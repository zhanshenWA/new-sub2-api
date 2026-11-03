import type { AccountRecord, AccountGroupRecord, MixedChannelRiskRecord } from "../repositories/accounts.ts";
import { D1AccountRepository } from "../repositories/accounts.ts";
import { D1ProxyRepository } from "../repositories/proxies.ts";
import { D1AdminOAuthService, AdminOAuthError } from "./admin-oauth.ts";
import type { D1Database, D1Value } from "../types/d1.ts";

export class AccountError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code: string) {
        super(message);
        this.name = "AccountError";
        this.status = status;
        this.code = code;
    }
}

export function errNotFound(): AccountError {
    return new AccountError(404, "Account not found", "ACCOUNT_NOT_FOUND");
}

export function errConflict(msg: string): AccountError {
    return new AccountError(409, msg, "ACCOUNT_CONFLICT");
}

export function errBadRequest(msg: string): AccountError {
    return new AccountError(400, msg, "BAD_REQUEST");
}

export function getDefaultBaseUrl(platform: string): string {
    const p = platform.toLowerCase();
    switch (p) {
        case "anthropic":
        case "antigravity":
            return "https://api.anthropic.com";
        case "gemini":
            return "https://generativelanguage.googleapis.com";
        case "grok":
            return "https://api.x.ai";
        case "deepseek":
            return "https://api.deepseek.com";
        case "glm":
            return "https://open.bigmodel.cn/api/paas/v4";
        case "minimax":
            return "https://api.minimax.chat/v1";
        case "qwen":
            return "https://dashscope.aliyuncs.com/compatible-mode/v1";
        case "kimi":
        case "moonshot":
            return "https://api.moonshot.cn/v1";
        default:
            return "https://api.openai.com";
    }
}

export interface CreateAccountInput {
    name: string;
    notes?: string;
    platform?: string;
    type?: string;
    credentials?: string;
    extra?: string;
    proxyId?: number | null;
    concurrency?: number;
    priority?: number;
    rateMultiplier?: number;
    loadFactor?: number | null;
    groupIds?: number[];
    expiresAt?: string | null;
    autoPauseOnExpired?: boolean;
    proxyFallbackOriginId?: number | null;
    proxy_id?: number | null;
    rate_multiplier?: number;
    load_factor?: number | null;
    group_ids?: number[];
    expires_at?: string | number | null;
    auto_pause_on_expired?: boolean;
}

export type UpdateAccountInput = Partial<{
    name: string;
    notes: string | null;
    platform: string;
    type: string;
    credentials: string;
    extra: string;
    proxyId: number | null;
    concurrency: number;
    priority: number;
    rateMultiplier: number;
    loadFactor: number | null;
    status: string;
    groupIds: number[];
    expiresAt: string | null;
    autoPauseOnExpired: boolean;
    proxyFallbackOriginId: number | null;
    schedulable: boolean;
}>;

export interface AccountStats {
    total_requests: number;
    total_cost: number;
    current_concurrency: number;
    active_sessions: number;
    current_rpm: number;
    current_window_cost: number | null;
}

export interface TodayStats {
    requests: number;
    tokens: number;
    cost: number;
    actual_cost: number;
    user_cost: number;
}

export interface UsageProgress {
    utilization: number;
    resets_at: string | null;
    remaining_seconds: number;
    window_stats?: TodayStats | null;
    used_requests?: number;
    limit_requests?: number;
}

export interface AccountUsageInfo {
    source?: "passive" | "active";
    updated_at: string | null;
    five_hour: UsageProgress | null;
    seven_day: UsageProgress | null;
    seven_day_sonnet: UsageProgress | null;
    grok_local_usage?: TodayStats | null;
    grok_local_usage_24h?: TodayStats | null;
    grok_local_usage_7d?: TodayStats | null;
    grok_local_usage_monthly?: TodayStats | null;
    is_forbidden?: boolean;
    forbidden_reason?: string;
    needs_reauth?: boolean;
    error?: string;
}

export interface MixedChannelRiskResult {
    has_risk: boolean;
    message: string;
    details?: MixedChannelRiskRecord;
}

