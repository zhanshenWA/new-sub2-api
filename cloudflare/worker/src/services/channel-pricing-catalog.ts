// Static model-pricing catalog. OpenAI and active DeepSeek rates below
// were checked against provider documentation on 2026-11-03. Other legacy entries are retained.

interface ModelPricingEntry {
    inputPricePerToken: number;
    outputPricePerToken: number;
    cacheWritePrice: number | null;
    cacheReadPrice: number | null;
    imageOutputPrice: number | null;
    cacheWritePrice12h?: number | null;
}

interface ModelPricingResult {
    found: boolean;
    inputPrice?: number;
    outputPrice?: number;
    cacheWritePrice?: number | null;
    cacheReadPrice?: number | null;
    imageOutputPrice?: number | null;
}

const platformToProvider: Record<string, string> = {
    anthropic: "anthropic",
    openai: "openai",
    gemini: "google",
    antigravity: "anthropic",
    grok: "xai",
    deepseek: "deepseek",
    glm: "glm",
    minimax: "minimax",
    qwen: "qwen",
    kimi: "kimi",
    moonshot: "kimi",
};

// Partial pricing data for common models (prices per token)
// Official text-token prices in USD per 1M tokens, verified 2026-11-03.
// https://developers.openai.com/api/docs/pricing
// Standard short-context prices are also used by the model-price UI.
// Audio, image generation and per-call tools require separate metering.
function tokenPrices(input: number, output: number, cached: number | null, write30m: number | null = null, write12h: number | null = null): ModelPricingEntry {
    return { inputPricePerToken: input / 1e6, outputPricePerToken: output / 1e6,
        cacheReadPrice: cached === null ? null : cached / 1e6,
        cacheWritePrice: write30m === null ? null : write30m / 1e6,
        cacheWritePrice12h: write12h === null ? null : write12h / 1e6, imageOutputPrice: null };
}

