import { authorizeRequest, canManageTeam, getSlackConnection } from "@/lib/pace-data";
import { canAutoJoinSlackChannel, listSlackChannels, slackApi, slackTokenForConnection } from "@/lib/slack-daily";
import { workspaceMessageLanguage } from "@/lib/language-preferences";
import { serverTranslator } from "@/lib/server-language";
import { slackWorkGuideBlocks, slackWorkGuideText } from "@/lib/slack-work-command-guide";
import { env } from "cloudflare:workers";

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  if (!canManageTeam(authorization)) return json({ error: "Owner 또는 Admin 권한이 필요합니다." }, 403);

  try {
    const payload = await request.json() as Record<string, unknown>;
    const channelId = typeof payload.channelId === "string" ? payload.channelId.trim() : "";
    if (!/^[A-Z0-9]{1,32}$/i.test(channelId)) return json({ error: "공유할 Slack 채널을 선택해 주세요." }, 400);

    const [connection, channels, t] = await Promise.all([
      getSlackConnection(authorization.ownerId),
      listSlackChannels(authorization.ownerId, { includeJoinablePublic: true }),
      workspaceMessageLanguage(env.DB, authorization.ownerId).then(serverTranslator),
    ]);
    if (!connection) return json({ error: "Slack 연결이 필요합니다." }, 409);
    const channel = channels.find((entry) => entry.id === channelId);
    if (!channel) return json({ error: "현재 공유할 수 있는 Slack 채널이 아닙니다." }, 400);

    const token = await slackTokenForConnection(connection);
    if (canAutoJoinSlackChannel(channel)) await slackApi(token, "conversations.join", { channel: channel.id });
    await slackApi(token, "chat.postMessage", {
      channel: channel.id,
      text: slackWorkGuideText(t),
      blocks: slackWorkGuideBlocks(t),
      unfurl_links: false,
      unfurl_media: false,
    });
    return json({ sent: true, channel: { id: channel.id, name: channel.name } });
  } catch (error) {
    console.error("Slack work guide sharing failed", error);
    return json({ error: error instanceof Error ? error.message : "Slack 매뉴얼을 공유하지 못했습니다." }, 502);
  }
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
