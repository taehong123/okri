import { configureSlackDailyOnboarding } from "@/lib/slack-daily";
import { parseDigestSettings } from "@/lib/slack-daily-digest";
import { authorizeRequest, canManageTeam } from "@/lib/pace-data";

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  if (!canManageTeam(authorization)) return Response.json({ error: "Owner 또는 Admin 권한이 필요합니다." }, { status: 403 });

  try {
    const payload = await request.json() as Record<string, unknown>;
    return Response.json(await configureSlackDailyOnboarding(authorization, {
      ...parseDigestSettings(payload),
      weekdays: Array.isArray(payload.weekdays) ? payload.weekdays.map(Number) : [],
      reminderTime: typeof payload.reminderTime === "string" ? payload.reminderTime : "",
      timezone: typeof payload.timezone === "string" ? payload.timezone : "",
      memberIds: Array.isArray(payload.memberIds) ? payload.memberIds.filter((value): value is string => typeof value === "string") : [],
      channelIds: Array.isArray(payload.channelIds) ? payload.channelIds.filter((value): value is string => typeof value === "string") : [],
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Slack 초기 설정을 완료하지 못했습니다.";
    return Response.json({ error: message }, { status: /필요|선택|시간|시간대|채널|멤버|연결|설정/i.test(message) ? 400 : 500 });
  }
}
