import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileLanguageModule, d1Fixture, language } from "./helpers/language-fixture.mjs";

const [signupSource, feedbackSource, migration, page, statusPage, privacy, parity, copy] = await Promise.all([
  readFile(new URL("../lib/android-test-signup.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/android-test-feedback.ts", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0067_android_test_portal.sql", import.meta.url), "utf8"),
  readFile(new URL("../app/android-test/android-test-page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/android-test/status/status-page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../mobile/release/parity.md", import.meta.url), "utf8"),
  readFile(new URL("../lib/android-test-copy.ts", import.meta.url), "utf8"),
]);

function signupModule() { return compileLanguageModule(signupSource, { "./language": language }); }
function feedbackModule(posted) {
  return compileLanguageModule(feedbackSource, {
    "./pace-data": { getSlackConnectionByTeam: async (team) => team === "T0ALNKB6HEZ" ? { encryptedBotToken: "encrypted" } : null },
    "./slack-oauth": { decryptSlackSecret: async () => "bot-token" },
    "./slack-automation": { postSlackMessage: async (_token, channel, text, options) => { posted.push({ channel, text, options }); return { timestamp: "1.1" }; } },
  });
}

function fixture() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON;"); db.exec(migration);
  return { db, d1: d1Fixture(db) };
}

test("Android tester application validates contact details, encrypts before persistence, and exposes only a masked private portal", async (t) => {
  const { db, d1 } = fixture(); t.after(() => db.close());
  const signup = signupModule();
  assert.throws(() => signup.parseAndroidTestSignup({ email: "tester@example.com", phone: "010-1234-5678", consent: false }), /consent_required/);
  assert.throws(() => signup.parseAndroidTestSignup({ email: "tester@example.com", phone: "not-a-phone", consent: true }), /invalid_phone/);
  const input = signup.parseAndroidTestSignup({ email: " Tester@Example.com ", phone: "010-1234-5678", language: "ko", consent: true });
  const access = await signup.createAndroidTestAccess();
  await signup.saveAndroidTestSignup(d1, { ...input, encryptedPhone: "ciphertext-only", phoneLastFour: signup.phoneLastFour(input.phone), accessTokenHash: access.hash }, new Date("2026-09-26T00:00:00.000Z"));
  const raw = db.prepare("SELECT email_normalized, encrypted_phone, phone_last_four, access_token_hash FROM android_test_signups").get();
  assert.deepEqual({ ...raw }, { email_normalized: "tester@example.com", encrypted_phone: "ciphertext-only", phone_last_four: "5678", access_token_hash: access.hash });
  assert.equal(raw.encrypted_phone.includes("010"), false);
  db.prepare("INSERT INTO android_test_feedback(id,signup_id,message,created_at) VALUES('feedback',?,'The flow is clear.','2026-09-26T01:00:00.000Z')").run(db.prepare("SELECT id FROM android_test_signups").get().id);
  const portal = await signup.findAndroidTestPortal(d1, access.token);
  assert.equal(portal.email, "t*****@example.com"); assert.equal(portal.phoneLastFour, "5678");
  assert.equal(portal.feedback[0].message, "The flow is clear.");
  assert.equal(await signup.findAndroidTestPortal(d1, "not-a-valid-token"), null);
});

test("Android tester feedback and morning reports go to the client channel without contact details", async (t) => {
  const { db, d1 } = fixture(); t.after(() => db.close());
  const signup = signupModule(); const input = signup.parseAndroidTestSignup({ email: "tester@example.com", phone: "01012345678", language: "ko", consent: true }); const access = await signup.createAndroidTestAccess();
  await signup.saveAndroidTestSignup(d1, { ...input, encryptedPhone: "ciphertext-only", phoneLastFour: "5678", accessTokenHash: access.hash });
  const id = db.prepare("SELECT id FROM android_test_signups").get().id;
  db.prepare("UPDATE android_test_signups SET status='opted_in', opted_in_at='2026-09-25T00:00:00.000Z' WHERE id=?").run(id);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("conversations.list") ? { ok: true, channels: [{ id: "C-CLIENT", name: "client-okri" }] } : { ok: true }), { status: 200 });
  t.after(() => { globalThis.fetch = previousFetch; });
  const posted = []; const feedback = feedbackModule(posted);
  await feedback.createAndroidTestFeedback({ DB: d1, SLACK_TOKEN_ENCRYPTION_KEY: "key", STORE_FEEDBACK_SLACK_TEAM_ID: "T0ALNKB6HEZ" }, id, "Navigation needs clearer labels.");
  assert.equal(posted.length, 1); assert.equal(posted[0].channel, "C-CLIENT"); assert.match(posted[0].text, /Navigation needs clearer labels/); assert.doesNotMatch(posted[0].text, /tester@example\.com|01012345678/);
  await feedback.runAndroidTestDailyReport({ DB: d1, SLACK_TOKEN_ENCRYPTION_KEY: "key", STORE_FEEDBACK_SLACK_TEAM_ID: "T0ALNKB6HEZ" }, new Date("2026-09-26T00:05:00.000Z"));
  assert.equal(posted.length, 2); assert.match(posted[1].text, /Opted in: 1/); assert.doesNotMatch(posted[1].text, /tester@example\.com|01012345678/);
  assert.equal(db.prepare("SELECT status FROM android_test_daily_reports").get().status, "delivered");
});

test("tester page explains the duration and keeps privacy and native parity explicit", () => {
  assert.match(copy, /14일 연속|14 consecutive days/); assert.match(page, /phone/); assert.match(page, /status\?access/);
  assert.match(statusPage, /feedback/); assert.match(statusPage, /phoneLastFour/);
  assert.match(privacy, /Android 비공개 테스트 신청의 이메일과 암호화된 전화번호/); assert.match(privacy, /Slack 피드백 채널에는 이메일과 전화번호를 전송하지 않습니다/);
  assert.match(parity, /Android closed-test recruitment/);
});