const OPENAI_STANDARD: Record<string, ModelPricingEntry> = {
    "gpt-6-astra": tokenPrices(10, 50, 1, 12.5, 25),
    "gpt-6.1-sol": tokenPrices(2, 10, 0.1, 2.5, 5),
    "gpt-6.1-terra": tokenPrices(1, 5, 0.05, 1.25, 2.5),
    "gpt-6-luna": tokenPrices(0.1, 0.5, 0.01, 0.125, 0.25),
    "gpt-6-sol": tokenPrices(2, 10, 0.2, 2.5, 5),
    "gpt-5.6-sol": tokenPrices(4, 20, 0.4, 5, 10),
    "gpt-5.6-terra": tokenPrices(2, 12, 0.2, 2.5, 5),
    "gpt-5.6-luna": tokenPrices(0.2, 1.2, 0.02, 0.25, 0.5),
    "gpt-5.5": tokenPrices(5, 30, 0.5, null, null),
    "gpt-5.5-pro": tokenPrices(30, 180, null, null, null),
    "gpt-5.4": tokenPrices(2.5, 15, 0.25, null, null),
    "gpt-5.4-pro": tokenPrices(30, 180, null, null, null),
    "gpt-5.4-mini": tokenPrices(0.75, 4.5, 0.075),
    "gpt-5.4-nano": tokenPrices(0.2, 1.25, 0.02),
    "gpt-5.2": tokenPrices(1.75, 14, 0.175),
    "gpt-5.2-pro": tokenPrices(21, 168, null),
    "gpt-5.1": tokenPrices(1.25, 10, 0.125),
    "gpt-5": tokenPrices(1.25, 10, 0.125),
    "gpt-5-mini": tokenPrices(0.25, 2, 0.025),
    "gpt-5-nano": tokenPrices(0.05, 0.4, 0.005),
    "gpt-5-pro": tokenPrices(15, 120, null),
    "gpt-4.1": tokenPrices(2, 8, 0.5),
    "gpt-4.1-mini": tokenPrices(0.4, 1.6, 0.1),
    "gpt-4o": tokenPrices(2.5, 10, 1.25),
    "gpt-4o-mini": tokenPrices(0.15, 0.6, 0.075),
    "o3": tokenPrices(2, 8, 0.5),
    "o3-pro": tokenPrices(20, 80, null),
    "gpt-5.3-codex": tokenPrices(1.75, 14, 0.175),
    "chat-latest": tokenPrices(5, 30, 0.5),
};
const OPENAI_FAST: Record<string, ModelPricingEntry> = {
    "gpt-6-astra": tokenPrices(20, 100, 2, 25, 50),
    "gpt-6.1-sol": tokenPrices(4, 20, 0.2, 5, 10),
    "gpt-6.1-terra": tokenPrices(2, 10, 0.1, 2.5, 5),
    "gpt-6-luna": tokenPrices(0.2, 1, 0.02, 0.25, 0.5),
    "gpt-6-sol": tokenPrices(4, 20, 0.4, 5, 10),
    "gpt-5.6-sol": tokenPrices(8, 40, 0.8, 10, 20),
    "gpt-5.6-terra": tokenPrices(4, 24, 0.4, 5, 10),
    "gpt-5.6-luna": tokenPrices(0.4, 2.4, 0.04, 0.5, 1),
    "gpt-5.5": tokenPrices(12.5, 75, 1.25, null, null),
    "gpt-5.4": tokenPrices(5, 30, 0.5, null, null),
    "gpt-5.4-mini": tokenPrices(1.5, 9, 0.15),
    "gpt-5.2": tokenPrices(3.5, 28, 0.35),
    "gpt-5.1": tokenPrices(2.5, 20, 0.25),
    "gpt-5": tokenPrices(2.5, 20, 0.25),
    "gpt-5-mini": tokenPrices(0.45, 3.6, 0.045),
    "gpt-4.1": tokenPrices(3.5, 14, 0.875),
    "gpt-4.1-mini": tokenPrices(0.7, 2.8, 0.175),
    "gpt-4o": tokenPrices(4.25, 17, 2.125),
    "gpt-4o-mini": tokenPrices(0.25, 1, 0.125),
    "o3": tokenPrices(3.5, 14, 0.875),
};
const OPENAI_FLEX: Record<string, ModelPricingEntry> = {
    "gpt-6-astra": tokenPrices(5, 25, 0.5, 6.25, 12.5),
    "gpt-6.1-sol": tokenPrices(1, 5, 0.05, 1.25, 2.5),
    "gpt-6.1-terra": tokenPrices(0.5, 2.5, 0.025, 0.625, 1.25),
    "gpt-6-luna": tokenPrices(0.05, 0.25, 0.005, 0.0625, 0.125),
    "gpt-6-sol": tokenPrices(1, 5, 0.1, 1.25, 2.5),
    "gpt-5.6-sol": tokenPrices(2, 10, 0.2, 2.5, 5),
    "gpt-5.6-terra": tokenPrices(1, 6, 0.1, 1.25, 2.5),
    "gpt-5.6-luna": tokenPrices(0.1, 0.6, 0.01, 0.125, 0.25),
    "gpt-5.5": tokenPrices(2.5, 15, 0.25, null, null),
    "gpt-5.5-pro": tokenPrices(15, 90, null, null, null),
    "gpt-5.4": tokenPrices(1.25, 7.5, 0.13, null, null),
    "gpt-5.4-pro": tokenPrices(15, 90, null, null, null),
    "gpt-5.4-mini": tokenPrices(0.375, 2.25, 0.0375),
    "gpt-5.4-nano": tokenPrices(0.1, 0.625, 0.01),
    "gpt-5.2": tokenPrices(0.875, 7, 0.0875),
    "gpt-5.1": tokenPrices(0.625, 5, 0.0625),
    "gpt-5": tokenPrices(0.625, 5, 0.0625),
    "gpt-5-mini": tokenPrices(0.125, 1, 0.0125),
    "gpt-5-nano": tokenPrices(0.025, 0.2, 0.0025),
    "o3": tokenPrices(1, 4, 0.25),
};
const OPENAI_LONG_STANDARD: Record<string, ModelPricingEntry> = {
    "gpt-6-astra": tokenPrices(20, 75, 2, 25, 50),
    "gpt-6.1-sol": tokenPrices(4, 15, 0.2, 5, 10),
    "gpt-6.1-terra": tokenPrices(2, 7.5, 0.1, 2.5, 5),
    "gpt-6-luna": tokenPrices(0.2, 0.75, 0.02, 0.25, 0.5),
    "gpt-6-sol": tokenPrices(4, 15, 0.4, 5, 10),
    "gpt-5.6-sol": tokenPrices(8, 30, 0.8, 10, 20),
    "gpt-5.6-terra": tokenPrices(4, 18, 0.4, 5, 10),
    "gpt-5.6-luna": tokenPrices(0.4, 1.8, 0.04, 0.5, 1),
    "gpt-5.5": tokenPrices(10, 45, 1, null, null),
    "gpt-5.5-pro": tokenPrices(60, 270, null, null, null),
    "gpt-5.4": tokenPrices(5, 22.5, 0.5, null, null),
    "gpt-5.4-pro": tokenPrices(60, 270, null, null, null),
};

