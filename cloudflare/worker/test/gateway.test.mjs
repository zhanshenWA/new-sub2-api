import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { routeRequest } from "../src/index.ts";
import { gatewayLogContext, hasGatewayOutput } from "../src/services/gateway-log-context.ts";
import { withUsageMetadata } from "../src/services/usage-log-metadata.ts";
import { SQLiteD1Database } from "./sqlite-d1.mjs";

const migrations = await Promise.all([
    "0001_ent_core.sql",
    "0004_runtime_state.sql",
    "0005_auth_sessions.sql",
    "0007_usage_reasoning_effort.sql"
].map((name) => readFile(new URL(`../../d1/migrations/${name}`, import.meta.url), "utf8")));

async function fixture() {
    const db = new SQLiteD1Database();
    for (const migration of migrations) db.exec(migration);
    const now = "2026-07-18T00:00:00.000Z";
    const user = await db.prepare(`
        INSERT INTO users (created_at, updated_at, email, password_hash, role, status, username, totp_enabled, signup_source, token_version, balance)
        VALUES (?, ?, ?, ?, 'user', 'active', 'gateway-user', 0, 'email', 0, 10)
    `).bind(now, now, "gateway@example.com", "hash").run();
    const userId = Number(user.meta.last_row_id);
    await db.prepare(`
        INSERT INTO api_keys (created_at, updated_at, key, name, status, user_id, quota, quota_used, rate_limit_5h, rate_limit_1d, rate_limit_7d, usage_5h, usage_1d, usage_7d)
        VALUES (?, ?, 'sk-gateway', 'Gateway', 'active', ?, 0, 0, 0, 0, 0, 0, 0, 0)
    `).bind(now, now, userId).run();
    await db.prepare(`
        INSERT INTO accounts (created_at, updated_at, name, notes, platform, type, credentials, extra, concurrency, priority, rate_multiplier, status, auto_pause_on_expired, schedulable, quota_dimension)
        VALUES (?, ?, 'openai-main', '', 'openai', 'apikey', ?, '{}', 3, 50, 1, 'active', 1, 1, 'global')
    `).bind(now, now, JSON.stringify({ api_key: "upstream-secret", base_url: "https://upstream.example" })).run();
    return db;
}

test("gateway requires an API key", async () => {
    const db = await fixture();
    const response = await routeRequest(new Request("https://edge.example/v1/chat/completions", { method: "POST", body: "{}" }), { DB: db });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "invalid_api_key");
});

test("gateway selects an account and forwards credentials and body", async (t) => {
    const db = await fixture();
    const originalFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, init) => {
        captured = { url: String(url), init, body: await new Response(init.body).text() };
        return new Response(JSON.stringify({ id: "chatcmpl-1" }), {
            status: 200,
            headers: { "content-type": "application/json", "x-upstream": "ok" }
        });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const response = await routeRequest(new Request("https://edge.example/v1/chat/completions?trace=1", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1", messages: [] })
    }), { DB: db });

    assert.equal(response.status, 200);
    assert.equal(captured.url, "https://upstream.example/v1/chat/completions?trace=1");
    assert.equal(captured.init.headers.get("authorization"), "Bearer upstream-secret");
    assert.deepEqual(JSON.parse(captured.body), { model: "gpt-4.1", messages: [] });
    assert.equal(response.headers.get("x-upstream"), "ok");
    assert.equal(response.headers.get("x-sub2api-account-id"), "1");
    const key = await db.prepare("SELECT last_used_at FROM api_keys WHERE key = 'sk-gateway'").first();
    assert.equal(typeof key.last_used_at, "string");
});

