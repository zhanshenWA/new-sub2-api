import type { D1Database, D1Value } from "../types/d1.ts";
import { allRows, firstRow, runStatement } from "./d1.ts";

export interface GroupRecord {
    id: number;
    name: string;
    description: string;
    platform: string;
    rateMultiplier: number;
    peakRateEnabled: boolean;
    peakStart: string;
    peakEnd: string;
    peakRateMultiplier: number;
    isExclusive: boolean;
    status: string;
    subscriptionType: string;
    dailyLimitUsd: number | null;
    weeklyLimitUsd: number | null;
    monthlyLimitUsd: number | null;
    defaultValidityDays: number;
    allowImageGeneration: boolean;
    allowBatchImageGeneration: boolean;
    imageRateIndependent: boolean;
    imageRateMultiplier: number;
    imagePrice1k: number | null;
    imagePrice2k: number | null;
    imagePrice4k: number | null;
    batchImageDiscountMultiplier: number;
    batchImageHoldMultiplier: number;
    videoRateIndependent: boolean;
    videoRateMultiplier: number;
    videoPrice480p: number | null;
    videoPrice720p: number | null;
    videoPrice1080p: number | null;
    webSearchPricePerCall: number | null;
    claudeCodeOnly: boolean;
    fallbackGroupId: number | null;
    fallbackGroupIdOnInvalidRequest: number | null;
    modelRouting: string | null;
    modelRoutingEnabled: boolean;
    mcpXmlInject: boolean;
    supportedModelScopes: string;
    sortOrder: number;
    allowMessagesDispatch: boolean;
    requireOAuthOnly: boolean;
    requirePrivacySet: boolean;
    defaultMappedModel: string;
    messagesDispatchModelConfig: string;
    modelsListConfig: string;
    rpmLimit: number;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
}

export interface GroupAccountCounts {
    groupId: number;
    total: number;
    active: number;
    rateLimited: number;
}

export interface GroupApiKeyBrief {
    id: number;
    key: string;
    name: string;
    status: string;
    createdAt: string;
}

export interface RateEntryRecord {
    userId: number;
    userName: string;
    userEmail: string;
    userStatus: string;
    rateMultiplier: number | null;
    rpmOverride: number | null;
}

interface GroupRow {
    id: number;
    name: string;
    description: string;
    platform: string;
    rate_multiplier: number;
    peak_rate_enabled: number;
    peak_start: string;
    peak_end: string;
    peak_rate_multiplier: number;
    is_exclusive: number;
    status: string;
    subscription_type: string;
    daily_limit_usd: number | null;
    weekly_limit_usd: number | null;
    monthly_limit_usd: number | null;
    default_validity_days: number;
    allow_image_generation: number;
    allow_batch_image_generation: number;
    image_rate_independent: number;
    image_rate_multiplier: number;
    image_price_1k: number | null;
    image_price_2k: number | null;
    image_price_4k: number | null;
    batch_image_discount_multiplier: number;
    batch_image_hold_multiplier: number;
    video_rate_independent: number;
    video_rate_multiplier: number;
    video_price_480p: number | null;
    video_price_720p: number | null;
    video_price_1080p: number | null;
    web_search_price_per_call: number | null;
    claude_code_only: number;
    fallback_group_id: number | null;
    fallback_group_id_on_invalid_request: number | null;
    model_routing: string | null;
    model_routing_enabled: number;
    mcp_xml_inject: number;
    supported_model_scopes: string;
    sort_order: number;
    allow_messages_dispatch: number;
    require_oauth_only: number;
    require_privacy_set: number;
    default_mapped_model: string;
    messages_dispatch_model_config: string;
    models_list_config: string;
    rpm_limit: number;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
}

interface ApiKeyBriefRow {
    id: number;
    key: string;
    name: string;
    status: string;
    created_at: string;
}

interface RateEntryRow {
    user_id: number;
    user_name: string | null;
    user_email: string;
    user_status: string;
    rate_multiplier: number | null;
    rpm_override: number | null;
}

