import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { preferences, serverLanguage } from "./helpers/language-fixture.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
function compile(source, dependencies = {}) {
  const loaded = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "module", "exports", code)((name) => {
    if (!(name in dependencies)) throw new Error(`Unmocked dependency ${name}`);
    return dependencies[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}
const transport = compile(await read("../lib/slack-automation.ts"));
const source = await read("../lib/slack-bot-delivery.ts");
const managementSource = await read("../lib/workspace-management-bot.ts");
const managementReport = compile(await read("../lib/slack-management-report.ts"));
const dailySource = await read("../lib/slack-daily.ts");
const files = await readdir(new URL("../drizzle/", import.meta.url));
const migrationName = files.find((name) => name.endsWith("_slack_bot_deliveries.sql"));
assert.ok(migrationName, "generated delivery migration must exist");
const migration = await read(`../drizzle/${migrationName}`);
const NOW = new Date("2026-09-03T01:00:00.000Z");

function harness(t) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, name TEXT, scheduled_deletion_at TEXT);
    CREATE TABLE slack_connections(id TEXT PRIMARY KEY, owner_id TEXT, team_id TEXT, connected_at TEXT, encrypted_bot_token TEXT);
    CREATE TABLE workspace_management_bot_settings(owner_id TEXT PRIMARY KEY, enabled INTEGER, weekdays TEXT, report_time TEXT, timezone TEXT,
      channel_id TEXT, channel_name TEXT, signals TEXT, last_sent_date TEXT, last_sent_at TEXT, last_error TEXT DEFAULT '', updated_at TEXT);
    CREATE TABLE items(id TEXT PRIMARY KEY, owner_id TEXT, parent_id TEXT, kind TEXT, title TEXT, status TEXT, due_date TEXT, archived_at TEXT);
    CREATE TABLE item_assignments(owner_id TEXT, item_id TEXT, role TEXT, member_id TEXT);
    CREATE TABLE slack_member_links(owner_id TEXT, member_id TEXT, team_id TEXT, slack_user_id TEXT);
    CREATE TABLE activity_log(owner_id TEXT, item_id TEXT, action TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE slack_automations(id TEXT PRIMARY KEY, owner_id TEXT, active INTEGER, channel_id TEXT, trigger_type TEXT, trigger_status TEXT,
      message_template TEXT, last_triggered_at TEXT, last_delivery_status TEXT, last_error TEXT);
    CREATE TABLE slack_automation_deliveries(id TEXT PRIMARY KEY, owner_id TEXT, automation_id TEXT, item_id TEXT, status TEXT, error TEXT, sent_at TEXT);
    CREATE TABLE workspace_members(id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT, display_name TEXT);
    CREATE TABLE slack_daily_channels(owner_id TEXT, channel_id TEXT);
    CREATE TABLE daily_submissions(id TEXT PRIMARY KEY, owner_id TEXT, member_id TEXT, scrum_date TEXT, version INTEGER, member_name TEXT, member_email TEXT,
      yesterday_note TEXT DEFAULT '', today_note TEXT DEFAULT '', blockers_note TEXT DEFAULT '', no_planned_tasks INTEGER DEFAULT 1,
      skip_reason TEXT, skip_note TEXT DEFAULT '', source TEXT DEFAULT 'web', submitted_at TEXT,
      work_snapshot_json TEXT DEFAULT '[]', yesterday_work_snapshot_json TEXT DEFAULT '[]');
    CREATE TABLE daily_task_snapshots(id TEXT, submission_id TEXT, sort_order INTEGER);
    CREATE TABLE slack_daily_publications(id TEXT PRIMARY KEY, owner_id TEXT, member_id TEXT, submission_id TEXT, scrum_date TEXT, channel_id TEXT,
      slack_message_ts TEXT, status TEXT DEFAULT 'pending', error TEXT DEFAULT '', attempts INTEGER DEFAULT 0, updated_at TEXT);`);
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  for (const team of ["a", "b"]) {
    db.prepare("INSERT INTO workspaces VALUES(?,?,NULL)").run(team, `팀 ${team}`);
    db.prepare("INSERT INTO slack_connections VALUES(?,?,?,?,?)").run(`con-${team}`, team, `T-${team}`, "2026-09-02T00:00:00Z", `token-${team}`);
    db.prepare(`INSERT INTO workspace_management_bot_settings VALUES(?,1,'[1,2,3,4,5]','09:00','Asia/Seoul',?,?,'["missing_owner"]',NULL,NULL,'',?)`)
      .run(team, `C-${team}`, `channel-${team}`, NOW.toISOString());
    db.prepare("INSERT INTO items(id,owner_id,kind,title,status,due_date,archived_at) VALUES(?,?,'task',?,'blocked',NULL,NULL)").run(`item-${team}`, team, `업무 ${team}`);
    db.prepare("INSERT INTO slack_automations VALUES(?,?,1,?,'task_status_changed','blocked','template',NULL,'never','')").run(`rule-${team}`, team, `C-${team}`);
    db.prepare("INSERT INTO slack_automation_deliveries VALUES(?,?,?,?,'pending','',NULL)").run(`delivery-${team}`, team, `rule-${team}`, `item-${team}`);
    db.prepare("INSERT INTO workspace_members VALUES(?,?,'active',?)").run(`member-${team}`, team, `멤버 ${team}`);
    db.prepare("INSERT INTO slack_daily_channels VALUES(?,?)").run(team, `C-${team}`);
  }
  db.exec("ALTER TABLE workspaces ADD message_language TEXT NOT NULL DEFAULT 'ko'");
  const raw = { prepare(sql) {
    const stmt = db.prepare(sql); let values = [];
    return { bind(...args) { values = args; return this; }, async first() { return stmt.get(...values) ?? null; },
      async all() { return { results: stmt.all(...values) }; }, async run() { return { meta: { changes: Number(stmt.run(...values).changes) } }; } };
  }, async batch(statements) {
    const results = [];
    db.exec("BEGIN");
    try {
      for (const statement of statements) results.push(await statement.run());
      db.exec("COMMIT");
      return results;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } };
  const calls = [], behavior = { code: {}, loseResponse: false, beforeDecrypt: null };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    assert.ok(["https://slack.com/api/chat.postMessage", "https://slack.com/api/chat.update"].includes(url));
    assert.ok(request.signal, "network calls must have a timeout");
    const payload = JSON.parse(request.body), token = request.headers.Authorization;
    calls.push({ payload, token, method: url.split("/").at(-1) });
    if (behavior.loseResponse) throw new Error("lost response after send");
    const code = behavior.code[token];
    if (code === "ratelimited") return new Response("rate limited", { status: 429, headers: { "Retry-After": "180" } });
    if (code) return Response.json({ ok: false, error: code });
    return Response.json({ ok: true, ts: payload.ts || `${calls.length}.000001` });
  };
  const api = compile(source, {
    "cloudflare:workers": { env: { DB: raw, SLACK_TOKEN_ENCRYPTION_KEY: "mock" } },
    "@/lib/slack-oauth": { decryptSlackSecret: async (token) => { await behavior.beforeDecrypt?.(); return token; } },
    "@/lib/slack-automation": transport,
  });
  const management = compile(managementSource, {
    "./slack-management-report": managementReport,
    "./language-preferences": preferences, "./server-language": serverLanguage,
    "cloudflare:workers": { env: { DB: raw } },
    "@/lib/pace-data": { getSlackConnection: async (ownerId) => db.prepare("SELECT * FROM slack_connections WHERE owner_id=?").get(ownerId) },
    "@/lib/slack-daily": { listSlackChannels: async () => [], slackTokenForConnection: async (connection) => connection.encrypted_bot_token,
      slackApi: async (token, method, payload) => { calls.push({ token: `Bearer ${token}`, method, payload }); return { ok: true }; } },
    "@/lib/slack-bot-delivery": api,
  });
  const daily = compile(dailySource, {
    "@/lib/slack-daily-digest": { runDueDailyDigests: async () => ({ checked: 0 }) },
    "./language-preferences": preferences, "./server-language": serverLanguage,
    "cloudflare:workers": { env: { DB: raw } }, "drizzle-orm": {}, "@/db": {}, "@/db/schema": {},
    "@/lib/pace-data": { getSlackConnection: async (ownerId) => db.prepare("SELECT * FROM slack_connections WHERE owner_id=?").get(ownerId) },
    "@/lib/slack-daily-status": {}, "@/lib/slack-oauth": {}, "@/lib/slack-bot-delivery": api,
    "@/lib/daily-bot": { normalizeDailySkipReason: () => null },
    "@/lib/daily-work": { dailyWorkSnapshots: (raw) => JSON.parse(raw || "[]") },
    "@/lib/slack-daily-form": { dailyWorkContainerLabel: (work, translate) => work.parentKind === "project" ? `${translate("Project")} · ${work.parentTitle}` : work.parentKind === "routine" ? `${translate("Routine")} · ${work.parentTitle}` : work.parentTitle },
    "@/lib/slack-member-matching": {}, "@/lib/slack-daily-checklist": {},
  });
  t.after(() => { globalThis.fetch = originalFetch; db.close(); });
  const input = (team = "a", overrides = {}) => ({ ownerId: team, botKind: "automation", subjectId: `delivery-${team}`, eventKey: "same-event",
    payload: { channel: `C-${team}`, text: `알림 ${team}` }, expiresAt: "2026-09-04T00:00:00.000Z", ...overrides });
  const receipt = (team = "a") => db.prepare("SELECT * FROM slack_bot_deliveries WHERE owner_id=? ORDER BY created_at DESC LIMIT 1").get(team);
  function publication(team, version = 1) {
    const submissionId = `submission-${team}-${version}`, id = `publication-${team}-${version}`;
    db.prepare(`INSERT INTO daily_submissions(id,owner_id,member_id,scrum_date,version,member_name,member_email,submitted_at)
      VALUES(?,?,?,'2026-09-03',?,?,?,?)`).run(submissionId, team, `member-${team}`, version, `멤버 ${team}`, `${team}@example.com`, NOW.toISOString());
    db.prepare(`INSERT INTO slack_daily_publications(id,owner_id,member_id,submission_id,scrum_date,channel_id,updated_at)
      VALUES(?,?,?,?,'2026-09-03',?,?)`).run(id, team, `member-${team}`, submissionId, `C-${team}`, NOW.toISOString());
    return { submissionId, id };
  }
  return { db, raw, calls, behavior, api, management, daily, publication, input, receipt };
}

test("delivery migration is additive LF and enforces tenant/event uniqueness and workspace cleanup", async (t) => {
  const { db, api, raw, input } = harness(t);
  assert.ok(!migration.includes("\r"));
  assert.doesNotMatch(migration, /^(DROP|ALTER|DELETE FROM|UPDATE )/im);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  await api.deliverSlackBotMessage(raw, input());
  await api.deliverSlackBotMessage(raw, input("b"));
  const row = db.prepare("SELECT * FROM slack_bot_deliveries WHERE owner_id='b'").get();
  row.id = "duplicate";
  assert.throws(() => db.prepare(`INSERT INTO slack_bot_deliveries (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row)), /UNIQUE/);
  db.exec("DELETE FROM workspaces WHERE id='a'");
  assert.equal(db.prepare("SELECT count(*) n FROM slack_bot_deliveries WHERE owner_id='a'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM slack_bot_deliveries WHERE owner_id='b'").get().n, 1);
});

