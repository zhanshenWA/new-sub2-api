import { withUsageMetadata } from "../services/usage-log-metadata.ts";
import { normalizeUsageDate } from "../services/usage-dates.ts";
import { D1AuthSessionRepository } from "../repositories/auth-sessions.ts";
import { D1AuthUserRepository } from "../repositories/auth-users.ts";
import { AccessAuthError, AccessAuthService } from "../services/access-auth.ts";
import { D1UsageCleanupRepository } from "../repositories/usage-cleanup.ts";
import { UsageCleanupError, D1UsageCleanupService } from "../services/usage-cleanup.ts";
import { AuthTokenService } from "../services/auth-tokens.ts";
import { Hs256JwtSigner, Hs256JwtVerifier } from "../services/jwt.ts";
import type { D1Database } from "../types/d1.ts";
import {
    legacyError,
    legacyInternalError,
    legacySuccess,
    middlewareAuthError,
} from "./responses.ts";

const ROOT_RE = /^\/api\/v1\/admin\/usage\/?$/;
const STATS_RE = /^\/api\/v1\/admin\/usage\/stats\/?$/;
const SEARCH_USERS_RE = /^\/api\/v1\/admin\/usage\/search-users\/?$/;
const SEARCH_API_KEYS_RE = /^\/api\/v1\/admin\/usage\/search-api-keys\/?$/;
const CLEANUP_TASKS_RE = /^\/api\/v1\/admin\/usage\/cleanup-tasks\/?$/;
const CLEANUP_CANCEL_RE = /^\/api\/v1\/admin\/usage\/cleanup-tasks\/(\d+)\/cancel\/?$/;

export interface StagedUsageCleanupEnv {
    DB?: D1Database;
    JWT_SECRET?: string;
    JWT_ACCESS_TOKEN_EXPIRES_SECONDS?: string;
    JWT_REFRESH_TOKEN_EXPIRE_DAYS?: string;
}

function boundedIntegerEnv(value: string | undefined, defaultValue: number, min: number, max: number): number {
    if (value === undefined || value.trim() === "") return defaultValue;
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isInteger(parsed)) return defaultValue;
    return Math.min(max, Math.max(min, parsed));
}

function parseOptionalInt(url: URL, key: string): number | undefined {
    const v = url.searchParams.get(key);
    if (v === null || v.trim() === "") return undefined;
    const n = Number.parseInt(v.trim(), 10);
    return Number.isInteger(n) ? n : undefined;
}

function parseOptionalString(url: URL, key: string): string | undefined {
    const v = url.searchParams.get(key);
    return v !== null && v.trim() !== "" ? v.trim() : undefined;
}

function parseBoolean(url: URL, key: string): boolean | undefined {
    const value = url.searchParams.get(key)?.trim().toLowerCase();
    if (!value) return undefined;
    if (["true", "1", "yes"].includes(value)) return true;
    if (["false", "0", "no"].includes(value)) return false;
    return undefined;
}

export function isUsageCleanupPath(path: string): boolean {
    return path.startsWith("/api/v1/admin/usage");
}

async function authenticateAdmin(request: Request, env: StagedUsageCleanupEnv, clock: () => number): Promise<{ userId: number; role: string }> {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) throw new AccessAuthError("UNAUTHORIZED", "Missing authorization header");
    const secret = env.JWT_SECRET?.trim() ?? "";
    if (!secret) throw new AccessAuthError("UNAUTHORIZED", "JWT secret is not configured");
    const users = new D1AuthUserRepository(env.DB!);
    const sessions = new D1AuthSessionRepository(env.DB!);
    const signer = new Hs256JwtSigner(secret, boundedIntegerEnv(env.JWT_ACCESS_TOKEN_EXPIRES_SECONDS, 24 * 60 * 60, 1, 7 * 24 * 60 * 60), clock);
    const verifier = new Hs256JwtVerifier(secret, clock);
    const tokens = new AuthTokenService(sessions, signer, boundedIntegerEnv(env.JWT_REFRESH_TOKEN_EXPIRE_DAYS, 30, 1, 365), clock);
    const auth = new AccessAuthService(users, verifier, tokens, clock);
    const subject = await auth.authenticateAuthorization(authHeader);
    return { userId: subject.user.id, role: subject.user.role };
}

