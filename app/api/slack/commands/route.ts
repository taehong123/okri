import { env, waitUntil } from "cloudflare:workers";
import { ensureWorkspace, getSlackConnectionByTeam } from "@/lib/pace-data";
import { createSlackMemberLinkUrl, dailyMemberBySlack, openDailyModal, reconcileDailyReminders } from "@/lib/slack-daily";
import { slackConfigured, verifySlackRequest, type SlackRuntimeEnv } from "@/lib/slack-oauth";
import { memberMessageLanguage, workspaceMessageLanguage } from "@/lib/language-preferences";
import { serverTranslator } from "@/lib/server-language";
import { handleSlackWorkCommandEvent } from "@/lib/slack-work-command";

export async function POST(request: Request) {
  const runtime = env as SlackRuntimeEnv;
  if (!slackConfigured(runtime)) return slackMessage("OKRI Slack 설정이 아직 완료되지 않았습니다.");
  const rawBody = await request.text();
  if (!await verifySlackRequest(request, rawBody, runtime.SLACK_SIGNING_SECRET!)) {
    return new Response("invalid Slack signature", { status: 401 });
  }
  const body = new URLSearchParams(rawBody);
  const text = body.get("text")?.trim() ?? "";
  const teamId = body.get("team_id") ?? "";
  const slackUserId = body.get("user_id") ?? "";
  const connection = teamId ? await getSlackConnectionByTeam(teamId) : null;
  if (!connection) return slackMessage("이 Slack 워크스페이스는 아직 OKRI에 연결되지 않았습니다.");
  await ensureWorkspace(connection.ownerId);
  const linked = await dailyMemberBySlack(teamId, slackUserId);
  const t = await serverTranslator(linked
    ? await memberMessageLanguage(env.DB, linked.authorization.ownerId, linked.memberId)
    : await workspaceMessageLanguage(env.DB, connection.ownerId));

  if (["daily", "데일리", "daily 작성", "데일리 작성"].includes(text.toLocaleLowerCase())) {
    if (!linked) {
      const link = await createSlackMemberLinkUrl(connection.ownerId, teamId, slackUserId, request);
      return slackMessage(t("OKRI 계정 연결이 필요합니다. 15분 안에 로그인해 연결해 주세요.\n{link}", { link }));
    }
    const triggerId = body.get("trigger_id") ?? "";
    if (!triggerId) return slackMessage(t("Slack 데일리 창을 열 수 없습니다. 다시 시도해 주세요."));
    await openDailyModal(triggerId, linked.authorization);
    void reconcileDailyReminders(connection.ownerId);
    return new Response(null, { status: 200 });
  }

  if (!text || text === "help") {
    return slackMessage(t("사용법\n• `/okri daily` — 개인 데일리 작성\n• `/okri <문장>` — 스레드 내용으로 업무 생성 초안 준비"));
  }

  if (!linked) {
    const link = await createSlackMemberLinkUrl(connection.ownerId, teamId, slackUserId, request);
    return slackMessage(t("OKRI 계정 연결이 필요합니다. 15분 안에 로그인해 연결해 주세요.\n{link}", { link }));
  }
  const channel = body.get("channel_id") ?? "";
  if (!channel) return slackMessage(t("Slack 채널을 확인하지 못했습니다. 다시 시도해 주세요."));
  const directMessage = body.get("channel_name") === "directmessage";
  waitUntil(handleSlackWorkCommandEvent(request, connection, {
    channel,
    channelType: directMessage ? "im" : "channel",
    user: slackUserId,
    text,
  }, { command: "work_create", query: text.slice(0, 240) }, { preparingNotice: false })
    .catch((error) => console.error("Slack work creation command failed", error)));
  return slackMessage(t("업무 생성 초안을 준비하고 있습니다. 잠시 후 Slack에서 검토안을 확인해 주세요."));
}

function slackMessage(text: string) {
  return Response.json({ response_type: "ephemeral", text });
}
