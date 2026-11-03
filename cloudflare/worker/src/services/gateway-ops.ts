import type { D1Database } from "../types/d1.ts";
import { runStatement } from "../repositories/d1.ts";

export interface GatewayOpsEvent {
    requestId: string;
    startedAt: number;
    userId?: number;
    apiKeyId?: number;
    groupId?: number | null;
    accountId?: number;
    platform?: string;
    model?: string;
    stream?: boolean;
    upstreamStatus?: number;
    requestPath?: string;
}

/** Whitelist only metadata. Never persist credentials, bodies or upstream error text. */
export async function recordGatewayOpsError(db: D1Database, event: GatewayOpsEvent, status: number): Promise<void> {
    const now = new Date().toISOString();
    const businessLimited = [400,401,402,403,404,413,422,429].includes(status) && !event.upstreamStatus;
    const message = 'Gateway request failed (HTTP ' + status + ')';
    try {
        const results = await db.batch([
            db.prepare(`INSERT INTO ops_error_logs (request_id,user_id,api_key_id,account_id,group_id,platform,model,request_path,stream,error_phase,error_type,severity,status_code,is_business_limited,error_message,error_source,error_owner,upstream_status_code,duration_ms,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,'request',?,'P2',?,?,?,?,?,?,?,?)`).bind(
                event.requestId,event.userId??null,event.apiKeyId??null,event.accountId??null,event.groupId??null,event.platform??null,event.model??null,event.requestPath??null,event.stream?1:0,
                businessLimited?'business_limit':'gateway_error',status,businessLimited?1:0,message,event.upstreamStatus?'upstream_http':'gateway',event.upstreamStatus?'provider':businessLimited?'client':'platform',event.upstreamStatus??null,Math.max(0,Date.now()-event.startedAt),now),
            db.prepare(`INSERT INTO ops_system_logs (created_at,level,component,message,request_id,user_id,api_key_id,account_id,platform,model,host,extra)
                VALUES (?,'error','gateway',?,?,?,?,?,?,?,'cloudflare-worker',?)`).bind(now,message,event.requestId,event.userId??null,event.apiKeyId??null,event.accountId??null,event.platform??null,event.model??null,JSON.stringify({status_code:status,upstream_status_code:event.upstreamStatus??null}))
        ]);
        if (results.some(r=>!r.success)) throw new Error('Ops write failed');
    } catch {
        // Observability failure must not alter the response or billing outcome.
        console.error('Gateway ops error event could not be persisted');
    }
}

export async function recordGatewayOpsSuccess(db: D1Database, event: GatewayOpsEvent): Promise<void> {
    try {
        await runStatement(db,`INSERT INTO ops_system_logs (created_at,level,component,message,request_id,user_id,api_key_id,account_id,platform,model,host,extra)
            VALUES (?,'info','gateway','Gateway usage committed',?,?,?,?,?,?,'cloudflare-worker',?)`,[
            new Date().toISOString(),event.requestId,event.userId??null,event.apiKeyId??null,event.accountId??null,event.platform??null,event.model??null,
            JSON.stringify({duration_ms:Math.max(0,Date.now()-event.startedAt),stream:Boolean(event.stream)})
        ]);
    } catch { console.error('Gateway ops success event could not be persisted'); }
}