test("gateway fails over to the next account on retryable upstream failure", async (t) => {
    const db = await fixture();
    const now = "2026-07-18T00:00:00.000Z";
    await db.prepare(`
        INSERT INTO accounts (created_at, updated_at, name, notes, platform, type, credentials, extra, concurrency, priority, rate_multiplier, status, auto_pause_on_expired, schedulable, quota_dimension)
        VALUES (?, ?, 'openai-backup', '', 'openai', 'apikey', ?, '{}', 3, 60, 1, 'active', 1, 1, 'global')
    `).bind(now, now, JSON.stringify({ api_key: "backup-secret", base_url: "https://backup.example" })).run();

    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), body: await new Response(init.body).text() });
        if (String(url).startsWith("https://upstream.example")) {
            return new Response("temporary failure", { status: 503 });
        }
        return new Response(JSON.stringify({ id: "chatcmpl-backup" }), {
            status: 200,
            headers: { "content-type": "application/json" }
        });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const payload = { model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] };
    const response = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify(payload)
    }), { DB: db });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-sub2api-account-id"), "2");
    assert.equal(response.headers.get("x-sub2api-routing-attempt"), "2");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://upstream.example/v1/chat/completions");
    assert.equal(calls[1].url, "https://backup.example/v1/chat/completions");
    assert.deepEqual(JSON.parse(calls[0].body), payload);
    assert.deepEqual(JSON.parse(calls[1].body), payload);

    const failed = await db.prepare("SELECT error_message, temp_unschedulable_until, temp_unschedulable_reason FROM accounts WHERE id = 1").first();
    assert.match(failed.error_message, /503/);
    assert.equal(failed.temp_unschedulable_reason, "gateway_failover");
    assert.ok(Date.parse(failed.temp_unschedulable_until) > Date.now());
});

test("gateway skips accounts that are in overload cooldown", async (t) => {
    const db = await fixture();
    const now = "2026-07-18T00:00:00.000Z";
    const future = new Date(Date.now() + 60_000).toISOString();
    await db.prepare("UPDATE accounts SET overload_until = ? WHERE id = 1").bind(future).run();
    await db.prepare(`
        INSERT INTO accounts (created_at, updated_at, name, notes, platform, type, credentials, extra, concurrency, priority, rate_multiplier, status, auto_pause_on_expired, schedulable, quota_dimension)
        VALUES (?, ?, 'openai-healthy', '', 'openai', 'apikey', ?, '{}', 3, 60, 1, 'active', 1, 1, 'global')
    `).bind(now, now, JSON.stringify({ api_key: "healthy-secret", base_url: "https://healthy.example" })).run();

    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = async (url) => {
        calledUrl = String(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const response = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: "{}"
    }), { DB: db });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-sub2api-account-id"), "2");
    assert.equal(response.headers.get("x-sub2api-routing-attempt"), "1");
    assert.equal(calledUrl, "https://healthy.example/v1/chat/completions");
});

test("gateway marks final-attempt retryable status as account failure and does not mark key success", async (t) => {
    const db = await fixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "15" }
    });
    t.after(() => { globalThis.fetch = originalFetch; });

    const response = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: "{}"
    }), { DB: db });

    assert.equal(response.status, 429);
    const failed = await db.prepare("SELECT error_message, temp_unschedulable_until, temp_unschedulable_reason FROM accounts WHERE id = 1").first();
    assert.match(failed.error_message, /429/);
    assert.equal(failed.temp_unschedulable_reason, "gateway_failover");
    assert.ok(Date.parse(failed.temp_unschedulable_until) > Date.now());
    const key = await db.prepare("SELECT last_used_at FROM api_keys WHERE key = 'sk-gateway'").first();
    assert.equal(key.last_used_at, null);
});

test("gateway strips client Bearer header for Gemini accounts and prefixes /v1 on root OpenAI paths", async (t) => {
    const db = await fixture();
    const now = "2026-07-18T00:00:00.000Z";
    await db.prepare(`
        INSERT INTO accounts (created_at, updated_at, name, notes, platform, type, credentials, extra, concurrency, priority, rate_multiplier, status, auto_pause_on_expired, schedulable, quota_dimension)
        VALUES (?, ?, 'gemini-main', '', 'gemini', 'apikey', ?, '{}', 3, 10, 1, 'active', 1, 1, 'global')
    `).bind(now, now, JSON.stringify({ api_key: "gemini-secret", base_url: "https://generativelanguage.googleapis.com" })).run();

    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), auth: init.headers.get("authorization") });
        return new Response(JSON.stringify({
            id: "chatcmpl-usage",
            model: "gpt-4.1",
            usage: { prompt_tokens: 100, completion_tokens: 50 }
        }), { status: 200, headers: { "content-type": "application/json" } });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const geminiResp = await routeRequest(new Request("https://edge.example/v1beta/models/gemini-2.5-pro:generateContent", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ contents: [] })
    }), { DB: db });
    assert.equal(geminiResp.status, 200);
    assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=gemini-secret");
    assert.equal(calls[0].auth, null);

    const openaiResp = await routeRequest(new Request("https://edge.example/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1", messages: [] })
    }), { DB: db });
    assert.equal(openaiResp.status, 200);
    assert.equal(calls[1].url, "https://upstream.example/v1/chat/completions");
    assert.equal(calls[1].auth, "Bearer upstream-secret");

    const usageLog = await db.prepare("SELECT input_tokens, output_tokens FROM usage_logs ORDER BY id DESC LIMIT 1").first();
    assert.equal(usageLog.input_tokens, 100);
    assert.equal(usageLog.output_tokens, 50);
});

