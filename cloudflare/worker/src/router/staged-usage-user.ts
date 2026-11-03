import { normalizeUsageDate } from "../services/usage-dates.ts";
import { D1AuthSessionRepository } from "../repositories/auth-sessions.ts";
import { D1AuthUserRepository } from "../repositories/auth-users.ts";
import { allRows, firstRow } from "../repositories/d1.ts";
import { D1UsageUserRepository } from "../repositories/usage-user.ts";
import { AccessAuthError, AccessAuthService } from "../services/access-auth.ts";
import { AuthTokenService } from "../services/auth-tokens.ts";
import { Hs256JwtSigner, Hs256JwtVerifier } from "../services/jwt.ts";
import { D1UsageUserService, UsageUserError } from "../services/usage-user.ts";
import type { D1Database, D1Value } from "../types/d1.ts";
import {
    legacyError,
    legacyInternalError,
    legacySuccess,
    middlewareAuthError,
} from "./responses.ts";

const USAGE_LIST_RE = /^\/api\/v1\/usage\/?$/;
const USAGE_STATS_RE = /^\/api\/v1\/usage\/stats\/?$/;
const USAGE_ERRORS_RE = /^\/api\/v1\/usage\/errors\/?$/;
const USAGE_ERROR_BY_ID_RE = /^\/api\/v1\/usage\/errors\/(\d+)\/?$/;
const USAGE_DASHBOARD_STATS_RE = /^\/api\/v1\/usage\/dashboard\/stats\/?$/;
const USAGE_DASHBOARD_TREND_RE = /^\/api\/v1\/usage\/dashboard\/trend\/?$/;
const USAGE_DASHBOARD_MODELS_RE = /^\/api\/v1\/usage\/dashboard\/models\/?$/;
const USAGE_DASHBOARD_SNAPSHOT_V2_RE = /^\/api\/v1\/usage\/dashboard\/snapshot-v2\/?$/;
const USAGE_BY_ID_RE = /^\/api\/v1\/usage\/(\d+)\/?$/;
const USER_API_KEY_DAILY_USAGE_RE = /^\/api\/v1\/user\/api-keys\/(\d+)\/usage\/daily\/?$/;
const USER_PLATFORM_QUOTAS_RE = /^\/api\/v1\/user\/platform-quotas\/?$/;
const USER_BALANCE_HISTORY_RE = /^\/api\/v1\/user\/balance-history\/?$/;

export interface StagedUsageUserEnv {
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

function parseDateParam(url: URL, key: string): string | undefined {
    const v = url.searchParams.get(key);
    if (v === null || v.trim() === "") return undefined;
    return normalizeUsageDate(v, key === "end_date", url.searchParams.get("timezone") ?? "UTC");
}

export function isUsageUserPath(path: string): boolean {
    return path.startsWith("/api/v1/usage")
        || path.startsWith("/api/v1/user/api-keys/")
        || path.startsWith("/api/v1/user/platform-quotas")
        || path.startsWith("/api/v1/user/balance-history");
}

async function authenticateUser(request: Request, env: StagedUsageUserEnv, clock: () => number): Promise<{ userId: number }> {
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
    return { userId: subject.user.id };
}

function parseDateRange(url: URL, fallbackPeriod?: string): { startDate?: string; endDate?: string } {
    let startDate = parseDateParam(url, "start_date");
    let endDate = parseDateParam(url, "end_date");
    const period = url.searchParams.get("period") ?? fallbackPeriod;
    if (period && !startDate) {
        const range = computePeriodRange(period);
        startDate = range.startDate;
        endDate = range.endDate;
    }
    return { startDate, endDate };
}

export async function routeStagedUsageUser(
    request: Request,
    env: StagedUsageUserEnv
): Promise<Response | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (!isUsageUserPath(pathname)) return null;
    if (env.DB === undefined) return middlewareAuthError(503, "database_not_configured", "Configure the Cloudflare D1 DB binding");
    if (method !== "GET") return null;

