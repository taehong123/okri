import { authorizeRequest, canManageTeam } from "@/lib/pace-data";
import { env, waitUntil } from "cloudflare:workers";
import { getDailyManualRun, latestDailyManualRun, processDailyManualRun, startDailyManualRun } from "@/lib/slack-daily-manual";
import { runDueSlackBotDeliveries } from "@/lib/slack-bot-delivery";
import { parseDigestSettings } from "@/lib/slack-daily-digest";
import { getSlackDailySettings, reconcileDailyReminders, retryDailyPublication, sendDailyReminderNow, syncSlackDailyInstallation, testDailyChannel, testDailyDm, updateSlackDailySettings } from "@/lib/slack-daily";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  if (!canManageTeam(authorization)) return Response.json({ error: "Owner 또는 Admin 권한이 필요합니다." }, { status: 403 });
  try {
    const runId = new URL(request.url).searchParams.get("runId");
    if (runId) {
      const result = await getDailyManualRun(env.DB, authorization.ownerId, runId);
      if (result.status === "pending") {
        waitUntil(processDailyManualRun(env.DB, authorization.ownerId, runId));
        waitUntil(runDueSlackBotDeliveries(env.DB, new Date(), authorization.ownerId));
      }
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ...await getSlackDailySettings(authorization), manualRun: await latestDailyManualRun(env.DB, authorization.ownerId) });
  } catch (error) { return routeError(error); }
}

export async function PATCH(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  if (!canManageTeam(authorization)) return Response.json({ error: "Owner 또는 Admin 권한이 필요합니다." }, { status: 403 });
  try {
    const payload = await request.json() as Record<string, unknown>;
    if (payload.action === "send_all_now") {
      const result = await startDailyManualRun(env.DB, authorization, typeof payload.requestId === "string" ? payload.requestId : "");
      waitUntil(processDailyManualRun(env.DB, authorization.ownerId, result.id));
      waitUntil(runDueSlackBotDeliveries(env.DB, new Date(), authorization.ownerId));
      return Response.json(result, { status: 202 });
    }
    if (payload.action === "repair") {
      await reconcileDailyReminders(authorization.ownerId, { verify: true });
      return Response.json(await getSlackDailySettings(authorization));
    }
    if (payload.action === "resync") {
      await syncSlackDailyInstallation(authorization.ownerId);
      return Response.json(await getSlackDailySettings(authorization));
    }
    if (payload.action === "test_dm" && typeof payload.memberId === "string") {
      await testDailyDm(authorization.ownerId, payload.memberId);
      return Response.json({ sent: true });
    }
    if (payload.action === "send_now" && typeof payload.memberId === "string") {
      return Response.json(await sendDailyReminderNow(authorization.ownerId, payload.memberId));
    }
    if (payload.action === "test_channel" && typeof payload.channelId === "string") {
      await testDailyChannel(authorization.ownerId, payload.channelId);
      return Response.json({ sent: true });
    }
    if (payload.action === "retry_publication" && typeof payload.publicationId === "string") {
      await retryDailyPublication(authorization.ownerId, payload.publicationId);
      return Response.json(await getSlackDailySettings(authorization));
    }
    return Response.json(await updateSlackDailySettings(authorization.ownerId, {
      ...parseDigestSettings(payload),
      enabled: typeof payload.enabled === "boolean" ? payload.enabled : undefined,
      weekdays: Array.isArray(payload.weekdays) ? payload.weekdays.map(Number) : undefined,
      reminderTime: typeof payload.reminderTime === "string" ? payload.reminderTime : undefined,
      timezone: typeof payload.timezone === "string" ? payload.timezone : undefined,
      channelIds: Array.isArray(payload.channelIds) ? payload.channelIds.filter((value): value is string => typeof value === "string") : undefined,
    }));
  } catch (error) { return routeError(error); }
}

function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Slack 데일리 설정을 처리하지 못했습니다.";
  return Response.json({ error: message }, { status: /필요|선택|시간|시간대|채널|찾을 수|설정/i.test(message) ? 400 : 500 });
}