test("gateway returns 402 insufficient_balance when balance is 0 without an active subscription", async () => {
    const db = await fixture();
    await db.prepare("UPDATE users SET balance = 0 WHERE id = 1").run();

    const response = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-2024-08-06", messages: [] })
    }), { DB: db });

    assert.equal(response.status, 402);
    const body = await response.json();
    assert.equal(body.error.code, "insufficient_balance");
});

test("gateway deducts wallet balance or increments active subscription usage and sets loop header", async (t) => {
    const db = await fixture();
    const originalFetch = globalThis.fetch;
    let upstreamHopHeader = null;
    globalThis.fetch = async (_url, init) => {
        upstreamHopHeader = init.headers.get("x-sub2api-router-hop");
        return new Response(JSON.stringify({
            id: "chatcmpl-cost",
            model: "gpt-4o-2024-08-06",
            usage: { prompt_tokens: 1000, completion_tokens: 500 }
        }), { status: 200, headers: { "content-type": "application/json" } });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const resp1 = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-2024-08-06", messages: [] })
    }), { DB: db });
    assert.equal(resp1.status, 200);
    assert.equal(upstreamHopHeader, "1");

    // gpt-4o-2024-08-06: input 2.5e-6 * 1000 + output 1e-5 * 500 = 0.0025 + 0.005 = 0.0075
    const userAfterWallet = await db.prepare("SELECT balance FROM users WHERE id = 1").first();
    assert.ok(Math.abs(userAfterWallet.balance - (10 - 0.0075)) < 1e-9);

    // Now set balance = 0 and add an active subscription
    await db.prepare("UPDATE users SET balance = 0 WHERE id = 1").run();
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const groupRes = await db.prepare(`
        INSERT INTO groups (created_at, updated_at, name, platform, rate_multiplier, is_exclusive, status, subscription_type, daily_limit_usd, supported_model_scopes, messages_dispatch_model_config, models_list_config)
        VALUES (?, ?, 'Sub Group', 'openai', 2, 0, 'active', 'subscription', 50, '[]', '{}', '[]')
    `).bind(now, now).run();
    const groupId = Number(groupRes.meta.last_row_id);
    await db.prepare(`
        INSERT INTO user_subscriptions (created_at, updated_at, starts_at, expires_at, status, daily_usage_usd, weekly_usage_usd, monthly_usage_usd, assigned_at, group_id, user_id)
        VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, ?, 1)
    `).bind(now, now, now, future, now, groupId).run();

    const resp2 = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-2024-08-06", messages: [] })
    }), { DB: db });
    assert.equal(resp2.status, 200);

    const subAfter = await db.prepare("SELECT daily_usage_usd, weekly_usage_usd, monthly_usage_usd FROM user_subscriptions WHERE user_id = 1").first();
    // rate_multiplier = 2 -> 0.0075 * 2 = 0.015
    assert.ok(Math.abs(subAfter.daily_usage_usd - 0.015) < 1e-9);
    assert.ok(Math.abs(subAfter.weekly_usage_usd - 0.015) < 1e-9);
    assert.ok(Math.abs(subAfter.monthly_usage_usd - 0.015) < 1e-9);
});

