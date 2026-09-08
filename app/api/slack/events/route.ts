import { env, waitUntil } from "cloudflare:workers";
import { getSlackConnectionByTeam } from "@/lib/pace-data";
import { handleDeliveredDailyReminder, repairSlackDailyReminders } from "@/lib/slack-daily";
import { slackConfigured, verifySlackRequest, type SlackRuntimeEnv } from "@/lib/slack-oauth";
import { handleSlackWorkCommandEvent, parseSlackWorkCommand } from "@/lib/slack-work-command";

type SlackEventEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    channel_type?: string;
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    bot_id?: string;
    subtype?: string;
    thread_ts?: string;
    blocks?: Array<{ block_id?: string }>;
  };
};

type SlackEvent = NonNullable<SlackEventEnvelope["event"]>;
type SlackCommandEvent = SlackEvent & { channel: string; user: string; text: string; ts: string };

function isSlackCommandEvent(event: SlackEvent | undefined): event is SlackCommandEvent {
  return Boolean(event
    && (event.type === "message" || event.type === "app_mention")
    && event.channel && event.user && event.text && event.ts
    && !event.bot_id && !event.subtype);
}

function slackCommandReceiptId(teamId: string, event: SlackCommandEvent) {
  return `work:${teamId}:${event.channel}:${event.ts}:${event.user}`;
}

export async function POST(request: Request) {
  const runtime = env as SlackRuntimeEnv;
  if (!slackConfigured(runtime)) return new Response("Slack is not configured", { status: 503 });
  const rawBody = await request.text();
  if (!await verifySlackRequest(request, rawBody, runtime.SLACK_SIGNING_SECRET!)) return new Response("invalid Slack signature", { status: 401 });
  let payload: SlackEventEnvelope;
  try { payload = JSON.parse(rawBody) as SlackEventEnvelope; } catch { return new Response("invalid payload", { status: 400 }); }
  if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge ?? "" });
  const event = payload.event;
  const eventId = payload.event_id ?? "";
  const teamId = payload.team_id ?? "";
  if (!eventId || !teamId) return new Response(null, { status: 200 });
  const connection = await getSlackConnectionByTeam(teamId);
  if (!connection) return new Response(null, { status: 200 });
  const commandEvent = isSlackCommandEvent(event) && event.user !== connection.botUserId ? event : null;
  const commandText = commandEvent?.type === "app_mention"
    ? commandEvent.text.replace(/^<@[A-Z0-9]+>\s*/i, "")
    : commandEvent?.text;
  const parsedCommand = commandText ? parseSlackWorkCommand(commandText) : null;
  const naturalCreation = !parsedCommand && commandText?.trim()
    && (commandEvent?.type === "app_mention" || commandEvent?.channel_type === "im")
    ? { command: "work_create" as const, query: commandText.trim().slice(0, 240) }
    : null;
  const workCommand = parsedCommand ?? naturalCreation;
  const dailyMessage = event?.type === "message" && event.channel_type === "im" && event.user === connection.botUserId;
  const commandMessage = Boolean(workCommand && commandEvent);
  if (!dailyMessage && !commandMessage) {
    const shouldRepair = Boolean(event?.type
      && (event.type !== "message" || (event.channel_type === "im" && event.user !== connection.botUserId)));
    if (!shouldRepair) return new Response(null, { status: 200 });
    const receipt = await env.DB.prepare(`INSERT OR IGNORE INTO slack_event_receipts (event_id, team_id, event_type, received_at)
      VALUES (?, ?, ?, ?)`)
      .bind(eventId, teamId, event?.type ?? "", new Date().toISOString()).run();
    if (receipt.meta.changes) waitUntil(repairSlackDailyReminders(connection.ownerId));
    return new Response(null, { status: 200 });
  }
  const receiptId = commandMessage && commandEvent
    ? slackCommandReceiptId(teamId, commandEvent)
    : eventId;
  const receipt = await env.DB.prepare(`INSERT OR IGNORE INTO slack_event_receipts (event_id, team_id, event_type, received_at)
    VALUES (?, ?, ?, ?)`)
    .bind(receiptId, teamId, event?.type ?? "", new Date().toISOString()).run();
  if (!receipt.meta.changes) return new Response(null, { status: 200 });
  if (dailyMessage && event?.channel && event.user) {
    const blockIds = (event.blocks ?? []).flatMap((block) => block.block_id ? [block.block_id] : []);
    waitUntil(handleDeliveredDailyReminder({ teamId, channelId: event.channel, botId: event.user, blockIds }).then(() => undefined));
  } else if (workCommand && commandEvent
    && ["im", "channel", "group"].includes(commandEvent.channel_type ?? (commandEvent.type === "app_mention" ? "channel" : ""))) {
    waitUntil(handleSlackWorkCommandEvent(request, connection, {
      channel: commandEvent.channel,
      channelType: commandEvent.channel_type ?? (commandEvent.type === "app_mention" ? "channel" : ""),
      user: commandEvent.user,
      text: commandEvent.text,
      ts: commandEvent.ts,
      threadTs: commandEvent.thread_ts,
    }, workCommand).then(() => import("@/lib/slack-task-changes")).then(({ runDueTaskChanges }) => runDueTaskChanges(env.DB)).catch((error) => console.error("Slack work command failed", error)));
  }
  return new Response(null, { status: 200 });
}
