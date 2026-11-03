import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { SQLiteD1Database } from "./sqlite-d1.mjs";
import { D1OpsDashboard, opsWindow } from "../src/services/ops-dashboard.ts";
import { recordGatewayOpsError, recordGatewayOpsSuccess } from "../src/services/gateway-ops.ts";
const migrations=await Promise.all(["0001_ent_core.sql","0002_business_supplemental.sql","0003_ops_usage_supplemental.sql"].map(n=>readFile(new URL('../../d1/migrations/'+n,import.meta.url),'utf8')));
function fixture(){
 const db=new SQLiteD1Database();for(const sql of migrations)db.exec(sql);
 db.exec(`
 INSERT INTO users(id,created_at,updated_at,email,password_hash,balance) VALUES(1,'2026-11-03','2026-11-03','ops@example.test','unused',10);
 INSERT INTO groups(id,created_at,updated_at,name,platform,supported_model_scopes,messages_dispatch_model_config,models_list_config) VALUES
 (1,'2026-11-03','2026-11-03','DeepSeek','deepseek','[]','{}','{}'),(2,'2026-11-03','2026-11-03','OpenAI','openai','[]','{}','{}');
 INSERT INTO accounts(id,created_at,updated_at,name,platform,type,credentials,extra) VALUES
 (1,'2026-11-03','2026-11-03','DS','deepseek','apikey','{}','{}'),(2,'2026-11-03','2026-11-03','OA','openai','apikey','{}','{}');
 INSERT INTO api_keys(id,created_at,updated_at,key,name,user_id,group_id) VALUES(1,'2026-11-03','2026-11-03','test-key-never-log','test',1,1);
 INSERT INTO usage_logs(request_id,model,input_tokens,output_tokens,duration_ms,first_token_ms,created_at,api_key_id,account_id,group_id,user_id) VALUES
 ('a','deepseek-chat',100,20,1000,100,'2026-11-03T00:10:00.000Z',1,1,1,1),
 ('b','gpt-4.1',200,40,3000,300,'2026-11-03T00:20:00.000Z',1,2,2,1),
 ('c','deepseek-chat',50,10,9000,NULL,'2026-11-03 00:05:00',1,1,1,1),
 ('end-exclusive','deepseek-chat',500,500,99999,NULL,'2026-11-03T01:00:00.000Z',1,1,1,1);
 `);return db;
}
const url=(extra='')=>new URL('https://test.example/api/v1/admin/ops/dashboard/snapshot-v2?start_time=2026-11-03T00:00:00.000Z&end_time=2026-11-03T01:00:00.000Z'+extra);

test('ops dashboard: real usage produces complete snapshot without aggregate cron',async()=>{
 const d=fixture(),svc=new D1OpsDashboard(d),data=await svc.snapshot(url());
 assert.equal(data.overview.success_count,3);assert.equal(data.overview.token_consumed,420);
 assert.equal(data.overview.duration.p50_ms,3000);assert.equal(data.overview.duration.p99_ms,9000);
 assert.equal(data.overview.ttft.avg_ms,200);assert.equal(data.overview.system_metrics,null);
 assert.equal(data.throughput_trend.points.reduce((n,p)=>n+p.request_count,0),3);
 assert.equal(data.throughput_trend.points.reduce((n,p)=>n+p.token_consumed,0),420);
 assert.equal(data.throughput_trend.points.some(p=>'switch_count' in p),false);
 assert.equal((await d.prepare('SELECT COUNT(*) AS n FROM ops_metrics_hourly').first()).n,0);
});