test("gateway handles streaming SSE responses and records usage logs and rate limit windows", async (t) => {
    const db = await fixture();
    const expiredWindow = new Date(Date.now() - 10 * 3600_000).toISOString();
    await db.prepare(`
        UPDATE api_keys SET rate_limit_5h = 1, usage_5h = 1, window_5h_start = ? WHERE key = 'sk-gateway'
    `).bind(expiredWindow).run();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        const sse = [
            `data: {"id":"chatcmpl-stream","model":"gpt-4o-2024-08-06","choices":[{"delta":{"content":"Hello"}}]}`,
            `data: {"id":"chatcmpl-stream","model":"gpt-4o-2024-08-06","usage":{"prompt_tokens":200,"completion_tokens":100}}`,
            `data: [DONE]`,
            ""
        ].join("\n\n");
        return new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
        });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const response = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-2024-08-06", stream: true, messages: [] })
    }), { DB: db });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /chatcmpl-stream/);

    const log = await db.prepare("SELECT input_tokens, output_tokens, stream, actual_cost FROM usage_logs ORDER BY id DESC LIMIT 1").first();
    assert.equal(log.input_tokens, 200);
    assert.equal(log.output_tokens, 100);
    assert.equal(log.stream, 1);
    assert.ok(log.actual_cost > 0);

    const keyAfter = await db.prepare("SELECT usage_5h, window_5h_start FROM api_keys WHERE key = 'sk-gateway'").first();
    assert.ok(Math.abs(keyAfter.usage_5h - log.actual_cost) < 1e-9);
    assert.ok(Date.parse(keyAfter.window_5h_start) > Date.parse(expiredWindow));
});

test("gateway serves GET /v1/usage locally without calling upstream", async () => {
    const db = await fixture();
    const now = new Date().toISOString();
    await db.prepare(`
        INSERT INTO usage_logs (request_id, model, requested_model, upstream_model, input_tokens, output_tokens, total_cost, actual_cost, stream, duration_ms, created_at, api_key_id, account_id, user_id)
        VALUES ('req-1', 'gpt-4.1', 'gpt-4.1', 'gpt-4.1', 120, 80, 0.05, 0.05, 0, 250, ?, 1, 1, 1)
    `).bind(now).run();

    const walletRes = await routeRequest(new Request("https://edge.example/v1/usage", {
        method: "GET",
        headers: { authorization: "Bearer sk-gateway" }
    }), { DB: db });
    assert.equal(walletRes.status, 200);
    const walletData = await walletRes.json();
    assert.equal(walletData.mode, "wallet");
    assert.equal(walletData.balance, 10);
    assert.equal(walletData.usage.total.requests, 1);
    assert.equal(walletData.usage.total.input_tokens, 120);
    assert.equal(walletData.usage.total.output_tokens, 80);
    assert.equal(walletData.model_stats.length, 1);
    assert.equal(walletData.daily_usage.length, 1);

    await db.prepare("UPDATE api_keys SET quota = 50, quota_used = 12.5, rate_limit_5h = 5 WHERE key = 'sk-gateway'").run();
    const quotaRes = await routeRequest(new Request("https://edge.example/v1/usage", {
        method: "GET",
        headers: { authorization: "Bearer sk-gateway" }
    }), { DB: db });
    assert.equal(quotaRes.status, 200);
    const quotaData = await quotaRes.json();
    assert.equal(quotaData.mode, "quota_limited");
    assert.equal(quotaData.quota.limit, 50);
    assert.equal(quotaData.quota.used, 12.5);
    assert.equal(quotaData.quota.remaining, 37.5);
    assert.equal(quotaData.rate_limits.length, 1);
    assert.equal(quotaData.rate_limits[0].window, "5h");
});

