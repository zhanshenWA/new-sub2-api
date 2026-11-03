import { D1AuthSessionRepository } from "../repositories/auth-sessions.ts";
import { D1AuthUserRepository } from "../repositories/auth-users.ts";
import { runStatement } from "../repositories/d1.ts";
import { AccessAuthError, AccessAuthService } from "../services/access-auth.ts";
import { D1OpsRepositoryImpl } from "../repositories/ops.ts";
import { D1OpsDashboard, opsWindow } from "../services/ops-dashboard.ts";
import { D1OpsService, OpsError } from "../services/ops.ts";
import { AuthTokenService } from "../services/auth-tokens.ts";
import { Hs256JwtSigner, Hs256JwtVerifier } from "../services/jwt.ts";
import type { D1Database } from "../types/d1.ts";
import {
    legacyError,
    legacyInternalError,
    legacySuccess,
    middlewareAuthError,
} from "./responses.ts";

const OPS_PATHS = {
    concurrency: "/api/v1/admin/ops/concurrency",
    userConcurrency: "/api/v1/admin/ops/user-concurrency",
    accountAvailability: "/api/v1/admin/ops/account-availability",
    realtimeTraffic: "/api/v1/admin/ops/realtime-traffic",

    alertRules: "/api/v1/admin/ops/alert-rules",
    alertRulesId: (id: string) => `/api/v1/admin/ops/alert-rules/${id}`,
    alertEvents: "/api/v1/admin/ops/alert-events",
    alertEventsId: (id: string) => `/api/v1/admin/ops/alert-events/${id}`,
    alertEventsIdStatus: (id: string) => `/api/v1/admin/ops/alert-events/${id}/status`,
    alertSilences: "/api/v1/admin/ops/alert-silences",

    emailNotificationConfig: "/api/v1/admin/ops/email-notification/config",
    alertRuntimeSettings: "/api/v1/admin/ops/runtime/alert",
    runtimeLogConfig: "/api/v1/admin/ops/runtime/logging",
    runtimeLogConfigReset: "/api/v1/admin/ops/runtime/logging/reset",

    advancedSettings: "/api/v1/admin/ops/advanced-settings",
    metricThresholds: "/api/v1/admin/ops/settings/metric-thresholds",

    errors: "/api/v1/admin/ops/errors",
    errorsId: (id: string) => `/api/v1/admin/ops/errors/${id}`,
    errorsIdResolve: (id: string) => `/api/v1/admin/ops/errors/${id}/resolve`,

    requestErrors: "/api/v1/admin/ops/request-errors",
    requestErrorsId: (id: string) => `/api/v1/admin/ops/request-errors/${id}`,
    requestErrorsIdUpstream: (id: string) => `/api/v1/admin/ops/request-errors/${id}/upstream-errors`,
    requestErrorsIdResolve: (id: string) => `/api/v1/admin/ops/request-errors/${id}/resolve`,

    upstreamErrors: "/api/v1/admin/ops/upstream-errors",
    upstreamErrorsId: (id: string) => `/api/v1/admin/ops/upstream-errors/${id}`,
    upstreamErrorsIdResolve: (id: string) => `/api/v1/admin/ops/upstream-errors/${id}/resolve`,

    requests: "/api/v1/admin/ops/requests",

    systemLogs: "/api/v1/admin/ops/system-logs",
    systemLogsCleanup: "/api/v1/admin/ops/system-logs/cleanup",
    systemLogsHealth: "/api/v1/admin/ops/system-logs/health",

    dashboardSnapshotV2: "/api/v1/admin/ops/dashboard/snapshot-v2",
    dashboardOverview: "/api/v1/admin/ops/dashboard/overview",
    dashboardThroughputTrend: "/api/v1/admin/ops/dashboard/throughput-trend",
    dashboardLatencyHistogram: "/api/v1/admin/ops/dashboard/latency-histogram",
    dashboardErrorTrend: "/api/v1/admin/ops/dashboard/error-trend",
    dashboardErrorDistribution: "/api/v1/admin/ops/dashboard/error-distribution",
    dashboardOpenAITokenStats: "/api/v1/admin/ops/dashboard/openai-token-stats",
} as const;

