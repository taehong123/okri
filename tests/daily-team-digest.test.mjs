import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { preferences, serverLanguage } from "./helpers/language-fixture.mjs";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");
function compile(source, deps) {
  const loaded = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "module", "exports", code)((name) => {
    assert.ok(name in deps, `Unmocked dependency ${name}`); return deps[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}
const source = await read("../lib/slack-daily-digest.ts"), deliverySource = await read("../lib/slack-bot-delivery.ts");
const migration = await read("../drizzle/0052_daily_team_digest.sql");
const deliveryFile = (await readdir(new URL("../drizzle/", import.meta.url))).find((file) => file.endsWith("_slack_bot_deliveries.sql"));
const deliveryMigration = await read(`../drizzle/${deliveryFile}`);
const NOW = new Date("2026-09-07T02:00:00Z"), NOON = new Date("2026-09-07T03:00:00Z");
const task = (id, completedToday = false) => ({ id, kind: "task", completedToday });
const translator = await serverLanguage.serverTranslator("ko");

function harness(t) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, scheduled_deletion_at TEXT, message_language TEXT DEFAULT 'ko');
    CREATE TABLE slack_connections(id TEXT PRIMARY KEY, owner_id TEXT, team_id TEXT, connected_at TEXT, encrypted_bot_token TEXT);
    CREATE TABLE slack_daily_settings(owner_id TEXT PRIMARY KEY, enabled INTEGER, weekdays TEXT, timezone TEXT, onboarding_completed_at TEXT, install_status TEXT);
    CREATE TABLE workspace_members(id TEXT PRIMARY KEY, workspace_id TEXT, display_name TEXT, email TEXT, status TEXT);
    CREATE TABLE slack_member_links(owner_id TEXT, member_id TEXT, team_id TEXT);
    CREATE TABLE slack_daily_preferences(owner_id TEXT, member_id TEXT, enabled INTEGER);
    CREATE TABLE slack_daily_channels(owner_id TEXT, channel_id TEXT);
    CREATE TABLE daily_submissions(id TEXT PRIMARY KEY, owner_id TEXT, member_id TEXT, scrum_date TEXT, version INTEGER, work_snapshot_json TEXT, yesterday_work_snapshot_json TEXT, work_status TEXT DEFAULT 'office', skip_reason TEXT);
    CREATE TABLE daily_task_snapshots(id TEXT, submission_id TEXT, task_id TEXT, parent_id TEXT, parent_kind TEXT);
    CREATE TABLE items(id TEXT PRIMARY KEY, owner_id TEXT, kind TEXT, title TEXT, parent_id TEXT, routine_id TEXT);`);
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(deliveryMigration.replaceAll("--> statement-breakpoint", ""));
  for (const owner of ["a", "b"]) {
    db.prepare("INSERT INTO workspaces(id) VALUES(?)").run(owner);
    db.prepare("INSERT INTO slack_connections VALUES(?,?,?,?,?)").run(`c-${owner}`, owner, `T-${owner}`, NOW.toISOString(), owner);
    db.prepare("INSERT INTO slack_daily_settings(owner_id,enabled,weekdays,timezone,onboarding_completed_at,install_status) VALUES(?,1,'[1,2,3,4,5]','Asia/Seoul','2026-09-01','connected')").run(owner);
    db.prepare("INSERT INTO slack_daily_channels VALUES(?,?)").run(owner, `C-${owner}`);
    for (let i = 1; i <= 2; i++) {
      db.prepare("INSERT INTO workspace_members VALUES(?,?,?,?,'active')").run(`${owner}${i}`, owner, `${owner === "a" ? "한글 이름" : "다른 팀"} ${i}`, `${owner}${i}@test.invalid`);
      db.prepare("INSERT INTO slack_member_links VALUES(?,?,?)").run(owner, `${owner}${i}`, `T-${owner}`);
    }
    for (const [id, kind, parent, routine] of [["kr", "key_result", null, null], ["i", "initiative", "kr", null], ["p", "project", "i", null], ["t1", "task", "p", null], ["t2", "task", "p", null], ["r", "task", null, "routine"], ["inbox", "task", null, null]]) {
      db.prepare("INSERT INTO items VALUES(?,?,?,?,?,?)").run(`${owner}-${id}`, owner, kind, `${owner}-${id}`, parent ? `${owner}-${parent}` : null, routine);
    }
  }
  const raw = {
    async batch(statements) { db.exec("SAVEPOINT d1_batch"); try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec("RELEASE d1_batch"); return result; } catch (error) { db.exec("ROLLBACK TO d1_batch; RELEASE d1_batch"); throw error; } },
    prepare(sql) { const statement = db.prepare(sql); let args = []; return {
      bind(...values) { args = values; return this; }, async first() { return statement.get(...args) ?? null; },
      async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
    }; },
  };
  const calls = [], behavior = { fail: null, beforeDecrypt: null };
  class SlackMessageError extends Error { constructor(message, outcome, retryAfterSeconds = 0) { super(message); Object.assign(this, { outcome, retryAfterSeconds }); } }
  const delivery = compile(deliverySource, {
    "cloudflare:workers": { env: { SLACK_TOKEN_ENCRYPTION_KEY: "mock" } },
    "@/lib/slack-oauth": { decryptSlackSecret: async (token) => { await behavior.beforeDecrypt?.(); return token; } },
    "@/lib/slack-automation": { SlackMessageError, async postSlackMessage(token, channel, text, options) {
      calls.push({ token, channel, text, ...options }); if (behavior.fail) throw behavior.fail; return { timestamp: `${calls.length}.1` };
    } },
  });
  const api = compile(source, { "./slack-bot-delivery": delivery, "./language-preferences": preferences, "./server-language": serverLanguage });
  const submit = (member, work = [], completed = [], skip = null, version = 1, date = "2026-09-07") => {
    const id = `${member}-${version}-${date}`;
    db.prepare("INSERT INTO daily_submissions VALUES(?,?,?,?,?,?,?,?,?)").run(id, member[0], member, date, version, JSON.stringify(work), JSON.stringify(completed), skip ? "skip" : "office", skip);
    return id;
  };
  return { db, raw, api, delivery, submit, calls, behavior, SlackMessageError };
}

test("default ON/noon migration preserves settings and is LF-only", (t) => {
  const { db, api } = harness(t);
  assert.ok(!migration.includes("\r"));
  assert.deepEqual({ ...db.prepare("SELECT summary_enabled,summary_time,timezone FROM slack_daily_settings WHERE owner_id='a'").get() }, { summary_enabled: 1, summary_time: "12:00", timezone: "Asia/Seoul" });
  assert.deepEqual(api.parseDigestSettings({ summaryEnabled: false, summaryTime: "23:59" }), { summaryEnabled: false, summaryTime: "23:59" });
  for (const summaryTime of ["24:00", "12:60", "9:00", "", null, 1200]) assert.throws(() => api.parseDigestSettings({ summaryTime }));
  assert.throws(() => api.parseDigestSettings({ summaryEnabled: "false" }));
});

test("latest submitted Task snapshots, correct KR paths, Routine and unlinked buckets, member names and deduplication", async (t) => {
  const h = harness(t);
  h.submit("a1", [task("a-t1")]);
  const id = h.submit("a1", [task("a-t1", true), task("a-t2"), task("a-r"), task("a-inbox"), { id: "a-p", kind: "project" }, { id: "routine", kind: "routine" }], [task("a-t1")], null, 2);
  h.db.prepare("INSERT INTO daily_task_snapshots VALUES('snapshot',?,?,?,?)").run(id, "a-t2", "a-p", "project");
  h.submit("a2", [task("a-t2")]);
  h.submit("b1", [task("b-t1")]);
  const digest = await h.api.loadDailyDigest(h.raw, "a", "2026-09-07");
  assert.equal(digest.completed, 1); assert.equal(digest.planned, 3);
  assert.deepEqual(digest.groups.map((group) => [group.id, group.completed, group.planned]), [["a-kr", 1, 1], ["routines", 0, 1], ["unlinked", 0, 1]]);
  assert.deepEqual(digest.members.map((member) => [member.name, member.completed, member.planned]), [["한글 이름 1", 1, 3], ["한글 이름 2", 0, 1]]);
  h.db.exec("UPDATE workspace_members SET display_name='바뀐 이름' WHERE id='a1'");
  assert.ok((await h.api.loadDailyDigest(h.raw, "a", "2026-09-07")).members.some((member) => member.name === "바뀐 이름"));
});

test("all submitted sends early once per channel, including a skip; scheduler and resubmission do not duplicate", async (t) => {
  const h = harness(t);
  h.submit("a1", [task("a-t1")]);
  await h.api.runDueDailyDigests(h.raw, NOW, "a"); assert.equal(h.calls.length, 0);
  h.submit("a2", [], [], "vacation");
  await h.api.runDueDailyDigests(h.raw, NOW, "a");
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].channel, "C-a");
  assert.match(h.calls[0].text, /공유 2\/2명/); assert.match(h.calls[0].text, /스킵/);
  h.submit("a1", [task("a-t2")], [], null, 2);
  await h.api.runDueDailyDigests(h.raw, NOON, "a"); assert.equal(h.calls.length, 1);
});

test("deadline shares zero submissions and prominently marks each missing member rather than counting them as zero", async (t) => {
  const h = harness(t);
  await h.api.runDueDailyDigests(h.raw, new Date(NOON.getTime() - 60000), "a"); assert.equal(h.calls.length, 0);
  await h.api.runDueDailyDigests(h.raw, NOON, "a"); assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].text, /\*미공유 2명\*/); assert.match(h.calls[0].text, /한글 이름 1: \*미공유\*/);
  assert.doesNotMatch(h.calls[0].text, /한글 이름 1: 0건|다른 팀/);
});

test("disabled, unconfigured, off-day, deleted workspace, no targets or no channels never send", async (t) => {
  const h = harness(t);
  for (const sql of ["UPDATE slack_daily_settings SET summary_enabled=0", "UPDATE slack_daily_settings SET enabled=0", "UPDATE slack_daily_settings SET onboarding_completed_at=NULL", "UPDATE slack_daily_settings SET weekdays='[0]'", "UPDATE workspaces SET scheduled_deletion_at='later'", "UPDATE workspace_members SET status='removed'", "DELETE FROM slack_member_links", "DELETE FROM slack_daily_channels", "INSERT INTO slack_daily_preferences VALUES('a','a1',0),('a','a2',0)"]) {
    h.db.exec("SAVEPOINT test_case"); h.db.exec(sql);
    await h.api.runDueDailyDigests(h.raw, NOON, "a"); assert.equal(h.calls.length, 0, sql);
    h.db.exec("ROLLBACK TO test_case; RELEASE test_case");
  }
});

test("timezone local date, configured deadline and scheduled day are respected", async (t) => {
  const h = harness(t);
  assert.deepEqual(h.api.digestClock(new Date("2026-09-07T01:00:00Z"), "America/Los_Angeles"), { date: "2026-09-06", time: "18:00", weekday: 0 });
  h.db.exec("UPDATE slack_daily_settings SET summary_time='13:30' WHERE owner_id='a'");
  await h.api.runDueDailyDigests(h.raw, NOON, "a"); assert.equal(h.calls.length, 0);
  await h.api.runDueDailyDigests(h.raw, new Date("2026-09-07T04:30:00Z"), "a"); assert.equal(h.calls.length, 1);
});

test("queued pages persist atomically and concurrent attempts reuse one immutable daily snapshot", async (t) => {
  const h = harness(t);
  const input = { ownerId: "a", channel: "C-a", date: "2026-09-07", memberIds: ["a1", "a2"], pages: [{ text: "page1", blocks: [] }, { text: "page2", blocks: [] }], expiresAt: new Date(NOON.getTime() + 3600000).toISOString() };
  h.db.exec("CREATE TRIGGER fail_page BEFORE INSERT ON slack_bot_deliveries WHEN NEW.event_key LIKE '%/0' BEGIN SELECT RAISE(ABORT,'failure'); END;");
  await assert.rejects(() => h.delivery.queueDailyDigest(h.raw, input, NOW), /failure/);
  assert.equal(h.db.prepare("SELECT count(*) n FROM slack_bot_deliveries").get().n, 0);
  h.db.exec("DROP TRIGGER fail_page");
  await h.delivery.queueDailyDigest(h.raw, input, NOW);
  await h.delivery.queueDailyDigest(h.raw, { ...input, pages: [...input.pages, { text: "new page", blocks: [] }] }, NOW);
  assert.equal(h.db.prepare("SELECT count(*) n FROM slack_bot_deliveries").get().n, 2);
  await Promise.all([h.delivery.runDueSlackBotDeliveries(h.raw, NOW), h.delivery.runDueSlackBotDeliveries(h.raw, NOW)]);
  assert.equal(h.calls.length, 2); assert.deepEqual(new Set(h.calls.map((call) => call.text)), new Set(["page1", "page2"]));
});

test("pending summaries cancel after member removal, channel removal, disabling or day rollover", async (t) => {
  const h = harness(t);
  for (const change of ["UPDATE workspace_members SET status='removed' WHERE id='a1'", "DELETE FROM slack_daily_channels WHERE owner_id='a'", "UPDATE slack_daily_settings SET summary_enabled=0 WHERE owner_id='a'", "midnight"]) {
    h.db.exec("SAVEPOINT policy_case");
    await h.delivery.queueDailyDigest(h.raw, { ownerId: "a", channel: "C-a", date: "2026-09-07", memberIds: ["a1", "a2"], pages: [{ text: "snapshot", blocks: [] }], expiresAt: "2026-09-09T00:00:00Z" }, NOW);
    if (change === "midnight") t.mock.timers.setTime(new Date("2026-09-07T15:01:00Z").getTime()); else h.db.exec(change);
    await h.delivery.runDueSlackBotDeliveries(h.raw, NOW);
    assert.equal(h.calls.length, 0, change);
    assert.equal(h.db.prepare("SELECT status FROM slack_bot_deliveries").get().status, "cancelled");
    t.mock.timers.setTime(NOW.getTime()); h.db.exec("ROLLBACK TO policy_case; RELEASE policy_case");
  }
});

test("confirmed rate limits retry, unknown outcomes never automatically duplicate", async (t) => {
  const h = harness(t);
  h.behavior.fail = new h.SlackMessageError("slow down", "rejected", 60);
  await h.api.runDueDailyDigests(h.raw, NOON, "a"); assert.equal(h.calls.length, 1);
  assert.equal(h.db.prepare("SELECT status FROM slack_bot_deliveries").get().status, "retry");
  h.behavior.fail = null;
  await h.delivery.runDueSlackBotDeliveries(h.raw, new Date(NOON.getTime() + 60000)); assert.equal(h.calls.length, 2);
  h.behavior.fail = new h.SlackMessageError("unknown", "uncertain");
  await h.api.runDueDailyDigests(h.raw, NOON, "b"); assert.equal(h.calls.length, 3);
  await h.delivery.runDueSlackBotDeliveries(h.raw, new Date(NOON.getTime() + 600000)); assert.equal(h.calls.length, 3);
});

test("large teams and KR lists preserve every row within Slack limits, escape mentions, and translate all headings", async (t) => {
  const h = harness(t);
  const digest = { date: "2026-09-07", completed: 0, planned: 0, members: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, name: `<@everyone> *member* ${i}`, shared: false, skipped: false, completed: 0, planned: 0 })), groups: Array.from({ length: 300 }, (_, i) => ({ id: `kr${i}`, title: `KR-${i} ${"x".repeat(150)}`, completed: 0, planned: 0 })) };
  const pages = h.api.dailyDigestMessages(digest, translator);
  assert.ok(pages.length > 1);
  const text = pages.flatMap((page) => page.blocks.map((block) => block.text.text)).join("\n");
  for (const page of pages) { assert.ok(page.blocks.length <= 50); for (const block of page.blocks) assert.ok(block.text.text.length <= 3000); }
  for (let i = 0; i < 300; i++) assert.match(text, new RegExp(`KR-${i} `));
  assert.doesNotMatch(text, /<@everyone>/); assert.match(text, /&lt;@everyone&gt;/);
  const normal = await h.api.loadDailyDigest(h.raw, "a", "2026-09-07"); normal.members.forEach((member) => { member.name = "Member"; });
  for (const language of ["en", "ja", "zh", "es"]) {
    const pages = h.api.dailyDigestMessages(normal, await serverLanguage.serverTranslator(language));
    assert.doesNotMatch(pages[0].text, /[가-힣]/);
  }
});
