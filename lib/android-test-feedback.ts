import { getSlackConnectionByTeam } from "./pace-data";
import { postSlackMessage } from "./slack-automation";
import { decryptSlackSecret } from "./slack-oauth";

type Statement = {
  bind: (...values: unknown[]) => Statement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<unknown>;
};

export type AndroidTestFeedbackRuntime = {
  DB: { prepare: (sql: string) => Statement };
  SLACK_TOKEN_ENCRYPTION_KEY?: string;
  ANDROID_TEST_FEEDBACK_SLACK_TEAM_ID?: string;
  ANDROID_TEST_FEEDBACK_SLACK_CHANNEL_NAME?: string;
  STORE_FEEDBACK_SLACK_TEAM_ID?: string;
};

type AndroidTestSummary = {
  applied: number;
  invited: number;
  optedIn: number;
  eligible: number;
  rewarded: number;
  cancelled: number;
  feedback: number;
};

export async function createAndroidTestFeedback(runtime: AndroidTestFeedbackRuntime, signupId: string, message: string, now = new Date()) {
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  await runtime.DB.prepare(`INSERT INTO android_test_feedback
    (id, signup_id, message, delivery_status, created_at, last_error) VALUES (?, ?, ?, 'pending', ?, '')`)
    .bind(id, signupId, message, createdAt).run();
  try {
    await deliverAndroidTestFeedback(runtime, id);
  } catch {
    // The feedback has already been persisted; a Slack outage must not erase it.
  }
  return id;
}

export async function deliverAndroidTestFeedback(runtime: AndroidTestFeedbackRuntime, feedbackId: string) {
  const feedback = await runtime.DB.prepare(`SELECT f.id, f.signup_id, f.message, s.language
    FROM android_test_feedback f JOIN android_test_signups s ON s.id = f.signup_id WHERE f.id = ?`)
    .bind(feedbackId).first<{ id: string; signup_id: string; message: string; language: string }>();
  if (!feedback) throw new Error("Android test feedback was not found");
  try {
    const { token, channel } = await slackDestination(runtime);
    const receipt = await postSlackMessage(token, channel, feedbackMessage(feedback), { clientMsgId: await stableUuid(`android-test-feedback:${feedback.id}`) });
    await runtime.DB.prepare(`UPDATE android_test_feedback
      SET delivery_status='delivered', slack_message_ts=?, delivered_at=?, last_error='' WHERE id=?`)
      .bind(receipt.timestamp, new Date().toISOString(), feedback.id).run();
    return "delivered";
  } catch (error) {
    const message = errorMessage(error);
    await runtime.DB.prepare("UPDATE android_test_feedback SET delivery_status='failed', last_error=? WHERE id=?")
      .bind(message, feedback.id).run();
    throw error;
  }
}

export async function runAndroidTestDailyReport(runtime: AndroidTestFeedbackRuntime, scheduledAt = new Date()) {
  const local = seoulTime(scheduledAt);
  if (local.hour < 9 || local.hour >= 12) return { status: "not_due" as const };
  const existing = await runtime.DB.prepare("SELECT status FROM android_test_daily_reports WHERE report_date=?")
    .bind(local.date).first<{ status: string }>();
  if (existing?.status === "delivered") return { status: "already_delivered" as const };

  const summary = await androidTestSummary(runtime);
  const now = new Date().toISOString();
  await runtime.DB.prepare(`INSERT INTO android_test_daily_reports
    (report_date, status, summary_json, attempts, created_at, last_error) VALUES (?, 'pending', ?, 0, ?, '')
    ON CONFLICT(report_date) DO UPDATE SET summary_json=excluded.summary_json`)
    .bind(local.date, JSON.stringify(summary), now).run();
  try {
    const { token, channel } = await slackDestination(runtime);
    await postSlackMessage(token, channel, dailyReportMessage(local.date, summary), { clientMsgId: await stableUuid(`android-test-report:${local.date}`) });
    await runtime.DB.prepare(`UPDATE android_test_daily_reports
      SET status='delivered', attempts=attempts+1, delivered_at=?, last_error='' WHERE report_date=?`)
      .bind(new Date().toISOString(), local.date).run();
    return { status: "delivered" as const, summary };
  } catch (error) {
    await runtime.DB.prepare(`UPDATE android_test_daily_reports
      SET status='failed', attempts=attempts+1, last_error=? WHERE report_date=?`)
      .bind(errorMessage(error), local.date).run();
    throw error;
  }
}

