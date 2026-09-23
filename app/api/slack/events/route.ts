import { env, waitUntil } from "cloudflare:workers";
import { getSlackConnectionByTeam } from "@/lib/pace-data";
import { handleDeliveredDailyReminder, repairSlackDailyReminders } from "@/lib/slack-daily";
import { slackConfigured, verifySlackRequest, type SlackRuntimeEnv } from "@/lib/slack-oauth";
import { handleSlackWorkCommandEvent, parseSlackWorkCommand } from "@/lib/slack-work-command";
import { handleSlackMcpConversation } from "@/lib/slack-mcp-agent";

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
    file_id?: string;
    blocks?: unknown[];
  };
};

type SlackEvent = NonNullable<SlackEventEnvelope["event"]>;
type SlackCommandEvent = SlackEvent & { channel: string; user: string; ts: string };

function isSlackCommandEvent(event: SlackEvent | undefined): event is SlackCommandEvent {
  const supportedSubtype = !event?.subtype
    || (event.type === "app_mention" && event.subtype === "document_mention");
  return Boolean(event
    && (event.type === "message" || event.type === "app_mention")
    && event.channel && event.user && event.ts
    && (event.text || event.subtype === "document_mention")
    && !event.bot_id && supportedSubtype);
}

function slackCommandReceiptId(teamId: string, event: SlackCommandEvent) {
  return `work:${teamId}:${event.channel}:${event.ts}:${event.user}`;
}

function withoutBotMention(text: string, botUserId: string) {
  return text.replaceAll(`<@${botUserId}>`, " ").replace(/[ \t]{2,}/g, " ").trim();
}

function slackBlockText(blocks: unknown[] | undefined) {
  const found: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || !value) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") found.push(record.text);
    for (const [key, entry] of Object.entries(record)) {
      if (key !== "text" && (key === "elements" || key === "blocks" || key === "fields")) visit(entry, depth + 1);
    }
  };
  visit(blocks, 0);
  return [...new Set(found.map((value) => value.trim()).filter(Boolean))].join("\n").slice(0, 8_000);
}

function slackBlockId(value: unknown) {
  return value && typeof value === "object" && typeof (value as { block_id?: unknown }).block_id === "string"
    ? (value as { block_id: string }).block_id
    : "";
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
  const canvasExcerpt = commandEvent?.subtype === "document_mention" ? slackBlockText(commandEvent.blocks) : "";
  const rawCommandText = commandEvent?.text || canvasExcerpt;
  const commandText = commandEvent?.type === "app_mention"
    ? withoutBotMention(rawCommandText ?? "", connection.botUserId)
    : rawCommandText;
  const parsedCommand = commandText ? parseSlackWorkCommand(commandText) : null;
  const mcpConversation = commandEvent?.type === "app_mention";
  const naturalCreation = !parsedCommand && commandText?.trim()
    && commandEvent?.channel_type === "im"
    ? { command: "work_create" as const, query: commandText.trim().slice(0, 240) }
    : null;
  const workCommand = mcpConversation ? null : parsedCommand ?? naturalCreation;
  const dailyMessage = event?.type === "message" && event.channel_type === "im" && event.user === connection.botUserId;
  const commandMessage = Boolean(workCommand && commandEvent);
  if (!dailyMessage && !commandMessage && !mcpConversation) {
    const shouldRepair = Boolean(event?.type
      && (event.type !== "message" || (event.channel_type === "im" && event.user !== connection.botUserId)));
    if (!shouldRepair) return new Response(null, { status: 200 });
    const receipt = await env.DB.prepare(`INSERT OR IGNORE INTO slack_event_receipts (event_id, team_id, event_type, received_at)
      VALUES (?, ?, ?, ?)`)
      .bind(eventId, teamId, event?.type ?? "", new Date().toISOString()).run();
    if (receipt.meta.changes) waitUntil(repairSlackDailyReminders(connection.ownerId));
    return new Response(null, { status: 200 });
  }
  const receiptId = (commandMessage || mcpConversation) && commandEvent
    ? slackCommandReceiptId(teamId, commandEvent)
    : eventId;
  const receipt = await env.DB.prepare(`INSERT OR IGNORE INTO slack_event_receipts (event_id, team_id, event_type, received_at)
    VALUES (?, ?, ?, ?)`)
    .bind(receiptId, teamId, event?.type ?? "", new Date().toISOString()).run();
  if (!receipt.meta.changes) return new Response(null, { status: 200 });
  if (mcpConversation && commandEvent) {
    waitUntil(handleSlackMcpConversation(request, connection, {
      channel: commandEvent.channel,
      channelType: commandEvent.channel_type ?? "channel",
      user: commandEvent.user,
      text: commandEvent.text || canvasExcerpt,
      ts: commandEvent.ts,
      threadTs: commandEvent.thread_ts,
      canvasFileId: commandEvent.subtype === "document_mention" ? commandEvent.file_id : undefined,
      canvasExcerpt: commandEvent.subtype === "document_mention" ? canvasExcerpt : undefined,
    }, commandText?.trim().slice(0, 4_000) || "Read this Canvas and respond to the request around the mention.").then(() => import("@/lib/slack-task-changes"))
      .then(({ runDueTaskChanges }) => runDueTaskChanges(env.DB))
      .catch((error) => console.error("Slack MCP conversation failed", error)));
  } else if (dailyMessage && event?.channel && event.user) {
    const blockIds = (event.blocks ?? []).map(slackBlockId).filter(Boolean);
    waitUntil(handleDeliveredDailyReminder({ teamId, channelId: event.channel, botId: event.user, blockIds }).then(() => undefined));
  } else if (workCommand && commandEvent
    && ["im", "channel", "group"].includes(commandEvent.channel_type ?? (commandEvent.type === "app_mention" ? "channel" : ""))) {
    waitUntil(handleSlackWorkCommandEvent(request, connection, {
      channel: commandEvent.channel,
      channelType: commandEvent.channel_type ?? (commandEvent.type === "app_mention" ? "channel" : ""),
      user: commandEvent.user,
      text: commandEvent.text ?? "",
      ts: commandEvent.ts,
      threadTs: commandEvent.thread_ts,
    }, workCommand).then(() => import("@/lib/slack-task-changes")).then(({ runDueTaskChanges }) => runDueTaskChanges(env.DB)).catch((error) => console.error("Slack work command failed", error)));
  }
  return new Response(null, { status: 200 });
}
