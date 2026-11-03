import type { GroupRecord, RateEntryRecord, GroupApiKeyBrief, GroupAccountCounts } from "../repositories/groups.ts";
import { D1GroupRepository, buildGroupInsertValues } from "../repositories/groups.ts";
import type { D1Database, D1Value } from "../types/d1.ts";

export class GroupError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code: string) {
        super(message);
        this.name = "GroupError";
        this.status = status;
        this.code = code;
    }
}

export function errNotFound(): GroupError {
    return new GroupError(404, "Group not found", "GROUP_NOT_FOUND");
}

export function errConflict(msg: string): GroupError {
    return new GroupError(409, msg, "GROUP_CONFLICT");
}

export function errBadRequest(msg: string): GroupError {
    return new GroupError(400, msg, "BAD_REQUEST");
}

function safeJsonParse<T>(val: string | null | undefined, fallback: T): T {
    if (!val || typeof val !== "string") return fallback;
    try {
        return JSON.parse(val) as T;
    } catch {
        return fallback;
    }
}

export interface CreateGroupInput {
    name: string;
    description?: string | null;
    platform?: string;
    rate_multiplier?: number;
    is_exclusive?: boolean;
    status?: string;
    subscription_type?: string;
    daily_limit_usd?: number | null;
    weekly_limit_usd?: number | null;
    monthly_limit_usd?: number | null;
    allow_image_generation?: boolean;
    allow_batch_image_generation?: boolean;
    image_rate_independent?: boolean;
    image_rate_multiplier?: number;
    image_price_1k?: number | null;
    image_price_2k?: number | null;
    image_price_4k?: number | null;
    batch_image_discount_multiplier?: number;
    batch_image_hold_multiplier?: number;
    video_rate_independent?: boolean;
    video_rate_multiplier?: number;
    video_price_480p?: number | null;
    video_price_720p?: number | null;
    video_price_1080p?: number | null;
    web_search_price_per_call?: number | null;
    peak_rate_enabled?: boolean;
    peak_start?: string;
    peak_end?: string;
    peak_rate_multiplier?: number;
    claude_code_only?: boolean;
    fallback_group_id?: number | null;
    fallback_group_id_on_invalid_request?: number | null;
    model_routing?: string | Record<string, number[]> | null;
    model_routing_enabled?: boolean;
    mcp_xml_inject?: boolean;
    supported_model_scopes?: string | string[];
    sort_order?: number;
    allow_messages_dispatch?: boolean;
    require_oauth_only?: boolean;
    require_privacy_set?: boolean;
    default_mapped_model?: string;
    messages_dispatch_model_config?: string | Record<string, unknown>;
    models_list_config?: string | Record<string, unknown>;
    rpm_limit?: number;
    copy_accounts_from_group_ids?: number[];
}

export type UpdateGroupInput = Partial<{
    name: string;
    description: string | null;
    platform: string;
    rate_multiplier: number;
    is_exclusive: boolean;
    status: string;
    subscription_type: string;
    daily_limit_usd: number | null;
    weekly_limit_usd: number | null;
    monthly_limit_usd: number | null;
    allow_image_generation: boolean;
    allow_batch_image_generation: boolean;
    image_rate_independent: boolean;
    image_rate_multiplier: number;
    image_price_1k: number | null;
    image_price_2k: number | null;
    image_price_4k: number | null;
    batch_image_discount_multiplier: number;
    batch_image_hold_multiplier: number;
    video_rate_independent: boolean;
    video_rate_multiplier: number;
    video_price_480p: number | null;
    video_price_720p: number | null;
    video_price_1080p: number | null;
    web_search_price_per_call: number | null;
    peak_rate_enabled: boolean;
    peak_start: string;
    peak_end: string;
    peak_rate_multiplier: number;
    claude_code_only: boolean;
    fallback_group_id: number | null;
    fallback_group_id_on_invalid_request: number | null;
    model_routing: string | Record<string, number[]> | null;
    model_routing_enabled: boolean;
    mcp_xml_inject: boolean;
    supported_model_scopes: string | string[];
    sort_order: number;
    allow_messages_dispatch: boolean;
    require_oauth_only: boolean;
    require_privacy_set: boolean;
    default_mapped_model: string;
    messages_dispatch_model_config: string | Record<string, unknown>;
    models_list_config: string | Record<string, unknown>;
    rpm_limit: number;
    copy_accounts_from_group_ids: number[];
}>;

