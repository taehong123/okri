import { env } from "cloudflare:workers";
import { authorizeRequest, ensureWorkspace } from "@/lib/pace-data";
import { ContributionError } from "@/lib/project-contributions";
import { listKrMetricSummaries, readKrSource, saveKrSource } from "@/lib/kr-data-sources";
export async function GET(request: Request) {
  const auth=await authorizeRequest(request,{allowViewerWrite:true});
  if(auth instanceof Response)return auth;
  try{
    await ensureWorkspace(auth.ownerId);
    const id=new URL(request.url).searchParams.get("keyResultId")?.trim();
    return Response.json(id?await readKrSource(env.DB,auth.ownerId,id):{metrics:await listKrMetricSummaries(env.DB,auth.ownerId)},{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return failure(error);}
}
export async function PUT(request: Request) {
  const auth=await authorizeRequest(request);
  if(auth instanceof Response)return auth;
  try{
    await ensureWorkspace(auth.ownerId);
    const input=await request.json() as Record<string,unknown>|null;
    if(!input||typeof input.keyResultId!=="string"||!input.keyResultId.trim())throw new ContributionError("invalid_contribution",400);
    return Response.json(await saveKrSource(env.DB,auth.ownerId,auth.userId,input.keyResultId.trim(),input),{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return failure(error);}
}
function failure(error:unknown){
  return error instanceof ContributionError?Response.json({code:error.code},{status:error.status}):Response.json({code:"data_source_save_failed"},{status:error instanceof SyntaxError?400:500});
}
