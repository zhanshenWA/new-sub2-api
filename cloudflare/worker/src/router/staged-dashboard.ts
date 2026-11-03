import { normalizeUsageDate } from "../services/usage-dates.ts";
import { D1AuthSessionRepository } from "../repositories/auth-sessions.ts";
import { D1AuthUserRepository } from "../repositories/auth-users.ts";
import { AccessAuthError, AccessAuthService } from "../services/access-auth.ts";
import { D1DashboardRepositoryImpl } from "../repositories/dashboard.ts";
import { D1DashboardService } from "../services/dashboard.ts";
import { AuthTokenService } from "../services/auth-tokens.ts";
import { Hs256JwtSigner, Hs256JwtVerifier } from "../services/jwt.ts";
import type { D1Database } from "../types/d1.ts";
import {
    legacyError,
    legacyInternalError,
    legacySuccess,
    middlewareAuthError,
    routerError,
} from "./responses.ts";

function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        const snakeKey = key
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
            .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
            .toLowerCase();
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            result[snakeKey] = toSnakeCase(value as Record<string, unknown>);
        } else if (Array.isArray(value)) {
            result[snakeKey] = value.map((v) => typeof v === "object" && v !== null ? toSnakeCase(v as Record<string, unknown>) : v);
        } else {
            result[snakeKey] = value;
        }
    }
    return result;
}

function dashboardTrendPoint(point: {
    bucket: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCost: number;
    actualCost: number;
}): Record<string, unknown> {
    return {
        date: point.bucket,
        requests: point.requests ?? 0,
        input_tokens: point.inputTokens ?? 0,
        output_tokens: point.outputTokens ?? 0,
        cache_creation_tokens: point.cacheCreationTokens ?? 0,
        cache_read_tokens: point.cacheReadTokens ?? 0,
        total_tokens: (point.inputTokens ?? 0) + (point.outputTokens ?? 0) +
            (point.cacheCreationTokens ?? 0) + (point.cacheReadTokens ?? 0),
        cost: point.totalCost ?? 0,
        actual_cost: point.actualCost ?? 0,
    };
}

function dashboardModelStat(model: {
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCost: number;
    actualCost: number;
}): Record<string, unknown> {
    return {
        model: model.model,
        requests: model.requests ?? 0,
        input_tokens: model.inputTokens ?? 0,
        output_tokens: model.outputTokens ?? 0,
        cache_creation_tokens: model.cacheCreationTokens ?? 0,
        cache_read_tokens: model.cacheReadTokens ?? 0,
        total_tokens: (model.inputTokens ?? 0) + (model.outputTokens ?? 0) +
            (model.cacheCreationTokens ?? 0) + (model.cacheReadTokens ?? 0),
        cost: model.totalCost ?? 0,
        actual_cost: model.actualCost ?? 0,
    };
}

const DASHBOARD_PATHS = {
    snapshotV2: "/api/v1/admin/dashboard/snapshot-v2",
    stats: "/api/v1/admin/dashboard/stats",
    realtime: "/api/v1/admin/dashboard/realtime",
    trend: "/api/v1/admin/dashboard/trend",
    models: "/api/v1/admin/dashboard/models",
    groups: "/api/v1/admin/dashboard/groups",
    apiKeysTrend: "/api/v1/admin/dashboard/api-keys-trend",
    usersTrend: "/api/v1/admin/dashboard/users-trend",
    usersRanking: "/api/v1/admin/dashboard/users-ranking",
    usersUsage: "/api/v1/admin/dashboard/users-usage",
    apiKeysUsage: "/api/v1/admin/dashboard/api-keys-usage",
    userBreakdown: "/api/v1/admin/dashboard/user-breakdown",
    backfill: "/api/v1/admin/dashboard/aggregation/backfill",
} as const;