export interface GroupStats {
    totalAccounts: number;
    activeAccounts: number;
    rateLimitedAccounts: number;
    todayUsageTokens: number;
    todayCostUsd: number;
    activeUsersCount: number;
    total_api_keys: number;
    active_api_keys: number;
    total_requests: number;
    total_cost: number;
}

export class D1GroupService {
    private repo: D1GroupRepository;

    constructor(dbOrRepo: D1Database | D1GroupRepository) {
        this.repo = dbOrRepo instanceof D1GroupRepository ? dbOrRepo : new D1GroupRepository(dbOrRepo);
    }

    private toGroupJson(g: GroupRecord, counts?: GroupAccountCounts): Record<string, unknown> {
        return {
            id: g.id,
            name: g.name,
            description: g.description,
            platform: g.platform,
            rate_multiplier: g.rateMultiplier,
            peak_rate_enabled: g.peakRateEnabled,
            peak_start: g.peakStart,
            peak_end: g.peakEnd,
            peak_rate_multiplier: g.peakRateMultiplier,
            is_exclusive: g.isExclusive,
            status: g.status,
            subscription_type: g.subscriptionType,
            daily_limit_usd: g.dailyLimitUsd,
            weekly_limit_usd: g.weeklyLimitUsd,
            monthly_limit_usd: g.monthlyLimitUsd,
            default_validity_days: g.defaultValidityDays,
            allow_image_generation: g.allowImageGeneration,
            allow_batch_image_generation: g.allowBatchImageGeneration,
            image_rate_independent: g.imageRateIndependent,
            image_rate_multiplier: g.imageRateMultiplier,
            image_price_1k: g.imagePrice1k,
            image_price_2k: g.imagePrice2k,
            image_price_4k: g.imagePrice4k,
            batch_image_discount_multiplier: g.batchImageDiscountMultiplier,
            batch_image_hold_multiplier: g.batchImageHoldMultiplier,
            video_rate_independent: g.videoRateIndependent,
            video_rate_multiplier: g.videoRateMultiplier,
            video_price_480p: g.videoPrice480p,
            video_price_720p: g.videoPrice720p,
            video_price_1080p: g.videoPrice1080p,
            web_search_price_per_call: g.webSearchPricePerCall,
            claude_code_only: g.claudeCodeOnly,
            fallback_group_id: g.fallbackGroupId,
            fallback_group_id_on_invalid_request: g.fallbackGroupIdOnInvalidRequest,
            model_routing: g.modelRouting ? safeJsonParse(g.modelRouting, null) : null,
            model_routing_enabled: g.modelRoutingEnabled,
            mcp_xml_inject: g.mcpXmlInject,
            supported_model_scopes: safeJsonParse(g.supportedModelScopes, []),
            sort_order: g.sortOrder,
            allow_messages_dispatch: g.allowMessagesDispatch,
            require_oauth_only: g.requireOAuthOnly,
            require_privacy_set: g.requirePrivacySet,
            default_mapped_model: g.defaultMappedModel,
            messages_dispatch_model_config: safeJsonParse(g.messagesDispatchModelConfig, {}),
            models_list_config: safeJsonParse(g.modelsListConfig, {}),
            rpm_limit: g.rpmLimit,
            account_count: counts?.total ?? 0,
            active_account_count: counts?.active ?? 0,
            rate_limited_account_count: counts?.rateLimited ?? 0,
            account_groups: [],
            created_at: g.createdAt,
            updated_at: g.updatedAt
        };
    }

    private async toGroupsJson(groups: GroupRecord[]): Promise<Record<string, unknown>[]> {
        const counts = await this.repo.getAccountCounts(groups.map(group => group.id));
        const byId = new Map(counts.map(count => [count.groupId, count]));
        return groups.map(group => this.toGroupJson(group, byId.get(group.id)));
    }