async function androidTestSummary(runtime: AndroidTestFeedbackRuntime): Promise<AndroidTestSummary> {
  const rows = await runtime.DB.prepare("SELECT status, COUNT(*) AS count FROM android_test_signups GROUP BY status")
    .all<{ status: string; count: number }>();
  const feedback = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM android_test_feedback")
    .first<{ count: number }>();
  const counts = new Map(rows.results.map((row) => [row.status, Number(row.count)]));
  return {
    applied: counts.get("applied") ?? 0,
    invited: counts.get("invited") ?? 0,
    optedIn: counts.get("opted_in") ?? 0,
    eligible: counts.get("eligible") ?? 0,
    rewarded: counts.get("rewarded") ?? 0,
    cancelled: counts.get("cancelled") ?? 0,
    feedback: Number(feedback?.count ?? 0),
  };
}

async function slackDestination(runtime: AndroidTestFeedbackRuntime) {
  const teamId = required(runtime.ANDROID_TEST_FEEDBACK_SLACK_TEAM_ID ?? runtime.STORE_FEEDBACK_SLACK_TEAM_ID, "ANDROID_TEST_FEEDBACK_SLACK_TEAM_ID");
  const connection = await getSlackConnectionByTeam(teamId);
  if (!connection) throw new Error("The configured Slack team is not connected to OKRI");
  const token = await decryptSlackSecret(connection.encryptedBotToken, required(runtime.SLACK_TOKEN_ENCRYPTION_KEY, "SLACK_TOKEN_ENCRYPTION_KEY"));
  const channel = await findOrJoinPublicChannel(token, runtime.ANDROID_TEST_FEEDBACK_SLACK_CHANNEL_NAME?.trim() || "client-okri");
  return { token, channel };
}

async function findOrJoinPublicChannel(token: string, name: string) {
  const response = await fetch(`https://slack.com/api/conversations.list?exclude_archived=true&limit=200&types=public_channel`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => null) as { ok?: boolean; error?: string; channels?: Array<{ id?: string; name?: string }> } | null;
  const channel = result?.channels?.find((candidate) => candidate.name === name && candidate.id);
  if (!response.ok || !result?.ok || !channel?.id) throw new Error(`Slack channel #${name} was not found`);
  const join = await fetch("https://slack.com/api/conversations.join", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: channel.id }), signal: AbortSignal.timeout(15_000),
  });
  const joined = await join.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!join.ok || !joined?.ok) throw new Error(`OKRI bot could not join #${name}`);
  return channel.id;
}

function feedbackMessage(feedback: { id: string; message: string; language: string }) {
  return [
    "*OKRI Android tester feedback*",
    `Tester ${feedback.id.slice(0, 8)} · ${escapeSlack(feedback.language.toUpperCase())}`,
    "",
    escapeSlack(feedback.message),
  ].join("\n");
}

function dailyReportMessage(date: string, summary: AndroidTestSummary) {
  return [
    "*OKRI Android testing morning summary*",
    date,
    "",
    `Applications: ${summary.applied}`,
    `Invited: ${summary.invited}`,
    `Opted in: ${summary.optedIn}`,
    `14-day completion: ${summary.eligible}`,
    `Reward sent: ${summary.rewarded}`,
    `Feedback received: ${summary.feedback}`,
    summary.cancelled ? `Cancelled: ${summary.cancelled}` : "",
  ].filter(Boolean).join("\n");
}

function seoulTime(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour), minute: Number(value.minute) };
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message.slice(0, 500) : "Android test feedback delivery failed"; }
function escapeSlack(value: string) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
async function stableUuid(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
