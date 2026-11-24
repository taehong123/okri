import { env } from "cloudflare:workers";
import { authorizeRequest, ensureWorkspace } from "@/lib/pace-data";
import { hasPerformanceRule, readKrPerformance } from "@/lib/kr-performance";
import { readMetricDisplaySettings } from "@/lib/kr-metric-display";
import { ContributionError } from "@/lib/project-contributions";
import { listCurrentKrMetrics, readKrSource, saveKrSource } from "@/lib/kr-data-sources";
export async function GET(request: Request) {
  const auth=await authorizeRequest(request,{allowViewerWrite:true});
  if(auth instanceof Response)return auth;
  try{
    await ensureWorkspace(auth.ownerId);
    const id=new URL(request.url).searchParams.get("keyResultId")?.trim();
    const headers = { "Cache-Control": "private, no-store" };
    if (id) {
      const [legacy, state, displaySettings] = await Promise.all([
        readKrSource(env.DB, auth.ownerId, id), readKrPerformance(env.DB, auth.ownerId, id, { grain: "month" }),
        readMetricDisplaySettings(env.DB, auth.ownerId, id),
      ]);
      const performance = state.performance;
      return Response.json({ ...legacy, displaySettings, performanceConfigured: Boolean(state.revision),
        keyResult: { ...legacy.keyResult, progress: performance ? performance.current.progress ?? 0 : legacy.keyResult.progress },
        metric: performance ? performance.rule.value.source === "projects" ? {
          startingValue: performance.rule.value.baseline, targetValue: performance.rule.value.target,
          currentValue: performance.current.value ?? 0, unit: performance.rule.value.unit,
        } : null : legacy.metric }, { headers });
    }
    return Response.json({ metrics: await listCurrentKrMetrics(env.DB, auth.ownerId) }, { headers });
  }catch(error){return failure(error);}
}
export async function PUT(request: Request) {
  const auth=await authorizeRequest(request);
  if(auth instanceof Response)return auth;
  try{
    await ensureWorkspace(auth.ownerId);
    const input=await request.json() as Record<string,unknown>|null;
    if(!input||typeof input.keyResultId!=="string"||!input.keyResultId.trim())throw new ContributionError("invalid_contribution",400);
    if (input.mode === "projects" && await hasPerformanceRule(env.DB, auth.ownerId, input.keyResultId.trim())) {
      throw new ContributionError("versioned_kr_rule_required",409);
    }
    return Response.json(await saveKrSource(env.DB,auth.ownerId,auth.userId,input.keyResultId.trim(),input),{headers:{"Cache-Control":"private, no-store"}});
  }catch(error){return failure(error);}
}
function failure(error:unknown){
  return error instanceof ContributionError?Response.json({code:error.code},{status:error.status}):Response.json({code:"data_source_save_failed"},{status:error instanceof SyntaxError?400:500});
}
