import {env} from "cloudflare:workers";
import {authorizeRequest,ensureWorkspace} from "@/lib/pace-data";
import {readProjectSchedule,saveProjectSchedule,ScheduleError} from "@/lib/project-metric-schedules";
import {readMetricDisplaySettings} from "@/lib/kr-metric-display";
import {hasPerformanceRule} from "@/lib/kr-performance";
const headers={"Cache-Control":"private, no-store"};
export async function GET(request:Request) {
  const auth=await authorizeRequest(request,{allowViewerWrite:true});if(auth instanceof Response)return auth;
  try {
    await ensureWorkspace(auth.ownerId);
    const value = await readProjectSchedule(env.DB, auth.ownerId, new URL(request.url).searchParams.get("projectId") ?? "");
    return Response.json({ ...value, displaySettings: await readMetricDisplaySettings(env.DB, auth.ownerId, value.keyResult.id) }, { headers });
  }
  catch(error){return failure(error);}
}
export async function PUT(request:Request) {
  const auth=await authorizeRequest(request);if(auth instanceof Response)return auth;
  try {
    await ensureWorkspace(auth.ownerId);const text=await request.text();if(text.length>16000)throw new ScheduleError("invalid_contribution_schedule",413);
    const input=JSON.parse(text);if(!input||typeof input.projectId!=="string"||typeof input.revision!=="string")throw new ScheduleError("invalid_contribution_schedule");
    const previous=await readProjectSchedule(env.DB,auth.ownerId,input.projectId);
    if(await hasPerformanceRule(env.DB,auth.ownerId,previous.keyResult.id))throw new ScheduleError("versioned_project_rule_required",409);
    return Response.json(await saveProjectSchedule(env.DB,auth.ownerId,input.projectId,input,input.revision),{headers});
  }catch(error){return failure(error);}
}
function failure(error:unknown) {return Response.json({code:error instanceof ScheduleError?error.code:"contribution_schedule_failed"},{status:error instanceof ScheduleError?error.status:error instanceof SyntaxError?400:500,headers});}
