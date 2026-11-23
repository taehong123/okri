import { env } from "cloudflare:workers";
import { authorizeRequest } from "@/lib/pace-data";
import { listProjectOperations, writeProjectOperations } from "@/lib/project-operations";
import { readMetricCalendar } from "@/lib/project-metric-schedules";
import { performanceFailure, performanceResponse } from "@/lib/kr-performance";
import { PerformanceError, record, textValue } from "@/lib/kr-performance-model";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request, { allowViewerWrite: true });
  if (auth instanceof Response) return auth;
  try {
    const query = new URL(request.url).searchParams;
    const calendar = await readMetricCalendar(env.DB, auth.ownerId);
    return performanceResponse(await listProjectOperations(env.DB, auth.ownerId, calendar.timezone, {
      projectId: query.get("projectId") ?? undefined, asOf: query.get("asOf") ?? undefined,
      cursor: query.get("cursor") ?? undefined, limit: Number(query.get("limit") ?? 50),
    }));
  } catch (error) {
    const failure = performanceFailure(error);
    return performanceResponse({ code: failure.code }, failure.status);
  }
}

export async function PUT(request: Request) {
  const auth = await authorizeRequest(request);
  if (auth instanceof Response) return auth;
  try {
    const body = await request.text();
    if (body.length > 128_000) throw new PerformanceError("performance_input_too_large", 413);
    const input = record(JSON.parse(body));
    const calendar = await readMetricCalendar(env.DB, auth.ownerId);
    return performanceResponse(await writeProjectOperations(env.DB, auth, textValue(input.projectId, 128), input, calendar.timezone));
  } catch (error) {
    const failure = performanceFailure(error);
    return performanceResponse({ code: failure.code }, failure.status);
  }
}
