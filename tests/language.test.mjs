import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { language, preferences, catalogs, serverLanguage, d1Fixture, compileLanguageModule } from "./helpers/language-fixture.mjs";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, language_preference TEXT DEFAULT 'ko', resolved_language TEXT DEFAULT 'ko', language_revision INTEGER DEFAULT 0);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, message_language TEXT DEFAULT 'ko');
    CREATE TABLE workspace_members(id TEXT, workspace_id TEXT, user_id TEXT, status TEXT);
    INSERT INTO users(id) VALUES('a'),('b'); INSERT INTO workspaces VALUES('team','es');
    INSERT INTO workspace_members VALUES('ma','team','a','active'),('mb','team','b','active'),('unlinked','team',NULL,'active');`);
  return { db, d1: d1Fixture(db) };
}
const request = (header = "en-US", country) => Object.assign(new Request("https://okri.ai/api/account/preferences", { headers: { "accept-language": header } }), country ? { cf: { country } } : {});

test("automatic language respects browser order and trusted country only as fallback", () => {
  for (const [header, country, expected] of [["ko,en;q=0.5", "US", "ko"], ["ja-JP", "KR", "ja"], ["zh-TW", "KR", "zh"], ["de-DE,es-MX;q=.8", "KR", "es"], ["de-DE", "JP", "ja"], ["de-DE", null, "en"], ["en;q=0,ja;q=0.8", "KR", "ja"], ["*", "CN", "zh"]]) {
    assert.equal(language.requestLanguage(request(header, country)), expected);
  }
  const spoofed = new Request("https://okri.ai", { headers: { "CF-IPCountry": "JP", "X-Country": "KR", "Accept-Language": "de" } });
  assert.equal(language.requestLanguage(spoofed), "en");
});

test("existing accounts remain Korean; new accounts inherit only explicit valid guest choice", async (t) => {
  const { d1 } = fixture(t);
  assert.deepEqual(await preferences.languageForBootstrap(d1, "a", request("es")), { language: "ko", resolvedLanguage: "ko", revision: 0 });
  assert.deepEqual(preferences.newAccountLanguage(request("es")), { languagePreference: "auto", resolvedLanguage: "es" });
  const chosen = new Request("https://okri.ai", { headers: { cookie: "okri_guest_language=ja", "accept-language": "en" } });
  assert.deepEqual(preferences.newAccountLanguage(chosen), { languagePreference: "ja", resolvedLanguage: "ja" });
  const invalid = new Request("https://okri.ai", { headers: { cookie: "okri_guest_language=../../secret", "accept-language": "en" } });
  assert.equal(preferences.newAccountLanguage(invalid).resolvedLanguage, "en");
});

test("personal preferences and workspace messages remain independent and concurrent writes are rejected", async (t) => {
  const { d1, db } = fixture(t);
  const saved = await preferences.saveLanguagePreferences(d1, "a", { language: "ja", revision: 0 }, request());
  assert.deepEqual(saved, { language: "ja", resolvedLanguage: "ja", revision: 1 });
  assert.equal(await preferences.memberMessageLanguage(d1, "team", "ma"), "ja");
  assert.equal(await preferences.memberMessageLanguage(d1, "team", "mb"), "ko");
  assert.equal(await preferences.memberMessageLanguage(d1, "team", "unlinked"), "es");
  assert.equal(await preferences.workspaceMessageLanguage(d1, "team"), "es");
  await assert.rejects(preferences.saveLanguagePreferences(d1, "a", { language: "en", revision: 0 }, request()), (error) => error.code === "preference_conflict");
  await assert.rejects(preferences.saveLanguagePreferences(d1, "a", { language: "xx", revision: 1 }, request()), (error) => error.code === "invalid_language");
  assert.equal(db.prepare("SELECT language_revision FROM users WHERE id='b'").get().language_revision, 0);
});

test("automatic selection stores the latest confirmed language for asynchronous DM", async (t) => {
  const { d1 } = fixture(t);
  await preferences.saveLanguagePreferences(d1, "a", { language: "auto", revision: 0 }, request("ja"));
  assert.equal(await preferences.memberMessageLanguage(d1, "team", "ma"), "ja");
  const next = await preferences.languageForBootstrap(d1, "a", request("es"));
  assert.equal(next.language, "auto"); assert.equal(next.resolvedLanguage, "es"); assert.equal(next.revision, 1);
  assert.equal(await preferences.memberMessageLanguage(d1, "team", "ma"), "es");
});

test("all catalogs have identical keys and named variables without empty translations", () => {
  const keys = Object.keys(catalogs.en.default).sort();
  const variables = (value) => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((entry) => entry[1]))].sort();
  for (const [id, module] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(module.default).sort(), keys, id);
    for (const [key, value] of Object.entries(module.default)) {
      for (const text of typeof value === "string" ? [value] : Object.values(value)) {
        assert.ok(text.trim(), `${id}: ${key}`);
        assert.deepEqual(variables(text), variables(key), `${id}: ${key}`);
      }
    }
  }
});

test("Slack bot types, settings, states and safe errors are localized in every supported language", async () => {
  const botKeys = [
    "데일리 봇",
    "관리 봇",
    "자동화 봇",
    "업무 생성 관리 봇",
    "Task 변동 알림 봇",
    "시간과 대상 멤버를 설정합니다",
    "시간과 발송 채널을 설정합니다",
    "추천 규칙 또는 직접 규칙을 만듭니다",
    "Slack 연결 후 설정할 수 있습니다",
    "Slack 연결을 잠시 사용할 수 없습니다. 서비스 설정을 확인해 주세요.",
    "Owner 또는 Admin이 이 OKRI 워크스페이스에 사용할 Slack을 연결할 수 있습니다.",
    "데일리 기능에 필요한 Slack 권한을 다시 승인해 주세요.",
    "OKRI 연결이 완료되었습니다. 데일리 발송 설정을 완료해 주세요.",
    "OKRI 연결이 완료되었습니다.",
    "초기 설정 필요",
    "권한 업데이트 필요",
    "잠시 사용 불가",
    "예약됨",
    "예약 중",
    "발송 완료",
    "예약 취소됨",
    "Task 완료 알림",
    "Task 다시 열림 알림",
    "새 Task 알림",
    "새 Task가 만들어지면 담당 채널에 알립니다.",
    "업무 생성",
    "현재 Task 상태 모델에서는 사용할 수 없음",
    "Project 기한 초과",
    "Task 기한 초과",
    "기한 초과 Task {count}개",
    "연결된 Project 없음",
    "{count}개 Task",
    "발송 여부를 확인하지 못했습니다. 중복 발송을 막기 위해 재발송을 보류했습니다.",
    "Slack 연결 권한을 갱신해 주세요. 워크스페이스 관리자가 Slack 연결 관리에서 갱신할 수 있습니다.",
  ];
  for (const [id, module] of Object.entries(catalogs)) {
    for (const key of botKeys) {
      assert.ok(module.default[key], `${id}: missing bot copy ${key}`);
      assert.notEqual(module.default[key], key, `${id}: untranslated bot copy ${key}`);
    }
  }

  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /return t\(baseSlackErrorMessage\(error, fallback\)\)/);
  assert.match(page, /return t\(baseSlackReminderLabel\(status\)\)/);
  assert.match(page, /<b>\{t\(slackOAuthIssueCopy\[slackOAuthIssue\]\.title\)\}<\/b>/);
  assert.match(page, /<b>\{t\(recommendation\.name\)\}<\/b><p>\{t\(recommendation\.description\)\}<\/p>/);
  assert.match(page, /name: localizedName/);
  assert.match(page, /return t\("Task 생성"\)/);
  assert.match(page, /return t\("지원하지 않는 과거 상태 규칙"\)/);
});

test("server translators are bound per recipient and preserve user-authored text", async () => {
  const [ko, en, ja] = await Promise.all(["ko", "en", "ja"].map(serverLanguage.serverTranslator));
  assert.equal(ko("데일리 봇"), "데일리 봇");
  assert.notEqual(en("데일리 봇"), ko("데일리 봇"));
  assert.notEqual(ja("데일리 봇"), en("데일리 봇"));
  assert.equal(en("Customer-authored title"), "Customer-authored title");
  assert.equal(en("{count}개", { count: 1 }), "1 item");
  assert.equal(en("{count}개", { count: 0 }), "0 items");
  assert.equal(en("{count}개", { count: 2 }), "2 items");
});

test("date-only formatting keeps the stored deadline and numbers preserve zero", () => {
  for (const { id } of language.languages) {
    assert.match(language.formatCalendarDate("2026-09-03", id, { year: "numeric", month: "2-digit", day: "2-digit" }), /2026/);
    assert.equal(language.formatNumber(0, id), "0");
  }
  assert.equal(language.formatCalendarDate("not-a-date", "en"), "not-a-date");
});

test("preferences API permits every member's own account but denies tokens and cross-site writes", async (t) => {
  const { d1 } = fixture(t);
  let auth = { userId: "a", ownerId: "team", role: "viewer" };
  const background = [];
  const route = compileLanguageModule(await readFile(new URL("../app/api/account/preferences/route.ts", import.meta.url), "utf8"), {
    "cloudflare:workers": { env: { DB: d1 }, waitUntil: (promise) => background.push(promise) },
    "@/lib/pace-data": { authorizeRequest: async (_request, options) => { assert.equal(options.allowViewerWrite, true); return auth; } },
    "@/lib/language-preferences": preferences,
    "@/lib/slack-daily": { refreshUserReminderLanguages: async (userId) => assert.equal(userId, "a") },
  });
  const patch = (body, origin = "https://okri.ai") => new Request("https://okri.ai/api/account/preferences", { method: "PATCH", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const role of ["viewer", "member", "admin", "owner"]) {
    auth = { ...auth, role };
    const current = await preferences.readLanguagePreferences(d1, "a");
    const response = await route.PATCH(patch({ language: "en", revision: current.revision, userId: "b" }));
    assert.equal(response.status, 200); assert.match(response.headers.get("Cache-Control"), /private, no-store/);
    assert.equal((await preferences.readLanguagePreferences(d1, "b")).language, "ko");
  }
  assert.equal((await route.PATCH(patch({ language: "ja", revision: 4 }, "https://attacker.test"))).status, 403);
  auth = { ...auth, apiToken: true };
  assert.equal((await route.PATCH(patch({ language: "ja", revision: 4 }))).status, 403);
  assert.equal((await route.GET(request())).status, 403);
  await Promise.all(background);
});

test("language migration is additive, LF, and preserves existing Korean defaults", async () => {
  const sql = await readFile(new URL("../drizzle/0046_global_language.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /\r/);
  assert.doesNotMatch(sql, /\b(DROP|DELETE|UPDATE)\b/i);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE users(id TEXT); CREATE TABLE workspaces(id TEXT); CREATE TABLE slack_daily_reminders(id TEXT); CREATE TABLE slack_automations(id TEXT); INSERT INTO users VALUES('existing'); INSERT INTO workspaces VALUES('existing');");
    db.exec(sql);
    assert.equal(db.prepare("SELECT language_preference FROM users").get().language_preference, "ko");
    assert.equal(db.prepare("SELECT message_language FROM workspaces").get().message_language, "ko");
  } finally { db.close(); }
});

test("default property labels localize while renamed properties and custom values remain untouched", async () => {
  const { systemPropertyLabel } = compileLanguageModule(await readFile(new URL("../lib/property-label.ts", import.meta.url), "utf8"));
  const en = await serverLanguage.serverTranslator("en");
  assert.equal(systemPropertyLabel({ name: "DRI", systemKey: "project_dri" }, en), "Project lead");
  assert.equal(systemPropertyLabel({ name: "상태", systemKey: "status" }, en), en("상태"));
  assert.equal(systemPropertyLabel({ name: "우리 팀 책임자", systemKey: "project_dri" }, en), "우리 팀 책임자");
  assert.equal(systemPropertyLabel({ name: "상태", systemKey: null }, en), "상태");
  assert.equal(systemPropertyLabel({ name: "운영", systemKey: null }, en), "운영");
});

test("error envelopes preserve legacy fields and headers, with stable safe customer codes", async () => {
  const { withPublicErrorDetails, publicErrorMessages } = compileLanguageModule(await readFile(new URL("../lib/api-error.ts", import.meta.url), "utf8"));
  for (const [status, code] of [[400, "invalid_input"], [401, "authentication_required"], [403, "access_denied"], [409, "conflict"], [429, "rate_limited"], [500, "request_failed"]]) {
    const response = await withPublicErrorDetails(Response.json({ error: "database diagnostic", code: "legacy", fieldErrors: { title: "required" } }, { status, headers: { "X-Test": "preserved", "Content-Encoding": "gzip", ETag: '"old"' } }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("X-Test"), "preserved");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.equal(response.headers.get("ETag"), null);
    assert.deepEqual(await response.json(), { error: "database diagnostic", code: "legacy", fieldErrors: { title: "required" }, messageCode: code, messageValues: {} });
    for (const id of ["en", "ja", "zh", "es"]) assert.ok(catalogs[id].default[publicErrorMessages[code]], `Missing ${id} error ${code}`);
  }
  const success = Response.json({ ok: true });
  assert.equal(await withPublicErrorDetails(success), success);
});

test("automatic language does not follow an IP-only change during an active screen", async (t) => {
  const { d1 } = fixture(t);
  await preferences.saveLanguagePreferences(d1, "a", { language: "auto", revision: 0 }, request("fr", "JP"));
  const nextRequest = request("fr", "CN");
  nextRequest.headers.set("x-okri-display-language", "ja");
  assert.equal((await preferences.languageForBootstrap(d1, "a", nextRequest)).resolvedLanguage, "ja");
  assert.equal((await preferences.languageForBootstrap(d1, "a", request("fr", "CN"))).resolvedLanguage, "zh");
});

test("automation migration retains existing messages as custom text", async () => {
  const sql = await readFile(new URL("../drizzle/0046_global_language.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /\r|DROP|DELETE|UPDATE/i);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE slack_automations(id TEXT, message_template TEXT); CREATE TABLE slack_daily_reminders(id TEXT); CREATE TABLE users(id TEXT); CREATE TABLE workspaces(id TEXT); INSERT INTO slack_automations VALUES ('a','사용자가 작성한 메시지')");
    db.exec(sql);
    assert.deepEqual({ ...db.prepare("SELECT * FROM slack_automations").get() }, { id: "a", message_template: "사용자가 작성한 메시지", message_template_kind: "custom" });
  } finally { db.close(); }
});