    async list(params: {
        page: number; pageSize: number; platform?: string; status?: string;
        search?: string; isExclusive?: boolean; sortBy?: string; sortOrder?: string
    }): Promise<{ items: Record<string, unknown>[]; total: number }> {
        const result = await this.repo.list(params);
        return { items: await this.toGroupsJson(result.items), total: result.total };
    }

    async listAll(): Promise<Record<string, unknown>[]> {
        const groups = await this.repo.listAll();
        return this.toGroupsJson(groups);
    }

    async listActive(): Promise<Record<string, unknown>[]> {
        const groups = await this.repo.listActive();
        return this.toGroupsJson(groups);
    }

    async listActiveByPlatform(platform: string): Promise<Record<string, unknown>[]> {
        const groups = await this.repo.listActiveByPlatform(platform);
        return this.toGroupsJson(groups);
    }

    async listAllIncludingInactive(): Promise<Record<string, unknown>[]> {
        const groups = await this.repo.listAll();
        return this.toGroupsJson(groups);
    }

    async getById(id: number): Promise<Record<string, unknown>> {
        const g = await this.repo.getById(id);
        if (!g) throw errNotFound();
        return (await this.toGroupsJson([g]))[0]!;
    }

    async create(input: CreateGroupInput): Promise<Record<string, unknown>> {
        const name = input.name?.trim();
        if (!name) throw errBadRequest("name is required");
        if (name.length > 100) throw errBadRequest("name must be at most 100 characters");

        const exists = await this.repo.existsByName(name);
        if (exists) throw errConflict(`Group "${name}" already exists`);

        const platform = input.platform ?? "anthropic";
        const validPlatforms = ["anthropic", "openai", "gemini", "antigravity", "grok", "deepseek", "glm", "minimax", "qwen", "kimi", "moonshot"];
        if (!validPlatforms.includes(platform)) throw errBadRequest(`Invalid platform: ${platform}`);

        const subType = input.subscription_type ?? "standard";
        if (!["standard", "subscription"].includes(subType)) throw errBadRequest(`Invalid subscription_type: ${subType}`);

        const vals: Record<string, D1Value> = {
            name,
            description: input.description ?? "",
            platform,
            rate_multiplier: input.rate_multiplier ?? 1.0,
            peak_rate_enabled: input.peak_rate_enabled ? 1 : 0,
            peak_start: input.peak_start ?? "",
            peak_end: input.peak_end ?? "",
            peak_rate_multiplier: input.peak_rate_multiplier ?? 1.0,
            is_exclusive: input.is_exclusive ? 1 : 0,
            status: input.status ?? "active",
            subscription_type: subType,
            daily_limit_usd: input.daily_limit_usd ?? null,
            weekly_limit_usd: input.weekly_limit_usd ?? null,
            monthly_limit_usd: input.monthly_limit_usd ?? null,
            default_validity_days: 30,
            allow_image_generation: input.allow_image_generation ? 1 : 0,
            allow_batch_image_generation: input.allow_batch_image_generation ? 1 : 0,
            image_rate_independent: input.image_rate_independent ? 1 : 0,
            image_rate_multiplier: input.image_rate_multiplier ?? 1.0,
            image_price_1k: input.image_price_1k ?? null,
            image_price_2k: input.image_price_2k ?? null,
            image_price_4k: input.image_price_4k ?? null,
            batch_image_discount_multiplier: input.batch_image_discount_multiplier ?? 0.5,
            batch_image_hold_multiplier: input.batch_image_hold_multiplier ?? 0.6,
            video_rate_independent: input.video_rate_independent ? 1 : 0,
            video_rate_multiplier: input.video_rate_multiplier ?? 1.0,
            video_price_480p: input.video_price_480p ?? null,
            video_price_720p: input.video_price_720p ?? null,
            video_price_1080p: input.video_price_1080p ?? null,
            web_search_price_per_call: input.web_search_price_per_call ?? null,
            claude_code_only: input.claude_code_only ? 1 : 0,
            fallback_group_id: input.fallback_group_id ?? null,
            fallback_group_id_on_invalid_request: input.fallback_group_id_on_invalid_request ?? null,
            model_routing: input.model_routing ? (typeof input.model_routing === "string" ? input.model_routing : JSON.stringify(input.model_routing)) : null,
            model_routing_enabled: input.model_routing_enabled ? 1 : 0,
            mcp_xml_inject: input.mcp_xml_inject !== undefined ? (input.mcp_xml_inject ? 1 : 0) : 1,
            supported_model_scopes: typeof input.supported_model_scopes === "string" ? input.supported_model_scopes : JSON.stringify(input.supported_model_scopes ?? []),
            sort_order: input.sort_order ?? 0,
            allow_messages_dispatch: input.allow_messages_dispatch ? 1 : 0,
            require_oauth_only: input.require_oauth_only ? 1 : 0,
            require_privacy_set: input.require_privacy_set ? 1 : 0,
            default_mapped_model: input.default_mapped_model ?? "",
            messages_dispatch_model_config: typeof input.messages_dispatch_model_config === "string" ? input.messages_dispatch_model_config : JSON.stringify(input.messages_dispatch_model_config ?? {}),
            models_list_config: typeof input.models_list_config === "string" ? input.models_list_config : JSON.stringify(input.models_list_config ?? {}),
            rpm_limit: input.rpm_limit ?? 0
        };
        const g = await this.repo.create(vals);
        if (Array.isArray(input.copy_accounts_from_group_ids) && input.copy_accounts_from_group_ids.length > 0) {
            await this.repo.copyAccountsFromGroups(g.id, input.copy_accounts_from_group_ids);
        }
        return (await this.toGroupsJson([g]))[0]!;
    }