function rowToRecord(row: GroupRow): GroupRecord {
    return {
        id: row.id, name: row.name, description: row.description, platform: row.platform,
        rateMultiplier: row.rate_multiplier,
        peakRateEnabled: row.peak_rate_enabled !== 0, peakStart: row.peak_start, peakEnd: row.peak_end,
        peakRateMultiplier: row.peak_rate_multiplier, isExclusive: row.is_exclusive !== 0,
        status: row.status, subscriptionType: row.subscription_type,
        dailyLimitUsd: row.daily_limit_usd, weeklyLimitUsd: row.weekly_limit_usd,
        monthlyLimitUsd: row.monthly_limit_usd, defaultValidityDays: row.default_validity_days,
        allowImageGeneration: row.allow_image_generation !== 0,
        allowBatchImageGeneration: row.allow_batch_image_generation !== 0,
        imageRateIndependent: row.image_rate_independent !== 0,
        imageRateMultiplier: row.image_rate_multiplier,
        imagePrice1k: row.image_price_1k, imagePrice2k: row.image_price_2k, imagePrice4k: row.image_price_4k,
        batchImageDiscountMultiplier: row.batch_image_discount_multiplier,
        batchImageHoldMultiplier: row.batch_image_hold_multiplier,
        videoRateIndependent: row.video_rate_independent !== 0,
        videoRateMultiplier: row.video_rate_multiplier,
        videoPrice480p: row.video_price_480p, videoPrice720p: row.video_price_720p,
        videoPrice1080p: row.video_price_1080p,
        webSearchPricePerCall: row.web_search_price_per_call,
        claudeCodeOnly: row.claude_code_only !== 0,
        fallbackGroupId: row.fallback_group_id,
        fallbackGroupIdOnInvalidRequest: row.fallback_group_id_on_invalid_request,
        modelRouting: row.model_routing, modelRoutingEnabled: row.model_routing_enabled !== 0,
        mcpXmlInject: row.mcp_xml_inject !== 0, supportedModelScopes: row.supported_model_scopes,
        sortOrder: row.sort_order,
        allowMessagesDispatch: row.allow_messages_dispatch !== 0,
        requireOAuthOnly: row.require_oauth_only !== 0,
        requirePrivacySet: row.require_privacy_set !== 0,
        defaultMappedModel: row.default_mapped_model,
        messagesDispatchModelConfig: row.messages_dispatch_model_config,
        modelsListConfig: row.models_list_config,
        rpmLimit: row.rpm_limit,
        createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at
    };
}

function nowISO(): string {
    return new Date().toISOString();
}

function toStringValue(val: unknown, fallback: string): string {
    if (val === undefined || val === null) return fallback;
    if (typeof val === "string") return val;
    try {
        return JSON.stringify(val);
    } catch {
        return fallback;
    }
}

export function buildGroupInsertValues(input: Record<string, D1Value>, ts: string): D1Value[] {
    return [
        input.name ?? "", input.description ?? "", input.platform ?? "anthropic",
        input.rate_multiplier ?? 1.0,
        input.peak_rate_enabled ?? 0, input.peak_start ?? "", input.peak_end ?? "",
        input.peak_rate_multiplier ?? 1.0,
        input.is_exclusive ?? 0, input.status ?? "active", input.subscription_type ?? "standard",
        input.daily_limit_usd ?? null, input.weekly_limit_usd ?? null, input.monthly_limit_usd ?? null,
        input.default_validity_days ?? 30,
        input.allow_image_generation ?? 0, input.allow_batch_image_generation ?? 0,
        input.image_rate_independent ?? 0, input.image_rate_multiplier ?? 1.0,
        input.image_price_1k ?? null, input.image_price_2k ?? null, input.image_price_4k ?? null,
        input.batch_image_discount_multiplier ?? 0.5, input.batch_image_hold_multiplier ?? 0.6,
        input.video_rate_independent ?? 0, input.video_rate_multiplier ?? 1.0,
        input.video_price_480p ?? null, input.video_price_720p ?? null, input.video_price_1080p ?? null,
        input.web_search_price_per_call ?? null,
        input.claude_code_only ?? 0, input.fallback_group_id ?? null,
        input.fallback_group_id_on_invalid_request ?? null,
        input.model_routing ? (typeof input.model_routing === "string" ? input.model_routing : JSON.stringify(input.model_routing)) : null,
        input.model_routing_enabled ?? 0, input.mcp_xml_inject ?? 1,
        toStringValue(input.supported_model_scopes, "[]"),
        input.sort_order ?? 0,
        input.allow_messages_dispatch ?? 0, input.require_oauth_only ?? 0,
        input.require_privacy_set ?? 0,
        input.default_mapped_model ?? "",
        toStringValue(input.messages_dispatch_model_config, "{}"),
        toStringValue(input.models_list_config, "{}"),
        input.rpm_limit ?? 0,
        ts, ts
    ];
}

