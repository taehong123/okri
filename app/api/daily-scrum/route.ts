import { getDailyDashboard, saveDailyDraft } from "@/lib/daily-bot";
import { authorizeRequest } from "@/lib/pace-data";
import { waitUntil } from "cloudflare:workers";
import { reconcileDailyReminders } from "@/lib/slack-daily";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;

  try {
    const date = new URL(request.url).searchParams.get("date") ?? today();
    waitUntil(reconcileDailyReminders(authorization.ownerId));
    return Response.json(await getDailyDashboard(authorization, date));
  } catch (error) {
    return dailyRouteError(error);
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const result = await saveDailyDraft(authorization, {
      date: typeof payload.date === "string" ? payload.date : today(),
      yesterdayNote: asText(payload.yesterdayNote),
      todayNote: asText(payload.todayNote),
      blockersNote: asText(payload.blockersNote),
      selectedTaskIds: Array.isArray(payload.selectedTaskIds) ? payload.selectedTaskIds.filter((value): value is string => typeof value === "string") : [],
      selectedWorkIds: Array.isArray(payload.selectedWorkIds) ? payload.selectedWorkIds as string[] : undefined,
      ...(Object.hasOwn(payload, "mustDoWorkIds") ? { mustDoWorkIds: payload.mustDoWorkIds as string[] } : {}),
      selectedYesterdayWorkIds: Array.isArray(payload.selectedYesterdayWorkIds) ? payload.selectedYesterdayWorkIds as string[] : undefined,
      noPlannedTasks: payload.noPlannedTasks === true,
      skipReason: typeof payload.skipReason === "string" ? payload.skipReason as "workload" | "vacation" | "personal" | "other" : null,
      skipNote: asText(payload.skipNote),
      source: "web",
    });
    return Response.json(result);
  } catch (error) {
    return dailyRouteError(error);
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function dailyRouteError(error: unknown) {
  const message = error instanceof Error ? error.message : "데일리 요청을 처리하지 못했습니다.";
  const status = /날짜|입력|선택|할당|담당|최대|초안|멤버|Task|date|invalid|required/i.test(message) ? 400 : 500;
  return Response.json({ error: message }, { status });
}