    async update(id: number, input: UpdateGroupInput): Promise<Record<string, unknown>> {
        const existing = await this.repo.getById(id);
        if (!existing) throw errNotFound();

        const updates: Record<string, D1Value> = {};
        const fields: Array<[string, keyof UpdateGroupInput]> = [
            ["name", "name"], ["description", "description"], ["platform", "platform"],
            ["rate_multiplier", "rate_multiplier"], ["is_exclusive", "is_exclusive"],
            ["status", "status"], ["subscription_type", "subscription_type"],
            ["daily_limit_usd", "daily_limit_usd"], ["weekly_limit_usd", "weekly_limit_usd"],
            ["monthly_limit_usd", "monthly_limit_usd"],
            ["allow_image_generation", "allow_image_generation"],
            ["allow_batch_image_generation", "allow_batch_image_generation"],
            ["image_rate_independent", "image_rate_independent"],
            ["image_rate_multiplier", "image_rate_multiplier"],
            ["image_price_1k", "image_price_1k"], ["image_price_2k", "image_price_2k"],
            ["image_price_4k", "image_price_4k"],
            ["batch_image_discount_multiplier", "batch_image_discount_multiplier"],
            ["batch_image_hold_multiplier", "batch_image_hold_multiplier"],
            ["video_rate_independent", "video_rate_independent"],
            ["video_rate_multiplier", "video_rate_multiplier"],
            ["video_price_480p", "video_price_480p"], ["video_price_720p", "video_price_720p"],
            ["video_price_1080p", "video_price_1080p"],
            ["web_search_price_per_call", "web_search_price_per_call"],
            ["claude_code_only", "claude_code_only"],
            ["fallback_group_id", "fallback_group_id"],
            ["fallback_group_id_on_invalid_request", "fallback_group_id_on_invalid_request"],
            ["model_routing", "model_routing"],
            ["model_routing_enabled", "model_routing_enabled"],
            ["mcp_xml_inject", "mcp_xml_inject"],
            ["supported_model_scopes", "supported_model_scopes"],
            ["allow_messages_dispatch", "allow_messages_dispatch"],
            ["require_oauth_only", "require_oauth_only"],
            ["require_privacy_set", "require_privacy_set"],
            ["default_mapped_model", "default_mapped_model"],
            ["messages_dispatch_model_config", "messages_dispatch_model_config"],
            ["models_list_config", "models_list_config"],
            ["rpm_limit", "rpm_limit"],
            ["peak_rate_enabled", "peak_rate_enabled"],
            ["peak_start", "peak_start"], ["peak_end", "peak_end"],
            ["peak_rate_multiplier", "peak_rate_multiplier"]
        ];

        for (const [col, key] of fields) {
            if (key in input) {
                const val = (input as Record<string, unknown>)[key];
                if (val === undefined || val === null) {
                    updates[col] = null;
                } else if (typeof val === "boolean") {
                    updates[col] = val ? 1 : 0;
                } else if (typeof val === "string" || typeof val === "number") {
                    updates[col] = val;
                } else {
                    updates[col] = JSON.stringify(val);
                }
            }
        }

        if (Array.isArray(input.copy_accounts_from_group_ids) && input.copy_accounts_from_group_ids.length > 0) {
            await this.repo.copyAccountsFromGroups(id, input.copy_accounts_from_group_ids);
        }

        if (Object.keys(updates).length === 0) return (await this.toGroupsJson([existing]))[0]!;

        if (updates["name"] !== undefined && typeof updates["name"] === "string") {
            const newName = (updates["name"] as string).trim();
            if (newName !== existing.name) {
                const exists = await this.repo.existsByName(newName);
                if (exists) throw errConflict(`Group "${newName}" already exists`);
            }
            updates["name"] = newName;
        }

        const updated = await this.repo.update(id, updates);
        if (!updated) throw errNotFound();
        return (await this.toGroupsJson([updated]))[0]!;
    }