export interface StagedDashboardEnv {
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

export function isDashboardPath(path: string): boolean {
    return path.startsWith("/api/v1/admin/dashboard");
}

async function authenticateAdmin(request: Request, env: StagedDashboardEnv, clock: () => number): Promise<{ userId: number; role: string }> {
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

export async function routeStagedDashboard(
    request: Request,
    env: StagedDashboardEnv
): Promise<Response | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (!isDashboardPath(pathname)) return null;
    if (env.DB === undefined) return middlewareAuthError(503, "database_not_configured", "Configure the Cloudflare D1 DB binding");

    try {
        const auth = await authenticateAdmin(request, env, Date.now);
        if (auth.role !== "admin") return middlewareAuthError(403, "FORBIDDEN", "Admin access required");

        const repo = new D1DashboardRepositoryImpl(env.DB);
        const svc = new D1DashboardService(repo);

        const period = url.searchParams.get("period") ?? "day";
        const granularity = url.searchParams.get("granularity") ?? "day";
        const startDate = normalizeUsageDate(url.searchParams.get("start_date"), false, url.searchParams.get("timezone") ?? "UTC");
        const endDate = normalizeUsageDate(url.searchParams.get("end_date"), true, url.searchParams.get("timezone") ?? "UTC");
        const includeStats = url.searchParams.get("include_stats") !== "false";
        const includeTrend = url.searchParams.get("include_trend") !== "false";
        const includeModelStats = url.searchParams.get("include_model_stats") !== "false";
        const includeGroupStats = url.searchParams.get("include_group_stats") === "true";

        if (pathname === DASHBOARD_PATHS.snapshotV2 && method === "GET") {
            const response: Record<string, unknown> = {
                generated_at: new Date().toISOString(),
                start_date: startDate ?? "",
                end_date: endDate ?? "",
                granularity,
            };
            if (includeStats) {
                const stats = await svc.getStats(period, startDate, endDate);
                response.stats = { ...toSnakeCase(stats as unknown as Record<string, unknown>), uptime: 0 };
            }
            if (includeTrend) {
                const trend = await svc.getUsageTrend(period, granularity, startDate, endDate);
                response.trend = trend.map(dashboardTrendPoint);
            }
            if (includeModelStats) {
                const models = await svc.getModelStats(period, startDate, endDate);
                response.models = models.map(dashboardModelStat);
            }
            if (includeGroupStats) {
                const groups = await svc.getGroupStats(period, startDate, endDate);
                response.groups = groups.map((g) => ({ group_id: g.groupId, group_name: g.groupName, requests: g.requests, cost: g.cost, actual_cost: g.actualCost, total_tokens: g.totalTokens, active_users: g.activeUsers, active_api_keys: g.activeAPIKeys }));
            }
            return legacySuccess(response);
        }

        if (pathname === DASHBOARD_PATHS.stats && method === "GET") {
            const stats = await svc.getStats(period, startDate, endDate);
            return legacySuccess(toSnakeCase(stats as unknown as Record<string, unknown>));
        }

        if (pathname === DASHBOARD_PATHS.realtime && method === "GET") {
            const metrics = await svc.getRealtimeMetrics();
            return legacySuccess(metrics);
        }

        if (pathname === DASHBOARD_PATHS.trend && method === "GET") {
            const trend = await svc.getUsageTrend(period, granularity, startDate, endDate);
            return legacySuccess({ trend: trend.map(dashboardTrendPoint) });
        }

        if (pathname === DASHBOARD_PATHS.models && method === "GET") {
            const models = await svc.getModelStats(period, startDate, endDate);
            return legacySuccess({ models: models.map(dashboardModelStat) });
        }

        if (pathname === DASHBOARD_PATHS.groups && method === "GET") {
            const groups = await svc.getGroupStats(period, startDate, endDate);
            return legacySuccess({ groups });
        }

        if (pathname === DASHBOARD_PATHS.apiKeysTrend && method === "POST") {
            const body = await request.json() as Record<string, unknown>;
            const apiKeyIds = Array.isArray(body.api_key_ids) ? body.api_key_ids.map(Number) : [];
            const trends = await svc.getAPIKeyUsageTrend(apiKeyIds, period);
            return legacySuccess({ trends });
        }

        if (pathname === DASHBOARD_PATHS.usersTrend && method === "GET") {
            const startDate = url.searchParams.get("start_date") ?? "";
            const endDate = url.searchParams.get("end_date") ?? "";
            const granularityParam = url.searchParams.get("granularity") ?? "day";
            const limit = parseOptionalInt(url, "limit") ?? 12;
            const granularity = granularityParam === "hour" ? "hour" : "day";
            const trends = await svc.getUserUsageTrend(startDate, endDate, granularity, limit);
            return legacySuccess({
                trend: trends.map((point) => ({
                    date: point.date,
                    user_id: point.userId,
                    email: point.email,
                    username: point.username,
                    requests: point.requests ?? 0,
                    tokens: point.tokens ?? 0,
                    cost: point.cost ?? 0,
                    actual_cost: point.actualCost ?? 0,
                })),
                start_date: startDate,
                end_date: endDate,
                granularity,
            });
        }

        if (pathname === DASHBOARD_PATHS.usersRanking && method === "GET") {
            const rankingLimit = parseOptionalInt(url, "limit") ?? 50;
            const rankingStartDate = url.searchParams.get("start_date") ?? undefined;
            const rankingEndDate = url.searchParams.get("end_date") ?? undefined;
            const ranking = await svc.getUserSpendingRanking(period, rankingLimit, rankingStartDate, rankingEndDate);
            return legacySuccess({
                ranking: ranking.map((item) => ({
                    user_id: item.userId,
                    username: item.username,
                    email: item.email,
                    total_cost: item.totalCost ?? 0,
                    actual_cost: item.actualCost ?? 0,
                    total_requests: item.totalRequests ?? 0,
                    total_tokens: item.totalTokens ?? 0,
                    requests: item.totalRequests ?? 0,
                    tokens: item.totalTokens ?? 0,
                })),
            });
        }

        if (pathname === DASHBOARD_PATHS.usersUsage && method === "POST") {
            const body = await request.json() as Record<string, unknown>;
            const userIds = Array.isArray(body.user_ids) ? body.user_ids.map(Number) : [];
            const usage = await svc.getBatchUsersUsage(userIds, period);
            return legacySuccess({ usage });
        }

        if (pathname === DASHBOARD_PATHS.apiKeysUsage && method === "POST") {
            const body = await request.json() as Record<string, unknown>;
            const apiKeyIds = Array.isArray(body.api_key_ids) ? body.api_key_ids.map(Number) : [];
            const usage = await svc.getBatchAPIKeysUsage(apiKeyIds, period);
            return legacySuccess({ usage });
        }

        if (pathname === DASHBOARD_PATHS.userBreakdown && method === "GET") {
            const userId = parseOptionalInt(url, "user_id");
            if (userId === undefined) return legacyError(400, "user_id is required", "MISSING_USER_ID");
            const breakdown = await svc.getUserBreakdown(userId, period);
            return legacySuccess(toSnakeCase(breakdown as unknown as Record<string, unknown>));
        }

        if (pathname === DASHBOARD_PATHS.backfill && method === "POST") {
            const body = await request.json() as Record<string, unknown>;
            const from = typeof body.from === "string" ? body.from : "";
            const to = typeof body.to === "string" ? body.to : "";
            if (!from || !to) return legacyError(400, "from and to dates are required", "MISSING_DATES");
            const result = await svc.backfillAggregation(from, to);
            return legacySuccess(result);
        }

        return routerError(405, "method_not_allowed", "Method not allowed for this dashboard route");
    } catch (error: unknown) {
        if (error instanceof AccessAuthError) return middlewareAuthError(401, error.code, error.message);
        if (error instanceof DashboardError) return legacyError(error.status, error.message, error.code);
        if (error instanceof Error && error.message === "User not found") return legacyError(404, error.message, "USER_NOT_FOUND");
        console.error("Dashboard error:", error);
        return legacyInternalError();
    }
}

function parseOptionalInt(url: URL, key: string): number | undefined {
    const v = url.searchParams.get(key);
    if (v === null || v.trim() === "") return undefined;
    const n = Number.parseInt(v.trim(), 10);
    return Number.isInteger(n) ? n : undefined;
}

import { DashboardError } from "../services/dashboard.ts";
