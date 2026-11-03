import { allRows } from "../repositories/d1.ts";
import type { D1Database, D1Value } from "../types/d1.ts";

// Enrich only the already-authorized page, with one query and no credential fields.
export async function withUsageMetadata<T extends { id: number }>(
    db: D1Database,
    items: T[],
    scope: { userId: number } | { admin: true }
): Promise<Array<T & Record<string, unknown>>> {
    if (items.length === 0) return [];
    const admin = "admin" in scope;
    const ids = [...new Set(items.map((item) => item.id))];
    const values: D1Value[] = [...ids];
    if (!admin && "userId" in scope) values.push(scope.userId);
    const rows = await allRows<Record<string, unknown>>(db,
        `SELECT l.id, l.user_id, l.api_key_id, l.group_id, l.account_id,
                l.upstream_model, l.reasoning_effort, l.ip_address,
                l.inbound_endpoint, l.upstream_endpoint, l.first_token_ms, l.user_agent,
                l.rate_multiplier, l.billing_mode, l.billing_tier,
                l.input_cost, l.output_cost, l.cache_creation_cost, l.cache_read_cost,
                k.name AS key_name, g.name AS group_name, g.platform AS group_platform,
                g.rate_multiplier AS group_rate_multiplier
                ${admin ? ", u.email AS user_email, u.username AS user_name, u.deleted_at AS user_deleted_at, a.name AS account_name" : ""}
         FROM usage_logs l
         LEFT JOIN api_keys k ON k.id = l.api_key_id
         LEFT JOIN groups g ON g.id = l.group_id
         ${admin ? "LEFT JOIN users u ON u.id = l.user_id LEFT JOIN accounts a ON a.id = l.account_id" : ""}
         WHERE l.id IN (${ids.map(() => "?").join(",")})${admin ? "" : " AND l.user_id = ?"}`, values);
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    return items.flatMap((item) => {
        const row = byId.get(item.id);
        if (!row) return [];
        const metadata: Record<string, unknown> = {
            user_id: row.user_id,
            upstream_model: row.upstream_model,
            reasoning_effort: row.reasoning_effort,
            ip_address: row.ip_address,
            inbound_endpoint: row.inbound_endpoint,
            upstream_endpoint: row.upstream_endpoint,
            first_token_ms: row.first_token_ms,
            user_agent: row.user_agent,
            rate_multiplier: row.rate_multiplier,
            billing_mode: row.billing_mode,
            billing_tier: row.billing_tier,
            input_cost: row.input_cost,
            output_cost: row.output_cost,
            cache_creation_cost: row.cache_creation_cost,
            cache_read_cost: row.cache_read_cost,
            api_key: { id: row.api_key_id, name: row.key_name ?? null },
            group: row.group_id == null ? null : {
                id: row.group_id, name: row.group_name ?? `#${row.group_id}`,
                platform: row.group_platform, rate_multiplier: row.group_rate_multiplier
            }
        };
        if (admin) {
            metadata.user = { id: row.user_id, email: row.user_email ?? null, username: row.user_name ?? null, deleted_at: row.user_deleted_at ?? null };
            metadata.account = { id: row.account_id, name: row.account_name ?? null };
        }
        return [{ ...item, ...metadata }];
    });
}