export interface StagedOpsEnv {
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

export function isOpsPath(path: string): boolean {
    return path.startsWith("/api/v1/admin/ops");
}

async function authenticateAdmin(request: Request, env: StagedOpsEnv, clock: () => number): Promise<{ userId: number; role: string }> {
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

function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        result[camelKey] = value;
    }
    return result;
}

function toSnakeCase(obj: unknown): unknown {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((v) => toSnakeCase(v));
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            result[snakeKey] = toSnakeCase(value);
        } else if (Array.isArray(value)) {
            result[snakeKey] = value.map((v) => toSnakeCase(v));
        } else {
            result[snakeKey] = value;
        }
    }
    return result;
}

function parseOptionalInt(url: URL, key: string): number | undefined {
    const v = url.searchParams.get(key);
    if (v === null || v.trim() === "") return undefined;
    const n = Number.parseInt(v.trim(), 10);
    return Number.isInteger(n) ? n : undefined;
}

export async function routeStagedOps(
    request: Request,
    env: StagedOpsEnv
): Promise<Response | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (!isOpsPath(pathname)) return null;
    if (env.DB === undefined) return middlewareAuthError(503, "database_not_configured", "Configure the Cloudflare D1 DB binding");

    try {
        const auth = await authenticateAdmin(request, env, Date.now);
        if (auth.role !== "admin") return middlewareAuthError(403, "FORBIDDEN", "Admin access required");

        const repo = new D1OpsRepositoryImpl(env.DB);
        const svc = new D1OpsService(repo);

        // Vue dashboard contracts, backed by raw usage/error ledgers on Cloudflare.
        if (method === "GET") {
            const dashboard = new D1OpsDashboard(env.DB);
            const unavailable = { enabled: false, platform: {}, group: {}, account: {},
                reason: "Cloudflare Workers 当前未启用全局在途并发与排队采集", timestamp: new Date().toISOString() };
            const queries: Record<string, () => Promise<unknown>> = {
                [OPS_PATHS.dashboardSnapshotV2]: () => dashboard.snapshot(url),
                [OPS_PATHS.dashboardOverview]: () => dashboard.overview(opsWindow(url)),
                [OPS_PATHS.dashboardThroughputTrend]: () => dashboard.throughput(opsWindow(url)),
                [OPS_PATHS.dashboardLatencyHistogram]: () => dashboard.latency(opsWindow(url)),
                [OPS_PATHS.dashboardErrorTrend]: () => dashboard.errorTrend(opsWindow(url)),
                [OPS_PATHS.dashboardErrorDistribution]: () => dashboard.distribution(opsWindow(url)),
                [OPS_PATHS.dashboardOpenAITokenStats]: () => dashboard.openaiTokens(url),
                [OPS_PATHS.requests]: () => dashboard.requests(url),
                [OPS_PATHS.systemLogs]: () => dashboard.systemLogs(url),
                [OPS_PATHS.systemLogsHealth]: () => dashboard.logHealth(),
                [OPS_PATHS.concurrency]: async () => unavailable,
                [OPS_PATHS.userConcurrency]: async () => ({ ...unavailable, user: {} }),
                [OPS_PATHS.accountAvailability]: async () => unavailable,
                [OPS_PATHS.realtimeTraffic]: async () => {
                    const w = opsWindow(url), data = await dashboard.overview(w);
                    return { enabled: true, summary: { ...data, window: url.searchParams.get("window") ?? "1h" }, timestamp: new Date().toISOString() };
                },
            };
            if (Object.hasOwn(queries, pathname)) return legacySuccess(await queries[pathname]());
        }

        // Realtime ops signals
        if (pathname === OPS_PATHS.concurrency && method === "GET") {
            return legacySuccess(toSnakeCase(await svc.getConcurrencyStats()));
        }
        if (pathname === OPS_PATHS.userConcurrency && method === "GET") {
            return legacySuccess(toSnakeCase(await svc.getUserConcurrencyStats()));
        }
        if (pathname === OPS_PATHS.accountAvailability && method === "GET") {
            return legacySuccess(toSnakeCase(await svc.getAccountAvailability()));
        }
        if (pathname === OPS_PATHS.realtimeTraffic && method === "GET") {
            return legacySuccess(toSnakeCase(await svc.getRealtimeTrafficSummary()));
        }

        // Alert rules
        if (pathname === OPS_PATHS.alertRules && method === "GET") {
            return legacySuccess(await svc.listAlertRules());
        }
        if (pathname === OPS_PATHS.alertRules && method === "POST") {
            const body = await request.json() as Record<string, unknown>;
            return legacySuccess({ id: await svc.createAlertRule(snakeToCamel(body) as any) });
        }
        const alertRuleIdMatch = /^\/api\/v1\/admin\/ops\/alert-rules\/(\d+)$/.exec(pathname);
        if (alertRuleIdMatch && method === "PUT") {
            const body = await request.json() as Record<string, unknown>;
            await svc.updateAlertRule(Number(alertRuleIdMatch[1]), snakeToCamel(body) as any);
            return legacySuccess({});
        }
        if (alertRuleIdMatch && method === "DELETE") {
            await svc.deleteAlertRule(Number(alertRuleIdMatch[1]));
            return legacySuccess({});
        }

        // Alert events
        if (pathname === OPS_PATHS.alertEvents && method === "GET") {
            const status = url.searchParams.get("status") ?? undefined;
            const ruleId = parseOptionalInt(url, "rule_id");
            const limit = parseOptionalInt(url, "limit");
            const offset = parseOptionalInt(url, "offset");
            return legacySuccess(await svc.listAlertEvents({ status, ruleId, limit, offset }));
        }
        const alertEventIdMatch = /^\/api\/v1\/admin\/ops\/alert-events\/(\d+)$/.exec(pathname);
        if (alertEventIdMatch && method === "GET") {
            return legacySuccess(await svc.getAlertEvent(Number(alertEventIdMatch[1])));
        }
        const alertEventStatusMatch = /^\/api\/v1\/admin\/ops\/alert-events\/(\d+)\/status$/.exec(pathname);
        if (alertEventStatusMatch && method === "PUT") {
            const body = await request.json() as Record<string, unknown>;
            await svc.updateAlertEventStatus(Number(alertEventStatusMatch[1]), String(body.status));
            return legacySuccess({});
        }

        // Alert silences
        if (pathname === OPS_PATHS.alertSilences && method === "POST") {
            const body = await request.json() as Record<string, unknown>;
            return legacySuccess({ id: await svc.createAlertSilence(snakeToCamel(body) as any) });
        }
        const alertSilenceIdMatch = /^\/api\/v1\/admin\/ops\/alert-silences\/(\d+)$/.exec(pathname);
        if (alertSilenceIdMatch && method === "DELETE") {
            await runStatement(env.DB, "DELETE FROM ops_alert_silences WHERE id = ?", [Number(alertSilenceIdMatch[1])]);
            return legacySuccess({});
        }

        // Email notification config
        if (pathname === OPS_PATHS.emailNotificationConfig && method === "GET") {
            return legacySuccess(await svc.getEmailNotificationConfig());
        }
        if (pathname === OPS_PATHS.emailNotificationConfig && method === "PUT") {
            const body = await request.json() as Record<string, unknown>;
            await svc.updateEmailNotificationConfig(body as any);
            return legacySuccess({});
        }

        // Runtime settings
        if (pathname === OPS_PATHS.alertRuntimeSettings && method === "GET") {
            return legacySuccess(await svc.getAlertRuntimeSettings());
        }
        if (pathname === OPS_PATHS.alertRuntimeSettings && method === "PUT") {
            const body = await request.json() as Record<string, unknown>;
            await svc.updateAlertRuntimeSettings(body as any);
            return legacySuccess({});
        }
        if (pathname === OPS_PATHS.runtimeLogConfig && method === "GET") {
            return legacySuccess(await svc.getRuntimeLogConfig());
        }
        if (pathname === OPS_PATHS.runtimeLogConfig && method === "PUT") {
            const body = await request.json() as Record<string, unknown>;
            await svc.updateRuntimeLogConfig(body as any);
            return legacySuccess({});
        }
        if (pathname === OPS_PATHS.runtimeLogConfigReset && method === "POST") {
            await svc.resetRuntimeLogConfig();
            return legacySuccess({});
        }

        // Advanced settings
        if (pathname === OPS_PATHS.advancedSettings && method === "GET") {
            return legacySuccess(await svc.getAdvancedSettings());
        }
        if (pathname === OPS_PATHS.advancedSettings && method === "PUT") {
            const body = await request.json() as Record<string, unknown>;
            await svc.updateAdvancedSettings(body as any);
            return legacySuccess({});
        }

        // Metric thresholds
        if (pathname === OPS_PATHS.metricThresholds && method === "GET") {
            return legacySuccess(await svc.getMetricThresholds());
        }
        if (pathname === OPS_PATHS.metricThresholds && method === "PUT") {
            const body = await request.json() as Record<string, unknown>;
            await svc.updateMetricThresholds(body as any);
            return legacySuccess({});
        }

        // Error logs
        if (pathname === OPS_PATHS.errors && method === "GET") {
            const statusCode = parseOptionalInt(url, "status_code");
            const platform = url.searchParams.get("platform") ?? undefined;
            const userId = parseOptionalInt(url, "user_id");
            const resolved = url.searchParams.get("resolved") === "true" ? true : url.searchParams.get("resolved") === "false" ? false : undefined;
            const limit = parseOptionalInt(url, "limit");
            const offset = parseOptionalInt(url, "offset");
            return legacySuccess(await svc.listErrorLogs({ statusCode, platform, userId, resolved, limit, offset }));
        }
        const errorIdMatch = /^\/api\/v1\/admin\/ops\/errors\/(\d+)$/.exec(pathname);
        if (errorIdMatch && method === "GET") {
            return legacySuccess(await svc.getErrorLog(Number(errorIdMatch[1])));
        }
        if (errorIdMatch && method === "DELETE") {
            await runStatement(env.DB, "DELETE FROM ops_error_logs WHERE id = ?", [Number(errorIdMatch[1])]);
            return legacySuccess({});
        }
        const errorUpstreamMatch = /^\/api\/v1\/admin\/ops\/errors\/(\d+)\/upstream-errors$/.exec(pathname);
        if (errorUpstreamMatch && method === "GET") {
            return legacySuccess(await svc.listRequestErrorUpstreamErrors(Number(errorUpstreamMatch[1])));
        }
        const errorResolveMatch = /^\/api\/v1\/admin\/ops\/errors\/(\d+)\/resolve$/.exec(pathname);
        if (errorResolveMatch && method === "PUT") {
            const body = await request.json() as Record<string, unknown>;
            await svc.updateErrorResolution(Number(errorResolveMatch[1]), Boolean(body.resolved), auth.userId);
            return legacySuccess({});
        }

        // Request errors
        if (pathname === OPS_PATHS.requestErrors && method === "GET") {
            const statusCode = parseOptionalInt(url, "status_code");
            const platform = url.searchParams.get("platform") ?? undefined;
            const limit = parseOptionalInt(url, "limit");
            const offset = parseOptionalInt(url, "offset");
            return legacySuccess(await svc.listRequestErrors({ statusCode, platform, limit, offset }));
        }
        const requestErrorIdMatch = /^\/api\/v1\/admin\/ops\/request-errors\/(\d+)$/.exec(pathname);
        if (requestErrorIdMatch && method === "GET") {
            return legacySuccess(await svc.getRequestError(Number(requestErrorIdMatch[1])));
        }
        const requestErrorUpstreamMatch = /^\/api\/v1\/admin\/ops\/request-errors\/(\d+)\/upstream-errors$/.exec(pathname);
        if (requestErrorUpstreamMatch && method === "GET") {
            return legacySuccess(await svc.listRequestErrorUpstreamErrors(Number(requestErrorUpstreamMatch[1])));
        }
        const requestErrorResolveMatch = /^\/api\/v1\/admin\/ops\/request-errors\/(\d+)\/resolve$/.exec(pathname);
        if (requestErrorResolveMatch && method === "PUT") {
            await svc.resolveRequestError(Number(requestErrorResolveMatch[1]));
            return legacySuccess({});
        }

        // Upstream errors
        if (pathname === OPS_PATHS.upstreamErrors && method === "GET") {
            const platform = url.searchParams.get("platform") ?? undefined;
            const limit = parseOptionalInt(url, "limit");
            const offset = parseOptionalInt(url, "offset");
            return legacySuccess(await svc.listUpstreamErrors({ platform, limit, offset }));
        }
        const upstreamErrorIdMatch = /^\/api\/v1\/admin\/ops\/upstream-errors\/(\d+)$/.exec(pathname);
        if (upstreamErrorIdMatch && method === "GET") {
            return legacySuccess(await svc.getUpstreamError(Number(upstreamErrorIdMatch[1])));
        }
        const upstreamErrorResolveMatch = /^\/api\/v1\/admin\/ops\/upstream-errors\/(\d+)\/resolve$/.exec(pathname);
        if (upstreamErrorResolveMatch && method === "PUT") {
            await svc.resolveUpstreamError(Number(upstreamErrorResolveMatch[1]));
            return legacySuccess({});
        }

        // Request details
        if (pathname === OPS_PATHS.requests && method === "GET") {
            const statusCode = parseOptionalInt(url, "status_code");
            const platform = url.searchParams.get("platform") ?? undefined;
            const userId = parseOptionalInt(url, "user_id");
            const limit = parseOptionalInt(url, "limit");
            const offset = parseOptionalInt(url, "offset");
            return legacySuccess(await svc.listRequestDetails({ statusCode, platform, userId, limit, offset }));
        }

        // System logs
        if (pathname === OPS_PATHS.systemLogs && method === "GET") {
            const level = url.searchParams.get("level") ?? undefined;
            const component = url.searchParams.get("component") ?? undefined;
            const limit = parseOptionalInt(url, "limit");
            const offset = parseOptionalInt(url, "offset");
            return legacySuccess(await svc.listSystemLogs({ level, component, limit, offset }));
        }
        if (pathname === OPS_PATHS.systemLogsCleanup && method === "POST") {
            const body = await request.json() as Record<string, unknown>;
            return legacySuccess({ deleted: await svc.cleanupSystemLogs(String(body.before_date)) });
        }
        if (pathname === OPS_PATHS.systemLogsHealth && method === "GET") {
            return legacySuccess(toSnakeCase(await svc.getSystemLogIngestionHealth()));
        }

        // Dashboard vNext
        if (pathname === OPS_PATHS.dashboardSnapshotV2 && method === "GET") {
            return legacySuccess(await svc.getDashboardSnapshotV2());
        }
        if (pathname === OPS_PATHS.dashboardOverview && method === "GET") {
            return legacySuccess(await svc.getDashboardOverview());
        }
        if (pathname === OPS_PATHS.dashboardThroughputTrend && method === "GET") {
            return legacySuccess(await svc.getDashboardThroughputTrend());
        }
        if (pathname === OPS_PATHS.dashboardLatencyHistogram && method === "GET") {
            return legacySuccess(await svc.getDashboardLatencyHistogram());
        }
        if (pathname === OPS_PATHS.dashboardErrorTrend && method === "GET") {
            return legacySuccess(await svc.getDashboardErrorTrend());
        }
        if (pathname === OPS_PATHS.dashboardErrorDistribution && method === "GET") {
            return legacySuccess(await svc.getDashboardErrorDistribution());
        }
        if (pathname === OPS_PATHS.dashboardOpenAITokenStats && method === "GET") {
            return legacySuccess(await svc.getDashboardOpenAITokenStats());
        }

        return null;
    } catch (error: unknown) {
        if (error instanceof AccessAuthError) return middlewareAuthError(401, error.code, error.message);
        if (error instanceof OpsError) return legacyError(error.status, error.message, error.code);
        console.error("Ops error:", error);
        return legacyInternalError();
    }
}
