import { env } from "cloudflare:workers";
import { authorizeRequest, ensureWorkspace } from "@/lib/pace-data";
import { ContributionError, listProjectMetrics, readContribution, saveContribution } from "@/lib/project-contributions";
import { readProjectPeriodContribution } from "@/lib/kr-performance";
export async function GET(request: Request) {
  const auth=await authorizeRequest(request,{allowViewerWrite:true});
  if(auth instanceof Response)return auth;
  try {
    await ensureWorkspace(auth.ownerId);
    const url=new URL(request.url), projectId=url.searchParams.get("projectId")?.trim();
    let data;
    if (projectId) {
      const legacy = await readContribution(env.DB, auth.ownerId, projectId);
      const performance = legacy.keyResult && await readProjectPeriodContribution(env.DB, auth.ownerId, legacy.keyResult.id, projectId);
      data = performance ? { ...legacy, metric: null, contribution: null, schedule: null, performance } : legacy;
    } else {
      data = { metrics: await listProjectMetrics(env.DB, auth.ownerId) };
    }
    return Response.json(data,{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return failure(error);}
}
export async function PUT(request: Request) {
  const auth=await authorizeRequest(request);
  if(auth instanceof Response)return auth;
  try {
    await ensureWorkspace(auth.ownerId);
    const input=await request.json() as Record<string,unknown>|null;
    if(!input || typeof input.projectId!=="string" || !input.projectId.trim())throw new ContributionError("invalid_contribution",400);
    const legacy = await readContribution(env.DB, auth.ownerId, input.projectId.trim());
    if (legacy.keyResult && await readProjectPeriodContribution(env.DB, auth.ownerId, legacy.keyResult.id, input.projectId.trim())) {
      throw new ContributionError("versioned_project_rule_required");
    }
    return Response.json(await saveContribution(env.DB,auth.ownerId,input.projectId.trim(),input),{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return failure(error);}
}
function failure(error:unknown){
  if(error instanceof ContributionError)return Response.json({code:error.code},{status:error.status});
  return Response.json({code:"contribution_save_failed"},{status:error instanceof SyntaxError?400:500});
}