export async function routeStagedUsageCleanup(
    request: Request,
    env: StagedUsageCleanupEnv
): Promise<Response | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (!isUsageCleanupPath(pathname)) return null;
    if (env.DB === undefined) return middlewareAuthError(503, "database_not_configured", "Configure the Cloudflare D1 DB binding");

    try {
        const auth = await authenticateAdmin(request, env, Date.now);
        if (auth.role !== "admin") return middlewareAuthError(403, "FORBIDDEN", "Admin access required");

        const repo = new D1UsageCleanupRepository(env.DB);
        const svc = new D1UsageCleanupService(repo);

        if (ROOT_RE.test(pathname) && method === "GET") {
            const page = Math.max(1, parseOptionalInt(url, "page") ?? 1);
            const pageSize = Math.min(100, Math.max(1, parseOptionalInt(url, "page_size") ?? parseOptionalInt(url, "limit") ?? 20));
            const conditions: string[] = [];
            const values: Array<string | number> = [];
            const filters: Array<[string, string]> = [["user_id", "user_id"], ["api_key_id", "api_key_id"], ["account_id", "account_id"], ["group_id", "group_id"], ["billing_type", "billing_type"]];
            for (const [queryKey, column] of filters) {
                const value = parseOptionalInt(url, queryKey);
                if (value !== undefined) { conditions.push(`${column} = ?`); values.push(value); }
            }
            const model = parseOptionalString(url, "model");
            if (model) { conditions.push("model LIKE ?"); values.push(`%${model}%`); }
            const startDate = normalizeUsageDate(url.searchParams.get("start_date"), false, url.searchParams.get("timezone") ?? "UTC");
            if (startDate) { conditions.push("created_at >= ?"); values.push(startDate); }
            const endDate = normalizeUsageDate(url.searchParams.get("end_date"), true, url.searchParams.get("timezone") ?? "UTC");
            if (endDate) { conditions.push("created_at < ?"); values.push(endDate); }
            const stream = parseBoolean(url, "stream");
            if (stream !== undefined) { conditions.push("stream = ?"); values.push(stream ? 1 : 0); }
            const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
            const sortColumn = ["created_at", "total_cost", "model", "duration_ms"].includes(parseOptionalString(url, "sort_by") ?? "") ? parseOptionalString(url, "sort_by")! : "created_at";
            const sortOrder = parseOptionalString(url, "sort_order")?.toLowerCase() === "asc" ? "ASC" : "DESC";
            const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM usage_logs ${where}`).bind(...values).first() as { total?: number } | null;
            const rows = await env.DB.prepare(`
                SELECT id, request_id, model, requested_model, input_tokens, output_tokens,
                       cache_creation_tokens, cache_read_tokens, total_cost, actual_cost,
                       billing_type, stream, duration_ms, first_token_ms, user_agent,
                       image_count, video_count, group_id, subscription_id, api_key_id,
                       account_id, created_at
                FROM usage_logs ${where} ORDER BY ${sortColumn} ${sortOrder} LIMIT ? OFFSET ?
            `).bind(...values, pageSize, (page - 1) * pageSize).all() as { results?: Array<Record<string, unknown>> };
            const items = (rows.results ?? []).map((row) => ({
                id: Number(row.id), request_id: row.request_id, model: row.model, requested_model: row.requested_model,
                input_tokens: row.input_tokens, output_tokens: row.output_tokens,
                cache_creation_tokens: row.cache_creation_tokens, cache_read_tokens: row.cache_read_tokens,
                total_cost: row.total_cost, actual_cost: row.actual_cost, billing_type: row.billing_type,
                stream: row.stream === 1, duration_ms: row.duration_ms, first_token_ms: row.first_token_ms,
                user_agent: row.user_agent, image_count: row.image_count, video_count: row.video_count,
                group_id: row.group_id, subscription_id: row.subscription_id, api_key_id: row.api_key_id,
                account_id: row.account_id, created_at: row.created_at,
            }));
            return legacySuccess({ items: await withUsageMetadata(env.DB, items, { admin: true }), total: count?.total ?? 0, page, page_size: pageSize });
        }

        if (STATS_RE.test(pathname) && method === "GET") {
            const conditions: string[] = [];
            const values: Array<string | number> = [];
            for (const key of ["user_id", "api_key_id", "account_id", "group_id", "billing_type"] as const) {
                const value = parseOptionalInt(url, key);
                if (value !== undefined) { conditions.push(`${key} = ?`); values.push(value); }
            }
            const model = parseOptionalString(url, "model");
            if (model) { conditions.push("model LIKE ?"); values.push(`%${model}%`); }
            const startDate = normalizeUsageDate(url.searchParams.get("start_date"), false, url.searchParams.get("timezone") ?? "UTC");
            if (startDate) { conditions.push("created_at >= ?"); values.push(startDate); }
            const endDate = normalizeUsageDate(url.searchParams.get("end_date"), true, url.searchParams.get("timezone") ?? "UTC");
            if (endDate) { conditions.push("created_at < ?"); values.push(endDate); }
            const stream = parseBoolean(url, "stream");
            if (stream !== undefined) { conditions.push("stream = ?"); values.push(stream ? 1 : 0); }
            const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
            const row = await env.DB.prepare(`
                SELECT COUNT(*) AS total_requests,
                       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                       COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation_tokens,
                       COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
                       COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens,
                       COALESCE(SUM(total_cost), 0) AS total_cost,
                       COALESCE(SUM(actual_cost), 0) AS total_actual_cost,
                       COALESCE(AVG(duration_ms), 0) AS average_duration_ms
                FROM usage_logs ${where}
            `).bind(...values).first() as Record<string, unknown> | null;
            return legacySuccess(row ?? {
                total_requests: 0, total_input_tokens: 0, total_output_tokens: 0,
                total_cache_creation_tokens: 0, total_cache_read_tokens: 0, total_tokens: 0,
                total_cost: 0, total_actual_cost: 0, average_duration_ms: 0,
            });
        }

        // GET /admin/usage/search-users
        if (SEARCH_USERS_RE.test(pathname) && method === "GET") {
            const q = url.searchParams.get("q") ?? "";
            const items = await svc.searchUsers(q);
            return legacySuccess(items);
        }

        // GET /admin/usage/search-api-keys
        if (SEARCH_API_KEYS_RE.test(pathname) && method === "GET") {
            const userId = parseOptionalInt(url, "user_id") ?? null;
            const q = url.searchParams.get("q") ?? "";
            const items = await svc.searchApiKeys(userId, q);
            return legacySuccess(items);
        }

        // POST /admin/usage/cleanup-tasks/:id/cancel
        const cancelMatch = CLEANUP_CANCEL_RE.exec(pathname);
        if (cancelMatch !== null && method === "POST") {
            const id = Number(cancelMatch[1]);
            const result = await svc.cancelTask(id, auth.userId);
            return legacySuccess(result);
        }

        // GET/POST /admin/usage/cleanup-tasks
        if (CLEANUP_TASKS_RE.test(pathname)) {
            if (method === "GET") {
                const page = parseOptionalInt(url, "page") ?? 1;
                const pageSize = parseOptionalInt(url, "page_size") ?? parseOptionalInt(url, "limit") ?? 20;
                const result = await svc.listTasks(page, pageSize);
                return legacySuccess({ items: result.items, total: result.total, page: result.page, page_size: result.pageSize, pages: result.pages });
            }
            if (method === "POST") {
                const body = await request.json() as Record<string, unknown>;
                const filters: Record<string, unknown> = {};
                if (typeof body.start_date === "string") filters.start_date = body.start_date;
                if (typeof body.end_date === "string") filters.end_date = body.end_date;
                if (body.user_id != null) filters.user_id = body.user_id;
                if (body.api_key_id != null) filters.api_key_id = body.api_key_id;
                if (body.account_id != null) filters.account_id = body.account_id;
                if (body.group_id != null) filters.group_id = body.group_id;
                if (typeof body.model === "string") filters.model = body.model;
                if (typeof body.request_type === "string") filters.request_type = body.request_type;
                if (body.stream != null) filters.stream = body.stream;
                if (body.billing_type != null) filters.billing_type = body.billing_type;
                const task = await svc.createTask(filters, auth.userId);
                return legacySuccess(task);
            }
        }

        return legacyError(405, "method_not_allowed", "Method not allowed");
    } catch (error: unknown) {
        if (error instanceof AccessAuthError) return middlewareAuthError(401, error.code, error.message);
        if (error instanceof UsageCleanupError) return legacyError(error.status, error.message, error.code);
        return legacyInternalError();
    }
}
