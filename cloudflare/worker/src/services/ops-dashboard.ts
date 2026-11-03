import type { D1Database, D1Value } from "../types/d1.ts";
import { allRows, firstRow } from "../repositories/d1.ts";
import { OpsError } from "./ops.ts";

const ranges: Record<string, number> = { "5m": 300, "30m": 1800, "1h": 3600, "6h": 21600, "24h": 86400, "1d": 86400, "7d": 604800, "15d": 1296000, "30d": 2592000 };
export function opsWindow(url: URL, now = Date.now()) {
    const p = url.searchParams;
    const end = p.has("end_time") ? Date.parse(p.get("end_time")!) : now;
    const start = p.has("start_time") ? Date.parse(p.get("start_time")!) : end - (ranges[p.get("time_range") ?? p.get("window") ?? "1h"] ?? 3600) * 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 31 * 86400_000) {
        throw new OpsError(400, "INVALID_TIME_RANGE", "Select a valid time window of at most 31 days");
    }
    const group = p.get("group_id");
    const groupId = group ? Number(group) : null;
    if (groupId !== null && (!Number.isSafeInteger(groupId) || groupId <= 0)) throw new OpsError(400, "INVALID_GROUP", "Invalid group_id");
    return { start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), platform: p.get("platform") ?? "", group_id: groupId, start, end };
}
type Window = ReturnType<typeof opsWindow>;
const tokenSQL = "COALESCE(u.input_tokens,0)+COALESCE(u.output_tokens,0)+COALESCE(u.cache_creation_tokens,0)+COALESCE(u.cache_read_tokens,0)";
const eventsSQL = `WITH events AS (
    SELECT u.id, 'success' AS kind, u.created_at, u.request_id, COALESCE(a.platform,'') AS platform,
           COALESCE(u.requested_model,u.model) AS model, u.user_id,u.api_key_id,u.account_id,u.group_id,u.stream,
           u.duration_ms,u.first_token_ms, 200 AS status_code, NULL AS error_id, '' AS phase,'' AS severity,'' AS message,
           0 AS business_limited, 0 AS upstream_status_code, ${tokenSQL} AS tokens, u.output_tokens
    FROM usage_logs u LEFT JOIN accounts a ON a.id=u.account_id
    UNION ALL
    SELECT e.id,'error',e.created_at,e.request_id,COALESCE(e.platform,''),COALESCE(e.requested_model,e.model),
           e.user_id,e.api_key_id,e.account_id,e.group_id,e.stream,e.duration_ms,e.time_to_first_token_ms,
           e.status_code,e.id,e.error_phase,e.severity,e.error_message,e.is_business_limited,COALESCE(e.upstream_status_code,0),0,0
    FROM ops_error_logs e WHERE e.error_phase != 'upstream'
), filtered AS (SELECT * FROM events WHERE julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)
    AND (?='' OR platform=?) AND (? IS NULL OR group_id=?))`;
function values(w: Window): D1Value[] { return [w.start_time,w.end_time,w.platform,w.platform,w.group_id,w.group_id]; }
function publicWindow(w: Window) { return { start_time:w.start_time,end_time:w.end_time,platform:w.platform,group_id:w.group_id }; }
function intParam(url: URL,key: string,fallback: number,max: number) { const n=Number(url.searchParams.get(key)); return Number.isSafeInteger(n)&&n>0?Math.min(n,max):fallback; }
const errorCounts = `SUM(CASE WHEN kind='error' THEN 1 ELSE 0 END) AS error_count_total,
 SUM(CASE WHEN kind='error' AND business_limited=1 THEN 1 ELSE 0 END) AS business_limited_count,
 SUM(CASE WHEN kind='error' AND business_limited=0 THEN 1 ELSE 0 END) AS error_count_sla,
 SUM(CASE WHEN upstream_status_code>0 AND upstream_status_code NOT IN (429,529) THEN 1 ELSE 0 END) AS upstream_error_count_excl_429_529,
 SUM(CASE WHEN upstream_status_code=429 THEN 1 ELSE 0 END) AS upstream_429_count,
 SUM(CASE WHEN upstream_status_code=529 THEN 1 ELSE 0 END) AS upstream_529_count`;