const OPENAI_LONG_FAST: Record<string, ModelPricingEntry> = {
    "gpt-6-astra": tokenPrices(40, 150, 4, 50, 100),
    "gpt-6.1-sol": tokenPrices(8, 30, 0.4, 10, 20),
    "gpt-6.1-terra": tokenPrices(4, 15, 0.2, 5, 10),
    "gpt-6-luna": tokenPrices(0.4, 1.5, 0.04, 0.5, 1),
    "gpt-6-sol": tokenPrices(8, 30, 0.8, 10, 20),
    "gpt-5.6-sol": tokenPrices(16, 60, 1.6, 20, 40),
    "gpt-5.6-terra": tokenPrices(8, 36, 0.8, 10, 20),
    "gpt-5.6-luna": tokenPrices(0.8, 3.6, 0.08, 1, 2),
};

const OPENAI_LONG_FLEX: Record<string, ModelPricingEntry> = {
    "gpt-6-astra": tokenPrices(10, 37.5, 1, 12.5, 25),
    "gpt-6.1-sol": tokenPrices(2, 7.5, 0.1, 2.5, 5),
    "gpt-6.1-terra": tokenPrices(1, 3.75, 0.05, 1.25, 2.5),
    "gpt-6-luna": tokenPrices(0.1, 0.375, 0.01, 0.125, 0.25),
    "gpt-6-sol": tokenPrices(2, 7.5, 0.2, 2.5, 5),
    "gpt-5.6-sol": tokenPrices(4, 15, 0.4, 5, 10),
    "gpt-5.6-terra": tokenPrices(2, 9, 0.2, 2.5, 5),
    "gpt-5.6-luna": tokenPrices(0.2, 0.9, 0.02, 0.25, 0.5),
    "gpt-5.5": tokenPrices(5, 22.5, 0.5, null, null),
    "gpt-5.4": tokenPrices(2.5, 11.25, 0.25, null, null),
    "gpt-5.4-pro": tokenPrices(30, 135, null, null, null),
};

const OPENAI_LONG_CONTEXT = new Set(["gpt-6-astra","gpt-6.1-sol","gpt-6.1-terra","gpt-6-luna","gpt-6-sol","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","gpt-5.5-pro","gpt-5.4","gpt-5.4-pro"]);
// Existing exact snapshots with the same verified published text-token rate.
OPENAI_STANDARD["gpt-4o-2024-08-06"] = OPENAI_STANDARD["gpt-4o"];
OPENAI_STANDARD["gpt-4o-mini-2024-07-18"] = OPENAI_STANDARD["gpt-4o-mini"];

export interface PricingContext {
    inputTokens?: number;
    serviceTier?: string;
    cacheRetention?: string;
    timeMs?: number;
}