test("overlapping requests send once and identical events in two teams use separate credentials", async (t) => {
  const { api, raw, input, calls, db } = harness(t);
  await Promise.all([api.deliverSlackBotMessage(raw, input()), api.deliverSlackBotMessage(raw, input()), api.deliverSlackBotMessage(raw, input("b"))]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => [call.token, call.payload.channel]).sort(), [["Bearer token-a", "C-a"], ["Bearer token-b", "C-b"]]);
  assert.equal(db.prepare("SELECT count(*) n FROM slack_bot_deliveries WHERE status='sent'").get().n, 2);
});

test("rate limits retain pending receipts, respect retry-after and isolate the other team", async (t) => {
  const { api, raw, input, calls, behavior, receipt } = harness(t);
  behavior.code["Bearer token-a"] = "ratelimited";
  assert.equal((await api.deliverSlackBotMessage(raw, input())).status, "retry");
  assert.equal((await api.deliverSlackBotMessage(raw, input("b"))).status, "sent");
  await api.runDueSlackBotDeliveries(raw, new Date(NOW.getTime() + 120_000));
  assert.equal(calls.length, 2);
  delete behavior.code["Bearer token-a"];
  await api.runDueSlackBotDeliveries(raw, new Date(NOW.getTime() + 181_000));
  assert.equal(receipt().status, "sent");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].payload.client_msg_id, calls[2].payload.client_msg_id);
});

