import type { D1Database, D1Value, D1PreparedStatement } from "../types/d1.ts";
import { classifyBackendRoute, PROXY_HOP_HEADER } from "../routes.ts";
import { allRows, firstRow, runStatement } from "../repositories/d1.ts";
import { routerError } from "./responses.ts";
import { GeminiWebService } from "../services/gemini-web.ts";
import { DeepSeekWebService } from "../services/deepseek-web.ts";
import { ChannelPricingCatalogService, type PricingContext } from "../services/channel-pricing-catalog.ts";

const pricingCatalog = new ChannelPricingCatalogService();

function findModelPricing(model: string, context: PricingContext = {}): { inputPrice: number; outputPrice: number; cacheWritePrice: number; cacheReadPrice: number } | null {
    const result = pricingCatalog.getModelPricing(model, context);
    if (result.found && (result.inputPrice !== undefined || result.outputPrice !== undefined)) {
        return {
            inputPrice: result.inputPrice ?? 0,
            outputPrice: result.outputPrice ?? 0,
            cacheWritePrice: result.cacheWritePrice ?? result.inputPrice ?? 0,
            cacheReadPrice: result.cacheReadPrice ?? 0
        };
    }
    return null;
}

interface GatewayEnv {
    DB?: D1Database;
}

interface GatewayKeyRow {
    id: number;
    user_id: number;
    group_id: number | null;
    status: string;
    quota: number;
    quota_used: number;
    expires_at: string | null;
    ip_whitelist?: string | null;
    ip_blacklist?: string | null;
    rate_limit_5h?: number;
    rate_limit_1d?: number;
    rate_limit_7d?: number;
    usage_5h?: number;
    usage_1d?: number;
    usage_7d?: number;
    window_5h_start?: string | null;
    window_1d_start?: string | null;
    window_7d_start?: string | null;
    user_status: string;
    user_balance?: number;
    group_rate_multiplier?: number | null;
}

interface GatewaySubscriptionRow {
    id: number;
    group_id: number;
    starts_at: string;
    expires_at: string;
    status: string;
    daily_window_start: string | null;
    weekly_window_start: string | null;
    monthly_window_start: string | null;
    daily_usage_usd: number;
    weekly_usage_usd: number;
    monthly_usage_usd: number;
    group_name: string | null;
    daily_limit_usd: number | null;
    weekly_limit_usd: number | null;
    monthly_limit_usd: number | null;
    group_rate_multiplier: number | null;
}

interface GatewayAccountRow {
    id: number;
    platform: string;
    type?: string;
    credentials: string;
    extra: string;
    proxy_id?: number | null;
    priority: number;
    rate_multiplier?: number;
    group_priority?: number | null;
    last_used_at?: string | null;
}

const GATEWAY_FAMILIES = new Set([
    "v1", "v1beta", "responses", "alpha-search", "images", "videos",
    "chat-completions", "embeddings", "antigravity"
]);

const MAX_ROUTING_ATTEMPTS = 5;
const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;

