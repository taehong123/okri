import {env,waitUntil} from "cloudflare:workers";
import {authorizeRequest,ensureWorkspace} from "@/lib/pace-data";
import {DailyReportError,createReportDraft,getReportContext,getReportDraft,readReportPreferences} from "@/lib/daily-report";
import {requireReportAdmin} from "@/lib/daily-report-config";
import {reportChannels,requestReportReview} from "@/lib/daily-report-slack";
import {runDueSlackBotDeliveries} from "@/lib/slack-bot-delivery";
const headers={"Cache-Control":"private, no-store"};
export async function GET(request:Request) {
  const auth=await authorizeRequest(request,{allowViewerWrite:true});if(auth instanceof Response)return auth;
  try {requireReportAdmin(auth);await ensureWorkspace(auth.ownerId);const url=new URL(request.url),id=url.searchParams.get("id");return Response.json(id?await getReportDraft(env.DB,auth.ownerId,id):await getReportContext(env.DB,auth.ownerId,auth.userId,url.searchParams.get("date")??undefined),{headers});}
  catch(error){return failure(error);}
}
export async function POST(request:Request) {
  const auth=await authorizeRequest(request);if(auth instanceof Response)return auth;
  try {
    requireReportAdmin(auth,true);await ensureWorkspace(auth.ownerId);const text=await request.text();if(text.length>140000)throw new DailyReportError("invalid_report_pages",413);
    const input=JSON.parse(text);if(!input||typeof input!=="object")throw new DailyReportError("invalid_report_action");
    if(input.action==="save_draft") {
      if(typeof input.sourceHash!=="string"||!Number.isSafeInteger(input.policyVersion)||typeof input.date!=="string")throw new DailyReportError("invalid_report_action");
      const prefs=await readReportPreferences(env.DB,auth.ownerId,auth.userId),channels=await reportChannels(auth.ownerId,prefs.policy.channelIds);
      return Response.json(await createReportDraft(env.DB,auth.ownerId,auth.userId,input,channels),{headers});
    }
    if(input.action==="request_approval"&&typeof input.id==="string"&&Number.isSafeInteger(input.revision)) {
      const result=await requestReportReview(env.DB,auth.ownerId,input.id,input.revision,new Date(),true);
      waitUntil(runDueSlackBotDeliveries(env.DB,new Date(),auth.ownerId));return Response.json(result,{status:202,headers});
    }
    throw new DailyReportError("invalid_report_action");
  }catch(error){return failure(error);}
}
function failure(error:unknown){return Response.json({code:error instanceof DailyReportError?error.code:"daily_report_failed"},{status:error instanceof DailyReportError?error.status:error instanceof SyntaxError?400:500,headers});}
