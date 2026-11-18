import {env} from "cloudflare:workers";
import {authorizeRequest,ensureWorkspace} from "@/lib/pace-data";
import {DailyReportError,readReportPreferences} from "@/lib/daily-report";
import {requireReportAdmin,updateReportPreferences} from "@/lib/daily-report-config";
import {listSlackChannels} from "@/lib/slack-daily";
const headers={"Cache-Control":"private, no-store"};
export async function GET(request:Request) {
  const auth=await authorizeRequest(request,{allowViewerWrite:true});if(auth instanceof Response)return auth;
  try {
    requireReportAdmin(auth);await ensureWorkspace(auth.ownerId);const preferences=await readReportPreferences(env.DB,auth.ownerId,auth.userId);
    let channels:Awaited<ReturnType<typeof listSlackChannels>>=[],channelError=false;
    try {channels=await listSlackChannels(auth.ownerId);}catch{channelError=true;}
    const projects=await env.DB.prepare("SELECT id,title FROM items WHERE owner_id=? AND kind='project' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200").bind(auth.ownerId).all<{id:string;title:string}>();
    return Response.json({...preferences,channels,channelError,projects:projects.results},{headers});
  }catch(error){return failure(error);}
}
export async function PUT(request:Request) {
  const auth=await authorizeRequest(request);if(auth instanceof Response)return auth;
  try {
    requireReportAdmin(auth,true);await ensureWorkspace(auth.ownerId);const text=await request.text();if(text.length>64000)throw new DailyReportError("invalid_report_policy",413);
    const input=JSON.parse(text);if(!input||!Number.isSafeInteger(input.version)||input.version<0)throw new DailyReportError("invalid_report_policy");
    return Response.json(await updateReportPreferences(env.DB,auth,input,input.version),{headers});
  }catch(error){return failure(error);}
}
function failure(error:unknown){return Response.json({code:error instanceof DailyReportError?error.code:"daily_report_preferences_failed"},{status:error instanceof DailyReportError?error.status:error instanceof SyntaxError?400:500,headers});}