    async delete(id: number): Promise<void> {
        const ok = await this.repo.delete(id);
        if (!ok) throw errNotFound();
    }

    async updateSortOrders(updates: Array<{ id: number; sortOrder: number }>): Promise<void> {
        await this.repo.updateSortOrders(updates);
    }

    async getGroupApiKeys(groupId: number, page: number, pageSize: number): Promise<{ items: GroupApiKeyBrief[]; total: number }> {
        return this.repo.getGroupApiKeys(groupId, page, pageSize);
    }

    async getGroupStats(groupId: number): Promise<GroupStats> {
        const existing = await this.repo.getById(groupId);
        if (!existing) throw errNotFound();
        const [counts] = await this.repo.getAccountCounts([groupId]);
        return {
            totalAccounts: counts?.total ?? 0,
            activeAccounts: counts?.active ?? 0,
            rateLimitedAccounts: counts?.rateLimited ?? 0,
            todayUsageTokens: 0,
            todayCostUsd: 0,
            activeUsersCount: 0,
            total_api_keys: 0,
            active_api_keys: 0,
            total_requests: 0,
            total_cost: 0
        };
    }

    async getRateMultipliers(groupId: number): Promise<RateEntryRecord[]> {
        const existing = await this.repo.getById(groupId);
        if (!existing) throw errNotFound();
        return this.repo.getRateMultiplierEntries(groupId);
    }

    async batchSetRateMultipliers(groupId: number, entries: Array<{ userId: number; rateMultiplier: number }>): Promise<void> {
        const existing = await this.repo.getById(groupId);
        if (!existing) throw errNotFound();
        await this.repo.syncRateMultipliers(groupId, entries);
    }

    async clearRateMultipliers(groupId: number): Promise<void> {
        const existing = await this.repo.getById(groupId);
        if (!existing) throw errNotFound();
        await this.repo.clearRateMultipliers(groupId);
    }

    async batchSetRPMOverrides(groupId: number, entries: Array<{ userId: number; rpmOverride: number | null }>): Promise<void> {
        const existing = await this.repo.getById(groupId);
        if (!existing) throw errNotFound();
        await this.repo.syncRPMOverrides(groupId, entries);
    }

    async clearRPMOverrides(groupId: number): Promise<void> {
        const existing = await this.repo.getById(groupId);
        if (!existing) throw errNotFound();
        await this.repo.clearRPMOverrides(groupId);
    }
}