test('ops dashboard: platform group and exclusive UTC range filter the same ledger',async()=>{
 const svc=new D1OpsDashboard(fixture());
 const ds=await svc.snapshot(url('&platform=deepseek&group_id=1'));
 assert.equal(ds.overview.success_count,2);assert.equal(ds.overview.token_consumed,180);
 assert.equal(ds.throughput_trend.top_groups[0].group_name,'DeepSeek');
 const mismatch=await svc.snapshot(url('&platform=openai&group_id=1'));
 assert.equal(mismatch.overview.request_count_total,0);
 const histogram=await svc.latency(opsWindow(url('&platform=openai&group_id=2')));
 assert.equal(histogram.total_requests,1);assert.equal(histogram.buckets.reduce((n,b)=>n+b.count,0),1);
 await assert.rejects(()=>svc.snapshot(url('&group_id=abc')),e=>e.status===400);
 assert.throws(()=>opsWindow(new URL('https://x/?start_time=invalid')),e=>e.status===400);
});

test('ops dashboard: final upstream error counted once in SLA trend and distribution',async()=>{
 const d=fixture();
 await d.prepare(`INSERT INTO ops_error_logs(request_id,created_at,error_phase,error_type,status_code,upstream_status_code,platform,group_id) VALUES('e','2026-11-03T00:30:00.000Z','request','upstream',502,429,'openai',2)`).run();
 const svc=new D1OpsDashboard(d),data=await svc.snapshot(url());
 assert.equal(data.overview.request_count_total,4);assert.equal(data.overview.error_count_total,1);
 assert.equal(data.overview.sla,75);assert.equal(data.overview.upstream_429_count,1);
 assert.equal(data.error_trend.points.reduce((n,p)=>n+p.error_count_total,0),1);
 assert.deepEqual(await svc.distribution(opsWindow(url())),{total:1,items:[{status_code:502,total:1,sla:1,business_limited:0}]});
});

test('ops dashboard: request drilldown paginates successes and honors duration filters',async()=>{
 const svc=new D1OpsDashboard(fixture());
 const data=await svc.requests(url('&page_size=1&sort=duration_desc&min_duration_ms=2000'));
 assert.equal(data.total,2);assert.equal(data.items.length,1);assert.equal(data.items[0].request_id,'c');
 const oa=await svc.openaiTokens(url('&platform=openai'));
 assert.equal(oa.total,1);assert.equal(oa.items[0].model,'gpt-4.1');assert.equal(oa.items[0].total_output_tokens,40);
});

test('ops dashboard: sanitized events appear in system logs without touching balances',async()=>{
 const d=fixture(),event={requestId:'new-event',startedAt:Date.now()-100,userId:1,apiKeyId:1,groupId:1,accountId:1,platform:'deepseek',model:'deepseek-chat',requestPath:'/v1/chat/completions'};
 await recordGatewayOpsError(d,event,503);
 await recordGatewayOpsSuccess(d,{...event,requestId:'success-event',platform:undefined});
 const svc=new D1OpsDashboard(d),data=await svc.systemLogs(new URL('https://x/?time_range=1h&platform=deepseek&page_size=1'));
 assert.equal(data.total,2);assert.equal(data.items.length,1);assert.equal(typeof data.items[0].extra,'object');
 assert.equal((await svc.logHealth()).written_count,2);assert.equal((await svc.logHealth()).dropped_count,null);
 assert.equal((await d.prepare('SELECT balance FROM users WHERE id=1').first()).balance,10);
 assert.equal((await d.prepare('SELECT COUNT(*) AS n FROM usage_logs').first()).n,4);
 const rows=await d.prepare('SELECT * FROM ops_system_logs').all();assert.equal(JSON.stringify(rows).includes('test-key-never-log'),false);
 assert.equal((await d.prepare('SELECT COUNT(*) AS n FROM ops_error_logs').first()).n,1);
});

test('ops dashboard: logging failure does not fail a completed gateway response',async()=>{
 const db={prepare(){throw new Error('D1 unavailable');},batch(){throw new Error('D1 unavailable');}};
 await assert.doesNotReject(()=>recordGatewayOpsError(db,{requestId:'x',startedAt:Date.now()},500));
 await assert.doesNotReject(()=>recordGatewayOpsSuccess(db,{requestId:'x',startedAt:Date.now()}));
});
