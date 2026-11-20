import { ContributionError } from "./project-contributions";
import { normalizeEndpoint } from "./kr-data-sync";

export type KrSourceMode = "api" | "projects";
export type KrSourceSettings = {
  keyResult: { id: string; title: string; progress: number };
  mode: KrSourceMode | null;
  performanceConfigured?: boolean;
  revision: string;
  metric: { startingValue: number; currentValue: number; targetValue: number; unit: string } | null;
  api: { name: string; endpointUrl: string; valuePath: string; baselineValue: number; targetValue: number; unit: string; cadence: string; active: boolean } | null;
  projects: { id: string; title: string; status: string; defaultValue: number | null; actualValue: number | null; applied: boolean; schedule?:{mode:string;amount:number;accruedValue:number} | null }[];
};
export type KrMetricSummary = { keyResultId: string; mode: KrSourceMode | "manual" | null; currentValue: number | null; targetValue: number | null; unit: string; progress: number; isEstimate?:boolean; performance?:boolean; trend?:import("./kr-performance-model").PerformanceResult["points"] };
type Row = Record<string, string | number | null>;
const children = `SELECT p.id,p.title,p.status,p.updated_at,c.id AS config_id,c.version AS config_version,c.kr_item_id,
 c.default_value,c.actual_value,c.applied,c.enabled,s.mode AS schedule_mode,s.amount AS schedule_amount,s.accrued_value AS schedule_value
 FROM items p JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id
 LEFT JOIN project_contributions c ON c.owner_id=p.owner_id AND c.project_id=p.id
 LEFT JOIN project_metric_schedules s ON s.owner_id=p.owner_id AND s.project_id=p.id AND s.kr_item_id=i.parent_id
 WHERE p.owner_id=? AND i.parent_id=? AND i.kind='initiative' AND i.archived_at IS NULL
 AND p.kind='project' AND p.archived_at IS NULL ORDER BY p.id`;

