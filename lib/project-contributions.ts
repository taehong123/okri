export class ContributionError extends Error {
  constructor(public code: string, public status = 409) { super(code); this.name="ContributionError"; }
}
export type CompletionContributionInput = { actualValue: number; expectedVersion: number; expectedId: string; requestId: string };
export type Contribution = { id: string; defaultValue: number; actualValue: number | null; applied: boolean; enabled: boolean; version: number };
export type ProjectMetric = { id: string; keyResultId: string; title: string; startingValue: number; currentValue: number; targetValue: number; unit: string; progress: number; version: number; active: boolean; isEstimate?:boolean };
export type ContributionState = { projectId: string; projectStatus: string; keyResult: { id: string; title: string; progress: number } | null; contribution: Contribution | null; metric: ProjectMetric | null; apiConnected: boolean; schedule?:{mode:string;amount:number;accruedValue:number;active:boolean} | null };
const metricSelect = `SELECT m.*, k.title,EXISTS(SELECT 1 FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id AND json_array_length(s.credit_dates_json)>0) AS is_estimate,
  m.starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c
    WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0)+coalesce((SELECT sum(s.accrued_value) FROM project_metric_schedules s WHERE s.owner_id=m.owner_id AND s.kr_item_id=m.kr_item_id),0) AS current_value
  FROM kr_project_metrics m JOIN items k ON k.id=m.kr_item_id AND k.owner_id=m.owner_id`;
