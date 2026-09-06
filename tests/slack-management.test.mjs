import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileLanguageModule as compile, serverLanguage } from "./helpers/language-fixture.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const labels = compile(await read("lib/property-label.ts"));
const editor = compile(await read("lib/slack-management-editor.ts"), { "./property-label": labels });
const report = compile(await read("lib/slack-management-report.ts"));
const actionSource = await read("lib/slack-management-actions.ts");
const routeSource = await read("app/api/slack/interactions/route.ts");
const tKo = await serverLanguage.serverTranslator("ko");
const select = (id, value) => ({ [id]: { [id]: { selected_option: value === null ? null : { value } } } });
const input = (id, value) => ({ [id]: { [id]: { value } } });
const date = (id, value) => ({ [id]: { [id]: { selected_date: value } } });
const multi = (id, values) => ({ [id]: { [id]: { selected_options: values.map((value) => ({ value })) } } });
const actor = { authorization: { ownerId: "ws", userId: "user", role: "owner" }, memberId: "m1", teamId: "T1", slackUserId: "U1" };

function harness(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, scheduled_deletion_at TEXT);
    CREATE TABLE workspace_members(id TEXT PRIMARY KEY, workspace_id TEXT, display_name TEXT, role TEXT, status TEXT, user_id TEXT, updated_at TEXT);
    CREATE TABLE slack_member_links(owner_id TEXT, member_id TEXT, team_id TEXT, slack_user_id TEXT);
    CREATE TABLE slack_connections(owner_id TEXT, team_id TEXT);
    CREATE TABLE items(id TEXT PRIMARY KEY, owner_id TEXT, kind TEXT, title TEXT, parent_id TEXT, status TEXT, priority TEXT, progress REAL, due_date TEXT, archived_at TEXT, updated_at TEXT);
    CREATE TABLE item_assignments(id TEXT PRIMARY KEY, owner_id TEXT, item_id TEXT REFERENCES items(id), member_id TEXT REFERENCES workspace_members(id), role TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE property_definitions(id TEXT PRIMARY KEY, owner_id TEXT, name TEXT, type TEXT, options TEXT, system_key TEXT, active INTEGER, sort_order INTEGER, updated_at TEXT);
    CREATE TABLE item_property_values(id TEXT PRIMARY KEY, owner_id TEXT, item_id TEXT REFERENCES items(id), property_id TEXT REFERENCES property_definitions(id), value TEXT, updated_at TEXT, UNIQUE(owner_id,item_id,property_id));
    CREATE TABLE slack_work_command_operations(request_id TEXT PRIMARY KEY, owner_id TEXT, team_id TEXT, slack_user_id TEXT, command TEXT, target_id TEXT, status TEXT, result_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE activity_log(id TEXT PRIMARY KEY, owner_id TEXT, item_id TEXT REFERENCES items(id), action TEXT, source TEXT, payload TEXT, created_at TEXT);
    INSERT INTO workspaces VALUES('ws',NULL),('other',NULL);
    INSERT INTO workspace_members VALUES('m1','ws','장재욱','owner','active','user','1'),('m2','ws','조성배','member','active','user2','1'),('mx','other','외부','owner','active','other','1');
    INSERT INTO slack_member_links VALUES('ws','m1','T1','U1');
    INSERT INTO slack_connections VALUES('ws','T1');
    INSERT INTO items VALUES('p','ws','project','전체 대시보드','ini','in_progress','medium',20,NULL,NULL,'1'),('task','ws','task','KR 연결','p','todo','medium',0,NULL,NULL,'1'),('foreign','other','project','비공개',NULL,'todo','low',0,NULL,NULL,'1');
    INSERT INTO item_assignments VALUES('a','ws','p','m1','project_dri','1','1'),('worker','ws','p','m1','project_worker','1','1');`);
  for (const [index, type] of ["text", "number", "select", "date", "checkbox", "member", "members"].entries()) {
    db.prepare("INSERT INTO property_definitions VALUES(?,?,?,?,?,NULL,1,?,'1')").run(type, "ws", type === "select" ? "분류" : `사용자 ${type}`, type, '["운영","개발","HR"]', index);
  }
  db.exec(`INSERT INTO property_definitions VALUES('sys','ws','우리 팀 상태','select','[]','status',1,20,'1'),('inactive','ws','이전 분류','text','[]',NULL,0,21,'1');
    INSERT INTO item_property_values VALUES('v','ws','p','inactive','"보존"','1');`);
  const behavior = { canWrite: true, failAt: -1, loseResponse: false }, queue = [], calls = [], automations = [], refreshes = [];
  const statement = (sql, args = []) => ({
    sql, args, bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  const raw = { prepare: statement, async batch(statements) {
    db.exec("BEGIN");
    try {
      const result = [];
      for (const [i, stmt] of statements.entries()) {
        if (behavior.failAt === i) throw new Error("injected database failure");
        result.push(await stmt.run());
      }
      db.exec("COMMIT");
      if (behavior.loseResponse) throw new Error("lost response after commit");
      return result;
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  } };
  const api = compile(actionSource, {
    "cloudflare:workers": { env: { DB: raw, OKRPTR_APP_URL: "https://okrptr.example" }, waitUntil: (promise) => queue.push(promise) },
    "./slack-management-editor": editor,
    "./pace-data": { getSlackConnection: async () => ({ teamId: "T1" }), dispatchSlackAutomationEvent: async (...args) => automations.push(args) },
    "./billing": { memberCanWrite: async () => behavior.canWrite },
    "./slack-daily": { slackTokenForConnection: async () => "mock", slackApi: async (_token, method, payload) => { calls.push({ method, payload }); return { ok: true, view: { id: "V1", hash: "hash" } }; } },
    "./workspace-management-bot": { refreshManagementReport: async (...args) => refreshes.push(args) },
    "./slack-task-changes": { runDueTaskChanges: async () => {} },
  });
  const flush = async () => { while (queue.length) await Promise.all(queue.splice(0)); };
  const open = async (id = "p", who = actor) => {
    await api.openManagementEditor(who, "trigger", id, { channel: "C1", ts: "1.0001" }, tKo);
    assert.equal(calls.at(-1).method, "views.open", "consume trigger before expensive form reads");
    await flush();
    return calls.at(-1).payload.view;
  };
  const snapshot = async (id = "p") => JSON.parse(await api.readManagementSnapshot(raw, "ws", id));
  t.after(() => db.close());
  return { db, raw, api, open, snapshot, flush, calls, automations, refreshes, behavior };
}

test("opening preserves missing values; native inputs use actual seven property types and labels", async (t) => {
  const { open, db } = harness(t), view = await open();
  assert.equal(view.callback_id, "management_submit");
  assert.equal(view.blocks.find((b) => b.block_id === "mg_status").label.text, "우리 팀 상태");
  assert.equal(view.blocks.find((b) => b.block_id === "mg_prop_select").label.text, "분류");
  assert.equal(view.blocks.find((b) => b.block_id === "mg_prop_select").element.type, "static_select", "ordinary lists search locally without an extra Slack callback");
  assert.equal(view.blocks.find((b) => b.block_id === "mg_due").element.initial_date, undefined);
  assert.equal(view.blocks.filter((b) => b.type === "input").length, 11);
  assert.equal(db.prepare("SELECT count(*) n FROM activity_log").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM item_property_values").get().n, 1, "no defaults applied merely by opening");
  assert.equal(db.prepare("SELECT due_date FROM items WHERE id='p'").get().due_date, null);
});

test("one atomic save edits all seven types, preserves zero/false/participants and does not complete children", async (t) => {
  const { open, api, db } = harness(t), view = await open();
  const state = { ...select("mg_member", "m2"), ...select("mg_status", "done"), ...select("mg_priority", "high"), ...date("mg_due", "2026-09-06"),
    ...input("mg_prop_text", "직접 입력"), ...input("mg_prop_number", "0"), ...select("mg_prop_select", "1"), ...date("mg_prop_date", "2026-09-07"),
    ...select("mg_prop_checkbox", "false"), ...select("mg_prop_member", "m2"), ...multi("mg_prop_members", ["m1", "m2"]) };
  const saved = await api.saveManagementEditor(actor, view.private_metadata, state);
  assert.equal(saved.values.assignee, "m2");
  assert.equal(db.prepare("SELECT status,progress FROM items WHERE id='p'").get().status, "done");
  assert.equal(db.prepare("SELECT progress FROM items WHERE id='p'").get().progress, 100);
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
  assert.equal(db.prepare("SELECT member_id FROM item_assignments WHERE role='project_dri'").get().member_id, "m2");
  assert.equal(db.prepare("SELECT member_id FROM item_assignments WHERE role='project_worker'").get().member_id, "m1");
  const values = Object.fromEntries(db.prepare("SELECT property_id,value FROM item_property_values").all().map((r) => [r.property_id, JSON.parse(r.value)]));
  assert.deepEqual(values, { inactive: "보존", text: "직접 입력", number: 0, select: "개발", date: "2026-09-07", checkbox: false, member: "m2", members: ["m1", "m2"] });
  const activity = db.prepare("SELECT * FROM activity_log").all();
  assert.equal(activity.length, 1);
  assert.equal(activity[0].source, "slack");
  assert.equal(JSON.parse(activity[0].payload).properties.number, 0);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("partial batch failure rolls back all edits and retry/lost-response/replay saves once", async (t) => {
  const { open, api, db, behavior } = harness(t), view = await open();
  const state = { ...date("mg_due", "2026-09-08"), ...select("mg_member", "m2"), ...input("mg_prop_number", "0") };
  behavior.failAt = 4;
  await assert.rejects(api.saveManagementEditor(actor, view.private_metadata, state), /injected/);
  assert.equal(db.prepare("SELECT due_date FROM items WHERE id='p'").get().due_date, null);
  assert.equal(db.prepare("SELECT member_id FROM item_assignments WHERE role='project_dri'").get().member_id, "m1");
  assert.equal(db.prepare("SELECT count(*) n FROM activity_log").get().n, 0);
  assert.equal(db.prepare("SELECT status FROM slack_work_command_operations").get().status, "draft");
  behavior.failAt = -1; behavior.loseResponse = true;
  assert.equal((await api.saveManagementEditor(actor, view.private_metadata, state)).repeated, true);
  assert.equal((await api.saveManagementEditor(actor, view.private_metadata, select("mg_member", "m1"))).values.assignee, "m2");
  assert.equal(db.prepare("SELECT count(*) n FROM activity_log").get().n, 1);
});

test("clearing optional values is explicit and no-op saves create no activity", async (t) => {
  const { open, api, db } = harness(t);
  db.exec(`UPDATE items SET due_date='2026-09-10' WHERE id='p'; INSERT INTO item_property_values VALUES('vv','ws','p','number','0','1');`);
  let view = await open();
  await api.saveManagementEditor(actor, view.private_metadata, {});
  assert.equal(db.prepare("SELECT count(*) n FROM activity_log").get().n, 0);
  view = await open();
  await api.saveManagementEditor(actor, view.private_metadata, { ...select("mg_member", null), ...date("mg_due", null), ...input("mg_prop_number", "") });
  assert.equal(db.prepare("SELECT due_date FROM items WHERE id='p'").get().due_date, null);
  assert.equal(db.prepare("SELECT count(*) n FROM item_assignments WHERE role='project_dri'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM item_property_values WHERE property_id='number'").get().n, 0);
});

for (const [label, sql] of [
  ["item edited", "UPDATE items SET updated_at='2',title='다른 수정' WHERE id='p'"],
  ["item archived", "UPDATE items SET archived_at='2' WHERE id='p'"],
  ["property options changed", "UPDATE property_definitions SET options='[\"재무\"]' WHERE id='select'"],
  ["property removed", "DELETE FROM property_definitions WHERE id='number'"],
  ["member removed", "UPDATE workspace_members SET status='removed' WHERE id='m2'"],
  ["assignee changed", "UPDATE item_assignments SET member_id='m2' WHERE id='a'"],
]) test(`stale ${label} cannot be overwritten`, async (t) => {
  const { open, api, db } = harness(t), view = await open();
  db.exec(sql);
  await assert.rejects(api.saveManagementEditor(actor, view.private_metadata, date("mg_due", "2026-09-08")), /변경/);
  assert.equal(db.prepare("SELECT due_date FROM items WHERE id='p'").get().due_date, null);
  assert.equal(db.prepare("SELECT count(*) n FROM activity_log").get().n, 0);
});

test("viewer, editor seat, cross-tenant, Slack relink and expiry are rejected without writes", async (t) => {
  const { open, api, db, behavior, raw } = harness(t), view = await open();
  await assert.rejects(api.saveManagementEditor({ ...actor, authorization: { ...actor.authorization, role: "viewer" } }, view.private_metadata, {}), /권한/);
  behavior.canWrite = false;
  await assert.rejects(api.saveManagementEditor(actor, view.private_metadata, {}), /권한/);
  behavior.canWrite = true;
  await assert.rejects(api.readManagementSnapshot(raw, "ws", "foreign"), /접근/);
  await assert.rejects(api.saveManagementEditor({ ...actor, slackUserId: "U2" }, view.private_metadata, {}), /권한/);
  db.exec("UPDATE slack_work_command_operations SET created_at='2000-01-01T00:00:00Z'");
  await assert.rejects(api.saveManagementEditor(actor, view.private_metadata, {}), /만료/);
  assert.equal(db.prepare("SELECT count(*) n FROM activity_log").get().n, 0);
});

test("invalid input, bad dates, foreign members and option values never mutate; retry retains all entries", async (t) => {
  const { open, api, db, snapshot } = harness(t), view = await open();
  for (const state of [date("mg_due", "2026-02-31"), select("mg_member", "mx"), input("mg_prop_number", "NaN"), select("mg_prop_select", "999"), select("mg_prop_checkbox", "yes")]) {
    await assert.rejects(api.saveManagementEditor(actor, view.private_metadata, state), editor.ManagementFieldError);
  }
  const state = { ...input("mg_prop_number", "잘못된 숫자"), ...input("mg_prop_text", "작성 중인 내용"), ...select("mg_member", "m2"), ...select("mg_prop_checkbox", "false") };
  const retry = editor.managementEditorView(await snapshot(), view.private_metadata, editor.editableManagementProperties(await snapshot()).map((p) => p.id), tKo, { state, error: "입력값을 확인해 주세요.", errorField: "mg_prop_number" });
  assert.equal(retry.blocks.find((b) => b.block_id === "mg_prop_text").element.initial_value, "작성 중인 내용");
  assert.equal(retry.blocks.find((b) => b.block_id === "mg_member").element.initial_option.text.text, "조성배");
  assert.equal(retry.blocks.find((b) => b.block_id === "mg_prop_checkbox").element.initial_option.text.text, "아니요");
  assert.equal(db.prepare("SELECT count(*) n FROM activity_log").get().n, 0);
});

test("search supports >100 choices without showing IDs or losing initial selections", async (t) => {
  const { snapshot } = harness(t), snap = await snapshot();
  snap.members.push(...Array.from({ length: 130 }, (_, n) => ({ id: `member-${n}`, display_name: `이름 ${n}`, status: "active" })));
  snap.assignments[0].member_id = "member-129";
  snap.definitions.find((p) => p.id === "select").options = JSON.stringify(Array.from({ length: 140 }, (_, n) => `선택 ${n}`));
  snap.values.push({ property_id: "select", value: '"선택 139"' });
  const ids = editor.editableManagementProperties(snap).map((p) => p.id);
  for (const state of [undefined, { ...select("mg_member", "member-129"), ...select("mg_prop_select", "139") }]) {
    const view = editor.managementEditorView(snap, "id", ids, tKo, { state });
    assert.equal(view.blocks.find((b) => b.block_id === "mg_member").element.initial_option.text.text, "이름 129");
    assert.equal(view.blocks.find((b) => b.block_id === "mg_prop_select").element.initial_option.text.text, "선택 139");
  }
  assert.equal(editor.choicesFor(snap, "mg_member", "", tKo).length, 100);
  assert.deepEqual(editor.choicesFor(snap, "mg_member", "이름 129", tKo).map((o) => o.value), ["member-129"]);
  snap.values.push({ property_id: "members", value: JSON.stringify(snap.members.map((m) => m.id)) });
  assert.ok(!editor.editableManagementProperties(snap).some((p) => p.id === "members"), "oversized values remain untouched; use web editor instead");
});

test("Task has its own assignee/state and opens parent Project properties without changing parent", async (t) => {
  const { open, api, db } = harness(t), view = await open("task");
  assert.equal(view.blocks.filter((b) => b.type === "input").length, 4);
  assert.ok(view.blocks.some((b) => b.elements?.some((e) => e.action_id === "management_parent" && e.value === "p")));
  assert.deepEqual(await api.managementEditorSource(actor, view.private_metadata, "p", true), { channel: "C1", ts: "1.0001" });
  await assert.rejects(api.managementEditorSource(actor, view.private_metadata, "foreign", true), /접근/);
  await assert.rejects(api.saveManagementEditor(actor, view.private_metadata, select("mg_status", "in_progress")), editor.ManagementFieldError);
  await api.saveManagementEditor(actor, view.private_metadata, { ...select("mg_status", "done"), ...select("mg_member", "m2") });
  assert.equal(db.prepare("SELECT status FROM items WHERE id='p'").get().status, "in_progress");
  assert.equal(db.prepare("SELECT progress FROM items WHERE id='task'").get().progress, 100);
  assert.equal(db.prepare("SELECT member_id FROM item_assignments WHERE role='task_assignee'").get().member_id, "m2");
});

test("Tasks under Routine or archived Project never offer an invalid parent Project form", async (t) => {
  const { open, db } = harness(t);
  for (const sql of ["UPDATE items SET kind='routine' WHERE id='p'", "UPDATE items SET kind='project',archived_at='2' WHERE id='p'"]) {
    db.exec(sql);
    const view = await open("task");
    assert.ok(!view.blocks.some((b) => b.elements?.some((e) => e.action_id === "management_parent")));
  }
});

test("async submission acknowledges separately, refreshes existing report and dispatches only actual Task status changes", async (t) => {
  const { open, api, flush, calls, automations, refreshes } = harness(t), view = await open("task");
  api.finishManagementSubmission(actor, "V1", view.private_metadata, { ...select("mg_status", "done") }, tKo);
  await flush();
  assert.equal(calls.at(-1).payload.view.blocks[0].text.text, "업무 정보를 저장했습니다.");
  assert.equal(automations.length, 1);
  assert.deepEqual(refreshes, [["ws", "C1", "1.0001"]]);
  const next = await open("task");
  api.finishManagementSubmission(actor, "V1", next.private_metadata, date("mg_due", "2026-09-10"), tKo);
  await flush();
  assert.equal(automations.length, 1, "property-only edits must not generate completion events");
});

function sampleReport() {
  const items = [
    { id: "p", kind: "project", title: "긴 제목 <!channel> <@UOTHER> &".repeat(30), dueDate: "2026-09-03", isOverdue: true },
    { id: "task", kind: "task", title: "KR 연결", dueDate: "2026-09-04", isOverdue: true, parentProject: { title: "전체 대시보드" } },
    { id: "today", kind: "task", title: "오늘 할 일", dueDate: "2026-09-06", isOverdue: false },
  ];
  return { workspace: "워크스페이스", date: "2026-09-06", appUrl: "https://okrptr.example",
    groups: [{ signal: "missing_owner", count: 3, items }, { signal: "overdue", count: 2, items: items.slice(0, 2) }, { signal: "due_today", count: 1, items: [items[2]] }],
    assignees: Object.fromEntries(items.map((i) => [i.id, [{ name: "조성배", slackId: "U123" }]])) };
}
test("reports put urgency first, dedupe work and real mentions, keep Task parent context and unbold project titles", () => {
  const blocks = report.managementReportBlocks(sampleReport(), tKo), raw = JSON.stringify(blocks);
  const rows = blocks.filter((b) => b.accessory);
  assert.deepEqual(rows.map((b) => b.accessory.value), ["p", "task", "today"]);
  assert.equal(raw.match(/<@U123>/g).length, 1);
  assert.doesNotMatch(raw, /<!channel>|<@UOTHER>/);
  assert.match(raw, /&lt;!channel&gt;/);
  assert.match(raw, /Project · 전체 대시보드/);
  assert.ok(!rows[0].text.text.startsWith("*"));
  assert.doesNotMatch(JSON.stringify(report.managementReportBlocks({ ...sampleReport(), mentions: false }, tKo)), /<@U123>/);
});

for (const locale of ["ko", "en", "ja", "zh", "es"]) test(`${locale} native form and report stay within Block Kit limits with long titles`, async (t) => {
  const { snapshot } = harness(t), snap = await snapshot(), tr = await serverLanguage.serverTranslator(locale);
  snap.item.title = "긴 한글 제목 English 中文 日本語 ".repeat(300);
  for (let i = 0; i < 120; i++) snap.definitions.push({ id: `extra${i}`, name: "사용자 정의 이름".repeat(40), type: "text", active: 1, options: "[]", system_key: null });
  const view = editor.managementEditorView(snap, "id", editor.editableManagementProperties(snap).map((p) => p.id), tr);
  assert.ok(view.title.text.length <= 24);
  assert.ok(view.blocks.length <= 100);
  for (const block of view.blocks) {
    assert.ok((block.text?.text.length ?? 0) <= 3000);
    assert.ok((block.label?.text.length ?? 0) <= 200);
    assert.ok((block.element?.options?.length ?? 0) <= 100);
  }
  const data = sampleReport();
  data.groups[1].items.push(...Array.from({ length: 100 }, (_, i) => ({ id: `extra${i}`, kind: "task", title: "제목", isOverdue: false })));
  const blocks = report.managementReportBlocks(data, tr);
  assert.ok(blocks.length <= 50);
  assert.equal(blocks.filter((b) => b.accessory).length, 10);
  for (const b of blocks) assert.ok((b.text?.text.length ?? 0) <= (b.type === "header" ? 150 : 3000));
  assert.equal(blocks.at(-1).elements[0].url, "https://okrptr.example/?settings=workspace&tab=summary");
});

test("interaction route checks signatures and scope before editor access; suggestions and submissions acknowledge without waiting on saves", async () => {
  const calls = [], flags = { signed: true, connected: true, linked: true };
  const route = compile(routeSource, {
    "cloudflare:workers": { env: { DB: {}, SLACK_SIGNING_SECRET: "mock" }, waitUntil: () => {} },
    "@/lib/daily-bot": {}, "@/lib/slack-daily-checklist": {}, "@/lib/slack-work-command": {},
    "@/lib/pace-data": { getSlackConnectionByTeam: async (id) => { calls.push(["team", id]); return flags.connected ? { ownerId: "ws" } : null; } },
    "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => flags.signed },
    "@/lib/language-preferences": { memberMessageLanguage: async () => "ko", workspaceMessageLanguage: async () => "ko" },
    "@/lib/server-language": serverLanguage,
    "@/lib/slack-daily": { dailyMemberBySlack: async () => flags.linked ? actor : null, createSlackMemberLinkUrl: async () => "https://example.test/link",
      externalTaskOptions: async () => [{ value: "daily-option" }], openDailyModal: async () => calls.push(["daily"]) },
    "@/lib/slack-management-actions": {
      openManagementEditor: async (...args) => calls.push(["open", ...args]),
      managementEditorOptions: async (...args) => { calls.push(["options", ...args]); return { options: [{ value: "m2" }] }; },
      finishManagementSubmission: (...args) => { calls.push(["save", ...args]); return new Promise(() => {}); },
      managementStatusView: (message) => ({ type: "modal", title: { type: "plain_text", text: message } }),
    },
  });
  const request = (payload) => new Request("https://example.test/api/slack/interactions", { method: "POST", body: new URLSearchParams({ payload: JSON.stringify({ team: { id: "T1" }, user: { id: "U1" }, ...payload }) }) });
  const action = { type: "block_actions", trigger_id: "trigger", actions: [{ action_id: "management_edit", value: "p" }], container: { channel_id: "C1", message_ts: "1.01" } };
  flags.signed = false;
  assert.equal((await route.POST(request(action))).status, 401);
  assert.equal(calls.length, 0);
  flags.signed = true; flags.connected = false;
  assert.equal((await route.POST(request(action))).status, 403);
  flags.connected = true; flags.linked = false;
  assert.match((await (await route.POST(request(action))).json()).text, /계정을 먼저 연결/);
  assert.equal(calls.filter((c) => c[0] === "open").length, 0);
  flags.linked = true;
  assert.equal((await route.POST(request(action))).status, 200);
  const opened = calls.find((c) => c[0] === "open");
  assert.equal(opened[1].authorization.ownerId, "ws");
  assert.deepEqual(opened[4], { channel: "C1", ts: "1.01" });
  const choices = await (await route.POST(request({ type: "block_suggestion", action_id: "mg_member", value: "조", view: { private_metadata: "draft" } }))).json();
  assert.deepEqual(choices, { options: [{ value: "m2" }] });
  const saved = await (await route.POST(request({ type: "view_submission", view: { id: "V1", private_metadata: "draft", callback_id: "management_submit", state: { values: date("mg_due", "2026-09-10") } } }))).json();
  assert.equal(saved.response_action, "update");
  assert.equal(calls.filter((c) => c[0] === "save").length, 1);
  assert.deepEqual(await (await route.POST(request({ type: "block_suggestion", action_id: "selected_today_work", value: "" }))).json(), { options: [{ value: "daily-option" }] });
  await route.POST(request({ type: "block_actions", trigger_id: "trigger", actions: [{ action_id: "daily_open" }] }));
  assert.ok(calls.some((c) => c[0] === "daily"));
});
