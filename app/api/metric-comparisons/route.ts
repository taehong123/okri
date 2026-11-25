import { env } from "cloudflare:workers";
import { authorizeRequest } from "@/lib/pace-data";
import { performanceFailure, performanceResponse } from "@/lib/kr-performance";
import { readMetricComparisons } from "@/lib/metric-comparisons";
import { PerformanceError } from "@/lib/kr-performance-model";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request, { allowViewerWrite: true });
  if (auth instanceof Response) return auth;
  try {
    const q = new URL(request.url).searchParams;
    const projectId = q.get("projectId") ?? undefined;
    const keyResultId = q.get("keyResultId") ?? "";
    if (!keyResultId && !projectId) throw new PerformanceError("key_result_required");
    const custom = ["currentStart", "currentEnd", "previousStart", "previousEnd"].map(key => q.get(key));
    if (custom.some(Boolean) && !custom.every(Boolean)) throw new PerformanceError("invalid_performance_range");
    return performanceResponse(await readMetricComparisons(env.DB, auth.ownerId, keyResultId, {
      asOf: q.get("asOf") ?? undefined, locale: q.get("locale") ?? undefined, projectId, includeEstimates: q.get("includeEstimates") !== "false",
      ...(custom.every(Boolean) ? { current: { start: custom[0]!, end: custom[1]! }, previous: { start: custom[2]!, end: custom[3]! } } : {}),
    }));
  } catch (error) {
    const failure = performanceFailure(error);
    return performanceResponse({ code: failure.code }, failure.status);
  }
}
