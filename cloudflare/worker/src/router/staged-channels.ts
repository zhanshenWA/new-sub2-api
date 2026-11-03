import { D1AuthSessionRepository } from "../repositories/auth-sessions.ts";
import { D1AuthUserRepository } from "../repositories/auth-users.ts";
import { AccessAuthError, AccessAuthService } from "../services/access-auth.ts";
import { AuthTokenService } from "../services/auth-tokens.ts";
import { D1ChannelService, ChannelError } from "../services/channels.ts";
import { ChannelPricingCatalogService } from "../services/channel-pricing-catalog.ts";
import { Hs256JwtSigner, Hs256JwtVerifier } from "../services/jwt.ts";
import type { ChannelModelPricingRecord, ChannelWithRelationsRecord } from "../repositories/channels.ts";
import type { D1Database } from "../types/d1.ts";
import {
    legacyError,
    legacyInternalError,
    legacySuccess,
    middlewareAuthError,
    routerError
} from "./responses.ts";

const CHANNELS_PATH = "/api/v1/admin/channels";
const CHANNELS_ID = /^\/api\/v1\/admin\/channels\/(\d+)$/u;
const CHANNELS_MODEL_PRICING = "/api/v1/admin/channels/model-pricing";
const CHANNELS_SYNC_MODELS = "/api/v1/admin/channels/pricing/sync-models";

function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function mapPricingInput(raw: unknown): unknown {
    if (!Array.isArray(raw)) return raw;
    return raw.map((item) => {
        if (!item || typeof item !== "object") return item;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            if (k === "intervals" && Array.isArray(v)) {
                out[snakeToCamel(k)] = v.map((iv) => {
                    if (!iv || typeof iv !== "object") return iv;
                    const m: Record<string, unknown> = {};
                    for (const [ik, iv2] of Object.entries(iv as Record<string, unknown>)) m[snakeToCamel(ik)] = iv2;
                    return m;
                });
            } else {
                out[snakeToCamel(k)] = v;
            }
        }
        return out;
    });
}

function mapAccountStatsRulesInput(raw: unknown): unknown {
    if (!Array.isArray(raw)) return raw;
    return raw.map((item) => {
        if (!item || typeof item !== "object") return item;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            if (k === "pricing") {
                out.pricing = mapPricingInput(v);
            } else {
                out[snakeToCamel(k)] = v;
            }
        }
        return out;
    });
}

function pricingOutput(pricing: ChannelModelPricingRecord) {
    return {
        id: pricing.id, channel_id: pricing.channelId, platform: pricing.platform,
        models: pricing.models, billing_mode: pricing.billingMode,
        input_price: pricing.inputPrice, output_price: pricing.outputPrice,
        cache_write_price: pricing.cacheWritePrice, cache_read_price: pricing.cacheReadPrice,
        image_output_price: pricing.imageOutputPrice, per_request_price: pricing.perRequestPrice,
        intervals: pricing.intervals.map((interval) => ({
            id: interval.id, pricing_id: interval.pricingId,
            min_tokens: interval.minTokens, max_tokens: interval.maxTokens,
            tier_label: interval.tierLabel, input_price: interval.inputPrice,
            output_price: interval.outputPrice, cache_write_price: interval.cacheWritePrice,
            cache_read_price: interval.cacheReadPrice, per_request_price: interval.perRequestPrice,
            sort_order: interval.sortOrder,
        })),
    };
}

// The admin API uses snake_case; preserve user-defined JSON mapping keys verbatim.
function channelOutput(channel: ChannelWithRelationsRecord) {
    return {
        id: channel.id, name: channel.name, description: channel.description, status: channel.status,
        group_ids: channel.groupIds, model_pricing: channel.modelPricing.map(pricingOutput),
        model_mapping: channel.modelMapping, billing_model_source: channel.billingModelSource,
        restrict_models: channel.restrictModels, features: channel.features,
        features_config: channel.featuresConfig,
        apply_pricing_to_account_stats: channel.applyPricingToAccountStats,
        account_stats_pricing_rules: channel.accountStatsPricingRules.map((rule) => ({
            id: rule.id, channel_id: rule.channelId, name: rule.name,
            group_ids: rule.groupIds, account_ids: rule.accountIds, sort_order: rule.sortOrder,
            pricing: rule.pricing.map(pricingOutput),
        })),
        created_at: channel.createdAt, updated_at: channel.updatedAt,
    };
}

export interface StagedChannelsEnv {
    DB?: D1Database;
    JWT_SECRET?: string;
    JWT_ACCESS_TOKEN_EXPIRES_SECONDS?: string;
    JWT_REFRESH_TOKEN_EXPIRE_DAYS?: string;
}

export interface StagedChannelsDependencies {
    clock?: () => number;
}

function boundedIntegerEnv(
    value: string | undefined,
    defaultValue: number,
    min: number,
    max: number
): number {
    if (value === undefined || value.trim() === "") return defaultValue;
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isInteger(parsed)) return defaultValue;
    return Math.min(max, Math.max(min, parsed));
}

function parseOptionalInt(url: URL, key: string): number | undefined {
    const value = url.searchParams.get(key);
    if (value === null || value.trim() === "") return undefined;
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) ? parsed : undefined;
}

function parseQueryString(url: URL, key: string): string | undefined {
    const value = url.searchParams.get(key);
    return value !== null && value.trim() !== "" ? value.trim() : undefined;
}

async function authenticateAdmin(
    request: Request,
    env: StagedChannelsEnv,
    clock: () => number
): Promise<{ userId: number; role: string }> {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
        throw new AccessAuthError("UNAUTHORIZED", "Missing authorization header");
    }
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

