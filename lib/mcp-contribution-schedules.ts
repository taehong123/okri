import {z} from "zod";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {RequestAuthorization} from "./pace-data";
import {readMetricCalendar,readProjectSchedule,saveMetricCalendar,saveProjectSchedule,ScheduleError} from "./project-metric-schedules";
import {readKrSource,saveKrSource} from "./kr-data-sources";
const projectId=z.string().trim().min(1).max(128),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
function writeAccess(auth:RequestAuthorization,admin=false) {
  if(auth.role==="viewer"||auth.oauthScopes!==undefined&&!auth.oauthScopes.split(/\s+/).includes("okri:write"))throw new ScheduleError("write_access_required",403);
  if(admin&&!["owner","admin"].includes(auth.role))throw new ScheduleError("metric_calendar_admin_required",403);
}
const result=(value:unknown)=>({structuredContent:value as Record<string,unknown>,content:[{type:"text" as const,text:JSON.stringify(value)}]});
function failure(error:unknown) {return {isError:true,content:[{type:"text" as const,text:JSON.stringify({code:error instanceof ScheduleError?error.code:"contribution_schedule_failed"})}]};}
export function registerContributionScheduleTools(server:McpServer,db:D1Database,auth:RequestAuthorization,isManaged?:(krId:string)=>Promise<boolean>) {
  server.registerTool("set_kr_project_measurement",{
    title:"Measure a KR with Project contributions",description:"Explicitly select Project measurement before configuring date-based contributions, without opening the web UI. Preserve existing Project defaults, completed credits, schedules and saved API configuration; pause the KR API. A new numeric metric needs user-supplied starting_value, target_value and unit. Omit values to retain an existing Project metric. Never invent a target, unit, or starting amount. Uses an atomic revision check.",
    inputSchema:{key_result_id:projectId,starting_value:z.number().finite().min(0).max(1e12).optional(),target_value:z.number().finite().positive().max(1e12).optional(),unit:z.string().max(24).optional(),expected_revision:z.string().optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async input=>{try {
    writeAccess(auth);
    if(await isManaged?.(input.key_result_id))throw new ScheduleError("versioned_kr_rule_required",409);
    const state=await readKrSource(db,auth.ownerId,input.key_result_id);
    if(input.expected_revision!==undefined&&input.expected_revision!==state.revision)throw new ScheduleError("contribution_schedule_conflict",409);
    const startingValue=input.starting_value??state.metric?.startingValue,targetValue=input.target_value??state.metric?.targetValue,unit=input.unit??state.metric?.unit;
    if(startingValue===undefined||targetValue===undefined||unit===undefined)throw new ScheduleError("project_metric_values_required");
    const saved=state.mode==="projects"&&state.metric?.startingValue===startingValue&&state.metric.targetValue===targetValue&&state.metric.unit===unit?state:await saveKrSource(db,auth.ownerId,auth.userId,input.key_result_id,{revision:input.expected_revision??state.revision,mode:"projects",startingValue,targetValue,unit,projects:state.projects.map(p=>({id:p.id,defaultValue:p.defaultValue}))});
    return result({keyResult:saved.keyResult,mode:saved.mode,metric:saved.metric,projects:saved.projects,revision:saved.revision,apiConfigured:Boolean(saved.api)});
  }catch(error){return failure(error);}});
  server.registerTool("get_project_contribution_schedule",{
    title:"Read a Project's KR contribution schedule",description:"Read its current KR, saved one-off/business-day/daily estimated contribution, operating dates, pauses, cumulative/monthly estimates and latest 100 credited dates. Read-only; never treats Project completion as evidence of recurring work.",
    inputSchema:{project_id:projectId},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async input=>{try{return result(await readProjectSchedule(db,auth.ownerId,input.project_id));}catch(error){return failure(error);}});
  server.registerTool("upsert_project_contribution_schedule",{
    title:"Set one-off, business-day or daily KR contribution",description:"Save a Project's date-based estimated contribution independently of completion. KR must already use Project measurement. Modes: once (specified start_date), business_days (Mon–Fri excluding workspace holidays), daily. New settings require mode, amount and start_date; dates are local to the workspace calendar. Repeats credit closed days, not today. Optional inclusive end_date and pauses (null end_date means ongoing pause). Preserve omitted settings. Edits recalculate estimates for the operating period, never duplicate a credited date, preserve legacy completion credits, and never present estimates as actual API measurements. All amounts use the KR unit; do not invent an amount, operating start, or holiday dates.",
    inputSchema:{project_id:projectId,mode:z.enum(["once","business_days","daily"]).optional(),amount:z.number().finite().min(0).max(1e12).optional(),start_date:date.optional(),end_date:date.nullable().optional(),pauses:z.array(z.object({start_date:date,end_date:date.nullable()})).max(50).optional(),expected_revision:z.string().optional()},
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async input=>{try {
    writeAccess(auth);const current=await readProjectSchedule(db,auth.ownerId,input.project_id),s=current.schedule;
    if(await isManaged?.(current.keyResult.id))throw new ScheduleError("versioned_project_rule_required",409);
    return result(await saveProjectSchedule(db,auth.ownerId,input.project_id,{mode:input.mode??s?.mode,amount:input.amount??s?.amount,startDate:input.start_date??s?.startDate,endDate:input.end_date===undefined?s?.endDate??null:input.end_date,pauses:input.pauses?.map(p=>({startDate:p.start_date,endDate:p.end_date}))??s?.pauses??[]},input.expected_revision??current.revision));
  }catch(error){return failure(error);}});
  server.registerTool("get_metric_calendar",{
    title:"Read the workspace contribution calendar",description:"Read the IANA timezone and explicitly configured holiday dates used for business-day contribution. No holidays are silently assumed or fetched.",inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },async()=>{try{return result({calendar:await readMetricCalendar(db,auth.ownerId),canEdit:["owner","admin"].includes(auth.role)});}catch(error){return failure(error);}});
  server.registerTool("set_metric_calendar",{
    title:"Set workspace timezone and contribution holidays",description:"Owner/Admin only. Set an IANA timezone and explicit YYYY-MM-DD holidays after reading get_metric_calendar. Requires its version to reject stale writes. Affects all contribution schedules in this workspace; existing estimates are recalculated by the next scheduled job. Business days are Mon–Fri excluding these dates. Never invent national holiday coverage.",
    inputSchema:{timezone:z.string().min(1).max(100),holidays:z.array(date).max(2000),expected_version:z.number().int().min(0)},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  },async input=>{try{writeAccess(auth,true);return result({calendar:await saveMetricCalendar(db,auth.ownerId,input,input.expected_version)});}catch(error){return failure(error);}});
}
