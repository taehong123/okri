import {env} from "cloudflare:workers";
import {authorizeRequest,ensureWorkspace} from "@/lib/pace-data";
import {readMetricCalendar,saveMetricCalendar,ScheduleError} from "@/lib/project-metric-schedules";
const headers={"Cache-Control":"private, no-store"};
export async function GET(request:Request) {
  const auth=await authorizeRequest(request,{allowViewerWrite:true});if(auth instanceof Response)return auth;
  await ensureWorkspace(auth.ownerId);
  return Response.json({calendar:await readMetricCalendar(env.DB,auth.ownerId),canEdit:["owner","admin"].includes(auth.role)},{headers});
}
export async function PUT(request:Request) {
  const auth=await authorizeRequest(request);if(auth instanceof Response)return auth;
  if(!["owner","admin"].includes(auth.role))return Response.json({code:"metric_calendar_admin_required"},{status:403,headers});
  try {
    await ensureWorkspace(auth.ownerId);const text=await request.text();if(text.length>64000)throw new ScheduleError("invalid_metric_calendar",413);
    const input=JSON.parse(text);if(!input||!Number.isSafeInteger(input.version)||input.version<0)throw new ScheduleError("invalid_metric_calendar");
    return Response.json({calendar:await saveMetricCalendar(env.DB,auth.ownerId,input,input.version),canEdit:true},{headers});
  }catch(error){return Response.json({code:error instanceof ScheduleError?error.code:"metric_calendar_failed"},{status:error instanceof ScheduleError?error.status:error instanceof SyntaxError?400:500,headers});}
}