async function snapshot(db: D1Database, ownerId: string, id: string) {
  const kr=await db.prepare("SELECT id,title,progress,updated_at FROM items WHERE owner_id=? AND id=? AND kind='key_result' AND archived_at IS NULL").bind(ownerId,id).first<Row>();
  if(!kr)throw new ContributionError("key_result_not_found",404);
  const [m,a,p]=await Promise.all([
    db.prepare(`SELECT m.*,m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0) AS current_value FROM kr_project_metrics m WHERE owner_id=? AND kr_item_id=?`).bind(ownerId,id).first<Row>(),
    db.prepare("SELECT * FROM kr_data_connections WHERE owner_id=? AND kr_item_id=?").bind(ownerId,id).first<Row>(),
    db.prepare(children).bind(ownerId,id).all<Row>(),
  ]);
  const stamp=JSON.stringify([kr,m,a,p.results]);
  const revision=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stamp))),n=>n.toString(16).padStart(2,"0")).join("");
  return {kr,m,a,projects:p.results,revision};
}
function settings(s: Awaited<ReturnType<typeof snapshot>>): KrSourceSettings {
  const {kr,m,a}=s;
  return {keyResult:{id:String(kr.id),title:String(kr.title),progress:Number(kr.progress)},revision:s.revision,
    mode:m?.active===1?"projects":a?"api":null,
    metric:m?{startingValue:Number(m.starting_value),currentValue:Number(m.current_value),targetValue:Number(m.target_value),unit:String(m.unit)}:null,
    api:a?{name:String(a.name),endpointUrl:String(a.endpoint_url),valuePath:String(a.value_path),baselineValue:Number(a.baseline_value),targetValue:Number(a.target_value),unit:String(a.unit),cadence:String(a.cadence),active:Boolean(a.active)}:null,
    projects:s.projects.map(p=>({id:String(p.id),title:String(p.title),status:String(p.status),defaultValue:p.enabled===1&&p.kr_item_id===kr.id?Number(p.default_value):null,actualValue:p.kr_item_id===kr.id&&p.actual_value!==null?Number(p.actual_value):null,applied:p.kr_item_id===kr.id&&Boolean(p.applied),schedule:p.schedule_mode?{mode:String(p.schedule_mode),amount:Number(p.schedule_amount),accruedValue:Number(p.schedule_value)}:null})),
  };
}
export async function readKrSource(db: D1Database, ownerId: string, id: string) { return settings(await snapshot(db,ownerId,id)); }
export async function listKrMetricSummaries(db: D1Database, ownerId: string): Promise<KrMetricSummary[]> {
  const rows=await db.prepare(`SELECT k.id,k.progress,m.active,m.starting_value,m.target_value,m.unit,a.id AS api_id,a.last_value,a.target_value AS api_target,a.unit AS api_unit,
    EXISTS(SELECT 1 FROM project_metric_schedules s WHERE s.owner_id=k.owner_id AND s.kr_item_id=k.id AND json_array_length(s.credit_dates_json)>0) AS is_estimate,
    coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=k.owner_id AND c.kr_item_id=k.id AND c.applied=1),0)+coalesce((SELECT sum(accrued_value) FROM project_metric_schedules s WHERE s.owner_id=k.owner_id AND s.kr_item_id=k.id),0) AS earned
    FROM items k LEFT JOIN kr_project_metrics m ON m.owner_id=k.owner_id AND m.kr_item_id=k.id
    LEFT JOIN kr_data_connections a ON a.owner_id=k.owner_id AND a.kr_item_id=k.id
    WHERE k.owner_id=? AND k.kind='key_result' AND k.archived_at IS NULL`).bind(ownerId).all<Row>();
  return rows.results.map(r=>({keyResultId:String(r.id),mode:r.active===1?"projects":r.api_id?"api":null,
    currentValue:r.active===1?Number(r.starting_value)+Number(r.earned):r.api_id&&r.last_value!==null?Number(r.last_value):null,
    targetValue:r.active===1?Number(r.target_value):r.api_id?Number(r.api_target):null,unit:String(r.active===1?r.unit:r.api_unit??""),progress:Number(r.progress),isEstimate:r.active===1&&Boolean(r.is_estimate)}));
}
function numeric(v:unknown,positive=false) {
  if(typeof v!=="number"||!Number.isFinite(v)||v<0||v>1e12||(positive&&v===0))throw new ContributionError("invalid_contribution",400);
  return v;
}
function apiNumeric(v:unknown) {
  if(typeof v!=="number"||!Number.isFinite(v))throw new ContributionError("invalid_contribution",400);
  return v;
}
function text(v:unknown,max=500) {
  if(typeof v!=="string"||v.trim().length>max)throw new ContributionError("invalid_contribution",400);
  return v.trim();
}
export async function saveKrSource(db: D1Database, ownerId: string, userId: string, id: string, input: Record<string,unknown>) {
  const s=await snapshot(db,ownerId,id),{m,a}=s;
  if(input.revision!==s.revision)throw new ContributionError("contribution_conflict");
  if(input.mode!=="projects"&&input.mode!=="api")throw new ContributionError("invalid_contribution",400);
  const mode=input.mode,guard=crypto.randomUUID(),now=new Date().toISOString();
  const projectStamp=JSON.stringify(s.projects.map(p=>({id:p.id,updated:p.updated_at,config:p.config_id,version:p.config_version})));
  const statements=[db.prepare(`INSERT INTO project_contribution_guards(id,valid) SELECT ?,CASE WHEN
    EXISTS(SELECT 1 FROM items WHERE owner_id=? AND id=? AND kind='key_result' AND archived_at IS NULL AND updated_at IS ?)
    AND coalesce((SELECT version FROM kr_project_metrics WHERE owner_id=? AND kr_item_id=?),0)=?
    AND coalesce((SELECT id FROM kr_project_metrics WHERE owner_id=? AND kr_item_id=?),'')=?
    AND coalesce((SELECT id FROM kr_data_connections WHERE owner_id=? AND kr_item_id=?),'')=?
    AND (SELECT updated_at FROM kr_data_connections WHERE owner_id=? AND kr_item_id=?) IS ?
    AND (SELECT count(*) FROM (${children}))=json_array_length(?)
    AND NOT EXISTS(SELECT 1 FROM (${children}) p WHERE NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE
      json_extract(j.value,'$.id')=p.id AND json_extract(j.value,'$.updated') IS p.updated_at
      AND json_extract(j.value,'$.config') IS p.config_id AND json_extract(j.value,'$.version') IS p.config_version))
    THEN 1 ELSE 0 END`).bind(guard,ownerId,id,s.kr.updated_at,ownerId,id,m?.version??0,ownerId,id,m?.id??"",ownerId,id,a?.id??"",ownerId,id,a?.updated_at??null,ownerId,id,projectStamp,ownerId,id,projectStamp)];
  if(mode==="projects") {
    const starting=numeric(input.startingValue),target=numeric(input.targetValue,true),unit=text(input.unit,24);
    if(!Array.isArray(input.projects)||input.projects.length!==s.projects.length)throw new ContributionError("invalid_contribution",400);
    const defaults=new Map<string,number|null>();
    for(const row of input.projects) {
      if(!row||typeof row!=="object"||typeof row.id!=="string"||defaults.has(row.id)||!s.projects.some(p=>p.id===row.id))throw new ContributionError("invalid_contribution",400);
      defaults.set(row.id,row.defaultValue===null?null:numeric(row.defaultValue));
    }
    statements.push(db.prepare("UPDATE kr_data_connections SET active=0,next_sync_at=NULL,updated_at=? WHERE owner_id=? AND kr_item_id=?").bind(now,ownerId,id));
    statements.push(db.prepare(`INSERT INTO kr_project_metrics(id,owner_id,kr_item_id,starting_value,target_value,unit,active,created_at,updated_at)
      VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(owner_id,kr_item_id) DO UPDATE SET starting_value=excluded.starting_value,target_value=excluded.target_value,unit=excluded.unit,active=1,version=kr_project_metrics.version+1,updated_at=excluded.updated_at`).bind(m?.id??crypto.randomUUID(),ownerId,id,starting,target,unit,now,now));
    for(const p of s.projects) {
      const value=defaults.get(String(p.id));
      if(value===null) {
        if(p.config_id)statements.push(db.prepare("UPDATE project_contributions SET enabled=0,version=version+1,updated_at=? WHERE owner_id=? AND project_id=?").bind(now,ownerId,p.id));
      } else statements.push(db.prepare(`INSERT INTO project_contributions(id,owner_id,project_id,kr_item_id,default_value,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(owner_id,project_id) DO UPDATE SET kr_item_id=excluded.kr_item_id,default_value=excluded.default_value,enabled=1,version=project_contributions.version+1,updated_at=excluded.updated_at`).bind(p.config_id??crypto.randomUUID(),ownerId,p.id,id,value,now,now));
    }
  } else {
    if(!input.api||typeof input.api!=="object")throw new ContributionError("invalid_contribution",400);
    const api=input.api as Record<string,unknown>,name=text(api.name,120),unit=text(api.unit,24),path=text(api.valuePath),baseline=apiNumeric(api.baselineValue),target=apiNumeric(api.targetValue);
    let endpoint:string;try{endpoint=normalizeEndpoint(text(api.endpointUrl,4000));}catch{throw new ContributionError("invalid_data_endpoint",400);}
    if(!name||baseline===target||!["hourly","daily","weekly","manual"].includes(String(api.cadence))||typeof api.active!=="boolean")throw new ContributionError("invalid_contribution",400);
    statements.push(db.prepare("UPDATE kr_project_metrics SET active=0,version=version+1,updated_at=? WHERE owner_id=? AND kr_item_id=?").bind(now,ownerId,id));
    statements.push(db.prepare(`INSERT INTO kr_data_connections(id,owner_id,kr_item_id,name,endpoint_url,value_path,baseline_value,target_value,unit,cadence,active,next_sync_at,created_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,kr_item_id) DO UPDATE SET name=excluded.name,endpoint_url=excluded.endpoint_url,value_path=excluded.value_path,baseline_value=excluded.baseline_value,target_value=excluded.target_value,unit=excluded.unit,cadence=excluded.cadence,active=excluded.active,next_sync_at=excluded.next_sync_at,updated_at=excluded.updated_at`)
      .bind(a?.id??crypto.randomUUID(),ownerId,id,name,endpoint,path,baseline,target,unit,api.cadence,Number(api.active),api.active&&api.cadence!=="manual"?now:null,userId,now,now));
    // Reuse the last observed API value immediately; changing sources never invents a sample.
    const last=a?.endpoint_url===endpoint&&a?.value_path===path?a.last_value:null;
    statements.push(db.prepare("UPDATE kr_data_connections SET last_value=?,last_sync_status=?,last_error='' WHERE owner_id=? AND kr_item_id=?").bind(last,last===null?"never":a?.last_sync_status??"never",ownerId,id));
    statements.push(db.prepare("UPDATE items SET progress=?,updated_at=? WHERE owner_id=? AND id=?").bind(last===null?0:Math.max(0,Math.min(100,Math.round((Number(last)-baseline)/(target-baseline)*100))),now,ownerId,id));
    statements.push(db.prepare(`INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) VALUES(?,?,?,'api','settings',NULL,?,?,?,?)`).bind(crypto.randomUUID(),ownerId,id,baseline,target,unit,now));
  }
  statements.push(db.prepare("DELETE FROM project_contribution_guards WHERE id=?").bind(guard));
  try{await db.batch(statements);}catch{throw new ContributionError("contribution_conflict");}
  return readKrSource(db,ownerId,id);
}