const GROUP_INSERT_COLS = `(
    name, description, platform, rate_multiplier,
    peak_rate_enabled, peak_start, peak_end, peak_rate_multiplier,
    is_exclusive, status, subscription_type,
    daily_limit_usd, weekly_limit_usd, monthly_limit_usd, default_validity_days,
    allow_image_generation, allow_batch_image_generation,
    image_rate_independent, image_rate_multiplier,
    image_price_1k, image_price_2k, image_price_4k,
    batch_image_discount_multiplier, batch_image_hold_multiplier,
    video_rate_independent, video_rate_multiplier,
    video_price_480p, video_price_720p, video_price_1080p,
    web_search_price_per_call,
    claude_code_only, fallback_group_id, fallback_group_id_on_invalid_request,
    model_routing, model_routing_enabled, mcp_xml_inject, supported_model_scopes,
    sort_order,
    allow_messages_dispatch, require_oauth_only, require_privacy_set,
    default_mapped_model, messages_dispatch_model_config, models_list_config,
    rpm_limit,
    created_at, updated_at
)`;

const GROUP_INSERT_VALS = `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export class D1GroupRepository {
    private db: D1Database;
    constructor(db: D1Database) {
        this.db = db;
    }

    async create(input: Record<string, D1Value>): Promise<GroupRecord> {
        const ts = nowISO();
        const sql = `INSERT INTO groups ${GROUP_INSERT_COLS} ${GROUP_INSERT_VALS} RETURNING *`;
        const vals = buildGroupInsertValues(input, ts);
        const row = await firstRow<GroupRow>(this.db, sql, vals);
        return rowToRecord(row!);
    }

    async copyAccountsFromGroups(targetGroupId: number, sourceGroupIds: number[]): Promise<void> {
        const validIds = sourceGroupIds.filter((id) => typeof id === "number" && id > 0);
        if (validIds.length === 0) return;
        const ts = nowISO();
        const placeholders = validIds.map(() => "?").join(", ");
        await runStatement(
            this.db,
            `INSERT OR IGNORE INTO account_groups (account_id, group_id, priority, created_at)
             SELECT DISTINCT account_id, ?, priority, ?
             FROM account_groups
             WHERE group_id IN (${placeholders})`,
            [targetGroupId, ts, ...validIds]
        );
    }

    async getById(id: number): Promise<GroupRecord | null> {
        const row = await firstRow<GroupRow>(this.db, `SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL`, [id]);
        return row ? rowToRecord(row) : null;
    }

    async update(id: number, input: Record<string, D1Value>): Promise<GroupRecord | null> {
        const ts = nowISO();
        const setClauses: string[] = [];
        const values: D1Value[] = [];
        for (const [key, value] of Object.entries(input)) {
            setClauses.push(`${key} = ?`);
            values.push(value ?? null);
        }
        setClauses.push("updated_at = ?");
        values.push(ts);
        values.push(id);
        const sql = `UPDATE groups SET ${setClauses.join(", ")} WHERE id = ? AND deleted_at IS NULL RETURNING *`;
        const row = await firstRow<GroupRow>(this.db, sql, values);
        return row ? rowToRecord(row) : null;
    }

    async delete(id: number): Promise<boolean> {
        const ts = nowISO();
        const result = await runStatement(this.db, `UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [ts, ts, id]);
        return result.success && (result.meta?.changes ?? 0) > 0;
    }

    async existsByName(name: string): Promise<boolean> {
        const row = await firstRow<{ c: number }>(this.db, `SELECT COUNT(*) as c FROM groups WHERE name = ? AND deleted_at IS NULL`, [name]);
        return row !== null && row.c > 0;
    }

    async list(params: {
        page: number; pageSize: number; platform?: string; status?: string;
        search?: string; isExclusive?: boolean; sortBy?: string; sortOrder?: string
    }): Promise<{ items: GroupRecord[]; total: number }> {
        const where: string[] = ["deleted_at IS NULL"];
        const values: D1Value[] = [];

        if (params.platform) { where.push("platform = ?"); values.push(params.platform); }
        if (params.status) { where.push("status = ?"); values.push(params.status); }
        if (params.isExclusive !== undefined) { where.push("is_exclusive = ?"); values.push(params.isExclusive ? 1 : 0); }
        if (params.search) { where.push("name LIKE ?"); values.push(`%${params.search}%`); }

        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const sortBy = params.sortBy ?? "sort_order";
        const sortOrder = params.sortOrder ?? "asc";
        const safeSortBy = ["sort_order", "name", "created_at", "updated_at", "status", "platform", "rate_multiplier"].includes(sortBy) ? sortBy : "sort_order";
        const safeSortOrder = sortOrder === "desc" ? "DESC" : "ASC";

        const countRow = await firstRow<{ c: number }>(this.db, `SELECT COUNT(*) as c FROM groups ${whereClause}`, values);
        const total = countRow?.c ?? 0;

        const offset = (params.page - 1) * params.pageSize;
        const rows = await allRows<GroupRow>(this.db, `SELECT * FROM groups ${whereClause} ORDER BY ${safeSortBy} ${safeSortOrder} LIMIT ? OFFSET ?`, [...values, params.pageSize, offset]);

        return { items: rows.map(rowToRecord), total };
    }

    async listActive(): Promise<GroupRecord[]> {
        const rows = await allRows<GroupRow>(this.db, `SELECT * FROM groups WHERE deleted_at IS NULL AND status = 'active' ORDER BY sort_order ASC`);
        return rows.map(rowToRecord);
    }

    async listActiveByPlatform(platform: string): Promise<GroupRecord[]> {
        const rows = await allRows<GroupRow>(this.db, `SELECT * FROM groups WHERE deleted_at IS NULL AND status = 'active' AND platform = ? ORDER BY sort_order ASC`, [platform]);
        return rows.map(rowToRecord);
    }

    async listAll(): Promise<GroupRecord[]> {
        const rows = await allRows<GroupRow>(this.db, `SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY sort_order ASC`);
        return rows.map(rowToRecord);
    }

    async getAccountCounts(groupIds: number[]): Promise<GroupAccountCounts[]> {
        const ids = [...new Set(groupIds)].filter(id => Number.isInteger(id) && id > 0);
        const counts: GroupAccountCounts[] = [];
        for (let offset = 0; offset < ids.length; offset += 80) {
            const batch = ids.slice(offset, offset + 80);
            const rows = await allRows<{ group_id: number; total: number; active: number; rate_limited: number }>(this.db, `
                SELECT ag.group_id,
                       COUNT(DISTINCT a.id) AS total,
                       COUNT(DISTINCT CASE WHEN a.status = 'active' AND a.schedulable = 1
                           AND (a.auto_pause_on_expired = 0 OR a.expires_at IS NULL OR julianday(a.expires_at) > julianday('now'))
                           AND (a.rate_limit_reset_at IS NULL OR julianday(a.rate_limit_reset_at) <= julianday('now'))
                           AND (a.overload_until IS NULL OR julianday(a.overload_until) <= julianday('now'))
                           AND (a.temp_unschedulable_until IS NULL OR julianday(a.temp_unschedulable_until) <= julianday('now'))
                           THEN a.id END) AS active,
                       COUNT(DISTINCT CASE WHEN julianday(a.rate_limit_reset_at) > julianday('now') THEN a.id END) AS rate_limited
                FROM account_groups ag
                JOIN accounts a ON a.id = ag.account_id AND a.deleted_at IS NULL
                WHERE ag.group_id IN (${batch.map(() => '?').join(', ')})
                GROUP BY ag.group_id
            `, batch);
            counts.push(...rows.map(row => ({ groupId: row.group_id, total: row.total, active: row.active, rateLimited: row.rate_limited })));
        }
        return counts;
    }

    async updateSortOrders(updates: Array<{ id: number; sortOrder: number }>): Promise<void> {
        const ts = nowISO();
        for (const u of updates) {
            await runStatement(this.db, `UPDATE groups SET sort_order = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [u.sortOrder, ts, u.id]);
        }
    }

    async getGroupApiKeys(groupId: number, page: number, pageSize: number): Promise<{ items: GroupApiKeyBrief[]; total: number }> {
        const countRow = await firstRow<{ c: number }>(this.db, `SELECT COUNT(*) as c FROM api_keys WHERE group_id = ? AND deleted_at IS NULL`, [groupId]);
        const total = countRow?.c ?? 0;
        const offset = (page - 1) * pageSize;
        const rows = await allRows<ApiKeyBriefRow>(this.db, `SELECT id, key, name, status, created_at FROM api_keys WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`, [groupId, pageSize, offset]);
        return { items: rows.map(r => ({ id: r.id, key: r.key, name: r.name, status: r.status, createdAt: r.created_at })), total };
    }

    async getRateMultiplierEntries(groupId: number): Promise<RateEntryRecord[]> {
        const rows = await allRows<RateEntryRow>(this.db, `
            SELECT ug.user_id, u.username as user_name, u.email as user_email, u.status as user_status,
                   ug.rate_multiplier, ug.rpm_override
            FROM user_group_rate_multipliers ug
            JOIN users u ON u.id = ug.user_id AND u.deleted_at IS NULL
            WHERE ug.group_id = ?
            ORDER BY u.email ASC
        `, [groupId]);
        return rows.map(r => ({
            userId: r.user_id, userName: r.user_name ?? "", userEmail: r.user_email,
            userStatus: r.user_status, rateMultiplier: r.rate_multiplier, rpmOverride: r.rpm_override
        }));
    }

    async syncRateMultipliers(groupId: number, entries: Array<{ userId: number; rateMultiplier: number }>): Promise<void> {
        const ts = nowISO();
        await runStatement(this.db, `UPDATE user_group_rate_multipliers SET rate_multiplier = NULL, updated_at = ? WHERE group_id = ? AND rpm_override IS NOT NULL`, [ts, groupId]);
        await runStatement(this.db, `DELETE FROM user_group_rate_multipliers WHERE group_id = ? AND rpm_override IS NULL`, [groupId]);
        for (const e of entries) {
            await runStatement(this.db, `INSERT INTO user_group_rate_multipliers (user_id, group_id, rate_multiplier, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, group_id) DO UPDATE SET rate_multiplier = ?, updated_at = ?`, [e.userId, groupId, e.rateMultiplier, ts, ts, e.rateMultiplier, ts]);
        }
    }

    async syncRPMOverrides(groupId: number, entries: Array<{ userId: number; rpmOverride: number | null }>): Promise<void> {
        const ts = nowISO();
        await runStatement(this.db, `UPDATE user_group_rate_multipliers SET rpm_override = NULL, updated_at = ? WHERE group_id = ? AND rate_multiplier IS NOT NULL`, [ts, groupId]);
        await runStatement(this.db, `DELETE FROM user_group_rate_multipliers WHERE group_id = ? AND rate_multiplier IS NULL`, [groupId]);
        for (const e of entries) {
            if (e.rpmOverride !== null) {
                await runStatement(this.db, `INSERT INTO user_group_rate_multipliers (user_id, group_id, rpm_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, group_id) DO UPDATE SET rpm_override = ?, updated_at = ?`, [e.userId, groupId, e.rpmOverride, ts, ts, e.rpmOverride, ts]);
            } else {
                await runStatement(this.db, `UPDATE user_group_rate_multipliers SET rpm_override = NULL, updated_at = ? WHERE user_id = ? AND group_id = ?`, [ts, e.userId, groupId]);
            }
        }
        await runStatement(this.db, `DELETE FROM user_group_rate_multipliers WHERE group_id = ? AND rate_multiplier IS NULL AND rpm_override IS NULL`, [groupId]);
    }

    async clearRateMultipliers(groupId: number): Promise<void> {
        const ts = nowISO();
        await runStatement(this.db, `UPDATE user_group_rate_multipliers SET rate_multiplier = NULL, updated_at = ? WHERE group_id = ? AND rpm_override IS NOT NULL`, [ts, groupId]);
        await runStatement(this.db, `DELETE FROM user_group_rate_multipliers WHERE group_id = ? AND rpm_override IS NULL`, [groupId]);
    }

    async clearRPMOverrides(groupId: number): Promise<void> {
        const ts = nowISO();
        await runStatement(this.db, `UPDATE user_group_rate_multipliers SET rpm_override = NULL, updated_at = ? WHERE group_id = ? AND rate_multiplier IS NOT NULL`, [ts, groupId]);
        await runStatement(this.db, `DELETE FROM user_group_rate_multipliers WHERE group_id = ? AND rate_multiplier IS NULL`, [groupId]);
    }
}