type MetricRow = { id: string; kr_item_id: string; title: string; starting_value: number; current_value: number; target_value: number; unit: string; version: number; active: number;is_estimate:number };
const metric = (m: MetricRow): ProjectMetric => ({ id:m.id,keyResultId:m.kr_item_id,title:m.title,startingValue:m.starting_value,currentValue:m.current_value,targetValue:m.target_value,unit:m.unit,version:m.version,active:Boolean(m.active),isEstimate:Boolean(m.is_estimate),progress:Math.max(0,Math.min(100,Math.round(m.current_value/m.target_value*100))) });
export async function listProjectMetrics(db: D1Database, ownerId: string) {
  const rows=await db.prepare(metricSelect+" WHERE m.owner_id=? AND m.active=1 AND k.archived_at IS NULL").bind(ownerId).all<MetricRow>();
  return rows.results.map(metric);
}
export async function readContribution(db: D1Database, ownerId: string, projectId: string): Promise<ContributionState> {
  const p=await db.prepare("SELECT id,status,parent_id FROM items WHERE owner_id=? AND id=? AND kind='project' AND archived_at IS NULL").bind(ownerId,projectId).first<{id:string;status:string;parent_id:string|null}>();
  if(!p)throw new ContributionError("project_not_found",404);
  const kr=await db.prepare(`SELECT k.id,k.title,k.progress FROM items i JOIN items k ON k.id=i.parent_id AND k.owner_id=i.owner_id
    WHERE i.owner_id=? AND i.id=? AND i.kind='initiative' AND i.archived_at IS NULL AND k.kind='key_result' AND k.archived_at IS NULL`)
    .bind(ownerId,p.parent_id).first<{id:string;title:string;progress:number}>();
  const c=await db.prepare("SELECT * FROM project_contributions WHERE owner_id=? AND project_id=?").bind(ownerId,projectId)
    .first<{id:string;default_value:number;actual_value:number|null;applied:number;enabled:number;version:number}>();
  const m=kr ? await db.prepare(metricSelect+" WHERE m.owner_id=? AND m.kr_item_id=?").bind(ownerId,kr.id).first<MetricRow>() : null;
  const api=kr ? await db.prepare("SELECT id FROM kr_data_connections WHERE owner_id=? AND kr_item_id=?").bind(ownerId,kr.id).first() : null;
  const schedule=kr?await db.prepare("SELECT mode,amount,accrued_value,active FROM project_metric_schedules WHERE owner_id=? AND project_id=? AND kr_item_id=?").bind(ownerId,projectId,kr.id).first<{mode:string;amount:number;accrued_value:number;active:number}>():null;
  return {projectId,projectStatus:p.status,keyResult:kr,contribution:c ? {id:c.id,defaultValue:c.default_value,actualValue:c.actual_value,applied:Boolean(c.applied),enabled:Boolean(c.enabled && m?.active && !schedule),version:c.version}:null,metric:m ? metric(m):null,apiConnected:Boolean(api && !m?.active),schedule:schedule?{mode:schedule.mode,amount:schedule.amount,accruedValue:schedule.accrued_value,active:Boolean(schedule.active)}:null};
}
function number(value: unknown, positive=false) {
  if(typeof value!=="number" || !Number.isFinite(value) || value<0 || value>1e12 || positive && value===0)throw new ContributionError("invalid_contribution",400);
  return value;
}
function version(value: unknown) {
  if(!Number.isSafeInteger(value) || (value as number)<0)throw new ContributionError("invalid_contribution",400);
  return value as number;
}
export function completionInput(input: unknown): CompletionContributionInput | undefined {
  if(input===undefined)return undefined;
  if(!input || typeof input!=="object" || Array.isArray(input))throw new ContributionError("invalid_contribution",400);
  const v=input as Record<string,unknown>;
  if(typeof v.expectedId!=="string" || !v.expectedId || typeof v.requestId!=="string" || !/^[a-zA-Z0-9-]{16,100}$/.test(v.requestId))throw new ContributionError("invalid_contribution",400);
  return {actualValue:number(v.actualValue),expectedVersion:version(v.expectedVersion),expectedId:v.expectedId,requestId:v.requestId};
}
export async function saveContribution(db: D1Database, ownerId: string, projectId: string, input: Record<string,unknown>) {
  const current=await readContribution(db,ownerId,projectId), c=current.contribution, m=current.metric;
  if(current.schedule)throw new ContributionError("scheduled_contribution_active");
  const expected=version(input.expectedVersion), expectedMetric=version(input.expectedMetricVersion);
  if(expected!==(c?.version??0) || (c && input.expectedId!==c.id) || expectedMetric!==(m?.version??0))throw new ContributionError("contribution_conflict");
  if(!current.keyResult)throw new ContributionError("key_result_required",400);
  if(current.apiConnected)throw new ContributionError("metric_api_connected");
  if(m && !m.active)throw new ContributionError("contribution_conflict");
  const defaultValue=number(input.defaultValue);
  const startingValue=m?.startingValue??number(input.startingValue);
  const targetValue=m?.targetValue??number(input.targetValue,true);
  const unit=m?.unit??(typeof input.unit==="string" ? input.unit.trim() : "%");
  if(unit.length>24)throw new ContributionError("invalid_contribution",400);
  const id=c?.id??crypto.randomUUID(), guard=crypto.randomUUID(), now=new Date().toISOString(), kr=current.keyResult.id;
  const statements=[
    db.prepare(`INSERT INTO project_contribution_guards (id,valid) SELECT ?, CASE WHEN
      EXISTS(SELECT 1 FROM items p JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id JOIN items k ON k.id=i.parent_id AND k.owner_id=p.owner_id
        WHERE p.id=? AND p.owner_id=? AND p.kind='project' AND p.archived_at IS NULL AND i.kind='initiative' AND i.archived_at IS NULL AND k.id=? AND k.kind='key_result' AND k.archived_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM kr_data_connections WHERE owner_id=? AND kr_item_id=? AND active=1)
      AND coalesce((SELECT version FROM project_contributions WHERE owner_id=? AND project_id=?),0)=?
      AND coalesce((SELECT id FROM project_contributions WHERE owner_id=? AND project_id=?),'')=?
      AND coalesce((SELECT version FROM kr_project_metrics WHERE owner_id=? AND kr_item_id=?),0)=? THEN 1 ELSE 0 END`)
      .bind(guard,projectId,ownerId,kr,ownerId,kr,ownerId,projectId,expected,ownerId,projectId,c?.id??"",ownerId,kr,expectedMetric),
    db.prepare(`INSERT INTO kr_project_metrics (id,owner_id,kr_item_id,starting_value,target_value,unit,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,kr_item_id) DO NOTHING`).bind(m?.id??crypto.randomUUID(),ownerId,kr,startingValue,targetValue,unit,now,now),
    db.prepare(`INSERT INTO project_contributions (id,owner_id,project_id,kr_item_id,default_value,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,project_id) DO UPDATE SET default_value=excluded.default_value,kr_item_id=excluded.kr_item_id,enabled=1,version=project_contributions.version+1,updated_at=excluded.updated_at`)
      .bind(id,ownerId,projectId,kr,defaultValue,now,now),
    db.prepare("DELETE FROM project_contribution_guards WHERE id=?").bind(guard),
  ];
  try{await db.batch(statements);}catch{throw new ContributionError("contribution_conflict");}
  return readContribution(db,ownerId,projectId);
}
export async function completeWithContribution(db: D1Database, ownerId: string, projectId: string, input: CompletionContributionInput, update: {sql:string;params:unknown[]}, nextStatus: string) {
  if(!["done","development_done"].includes(nextStatus))throw new ContributionError("invalid_contribution",400);
  const state=await readContribution(db,ownerId,projectId), c=state.contribution;
  const last=await db.prepare("SELECT last_request_id FROM project_contributions WHERE owner_id=? AND project_id=?").bind(ownerId,projectId).first<{last_request_id:string|null}>();
  if(c?.applied && last?.last_request_id===input.requestId && c.actualValue===input.actualValue && ["done","development_done"].includes(state.projectStatus))return;
  if(!c?.enabled || c.id!==input.expectedId || c.version!==input.expectedVersion || c.applied || ["done","development_done"].includes(state.projectStatus))throw new ContributionError("contribution_conflict");
  const guard=crypto.randomUUID(), now=new Date().toISOString();
  try{await db.batch([
    db.prepare(`INSERT INTO project_contribution_guards (id,valid) SELECT ?, CASE WHEN EXISTS(
      SELECT 1 FROM project_contributions c JOIN items p ON p.id=c.project_id AND p.owner_id=c.owner_id
      JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id
      JOIN items k ON k.id=i.parent_id AND k.owner_id=p.owner_id
      WHERE c.owner_id=? AND c.project_id=? AND c.id=? AND c.version=? AND c.enabled=1 AND c.applied=0
        AND p.kind='project' AND p.status NOT IN ('done','development_done') AND p.archived_at IS NULL AND i.kind='initiative' AND i.archived_at IS NULL
        AND k.id=c.kr_item_id AND k.kind='key_result' AND k.archived_at IS NULL
        AND EXISTS(SELECT 1 FROM kr_project_metrics m WHERE m.owner_id=c.owner_id AND m.kr_item_id=c.kr_item_id AND m.active=1)
        AND NOT EXISTS(SELECT 1 FROM project_metric_schedules s WHERE s.owner_id=c.owner_id AND s.project_id=c.project_id AND s.kr_item_id=c.kr_item_id)
    ) THEN 1 ELSE 0 END`).bind(guard,ownerId,projectId,input.expectedId,input.expectedVersion),
    db.prepare("UPDATE project_contributions SET actual_value=?,last_request_id=?,updated_at=? WHERE owner_id=? AND project_id=?")
      .bind(input.actualValue,input.requestId,now,ownerId,projectId),
    db.prepare(update.sql).bind(...update.params),
    db.prepare("DELETE FROM project_contribution_guards WHERE id=?").bind(guard),
  ]);}catch{throw new ContributionError("contribution_conflict");}
}