const PLATFORM_MODELS: Record<string, string[]> = {
    anthropic: ["claude-3-5-sonnet-20241022", "claude-3-7-sonnet-20250219", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-fable-5"],
    openai: ["gpt-4o", "gpt-4o-mini", "gpt-5.2", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-image-1", "gpt-image-1.5", "gpt-image-2"],
    gemini: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3-pro-preview", "gemini-3.1-flash-image"],
    antigravity: ["claude-fable-5", "claude-opus-4-6", "claude-opus-4-6-thinking", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-5", "claude-sonnet-4-6", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash", "gemini-3-pro-high", "gemini-3.1-pro", "gemini-3.1-flash-image", "gpt-oss-120b-medium"],
    grok: ["grok-3", "grok-4", "grok-4.5"],
    bedrock: ["claude-fable-5", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"],
    deepseek: ["deepseek-chat", "deepseek-reasoner"],
    glm: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-4.7", "glm-4.7-flash", "glm-5v-turbo", "glm-4.6v", "glm-4-long"],
    minimax: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-Text-01", "MiniMax-VL-01", "abab6.5s-chat"],
    qwen: ["qwen3.8-max-0902", "qwen3.8-max", "qwen3.8-flash", "qwen3-max", "qwen3.5-omni-flash", "qwen3-vl-flash", "qwen-max", "qwen-plus", "qwen-turbo", "qwen-flash", "qwq-32b"],
    kimi: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"],
    moonshot: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"]
};

const ANTIGRAVITY_DEFAULT_MODEL_MAPPING: Record<string, string> = {
    "claude-fable-5": "claude-fable-5",
    "claude-opus-4-8": "claude-opus-4-8",
    "claude-opus-4-7": "claude-opus-4-7",
    "claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
    "claude-opus-4-6": "claude-opus-4-6-thinking",
    "claude-opus-4-5-thinking": "claude-opus-4-6-thinking",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking": "claude-sonnet-4-5-thinking",
    "claude-opus-4-5-20251101": "claude-opus-4-6-thinking",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
    "claude-haiku-4-5": "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001": "claude-sonnet-4-6",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.5-flash-image": "gemini-2.5-flash-image",
    "gemini-2.5-flash-image-preview": "gemini-2.5-flash-image",
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
    "gemini-2.5-flash-thinking": "gemini-2.5-flash-thinking",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-3-flash": "gemini-3-flash",
    "gemini-3-pro-high": "gemini-3-pro-high",
    "gemini-3-pro-low": "gemini-3-pro-low",
    "gemini-3-flash-preview": "gemini-3-flash",
    "gemini-3-pro-preview": "gemini-3-pro-high",
    "gemini-pro-agent": "gemini-pro-agent",
    "gemini-3.1-pro": "gemini-pro-agent",
    "gemini-3.1-pro-high": "gemini-pro-agent",
    "gemini-3.1-pro-low": "gemini-3.1-pro-low",
    "gemini-3.1-pro-preview": "gemini-pro-agent",
    "gemini-3.1-flash-image": "gemini-3.1-flash-image",
    "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image",
    "gemini-3-pro-image": "gemini-3.1-flash-image",
    "gemini-3-pro-image-preview": "gemini-3.1-flash-image",
    "gpt-oss-120b-medium": "gpt-oss-120b-medium",
    "tab_flash_lite_preview": "tab_flash_lite_preview"
};

export class D1AccountService {
    private db: D1Database;
    private repo: D1AccountRepository;

    constructor(db: D1Database) {
        this.db = db;
        this.repo = new D1AccountRepository(db);
    }

    private parseJsonObject(value: string, field: string): Record<string, unknown> {
        try {
            const parsed = JSON.parse(value) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
            return parsed as Record<string, unknown>;
        } catch {
            throw errBadRequest(`${field} must be a JSON object`);
        }
    }

    private normalizeDate(value: string | number | null | undefined): string | null | undefined {
        if (value === undefined) return undefined;
        if (value === null || value === 0 || value === "") return null;
        if (typeof value === "number") return new Date(value * 1000).toISOString();
        return value;
    }

    private toAccountJson(a: AccountRecord): Record<string, unknown> {
        return {
            id: a.id,
            name: a.name,
            notes: a.notes,
            platform: a.platform,
            type: a.type,
            credentials: JSON.parse(a.credentials),
            extra: JSON.parse(a.extra),
            proxy_fallback_origin_id: a.proxyFallbackOriginId,
            concurrency: a.concurrency,
            load_factor: a.loadFactor,
            priority: a.priority,
            rate_multiplier: a.rateMultiplier,
            status: a.status,
            error_message: a.errorMessage,
            last_used_at: a.lastUsedAt,
            expires_at: a.expiresAt,
            auto_pause_on_expired: a.autoPauseOnExpired,
            schedulable: a.schedulable,
            rate_limited_at: a.rateLimitedAt,
            rate_limit_reset_at: a.rateLimitResetAt,
            overload_until: a.overloadUntil,
            temp_unschedulable_until: a.tempUnschedulableUntil,
            temp_unschedulable_reason: a.tempUnschedulableReason,
            session_window_start: a.sessionWindowStart,
            session_window_end: a.sessionWindowEnd,
            session_window_status: a.sessionWindowStatus,
            quota_dimension: a.quotaDimension,
            proxy_id: a.proxyId,
            parent_account_id: a.parentAccountId,
            created_at: a.createdAt,
            updated_at: a.updatedAt
        };
    }

    async list(params: {
        page: number; pageSize: number; platform?: string; type?: string; status?: string;
        search?: string; groupId?: number; groupUngrouped?: boolean; privacyMode?: string;
        sortBy?: string; sortOrder?: string
    }): Promise<{ items: Record<string, unknown>[]; total: number }> {
        const result = await this.repo.list(params);
        return { items: result.items.map(a => this.toAccountJson(a)), total: result.total };
    }

    async listAll(): Promise<Record<string, unknown>[]> {
        const accounts = await this.repo.listAll();
        return accounts.map(a => this.toAccountJson(a));
    }

    async getById(id: number): Promise<Record<string, unknown>> {
        const account = await this.repo.getById(id);
        if (!account) throw errNotFound();
        return this.toAccountJson(account);
    }

    async testConnectivity(id: number): Promise<{ success: boolean; message: string; latency_ms: number }> {
        const account = await this.repo.getById(id);
        if (!account) throw errNotFound();
        const credentials = this.parseJsonObject(account.credentials, "credentials");
        const extra = this.parseJsonObject(account.extra, "extra");
        const rawBase = [credentials.base_url, credentials.baseUrl, extra.base_url, extra.baseUrl].find((value): value is string => typeof value === "string" && value.trim() !== "")
            ?? getDefaultBaseUrl(account.platform);
        const target = new URL(rawBase);
        const lowerPath = target.pathname.replace(/\/+$/u, "").toLowerCase();
        if (account.platform === "gemini") {
            target.pathname = lowerPath.endsWith("/v1beta/models") ? target.pathname : `${lowerPath.endsWith("/v1beta") ? lowerPath : `${lowerPath}/v1beta`}/models`;
        } else if (account.platform === "glm") {
            target.pathname = lowerPath.endsWith("/models") ? target.pathname : `${lowerPath}/models`;
        } else {
            target.pathname = lowerPath.endsWith("/v1/models") ? target.pathname : `${lowerPath.endsWith("/v1") ? lowerPath : `${lowerPath}/v1`}/models`;
        }
        target.search = "";
        const token = [credentials.api_key, credentials.apiKey, credentials.access_token, credentials.accessToken, credentials.token].find((value): value is string => typeof value === "string" && value.trim() !== "");
        if (!token) throw errBadRequest("Account has no upstream credential");
        const headers = new Headers({ accept: "application/json" });
        if (account.platform === "anthropic") {
            headers.set("x-api-key", token);
            headers.set("anthropic-version", "2023-06-01");
        } else if (account.platform === "gemini") {
            headers.set("x-goog-api-key", token);
        } else {
            headers.set("authorization", `Bearer ${token}`);
        }
        const started = Date.now();
        try {
            const response = await fetch(target, { method: "GET", headers });
            const latency_ms = Date.now() - started;
            if (!response.ok) return { success: false, message: `Upstream returned HTTP ${response.status}`, latency_ms };
            return { success: true, message: "Account connectivity test succeeded", latency_ms };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : "Upstream request failed", latency_ms: Date.now() - started };
        }
    }

    async create(input: CreateAccountInput): Promise<Record<string, unknown>> {
        const name = input.name?.trim();
        if (!name) throw errBadRequest("name is required");
        if (name.length > 100) throw errBadRequest("name must be at most 100 characters");

        const exists = await this.repo.existsByName(name);
        if (exists) throw errConflict(`Account "${name}" already exists`);

        const platform = input.platform ?? "openai";
        const validPlatforms = ["anthropic", "openai", "gemini", "antigravity", "grok", "bedrock", "vertex", "deepseek", "glm", "minimax", "qwen", "kimi", "moonshot"];
        if (!validPlatforms.includes(platform)) throw errBadRequest(`Invalid platform: ${platform}`);

        const type = input.type ?? "apikey";
        const validTypes = ["oauth", "setup-token", "apikey", "upstream", "bedrock", "service_account", "deepseek_web", "web_cookie"];
        if (!validTypes.includes(type)) throw errBadRequest(`Invalid type: ${type}`);

        const rateMultiplier = input.rateMultiplier ?? input.rate_multiplier;
        if (rateMultiplier !== undefined && rateMultiplier < 0) {
            throw errBadRequest("rate_multiplier must be >= 0");
        }

        let credentials: string;
        try {
            credentials = typeof input.credentials === "string" ? input.credentials : JSON.stringify(input.credentials ?? {});
            JSON.parse(credentials);
        } catch {
            throw errBadRequest("credentials must be valid JSON");
        }

        let extra: string;
        try {
            extra = typeof input.extra === "string" ? input.extra : JSON.stringify(input.extra ?? {});
            JSON.parse(extra);
        } catch {
            throw errBadRequest("extra must be valid JSON");
        }

        const vals: Record<string, D1Value> = {
            name,
            notes: input.notes ?? "",
            platform,
            type,
            credentials,
            extra,
            proxy_fallback_origin_id: input.proxyFallbackOriginId ?? null,
            proxy_id: input.proxyId ?? input.proxy_id ?? null,
            concurrency: input.concurrency ?? 3,
            load_factor: input.loadFactor ?? input.load_factor ?? null,
            priority: input.priority ?? 50,
            rate_multiplier: rateMultiplier ?? 1.0,
            status: "active",
            auto_pause_on_expired: (input.autoPauseOnExpired ?? input.auto_pause_on_expired) !== undefined ? ((input.autoPauseOnExpired ?? input.auto_pause_on_expired) ? 1 : 0) : 1,
            schedulable: 1,
            quota_dimension: "global",
            parent_account_id: null
        };

        const expiresAt = this.normalizeDate(input.expiresAt ?? input.expires_at);
        if (expiresAt !== undefined) vals.expires_at = expiresAt;

        const account = await this.repo.create(vals);

        const groupIds = input.groupIds ?? input.group_ids;
        if (groupIds && groupIds.length > 0) {
            await this.repo.setGroups(account.id, groupIds);
        }

        return this.toAccountJson(account);
    }

    async update(id: number, input: UpdateAccountInput): Promise<Record<string, unknown>> {
        const existing = await this.repo.getById(id);
        if (!existing) throw errNotFound();

        const updates: Record<string, D1Value> = {};

        const fields: Array<[string, string, string]> = [
            ["name", "name", "name"], ["notes", "notes", "notes"], ["platform", "platform", "platform"], ["type", "type", "type"],
            ["credentials", "credentials", "credentials"], ["extra", "extra", "extra"],
            ["proxy_id", "proxyId", "proxy_id"], ["concurrency", "concurrency", "concurrency"], ["priority", "priority", "priority"],
            ["rate_multiplier", "rateMultiplier", "rate_multiplier"], ["load_factor", "loadFactor", "load_factor"],
            ["status", "status", "status"], ["expires_at", "expiresAt", "expires_at"],
            ["auto_pause_on_expired", "autoPauseOnExpired", "auto_pause_on_expired"],
            ["schedulable", "schedulable", "schedulable"],
            ["proxy_fallback_origin_id", "proxyFallbackOriginId", "proxy_fallback_origin_id"]
        ];

        for (const [col, camelKey, snakeKey] of fields) {
            const val = (input as Record<string, unknown>)[camelKey] ?? (input as Record<string, unknown>)[snakeKey];
            if (val !== undefined) {
                if (val === null) {
                    updates[col] = null;
                } else if (typeof val === "boolean") {
                    updates[col] = val ? 1 : 0;
                } else if (col === "expires_at" && (typeof val === "string" || typeof val === "number")) {
                    updates[col] = this.normalizeDate(val) ?? null;
                } else if (col === "proxy_id" && val === 0) {
                    updates[col] = null;
                } else if (col === "load_factor" && typeof val === "number" && val <= 0) {
                    updates[col] = null;
                } else if (typeof val === "string" || typeof val === "number") {
                    updates[col] = val;
                } else {
                    updates[col] = JSON.stringify(val);
                }
            }
        }

        const groupIds = (input as Record<string, unknown>)["groupIds"] ?? (input as Record<string, unknown>)["group_ids"];
        if (Object.keys(updates).length === 0) {
            if (Array.isArray(groupIds)) await this.repo.setGroups(id, groupIds.map(Number));
            return this.toAccountJson(existing);
        }

        if (updates["name"] !== undefined && typeof updates["name"] === "string") {
            const newName = (updates["name"] as string).trim();
            if (newName !== existing.name) {
                const exists = await this.repo.existsByName(newName);
                if (exists) throw errConflict(`Account "${newName}" already exists`);
            }
            updates["name"] = newName;
        }

        const updated = await this.repo.update(id, updates);
        if (!updated) throw errNotFound();
        if (Array.isArray(groupIds)) await this.repo.setGroups(id, groupIds.map(Number));
        return this.toAccountJson(updated);
    }

    async delete(id: number): Promise<void> {
        const ok = await this.repo.delete(id);
        if (!ok) throw errNotFound();
    }

    async setGroups(accountId: number, groupIds: number[]): Promise<void> {
        const existing = await this.repo.getById(accountId);
        if (!existing) throw errNotFound();
        await this.repo.setGroups(accountId, groupIds);
    }

    async getGroups(accountId: number): Promise<AccountGroupRecord[]> {
        const existing = await this.repo.getById(accountId);
        if (!existing) throw errNotFound();
        return this.repo.getGroups(accountId);
    }

    async batchCreate(inputs: CreateAccountInput[]): Promise<Record<string, unknown>[]> {
        const results: Record<string, unknown>[] = [];
        for (const input of inputs) {
            const created = await this.create(input);
            results.push(created);
        }
        return results;
    }

    async batchUpdateCredentials(accountIds: number[], credentials: string, extra?: string): Promise<{ updated: number }> {
        const updated = await this.repo.batchUpdateCredentials(accountIds, credentials, extra);
        return { updated };
    }

    async getAccountStats(accountId: number): Promise<AccountStats> {
        const existing = await this.repo.getById(accountId);
        if (!existing) throw errNotFound();
        return {
            total_requests: 0,
            total_cost: 0,
            current_concurrency: 0,
            active_sessions: 0,
            current_rpm: 0,
            current_window_cost: null
        };
    }

    async getUsageStats(accountId: number, days: number): Promise<Record<string, unknown>> {
        const existing = await this.repo.getById(accountId);
        if (!existing) throw errNotFound();
        const safeDays = Math.min(365, Math.max(1, days));
        const startAt = new Date(Date.now() - (safeDays - 1) * 86400000).toISOString().slice(0, 10);
        const daily = await this.repo.getDailyStats(accountId, startAt);
        const models = await this.repo.getDimensionStats(accountId, startAt, "model");
        let endpoints: Awaited<ReturnType<D1AccountRepository["getDimensionStats"]>> = [];
        let upstreamEndpoints: Awaited<ReturnType<D1AccountRepository["getDimensionStats"]>> = [];
        try {
            endpoints = await this.repo.getDimensionStats(accountId, startAt, "inbound_endpoint");
            upstreamEndpoints = await this.repo.getDimensionStats(accountId, startAt, "upstream_endpoint");
        } catch {
            // Older D1 schemas do not have endpoint columns; core usage statistics remain available.
        }
        const totalRequests = daily.reduce((sum, item) => sum + item.requests, 0);
        const totalTokens = daily.reduce((sum, item) => sum + item.tokens, 0);
        const totalCost = daily.reduce((sum, item) => sum + item.accountCost, 0);
        const totalUserCost = daily.reduce((sum, item) => sum + item.userCost, 0);
        const totalStandardCost = daily.reduce((sum, item) => sum + item.standardCost, 0);
        const actualDaysUsed = daily.length;
        const todayDate = new Date().toISOString().slice(0, 10);
        const today = daily.find((item) => item.date === todayDate) ?? null;
        const highestCostDay = daily.reduce<typeof daily[number] | null>((best, item) => !best || item.accountCost > best.accountCost ? item : best, null);
        const highestRequestDay = daily.reduce<typeof daily[number] | null>((best, item) => !best || item.requests > best.requests ? item : best, null);
        const avgDurationMs = actualDaysUsed > 0 ? daily.reduce((sum, item) => sum + item.durationMs, 0) / actualDaysUsed : 0;
        return {
            history: daily.map((item) => ({ date: item.date, label: item.date, requests: item.requests, tokens: item.tokens, cost: item.accountCost, actual_cost: item.accountCost, user_cost: item.userCost })),
            summary: {
                days: safeDays,
                actual_days_used: actualDaysUsed,
                total_cost: totalCost,
                total_user_cost: totalUserCost,
                total_standard_cost: totalStandardCost,
                total_requests: totalRequests,
                total_tokens: totalTokens,
                avg_daily_cost: actualDaysUsed > 0 ? totalCost / actualDaysUsed : 0,
                avg_daily_user_cost: actualDaysUsed > 0 ? totalUserCost / actualDaysUsed : 0,
                avg_daily_requests: actualDaysUsed > 0 ? totalRequests / actualDaysUsed : 0,
                avg_daily_tokens: actualDaysUsed > 0 ? totalTokens / actualDaysUsed : 0,
                avg_duration_ms: avgDurationMs,
                today: today ? { date: today.date, cost: today.accountCost, user_cost: today.userCost, requests: today.requests, tokens: today.tokens } : null,
                highest_cost_day: highestCostDay ? { date: highestCostDay.date, label: highestCostDay.date, cost: highestCostDay.accountCost, user_cost: highestCostDay.userCost, requests: highestCostDay.requests } : null,
                highest_request_day: highestRequestDay ? { date: highestRequestDay.date, label: highestRequestDay.date, requests: highestRequestDay.requests, cost: highestRequestDay.accountCost, user_cost: highestRequestDay.userCost } : null
            },
            models: models.map((item) => ({ model: item.key, requests: item.requests, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: item.tokens, cost: item.standardCost, actual_cost: item.userCost, account_cost: item.accountCost })),
            endpoints: endpoints.map((item) => ({ endpoint: item.key, requests: item.requests, total_tokens: item.tokens, cost: item.standardCost, actual_cost: item.userCost })),
            upstream_endpoints: upstreamEndpoints.map((item) => ({ endpoint: item.key, requests: item.requests, total_tokens: item.tokens, cost: item.standardCost, actual_cost: item.userCost }))
        };
    }

    async getUsage(accountId: number): Promise<AccountUsageInfo> {
        const existing = await this.repo.getById(accountId);
        if (!existing) throw errNotFound();
        const zeroUsage: TodayStats = { requests: 0, tokens: 0, cost: 0, actual_cost: 0, user_cost: 0 };
        const now = new Date().toISOString();
        return {
            updated_at: now,
            five_hour: { utilization: 0, resets_at: null, remaining_seconds: 0, window_stats: zeroUsage },
            seven_day: { utilization: 0, resets_at: null, remaining_seconds: 0, window_stats: zeroUsage },
            seven_day_sonnet: { utilization: 0, resets_at: null, remaining_seconds: 0, window_stats: zeroUsage },
            grok_local_usage: zeroUsage,
            grok_local_usage_24h: zeroUsage,
            grok_local_usage_7d: zeroUsage,
            grok_local_usage_monthly: zeroUsage
        };
    }

    async clearRateLimit(accountId: number): Promise<Record<string, unknown>> {
        const updated = await this.repo.clearRateLimit(accountId);
        if (!updated) throw errNotFound();
        return this.toAccountJson(updated);
    }

    async resetQuota(accountId: number): Promise<Record<string, unknown>> {
        const updated = await this.repo.resetQuota(accountId);
        if (!updated) throw errNotFound();
        return this.toAccountJson(updated);
    }

    async setSchedulable(accountId: number, schedulable: boolean): Promise<Record<string, unknown>> {
        const updated = await this.repo.setSchedulable(accountId, schedulable);
        if (!updated) throw errNotFound();
        return this.toAccountJson(updated);
    }

    async setTempUnschedulable(accountId: number, until: string | null, reason: string | null): Promise<Record<string, unknown>> {
        const updated = await this.repo.setTempUnschedulable(accountId, until, reason);
        if (!updated) throw errNotFound();
        return this.toAccountJson(updated);
    }

    async getTempUnschedulableStatus(accountId: number): Promise<{ active: boolean; state?: { until_unix: number; triggered_at_unix: number; status_code: number; matched_keyword: string; rule_index: number; error_message: string } }> {
        const account = await this.repo.getById(accountId);
        if (!account) throw errNotFound();
        if (!account.tempUnschedulableUntil) return { active: false };
        const untilUnix = Math.floor(new Date(account.tempUnschedulableUntil).getTime() / 1000);
        const triggeredAtUnix = account.rateLimitedAt ? Math.floor(new Date(account.rateLimitedAt).getTime() / 1000) : untilUnix;
        return {
            active: true,
            state: {
                until_unix: Number.isFinite(untilUnix) ? untilUnix : 0,
                triggered_at_unix: Number.isFinite(triggeredAtUnix) ? triggeredAtUnix : 0,
                status_code: 0,
                matched_keyword: account.tempUnschedulableReason ?? "",
                rule_index: 0,
                error_message: account.tempUnschedulableReason ?? ""
            }
        };
    }

    async checkMixedChannelRisk(params: { accountId?: number; platform: string; groupIds: number[] }): Promise<MixedChannelRiskResult> {
        const record = await this.repo.checkMixedChannelRisk(params);
        if (!record) {
            return { has_risk: false, message: "No mixed-channel risk detected" };
        }
        return {
            has_risk: true,
            message: `Group ${record.groupName} already contains accounts on a different platform`,
            details: record
        };
    }

    async getTodayStats(accountId: number): Promise<TodayStats> {
        const existing = await this.repo.getById(accountId);
        if (!existing) throw errNotFound();
        const stats = await this.repo.getWindowStats(accountId, new Date().toISOString().slice(0, 10));
        return { requests: stats.requests, tokens: stats.tokens, cost: stats.accountCost, actual_cost: stats.accountCost, user_cost: stats.userCost };
    }

    async clearError(accountId: number): Promise<Record<string, unknown>> {
        const updated = await this.repo.updateStatusFields(accountId, { status: "active", error_message: null });
        if (!updated) throw errNotFound();
        return this.toAccountJson(updated);
    }

    async applyOAuthCredentials(accountId: number, input: { type: string; credentials: Record<string, unknown>; extra?: Record<string, unknown> }): Promise<Record<string, unknown>> {
        if (!input || !["oauth", "setup-token"].includes(input.type) || !input.credentials || typeof input.credentials !== "object" || Array.isArray(input.credentials)) {
            throw errBadRequest("type and credentials are required");
        }
        const existing = await this.repo.getById(accountId);
        if (!existing) throw errNotFound();
        const mergedCredentials = { ...this.parseJsonObject(existing.credentials, "credentials"), ...input.credentials };
        const mergedExtra = { ...this.parseJsonObject(existing.extra, "extra"), ...(input.extra ?? {}) };
        const updated = await this.repo.update(accountId, {
            type: input.type,
            credentials: JSON.stringify(mergedCredentials),
            extra: JSON.stringify(mergedExtra),
            status: "active",
            error_message: null
        });
        if (!updated) throw errNotFound();
        return this.toAccountJson(updated);
    }

    async bulkUpdate(accountIds: number[], updates: Record<string, unknown>): Promise<Record<string, unknown>> {
        const results: Array<{ account_id: number; success: boolean; error?: string }> = [];
        for (const accountId of accountIds) {
            try {
                const existing = await this.repo.getById(accountId);
                if (!existing) throw errNotFound();
                const merged = { ...updates };
                if (updates.credentials && typeof updates.credentials === "object" && !Array.isArray(updates.credentials)) {
                    merged.credentials = { ...this.parseJsonObject(existing.credentials, "credentials"), ...updates.credentials as Record<string, unknown> };
                }
                if (updates.extra && typeof updates.extra === "object" && !Array.isArray(updates.extra)) {
                    merged.extra = { ...this.parseJsonObject(existing.extra, "extra"), ...updates.extra as Record<string, unknown> };
                }
                await this.update(accountId, merged as UpdateAccountInput);
                results.push({ account_id: accountId, success: true });
            } catch (error) {
                results.push({ account_id: accountId, success: false, error: error instanceof Error ? error.message : "update failed" });
            }
        }
        const successIds = results.filter((item) => item.success).map((item) => item.account_id);
        const failedIds = results.filter((item) => !item.success).map((item) => item.account_id);
        return { success: successIds.length, failed: failedIds.length, success_ids: successIds, failed_ids: failedIds, results };
    }

    async batchClearError(accountIds: number[]): Promise<Record<string, unknown>> {
        const results: Array<{ account_id: number; success: boolean; error?: string }> = [];
        for (const accountId of accountIds) {
            try {
                await this.clearError(accountId);
                results.push({ account_id: accountId, success: true });
            } catch (error) {
                results.push({ account_id: accountId, success: false, error: error instanceof Error ? error.message : "clear failed" });
            }
        }
        const successIds = results.filter((item) => item.success).map((item) => item.account_id);
        const failedIds = results.filter((item) => !item.success).map((item) => item.account_id);
        return { total: results.length, success: successIds.length, failed: failedIds.length, success_ids: successIds, failed_ids: failedIds, results };
    }

    async revertProxyFallback(accountId: number): Promise<void> {
        const existing = await this.repo.getById(accountId);
        if (!existing) throw errNotFound();
        await this.repo.update(accountId, { proxy_id: existing.proxyFallbackOriginId, proxy_fallback_origin_id: null });
    }

    async createShadow(parentId: number, input: { name?: string; priority?: number; concurrency?: number; group_ids?: number[] }): Promise<Record<string, unknown>> {
        const parent = await this.repo.getById(parentId);
        if (!parent) throw errNotFound();
        if (parent.quotaDimension !== "global") throw errBadRequest("Only global accounts can create shadow accounts");
        const created = await this.repo.create({
            name: input.name?.trim() || `${parent.name} (Spark)`,
            notes: parent.notes,
            platform: parent.platform,
            type: parent.type,
            credentials: "{}",
            extra: "{}",
            concurrency: input.concurrency ?? parent.concurrency,
            priority: input.priority ?? parent.priority,
            rate_multiplier: parent.rateMultiplier,
            status: parent.status,
            schedulable: parent.schedulable ? 1 : 0,
            quota_dimension: "spark",
            parent_account_id: parent.id
        });
        const groupIds = input.group_ids ?? (await this.repo.getGroups(parentId)).map((group) => group.groupId);
        if (groupIds.length > 0) await this.repo.setGroups(created.id, groupIds);
        return this.toAccountJson(created);
    }

    async exportData(ids: number[] | undefined, includeProxies: boolean): Promise<Record<string, unknown>> {
        const allAccounts = await this.repo.listAll();
        const idSet = ids && ids.length > 0 ? new Set(ids) : null;
        const selected = allAccounts.filter((account) => (!idSet || idSet.has(account.id)) && account.quotaDimension !== "spark");
        const skippedShadows = allAccounts.filter((account) => (!idSet || idSet.has(account.id)) && account.quotaDimension === "spark").length;
        const proxyIds = new Set(selected.map((account) => account.proxyId).filter((id): id is number => id !== null));
        const proxies = includeProxies ? (await new D1ProxyRepository(this.db).listAll()).filter((proxy) => proxyIds.has(proxy.id)).map((proxy) => ({
            proxy_key: `proxy-${proxy.id}`,
            name: proxy.name,
            protocol: proxy.protocol,
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
            status: proxy.status
        })) : [];
        return {
            type: "sub2api-account-export",
            version: 1,
            exported_at: new Date().toISOString(),
            proxies,
            accounts: selected.map((account) => ({
                name: account.name,
                notes: account.notes,
                platform: account.platform,
                type: account.type,
                credentials: this.parseJsonObject(account.credentials, "credentials"),
                extra: this.parseJsonObject(account.extra, "extra"),
                proxy_key: account.proxyId === null ? null : `proxy-${account.proxyId}`,
                concurrency: account.concurrency,
                priority: account.priority,
                rate_multiplier: account.rateMultiplier,
                expires_at: account.expiresAt,
                auto_pause_on_expired: account.autoPauseOnExpired
            })),
            skipped_shadows: skippedShadows
        };
    }

    async getAvailableModels(accountId: number): Promise<Array<{ id: string; type: string; display_name: string; created_at: string }>> {
        const account = await this.repo.getById(accountId);
        if (!account) throw errNotFound();
        const credentials = this.parseJsonObject(account.credentials, "credentials");
        const mapping = credentials.model_mapping;
        const mappedModels = mapping && typeof mapping === "object" && !Array.isArray(mapping) ? Object.keys(mapping as Record<string, unknown>) : [];
        const models = mappedModels.length > 0 ? mappedModels : PLATFORM_MODELS[account.platform] ?? [];
        return [...new Set(models)].sort().map((model) => ({ id: model, type: "model", display_name: model, created_at: account.createdAt }));
    }

    /** Fetch the live model list exposed by an account's configured upstream. */
    async syncUpstreamModels(accountId: number): Promise<{ models: string[] }> {
        const account = await this.repo.getById(accountId);
        if (!account) throw errNotFound();
        return { models: await this.fetchUpstreamModels(account.platform, account.type, account.credentials, account.extra) };
    }

    /** Fetch the live model list during account creation, without persisting credentials. */
    async syncUpstreamModelsPreview(input: {
        platform?: string;
        type?: string;
        base_url?: string;
        api_key?: string;
    }): Promise<{ models: string[] }> {
        const platform = typeof input.platform === "string" ? input.platform.trim().toLowerCase() : "";
        const type = typeof input.type === "string" ? input.type.trim().toLowerCase() : "";
        const apiKey = typeof input.api_key === "string" ? input.api_key.trim() : "";
        if (!platform || !type || !apiKey) throw errBadRequest("platform, type and api_key are required");
        return { models: await this.fetchUpstreamModels(platform, type, JSON.stringify({ api_key: apiKey, base_url: input.base_url ?? "" }), "{}") };
    }

    private async fetchUpstreamModels(platform: string, type: string, credentialsJSON: string, extraJSON: string): Promise<string[]> {
        const credentials = this.parseJsonObject(credentialsJSON, "credentials");
        const extra = this.parseJsonObject(extraJSON, "extra");
        const readString = (...keys: string[]): string => {
            for (const key of keys) {
                const value = credentials[key] ?? extra[key];
                if (typeof value === "string" && value.trim() !== "") return value.trim();
            }
            return "";
        };
        const token = readString("api_key", "apiKey", "access_token", "accessToken", "token");
        if (!token) throw new AccountError(501, "Account has no upstream credential for model sync", "NOT_IMPLEMENTED");

        const rawBase = readString("base_url", "baseUrl") || getDefaultBaseUrl(platform);
        let base: URL;
        try {
            base = new URL(rawBase);
        } catch {
            throw errBadRequest("Invalid upstream base URL");
        }
        if (base.protocol !== "http:" && base.protocol !== "https:") throw errBadRequest("Upstream base URL must use HTTP(S)");

        const lowerPath = base.pathname.replace(/\/+$/u, "").toLowerCase();
        if (platform === "gemini") {
            base.pathname = lowerPath.endsWith("/v1beta/models") ? base.pathname : `${lowerPath.endsWith("/v1beta") ? lowerPath : `${lowerPath}/v1beta`}/models`;
        } else if (platform === "glm") {
            base.pathname = lowerPath.endsWith("/models") ? base.pathname : `${lowerPath}/models`;
        } else {
            base.pathname = lowerPath.endsWith("/v1/models") ? base.pathname : `${lowerPath.endsWith("/v1") ? lowerPath : `${lowerPath}/v1`}/models`;
        }
        base.search = "";

        const headers = new Headers({ accept: "application/json" });
        if (platform === "anthropic") {
            if (type === "apikey" || credentials.api_key || credentials.apiKey) headers.set("x-api-key", token);
            else headers.set("authorization", `Bearer ${token}`);
            headers.set("anthropic-version", "2023-06-01");
        } else if (platform === "gemini") {
            if (type === "apikey" || credentials.api_key || credentials.apiKey) headers.set("x-goog-api-key", token);
            else headers.set("authorization", `Bearer ${token}`);
        } else {
            headers.set("authorization", `Bearer ${token}`);
        }
        let response: Response;
        try {
            response = await fetch(base, { method: "GET", headers, signal: AbortSignal.timeout(30000) });
        } catch (error) {
            throw new AccountError(502, error instanceof Error ? error.message : "Upstream model request failed", "UPSTREAM_ERROR");
        }
        const text = await response.text();
        if (!response.ok) throw new AccountError(502, `Upstream model request failed with HTTP ${response.status}`, "UPSTREAM_ERROR");
        let payload: unknown;
        try {
            payload = JSON.parse(text);
        } catch {
            throw new AccountError(502, "Upstream model response was not valid JSON", "UPSTREAM_ERROR");
        }
        const candidates: unknown[] = Array.isArray(payload) ? payload :
            payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data) ? (payload as Record<string, unknown>).data as unknown[] :
                payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).models) ? (payload as Record<string, unknown>).models as unknown[] : [];
        const models = candidates.map((entry) => {
            if (typeof entry === "string") return entry;
            if (!entry || typeof entry !== "object") return "";
            const item = entry as Record<string, unknown>;
            const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
            return id.replace(/^models\//u, "").trim();
        }).filter((value): value is string => value !== "");
        const unique = [...new Set(models)].sort();
        if (unique.length === 0) throw new AccountError(502, "Upstream returned no supported models", "UPSTREAM_ERROR");
        return unique;
    }

    /** Refresh OAuth credentials using the provider-specific Worker OAuth clients. */
    async refreshAccount(accountId: number): Promise<Record<string, unknown>> {
        const account = await this.repo.getById(accountId);
        if (!account) throw errNotFound();
        if (account.type !== "oauth") throw errBadRequest("Cannot refresh non-OAuth account credentials");
        const credentials = this.parseJsonObject(account.credentials, "credentials");
        const refreshToken = [credentials.refresh_token, credentials.refreshToken].find((value): value is string => typeof value === "string" && value.trim() !== "");
        if (!refreshToken) throw new AccountError(501, "Account has no refresh token", "NOT_IMPLEMENTED");

        let tokenInfo: Record<string, unknown>;
        try {
            const oauth = new D1AdminOAuthService(this.db);
            if (account.platform === "openai") tokenInfo = await oauth.openaiRefreshToken(refreshToken);
            else if (account.platform === "grok") tokenInfo = await oauth.grokRefreshToken(refreshToken);
            else if (account.platform === "antigravity") tokenInfo = await oauth.antigravityRefreshToken(refreshToken);
            else if (account.platform === "gemini") tokenInfo = await this.refreshGoogleToken(credentials, refreshToken);
            else throw new AccountError(501, `OAuth refresh is not supported for platform ${account.platform}`, "NOT_IMPLEMENTED");
        } catch (error) {
            if (error instanceof AccountError) throw error;
            if (error instanceof AdminOAuthError) throw new AccountError(error.status, error.message, error.code);
            throw new AccountError(502, error instanceof Error ? error.message : "OAuth token refresh failed", "TOKEN_REFRESH_FAILED");
        }
        const merged = { ...credentials, ...tokenInfo };
        if (typeof tokenInfo.expires_at === "number") merged.expires_at = new Date(tokenInfo.expires_at * 1000).toISOString();
        const updated = await this.repo.update(accountId, { credentials: JSON.stringify(merged), status: "active", error_message: null });
        if (!updated) throw errNotFound();
        return this.toAccountJson(updated);
    }

    private async refreshGoogleToken(credentials: Record<string, unknown>, refreshToken: string): Promise<Record<string, unknown>> {
        const oauthType = typeof credentials.oauth_type === "string" ? credentials.oauth_type : "code_assist";
        const clientId = typeof credentials.client_id === "string" ? credentials.client_id :
            oauthType === "ai_studio" ? "" : "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
        if (!clientId) throw new AccountError(501, "Gemini OAuth client is not configured", "NOT_IMPLEMENTED");
        const response = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok || typeof payload.access_token !== "string") throw new AccountError(502, "Gemini token refresh failed", "TOKEN_REFRESH_FAILED");
        return { access_token: payload.access_token, ...(typeof payload.refresh_token === "string" ? { refresh_token: payload.refresh_token } : {}), ...(typeof payload.expires_in === "number" ? { expires_in: payload.expires_in, expires_at: Math.floor(Date.now() / 1000) + payload.expires_in } : {}) };
    }

    async batchRefresh(accountIds: number[]): Promise<Record<string, unknown>> {
        if (accountIds.length === 0) throw errBadRequest("account_ids is required");
        const results: Array<Record<string, unknown>> = [];
        for (const accountId of accountIds) {
            try {
                await this.refreshAccount(accountId);
                results.push({ account_id: accountId, success: true });
            } catch (error) {
                results.push({ account_id: accountId, success: false, error: error instanceof Error ? error.message : "refresh failed" });
            }
        }
        const success = results.filter((item) => item.success).length;
        return { total: results.length, success, failed: results.length - success, errors: results.filter((item) => !item.success).map((item) => ({ account_id: item.account_id, error: item.error })) };
    }

    async setPrivacy(accountId: number): Promise<Record<string, unknown>> {
        const account = await this.repo.getById(accountId);
        if (!account) throw errNotFound();
        if (account.type !== "oauth" || !["openai", "antigravity"].includes(account.platform)) throw errBadRequest("Only OpenAI and Antigravity OAuth accounts support privacy setting");
        const credentials = this.parseJsonObject(account.credentials, "credentials");
        const token = [credentials.access_token, credentials.accessToken].find((value): value is string => typeof value === "string" && value.trim() !== "");
        if (!token) throw new AccountError(501, "Cannot set privacy: missing access_token", "NOT_IMPLEMENTED");
        let mode = "";
        if (account.platform === "openai") {
            const url = new URL("https://chatgpt.com/backend-api/settings/account_user_setting");
            url.searchParams.set("feature", "training_allowed");
            url.searchParams.set("value", "false");
            const response = await fetch(url, { method: "PATCH", headers: { authorization: `Bearer ${token}`, origin: "https://chatgpt.com", referer: "https://chatgpt.com/", accept: "application/json" }, signal: AbortSignal.timeout(15000) });
            mode = response.ok ? "training_off" : "training_set_failed";
        } else {
            const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "*/*", "x-goog-api-client": "gl-node/22.21.1" };
            const setResponse = await fetch("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:setUserSettings", { method: "POST", headers, body: JSON.stringify({ user_settings: {} }), signal: AbortSignal.timeout(15000) });
            let setPayload: Record<string, unknown> = {};
            try { setPayload = await setResponse.json() as Record<string, unknown>; } catch { /* ignore malformed upstream body */ }
            const settings = setPayload.userSettings;
            const setSucceeded = setResponse.ok && (!settings || (typeof settings === "object" && Object.keys(settings as object).length === 0));
            const projectId = typeof credentials.project_id === "string" ? credentials.project_id : "";
            let verified = setSucceeded;
            if (verified && projectId) {
                const verifyResponse = await fetch("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchUserInfo", { method: "POST", headers, body: JSON.stringify({ project: projectId }), signal: AbortSignal.timeout(15000) });
                const verifyPayload = await verifyResponse.json().catch(() => ({})) as Record<string, unknown>;
                const verifySettings = verifyPayload.userSettings;
                verified = verifyResponse.ok && (!verifySettings || typeof verifySettings !== "object" || !("telemetryEnabled" in (verifySettings as object)));
            }
            mode = verified ? "privacy_set" : "privacy_set_failed";
        }
        const extra = this.parseJsonObject(account.extra, "extra");
        extra.privacy_mode = mode;
        const updated = await this.repo.update(accountId, { extra: JSON.stringify(extra) });
        if (!updated) throw errNotFound();
        return this.toAccountJson(updated);
    }

    getAntigravityDefaultModelMapping(): Record<string, string> {
        return { ...ANTIGRAVITY_DEFAULT_MODEL_MAPPING };
    }

    private async fetchCrsAccounts(input: { base_url?: string; username?: string; password?: string }): Promise<Array<Record<string, unknown>>> {
        const baseUrl = typeof input.base_url === "string" ? input.base_url.trim().replace(/\/+$/u, "") : "";
        const username = typeof input.username === "string" ? input.username.trim() : "";
        const password = typeof input.password === "string" ? input.password : "";
        if (!baseUrl || !username || !password) throw errBadRequest("base_url, username and password are required");
        let base: URL;
        try { base = new URL(baseUrl); } catch { throw errBadRequest("Invalid CRS base URL"); }
        if (base.protocol !== "http:" && base.protocol !== "https:") throw errBadRequest("CRS base URL must use HTTP(S)");
        const login = await fetch(`${base.toString().replace(/\/+$/u, "")}/web/auth/login`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(30000) });
        const loginPayload = await login.json().catch(() => ({})) as Record<string, unknown>;
        const token = typeof loginPayload.token === "string" ? loginPayload.token : "";
        if (!login.ok || loginPayload.success === false || !token) throw new AccountError(502, "CRS login failed", "CRS_LOGIN_FAILED");
        const exported = await fetch(`${base.toString().replace(/\/+$/u, "")}/admin/sync/export-accounts?include_secrets=true`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(30000) });
        const payload = await exported.json().catch(() => ({})) as Record<string, unknown>;
        if (!exported.ok || payload.success === false) throw new AccountError(502, "CRS account export failed", "CRS_EXPORT_FAILED");
        const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
        const definitions: Array<{ key: string; platform: string; type: string }> = [
            { key: "claudeAccounts", platform: "anthropic", type: "oauth" },
            { key: "claudeConsoleAccounts", platform: "anthropic", type: "apikey" },
            { key: "openaiOAuthAccounts", platform: "openai", type: "oauth" },
            { key: "openaiResponsesAccounts", platform: "openai", type: "apikey" },
            { key: "geminiOAuthAccounts", platform: "gemini", type: "oauth" },
            { key: "geminiAPIKeyAccounts", platform: "gemini", type: "apikey" }
        ];
        const entries: Array<Record<string, unknown>> = [];
        for (const definition of definitions) {
            const values = Array.isArray(data[definition.key]) ? data[definition.key] as unknown[] : [];
            for (const raw of values) {
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
                const source = raw as Record<string, unknown>;
                const id = typeof source.id === "string" ? source.id : "";
                if (!id) continue;
                const sourceType = definition.key === "claudeAccounts" && typeof source.authType === "string" && ["oauth", "setup-token"].includes(source.authType) ? source.authType : definition.type;
                entries.push({
                    crs_account_id: id,
                    kind: typeof source.kind === "string" ? source.kind : definition.key,
                    name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : id,
                    notes: typeof source.description === "string" ? source.description : "",
                    platform: typeof source.platform === "string" && source.platform.trim() ? source.platform : definition.platform,
                    type: sourceType,
                    credentials: source.credentials && typeof source.credentials === "object" ? source.credentials : {},
                    extra: source.extra && typeof source.extra === "object" ? source.extra : {},
                    proxy: source.proxy && typeof source.proxy === "object" ? source.proxy : null,
                    priority: typeof source.priority === "number" ? source.priority : 50,
                    concurrency: typeof source.maxConcurrentTasks === "number" ? source.maxConcurrentTasks : 3,
                    status: typeof source.status === "string" ? source.status : (source.isActive === false ? "disabled" : "active"),
                    schedulable: source.schedulable !== false
                });
            }
        }
        return entries;
    }

    async previewFromCrs(input: { base_url?: string; username?: string; password?: string }): Promise<{ new_accounts: Array<Record<string, unknown>>; existing_accounts: Array<Record<string, unknown>> }> {
        const entries = await this.fetchCrsAccounts(input);
        const existing = new Set<string>();
        for (const account of await this.repo.listAll()) {
            try {
                const extra = this.parseJsonObject(account.extra, "extra");
                if (typeof extra.crs_account_id === "string") existing.add(extra.crs_account_id);
            } catch { /* malformed legacy extras are ignored */ }
        }
        const toPreview = (entry: Record<string, unknown>) => ({ crs_account_id: entry.crs_account_id, kind: entry.kind, name: entry.name, platform: entry.platform, type: entry.type });
        return {
            new_accounts: entries.filter((entry) => !existing.has(String(entry.crs_account_id))).map(toPreview),
            existing_accounts: entries.filter((entry) => existing.has(String(entry.crs_account_id))).map(toPreview)
        };
    }

    async syncFromCrs(input: { base_url?: string; username?: string; password?: string; sync_proxies?: boolean; selected_account_ids?: string[] }): Promise<Record<string, unknown>> {
        const entries = await this.fetchCrsAccounts(input);
        const selected = new Set(Array.isArray(input.selected_account_ids) ? input.selected_account_ids.map(String) : []);
        const syncProxies = input.sync_proxies === true;
        const allAccounts = await this.repo.listAll();
        const existingByCrs = new Map<string, AccountRecord>();
        for (const account of allAccounts) {
            try {
                const extra = this.parseJsonObject(account.extra, "extra");
                if (typeof extra.crs_account_id === "string" && account.quotaDimension !== "spark") existingByCrs.set(extra.crs_account_id, account);
            } catch { /* ignore malformed extras */ }
        }
        const proxyRepo = new D1ProxyRepository(this.db);
        const proxyCache = new Map<string, number>();
        const items: Array<Record<string, unknown>> = [];
        let created = 0; let updated = 0; let skipped = 0; let failed = 0;
        for (const entry of entries) {
            const crsId = String(entry.crs_account_id);
            const item: Record<string, unknown> = { crs_account_id: crsId, kind: entry.kind, name: entry.name, action: "" };
            const existing = existingByCrs.get(crsId);
            if (!existing && selected.size > 0 && !selected.has(crsId)) {
                item.action = "skipped"; item.error = "not selected"; skipped++; items.push(item); continue;
            }
            try {
                const extra = { ...(entry.extra as Record<string, unknown>), crs_account_id: crsId };
                let proxyId: number | null = existing?.proxyId ?? null;
                const proxy = entry.proxy as Record<string, unknown> | null;
                if (syncProxies && proxy) {
                    const host = typeof proxy.host === "string" ? proxy.host : "";
                    const port = Number(proxy.port);
                    const username = typeof proxy.username === "string" ? proxy.username : "";
                    const password = typeof proxy.password === "string" ? proxy.password : "";
                    if (host && Number.isInteger(port)) {
                        const cacheKey = `${host}:${port}:${username}:${password}`;
                        proxyId = proxyCache.get(cacheKey) ?? null;
                        if (!proxyId) {
                            const found = await proxyRepo.findByHostPortAuth(host, port, username, password);
                            const saved = found ?? await proxyRepo.create({ name: `crs-${String(entry.name)}`, protocol: typeof proxy.protocol === "string" ? proxy.protocol : "http", host, port, username, password });
                            proxyId = saved.id; proxyCache.set(cacheKey, proxyId);
                        }
                    }
                }
                const updateInput = {
                    name: String(entry.name), notes: String(entry.notes ?? ""), platform: String(entry.platform), type: String(entry.type),
                    credentials: JSON.stringify(entry.credentials ?? {}), extra: JSON.stringify(extra), proxy_id: proxyId,
                    concurrency: Number(entry.concurrency) || 3, priority: Number(entry.priority) || 50, status: String(entry.status), schedulable: Boolean(entry.schedulable)
                };
                if (existing) { await this.update(existing.id, updateInput); item.action = "updated"; updated++; }
                else { await this.create(updateInput as unknown as CreateAccountInput); item.action = "created"; created++; }
            } catch (error) {
                item.action = "failed"; item.error = error instanceof Error ? error.message : "sync failed"; failed++;
            }
            items.push(item);
        }
        return { created, updated, skipped, failed, items };
    }

    async importData(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const data = payload.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) throw errBadRequest("data is required");
        const input = data as Record<string, unknown>;
        const proxiesInput = Array.isArray(input.proxies) ? input.proxies : [];
        const accountsInput = Array.isArray(input.accounts) ? input.accounts : [];
        const proxyRepo = new D1ProxyRepository(this.db);
        const proxyIds = new Map<string, number>();
        const errors: Array<{ kind: string; name?: string; proxy_key?: string; message: string }> = [];
        let proxyCreated = 0;
        let proxyReused = 0;
        let proxyFailed = 0;
        let accountCreated = 0;
        let accountFailed = 0;

        for (const raw of proxiesInput) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
            const proxy = raw as Record<string, unknown>;
            const proxyKey = typeof proxy.proxy_key === "string" ? proxy.proxy_key : "";
            try {
                const host = typeof proxy.host === "string" ? proxy.host : "";
                const port = Number(proxy.port);
                const username = typeof proxy.username === "string" ? proxy.username : "";
                const password = typeof proxy.password === "string" ? proxy.password : "";
                if (!proxyKey || !host || !Number.isInteger(port)) throw errBadRequest("proxy_key, host and port are required");
                let saved = await proxyRepo.findByHostPortAuth(host, port, username, password);
                if (saved) {
                    proxyReused++;
                } else {
                    saved = await proxyRepo.create({
                        name: typeof proxy.name === "string" && proxy.name.trim() ? proxy.name.trim() : proxyKey,
                        protocol: typeof proxy.protocol === "string" ? proxy.protocol : "http",
                        host,
                        port,
                        username,
                        password
                    });
                    proxyCreated++;
                }
                proxyIds.set(proxyKey, saved.id);
            } catch (error) {
                proxyFailed++;
                errors.push({ kind: "proxy", proxy_key: proxyKey, message: error instanceof Error ? error.message : "proxy import failed" });
            }
        }

        for (const raw of accountsInput) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
            const account = raw as Record<string, unknown>;
            const name = typeof account.name === "string" ? account.name : "";
            try {
                const proxyKey = typeof account.proxy_key === "string" ? account.proxy_key : null;
                await this.create({
                    name,
                    notes: typeof account.notes === "string" ? account.notes : "",
                    platform: typeof account.platform === "string" ? account.platform : "openai",
                    type: typeof account.type === "string" ? account.type : "apikey",
                    credentials: JSON.stringify(account.credentials ?? {}),
                    extra: JSON.stringify(account.extra ?? {}),
                    proxyId: proxyKey ? proxyIds.get(proxyKey) ?? null : null,
                    concurrency: typeof account.concurrency === "number" ? account.concurrency : 3,
                    priority: typeof account.priority === "number" ? account.priority : 50,
                    rateMultiplier: typeof account.rate_multiplier === "number" ? account.rate_multiplier : 1,
                    expiresAt: this.normalizeDate(account.expires_at as string | number | null | undefined),
                    autoPauseOnExpired: typeof account.auto_pause_on_expired === "boolean" ? account.auto_pause_on_expired : true
                });
                accountCreated++;
            } catch (error) {
                accountFailed++;
                errors.push({ kind: "account", name, message: error instanceof Error ? error.message : "account import failed" });
            }
        }

        return { proxy_created: proxyCreated, proxy_reused: proxyReused, proxy_failed: proxyFailed, account_created: accountCreated, account_failed: accountFailed, errors };
    }

    async importCodexSession(input: Record<string, unknown>): Promise<Record<string, unknown>> {
        const rawContents = Array.isArray(input.contents) ? input.contents : [input.content];
        const items: Record<string, unknown>[] = [];
        let created = 0;
        let failed = 0;
        for (let index = 0; index < rawContents.length; index++) {
            const raw = rawContents[index];
            try {
                if (typeof raw !== "string" || raw.trim() === "") throw errBadRequest("Codex session content is empty");
                const parsed = JSON.parse(raw) as Record<string, unknown>;
                const source = parsed.credentials && typeof parsed.credentials === "object" ? parsed.credentials as Record<string, unknown> : parsed;
                const accessToken = [source.access_token, source.accessToken, source.token].find((value): value is string => typeof value === "string" && value.trim() !== "");
                if (!accessToken) throw errBadRequest("Codex session does not contain an access token");
                const refreshToken = [source.refresh_token, source.refreshToken].find((value): value is string => typeof value === "string" && value.trim() !== "");
                const name = typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : `openai-codex-${index + 1}`;
                const extra = { ...(typeof input.extra === "object" && input.extra !== null ? input.extra as Record<string, unknown> : {}), ...(typeof input.credential_extras === "object" && input.credential_extras !== null ? input.credential_extras as Record<string, unknown> : {}) };
                const account = await this.create({
                    name: rawContents.length > 1 ? `${name}-${index + 1}` : name,
                    notes: typeof input.notes === "string" ? input.notes : "",
                    platform: "openai", type: "oauth",
                    credentials: JSON.stringify({ access_token: accessToken, ...(refreshToken ? { refresh_token: refreshToken } : {}), ...(typeof source.email === "string" ? { email: source.email } : {}) }),
                    extra: JSON.stringify(extra),
                    group_ids: Array.isArray(input.group_ids) ? input.group_ids.map(Number).filter(Number.isInteger) : [],
                    proxy_id: typeof input.proxy_id === "number" ? input.proxy_id : null,
                    concurrency: typeof input.concurrency === "number" ? input.concurrency : 3,
                    priority: typeof input.priority === "number" ? input.priority : 50,
                    rate_multiplier: typeof input.rate_multiplier === "number" ? input.rate_multiplier : 1,
                    load_factor: typeof input.load_factor === "number" ? input.load_factor : null,
                    auto_pause_on_expired: input.auto_pause_on_expired !== false,
                });
                created++;
                items.push({ index, action: "created", account_id: account.id });
            } catch (error) {
                failed++;
                items.push({ index, action: "failed", message: error instanceof Error ? error.message : "invalid Codex session" });
            }
        }
        return { total: rawContents.length, created, updated: 0, skipped: 0, failed, items, warnings: [], errors: items.filter((item) => item.action === "failed") };
    }
}