const numericCounts = ["error_count_total","business_limited_count","error_count_sla","upstream_error_count_excl_429_529","upstream_429_count","upstream_529_count"] as const;
function counts(row: Record<string,unknown>) { return Object.fromEntries(numericCounts.map(k=>[k,Number(row[k]??0)])) as Record<typeof numericCounts[number],number>; }

/** Raw D1 queries implement the Vue ops contract; no dependency on an absent aggregation cron. */
export class D1OpsDashboard {
    private readonly db: D1Database;
    constructor(db: D1Database) { this.db = db; }
    async snapshot(url: URL) {
        const w=opsWindow(url);
        const [overview,throughput_trend,error_trend]=await Promise.all([this.overview(w),this.throughput(w),this.errorTrend(w)]);
        return {generated_at:new Date().toISOString(),overview,throughput_trend,error_trend};
    }
    async percentiles(w: Window, column: "duration_ms"|"first_token_ms") {
        const row=await firstRow<Record<string,number|null>>(this.db,eventsSQL+`, ranked AS (
            SELECT ${column} AS v,ROW_NUMBER() OVER (ORDER BY ${column}) AS rn,COUNT(*) OVER () AS n
            FROM filtered WHERE kind='success' AND ${column} IS NOT NULL AND ${column}>=0)
            SELECT AVG(v) AS avg_ms,MAX(v) AS max_ms,
            MIN(CASE WHEN rn>=CAST((n*50+99)/100 AS INTEGER) THEN v END) AS p50_ms,
            MIN(CASE WHEN rn>=CAST((n*90+99)/100 AS INTEGER) THEN v END) AS p90_ms,
            MIN(CASE WHEN rn>=CAST((n*95+99)/100 AS INTEGER) THEN v END) AS p95_ms,
            MIN(CASE WHEN rn>=CAST((n*99+99)/100 AS INTEGER) THEN v END) AS p99_ms FROM ranked`,values(w));
        return row??{};
    }
    async overview(w: Window) {
        const [row,duration,ttft,trend]=await Promise.all([
            firstRow<Record<string,number>>(this.db,eventsSQL+` SELECT COUNT(*) AS request_count_total,
                SUM(CASE WHEN kind='success' THEN 1 ELSE 0 END) AS success_count,SUM(tokens) AS token_consumed,${errorCounts} FROM filtered`,values(w)),
            this.percentiles(w,"duration_ms"),this.percentiles(w,"first_token_ms"),this.throughput(w)
        ]);
        const r=row??{}; const errors=counts(r); const success=Number(r.success_count??0),total=Number(r.request_count_total??0);
        const slaTotal=success+errors.error_count_sla; const tokens=Number(r.token_consumed??0); const seconds=(w.end-w.start)/1000;
        const current=await firstRow<{requests:number;tokens:number}>(this.db,eventsSQL+" SELECT COUNT(*) AS requests,COALESCE(SUM(tokens),0) AS tokens FROM filtered WHERE julianday(created_at)>=julianday(?)",[...values(w),new Date(Math.max(w.start,w.end-60_000)).toISOString()]);
        const currentSeconds=Math.min(60,seconds);
        return {...publicWindow(w),system_metrics:null,job_heartbeats:null,success_count:success,...errors,
            request_count_total:total,request_count_sla:slaTotal,token_consumed:tokens,
            sla:slaTotal?success/slaTotal*100:100,error_rate:total?errors.error_count_total/total*100:0,
            upstream_error_rate:total?(errors.upstream_error_count_excl_429_529+errors.upstream_429_count+errors.upstream_529_count)/total*100:0,
            qps:{current:Number(current?.requests??0)/currentSeconds,peak:Math.max(0,...trend.points.map(p=>p.qps)),avg:total/seconds},
            tps:{current:Number(current?.tokens??0)/currentSeconds,peak:Math.max(0,...trend.points.map(p=>p.tps)),avg:tokens/seconds},duration,ttft};
    }
    bucketSeconds(w: Window) { const span=(w.end-w.start)/1000;return span<=3600?60:span<=21600?300:span<=86400?900:3600; }
    async throughput(w: Window) {
        const step=this.bucketSeconds(w);
        const [rows,by_platform,top_groups]=await Promise.all([
            allRows<{bucket:number;request_count:number;token_consumed:number}>(this.db,eventsSQL+` SELECT CAST(unixepoch(created_at)/${step} AS INTEGER)*${step} AS bucket,COUNT(*) AS request_count,COALESCE(SUM(tokens),0) AS token_consumed FROM filtered GROUP BY bucket ORDER BY bucket`,values(w)),
            allRows(this.db,eventsSQL+" SELECT platform,COUNT(*) AS request_count,COALESCE(SUM(tokens),0) AS token_consumed FROM filtered GROUP BY platform ORDER BY request_count DESC",values(w)),
            allRows(this.db,eventsSQL+" SELECT f.group_id,COALESCE(g.name,'Unknown group') AS group_name,COUNT(*) AS request_count,COALESCE(SUM(f.tokens),0) AS token_consumed FROM filtered f LEFT JOIN groups g ON g.id=f.group_id WHERE f.group_id IS NOT NULL GROUP BY f.group_id ORDER BY request_count DESC LIMIT 10",values(w))
        ]);
        const byBucket=new Map(rows.map(r=>[Number(r.bucket),r]));
        const points=[];
        for(let b=Math.floor(w.start/1000/step)*step;b<w.end/1000;b+=step){
            const r=byBucket.get(b);const seconds=(Math.min((b+step)*1000,w.end)-Math.max(b*1000,w.start))/1000;
            const requests=Number(r?.request_count??0),tokens=Number(r?.token_consumed??0);
            points.push({bucket_start:new Date(b*1000).toISOString(),request_count:requests,token_consumed:tokens,qps:requests/seconds,tps:tokens/seconds});
        }
        return {bucket:step%3600===0?step/3600+"h":step/60+"m",points,by_platform,top_groups};
    }
    async errorTrend(w: Window) {
        const step=this.bucketSeconds(w);
        const rows=await allRows<Record<string,unknown>>(this.db,eventsSQL+` SELECT CAST(unixepoch(created_at)/${step} AS INTEGER)*${step} AS bucket,${errorCounts} FROM filtered GROUP BY bucket ORDER BY bucket`,values(w));
        const byBucket=new Map(rows.map(r=>[Number(r.bucket),r]));const points=[];
        for(let b=Math.floor(w.start/1000/step)*step;b<w.end/1000;b+=step) points.push({bucket_start:new Date(b*1000).toISOString(),...counts(byBucket.get(b)??{})});
        return {bucket:step%3600===0?step/3600+"h":step/60+"m",points};
    }
    async latency(w: Window) {
        const rows=await allRows<{range:string;count:number}>(this.db,eventsSQL+` SELECT
            CASE WHEN duration_ms<1000 THEN '<1s' WHEN duration_ms<5000 THEN '1-5s' WHEN duration_ms<15000 THEN '5-15s' WHEN duration_ms<30000 THEN '15-30s' WHEN duration_ms<60000 THEN '30-60s' ELSE '>=60s' END AS range,COUNT(*) AS count
            FROM filtered WHERE kind='success' AND duration_ms IS NOT NULL GROUP BY range`,values(w));
        const lookup=new Map(rows.map(r=>[r.range,r.count]));const buckets=['<1s','1-5s','5-15s','15-30s','30-60s','>=60s'].map(range=>({range,count:lookup.get(range)??0}));
        return {...publicWindow(w),total_requests:buckets.reduce((n,b)=>n+b.count,0),buckets};
    }
    async distribution(w: Window) {
        const items=await allRows<{status_code:number;total:number;sla:number;business_limited:number}>(this.db,eventsSQL+" SELECT status_code,COUNT(*) AS total,SUM(CASE WHEN business_limited=0 THEN 1 ELSE 0 END) AS sla,SUM(business_limited) AS business_limited FROM filtered WHERE kind='error' GROUP BY status_code ORDER BY total DESC",values(w));
        return {total:items.reduce((n,r)=>n+r.total,0),items};
    }
    async requests(url: URL) {
        const w=opsWindow(url),p=url.searchParams;const conditions:string[]=[],args=values(w);
        for(const key of ['kind','platform','user_id','api_key_id','account_id','model','request_id']) if(p.get(key)&&p.get(key)!=='all'){conditions.push(key+'=?');args.push(p.get(key)!);}
        for(const [key,op] of [['min_duration_ms','>='],['max_duration_ms','<=']]) if(p.has(key)&&Number.isFinite(Number(p.get(key)))) {conditions.push('duration_ms'+op+'?');args.push(Number(p.get(key)));}
        if(p.get('q')) {conditions.push('(request_id LIKE ? OR model LIKE ?)');args.push('%'+p.get('q')+'%','%'+p.get('q')+'%');}
        const where=conditions.length?' WHERE '+conditions.join(' AND '):'';const page=intParam(url,'page',1,100000),page_size=intParam(url,'page_size',20,100);
        const [total,items]=await Promise.all([
            firstRow<{n:number}>(this.db,eventsSQL+' SELECT COUNT(*) AS n FROM filtered'+where,args),
            allRows(this.db,eventsSQL+' SELECT kind,created_at,request_id,platform,model,duration_ms,status_code,error_id,phase,severity,message,user_id,api_key_id,account_id,group_id,stream FROM filtered'+where+(p.get('sort')==='duration_desc'?' ORDER BY duration_ms DESC,id DESC':' ORDER BY julianday(created_at) DESC,id DESC')+' LIMIT ? OFFSET ?',[...args,page_size,(page-1)*page_size])
        ]);
        return {items,total:total?.n??0,page,page_size,pages:Math.ceil((total?.n??0)/page_size)};
    }
    async systemLogs(url: URL) {
        const w=opsWindow(url),p=url.searchParams;const conditions=['julianday(created_at)>=julianday(?)','julianday(created_at)<julianday(?)'];const args:D1Value[]=[w.start_time,w.end_time];
        for(const key of ['host','level','component','request_id','client_request_id','user_id','api_key_id','account_id','platform','model']) if(p.get(key)){conditions.push(key+'=?');args.push(p.get(key)!);}
        if(p.get('q')) {conditions.push('(message LIKE ? OR request_id LIKE ?)');args.push('%'+p.get('q')+'%','%'+p.get('q')+'%');}
        const where=' WHERE '+conditions.join(' AND '),page=intParam(url,'page',1,100000),page_size=intParam(url,'page_size',20,100);
        const [total,rows]=await Promise.all([
            firstRow<{n:number}>(this.db,'SELECT COUNT(*) AS n FROM ops_system_logs'+where,args),
            allRows<Record<string,unknown>>(this.db,'SELECT * FROM ops_system_logs'+where+' ORDER BY julianday(created_at) DESC,id DESC LIMIT ? OFFSET ?',[...args,page_size,(page-1)*page_size])
        ]);
        const items=rows.map(row=>{let extra={};try{extra=JSON.parse(String(row.extra??'{}'));}catch{}return {...row,extra};});
        return {items,total:total?.n??0,page,page_size,pages:Math.ceil((total?.n??0)/page_size)};
    }
    async logHealth() {
        const row=await firstRow<{n:number}>(this.db,'SELECT COUNT(*) AS n FROM ops_system_logs');
        // D1 writes are synchronous. There is no process-local queue or durable drop counter.
        return {queue_depth:null,queue_capacity:null,dropped_count:null,write_failed_count:null,written_count:row?.n??0,avg_write_delay_ms:null};
    }
    async openaiTokens(url: URL) {
        const w=opsWindow(url);if(!w.platform)w.platform='openai';
        const page=intParam(url,'page',1,100000),page_size=intParam(url,'page_size',20,100),top_n=intParam(url,'top_n',100,100);
        const items=await allRows(this.db,eventsSQL+` SELECT model,COUNT(*) AS request_count,SUM(output_tokens) AS total_output_tokens,AVG(duration_ms) AS avg_duration_ms,
            AVG(first_token_ms) AS avg_first_token_ms,COUNT(first_token_ms) AS requests_with_first_token,
            AVG(CASE WHEN duration_ms>COALESCE(first_token_ms,0) THEN output_tokens*1000.0/(duration_ms-COALESCE(first_token_ms,0)) END) AS avg_tokens_per_sec
            FROM filtered WHERE kind='success' GROUP BY model ORDER BY request_count DESC LIMIT ? OFFSET ?`,[...values(w),Math.min(page_size,top_n),(page-1)*page_size]);
        const total=await firstRow<{n:number}>(this.db,eventsSQL+" SELECT COUNT(DISTINCT model) AS n FROM filtered WHERE kind='success'",values(w));
        return {...publicWindow(w),time_range:url.searchParams.get('time_range')??'1h',items,total:total?.n??0,page,page_size,top_n};
    }
}