test("gateway enforces exclusive group access in querySchedulableAccounts", async (t) => {
    const db = await fixture();
    const now = new Date().toISOString();
    const groupRes = await db.prepare(`
        INSERT INTO groups (created_at, updated_at, name, platform, rate_multiplier, is_exclusive, status, subscription_type, supported_model_scopes, messages_dispatch_model_config, models_list_config)
        VALUES (?, ?, 'Exclusive VIP', 'openai', 1, 1, 'active', 'standard', '[]', '{}', '[]')
    `).bind(now, now).run();
    const exclusiveGroupId = Number(groupRes.meta.last_row_id);

    await db.prepare(`
        INSERT INTO account_groups (priority, created_at, account_id, group_id)
        VALUES (10, ?, 1, ?)
    `).bind(now, exclusiveGroupId).run();

    // User 1 is not in user_allowed_groups -> account 1 should be excluded
    const res1 = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1", messages: [] })
    }), { DB: db });
    assert.equal(res1.status, 503);
    assert.equal((await res1.json()).error.code, "no_available_account");

    // Grant access via user_allowed_groups
    await db.prepare(`
        INSERT INTO user_allowed_groups (created_at, user_id, group_id)
        VALUES (?, 1, ?)
    `).bind(now, exclusiveGroupId).run();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ id: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
    });
    t.after(() => { globalThis.fetch = originalFetch; });

    const res2 = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1", messages: [] })
    }), { DB: db });
    assert.equal(res2.status, 200);
});

async function metadataGroup(db) {
    const now = new Date().toISOString();
    const result = await db.prepare(
        "INSERT INTO groups (created_at, updated_at, name, platform, supported_model_scopes, messages_dispatch_model_config, models_list_config) VALUES (?, ?, 'Metadata group', 'openai', '[]', '{}', '{}')"
    ).bind(now, now).run();
    const groupId = Number(result.meta.last_row_id);
    await db.prepare("UPDATE api_keys SET group_id = ? WHERE id = 1").bind(groupId).run();
    await db.prepare("INSERT INTO account_groups (created_at, account_id, group_id) VALUES (?, 1, ?)").bind(now, groupId).run();
    return groupId;
}

test("usage metadata: accepts both effort formats and trusts only Cloudflare client IP", () => {
    const request = new Request("https://edge.example/responses?secret=not-logged", {
        headers: { "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": "203.0.113.9", "user-agent": "metadata-test" }
    });
    const nested = gatewayLogContext(request, { reasoning: { effort: "high" } });
    assert.equal(nested.reasoningEffort, "high");
    assert.equal(nested.ipAddress, "192.0.2.1");
    assert.equal(nested.inboundEndpoint, "/responses");
    assert.equal(nested.userAgent, "metadata-test");
    assert.equal(gatewayLogContext(request, { reasoning_effort: "low" }).reasoningEffort, "low");
    assert.equal(gatewayLogContext(request, {}).reasoningEffort, null);
    assert.equal(gatewayLogContext(new Request("https://edge.example/v1/responses", {
        headers: { "x-forwarded-for": "203.0.113.9" }
    }), {}).ipAddress, null);
});

test("usage metadata: first output detection ignores role heartbeat and usage", () => {
    assert.equal(hasGatewayOutput({ choices: [{ delta: { role: "assistant", content: "" } }] }), false);
    assert.equal(hasGatewayOutput({ type: "ping" }), false);
    assert.equal(hasGatewayOutput({ usage: { output_tokens: 1 } }), false);
    assert.equal(hasGatewayOutput({ type: "response.created" }), false);
    assert.equal(hasGatewayOutput({ choices: [{ delta: { content: "Hello" } }] }), true);
    assert.equal(hasGatewayOutput({ choices: [{ delta: { reasoning_content: "Think" } }] }), true);
    assert.equal(hasGatewayOutput({ type: "response.output_text.delta", delta: "Hi" }), true);
    assert.equal(hasGatewayOutput({ type: "response.function_call_arguments.delta", delta: "{}" }), true);
    assert.equal(hasGatewayOutput({ type: "content_block_delta", delta: { thinking: "Think" } }), true);
    assert.equal(hasGatewayOutput({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }), true);
});

