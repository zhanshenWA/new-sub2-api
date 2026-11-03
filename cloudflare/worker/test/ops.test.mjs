import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { routeRequest } from "../src/index.ts";
import { legacyTokenVersion } from "../src/utils/crypto.ts";
import { Hs256JwtSigner } from "../src/services/jwt.ts";
import { SQLiteD1Database } from "./sqlite-d1.mjs";

const migrations = await Promise.all([
    "0001_ent_core.sql", "0002_business_supplemental.sql", "0003_ops_usage_supplemental.sql", "0004_runtime_state.sql", "0005_auth_sessions.sql"
].map((n) => readFile(new URL(`../../d1/migrations/${n}`, import.meta.url), "utf8")));

const JWT_SECRET = "ops-test-secret-32-bytes-long-abc";
const PASSWORD_HASH = "$2b$10$nOUIs5kJ7naTuTFkBy1veuK0kSxUFXfuaOKdOKf9xYT0KKIGSJwFa";
const BASE = "https://edge.example";

function db() { const d = new SQLiteD1Database(); for (const m of migrations) d.exec(m); return d; }
function env(d) { return { DB: d, JWT_SECRET, JWT_ACCESS_TOKEN_EXPIRES_SECONDS: "3600", JWT_REFRESH_TOKEN_EXPIRE_DAYS: "30" }; }

async function insAdmin(d) {
    const r = await d.prepare(`INSERT INTO users (created_at,updated_at,email,password_hash,role,status,username,totp_enabled,totp_secret_encrypted,signup_source,token_version) VALUES(?,?,?,?,?,?,?,?,?,?,0)`).bind("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", "admin@x.com", PASSWORD_HASH, "admin", "active", "admin", 0, null, "email").run();
    return Number(r.meta?.last_row_id);
}

async function insUser(d, email, username) {
    const r = await d.prepare(`INSERT INTO users (created_at,updated_at,email,password_hash,role,status,username,token_version,balance) VALUES(?,?,?,?,?,?,?,?,?)`).bind("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", email, PASSWORD_HASH, "user", "active", username, 0, 10.0).run();
    return Number(r.meta.last_row_id);
}

async function token(d, uid, email, role) {
    const signer = new Hs256JwtSigner(JWT_SECRET, 604800);
    const tv = await legacyTokenVersion(email, PASSWORD_HASH, 0n);
    const s = await signer.sign({ id: uid, email, role, tokenVersion: tv });
    return s.token;
}

const P = "/api/v1/admin/ops";

test("admin ops", async (t) => {
    await t.test("GET /ops/concurrency returns stats", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/concurrency`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.equal(j.data.enabled, false);
        assert.deepEqual(j.data.platform, {});
    });

    await t.test("GET /ops/user-concurrency returns list", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/user-concurrency`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.deepEqual(j.data.user, {});
    });

    await t.test("GET /ops/account-availability returns list", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/account-availability`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.equal(j.data.enabled, false);
    });

    await t.test("GET /ops/realtime-traffic returns summary", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/realtime-traffic`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.equal(typeof j.data.summary.qps.current, "number");
    });

    await t.test("GET /ops/alert-rules returns list", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/alert-rules`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(j.data));
    });

    await t.test("POST /ops/alert-rules creates rule", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/alert-rules`, {
            method: "POST", headers: { authorization: `Bearer ${tk}`, "content-type": "application/json" },
            body: JSON.stringify({ name: "Test Rule", metric_type: "error_rate", operator: ">", threshold: 5, window_minutes: 5, sustained_minutes: 5, severity: "P1" })
        }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.equal(typeof j.data.id, "number");
    });

    await t.test("POST /ops/alert-rules missing name returns 400", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/alert-rules`, {
            method: "POST", headers: { authorization: `Bearer ${tk}`, "content-type": "application/json" },
            body: JSON.stringify({ metric_type: "error_rate", operator: ">", threshold: 5 })
        }), env(d));
        assert.equal(r.status, 400);
    });

    await t.test("GET /ops/alert-events returns list", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/alert-events`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(j.data));
    });

    await t.test("POST /ops/alert-silences creates silence", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/alert-silences`, {
            method: "POST", headers: { authorization: `Bearer ${tk}`, "content-type": "application/json" },
            body: JSON.stringify({ rule_id: 1, until: "2026-12-31T23:59:59.000Z", filters: "{}" })
        }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.equal(typeof j.data.id, "number");
    });

    await t.test("GET /ops/email-notification/config returns config", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/email-notification/config`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        assert.equal(r.status, 200);
    });

    await t.test("GET /ops/runtime/alert returns settings", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/runtime/alert`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        assert.equal(r.status, 200);
    });

    await t.test("GET /ops/runtime/logging returns config", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/runtime/logging`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        assert.equal(r.status, 200);
    });

    await t.test("POST /ops/runtime/logging/reset returns success", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/runtime/logging/reset`, { method: "POST", headers: { authorization: `Bearer ${tk}` } }), env(d));
        assert.equal(r.status, 200);
    });

    await t.test("GET /ops/advanced-settings returns settings", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/advanced-settings`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        assert.equal(r.status, 200);
    });

    await t.test("GET /ops/settings/metric-thresholds returns thresholds", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/settings/metric-thresholds`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        assert.equal(r.status, 200);
    });

    await t.test("GET /ops/errors returns list", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/errors`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(j.data.items));
    });

    await t.test("GET /ops/request-errors returns list", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/request-errors`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(j.data.items));
    });

    await t.test("GET /ops/upstream-errors returns list", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/upstream-errors`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(j.data.items));
    });

    await t.test("GET /ops/requests returns list", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/requests`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(j.data.items));
    });

    await t.test("GET /ops/system-logs returns list", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/system-logs`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(j.data.items));
    });

    await t.test("POST /ops/system-logs/cleanup returns result", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/system-logs/cleanup`, {
            method: "POST", headers: { authorization: `Bearer ${tk}`, "content-type": "application/json" },
            body: JSON.stringify({ before_date: "2026-01-01T00:00:00.000Z" })
        }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.equal(typeof j.data.deleted, "number");
    });

    await t.test("GET /ops/system-logs/health returns health", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/system-logs/health`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        const j = await r.json();
        assert.equal(r.status, 200);
        assert.equal(typeof j.data.written_count, "number");
    });

    await t.test("GET /ops/dashboard/snapshot-v2 returns snapshot", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/dashboard/snapshot-v2`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        assert.equal(r.status, 200);
    });

    await t.test("GET /ops/dashboard/overview returns overview", async () => {
        const d = db(); const aid = await insAdmin(d); const tk = await token(d, aid, "admin@x.com", "admin");
        const r = await routeRequest(new Request(`${BASE}${P}/dashboard/overview`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        assert.equal(r.status, 200);
    });

    await t.test("without auth returns 401", async () => {
        const d = db();
        const r = await routeRequest(new Request(`${BASE}${P}/concurrency`), env(d));
        assert.equal(r.status, 401);
    });

    await t.test("non-admin returns 403", async () => {
        const d = db(); const uid = await insUser(d, "user@test.com", "user"); const tk = await token(d, uid, "user@test.com", "user");
        const r = await routeRequest(new Request(`${BASE}${P}/concurrency`, { headers: { authorization: `Bearer ${tk}` } }), env(d));
        assert.equal(r.status, 403);
    });
});
