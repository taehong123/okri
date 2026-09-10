import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileLanguageModule, d1Fixture } from "./helpers/language-fixture.mjs";

const source = await readFile(new URL("../lib/store-review-feedback.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0064_store_review_feedback.sql", import.meta.url), "utf8");

function moduleWith(posted = []) {
  return compileLanguageModule(source, {
    "./pace-data": { getSlackConnectionByTeam: async teamId => teamId === "T0ALNKB6HEZ" ? { encryptedBotToken: "encrypted" } : null },
    "./slack-oauth": { decryptSlackSecret: async (value, secret) => `${value}:${secret}` },
    "./slack-automation": { postSlackMessage: async (token, channel, text, options) => { posted.push({ token, channel, text, options }); return { timestamp: "1.1" }; } },
  });
}

test("Apple webhook signatures and actionable state parsing use the documented payload shape", async () => {
  const store = moduleWith();
  const body = JSON.stringify({ data: { type: "appStoreVersionAppVersionStateUpdated", id: "7c813492-9516-4c79-903e-224effdd57ac", attributes: { newValue: "REJECTED", oldValue: "IN_REVIEW", timestamp: "2026-09-10T01:02:03Z" } } });
  const secret = "a sufficiently long webhook secret";
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(await store.verifyStoreWebhookSignature(body, `hmacsha256=${signature}`, secret), true);
  assert.equal(await store.verifyStoreWebhookSignature(body + "x", `hmacsha256=${signature}`, secret), false);
  const event = await store.parseAppleReviewEvent(JSON.parse(body), body);
  assert.deepEqual({ source: event.source, id: event.eventId, type: event.eventType, state: event.state, actionable: event.actionable }, {
    source: "apple", id: "7c813492-9516-4c79-903e-224effdd57ac", type: "appStoreVersionAppVersionStateUpdated", state: "REJECTED", actionable: true,
  });
  const progress = await store.parseAppleReviewEvent({ data: { type: "appStoreVersionAppVersionStateUpdated", id: "progress", attributes: { newValue: "IN_REVIEW" } } }, "progress");
  assert.equal(progress.actionable, false);
});

test("Google bridge accepts only signed Google Play mail and filters informational messages", () => {
  const store = moduleWith();
  const rejected = store.parseGooglePlayEmail({ messageId: "m1", from: "Google Play <noreply@google.com>", subject: "Action required: Google Play policy issue", snippet: "Your app was rejected.", receivedAt: "2026-09-10T00:00:00Z" });
  assert.equal(rejected.actionable, true);
  assert.equal(store.parseGooglePlayEmail({ messageId: "m2", from: "attacker@example.com", subject: "Google Play rejected", snippet: "" }), null);
  assert.equal(store.parseGooglePlayEmail({ messageId: "m3", from: "Google <noreply@google.com>", subject: "Security notice", snippet: "" }), null);
  const informational = store.parseGooglePlayEmail({ messageId: "m4", from: "Google Play <noreply@google.com>", subject: "Google Play Console update", snippet: "Your report is ready." });
  assert.equal(informational.actionable, false);
});

test("delivery stores no feedback body, deduplicates IDs and tags only actionable events", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close()); db.exec(migration);
  const posted = [], store = moduleWith(posted);
  const runtime = { DB: d1Fixture(db), SLACK_TOKEN_ENCRYPTION_KEY: "key", STORE_FEEDBACK_SLACK_TEAM_ID: "T0ALNKB6HEZ", STORE_FEEDBACK_SLACK_CHANNEL_ID: "C0AQ7SQC9P0", STORE_FEEDBACK_SLACK_MENTION_ID: "U0ALQ0TAN6A" };
  const actionable = { source: "apple", eventId: "event-1", eventType: "state", state: "REJECTED", occurredAt: "2026-09-10T00:00:00Z", summary: "Review rejected", actionable: true };
  assert.equal(await store.deliverStoreReviewEvent(runtime, actionable), "delivered");
  assert.equal(await store.deliverStoreReviewEvent(runtime, actionable), "delivered");
  assert.equal(posted.length, 1); assert.match(posted[0].text, /<@U0ALQ0TAN6A>/); assert.equal(posted[0].channel, "C0AQ7SQC9P0");
  const ignored = { ...actionable, eventId: "event-2", state: "IN_REVIEW", summary: "Not stored", actionable: false };
  assert.equal(await store.deliverStoreReviewEvent(runtime, ignored), "ignored"); assert.equal(posted.length, 1);
  const columns = db.prepare("PRAGMA table_info(store_review_feedback)").all().map(row => row.name);
  assert.equal(columns.includes("summary"), false); assert.equal(columns.includes("payload"), false);
});