test("usage metadata: JSON logging restores names and enforces the user scope", async (t) => {
    const db = await fixture();
    const groupId = await metadataGroup(db);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        model: "gpt-4.1", usage: { input_tokens: 100, output_tokens: 50 }
    }), { headers: { "content-type": "application/json" } });
    t.after(() => { globalThis.fetch = originalFetch; });
    const response = await routeRequest(new Request("https://edge.example/responses?secret=not-logged", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json", "cf-connecting-ip": "192.0.2.1", "user-agent": "metadata-test" },
        body: JSON.stringify({ model: "gpt-4.1", reasoning: { effort: "high" }, input: "Hi" })
    }), { DB: db });
    assert.equal(response.status, 200);
    const row = await db.prepare("SELECT * FROM usage_logs").first();
    assert.equal(row.reasoning_effort, "high");
    assert.equal(row.ip_address, "192.0.2.1");
    assert.equal(row.user_agent, "metadata-test");
    assert.equal(row.inbound_endpoint, "/responses");
    assert.equal(row.upstream_endpoint, "/v1/responses");
    assert.equal(row.first_token_ms, null);
    assert.equal(row.group_id, groupId);
    const [admin] = await withUsageMetadata(db, [row], { admin: true });
    assert.equal(admin.api_key.name, "Gateway");
    assert.equal(admin.account.name, "openai-main");
    assert.equal(admin.group.name, "Metadata group");
    assert.equal(admin.user.email, "gateway@example.com");
    const [user] = await withUsageMetadata(db, [{ id: row.id }], { userId: row.user_id });
    assert.equal(user.group.name, "Metadata group");
    assert.equal(user.api_key.name, "Gateway");
    assert.equal(user.account, undefined);
    assert.equal(user.user, undefined);
    assert.equal(JSON.stringify(user).includes("sk-gateway"), false);
    assert.equal(JSON.stringify(admin).includes("upstream-secret"), false);
    assert.deepEqual(await withUsageMetadata(db, [{ id: row.id }], { userId: row.user_id + 1 }), []);
    const total = await db.prepare("SELECT COUNT(*) AS n FROM usage_logs").first();
    assert.equal(total.n, 1);
    const key = await db.prepare("SELECT quota_used FROM api_keys WHERE id = 1").first();
    const balance = await db.prepare("SELECT balance FROM users WHERE id = ?").bind(row.user_id).first();
    assert.ok(row.actual_cost > 0);
    assert.equal(key.quota_used, row.actual_cost);
    assert.ok(Math.abs((10 - balance.balance) - row.actual_cost) < 1e-10);
});

test("usage metadata: SSE stays byte-identical and charges exactly one ledger entry", async (t) => {
    const db = await fixture();
    const originalFetch = globalThis.fetch;
    const wire = [
        'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"model":"gpt-4.1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n',
        'data: [DONE]\n\n'
    ].join("").replaceAll("\\n", "\n");
    globalThis.fetch = async () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
    t.after(() => { globalThis.fetch = originalFetch; });
    const response = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer sk-gateway", "content-type": "application/json", "cf-connecting-ip": "192.0.2.2" },
        body: JSON.stringify({ model: "gpt-4.1", stream: true, reasoning_effort: "low", messages: [] })
    }), { DB: db });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), wire);
    const row = await db.prepare("SELECT * FROM usage_logs").first();
    assert.equal(row.reasoning_effort, "low");
    assert.equal(row.ip_address, "192.0.2.2");
    assert.equal(row.inbound_endpoint, "/v1/chat/completions");
    assert.equal(row.upstream_endpoint, "/v1/chat/completions");
    assert.equal(typeof row.first_token_ms, "number");
    assert.ok(row.first_token_ms >= 0 && row.duration_ms >= row.first_token_ms);
    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 50);
    const total = await db.prepare("SELECT COUNT(*) AS n FROM usage_logs").first();
    assert.equal(total.n, 1);
    const key = await db.prepare("SELECT quota_used FROM api_keys WHERE id = 1").first();
    assert.equal(key.quota_used, row.actual_cost);
});

test("usage metadata: usage-only streams keep first token time and unspecified metadata null", async (t) => {
    const db = await fixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('data: {"model":"gpt-4.1","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":0}}\n\ndata: [DONE]\n\n'.replaceAll("\\n", "\n"), {
        headers: { "content-type": "text/event-stream" }
    });
    t.after(() => { globalThis.fetch = originalFetch; });
    const response = await routeRequest(new Request("https://edge.example/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer sk-gateway", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4.1", stream: true, messages: [] })
    }), { DB: db });
    assert.equal(response.status, 200);
    await response.text();
    const row = await db.prepare("SELECT first_token_ms, reasoning_effort, ip_address FROM usage_logs").first();
    assert.equal(row.first_token_ms, null);
    assert.equal(row.reasoning_effort, null);
    assert.equal(row.ip_address, null);
});
