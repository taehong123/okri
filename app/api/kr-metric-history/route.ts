import { env } from "cloudflare:workers";
import { authorizeRequest, ensureWorkspace } from "@/lib/pace-data";
import { ContributionError } from "@/lib/project-contributions";
import { readKrHistory } from "@/lib/kr-metric-history";
export async function GET(request:Request) {
  const auth=await authorizeRequest(request,{allowViewerWrite:true});
  if(auth instanceof Response)return auth;
  try{
    await ensureWorkspace(auth.ownerId);
    const url=new URL(request.url),id=url.searchParams.get("keyResultId")?.trim();
    if(!id)throw new ContributionError("key_result_required",400);
    return Response.json(await readKrHistory(env.DB,auth.ownerId,id,Number(url.searchParams.get("days")??30)),{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return error instanceof ContributionError?Response.json({code:error.code},{status:error.status}):Response.json({code:"metric_history_load_failed"},{status:500});}
}