export async function routeGateway(request: Request, env: GatewayEnv): Promise<Response | null> {
    const url = new URL(request.url);
    const family = classifyBackendRoute(url.pathname);
    if (family === null || !GATEWAY_FAMILIES.has(family)) return null;
    if (env.DB === undefined) return routerError(503, "database_not_configured", "Configure the Cloudflare D1 DB binding");

    const rawKey = readApiKey(request);
    if (rawKey === "") return openAIError(401, "invalid_api_key", "Missing API key");

    const key = await firstRow<GatewayKeyRow>(env.DB, `
        SELECT k.id, k.user_id, k.group_id, k.status, k.quota, k.quota_used, k.expires_at,
               k.ip_whitelist, k.ip_blacklist,
               k.rate_limit_5h, k.rate_limit_1d, k.rate_limit_7d,
               k.usage_5h, k.usage_1d, k.usage_7d,
               k.window_5h_start, k.window_1d_start, k.window_7d_start,
               u.status AS user_status, u.balance AS user_balance,
               g.rate_multiplier AS group_rate_multiplier
        FROM api_keys k
        JOIN users u ON u.id = k.user_id AND u.deleted_at IS NULL
        LEFT JOIN groups g ON g.id = k.group_id AND g.deleted_at IS NULL
        WHERE k.key = ? AND k.deleted_at IS NULL
        LIMIT 1
    `, [rawKey]);

    if (url.pathname === "/v1/usage" && request.method === "GET") {
        if (key === null) return openAIError(401, "invalid_api_key", "Invalid API key");
        return handleKeyUsage(env.DB, key, url);
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const activeSub = key !== null
        ? await queryActiveSubscription(env.DB, key.user_id, key.group_id, nowIso)
        : null;
    const hasValidSubscription = isSubscriptionWithinLimits(activeSub, nowMs);

    const rejection = validateKey(key, request, hasValidSubscription);
    if (rejection !== null) return rejection;

    const requestBody = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.clone().arrayBuffer();
    const parsedRequestJson = parseRequestBody(requestBody);
    const requestedModel = typeof parsedRequestJson.model === "string" ? parsedRequestJson.model : undefined;
    const isStreamRequest = parsedRequestJson.stream === true;
    const preferredPlatform = inferPlatform(url.pathname, requestedModel);
    if (requestedModel && !pricingCatalog.getModelPricing(requestedModel).found) {
        return openAIError(400, "model_pricing_unavailable", "No verified price is configured for this model");
    }

    const accounts = await selectAccounts(env.DB, key!.user_id, key!.group_id, MAX_ROUTING_ATTEMPTS, preferredPlatform);
    if (accounts.length === 0) return openAIError(503, "no_available_account", "No schedulable upstream account is available");

    let lastFailure: { status: number; code: string; message: string } | null = null;
    const validSub = hasValidSubscription ? activeSub : null;

    for (let attempt = 0; attempt < accounts.length; attempt += 1) {
        const account = accounts[attempt];
        const creds = parseObject(account.credentials);
        const attemptNumber = attempt + 1;
        const rateMultiplier = (validSub?.group_rate_multiplier ?? key!.group_rate_multiplier ?? account.rate_multiplier ?? 1) || 1;

        if (account.platform.toLowerCase() === "gemini" && (creds.auth_type === "gemini_web" || creds.secure_1psid)) {
            let proxyUrl = "";
            if (account.proxy_id) {
                const proxy = await firstRow<{ protocol: string; host: string; port: number; username?: string; password?: string }>(env.DB, `
                    SELECT protocol, host, port, username, password FROM proxies WHERE id = ?
                `, [account.proxy_id]);
                if (proxy) {
                    const auth = proxy.username && proxy.password ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@` : "";
                    proxyUrl = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
                }
            }

            const { prompt, model, stream } = extractPromptFromRequest(parsedRequestJson);
            const startedAt = Date.now();
            try {
                const resp = await GeminiWebService.executeChatCompletion(prompt, model, creds as any, stream, proxyUrl);
                if (isRetryableStatus(resp.status)) {
                    const message = `Gemini Web upstream returned HTTP ${resp.status}`;
                    await markAccountFailure(env.DB, account.id, message, retryAfterMs(resp.headers));
                    lastFailure = { status: 502, code: "upstream_error", message };
                    if (attemptNumber < accounts.length) {
                        await resp.body?.cancel().catch(() => undefined);
                        continue;
                    }
                    return withRoutingHeaders(resp, account.id, attemptNumber, Date.now() - startedAt);
                }
                const durationMs = Date.now() - startedAt;
                const finalized = await finalizeGatewayResponse(env.DB, key!, account.id, resp, {
                    model,
                    stream,
                    durationMs,
                    subscription: validSub,
                    rateMultiplier,
                    serviceTier: typeof parsedRequestJson.service_tier === "string" ? parsedRequestJson.service_tier : undefined,
                    cacheRetention: typeof parsedRequestJson.prompt_cache_retention === "string" ? parsedRequestJson.prompt_cache_retention : undefined
                });
                return withRoutingHeaders(finalized, account.id, attemptNumber, durationMs);
            } catch (err) {
                if (err instanceof GatewayBillingError) return openAIError(500, "billing_error", "Unable to record gateway usage");
                const message = err instanceof Error ? err.message : "Gemini Web request failed";
                await markAccountFailure(env.DB, account.id, message);
                lastFailure = { status: 502, code: "upstream_error", message };
                if (attemptNumber < accounts.length) continue;
                break;
            }
        }

        if (account.platform.toLowerCase() === "deepseek" && (account.type === "deepseek_web" || creds.auth_type === "deepseek_web" || creds.deepseek_token)) {
            let proxyUrl = "";
            if (account.proxy_id) {
                const proxy = await firstRow<{ protocol: string; host: string; port: number; username?: string; password?: string }>(env.DB, `
                    SELECT protocol, host, port, username, password FROM proxies WHERE id = ?
                `, [account.proxy_id]);
                if (proxy) {
                    const auth = proxy.username && proxy.password ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@` : "";
                    proxyUrl = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
                }
            }

            const { prompt, model, stream } = extractPromptFromRequest(parsedRequestJson);
            const startedAt = Date.now();
            try {
                const resp = await DeepSeekWebService.executeChatCompletion(prompt, model, creds as any, stream, proxyUrl);
                if (isRetryableStatus(resp.status)) {
                    const message = `DeepSeek Web upstream returned HTTP ${resp.status}`;
                    await markAccountFailure(env.DB, account.id, message, retryAfterMs(resp.headers));
                    lastFailure = { status: 502, code: "upstream_error", message };
                    if (attemptNumber < accounts.length) {
                        await resp.body?.cancel().catch(() => undefined);
                        continue;
                    }
                    return withRoutingHeaders(resp, account.id, attemptNumber, Date.now() - startedAt);
                }
                const durationMs = Date.now() - startedAt;
                const finalized = await finalizeGatewayResponse(env.DB, key!, account.id, resp, {
                    model,
                    stream,
                    durationMs,
                    subscription: validSub,
                    rateMultiplier,
                    serviceTier: typeof parsedRequestJson.service_tier === "string" ? parsedRequestJson.service_tier : undefined,
                    cacheRetention: typeof parsedRequestJson.prompt_cache_retention === "string" ? parsedRequestJson.prompt_cache_retention : undefined
                });
                return withRoutingHeaders(finalized, account.id, attemptNumber, durationMs);
            } catch (err) {
                if (err instanceof GatewayBillingError) return openAIError(500, "billing_error", "Unable to record gateway usage");
                const message = err instanceof Error ? err.message : "DeepSeek Web request failed";
                await markAccountFailure(env.DB, account.id, message);
                lastFailure = { status: 502, code: "upstream_error", message };
                if (attemptNumber < accounts.length) continue;
                break;
            }
        }

        let upstream: { url: URL; headers: Headers };
        try {
            upstream = buildUpstream(request, url, account);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid account configuration";
            await markAccountFailure(env.DB, account.id, message);
            lastFailure = { status: 503, code: "account_configuration_error", message };
            if (attemptNumber < accounts.length) continue;
            break;
        }

        const startedAt = Date.now();
        try {
            const response = await fetch(upstream.url, {
                method: request.method,
                headers: upstream.headers,
                body: requestBody === undefined ? undefined : requestBody.slice(0),
                redirect: "manual"
            });
            if (isRetryableStatus(response.status)) {
                const message = `Upstream returned HTTP ${response.status}`;
                await markAccountFailure(env.DB, account.id, message, retryAfterMs(response.headers));
                lastFailure = { status: 502, code: "upstream_error", message };
                if (attemptNumber < accounts.length) {
                    await response.body?.cancel().catch(() => undefined);
                    continue;
                }
                return withRoutingHeaders(response, account.id, attemptNumber, Date.now() - startedAt);
            }
            const durationMs = Date.now() - startedAt;
            const finalized = await finalizeGatewayResponse(env.DB, key!, account.id, response, {
                model: requestedModel,
                stream: isStreamRequest,
                durationMs,
                subscription: validSub,
                rateMultiplier,
                serviceTier: typeof parsedRequestJson.service_tier === "string" ? parsedRequestJson.service_tier : undefined,
                cacheRetention: typeof parsedRequestJson.prompt_cache_retention === "string" ? parsedRequestJson.prompt_cache_retention : undefined
            });
            return withRoutingHeaders(finalized, account.id, attemptNumber, durationMs);
        } catch (error) {
            if (error instanceof GatewayBillingError) return openAIError(500, "billing_error", "Unable to record gateway usage");
            const message = error instanceof Error ? error.message : "Upstream request failed";
            await markAccountFailure(env.DB, account.id, message);
            lastFailure = { status: 502, code: "upstream_error", message };
            if (attemptNumber < accounts.length) continue;
            break;
        }
    }

    return openAIError(
        lastFailure?.status ?? 502,
        lastFailure?.code ?? "upstream_error",
        lastFailure?.message ?? "All available upstream accounts failed"
    );
}

async function queryActiveSubscription(
    db: D1Database,
    userId: number,
    groupId: number | null,
    nowIso: string
): Promise<GatewaySubscriptionRow | null> {
    const values: D1Value[] = [userId, nowIso];
    let groupFilter = "";
    if (groupId !== null) {
        groupFilter = "AND us.group_id = ?";
        values.push(groupId);
    }
    return firstRow<GatewaySubscriptionRow>(
        db,
        `SELECT us.id, us.group_id, us.starts_at, us.expires_at, us.status,
                us.daily_window_start, us.weekly_window_start, us.monthly_window_start,
                us.daily_usage_usd, us.weekly_usage_usd, us.monthly_usage_usd,
                g.name AS group_name, g.daily_limit_usd, g.weekly_limit_usd, g.monthly_limit_usd,
                g.rate_multiplier AS group_rate_multiplier
         FROM user_subscriptions us
         LEFT JOIN groups g ON g.id = us.group_id AND g.deleted_at IS NULL
         WHERE us.user_id = ?
           AND us.status = 'active'
           AND us.deleted_at IS NULL
           AND us.expires_at > ?
           ${groupFilter}
         ORDER BY us.expires_at DESC, us.id DESC
         LIMIT 1`,
        values
    );
}

function isSubscriptionWithinLimits(sub: GatewaySubscriptionRow | null, nowMs: number): boolean {
    if (sub === null) return false;
    if (
        (sub.daily_limit_usd ?? 0) > 0 &&
        (sub.daily_usage_usd ?? 0) >= (sub.daily_limit_usd ?? 0) &&
        isWindowActive(sub.daily_window_start, 24 * 3600_000, nowMs, sub.daily_usage_usd)
    ) {
        return false;
    }
    if (
        (sub.weekly_limit_usd ?? 0) > 0 &&
        (sub.weekly_usage_usd ?? 0) >= (sub.weekly_limit_usd ?? 0) &&
        isWindowActive(sub.weekly_window_start, 7 * 24 * 3600_000, nowMs, sub.weekly_usage_usd)
    ) {
        return false;
    }
    if (
        (sub.monthly_limit_usd ?? 0) > 0 &&
        (sub.monthly_usage_usd ?? 0) >= (sub.monthly_limit_usd ?? 0) &&
        isWindowActive(sub.monthly_window_start, 30 * 24 * 3600_000, nowMs, sub.monthly_usage_usd)
    ) {
        return false;
    }
    return true;
}

async function handleKeyUsage(db: D1Database, key: GatewayKeyRow, url: URL): Promise<Response> {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const todayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;

    const rawStartDate = url.searchParams.get("start_date")?.trim();
    const rawEndDate = url.searchParams.get("end_date")?.trim();
    const rawDays = url.searchParams.get("days")?.trim();

    const startDate = rawStartDate
        ? (/^\d{4}-\d{2}-\d{2}$/u.test(rawStartDate) ? `${rawStartDate}T00:00:00.000Z` : rawStartDate)
        : undefined;
    const endDate = rawEndDate
        ? (/^\d{4}-\d{2}-\d{2}$/u.test(rawEndDate) ? `${rawEndDate}T23:59:59.999Z` : rawEndDate)
        : undefined;

    const filterConditions: string[] = ["api_key_id = ?"];
    const filterValues: D1Value[] = [key.id];
    if (startDate !== undefined) {
        filterConditions.push("created_at >= ?");
        filterValues.push(startDate);
    }
    if (endDate !== undefined) {
        filterConditions.push("created_at <= ?");
        filterValues.push(endDate);
    }
    const filterWhere = filterConditions.join(" AND ");

    const todayRow = await firstRow<{
        requests: number;
        input_tokens: number;
        output_tokens: number;
        cache_creation_tokens: number;
        cache_read_tokens: number;
        total_cost: number;
        actual_cost: number;
    }>(
        db,
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(total_cost), 0) AS total_cost,
                COALESCE(SUM(actual_cost), 0) AS actual_cost
         FROM usage_logs
         WHERE api_key_id = ? AND created_at >= ?`,
        [key.id, todayStart]
    );

    const totalRow = await firstRow<{
        requests: number;
        input_tokens: number;
        output_tokens: number;
        cache_creation_tokens: number;
        cache_read_tokens: number;
        total_cost: number;
        actual_cost: number;
        avg_duration: number;
    }>(
        db,
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(total_cost), 0) AS total_cost,
                COALESCE(SUM(actual_cost), 0) AS actual_cost,
                COALESCE(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE NULL END), 0) AS avg_duration
         FROM usage_logs
         WHERE ${filterWhere}`,
        filterValues
    );

    const modelRows = await allRows<{
        model: string;
        requests: number;
        input_tokens: number;
        output_tokens: number;
        cache_creation_tokens: number;
        cache_read_tokens: number;
        cost: number;
        actual_cost: number;
    }>(
        db,
        `SELECT COALESCE(requested_model, model) AS model,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(total_cost), 0) AS cost,
                COALESCE(SUM(actual_cost), 0) AS actual_cost
         FROM usage_logs
         WHERE ${filterWhere}
         GROUP BY COALESCE(requested_model, model)
         ORDER BY requests DESC`,
        filterValues
    );

    const dailyConditions: string[] = ["api_key_id = ?"];
    const dailyValues: D1Value[] = [key.id];
    if (rawDays !== undefined && rawDays !== "") {
        const parsedDays = Math.min(365, Math.max(1, Number.parseInt(rawDays, 10) || 30));
        const dailyStart = new Date(nowMs - parsedDays * 86_400_000).toISOString();
        dailyConditions.push("created_at >= ?");
        dailyValues.push(dailyStart);
    } else {
        if (startDate !== undefined) {
            dailyConditions.push("created_at >= ?");
            dailyValues.push(startDate);
        }
        if (endDate !== undefined) {
            dailyConditions.push("created_at <= ?");
            dailyValues.push(endDate);
        }
    }

    const dailyRows = await allRows<{
        bucket: string;
        requests: number;
        input_tokens: number;
        output_tokens: number;
        cache_creation_tokens: number;
        cache_read_tokens: number;
        cost: number;
        actual_cost: number;
    }>(
        db,
        `SELECT strftime('%Y-%m-%d', created_at) AS bucket,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(total_cost), 0) AS cost,
                COALESCE(SUM(actual_cost), 0) AS actual_cost
         FROM usage_logs
         WHERE ${dailyConditions.join(" AND ")}
         GROUP BY bucket
         ORDER BY bucket ASC`,
        dailyValues
    );

    const todayTokens = (todayRow?.input_tokens ?? 0) + (todayRow?.output_tokens ?? 0) + (todayRow?.cache_creation_tokens ?? 0) + (todayRow?.cache_read_tokens ?? 0);
    const totalTokens = (totalRow?.input_tokens ?? 0) + (totalRow?.output_tokens ?? 0) + (totalRow?.cache_creation_tokens ?? 0) + (totalRow?.cache_read_tokens ?? 0);

    const usagePayload = {
        today: {
            requests: todayRow?.requests ?? 0,
            input_tokens: todayRow?.input_tokens ?? 0,
            output_tokens: todayRow?.output_tokens ?? 0,
            total_tokens: todayTokens,
            cache_creation_tokens: todayRow?.cache_creation_tokens ?? 0,
            cache_read_tokens: todayRow?.cache_read_tokens ?? 0,
            total_cost: todayRow?.total_cost ?? 0,
            actual_cost: todayRow?.actual_cost ?? 0
        },
        total: {
            requests: totalRow?.requests ?? 0,
            input_tokens: totalRow?.input_tokens ?? 0,
            output_tokens: totalRow?.output_tokens ?? 0,
            total_tokens: totalTokens,
            cache_creation_tokens: totalRow?.cache_creation_tokens ?? 0,
            cache_read_tokens: totalRow?.cache_read_tokens ?? 0,
            total_cost: totalRow?.total_cost ?? 0,
            actual_cost: totalRow?.actual_cost ?? 0
        },
        rpm: 0,
        tpm: 0,
        average_duration_ms: totalRow?.avg_duration ?? 0
    };

    const modelStats = modelRows.map((r) => ({
        model: r.model,
        requests: r.requests,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_creation_tokens: r.cache_creation_tokens,
        cache_read_tokens: r.cache_read_tokens,
        total_tokens: r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens,
        cost: r.cost,
        actual_cost: r.actual_cost
    }));

    const dailyUsage = dailyRows.map((r) => ({
        date: r.bucket,
        requests: r.requests,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_creation_tokens,
        cache_creation_tokens: r.cache_creation_tokens,
        total_tokens: r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens,
        cost: r.cost,
        actual_cost: r.actual_cost
    }));

    const isQuotaLimited = key.quota > 0 || (key.rate_limit_5h ?? 0) > 0 || (key.rate_limit_1d ?? 0) > 0 || (key.rate_limit_7d ?? 0) > 0;

    if (isQuotaLimited) {
        let effectiveStatus = key.status;
        if (effectiveStatus === "active") {
            if (key.expires_at !== null && Date.parse(key.expires_at) <= nowMs) {
                effectiveStatus = "expired";
            } else if (key.quota > 0 && key.quota_used >= key.quota) {
                effectiveStatus = "quota_exhausted";
            }
        }
        const rateLimits: Array<{ window: string; limit: number; used: number; reset_at: string | null }> = [];
        const windows: Array<{ window: "5h" | "1d" | "7d"; limit: number; used: number; start: string | null | undefined; durationMs: number }> = [
            { window: "5h", limit: key.rate_limit_5h ?? 0, used: key.usage_5h ?? 0, start: key.window_5h_start, durationMs: 5 * 3600_000 },
            { window: "1d", limit: key.rate_limit_1d ?? 0, used: key.usage_1d ?? 0, start: key.window_1d_start, durationMs: 24 * 3600_000 },
            { window: "7d", limit: key.rate_limit_7d ?? 0, used: key.usage_7d ?? 0, start: key.window_7d_start, durationMs: 7 * 24 * 3600_000 }
        ];
        for (const w of windows) {
            if (w.limit > 0) {
                const active = isWindowActive(w.start, w.durationMs, nowMs, w.used);
                const resetAt = w.start && active && Number.isFinite(Date.parse(w.start))
                    ? new Date(Date.parse(w.start) + w.durationMs).toISOString()
                    : null;
                rateLimits.push({
                    window: w.window,
                    limit: w.limit,
                    used: active ? w.used : 0,
                    reset_at: resetAt
                });
            }
        }

        return new Response(JSON.stringify({
            mode: "quota_limited",
            isValid: effectiveStatus === "active" && key.user_status === "active",
            status: effectiveStatus,
            quota: key.quota > 0
                ? {
                    limit: key.quota,
                    used: key.quota_used,
                    remaining: Math.max(0, key.quota - key.quota_used)
                }
                : null,
            expires_at: key.expires_at,
            days_until_expiry: key.expires_at !== null
                ? Math.max(0, Math.ceil((Date.parse(key.expires_at) - nowMs) / 86_400_000))
                : null,
            rate_limits: rateLimits,
            usage: usagePayload,
            model_stats: modelStats,
            daily_usage: dailyUsage
        }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
        });
    }

    const sub = await queryActiveSubscription(db, key.user_id, key.group_id, nowIso);
    const balance = key.user_balance ?? 0;

    return new Response(JSON.stringify({
        mode: "wallet",
        planName: sub?.group_name ?? null,
        balance,
        remaining: balance,
        subscription: sub
            ? {
                id: sub.id,
                group_id: sub.group_id,
                group_name: sub.group_name,
                status: sub.status,
                starts_at: sub.starts_at,
                expires_at: sub.expires_at,
                daily_usage_usd: sub.daily_usage_usd ?? 0,
                daily_limit_usd: sub.daily_limit_usd ?? null,
                weekly_usage_usd: sub.weekly_usage_usd ?? 0,
                weekly_limit_usd: sub.weekly_limit_usd ?? null,
                monthly_usage_usd: sub.monthly_usage_usd ?? 0,
                monthly_limit_usd: sub.monthly_limit_usd ?? null
            }
            : null,
        usage: usagePayload,
        model_stats: modelStats,
        daily_usage: dailyUsage
    }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
}

function readApiKey(request: Request): string {
    const authorization = request.headers.get("authorization")?.trim() ?? "";
    if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
    return (request.headers.get("x-api-key") ?? request.headers.get("api-key") ?? request.headers.get("x-goog-api-key") ?? "").trim();
}

function parseIpList(raw: string | null | undefined): string[] {
    if (!raw || raw.trim() === "") return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
    } catch {
        // Fallback to comma-separated list
    }
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function isWindowActive(
    windowStart: string | null | undefined,
    durationMs: number,
    nowMs: number,
    currentUsage = 0
): boolean {
    if (!windowStart) return (currentUsage ?? 0) > 0;
    const parsed = Date.parse(windowStart);
    if (!Number.isFinite(parsed)) return (currentUsage ?? 0) > 0;
    return parsed + durationMs > nowMs;
}

function validateKey(key: GatewayKeyRow | null, request?: Request, hasValidSubscription = false): Response | null {
    if (key === null) return openAIError(401, "invalid_api_key", "Invalid API key");
    if (key.status !== "active" || key.user_status !== "active") return openAIError(403, "account_inactive", "API key or user is inactive");
    const nowMs = Date.now();
    if (key.expires_at !== null && Date.parse(key.expires_at) <= nowMs) return openAIError(401, "api_key_expired", "API key has expired");
    if (key.quota > 0 && key.quota_used >= key.quota) return openAIError(429, "quota_exceeded", "API key quota has been exhausted");
    if (!hasValidSubscription && (key.user_balance ?? 0) <= 0) {
        return openAIError(402, "insufficient_balance", "User account balance is insufficient");
    }

    const clientIp = (
        request?.headers.get("cf-connecting-ip") ??
        request?.headers.get("x-forwarded-for")?.split(",")[0] ??
        request?.headers.get("x-real-ip") ??
        ""
    ).trim();
    const blacklist = parseIpList(key.ip_blacklist);
    if (blacklist.length > 0 && clientIp !== "" && blacklist.includes(clientIp)) {
        return openAIError(403, "ip_forbidden", "Client IP is blocked for this API key");
    }
    const whitelist = parseIpList(key.ip_whitelist);
    if (whitelist.length > 0 && (clientIp === "" || !whitelist.includes(clientIp))) {
        return openAIError(403, "ip_not_allowed", "Client IP is not in the API key whitelist");
    }

    if ((key.rate_limit_5h ?? 0) > 0 && (key.usage_5h ?? 0) >= (key.rate_limit_5h ?? 0) && isWindowActive(key.window_5h_start, 5 * 3600_000, nowMs, key.usage_5h)) {
        return openAIError(429, "rate_limit_exceeded", "API key 5h rate limit has been exceeded");
    }
    if ((key.rate_limit_1d ?? 0) > 0 && (key.usage_1d ?? 0) >= (key.rate_limit_1d ?? 0) && isWindowActive(key.window_1d_start, 24 * 3600_000, nowMs, key.usage_1d)) {
        return openAIError(429, "rate_limit_exceeded", "API key 1d rate limit has been exceeded");
    }
    if ((key.rate_limit_7d ?? 0) > 0 && (key.usage_7d ?? 0) >= (key.rate_limit_7d ?? 0) && isWindowActive(key.window_7d_start, 7 * 24 * 3600_000, nowMs, key.usage_7d)) {
        return openAIError(429, "rate_limit_exceeded", "API key 7d rate limit has been exceeded");
    }
    return null;
}

function inferPlatform(pathname: string, model?: string): string | undefined {
    if (pathname === "/antigravity" || pathname.startsWith("/antigravity/")) return "antigravity";
    if (pathname === "/v1beta" || pathname.startsWith("/v1beta/")) return "gemini";
    if (pathname === "/v1/messages" || pathname.startsWith("/v1/messages/")) return "anthropic";
    const m = (model ?? "").trim().toLowerCase();
    if (m.startsWith("claude-")) return "anthropic";
    if (m.startsWith("gemini-")) return "gemini";
    if (m.startsWith("deepseek-")) return "deepseek";
    if (m.startsWith("grok-")) return "grok";
    if (m.startsWith("glm-")) return "glm";
    if (m.startsWith("qwen-")) return "qwen";
    if (m.startsWith("moonshot-") || m.startsWith("kimi-")) return "kimi";
    if (m.startsWith("abab") || m.startsWith("minimax-")) return "minimax";
    if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("text-embedding-")) return "openai";
    return undefined;
}

async function querySchedulableAccounts(
    db: D1Database,
    userId: number,
    groupId: number | null,
    limit: number,
    platformFilter?: string
): Promise<GatewayAccountRow[]> {
    const now = new Date().toISOString();
    const values: D1Value[] = [];
    let groupJoin = "";
    let groupAccessClause = "";
    let extraClause = "";

    if (groupId !== null) {
        groupJoin = `
            JOIN account_groups ag ON ag.account_id = a.id AND ag.group_id = ?
            JOIN groups g ON g.id = ag.group_id AND g.deleted_at IS NULL AND g.status = 'active'
        `;
        values.push(groupId);
    }

    values.push(now, now, now, now);

    if (groupId !== null) {
        groupAccessClause = `
            AND (
                g.is_exclusive = 0
                OR EXISTS (
                    SELECT 1 FROM user_allowed_groups uag
                    WHERE uag.user_id = ? AND uag.group_id = g.id
                )
                OR EXISTS (
                    SELECT 1 FROM user_subscriptions us
                    WHERE us.user_id = ? AND us.group_id = g.id
                      AND us.status = 'active' AND us.deleted_at IS NULL AND us.expires_at > ?
                )
            )
        `;
        values.push(userId, userId, now);
    } else {
        groupAccessClause = `
            AND (
                NOT EXISTS (
                    SELECT 1 FROM account_groups ag_ex
                    JOIN groups g_ex ON g_ex.id = ag_ex.group_id
                    WHERE ag_ex.account_id = a.id
                      AND g_ex.deleted_at IS NULL
                      AND (g_ex.is_exclusive = 1 OR g_ex.subscription_type = 'subscription')
                      AND NOT EXISTS (
                          SELECT 1 FROM user_allowed_groups uag
                          WHERE uag.user_id = ? AND uag.group_id = g_ex.id
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM user_subscriptions us
                          WHERE us.user_id = ? AND us.group_id = g_ex.id
                            AND us.status = 'active' AND us.deleted_at IS NULL AND us.expires_at > ?
                      )
                )
                OR EXISTS (
                    SELECT 1 FROM account_groups ag_std
                    JOIN groups g_std ON g_std.id = ag_std.group_id
                    WHERE ag_std.account_id = a.id
                      AND g_std.deleted_at IS NULL
                      AND g_std.status = 'active'
                      AND g_std.is_exclusive = 0
                      AND g_std.subscription_type != 'subscription'
                )
            )
        `;
        values.push(userId, userId, now);
    }

    if (platformFilter) {
        extraClause = "AND LOWER(a.platform) = ?";
        values.push(platformFilter.toLowerCase());
    }
    const result = await db.prepare(`
        SELECT a.id, a.platform, a.type, a.credentials, a.extra, a.proxy_id,
               a.priority, a.rate_multiplier, a.last_used_at,
               ${groupId !== null ? "ag.priority" : "NULL"} AS group_priority
        FROM accounts a
        ${groupJoin}
        WHERE a.deleted_at IS NULL AND a.status = 'active' AND a.schedulable = 1
          AND (a.expires_at IS NULL OR a.expires_at > ?)
          AND (a.rate_limit_reset_at IS NULL OR a.rate_limit_reset_at <= ?)
          AND (a.temp_unschedulable_until IS NULL OR a.temp_unschedulable_until <= ?)
          AND (a.overload_until IS NULL OR a.overload_until <= ?)
          ${groupAccessClause}
          ${extraClause}
        ORDER BY ${groupId !== null ? "ag.priority ASC," : ""} a.priority ASC,
                 COALESCE(a.last_used_at, a.created_at) ASC, a.id ASC
        LIMIT ?
    `).bind(...values, Math.max(limit * 4, limit)).all<GatewayAccountRow>();
    return result.results ?? [];
}

async function selectAccounts(
    db: D1Database,
    userId: number,
    groupId: number | null,
    limit: number,
    preferredPlatform?: string
): Promise<GatewayAccountRow[]> {
    if (preferredPlatform) {
        const filtered = await querySchedulableAccounts(db, userId, groupId, limit, preferredPlatform);
        if (filtered.length > 0) {
            return weightedPriorityOrder(filtered).slice(0, limit);
        }
    }
    const all = await querySchedulableAccounts(db, userId, groupId, limit);
    return weightedPriorityOrder(all).slice(0, limit);
}

function weightedPriorityOrder(accounts: GatewayAccountRow[]): GatewayAccountRow[] {
    const tiers = new Map<string, GatewayAccountRow[]>();
    for (const account of accounts) {
        const effectivePriority = account.group_priority ?? account.priority;
        const key = `${effectivePriority}:${account.priority}`;
        const tier = tiers.get(key) ?? [];
        tier.push(account);
        tiers.set(key, tier);
    }
    const ordered: GatewayAccountRow[] = [];
    for (const tier of tiers.values()) {
        const pool = [...tier];
        while (pool.length > 0) {
            const weights = pool.map(account => routingWeight(account));
            const total = weights.reduce((sum, weight) => sum + weight, 0);
            let cursor = Math.random() * total;
            let selected = 0;
            for (let index = 0; index < pool.length; index += 1) {
                cursor -= weights[index];
                if (cursor <= 0) {
                    selected = index;
                    break;
                }
            }
            ordered.push(pool.splice(selected, 1)[0]);
        }
    }
    return ordered;
}

function routingWeight(account: GatewayAccountRow): number {
    const extra = parseObject(account.extra);
    const raw = extra.routing_weight ?? extra.routingWeight ?? 1;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function parseRequestBody(body: ArrayBuffer | undefined): Record<string, unknown> {
    if (body === undefined || body.byteLength === 0) return {};
    try {
        const parsed = JSON.parse(new TextDecoder().decode(body));
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(headers: Headers): number {
    const raw = headers.get("retry-after")?.trim();
    if (!raw) return DEFAULT_FAILURE_COOLDOWN_MS;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) return Math.max(1_000, timestamp - Date.now());
    return DEFAULT_FAILURE_COOLDOWN_MS;
}

interface GatewayUsage {
    model?: string;
    serviceTier?: string;
    hasUsage: boolean;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}

function readGatewayUsage(data: Record<string, unknown>): GatewayUsage {
    const objectValue = (value: unknown): Record<string, unknown> | undefined =>
        value !== null && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown> : undefined;
    const tokens = (value: unknown): number => {
        const count = Number(value);
        return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
    };
    const payload = objectValue(data.response) ?? objectValue(data.message) ?? data;
    const usage = objectValue(payload.usage) ?? objectValue(data.usage);
    const metadata = objectValue(data.usageMetadata);
    const details = objectValue(usage?.input_tokens_details) ?? objectValue(usage?.prompt_tokens_details);
    const includedCacheRead = tokens(details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? metadata?.cachedContentTokenCount);
    const includedCacheWrite = tokens(details?.cache_write_tokens);
    const totalInput = tokens(usage?.prompt_tokens ?? usage?.input_tokens ?? metadata?.promptTokenCount);
    const model = typeof payload.model === "string" ? payload.model.trim() : undefined;
    return {
        model: model || undefined,
        serviceTier: typeof payload.service_tier === "string" ? payload.service_tier : undefined,
        hasUsage: usage !== undefined || metadata !== undefined,
        inputTokens: Math.max(0, totalInput - includedCacheRead - includedCacheWrite),
        outputTokens: tokens(usage?.completion_tokens ?? usage?.output_tokens ?? metadata?.candidatesTokenCount),
        cacheCreationTokens: tokens(usage?.cache_creation_input_tokens ?? includedCacheWrite),
        cacheReadTokens: tokens(usage?.cache_read_input_tokens ?? includedCacheRead)
    };
}

class GatewayBillingError extends Error {}

function usageWindowUpdates(windows: Array<[string, string, number]>, cost: number, nowMs: number): { sql: string; values: D1Value[] } {
    const sql: string[] = [];
    const values: D1Value[] = [];
    const now = new Date(nowMs).toISOString();
    for (const [usage, start, durationMs] of windows) {
        const cutoff = new Date(nowMs - durationMs).toISOString();
        const active = `julianday(${start}) > julianday(?)`;
        sql.push(`${usage} = (CASE WHEN ${active} THEN COALESCE(${usage}, 0) ELSE 0 END) + ?`);
        sql.push(`${start} = CASE WHEN ${active} THEN ${start} ELSE ? END`);
        values.push(cutoff, cost, cutoff, now);
    }
    return { sql: sql.join(', '), values };
}

async function finalizeGatewayResponse(
    db: D1Database,
    key: GatewayKeyRow,
    accountId: number,
    response: Response,
    options: {
        model?: string;
        stream?: boolean;
        durationMs?: number;
        subscription?: GatewaySubscriptionRow | null;
        rateMultiplier?: number;
        serviceTier?: string;
        cacheRetention?: string;
    }
): Promise<Response> {
    if (!response.ok) return response;
    const contentType = response.headers.get("content-type") ?? "";
    const isSse = contentType.includes("text/event-stream") || (Boolean(options.stream) && !contentType.includes("application/json"));

    if (isSse && response.body !== null) {
        const decoder = new TextDecoder();
        let buffer = "";
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheCreationTokens = 0;
        let cacheReadTokens = 0;
        let upstreamModel = options.model || "unknown";
        let serviceTier = options.serviceTier;

        const processLine = (rawLine: string) => {
            const line = rawLine.trim();
            // Some compatible upstreams label a plain JSON response as SSE.
            const payload = line.startsWith("data:") ? line.slice(5).trim() : line.startsWith("{") ? line : "";
            if (!payload || payload === "[DONE]") return;
            try {
                const data = JSON.parse(payload) as Record<string, unknown>;
                if (!data || typeof data !== "object") return;
                const usage = readGatewayUsage(data);
                upstreamModel = usage.model ?? upstreamModel;
                serviceTier = usage.serviceTier ?? serviceTier;
                inputTokens = Math.max(inputTokens, usage.inputTokens);
                outputTokens = Math.max(outputTokens, usage.outputTokens);
                cacheCreationTokens = Math.max(cacheCreationTokens, usage.cacheCreationTokens);
                cacheReadTokens = Math.max(cacheReadTokens, usage.cacheReadTokens);
            } catch {
                // Ignore non-JSON SSE lines.
            }
        };

        const transform = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                controller.enqueue(chunk);
                buffer += decoder.decode(chunk, { stream: true });
                if (buffer.trimStart().startsWith("{")) return;
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                    processLine(line);
                }
            },
            async flush() {
                buffer += decoder.decode();
                for (const line of buffer.trimStart().startsWith("{") ? [buffer] : buffer.split("\n")) {
                    processLine(line);
                }
                await markGatewaySuccess(db, key, accountId, {
                    model: options.model,
                    upstreamModel,
                    inputTokens,
                    outputTokens,
                    cacheCreationTokens,
                    cacheReadTokens,
                    stream: true,
                    durationMs: options.durationMs,
                    forceLog: true,
                    subscription: options.subscription,
                    rateMultiplier: options.rateMultiplier,
                    serviceTier,
                    cacheRetention: options.cacheRetention
                });
            }
        });

        return new Response(response.body.pipeThrough(transform), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    }

    await markGatewaySuccess(db, key, accountId, {
        model: options.model,
        stream: options.stream,
        durationMs: options.durationMs,
        response,
        forceLog: Boolean(options.stream),
        subscription: options.subscription,
        rateMultiplier: options.rateMultiplier,
        serviceTier: options.serviceTier,
        cacheRetention: options.cacheRetention
    });
    return response;
}

