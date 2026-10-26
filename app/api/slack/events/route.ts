import { env, waitUntil } from "cloudflare:workers";
import { getSlackConnectionByTeam } from "@/lib/pace-data";
import { handleDeliveredDailyReminder, repairSlackDailyReminders } from "@/lib/slack-daily";
import { slackConfigured, verifySlackRequest, type SlackRuntimeEnv } from "@/lib/slack-oauth";
import { handleSlackWorkCommandEvent, parseSlackWorkCommand } from "@/lib/slack-work-command";
import { handleSlackMcpConversation } from "@/lib/slack-mcp-agent";
import { isOkriManualQuestion } from "@/lib/okri-manual";


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
    files?: unknown[];
    attachments?: unknown[];
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
  return text.replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/giu, (mention, id: string) => id === botUserId ? " " : mention)
    .replace(/[ \t]{2,}/g, " ").trim();
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
  if(event&&['message','app_mention'].includes(event.type||'')&&event.user&&event.channel&&!event.bot_id&&!event.subtype&&/^!\s*(?:티켓\s*관리|tickets?\s+manage)\s*$/iu.test(withoutBotMention(event.text||'',connection.botUserId))){
    const receipt=await env.DB.prepare('INSERT OR IGNORE INTO slack_event_receipts(event_id,team_id,event_type,received_at) VALUES(?,?,?,?)').bind(`ticket_queue:${teamId}:${event.channel}:${event.ts}`,teamId,'ticket_queue',new Date().toISOString()).run();
    if(receipt.meta.changes)waitUntil(import('@/lib/ticket-slack-queue').then(({postTicketSlackQueueEntry})=>postTicketSlackQueueEntry(teamId,event.user!,event.channel!)).catch(()=>undefined));return new Response(null,{status:200});
  }
  // Persist customer intake before acknowledging Slack. A remote/AI failure cannot lose the event.
  if(isSlackCommandEvent(event)&&event.user!==connection.botUserId&&event.thread_ts&&event.channel_type!=='im'&&!parseSlackWorkCommand(withoutBotMention(event.text||'',connection.botUserId))){
    try{
      const queue=await import('@/lib/ticket-intake-queue');
      const id=await queue.captureTicketManagementReply(connection,{channel:event.channel,ts:event.ts,user:event.user,text:withoutBotMention(event.text||'',connection.botUserId),threadTs:event.thread_ts,hasAttachments:Boolean(event.files?.length||event.attachments?.length)});
      if(id){waitUntil(queue.processTicketReceipt(id));return new Response(null,{status:200});}
    }catch{return new Response('Ticket reply is temporarily unavailable',{status:503});}
  }
  const changed=event?.subtype==='message_changed'?(event as SlackEvent&{message?:SlackEvent}).message:undefined;
  const intakeMessage=changed||event;
  if(intakeMessage?.type!=='app_mention'&&intakeMessage?.channel_type!=='im'&&event?.channel_type!=='im'&&event?.channel&&intakeMessage?.ts&&(intakeMessage.user||intakeMessage.bot_id)&&(intakeMessage.text||intakeMessage.files?.length||intakeMessage.attachments?.length)&&(!intakeMessage.subtype||['bot_message','file_share','thread_broadcast'].includes(intakeMessage.subtype))){
    try{
      const {captureTicketMessage,processTicketReceipt}=await import('@/lib/ticket-intake-queue');
      const id=await captureTicketMessage(connection,{channel:event.channel,ts:intakeMessage.ts,user:intakeMessage.user||`bot:${intakeMessage.bot_id}`,text:intakeMessage.text||'',threadTs:intakeMessage.thread_ts,hasAttachments:Boolean(intakeMessage.files?.length||intakeMessage.attachments?.length),isRelay:Boolean(intakeMessage.bot_id||intakeMessage.subtype==='bot_message')});
      if(id)waitUntil(processTicketReceipt(id));
    }catch{return new Response('Ticket intake is temporarily unavailable',{status:503});}
  }
  if (event?.type === "message" && event.channel && event.ts && event.user && event.text && (!event.subtype||event.subtype==='bot_message') && event.user !== connection.botUserId && event.channel_type !== "im") {
    // Durable request uniqueness handles message/app_mention duplicates. Ticket work is isolated from other bot commands.
    waitUntil((async () => {
      const { intakeTicketEvent } = await import("@/lib/ticket-automation");
      const message = { channel: event.channel!, ts: event.ts!, user: event.user!, text: event.text!, threadTs: event.thread_ts, hasAttachments:Boolean(event.files?.length||event.attachments?.length),isRelay:Boolean(event.bot_id||event.subtype==='bot_message') };
      if (!message.isRelay) {
        // Explicit source-link sharing in the management channel remains supported.
        if(message.text.includes('.slack.com/archives/'))await intakeTicketEvent(connection,message);
      }
    })().catch(error => console.error("Ticket intake unavailable", { name: error instanceof Error ? error.name : "unknown" })));
  }
  const commandEvent = isSlackCommandEvent(event) && event.user !== connection.botUserId ? event : null;
  const canvasExcerpt = commandEvent?.subtype === "document_mention" ? slackBlockText(commandEvent.blocks) : "";
  const rawCommandText = commandEvent?.text || canvasExcerpt;
  // message and app_mention can arrive in either order for the same message.
  const commandText = commandEvent ? withoutBotMention(rawCommandText ?? "", connection.botUserId) : rawCommandText;
  const commandChannelType = commandEvent?.channel_type ?? (commandEvent?.channel.startsWith("D") ? "im" : "channel");
  const parsedCommand = commandText ? parseSlackWorkCommand(commandText) : null;
  const mcpConversation = !parsedCommand && (commandEvent?.type === "app_mention"
    || (!parsedCommand && commandEvent?.channel_type === "im" && isOkriManualQuestion(commandText ?? "")));
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
    && ["im", "mpim", "channel", "group"].includes(commandChannelType)) {
    waitUntil(handleSlackWorkCommandEvent(request, connection, {
      channel: commandEvent.channel,
      channelType: commandChannelType,
      user: commandEvent.user,
      text: commandText ?? "",
      ts: commandEvent.ts,
      threadTs: commandEvent.thread_ts,
    }, workCommand).then(() => import("@/lib/slack-task-changes")).then(({ runDueTaskChanges }) => runDueTaskChanges(env.DB)).catch((error) => console.error("Slack work command failed", error)));
  }
  return new Response(null, { status: 200 });
}
