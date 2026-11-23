import { env } from "cloudflare:workers";
import { authorizeRequest } from "@/lib/pace-data";
import { bulkUpsertMetricEntries, currentProjectKr, getMetricRollupStatus, listMetricEntries, performanceFailure, performanceResponse,
  previewMetricRollup, readKrPerformance, readPerformanceChanges, recalculateMetric, reviseMetricEntry, writePerformance } from "@/lib/kr-performance";
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
      Number(query.get("after") ?? 0), Number(query.get("limit") ?? 50),
      { from: query.get("start"), to: query.get("end"), kind: query.get("kind") }));
    const estimates = query.get("includeEstimates");
    if (estimates !== null && estimates !== "true" && estimates !== "false") throw new PerformanceError("invalid_performance_input");
    const options = {
      start: query.get("start"), end: query.get("end"), asOf: query.get("asOf"),
      grain: query.get("grain"), includeEstimates: estimates === null ? undefined : estimates === "true",
    };
    switch (query.get("view")) {
      case "rollup": return performanceResponse(await getMetricRollupStatus(env.DB, auth.ownerId, id, query.get("cursor") ?? undefined));
      case "preview": return performanceResponse(await previewMetricRollup(env.DB, auth.ownerId, id, options));
      case "ledger": return performanceResponse(await listMetricEntries(env.DB, auth.ownerId, id, {
        ...options, projectId, offset: Number(query.get("offset") ?? 0), limit: Number(query.get("limit") ?? 100),
        includeUndated: query.get("includeUndated") !== "false", status: query.get("status"),
      }));
      default: return performanceResponse(await readKrPerformance(env.DB, auth.ownerId, id, options));
    }
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
    const id = keyResultId.trim();
    switch (input.action) {
      case "bulk": return performanceResponse(await bulkUpsertMetricEntries(env.DB, auth, id, input));
      case "correct":
      case "cancel": return performanceResponse(await reviseMetricEntry(env.DB, auth, id, { ...input, operation: input.action }));
      case "recalculate": return performanceResponse(await recalculateMetric(env.DB, auth, id, input.expectedRevision, input.reason));
      default: return performanceResponse(await writePerformance(env.DB, auth, id, input));
    }
  } catch (error) {
    const failure = performanceFailure(error);
    return performanceResponse({ code: failure.code }, failure.status);
  }
}