// https://api-docs.deepseek.com/quick_start/pricing/ (verified 2026-11-03).
// Off-peak: weekends/Chinese holidays, and outside 01-04 / 06-10 UTC weekdays.
// 2026 official holiday schedule reproduced at https://www.yicai.com/news/102895208.html
// Refresh the holiday calendar and rates when the providers publish changes.
const CHINA_HOLIDAYS_2026 = [["01-01", "01-03"], ["02-15", "02-23"], ["04-04", "04-06"],
    ["05-01", "05-05"], ["06-19", "06-21"], ["09-25", "09-27"], ["10-01", "10-07"]];
function deepSeekPeak(timeMs: number): boolean {
    const date = new Date(timeMs);
    const localDate = new Date(timeMs + 8 * 3600_000).toISOString().slice(0, 10);
    const holiday = localDate.startsWith("2026-") && CHINA_HOLIDAYS_2026.some(([start, end]) => localDate.slice(5) >= start && localDate.slice(5) <= end);
    const hour = date.getUTCHours();
    return date.getUTCDay() >= 1 && date.getUTCDay() <= 5 && !holiday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

const PRICING_CATALOG: Record<string, Record<string, ModelPricingEntry>> = {
    anthropic: {
        "claude-sonnet-4-20250514": {
            inputPricePerToken: 3e-6, outputPricePerToken: 1.5e-5,
            cacheWritePrice: 3.75e-6, cacheReadPrice: 3e-7, imageOutputPrice: null,
        },
        "claude-sonnet-4": {
            inputPricePerToken: 3e-6, outputPricePerToken: 1.5e-5,
            cacheWritePrice: 3.75e-6, cacheReadPrice: 3e-7, imageOutputPrice: null,
        },
        "claude-3-5-sonnet-20241022": {
            inputPricePerToken: 3e-6, outputPricePerToken: 1.5e-5,
            cacheWritePrice: 3.75e-6, cacheReadPrice: 3e-7, imageOutputPrice: 4e-3,
        },
        "claude-3-5-haiku-20241022": {
            inputPricePerToken: 8e-7, outputPricePerToken: 4e-6,
            cacheWritePrice: 1e-6, cacheReadPrice: 8e-8, imageOutputPrice: 4e-3,
        },
        "claude-3-opus-20240229": {
            inputPricePerToken: 1.5e-5, outputPricePerToken: 7.5e-5,
            cacheWritePrice: 1.875e-5, cacheReadPrice: 1.5e-6, imageOutputPrice: 4e-3,
        },
        "claude-3-haiku-20240307": {
            inputPricePerToken: 2.5e-7, outputPricePerToken: 1.25e-6,
            cacheWritePrice: 3.125e-7, cacheReadPrice: 2.5e-8, imageOutputPrice: 4e-3,
        },
    },
    openai: OPENAI_STANDARD,
    google: {
        "gemini-2.0-flash-exp": {
            inputPricePerToken: 1e-7, outputPricePerToken: 4e-7,
            cacheWritePrice: null, cacheReadPrice: 2.5e-8, imageOutputPrice: null,
        },
        "gemini-1.5-pro-002": {
            inputPricePerToken: 1.25e-6, outputPricePerToken: 5e-6,
            cacheWritePrice: null, cacheReadPrice: 3.125e-7, imageOutputPrice: null,
        },
        "gemini-1.5-flash-002": {
            inputPricePerToken: 7.5e-8, outputPricePerToken: 3e-7,
            cacheWritePrice: null, cacheReadPrice: 1.875e-8, imageOutputPrice: null,
        },
    },
    xai: {
        "grok-2-1212": {
            inputPricePerToken: 2e-6, outputPricePerToken: 1e-5,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "grok-beta": {
            inputPricePerToken: 5e-6, outputPricePerToken: 1.5e-5,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
    },
    deepseek: {
        "deepseek-flash": tokenPrices(0.15, 0.6, 0.003),
        // Compatible upstream name for DeepSeek-V4.1-Flash; same Flash tariff.
        "deepseek-v4.1-flash": tokenPrices(0.15, 0.6, 0.003),
        "deepseek-v4-flash": tokenPrices(0.15, 0.6, 0.003),
        "deepseek-v4-flash-vision-exp": tokenPrices(0.15, 0.6, 0.003),
        "deepseek-v4-pro": tokenPrices(0.66, 1.98, 0.022),
        "deepseek-chat": {
            inputPricePerToken: 2.7e-7, outputPricePerToken: 1.1e-6,
            cacheWritePrice: null, cacheReadPrice: 7e-8, imageOutputPrice: null,
        },
        "deepseek-reasoner": {
            inputPricePerToken: 5.5e-7, outputPricePerToken: 2.19e-6,
            cacheWritePrice: null, cacheReadPrice: 1.4e-7, imageOutputPrice: null,
        },
    },
    glm: {
        "glm-5.3": {
            inputPricePerToken: 1e-6, outputPricePerToken: 2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "glm-5.3-flash": {
            inputPricePerToken: 0, outputPricePerToken: 0,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "glm-5.2": {
            inputPricePerToken: 1e-6, outputPricePerToken: 2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "glm-5.1": {
            inputPricePerToken: 1e-6, outputPricePerToken: 2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "glm-5-turbo": {
            inputPricePerToken: 1e-6, outputPricePerToken: 2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "glm-4.7": {
            inputPricePerToken: 1e-6, outputPricePerToken: 2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "glm-4.7-flash": {
            inputPricePerToken: 0, outputPricePerToken: 0,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "glm-5v-turbo": {
            inputPricePerToken: 1e-6, outputPricePerToken: 2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "glm-4.6v": {
            inputPricePerToken: 1e-6, outputPricePerToken: 2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "glm-4-long": {
            inputPricePerToken: 1e-6, outputPricePerToken: 2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
    },
    minimax: {
        "MiniMax-M3": {
            inputPricePerToken: 2e-6, outputPricePerToken: 8e-6,
            cacheWritePrice: null, cacheReadPrice: 5e-7, imageOutputPrice: null,
        },
        "MiniMax-M2.7": {
            inputPricePerToken: 1e-6, outputPricePerToken: 4e-6,
            cacheWritePrice: null, cacheReadPrice: 2.5e-7, imageOutputPrice: null,
        },
        "MiniMax-M2.7-highspeed": {
            inputPricePerToken: 1e-6, outputPricePerToken: 4e-6,
            cacheWritePrice: null, cacheReadPrice: 2.5e-7, imageOutputPrice: null,
        },
        "MiniMax-M2.5": {
            inputPricePerToken: 6e-7, outputPricePerToken: 2.4e-6,
            cacheWritePrice: null, cacheReadPrice: 1.5e-7, imageOutputPrice: null,
        },
        "MiniMax-M2.5-highspeed": {
            inputPricePerToken: 6e-7, outputPricePerToken: 2.4e-6,
            cacheWritePrice: null, cacheReadPrice: 1.5e-7, imageOutputPrice: null,
        },
        "MiniMax-M2.1": {
            inputPricePerToken: 6e-7, outputPricePerToken: 2.4e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "MiniMax-Text-01": {
            inputPricePerToken: 1e-6, outputPricePerToken: 4e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "MiniMax-VL-01": {
            inputPricePerToken: 1e-6, outputPricePerToken: 4e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "abab6.5s-chat": {
            inputPricePerToken: 1e-6, outputPricePerToken: 1e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
    },
    qwen: {
        "qwen3.8-max-0902": {
            inputPricePerToken: 2e-6, outputPricePerToken: 6e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwen3.8-max": {
            inputPricePerToken: 2e-6, outputPricePerToken: 6e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwen3.8-flash": {
            inputPricePerToken: 2e-7, outputPricePerToken: 6e-7,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwen3-max": {
            inputPricePerToken: 2e-6, outputPricePerToken: 6e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwen3.5-omni-flash": {
            inputPricePerToken: 4e-7, outputPricePerToken: 1.2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwen3-vl-flash": {
            inputPricePerToken: 3e-7, outputPricePerToken: 9e-7,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwen-max": {
            inputPricePerToken: 2e-6, outputPricePerToken: 6e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwen-plus": {
            inputPricePerToken: 4e-7, outputPricePerToken: 1.2e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwen-turbo": {
            inputPricePerToken: 2e-7, outputPricePerToken: 6e-7,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwen-flash": {
            inputPricePerToken: 1e-7, outputPricePerToken: 3e-7,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
        "qwq-32b": {
            inputPricePerToken: 6e-7, outputPricePerToken: 1.8e-6,
            cacheWritePrice: null, cacheReadPrice: null, imageOutputPrice: null,
        },
    },
    kimi: {
        "kimi-k3": {
            inputPricePerToken: 2e-6, outputPricePerToken: 8e-6,
            cacheWritePrice: null, cacheReadPrice: 5e-7, imageOutputPrice: null,
        },
        "kimi-k2.7-code": {
            inputPricePerToken: 1.5e-6, outputPricePerToken: 6e-6,
            cacheWritePrice: null, cacheReadPrice: 3e-7, imageOutputPrice: null,
        },
        "kimi-k2.7-code-highspeed": {
            inputPricePerToken: 1.5e-6, outputPricePerToken: 6e-6,
            cacheWritePrice: null, cacheReadPrice: 3e-7, imageOutputPrice: null,
        },
        "kimi-k2.6": {
            inputPricePerToken: 1.2e-6, outputPricePerToken: 4.8e-6,
            cacheWritePrice: null, cacheReadPrice: 2.5e-7, imageOutputPrice: null,
        },
    },
};

export class ChannelPricingCatalogService {
    getModelPricing(model: string, context: PricingContext = {}): ModelPricingResult {
        for (const [provider, models] of Object.entries(PRICING_CATALOG)) {
            if (!Object.prototype.hasOwnProperty.call(models, model)) continue;
            let p = models[model];
            let inputFactor = 1;
            let outputFactor = 1;
            if (provider === "openai") {
                const tier = context.serviceTier ?? "default";
                if (tier === "priority" || tier === "fast") p = OPENAI_FAST[model];
                else if (tier === "flex") p = OPENAI_FLEX[model];
                else if (tier !== "default" && tier !== "standard" && tier !== "auto") return { found: false };
                if (!p) return { found: false };
                if ((context.inputTokens ?? 0) > 272_000 && OPENAI_LONG_CONTEXT.has(model)) {
                    const longPrices = tier === "priority" || tier === "fast" ? OPENAI_LONG_FAST : tier === "flex" ? OPENAI_LONG_FLEX : OPENAI_LONG_STANDARD;
                    p = longPrices[model];
                    if (!p) return { found: false };
                }
            }
            if (provider === "deepseek" && model !== "deepseek-chat" && model !== "deepseek-reasoner" && deepSeekPeak(context.timeMs ?? Date.now())) {
                inputFactor = outputFactor = 2;
            }
            const cacheWrite = context.cacheRetention === "12h" ? p.cacheWritePrice12h ?? p.cacheWritePrice : p.cacheWritePrice;
            return {
                found: true,
                inputPrice: p.inputPricePerToken * inputFactor,
                outputPrice: p.outputPricePerToken * outputFactor,
                cacheWritePrice: cacheWrite === null || cacheWrite === undefined ? null : cacheWrite * inputFactor,
                cacheReadPrice: p.cacheReadPrice === null ? null : p.cacheReadPrice * inputFactor,
                imageOutputPrice: p.imageOutputPrice,
            };
        }
        return { found: false };
    }

    listModelNamesByPlatform(platform: string): string[] {
        const provider = platformToProvider[platform];
        if (!provider) return [];
        const models = PRICING_CATALOG[provider];
        if (!models) return [];
        return Object.keys(models);
    }
}
