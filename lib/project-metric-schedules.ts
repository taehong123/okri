import {calendarInput, localDate, scheduleCredits, scheduleInput, shiftDate, ScheduleError, type ContributionScheduleInput, type MetricCalendar} from "./project-metric-schedule-model";
export {ScheduleError} from "./project-metric-schedule-model";
type Row=Record<string,string|number|null>;
export type ProjectMetricSchedule=ContributionScheduleInput & {id:string;version:number;active:boolean;suspendedAt:string|null;isEstimate:true;accruedValue:number;monthValue:number;creditedDays:number;throughDate:string;recentCredits:{date:string;amount:number;isEstimate:true}[]};
export type ProjectScheduleState={project:{id:string;title:string};keyResult:{id:string;title:string;unit:string;projectMode:boolean};calendar:MetricCalendar;schedule:ProjectMetricSchedule|null;revision:string};
export async function readMetricCalendar(db:D1Database,ownerId:string):Promise<MetricCalendar> {
  const row=await db.prepare("SELECT timezone,holidays_json,version FROM workspace_metric_calendars WHERE owner_id=?").bind(ownerId).first<Row>();
  return row?{timezone:String(row.timezone),holidays:JSON.parse(String(row.holidays_json)),version:Number(row.version)}:{timezone:"Asia/Seoul",holidays:[],version:0};
}
async function snapshot(db:D1Database,ownerId:string,projectId:string) {
  const p=await db.prepare(`SELECT p.id,p.title,p.updated_at,p.parent_id,k.id AS kr_id,k.title AS kr_title,k.updated_at AS kr_updated,m.unit,m.active,m.version AS metric_version
    FROM items p JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id JOIN items k ON k.id=i.parent_id AND k.owner_id=p.owner_id
    LEFT JOIN kr_project_metrics m ON m.owner_id=k.owner_id AND m.kr_item_id=k.id
    WHERE p.owner_id=? AND p.id=? AND p.kind='project' AND p.archived_at IS NULL AND i.kind='initiative' AND i.archived_at IS NULL AND k.kind='key_result' AND k.archived_at IS NULL`).bind(ownerId,projectId).first<Row>();
  if(!p)throw new ScheduleError("schedule_project_or_kr_not_found",404);
  const [s,calendar]=await Promise.all([
    db.prepare("SELECT * FROM project_metric_schedules WHERE owner_id=? AND project_id=? AND kr_item_id=?").bind(ownerId,projectId,p.kr_id).first<Row>(),
    readMetricCalendar(db,ownerId),
  ]);
  const stamp=JSON.stringify([p,s,calendar]);
  const revision=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stamp))),b=>b.toString(16).padStart(2,"0")).join("");
  return {p,s,calendar,revision};
}
function stateFor(state:Awaited<ReturnType<typeof snapshot>>,now:Date):ProjectScheduleState {
  const {p,s,calendar,revision}=state;
  let schedule:ProjectMetricSchedule|null=null;
  if(s) {
    const dates=JSON.parse(String(s.credit_dates_json)) as string[],month=localDate(now,calendar.timezone).slice(0,7);
    const pauses=JSON.parse(String(s.pauses_json)) as ContributionScheduleInput["pauses"];
    // Archiving/moving suspends accrual. Resuming explicitly keeps the downtime excluded.
    if(s.suspended_at)pauses.push({startDate:localDate(new Date(String(s.suspended_at)),calendar.timezone),endDate:null});
    schedule={id:String(s.id),version:Number(s.version),mode:s.mode as ContributionScheduleInput["mode"],amount:Number(s.amount),startDate:String(s.start_date),endDate:s.end_date===null?null:String(s.end_date),pauses,
      active:Boolean(s.active),suspendedAt:s.suspended_at===null?null:String(s.suspended_at),isEstimate:true,accruedValue:Number(s.accrued_value),monthValue:dates.filter(d=>d.startsWith(month)).length*Number(s.amount),creditedDays:dates.length,throughDate:String(s.through_date),recentCredits:dates.slice(-100).reverse().map(date=>({date,amount:Number(s.amount),isEstimate:true}))};
  }
  return {project:{id:String(p.id),title:String(p.title)},keyResult:{id:String(p.kr_id),title:String(p.kr_title),unit:String(p.unit??""),projectMode:p.active===1},calendar,schedule,revision};
}
export async function readProjectSchedule(db:D1Database,ownerId:string,projectId:string,now=new Date()) {return stateFor(await snapshot(db,ownerId,projectId),now);}
function guardFor(db:D1Database,ownerId:string,state:Awaited<ReturnType<typeof snapshot>>,guard:string) {
  const {p,s,calendar}=state;
  return db.prepare(`INSERT INTO project_contribution_guards(id,valid) SELECT ?,CASE WHEN
    EXISTS(SELECT 1 FROM items p JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id JOIN items k ON k.id=i.parent_id AND k.owner_id=p.owner_id
      WHERE p.owner_id=? AND p.id=? AND p.parent_id=? AND p.updated_at IS ? AND p.archived_at IS NULL AND i.kind='initiative' AND i.archived_at IS NULL AND k.id=? AND k.kind='key_result' AND k.archived_at IS NULL)
    AND coalesce((SELECT version FROM kr_project_metrics WHERE owner_id=? AND kr_item_id=?),0)=?
    AND coalesce((SELECT version FROM project_metric_schedules WHERE owner_id=? AND project_id=? AND kr_item_id=?),0)=?
    AND coalesce((SELECT id FROM project_metric_schedules WHERE owner_id=? AND project_id=? AND kr_item_id=?),'')=?
    AND coalesce((SELECT version FROM workspace_metric_calendars WHERE owner_id=?),0)=? THEN 1 ELSE 0 END`)
    .bind(guard,ownerId,p.id,p.parent_id,p.updated_at, p.kr_id,ownerId,p.kr_id,p.metric_version??0,ownerId,p.id,p.kr_id,s?.version??0,ownerId,p.id,p.kr_id,s?.id??"",ownerId,calendar.version);
}
async function writeSchedule(db:D1Database,ownerId:string,state:Awaited<ReturnType<typeof snapshot>>,input:ContributionScheduleInput,now:Date) {
  const {p,s,calendar}=state,credits=scheduleCredits(input,calendar,now),guard=crypto.randomUUID(),at=now.toISOString();
  const config=[input.mode,input.amount,input.startDate,input.endDate,JSON.stringify(input.pauses),JSON.stringify(credits.dates),credits.accruedValue,credits.throughDate,calendar.version];
  if(s&&s.active===1&&s.suspended_at===null&&JSON.stringify([s.mode,s.amount,s.start_date,s.end_date,s.pauses_json,s.credit_dates_json,s.accrued_value,s.through_date,s.calendar_version])===JSON.stringify(config))return stateFor(state,now);
  try {await db.batch([
    guardFor(db,ownerId,state,guard),
    db.prepare(`INSERT INTO project_metric_schedules(id,owner_id,project_id,kr_item_id,mode,amount,start_date,end_date,pauses_json,credit_dates_json,accrued_value,through_date,calendar_version,active,suspended_at,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,1,?,?) ON CONFLICT(owner_id,project_id,kr_item_id) DO UPDATE SET
      mode=excluded.mode,amount=excluded.amount,start_date=excluded.start_date,end_date=excluded.end_date,pauses_json=excluded.pauses_json,credit_dates_json=excluded.credit_dates_json,
      accrued_value=excluded.accrued_value,through_date=excluded.through_date,calendar_version=excluded.calendar_version,active=1,suspended_at=NULL,version=project_metric_schedules.version+1,updated_at=excluded.updated_at`)
      .bind(s?.id??crypto.randomUUID(),ownerId,p.id,p.kr_id,...config,at,at),
    db.prepare("DELETE FROM project_contribution_guards WHERE id=?").bind(guard),
  ]);}catch {throw new ScheduleError("contribution_schedule_conflict",409);}
  return readProjectSchedule(db,ownerId,String(p.id),now);
}
export async function saveProjectSchedule(db:D1Database,ownerId:string,projectId:string,raw:unknown,expectedRevision?:string,now=new Date()) {
  const state=await snapshot(db,ownerId,projectId);
  if(expectedRevision!==undefined&&expectedRevision!==state.revision)throw new ScheduleError("contribution_schedule_conflict",409);
  if(state.p.active!==1)throw new ScheduleError("project_metric_source_required",409);
  return writeSchedule(db,ownerId,state,scheduleInput(raw),now);
}
export async function saveMetricCalendar(db:D1Database,ownerId:string,raw:unknown,expectedVersion:number,now=new Date()) {
  const input=calendarInput(raw),current=await readMetricCalendar(db,ownerId);
  if(expectedVersion!==current.version)throw new ScheduleError("metric_calendar_conflict",409);
  if(input.timezone===current.timezone&&JSON.stringify(input.holidays)===JSON.stringify(current.holidays))return current;
  const guard=crypto.randomUUID(),at=now.toISOString();
  try {await db.batch([
    db.prepare("INSERT INTO project_contribution_guards(id,valid) SELECT ?,CASE WHEN coalesce((SELECT version FROM workspace_metric_calendars WHERE owner_id=?),0)=? THEN 1 ELSE 0 END").bind(guard,ownerId,current.version),
    db.prepare(`INSERT INTO workspace_metric_calendars(id,owner_id,timezone,holidays_json,version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET timezone=excluded.timezone,holidays_json=excluded.holidays_json,version=workspace_metric_calendars.version+1,updated_at=excluded.updated_at`)
      .bind(ownerId,ownerId,input.timezone,JSON.stringify(input.holidays),at,at),
    db.prepare("DELETE FROM project_contribution_guards WHERE id=?").bind(guard),
  ]);}catch {throw new ScheduleError("metric_calendar_conflict",409);}
  return readMetricCalendar(db,ownerId);
}
export async function runDueProjectContributions(db:D1Database,now=new Date()) {
  const rows=await db.prepare(`SELECT s.owner_id,s.project_id,s.id,s.mode,s.start_date,s.through_date,s.calendar_version,c.timezone,coalesce(c.version,0) AS current_calendar_version
    FROM project_metric_schedules s LEFT JOIN workspace_metric_calendars c ON c.owner_id=s.owner_id
    JOIN items p ON p.id=s.project_id AND p.owner_id=s.owner_id JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id
    JOIN items k ON k.id=i.parent_id AND k.owner_id=p.owner_id
    WHERE s.active=1 AND p.archived_at IS NULL AND i.archived_at IS NULL AND k.archived_at IS NULL AND k.id=s.kr_item_id
    ORDER BY s.through_date,s.updated_at,s.id`).all<Row>();
  let updated=0,failed=0;
  for(const row of rows.results) {
    const today=localDate(now,String(row.timezone??"Asia/Seoul")),through=row.mode==="once"?today:shiftDate(today,-1);
    if(row.mode==="once"&&String(row.through_date)>=String(row.start_date)&&row.calendar_version===row.current_calendar_version)continue;
    if(String(row.through_date)>=through&&row.calendar_version===row.current_calendar_version)continue;
    if(updated+failed>=100)break;
    try {
      const state=await snapshot(db,String(row.owner_id),String(row.project_id));
      if(!state.s?.active||state.s.id!==row.id)continue;
      await writeSchedule(db,String(row.owner_id),state,scheduleInput({mode:state.s.mode,amount:state.s.amount,startDate:state.s.start_date,endDate:state.s.end_date,pauses:JSON.parse(String(state.s.pauses_json))}),now);updated++;
    }catch {failed++;}
  }
  if(failed)throw new ScheduleError("scheduled_contribution_jobs_failed",503);
  return {updated,failed};
}
