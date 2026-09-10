import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/slack-daily.ts", import.meta.url), "utf8");

function compile(sourceText, deps) {
  const loaded = { exports: {} };
  const output = ts.transpileModule(sourceText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "module", "exports", output)((name) => {
    assert.ok(name in deps, `Unmocked import ${name}`);
    return deps[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TABLE workspace_members(id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, email TEXT, display_name TEXT, role TEXT, status TEXT);
    CREATE TABLE items(id TEXT PRIMARY KEY, owner_id TEXT, kind TEXT, title TEXT, status TEXT, priority TEXT, progress INTEGER, source TEXT, archived_at TEXT, updated_at TEXT);
    CREATE TABLE item_assignments(id TEXT PRIMARY KEY, owner_id TEXT, item_id TEXT, member_id TEXT, role TEXT);
    CREATE TABLE daily_submissions(id TEXT PRIMARY KEY, owner_id TEXT, member_id TEXT, member_name TEXT, member_email TEXT, scrum_date TEXT,
      version INTEGER, yesterday_note TEXT, today_note TEXT, blockers_note TEXT, no_planned_tasks INTEGER, work_status TEXT,
      skip_reason TEXT, skip_note TEXT, source TEXT, submitted_at TEXT, work_snapshot_json TEXT, yesterday_work_snapshot_json TEXT);
    CREATE TABLE daily_task_snapshots(id TEXT PRIMARY KEY, owner_id TEXT, submission_id TEXT, task_id TEXT, task_title TEXT,
      parent_kind TEXT, parent_id TEXT, parent_title TEXT, status TEXT, is_new INTEGER, sort_order INTEGER);
    CREATE TABLE slack_daily_publications(id TEXT PRIMARY KEY, owner_id TEXT, member_id TEXT, submission_id TEXT, scrum_date TEXT,
      channel_id TEXT, slack_message_ts TEXT, status TEXT, error TEXT, attempts INTEGER, updated_at TEXT);
    CREATE TABLE slack_work_command_operations(request_id TEXT PRIMARY KEY, owner_id TEXT, team_id TEXT, slack_user_id TEXT,
      command TEXT, target_id TEXT, status TEXT, result_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE activity_log(id TEXT PRIMARY KEY, owner_id TEXT, item_id TEXT, action TEXT, source TEXT, payload TEXT, created_at TEXT);
    INSERT INTO workspace_members VALUES ('member','workspace','user','member@example.test','Member','member','active');
    INSERT INTO items VALUES ('task','workspace','task','Ship the release','todo','high',0,'web',NULL,'2026-09-08T00:00:00.000Z');
    INSERT INTO item_assignments VALUES ('assignment','workspace','task','member','task_assignee');
    INSERT INTO daily_submissions VALUES ('submission','workspace','member','Member','member@example.test','2026-09-08',1,'','','',0,'office',NULL,'','slack','2026-09-08T00:00:00.000Z','[]','[]');
    INSERT INTO daily_task_snapshots VALUES ('snapshot','workspace','submission','task','Ship the release','project','project','Launch','todo',0,0);
    INSERT INTO slack_daily_publications VALUES
      ('publication-a','workspace','member','submission','2026-09-08','C-A','1.001','sent','',1,'2026-09-08T00:00:00.000Z'),
      ('publication-b','workspace','member','submission','2026-09-08','C-B','1.002','sent','',1,'2026-09-08T00:00:00.000Z');
  `);
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql); let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
      };
    },
  };
  const calls = [], events = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ url, body, authorization: request.headers.Authorization });
    return Response.json({ ok: true, ts: body.ts });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const identity = (key, values) => key.replace(/\{(\w+)\}/g, (match, name) => values && Object.hasOwn(values, name) ? String(values[name]) : match);
  const api = compile(source, {
    "cloudflare:workers": { env: { DB: db, SLACK_TOKEN_ENCRYPTION_KEY: "mock", OKRI_APP_URL: "https://okri.test" }, waitUntil() {} },
    "drizzle-orm": {}, "@/db": {}, "@/db/schema": {},
    "./language-preferences": { workspaceMessageLanguage: async () => "ko" },
    "./server-language": { serverTranslator: async () => identity },
    "@/lib/daily-bot": { dailySkipReasonLabel: () => "휴가", normalizeDailySkipReason: (value) => value },
    "@/lib/daily-work-status": { dailyWorkStatusLabel: (value) => ({ office: "출근", remote: "재택", skip: "스킵" })[value], normalizeDailyWorkStatus: (value) => value || "office" },
    "@/lib/daily-work": { dailyWorkSnapshots: (raw) => JSON.parse(raw || "[]") },
    "@/lib/slack-daily-form": { dailyWorkContainerLabel: (work) => work.parentKind === "project" ? `Project · ${work.parentTitle}` : work.parentTitle },
    "@/lib/slack-daily-checklist": {}, "@/lib/slack-member-matching": {}, "@/lib/slack-daily-status": {},
    "@/lib/pace-data": {
      getSlackConnection: async () => ({ ownerId: "workspace", teamId: "T", encryptedBotToken: "cipher" }),
      dispatchSlackAutomationEvent: async (...args) => events.push(args),
    },
    "@/lib/slack-oauth": { decryptSlackSecret: async () => "xoxb-test", slackDailyScopes: [] },
  });
  const input = (overrides = {}) => ({
    authorization: { ownerId: "workspace", userId: "user", role: "member", apiToken: false }, memberId: "member",
    teamId: "T", slackUserId: "U", channelId: "C-A", messageTs: "1.001", actionTs: "2.001",
    value: JSON.stringify({ publicationId: "publication-a", taskId: "task" }), ...overrides,
  });
  return { sqlite, db, api, calls, events, input };
}

test("shared Daily completion updates the Task and every copy of the original Slack message once", async (t) => {
  const { sqlite, api, calls, events, input } = fixture(t);
  const result = await api.completePublishedDailyTask(input());
  assert.equal(result.changed, true);
  assert.deepEqual({ ...sqlite.prepare("SELECT status,progress,source FROM items WHERE id='task'").get() }, { status: "done", progress: 100, source: "slack" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM activity_log").get().count, 1);
  assert.equal(events.length, 1);
  assert.deepEqual(calls.map((call) => [call.url.split("/").at(-1), call.body.channel, call.body.ts]), [
    ["chat.update", "C-A", "1.001"], ["chat.update", "C-B", "1.002"],
  ]);
  for (const call of calls) {
    assert.match(JSON.stringify(call.body.blocks), /~Ship the release~/);
    assert.doesNotMatch(JSON.stringify(call.body.blocks), /daily_publication_complete/);
    assert.equal(call.authorization, "Bearer xoxb-test");
  }

  const replay = await api.completePublishedDailyTask(input());
  assert.equal(replay.changed, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM activity_log").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM slack_work_command_operations").get().count, 1);
  assert.equal(events.length, 1);
});

test("shared Daily completion rejects another member, stale messages and permission changes", async (t) => {
  const { sqlite, api, input } = fixture(t);
  await assert.rejects(api.completePublishedDailyTask(input({ memberId: "other" })));
  await assert.rejects(api.completePublishedDailyTask(input({ authorization: { ownerId: "workspace", userId: "user", role: "viewer", apiToken: false } })));
  await assert.rejects(api.completePublishedDailyTask(input({ messageTs: "foreign" })));
  sqlite.exec("DELETE FROM item_assignments");
  await assert.rejects(api.completePublishedDailyTask(input()));
  assert.equal(sqlite.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");

  sqlite.exec(`INSERT INTO item_assignments VALUES ('assignment-2','workspace','task','member','task_assignee');
    INSERT INTO daily_submissions VALUES ('newer','workspace','member','Member','member@example.test','2026-09-08',2,'','','',0,'office',NULL,'','slack','2026-09-08T01:00:00.000Z','[]','[]');`);
  await assert.rejects(api.completePublishedDailyTask(input()));
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM activity_log").get().count, 0);
});

test("private Daily completion controls validate the publication without exposing its public message timestamp", async (t) => {
  const { sqlite, api, input } = fixture(t);
  const result = await api.completePublishedDailyTask(input({
    messageTs: "ephemeral-control",
    value: JSON.stringify({ publicationId: "publication-a", taskId: "task", privateControl: true }),
  }));
  assert.equal(result.changed, true);
  assert.equal(sqlite.prepare("SELECT status FROM items WHERE id='task'").get().status, "done");
});
