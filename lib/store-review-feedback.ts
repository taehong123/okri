import { getSlackConnectionByTeam } from "./pace-data";
import { decryptSlackSecret } from "./slack-oauth";
import { postSlackMessage } from "./slack-automation";

export type StoreReviewSource = "apple" | "google_play";
export type StoreReviewEvent = {
  source: StoreReviewSource;
  eventId: string;
  eventType: string;
  state: string;
  occurredAt: string;
  summary: string;
  actionable: boolean;
};
export type StoreReviewRuntime = {
  DB: D1Database;
  SLACK_TOKEN_ENCRYPTION_KEY?: string;
  STORE_FEEDBACK_SLACK_TEAM_ID?: string;
  STORE_FEEDBACK_SLACK_CHANNEL_ID?: string;
  STORE_FEEDBACK_SLACK_MENTION_ID?: string;
};

const actionableStates = new Set([
  "DEVELOPER_REJECTED", "FAILED", "INVALID_BINARY", "METADATA_REJECTED", "REJECTED",
  "PROCESSING_EXCEPTION", "SUSPENDED", "REMOVED", "TERMINATED",
]);

export async function verifyStoreWebhookSignature(rawBody: string, supplied: string | null, secret: string | undefined) {
  if (!secret || secret.length < 24 || !supplied) return false;
  const match = supplied.trim().match(/^(?:hmacsha256|sha256)=([a-f0-9]{64})$/i);
  if (!match) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("HMAC", key, hexToBytes(match[1]), new TextEncoder().encode(rawBody));
  } catch { return false; }
}

export async function parseAppleReviewEvent(value: unknown, rawBody: string): Promise<StoreReviewEvent | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as { data?: Record<string, unknown> };
  const data = payload.data;
  if (!data || typeof data !== "object") return null;
  const eventType = clean(data.type, 120);
  if (!eventType) return null;
  const attributes = data.attributes && typeof data.attributes === "object" && !Array.isArray(data.attributes)
    ? data.attributes as Record<string, unknown> : {};
  const eventId = clean(data.id, 240) || await sha256(rawBody);
  const state = firstString(attributes, ["newValue", "newExternalBuildState", "newInternalBuildState", "newUploadState", "newState"]).toUpperCase();
  const occurredAt = normalizedDate(firstString(attributes, ["timestamp", "createdDate"]));
  const feedback = /feedback.*(?:created|submitted)|betaFeedback/i.test(eventType);
  const ping = /webhookPing/i.test(eventType);
  return {
    source: "apple",
    eventId,
    eventType,
    state,
    occurredAt,
    summary: feedback ? "TestFlight tester feedback was submitted." : state ? `App Store Connect state changed to ${state}.` : "App Store Connect event received.",
    actionable: !ping && (feedback || actionableStates.has(state) || /(?:FAILED|REJECTED|INVALID|ERROR)/.test(state)),
  };
}

export function parseGooglePlayEmail(value: unknown): StoreReviewEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const eventId = clean(input.messageId, 240);
  const from = clean(input.from, 320).toLowerCase();
  const subject = clean(input.subject, 500);
  const snippet = clean(input.snippet, 900);
  if (!eventId || !/@(?:[a-z0-9-]+\.)*google\.com(?:>|$)/i.test(from)) return null;
  if (!/(?:Google Play|Play Console)/i.test(`${subject} ${snippet}`)) return null;
  const signal = `${subject} ${snippet}`;
  const actionable = /(?:action required|rejected|rejection|policy issue|policy violation|suspend|removed|terminated|failed|couldn't publish|cannot publish|조치 필요|거부|반려|정책 위반|정지|삭제됨|게시할 수 없|審査|却下|違反|拒绝|违规|rechazad|infracci[oó]n)/i.test(signal);
  return {
    source: "google_play",
    eventId,
    eventType: "googlePlayConsoleEmail",
    state: actionable ? "ACTION_REQUIRED" : "INFORMATIONAL",
    occurredAt: normalizedDate(clean(input.receivedAt, 80)),
    summary: [subject, snippet].filter(Boolean).join("\n").slice(0, 1200),
    actionable,
  };
}

export async function deliverStoreReviewEvent(runtime: StoreReviewRuntime, event: StoreReviewEvent) {
  const id = `${event.source}:${event.eventId}`.slice(0, 480);
  const existing = await runtime.DB.prepare("SELECT delivery_status FROM store_review_feedback WHERE id = ?").bind(id).first<{ delivery_status: string }>();
  if (existing?.delivery_status === "delivered" || existing?.delivery_status === "ignored") return existing.delivery_status;
  await runtime.DB.prepare(`INSERT INTO store_review_feedback
    (id,source,source_event_id,event_type,state,delivery_status,received_at,occurred_at)
    VALUES(?,?,?,?,?,'received',?,?) ON CONFLICT(id) DO UPDATE SET attempts=store_review_feedback.attempts+1,last_error=''`)
    .bind(id, event.source, event.eventId, event.eventType, event.state, new Date().toISOString(), event.occurredAt).run();
  if (!event.actionable) {
    await runtime.DB.prepare("UPDATE store_review_feedback SET delivery_status='ignored' WHERE id=?").bind(id).run();
    return "ignored";
  }
  try {
    const teamId = required(runtime.STORE_FEEDBACK_SLACK_TEAM_ID, "STORE_FEEDBACK_SLACK_TEAM_ID");
    const channelId = required(runtime.STORE_FEEDBACK_SLACK_CHANNEL_ID, "STORE_FEEDBACK_SLACK_CHANNEL_ID");
    const mentionId = required(runtime.STORE_FEEDBACK_SLACK_MENTION_ID, "STORE_FEEDBACK_SLACK_MENTION_ID");
    const connection = await getSlackConnectionByTeam(teamId);
    if (!connection) throw new Error("The configured Slack team is not connected to OKRI");
    const token = await decryptSlackSecret(connection.encryptedBotToken, required(runtime.SLACK_TOKEN_ENCRYPTION_KEY, "SLACK_TOKEN_ENCRYPTION_KEY"));
    await postSlackMessage(token, channelId, reviewMessage(event, mentionId), { clientMsgId: await stableUuid(id) });
    await runtime.DB.prepare("UPDATE store_review_feedback SET delivery_status='delivered',delivered_at=?,last_error='' WHERE id=?")
      .bind(new Date().toISOString(), id).run();
    return "delivered";
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Store feedback delivery failed";
    await runtime.DB.prepare("UPDATE store_review_feedback SET delivery_status='failed',last_error=? WHERE id=?").bind(message, id).run();
    throw error;
  }
}

function reviewMessage(event: StoreReviewEvent, mentionId: string) {
  const store = event.source === "apple" ? "Apple App Store" : "Google Play";
  const link = event.source === "apple" ? "https://appstoreconnect.apple.com/apps" : "https://play.google.com/console/developers";
  return [
    `<@${mentionId}> 스토어 확인이 필요합니다.`,
    `*${escapeSlack(store)} · ${escapeSlack(event.state || event.eventType)}*`,
    escapeSlack(event.summary),
    `<${link}|${escapeSlack(store)} 열기>`,
  ].join("\n");
}

function firstString(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) { const result = clean(value[key], 200); if (result) return result; }
  return "";
}
function clean(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function normalizedDate(value: string) { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString(); }
function required(value: string | undefined, name: string) { if (!value) throw new Error(`${name} is not configured`); return value; }
function escapeSlack(value: string) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
async function sha256(value: string) { return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
async function stableUuid(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes.slice(0, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function hexToBytes(value: string) { return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16)); }
function bytesToHex(bytes: Uint8Array) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