async function markGatewaySuccess(
    db: D1Database,
    key: GatewayKeyRow,
    accountId: number,
    options?: {
        model?: string;
        upstreamModel?: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheCreationTokens?: number;
        cacheReadTokens?: number;
        stream?: boolean;
        durationMs?: number;
        response?: Response;
        forceLog?: boolean;
        subscription?: GatewaySubscriptionRow | null;
        rateMultiplier?: number;
        serviceTier?: string;
        cacheRetention?: string;
    }
): Promise<void> {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    let inputTokens = options?.inputTokens ?? 0;
    let outputTokens = options?.outputTokens ?? 0;
    let cacheCreationTokens = options?.cacheCreationTokens ?? 0;
    let cacheReadTokens = options?.cacheReadTokens ?? 0;
    let upstreamModel = options?.upstreamModel || options?.model || "unknown";
    let serviceTier = options?.serviceTier;
    let hasUsage = Boolean(options?.forceLog) || inputTokens > 0 || outputTokens > 0;

    const resp = options?.response;
    const contentType = resp?.headers.get("content-type") ?? "";
    if (resp && contentType.includes("application/json")) {
        try {
            const data = await resp.clone().json() as Record<string, unknown>;
            if (data && typeof data === "object") {
                const usage = readGatewayUsage(data);
                upstreamModel = usage.model ?? upstreamModel;
                serviceTier = usage.serviceTier ?? serviceTier;
                if (usage.hasUsage) {
                    hasUsage = true;
                    inputTokens = usage.inputTokens;
                    outputTokens = usage.outputTokens;
                    cacheCreationTokens = usage.cacheCreationTokens;
                    cacheReadTokens = usage.cacheReadTokens;
                }
            }
        } catch {
            // Ignore JSON parse errors on upstream bodies
        }
    }

    const pricing = findModelPricing(upstreamModel, {
        inputTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
        serviceTier, cacheRetention: options?.cacheRetention, timeMs: nowMs
    });
    if (pricing === null) throw new GatewayBillingError("No verified price is configured for upstream model or service tier");
    const baseCost = inputTokens * pricing.inputPrice +
          outputTokens * pricing.outputPrice +
          cacheCreationTokens * pricing.cacheWritePrice +
          cacheReadTokens * pricing.cacheReadPrice;
    const rateMultiplier = options?.rateMultiplier ?? 1;
    const costDelta = baseCost * rateMultiplier;

    // D1 batches are transactional: counters, balance and ledger commit together.
    // Window increments use current database values to avoid lost concurrent usage.
    const keyWindows = usageWindowUpdates([
        ["usage_5h", "window_5h_start", 5 * 3600_000],
        ["usage_1d", "window_1d_start", 24 * 3600_000],
        ["usage_7d", "window_7d_start", 7 * 24 * 3600_000]
    ], costDelta, nowMs);
    const statements: D1PreparedStatement[] = [
        db.prepare(`UPDATE api_keys
            SET last_used_at = ?, quota_used = COALESCE(quota_used, 0) + ?,
                ${keyWindows.sql}, updated_at = ? WHERE id = ?`)
            .bind(now, costDelta, ...keyWindows.values, now, key.id),
        db.prepare("UPDATE accounts SET last_used_at = ?, updated_at = ?, error_message = NULL WHERE id = ?")
            .bind(now, now, accountId)
    ];

    if (options?.subscription) {
        const sub = options.subscription;
        const subWindows = usageWindowUpdates([
            ["daily_usage_usd", "daily_window_start", 24 * 3600_000],
            ["weekly_usage_usd", "weekly_window_start", 7 * 24 * 3600_000],
            ["monthly_usage_usd", "monthly_window_start", 30 * 24 * 3600_000]
        ], costDelta, nowMs);
        statements.push(db.prepare(`UPDATE user_subscriptions SET ${subWindows.sql}, updated_at = ? WHERE id = ?`)
            .bind(...subWindows.values, now, sub.id));
    } else if (costDelta > 0) {
        statements.push(db.prepare("UPDATE users SET balance = balance - ?, updated_at = ? WHERE id = ?")
            .bind(costDelta, now, key.user_id));
    }

    if (hasUsage || inputTokens > 0 || outputTokens > 0 || options?.forceLog) {
        statements.push(db.prepare(`INSERT INTO usage_logs (
            request_id, model, requested_model, upstream_model,
            input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
            total_cost, actual_cost, rate_multiplier, billing_type,
            stream, duration_ms, created_at, api_key_id, account_id, group_id, user_id, subscription_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
                crypto.randomUUID(), upstreamModel, options?.model ?? upstreamModel, upstreamModel,
                inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
                baseCost, costDelta, rateMultiplier, options?.subscription ? 1 : 0,
                options?.stream ? 1 : 0, options?.durationMs ?? 0, now,
                key.id, accountId, key.group_id, key.user_id, options?.subscription?.id ?? null
            ));
    }

    try {
        const results = await db.batch(statements);
        if (results.some(result => !result.success)) throw new Error("D1 billing batch failed");
    } catch (error) {
        console.error("Gateway billing transaction failed", error);
        throw new GatewayBillingError("Unable to record gateway usage");
    }
}

async function markAccountFailure(db: D1Database, accountId: number, message: string, cooldownMs = DEFAULT_FAILURE_COOLDOWN_MS): Promise<void> {
    const now = new Date();
    const until = new Date(now.getTime() + Math.max(1_000, cooldownMs)).toISOString();
    await runStatement(
        db,
        "UPDATE accounts SET error_message = ?, temp_unschedulable_until = ?, temp_unschedulable_reason = ?, updated_at = ? WHERE id = ?",
        [message, until, "gateway_failover", now.toISOString(), accountId]
    );
}

function withRoutingHeaders(response: Response, accountId: number, attempt: number, latencyMs: number): Response {
    const headers = new Headers(response.headers);
    headers.set("x-sub2api-account-id", String(accountId));
    headers.set("x-sub2api-routing-attempt", String(attempt));
    headers.set("x-sub2api-upstream-latency-ms", String(latencyMs));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function extractPromptFromRequest(bodyJson: Record<string, unknown>): { prompt: string; model: string; stream: boolean } {
    let prompt = "";
    const model = typeof bodyJson.model === "string" ? bodyJson.model : "gemini-2.5-pro";
    const stream = bodyJson.stream === true;

    if (Array.isArray(bodyJson.messages)) {
        const parts: string[] = [];
        for (const msg of bodyJson.messages) {
            if (msg && typeof msg === "object") {
                const role = (msg as any).role || "user";
                let content = "";
                if (typeof (msg as any).content === "string") {
                    content = (msg as any).content;
                } else if (Array.isArray((msg as any).content)) {
                    content = (msg as any).content.map((c: any) => typeof c === "string" ? c : c?.text || "").join("\n");
                }
                if (content.trim()) {
                    parts.push(`${role}: ${content}`);
                }
            }
        }
        prompt = parts.join("\n\n");
    } else if (Array.isArray(bodyJson.contents)) {
        const parts: string[] = [];
        for (const c of bodyJson.contents) {
            if (c && Array.isArray((c as any).parts)) {
                for (const p of (c as any).parts) {
                    if (p && typeof p.text === "string") parts.push(p.text);
                }
            }
        }
        prompt = parts.join("\n\n");
    } else if (typeof bodyJson.prompt === "string") {
        prompt = bodyJson.prompt;
    }
    return { prompt, model, stream };
}

const ROOT_OPENAI_PATHS = ["/chat/completions", "/responses", "/embeddings", "/images", "/videos"];

function buildUpstream(request: Request, incoming: URL, account: GatewayAccountRow): { url: URL; headers: Headers } {
    const credentials = parseObject(account.credentials);
    const extra = parseObject(account.extra);
    const platform = account.platform.toLowerCase();
    const defaultBase = platform === "anthropic" || platform === "antigravity"
        ? "https://api.anthropic.com"
        : platform === "gemini"
            ? "https://generativelanguage.googleapis.com"
            : platform === "grok"
                ? "https://api.x.ai"
                : platform === "deepseek"
                    ? "https://api.deepseek.com"
                    : platform === "glm"
                        ? "https://open.bigmodel.cn/api/paas/v4"
                        : platform === "minimax"
                            ? "https://api.minimax.chat/v1"
                            : platform === "qwen"
                                ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
                                : (platform === "kimi" || platform === "moonshot")
                                    ? "https://api.moonshot.cn/v1"
                                    : "https://api.openai.com";
    const base = stringValue(credentials.base_url, credentials.baseUrl, extra.base_url, extra.baseUrl) || defaultBase;
    const upstream = new URL(base);
    let incomingPath = platform === "glm" && incoming.pathname.startsWith("/v1/")
        ? incoming.pathname.replace(/^\/v1\//, "/")
        : incoming.pathname;
    if (
        platform === "openai" &&
        (upstream.pathname === "/" || upstream.pathname === "") &&
        !incomingPath.startsWith("/v1/") &&
        ROOT_OPENAI_PATHS.some((prefix) => incomingPath === prefix || incomingPath.startsWith(`${prefix}/`))
    ) {
        incomingPath = `/v1${incomingPath}`;
    }
    upstream.pathname = joinPath(upstream.pathname, incomingPath);
    upstream.search = incoming.search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("cf-connecting-ip");
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.delete("api-key");
    headers.delete("x-goog-api-key");
    headers.set(PROXY_HOP_HEADER, "1");
    const token = stringValue(credentials.api_key, credentials.apiKey, credentials.access_token, credentials.accessToken, credentials.token);
    if (token === "") throw new Error(`Account ${account.id} has no upstream credential`);
    if (platform === "anthropic" || platform === "antigravity") {
        headers.set("x-api-key", token);
        if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    } else if (platform === "gemini") {
        upstream.searchParams.set("key", token);
    } else {
        headers.set("authorization", `Bearer ${token}`);
    }
    return { url: upstream, headers };
}

function parseObject(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function stringValue(...values: unknown[]): string {
    for (const value of values) if (typeof value === "string" && value.trim() !== "") return value.trim();
    return "";
}

function joinPath(base: string, path: string): string {
    const prefix = base === "/" ? "" : base.replace(/\/$/, "");
    const normalizedPath = path.replace(/^\//, "");
    const normalizedPrefix = prefix.replace(/^\//, "");
    if (normalizedPrefix !== "" && (normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`))) {
        return `/${normalizedPath}`;
    }
    const prefixSegment = normalizedPrefix.split("/").filter(Boolean).pop();
    if (prefixSegment && (normalizedPath === prefixSegment || normalizedPath.startsWith(`${prefixSegment}/`))) {
        return `${prefix}/${normalizedPath.slice(prefixSegment.length).replace(/^\//, "")}`;
    }
    return `${prefix}/${normalizedPath}`;
}

function openAIError(status: number, code: string, message: string): Response {
    return new Response(JSON.stringify({ error: { message, type: code, code } }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
}