test("background retries leave queued receipts intact when the request budget is exhausted", async (t) => {
  const { api, raw, input, behavior, calls, receipt } = harness(t);
  behavior.code["Bearer token-a"] = "ratelimited";
  behavior.code["Bearer token-b"] = "ratelimited";
  await api.deliverSlackBotMessage(raw, input());
  await api.deliverSlackBotMessage(raw, input("b"));
  behavior.code = {};
  behavior.beforeDecrypt = () => t.mock.timers.tick(11_000);
  const result = await api.runDueSlackBotDeliveries(raw, new Date(NOW.getTime() + 181_000));
  assert.equal(result.checked, 1);
  assert.equal(calls.length, 3);
  assert.equal(receipt().status, "sent");
  assert.equal(receipt("b").status, "retry");
});

test("management stops after a slow request and a later pass completes remaining reports", async (t) => {
  const { management, raw, calls, behavior, db } = harness(t);
  behavior.beforeDecrypt = () => t.mock.timers.tick(11_000);
  await management.runDueWorkspaceManagementBots(raw);
  assert.equal(calls.length, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM workspace_management_bot_settings WHERE last_sent_date IS NULL").get().n, 1);
  behavior.beforeDecrypt = null;
  await management.runDueWorkspaceManagementBots(raw);
  assert.equal(calls.length, 2);
});

test("lost response is uncertain, never called successful and never blindly replayed", async (t) => {
  const { api, raw, input, calls, behavior, db, receipt } = harness(t);
  behavior.loseResponse = true;
  assert.equal((await api.deliverSlackBotMessage(raw, input())).status, "uncertain");
  behavior.loseResponse = false;
  await api.deliverSlackBotMessage(raw, input());
  await api.runDueSlackBotDeliveries(raw, new Date(NOW.getTime() + 600_000));
  assert.equal(calls.length, 1);
  assert.equal(receipt().message_ts, null);
  assert.match(db.prepare("SELECT error FROM slack_automation_deliveries WHERE id='delivery-a'").get().error, /중복 방지/);
});

test("permanent Slack rejection is visible and retry attempts are bounded", async (t) => {
  const { api, raw, input, behavior, calls, receipt } = harness(t);
  behavior.code["Bearer token-a"] = "missing_scope";
  assert.equal((await api.deliverSlackBotMessage(raw, input())).status, "failed");
  behavior.code["Bearer token-b"] = "ratelimited";
  await api.deliverSlackBotMessage(raw, input("b"));
  for (let n = 1; n <= 8; n++) await api.runDueSlackBotDeliveries(raw, new Date(NOW.getTime() + n * 181_000));
  assert.equal(receipt("b").attempts, 5);
  assert.equal(receipt("b").status, "failed");
  assert.equal(calls.filter((call) => call.token === "Bearer token-a").length, 1);
});

for (const [label, mutation] of [
  ["stop rule", "UPDATE slack_automations SET active=0 WHERE owner_id='a'"],
  ["change channel", "UPDATE slack_automations SET channel_id='C-changed' WHERE owner_id='a'"],
  ["archive task", "UPDATE items SET archived_at='now' WHERE owner_id='a'"],
  ["disconnect", "DELETE FROM slack_connections WHERE owner_id='a'"],
  ["reinstall on another Slack team", "UPDATE slack_connections SET team_id='T-new', connected_at='new' WHERE owner_id='a'"],
  ["delete workspace", "UPDATE workspaces SET scheduled_deletion_at='tomorrow' WHERE id='a'"],
]) test(`${label} during preparation cancels old send without affecting another team`, async (t) => {
  const { api, raw, input, behavior, calls, db } = harness(t);
  behavior.beforeDecrypt = () => { db.exec(mutation); behavior.beforeDecrypt = null; };
  assert.equal((await api.deliverSlackBotMessage(raw, input())).status, "cancelled");
  assert.equal(calls.length, 0);
  assert.equal((await api.deliverSlackBotMessage(raw, input("b"))).status, "sent");
});

test("a stale in-flight request is not retried, but pre-send crash can safely resume", async (t) => {
  const { api, raw, input, db, calls, receipt, behavior } = harness(t);
  behavior.code["Bearer token-a"] = "ratelimited";
  await api.deliverSlackBotMessage(raw, input());
  db.prepare("UPDATE slack_bot_deliveries SET status='sending', retry_at=? WHERE owner_id='a'").run(NOW.toISOString());
  await api.runDueSlackBotDeliveries(raw);
  assert.equal(receipt().status, "uncertain");
  assert.equal(calls.length, 1);
  behavior.code["Bearer token-b"] = "ratelimited";
  await api.deliverSlackBotMessage(raw, input("b"));
  delete behavior.code["Bearer token-b"];
  db.prepare("UPDATE slack_bot_deliveries SET status='preparing', retry_at=? WHERE owner_id='b'").run(NOW.toISOString());
  await api.runDueSlackBotDeliveries(raw);
  assert.equal(receipt("b").status, "sent");
});

test("management cron is single-send per team/date and isolates malformed team configuration", async (t) => {
  const { management, raw, db, calls } = harness(t);
  db.exec("UPDATE workspace_management_bot_settings SET timezone='not/a/zone' WHERE owner_id='a'");
  await Promise.all([management.runDueWorkspaceManagementBots(raw), management.runDueWorkspaceManagementBots(raw)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.channel, "C-b");
  assert.equal(db.prepare("SELECT last_sent_date FROM workspace_management_bot_settings WHERE owner_id='b'").get().last_sent_date, "2026-09-03");
  assert.match(db.prepare("SELECT last_error FROM workspace_management_bot_settings WHERE owner_id='a'").get().last_error, /시간대/);
});

test("management obeys local weekday/time, stopped bots, deletion and current workspace scope", async (t) => {
  const { management, raw, db, calls } = harness(t);
  db.exec("UPDATE workspace_management_bot_settings SET timezone='America/Los_Angeles', report_time='20:00' WHERE owner_id='a'");
  await management.runDueWorkspaceManagementBots(raw, NOW, "a");
  assert.equal(calls.length, 0); // Los Angeles is still Wednesday 18:00.
  db.exec("UPDATE workspace_management_bot_settings SET enabled=0 WHERE owner_id='a'; UPDATE workspaces SET scheduled_deletion_at='tomorrow' WHERE id='b'");
  await management.runDueWorkspaceManagementBots(raw);
  assert.equal(calls.length, 0);
});

test("management groups tasks under projects and emphasizes project and task overdue states", async (t) => {
  const { management, raw, db, calls } = harness(t);
  db.exec("UPDATE workspace_management_bot_settings SET signals='[\"overdue\"]' WHERE owner_id='a'");
  db.prepare("INSERT INTO items VALUES(?,? ,NULL,'project',?,'in_progress',?,NULL)").run("project-overdue", "a", "출시 준비", "2026-09-01");
  db.prepare("INSERT INTO items VALUES(?,? ,?,'task',?,'in_progress',?,NULL)").run("task-overdue", "a", "project-overdue", "배포 점검", "2026-09-02");
  db.prepare("INSERT INTO items VALUES(?,? ,NULL,'project',?,'in_progress',?,NULL)").run("project-on-time", "a", "다음 분기 준비", "2026-09-10");
  db.prepare("INSERT INTO items VALUES(?,? ,?,'task',?,'todo',?,NULL)").run("task-delayed", "a", "project-on-time", "자료 정리", "2026-08-30");

  const snapshot = await management.collectWorkspaceManagementSnapshot("a", "2026-09-03", "Asia/Seoul", ["overdue"]);
  assert.equal(snapshot.groups[0].count, 3);
  assert.deepEqual(snapshot.groups[0].projects.map((group) => ({
    project: group.project?.title,
    projectOverdue: group.project?.isOverdue,
    matches: group.projectMatchesSignal,
    tasks: group.tasks.map((task) => task.title),
  })), [
    { project: "출시 준비", projectOverdue: true, matches: true, tasks: ["배포 점검"] },
    { project: "다음 분기 준비", projectOverdue: false, matches: false, tasks: ["자료 정리"] },
  ]);

  await management.runDueWorkspaceManagementBots(raw, NOW, "a");
  const rows = calls[0].payload.blocks.filter((block) => block.accessory?.action_id === "management_edit");
  const report = rows.map((block) => block.text.text).join("\n");
  assert.match(report, /출시 준비>[\s\S]*\*2일 지연\* · 2026-09-01/);
  assert.match(report, /배포 점검>[\s\S]*\*1일 지연\* · 2026-09-02\nProject · 출시 준비/);
  assert.equal(rows.length, 3);
  assert.ok(report.indexOf("출시 준비") < report.indexOf("배포 점검"));
});

test("management splits long reports without omitting work items", async (t) => {
  const { management, raw, db, calls } = harness(t);
  for (let index = 0; index < 45; index++) {
    db.prepare("INSERT INTO items(id,owner_id,kind,title,status,due_date,archived_at) VALUES(?,?,'task',?,'todo',NULL,NULL)")
      .run(`extra-${index}`, "a", `정리할 업무 ${index}`);
  }
  await management.runDueWorkspaceManagementBots(raw, NOW, "a");
  const reportCalls = calls.filter((call) => call.payload.channel === "C-a" && call.method === "chat.postMessage");
  assert.equal(reportCalls.length, 3);
  const itemIds = reportCalls.flatMap((call) => call.payload.blocks
    .filter((block) => block.accessory?.action_id === "management_edit")
    .map((block) => block.accessory.value));
  assert.equal(itemIds.length, 46);
  assert.equal(new Set(itemIds).size, 46);
  assert.ok(reportCalls.every((call) => call.payload.blocks.length <= 50));
  assert.deepEqual(reportCalls.map((call) => call.payload.blocks[0].text.text), ["관리 봇 (1/3)", "관리 봇 (2/3)", "관리 봇 (3/3)"]);
  assert.equal(db.prepare("SELECT count(*) n FROM slack_bot_deliveries WHERE owner_id='a' AND bot_kind='management' AND status='sent'").get().n, 3);
  assert.equal(db.prepare("SELECT last_sent_date FROM workspace_management_bot_settings WHERE owner_id='a'").get().last_sent_date, "2026-09-03");
});

test("management rejects invalid dates and report blocks remain within Slack limits", async (t) => {
  const { management, raw, db, calls } = harness(t);
  await assert.rejects(management.collectWorkspaceManagementSnapshot("a", "2026-02-31"), /날짜/);
  db.prepare("UPDATE items SET title=? WHERE owner_id='a'").run("긴제목<&>".repeat(2000));
  db.prepare("UPDATE workspaces SET name=? WHERE id='a'").run("긴팀명".repeat(2000));
  await management.runDueWorkspaceManagementBots(raw, NOW, "a");
  const blocks = calls[0].payload.blocks;
  assert.ok(blocks.find((block) => block.type === "section").text.text.length <= 3000);
  assert.ok(blocks.find((block) => block.type === "context").elements[0].text.length <= 2000);
  assert.ok(calls[0].payload.text.length <= 4000);
});

test("report tags only its current linked assignees, and refresh only edits its recorded message without re-mentioning", async (t) => {
  const { management, raw, db, calls } = harness(t);
  db.exec(`UPDATE workspace_management_bot_settings SET signals='["overdue"]' WHERE owner_id='a';
    UPDATE items SET due_date='2026-09-01' WHERE id='item-a';
    INSERT INTO item_assignments VALUES('a','item-a','task_assignee','member-a');
    INSERT INTO slack_member_links VALUES('a','member-a','T-a','U123'),('a','member-a','old-team','UOLD'),('b','member-b','T-b','UOTHER');`);
  await management.runDueWorkspaceManagementBots(raw, NOW, "a");
  assert.match(JSON.stringify(calls[0].payload.blocks), /<@U123>/);
  assert.doesNotMatch(JSON.stringify(calls[0].payload.blocks), /UOLD|UOTHER/);
  const receipt = db.prepare("SELECT message_ts FROM slack_bot_deliveries WHERE owner_id='a'").get();
  await management.refreshManagementReport("a", "C-b", receipt.message_ts);
  await management.refreshManagementReport("b", "C-a", receipt.message_ts);
  await management.refreshManagementReport("a", "C-a", "forged-message");
  assert.equal(calls.length, 1);
  await management.refreshManagementReport("a", "C-a", receipt.message_ts);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "chat.update");
  assert.equal(calls[1].payload.ts, receipt.message_ts);
  assert.doesNotMatch(JSON.stringify(calls[1].payload.blocks), /<@U123>/);
  db.exec("UPDATE items SET status='done' WHERE id='item-a'");
  await management.refreshManagementReport("a", "C-a", receipt.message_ts);
  assert.equal(calls[2].payload.blocks.filter((b) => b.accessory).length, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM slack_bot_deliveries").get().n, 1);
});

test("management can recover a rejected report after reconnection but never resends an uncertain report", async (t) => {
  const { management, raw, db, behavior, calls } = harness(t);
  behavior.code["Bearer token-a"] = "missing_scope";
  await management.runDueWorkspaceManagementBots(raw, NOW, "a");
  assert.equal(db.prepare("SELECT status FROM slack_bot_deliveries WHERE owner_id='a'").get().status, "failed");
  delete behavior.code["Bearer token-a"];
  db.exec("UPDATE slack_connections SET connected_at='reconnected' WHERE owner_id='a'");
  await management.runDueWorkspaceManagementBots(raw, NOW, "a");
  assert.equal(db.prepare("SELECT status FROM slack_bot_deliveries WHERE owner_id='a'").get().status, "sent");
  behavior.loseResponse = true;
  await management.runDueWorkspaceManagementBots(raw, NOW, "b");
  behavior.loseResponse = false;
  db.exec("UPDATE slack_connections SET connected_at='reconnected' WHERE owner_id='b'");
  const count = calls.length;
  await management.runDueWorkspaceManagementBots(raw, NOW, "b");
  assert.equal(calls.length, count);
});

test("daily sharing claims concurrent submissions once and edits the existing message for a new version", async (t) => {
  const { daily, publication, calls, db } = harness(t);
  const first = publication("a");
  await Promise.all([daily.publishDailySubmission("a", first.submissionId), daily.publishDailySubmission("a", first.submissionId)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "chat.postMessage");
  const second = publication("a", 2);
  await daily.publishDailySubmission("a", second.submissionId);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "chat.update");
  assert.equal(calls[1].payload.ts, "1.000001");
  assert.equal(db.prepare("SELECT status FROM slack_daily_publications WHERE id=?").get(second.id).status, "sent");
});

test("daily sharing labels completed Tasks with their Project or Routine", async (t) => {
  const { daily, publication, calls, db } = harness(t);
  const first = publication("a");
  db.prepare("UPDATE daily_submissions SET yesterday_work_snapshot_json=? WHERE id=?").run(JSON.stringify([
    { id: "project-task", key: "task:project-task", kind: "task", title: "고객 인터뷰 정리", parentKind: "project", parentId: "project", parentTitle: "서비스 개선" },
    { id: "routine-task", key: "task:routine-task", kind: "task", title: "주간 지표 입력", parentKind: "routine", parentId: "routine", parentTitle: "주간 운영" },
  ]), first.submissionId);
  await daily.publishDailySubmission("a", first.submissionId);
  const completed = calls[0].payload.blocks.find((block) => block.type === "section" && block.text.text.includes("완료한 일")).text.text;
  assert.match(completed, /\*Project · 서비스 개선\*\n• 고객 인터뷰 정리/);
  assert.match(completed, /\*Routine · 주간 운영\*\n• 주간 지표 입력/);
});

test("uncertain daily sharing cannot be retried or create a second message through a newer submission", async (t) => {
  const { daily, publication, calls, behavior, db } = harness(t);
  const first = publication("a");
  behavior.loseResponse = true;
  await daily.publishDailySubmission("a", first.submissionId);
  behavior.loseResponse = false;
  await assert.rejects(daily.retryDailyPublication("a", first.id), /중복 방지/);
  const second = publication("a", 2);
  await daily.publishDailySubmission("a", second.submissionId);
  assert.equal(calls.length, 1);
  assert.equal(db.prepare("SELECT status FROM slack_daily_publications WHERE id=?").get(second.id).status, "failed");
});

test("daily sharing ignores stale versions and foreign-tenant IDs, and honours channel removal", async (t) => {
  const { daily, publication, calls, db } = harness(t);
  const first = publication("a"), second = publication("a", 2);
  await daily.publishDailySubmission("b", second.submissionId);
  await daily.publishDailySubmission("a", first.submissionId);
  assert.equal(calls.length, 0);
  db.exec("DELETE FROM slack_daily_channels WHERE owner_id='a'");
  await daily.publishDailySubmission("a", second.submissionId);
  assert.equal(calls.length, 0);
});

test("bot writes require Owner/Admin and authenticated tenant scope before execution", async () => {
  for (const path of ["../app/api/workspace-management-bot/route.ts", "../app/api/slack/automations/route.ts", "../app/api/slack/automations/test/route.ts"]) {
    const code = await read(path);
    for (const role of ["member", "viewer"]) {
      let writes = 0;
      const api = compile(code, {
        "cloudflare:workers": { env: { DB: {} } },
        "@/lib/language-preferences": { workspaceMessageLanguage: async () => "ko" },
        "@/lib/pace-data": { authorizeRequest: async () => ({ ownerId: "b", role }), canManageTeam: (auth) => ["owner", "admin"].includes(auth.role), ensureWorkspace: async () => { writes++; } },
        "@/lib/workspace-management-bot": {},
      });
      for (const method of ["POST", "PATCH", "DELETE"]) if (api[method]) {
        const response = await api[method](new Request("https://example.com/api/bot", { method, body: JSON.stringify({ ownerId: "a", action: "test" }) }));
        assert.equal(response.status, 403);
      }
      assert.equal(writes, 0);
    }
  }
});