    try {
        const auth = await authenticateUser(request, env, Date.now);
        const repo = new D1UsageUserRepository(env.DB);
        const svc = new D1UsageUserService(repo);

        const userId = auth.userId;

        // GET /api/v1/usage/dashboard/snapshot-v2
        if (USAGE_DASHBOARD_SNAPSHOT_V2_RE.test(pathname)) {
            const { startDate, endDate } = parseDateRange(url, "month");
            const [result, dashStats] = await Promise.all([
                svc.getSnapshotV2(userId, startDate ?? "", endDate ?? ""),
                svc.getDashboardStats(userId),
            ]);
            const stats = {
                ...dashStats,
                total_api_keys: dashStats.totalApiKeys,
                active_api_keys: dashStats.activeApiKeys,
                total_requests: dashStats.totalRequests,
                total_input_tokens: dashStats.totalInputTokens,
                total_output_tokens: dashStats.totalOutputTokens,
                total_tokens: dashStats.totalTokens,
                total_cost: dashStats.totalCost,
                total_actual_cost: dashStats.totalActualCost,
                today_requests: dashStats.todayRequests,
                today_tokens: dashStats.todayTokens,
                today_cost: dashStats.todayCost,
                average_duration_ms: dashStats.averageDurationMs,
            };
            return legacySuccess({
                stats,
                trend: result.trend,
                models: result.modelStats,
                model_stats: result.modelStats,
                groups: [],
                group_stats: [],
            });
        }

        // GET /api/v1/usage/dashboard/models
        if (USAGE_DASHBOARD_MODELS_RE.test(pathname)) {
            const { startDate, endDate } = parseDateRange(url);
            const models = await svc.getModelStats(userId, startDate, endDate);
            return legacySuccess({ items: models, models });
        }

        // GET /api/v1/usage/dashboard/trend
        if (USAGE_DASHBOARD_TREND_RE.test(pathname)) {
            const { startDate, endDate } = parseDateRange(url, "month");
            const granularity = url.searchParams.get("granularity") ?? "day";
            const trend = await svc.getTrend(userId, startDate ?? "", endDate ?? "", granularity);
            return legacySuccess({ items: trend, trend });
        }

        // GET /api/v1/usage/dashboard/stats
        if (USAGE_DASHBOARD_STATS_RE.test(pathname)) {
            const stats = await svc.getDashboardStats(userId);
            return legacySuccess({
                total_api_keys: stats.totalApiKeys,
                active_api_keys: stats.activeApiKeys,
                total_requests: stats.totalRequests,
                total_input_tokens: stats.totalInputTokens,
                total_output_tokens: stats.totalOutputTokens,
                total_tokens: stats.totalTokens,
                total_cost: stats.totalCost,
                total_actual_cost: stats.totalActualCost,
                today_requests: stats.todayRequests,
                today_tokens: stats.todayTokens,
                today_cost: stats.todayCost,
                average_duration_ms: stats.averageDurationMs,
            });
        }

        // GET /api/v1/usage/stats
        if (USAGE_STATS_RE.test(pathname)) {
            const { startDate, endDate } = parseDateRange(url);
            const stats = await svc.getStats(userId, startDate, endDate);
            return legacySuccess({
                total_requests: stats.totalRequests,
                total_input_tokens: stats.totalInputTokens,
                total_output_tokens: stats.totalOutputTokens,
                total_cache_creation_tokens: stats.totalCacheCreationTokens,
                total_cache_read_tokens: stats.totalCacheReadTokens,
                total_tokens: stats.totalTokens,
                total_cost: stats.totalCost,
                total_actual_cost: stats.totalActualCost,
                average_duration_ms: stats.averageDurationMs,
            });
        }

        // GET /api/v1/user/platform-quotas
        if (USER_PLATFORM_QUOTAS_RE.test(pathname)) {
            const quotas = await svc.getPlatformQuotas(userId);
            return legacySuccess({ platform_quotas: quotas.map((q) => ({
                platform: q.platform,
                daily_limit_usd: q.dailyLimitUsd,
                weekly_limit_usd: q.weeklyLimitUsd,
                monthly_limit_usd: q.monthlyLimitUsd,
                daily_usage_usd: q.dailyUsageUsd,
                weekly_usage_usd: q.weeklyUsageUsd,
                monthly_usage_usd: q.monthlyUsageUsd,
            })) });
        }

        // GET /api/v1/user/balance-history
        if (USER_BALANCE_HISTORY_RE.test(pathname)) {
            const page = Math.max(1, parseOptionalInt(url, "page") ?? 1);
            const pageSize = Math.min(100, Math.max(1, parseOptionalInt(url, "page_size") ?? parseOptionalInt(url, "limit") ?? 20));
            const type = url.searchParams.get("type")?.trim() || undefined;
            const offset = (page - 1) * pageSize;

            type RawBalanceRow = {
                id: number;
                code: string;
                type: string;
                value: number;
                status: string;
                notes: string | null;
                used_at: string | null;
                created_at: string;
            };

            let rows: RawBalanceRow[] = [];
            let total = 0;

            if (type === "affiliate_balance") {
                const countRow = await firstRow<{ cnt: number }>(
                    env.DB,
                    "SELECT COUNT(*) as cnt FROM user_affiliate_ledger WHERE user_id = ? AND action = 'transfer'",
                    [userId]
                );
                total = countRow?.cnt ?? 0;
                const ledgerRows = await allRows<{ id: number; amount: number; created_at: string }>(
                    env.DB,
                    "SELECT id, amount, created_at FROM user_affiliate_ledger WHERE user_id = ? AND action = 'transfer' ORDER BY created_at DESC LIMIT ? OFFSET ?",
                    [userId, pageSize, offset]
                );
                rows = ledgerRows.map((r) => ({
                    id: r.id,
                    code: `aff_transfer_${r.id}`,
                    type: "affiliate_balance",
                    value: r.amount,
                    status: "used",
                    notes: null,
                    used_at: r.created_at,
                    created_at: r.created_at,
                }));
            } else if (type === "payment") {
                const countRow = await firstRow<{ cnt: number }>(
                    env.DB,
                    "SELECT COUNT(*) as cnt FROM payment_orders WHERE user_id = ? AND status IN ('completed', 'paid') AND COALESCE(order_type, 'balance') = 'balance'",
                    [userId]
                );
                total = countRow?.cnt ?? 0;
                rows = await allRows<RawBalanceRow>(
                    env.DB,
                    `SELECT id, COALESCE(out_trade_no, 'order_' || id) as code, 'payment' as type, amount as value, 'used' as status, payment_type as notes, COALESCE(paid_at, updated_at, created_at) as used_at, created_at
                     FROM payment_orders
                     WHERE user_id = ? AND status IN ('completed', 'paid') AND COALESCE(order_type, 'balance') = 'balance'
                     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                    [userId, pageSize, offset]
                );
            } else if (type) {
                const values: D1Value[] = [userId, type];
                const countRow = await firstRow<{ cnt: number }>(
                    env.DB,
                    "SELECT COUNT(*) as cnt FROM redeem_codes WHERE used_by = ? AND type = ?",
                    values
                );
                total = countRow?.cnt ?? 0;
                rows = await allRows<RawBalanceRow>(
                    env.DB,
                    "SELECT id, code, type, value, status, notes, used_at, created_at FROM redeem_codes WHERE used_by = ? AND type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                    [...values, pageSize, offset]
                );
            } else {
                const countRow = await firstRow<{ cnt: number }>(
                    env.DB,
                    `SELECT (
                        (SELECT COUNT(*) FROM redeem_codes WHERE used_by = ?) +
                        (SELECT COUNT(*) FROM payment_orders WHERE user_id = ? AND status IN ('completed', 'paid') AND COALESCE(order_type, 'balance') = 'balance')
                    ) as cnt`,
                    [userId, userId]
                );
                total = countRow?.cnt ?? 0;
                rows = await allRows<RawBalanceRow>(
                    env.DB,
                    `SELECT id, code, type, value, status, notes, used_at, created_at
                     FROM (
                         SELECT id, code, type, value, status, notes, used_at, created_at
                         FROM redeem_codes
                         WHERE used_by = ?
                         UNION ALL
                         SELECT id, COALESCE(out_trade_no, 'order_' || id) as code, 'payment' as type, amount as value, 'used' as status, payment_type as notes, COALESCE(paid_at, updated_at, created_at) as used_at, created_at
                         FROM payment_orders
                         WHERE user_id = ? AND status IN ('completed', 'paid') AND COALESCE(order_type, 'balance') = 'balance'
                     )
                     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                    [userId, userId, pageSize, offset]
                );
            }

            const rechargeRow = await firstRow<{ total: number }>(
                env.DB,
                `SELECT (
                    (SELECT COALESCE(SUM(value), 0) FROM redeem_codes WHERE used_by = ? AND value > 0) +
                    (SELECT COALESCE(SUM(amount), 0) FROM payment_orders WHERE user_id = ? AND status IN ('completed', 'paid') AND COALESCE(order_type, 'balance') = 'balance' AND amount > 0)
                ) as total`,
                [userId, userId]
            );
            const totalRecharged = rechargeRow?.total ?? 0;
            const pages = Math.max(1, Math.ceil(total / pageSize));

            return legacySuccess({
                items: rows.map((r) => ({
                    id: r.id,
                    code: r.code,
                    type: r.type,
                    value: r.value,
                    status: r.status,
                    notes: r.notes,
                    usedAt: r.used_at,
                    used_at: r.used_at,
                    createdAt: r.created_at,
                    created_at: r.created_at,
                })),
                total,
                page,
                page_size: pageSize,
                pages,
                total_recharged: totalRecharged,
            });
        }

        // GET /api/v1/usage/errors/:id
        const errorByIdMatch = USAGE_ERROR_BY_ID_RE.exec(pathname);
        if (errorByIdMatch !== null) {
            const allowSetting = await firstRow<{ value: string }>(
                env.DB,
                "SELECT value FROM settings WHERE key = 'allow_user_view_error_requests'"
            );
            if (allowSetting?.value?.trim().toLowerCase() === "false") {
                return middlewareAuthError(403, "FORBIDDEN", "Viewing error requests is disabled");
            }
            const id = Number(errorByIdMatch[1]);
            const detail = await svc.getErrorDetail(userId, id);
            return legacySuccess({
                id: detail.id, created_at: detail.createdAt, model: detail.model,
                inbound_endpoint: detail.inboundEndpoint, status_code: detail.statusCode,
                category: detail.category, platform: detail.platform, message: detail.message,
                stream: detail.stream, user_agent: detail.userAgent,
                error_body: detail.errorBody,
                upstream_status_code: detail.upstreamStatusCode,
            });
        }

        // GET /api/v1/usage/errors
        if (USAGE_ERRORS_RE.test(pathname)) {
            const allowSetting = await firstRow<{ value: string }>(
                env.DB,
                "SELECT value FROM settings WHERE key = 'allow_user_view_error_requests'"
            );
            if (allowSetting?.value?.trim().toLowerCase() === "false") {
                return middlewareAuthError(403, "FORBIDDEN", "Viewing error requests is disabled");
            }
            const page = parseOptionalInt(url, "page") ?? 1;
            const pageSize = parseOptionalInt(url, "page_size") ?? 20;
            const model = url.searchParams.get("model") ?? undefined;
            const apiKeyId = parseOptionalInt(url, "api_key_id");
            const startDate = parseDateParam(url, "start_date");
            const endDate = parseDateParam(url, "end_date");
            const result = await svc.listErrors(userId, page, pageSize, { model, apiKeyId, startDate, endDate });
            return legacySuccess({ items: result.items, total: result.total, page: result.page, page_size: result.pageSize });
        }

        // GET /api/v1/user/api-keys/:id/usage/daily
        const apiKeyDailyMatch = USER_API_KEY_DAILY_USAGE_RE.exec(pathname);
        if (apiKeyDailyMatch !== null) {
            const apiKeyId = Number(apiKeyDailyMatch[1]);
            const days = parseOptionalInt(url, "days") ?? 30;
            const items = await svc.getAPIKeyDailyUsage(userId, apiKeyId, days);
            return legacySuccess({ items });
        }

        // GET /api/v1/usage/:id
        const idMatch = USAGE_BY_ID_RE.exec(pathname);
        if (idMatch !== null) {
            const id = Number(idMatch[1]);
            const row = await svc.getUsageById(userId, id);
            return legacySuccess({
                id: row.id, request_id: row.requestId, model: row.model, requested_model: row.requestedModel,
                input_tokens: row.inputTokens, output_tokens: row.outputTokens,
                cache_creation_tokens: row.cacheCreationTokens, cache_read_tokens: row.cacheReadTokens,
                total_cost: row.totalCost, actual_cost: row.actualCost,
                billing_type: row.billingType, stream: row.stream === 1,
                duration_ms: row.durationMs, user_agent: row.userAgent,
                image_count: row.imageCount, video_count: row.videoCount,
                group_id: row.groupId, api_key_id: row.apiKeyId,
                created_at: row.createdAt,
            });
        }

        // GET /api/v1/usage
        if (USAGE_LIST_RE.test(pathname)) {
            const page = parseOptionalInt(url, "page") ?? 1;
            const pageSize = parseOptionalInt(url, "page_size") ?? 20;
            const apiKeyId = parseOptionalInt(url, "api_key_id");
            const groupId = parseOptionalInt(url, "group_id");
            const model = url.searchParams.get("model") ?? undefined;
            const sortBy = url.searchParams.get("sort_by") ?? undefined;
            const sortOrder = url.searchParams.get("sort_order") ?? undefined;
            const period = url.searchParams.get("period") ?? undefined;
            let startDate: string | undefined = parseDateParam(url, "start_date");
            let endDate: string | undefined = parseDateParam(url, "end_date");

            if (period !== undefined && startDate === undefined) {
                const range = computePeriodRange(period);
                startDate = range.startDate;
                endDate = range.endDate;
            }

            const result = await svc.listUsage(userId, page, pageSize, { apiKeyId, groupId, model, startDate, endDate, sortBy, sortOrder });
            return legacySuccess({
                items: result.items.map((r) => ({
                    id: r.id, request_id: r.requestId, model: r.model, requested_model: r.requestedModel,
                    input_tokens: r.inputTokens, output_tokens: r.outputTokens,
                    cache_creation_tokens: r.cacheCreationTokens, cache_read_tokens: r.cacheReadTokens,
                    total_cost: r.totalCost, actual_cost: r.actualCost,
                    billing_type: r.billingType, stream: r.stream === 1,
                    duration_ms: r.durationMs, first_token_ms: r.firstTokenMs,
                    user_agent: r.userAgent, image_count: r.imageCount, video_count: r.videoCount,
                    group_id: r.groupId, subscription_id: r.subscriptionId,
                    api_key_id: r.apiKeyId, account_id: r.accountId,
                    created_at: r.createdAt,
                })),
                total: result.total, page: result.page, page_size: result.pageSize,
            });
        }

        return null;
    } catch (error: unknown) {
        if (error instanceof AccessAuthError) return middlewareAuthError(401, error.code, error.message);
        if (error instanceof UsageUserError) return legacyError(error.status, error.message, error.code);
        return legacyInternalError();
    }
}

function computePeriodRange(period: string): { startDate: string; endDate: string } {
    const now = new Date();
    const endDate = now.toISOString();
    let startDate: string;

    switch (period) {
        case "today": {
            const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
            startDate = todayStart.toISOString();
            break;
        }
        case "week": {
            const weekAgo = new Date(now.getTime() - 7 * 86400000);
            startDate = weekAgo.toISOString();
            break;
        }
        case "month": {
            const monthAgo = new Date(now.getTime() - 30 * 86400000);
            startDate = monthAgo.toISOString();
            break;
        }
        default: {
            const monthAgo = new Date(now.getTime() - 30 * 86400000);
            startDate = monthAgo.toISOString();
        }
    }

    return { startDate, endDate };
}