export async function routeStagedChannels(
    request: Request,
    env: StagedChannelsEnv,
    dependencies: StagedChannelsDependencies = {}
): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const clock = dependencies.clock ?? Date.now;

    const idMatch = CHANNELS_ID.exec(path);

    const isKnownPath =
        path === CHANNELS_PATH ||
        path === CHANNELS_MODEL_PRICING ||
        path === CHANNELS_SYNC_MODELS ||
        idMatch !== null;

    if (!isKnownPath) return null;
    if (env.DB === undefined) return routerError(503, "database_not_configured", "Configure the Cloudflare D1 DB binding");

    try {
        const auth = await authenticateAdmin(request, env, clock);
        if (auth.role !== "admin") return middlewareAuthError(403, "FORBIDDEN", "Admin access required");

        const service = new D1ChannelService(env.DB);
        const pricingCatalog = new ChannelPricingCatalogService();

        // GET /api/v1/admin/channels/model-pricing?model=claude-sonnet-4
        if (path === CHANNELS_MODEL_PRICING && request.method === "GET") {
            const model = url.searchParams.get("model")?.trim() ?? "";
            if (!model) {
                return legacyError(400, "model parameter is required", "MISSING_PARAMETER");
            }
            const result = pricingCatalog.getModelPricing(model);
            return legacySuccess(result);
        }

        // GET /api/v1/admin/channels/pricing/sync-models?platform=anthropic
        if (path === CHANNELS_SYNC_MODELS && request.method === "GET") {
            const platform = url.searchParams.get("platform")?.trim().toLowerCase() ?? "";
            if (!platform) {
                return legacyError(400, "platform parameter is required", "MISSING_PARAMETER");
            }
            const allowed = ["anthropic", "openai", "gemini", "antigravity", "grok", "deepseek", "glm", "minimax", "qwen", "kimi", "moonshot"];
            if (!allowed.includes(platform)) {
                return legacyError(400, `unsupported platform: ${platform}`, "UNSUPPORTED_PLATFORM");
            }
            const models = pricingCatalog.listModelNamesByPlatform(platform);
            return legacySuccess({ models });
        }

        // GET /api/v1/admin/channels — list
        if (path === CHANNELS_PATH && request.method === "GET") {
            const page = parseOptionalInt(url, "page") ?? 1;
            const pageSize = parseOptionalInt(url, "page_size") ?? 20;
            const status = parseQueryString(url, "status");
            const search = parseQueryString(url, "search");
            const sortBy = parseQueryString(url, "sort_by") ?? "created_at";
            const sortOrder = parseQueryString(url, "sort_order") ?? "desc";
            const result = await service.list({ page, pageSize, status, search, sortBy, sortOrder });
            return legacySuccess({ items: result.items.map(channelOutput), total: result.total, page, page_size: pageSize });
        }

        // POST /api/v1/admin/channels — create
        if (path === CHANNELS_PATH && request.method === "POST") {
            const body = await request.json() as Record<string, unknown>;
            if (!body || typeof body.name !== "string") {
                return legacyError(400, "name is required", "INVALID_BODY");
            }
            const created = await service.create({
                name: body.name as string,
                description: body.description as string | undefined,
                groupIds: body.group_ids as number[] | undefined,
                modelPricing: mapPricingInput(body.model_pricing) as any,
                modelMapping: body.model_mapping as Record<string, Record<string, string>> | undefined,
                billingModelSource: body.billing_model_source as string | undefined,
                restrictModels: body.restrict_models as boolean | undefined,
                features: body.features as string | undefined,
                featuresConfig: body.features_config as Record<string, unknown> | undefined,
                applyPricingToAccountStats: body.apply_pricing_to_account_stats as boolean | undefined,
                accountStatsPricingRules: mapAccountStatsRulesInput(body.account_stats_pricing_rules) as any,
            });
            return legacySuccess(channelOutput(created));
        }

        // GET /api/v1/admin/channels/:id
        if (idMatch !== null && request.method === "GET") {
            const id = Number(idMatch[1]);
            const channel = await service.getById(id);
            return legacySuccess(channelOutput(channel));
        }

        // PUT /api/v1/admin/channels/:id
        if (idMatch !== null && request.method === "PUT") {
            const id = Number(idMatch[1]);
            const body = await request.json() as Record<string, unknown>;
            if (!body || typeof body !== "object") {
                return legacyError(400, "Request body must be a JSON object", "INVALID_BODY");
            }
            const updated = await service.update(id, {
                name: body.name as string | undefined,
                description: body.description as string | null | undefined,
                status: body.status as string | undefined,
                groupIds: body.group_ids as number[] | null | undefined,
                modelPricing: mapPricingInput(body.model_pricing) as any,
                modelMapping: body.model_mapping as Record<string, Record<string, string>> | undefined,
                billingModelSource: body.billing_model_source as string | undefined,
                restrictModels: body.restrict_models as boolean | null | undefined,
                features: body.features as string | null | undefined,
                featuresConfig: body.features_config as Record<string, unknown> | undefined,
                applyPricingToAccountStats: body.apply_pricing_to_account_stats as boolean | null | undefined,
                accountStatsPricingRules: mapAccountStatsRulesInput(body.account_stats_pricing_rules) as any,
            });
            return legacySuccess(channelOutput(updated));
        }

        // DELETE /api/v1/admin/channels/:id
        if (idMatch !== null && request.method === "DELETE") {
            const id = Number(idMatch[1]);
            await service.delete(id);
            return legacySuccess({ message: "Channel deleted successfully" });
        }

        return null;
    } catch (error: unknown) {
        if (error instanceof AccessAuthError) return middlewareAuthError(401, error.code, error.message);
        if (error instanceof ChannelError) return legacyError(error.status, error.message, error.code);
        return legacyInternalError();
    }
}
