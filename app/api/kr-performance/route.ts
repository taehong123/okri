import { env } from "cloudflare:workers";
import { authorizeRequest } from "@/lib/pace-data";
import { currentProjectKr, performanceFailure, performanceResponse, readKrPerformance, readPerformanceChanges, writePerformance } from "@/lib/kr-performance";
import { PerformanceError } from "@/lib/kr-performance-model";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request, { allowViewerWrite: true });
  if (auth instanceof Response) return auth;
  try {
    const query = new URL(request.url).searchParams;
    const projectId = query.get("projectId");
    const id = query.get("keyResultId") || (projectId ? (await currentProjectKr(env.DB, auth.ownerId, projectId)).keyResultId : "");
    if (!id) throw new PerformanceError("key_result_required");
    if (query.get("view") === "changes") return performanceResponse(await readPerformanceChanges(env.DB, auth.ownerId, id,
      Number(query.get("after") ?? 0), Number(query.get("limit") ?? 50)));
    const estimates = query.get("includeEstimates");
    if (estimates !== null && estimates !== "true" && estimates !== "false") throw new PerformanceError("invalid_performance_input");
    const result = await readKrPerformance(env.DB, auth.ownerId, id, {
      start: query.get("start"), end: query.get("end"), asOf: query.get("asOf"),
      grain: query.get("grain"), includeEstimates: estimates === null ? undefined : estimates === "true",
    });
    return performanceResponse(result);
  } catch (error) {
    const failure = performanceFailure(error);
    return performanceResponse({ code: failure.code }, failure.status);
  }
}

export async function PUT(request: Request) {
  const auth = await authorizeRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const text = await request.text();
    if (text.length > 128_000) throw new PerformanceError("performance_input_too_large", 413);
    const { keyResultId, ...input } = JSON.parse(text) ?? {};
    if (typeof keyResultId !== "string" || !keyResultId.trim()) throw new PerformanceError("key_result_required");
    return performanceResponse(await writePerformance(env.DB, auth, keyResultId.trim(), input));
  } catch (error) {
    const failure = performanceFailure(error);
    return performanceResponse({ code: failure.code }, failure.status);
  }
}
