import { env } from "cloudflare:workers";
import { authorizeRequest } from "@/lib/pace-data";
import { readMetricDisplaySettings, saveMetricDisplaySettings } from "@/lib/kr-metric-display";
import { performanceFailure, performanceResponse } from "@/lib/kr-performance";
import { PerformanceError, record, textValue } from "@/lib/kr-performance-model";

export async function GET(request: Request) {
  const auth = await authorizeRequest(request, { allowViewerWrite: true });
  if (auth instanceof Response) return auth;
  try {
    const id = textValue(new URL(request.url).searchParams.get("keyResultId"), 128);
    return performanceResponse({ settings: await readMetricDisplaySettings(env.DB, auth.ownerId, id) });
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
    if (body.length > 4096) throw new PerformanceError("performance_input_too_large", 413);
    const input = record(JSON.parse(body));
    return performanceResponse({ settings: await saveMetricDisplaySettings(env.DB, auth, textValue(input.keyResultId, 128), input) });
  } catch (error) {
    const failure = performanceFailure(error);
    return performanceResponse({ code: failure.code }, failure.status);
  }
}
