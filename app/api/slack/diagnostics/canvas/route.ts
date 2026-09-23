import { env } from "cloudflare:workers";
import { authorizeRequest, canManageTeam, getSlackConnection } from "@/lib/pace-data";
import { slackApi, slackCanvasTokenForConnection, slackTokenForConnection } from "@/lib/slack-daily";
import { readSlackThread, SlackWorkIntakeError } from "@/lib/slack-work-intake";

type ReceiptRow = { event_id: string; received_at: string };
type SlackMessage = {
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  latest_reply?: string;
};
type SlackHistory = { ok?: boolean; messages?: SlackMessage[] } & Record<string, unknown>;
type SlackConversation = { ok?: boolean; channel?: { name?: string } } & Record<string, unknown>;

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  if (!canManageTeam(authorization)) return Response.json({ error: "Owner 또는 Admin 권한이 필요합니다." }, { status: 403 });

  const connection = await getSlackConnection(authorization.ownerId);
  if (!connection) return diagnosticsResponse({ state: "disconnected" as const });

  const [botToken, canvasToken, receipts] = await Promise.all([
    slackTokenForConnection(connection),
    slackCanvasTokenForConnection(connection),
    env.DB.prepare(`SELECT event_id, received_at FROM slack_event_receipts
      WHERE team_id = ? AND event_id LIKE ? ORDER BY received_at DESC LIMIT 1`)
      .bind(connection.teamId, `work:${connection.teamId}:%`).all<ReceiptRow>(),
  ]);

  for (const receipt of receipts.results) {
    const parsed = parseWorkReceipt(receipt.event_id, connection.teamId);
    if (!parsed) continue;
    let message: SlackMessage | undefined;
    try {
      const history = await slackApi<SlackHistory>(botToken, "conversations.history", {
        channel: parsed.channel,
        latest: parsed.ts,
        inclusive: true,
        limit: 100,
      });
      const exact = history.messages?.find((entry) => entry.ts === parsed.ts);
      const huddleRoot = history.messages?.find((entry) => entry.subtype === "huddle_thread"
        && (!entry.latest_reply || entry.latest_reply >= parsed.ts));
      message = exact ?? (huddleRoot ? {
        user: parsed.user,
        text: "",
        ts: parsed.ts,
        thread_ts: huddleRoot.ts,
      } : undefined);
    } catch {
      continue;
    }
    if (!message) continue;

    try {
      const thread = await readSlackThread(botToken, {
        channel: parsed.channel,
        channelType: "channel",
        user: message.user || parsed.user,
        text: message.text || "",
        ts: parsed.ts,
        threadTs: message.thread_ts,
      }, canvasToken);
      if (!thread.canvasCandidateCount) continue;
      const channelName = await readChannelName(botToken, parsed.channel);
      return diagnosticsResponse({
        state: thread.canvasReadCount ? "readable" as const : "content_unavailable" as const,
        channelName,
        receivedAt: receipt.received_at,
        delegatedAccess: Boolean(canvasToken),
      });
    } catch (error) {
      if (!(error instanceof SlackWorkIntakeError) || !error.code.startsWith("slack_canvas_")) continue;
      const channelName = await readChannelName(botToken, parsed.channel);
      return diagnosticsResponse({
        state: error.code === "slack_canvas_scope_required" ? "permission_required" as const : "content_unavailable" as const,
        channelName,
        receivedAt: receipt.received_at,
        delegatedAccess: Boolean(canvasToken),
      });
    }
  }

  return diagnosticsResponse({ state: "no_recent_request" as const, delegatedAccess: Boolean(canvasToken) });
}

function parseWorkReceipt(value: string, teamId: string) {
  const parts = value.split(":");
  if (parts.length !== 5 || parts[0] !== "work" || parts[1] !== teamId) return null;
  const [, , channel, ts, user] = parts;
  return channel && ts && user ? { channel, ts, user } : null;
}

async function readChannelName(token: string, channel: string) {
  try {
    const result = await slackApi<SlackConversation>(token, "conversations.info", { channel });
    return result.channel?.name || "";
  } catch {
    return "";
  }
}

function diagnosticsResponse(value: Record<string, unknown>) {
  return Response.json(value, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
