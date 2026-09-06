import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileLanguageModule as compile, d1Fixture, preferences, serverLanguage } from "./helpers/language-fixture.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const schema = JSON.parse(await read("drizzle/meta/0038_snapshot.json"));
const languageMigration = await read("drizzle/0046_global_language.sql");
const migration = await read("drizzle/0050_slack_manual_and_task_changes.sql");
const transport = compile(await read("lib/slack-automation.ts"));
const deliverySource = await read("lib/slack-bot-delivery.ts");
const manualSource = await read("lib/slack-daily-manual.ts");
const changeSource = await read("lib/slack-task-changes.ts");
const dailySource = await read("lib/slack-daily.ts");
const workerSource = await read("worker/index.ts");
const auth = { ownerId: "w", userId: "u", role: "owner" };
const requestId = "manual-request-0000001";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const table of Object.values(schema.tables)) {
    const columns = Object.values(table.columns).map((c) => `${c.name} ${c.type}${c.primaryKey ? " PRIMARY KEY" : ""}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${c.default}` : ""}`);
    for (const fk of Object.values(table.foreignKeys)) columns.push(`FOREIGN KEY (${fk.columnsFrom}) REFERENCES ${fk.tableTo} (${fk.columnsTo}) ON DELETE ${fk.onDelete}`);
    db.exec(`CREATE TABLE ${table.name} (${columns.join(",")})`);
    for (const index of Object.values(table.indexes)) db.exec(`CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${index.name} ON ${table.name} (${index.columns})${index.where ? ` WHERE ${index.where}` : ""}`);
  }
  for (const sql of [languageMigration, migration]) db.exec(sql.replaceAll("--> statement-breakpoint", ""));
  db.exec(`INSERT INTO workspaces(id,name,owner_user_id,message_language) VALUES ('w','Workspace','u','en'),('other','Other','other-user','ko');
    INSERT INTO workspace_members(id,workspace_id,user_id,email,display_name,role,status) VALUES
      ('me','w','u','me@example.test','Alice','owner','active'),('colleague','w','c','c@example.test','Bob','member','active'),
      ('unlinked','w','x','x@example.test','Unlinked','member','active'),('inactive','w','i','i@example.test','Inactive','member','inactive'),
      ('foreign','other','other-user','f@example.test','Foreign','owner','active');
    INSERT INTO slack_connections(id,owner_id,user_id,team_id,encrypted_bot_token) VALUES ('connection','w','u','T','mock');
    INSERT INTO slack_member_links(id,owner_id,member_id,slack_user_id,team_id,dm_channel_id) VALUES
      ('link-me','w','me','U-ME','T','D-ME'),('link-c','w','colleague','U-C','T','D-C'),('link-i','w','inactive','U-I','T','D-I');
    INSERT INTO slack_daily_preferences(id,owner_id,member_id,enabled) VALUES ('pref','w','colleague',0);
    INSERT INTO items(id,owner_id,kind,title,status) VALUES ('project','w','project','Project','todo'),('task','w','task','Task','todo'),('foreign-task','other','task','Foreign','todo');
    UPDATE items SET parent_id='project' WHERE id='task';
    INSERT INTO slack_automations(id,owner_id,created_by_user_id,name,trigger_type,channel_id,message_template,message_template_kind,active) VALUES
      ('rule','w','u','All changes','task_changed','C-CHANGE','default','default',1);`);
  const raw = d1Fixture(db), calls = [], behavior = { failChannel: "", loseChannel: "", beforeDecrypt: null };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    assert.equal(url, "https://slack.com/api/chat.postMessage");
    const payload = JSON.parse(request.body); calls.push(payload);
    if (payload.channel === behavior.loseChannel) throw new Error("Lost response");
    if (payload.channel === behavior.failChannel) return Response.json({ ok: false, error: "channel_not_found" });
    return Response.json({ ok: true, ts: `${calls.length}.000001` });
  };
  const delivery = compile(deliverySource, {
    "cloudflare:workers": { env: { DB: raw, SLACK_TOKEN_ENCRYPTION_KEY: "mock" } },
    "@/lib/slack-oauth": { decryptSlackSecret: async (value) => { await behavior.beforeDecrypt?.(); return value; } },
    "@/lib/slack-automation": transport,
  });
  const daily = compile(dailySource, {
    "cloudflare:workers": {}, "drizzle-orm": {}, "@/db": {}, "@/db/schema": {}, "@/lib/pace-data": {},
    "./language-preferences": preferences, "./server-language": serverLanguage,
    "@/lib/slack-daily-status": {}, "@/lib/slack-oauth": {}, "@/lib/slack-bot-delivery": {},
    "@/lib/daily-bot": {}, "@/lib/daily-work": {}, "@/lib/slack-daily-form": {}, "@/lib/slack-member-matching": {}, "@/lib/slack-daily-checklist": {},
  });
  const manual = compile(manualSource, {
    "@/lib/pace-data": { getSlackConnection: async (ownerId) => db.prepare("SELECT * FROM slack_connections WHERE owner_id=?").get(ownerId) },
    "@/lib/slack-daily": { dailyReminderBlocks: daily.dailyReminderBlocks, ensureDmChannel: async (_token, user, existing) => existing || `D-${user}`, slackTokenForConnection: async () => "mock" },
    "@/lib/slack-bot-delivery": delivery, "@/lib/language-preferences": preferences, "@/lib/server-language": serverLanguage,
  });
  const changes = compile(changeSource, {
    "@/lib/slack-bot-delivery": delivery, "@/lib/slack-automation": transport,
    "@/lib/language-preferences": preferences, "@/lib/server-language": serverLanguage,
  });
  t.after(() => { globalThis.fetch = oldFetch; db.close(); });
  const events = () => db.prepare("SELECT * FROM slack_task_changes ORDER BY rowid").all();
  return { db, raw, manual, changes, delivery, calls, behavior, events };
}

test("all-change migration is additive LF, tenant scoped, and transactionally rolls back", (t) => {
  const { db, events } = fixture(t);
  assert.ok(!migration.includes("\r"));
  assert.doesNotMatch(migration, /^(DROP|ALTER|DELETE FROM|UPDATE )/im);
  db.exec("UPDATE items SET title='New title', due_date='2026-09-30', status='done' WHERE id='task'");
  assert.equal(events().length, 1);
  assert.equal(JSON.parse(events()[0].before_json).title, "Task");
  assert.equal(JSON.parse(events()[0].after_json).status, "done");
  db.exec("UPDATE items SET updated_at='later', title=title WHERE id='task'; UPDATE items SET title='Other' WHERE id IN ('foreign-task','project')");
  assert.equal(events().length, 1);
  db.exec("BEGIN; UPDATE items SET title='Rollback' WHERE id='task'; ROLLBACK;");
  assert.equal(events().length, 1);
  db.exec("UPDATE slack_automations SET active=0; UPDATE items SET title='Paused' WHERE id='task'; UPDATE slack_automations SET active=1");
  assert.equal(events().length, 1, "enabling a rule does not replay earlier edits");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("task create, deletion, restoration and permanent deletion retain safe snapshots", async (t) => {
  const { db, raw, changes, events, calls } = fixture(t);
  db.exec("INSERT INTO items(id,owner_id,kind,title) VALUES ('new','w','task','New'); UPDATE items SET archived_at='now' WHERE id='new'; UPDATE items SET archived_at=NULL WHERE id='new'; DELETE FROM items WHERE id='new'");
  assert.deepEqual(events().map((e) => e.change_kind), ["created", "deleted", "restored", "permanently_deleted"]);
  await changes.runDueTaskChanges(raw);
  assert.equal(calls.length, 4, "deleted items still deliver their captured changes");
  assert.ok(calls.some((p) => p.text.includes("permanently deleted")));
  assert.ok(events().every((e) => e.processed_at));
  await changes.runDueTaskChanges(raw);
  assert.equal(calls.length, 4);
});

test("assignment, properties and checklists capture meaningful edits, including cleared values", (t) => {
  const { db, events } = fixture(t);
  db.exec("INSERT INTO item_assignments(id,owner_id,item_id,member_id,role) VALUES ('a','w','task','me','task_assignee'); UPDATE item_assignments SET member_id='colleague' WHERE id='a'; DELETE FROM item_assignments WHERE id='a'");
  assert.deepEqual(events().map((e) => e.change_kind), ["assignee", "assignee", "assignee"]);
  assert.equal(JSON.parse(events()[1].before_json).assignee, "Alice");
  assert.equal(JSON.parse(events()[1].after_json).assignee, "Bob");
  db.exec("INSERT INTO property_definitions(id,owner_id,name,type) VALUES ('p','w','Effort','number'); INSERT INTO item_property_values(id,owner_id,item_id,property_id,value) VALUES ('v','w','task','p','3'); UPDATE item_property_values SET value='5' WHERE id='v'; UPDATE item_property_values SET value='5' WHERE id='v'; DELETE FROM item_property_values WHERE id='v'");
  assert.equal(events().filter((e) => e.change_kind === "property").length, 3);
  db.exec("INSERT INTO checklist_items(id,owner_id,task_id,title) VALUES ('c','w','task','Check'); UPDATE checklist_items SET completed=1 WHERE id='c'; UPDATE checklist_items SET completed=1 WHERE id='c'; DELETE FROM checklist_items WHERE id='c'");
  assert.equal(events().filter((e) => e.change_kind === "checklist").length, 3);
});

test("task notifications honor rule/channel changes and never interpolate user text as mentions", async (t) => {
  const { db, raw, changes, events, calls } = fixture(t);
  db.exec("UPDATE items SET title='<!channel> <https://bad.test|hi>' WHERE id='task'");
  await Promise.all([changes.runDueTaskChanges(raw), changes.runDueTaskChanges(raw)]);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].text.includes("<!channel>"));
  assert.ok(calls[0].text.includes("&lt;!channel&gt;"));
  db.exec("UPDATE items SET status='done' WHERE id='task'; UPDATE slack_automations SET channel_id='C-NEW'");
  await changes.runDueTaskChanges(raw);
  assert.equal(calls.length, 1);
  assert.ok(events().every((e) => e.processed_at));
});

test("change summaries translate five languages while preserving user titles and property values", async (t) => {
  const { changes } = fixture(t);
  for (const language of ["ko", "en", "ja", "zh", "es"]) {
    const translate = await serverLanguage.serverTranslator(language);
    const summary = changes.taskChangeSummary({ change_kind: "updated", before_json: JSON.stringify({ title: "할 일", status: "todo" }), after_json: JSON.stringify({ title: "User title", status: "done" }) }, translate);
    assert.ok(summary.includes("할 일 → User title"), "user content remains verbatim");
    assert.ok(summary.includes(`${translate("할 일")} → ${translate("완료")}`));
    const property = changes.taskChangeSummary({ change_kind: "property", before_json: '{"property_name":"Custom","value":"3"}', after_json: "{}" }, translate);
    assert.equal(property, `Custom: 3 → ${translate("미지정")}`);
  }
});

test("manual bulk snapshots only linked active members, includes manual-only members and sends once", async (t) => {
  const { raw, db, manual, calls } = fixture(t);
  const before = db.prepare("SELECT * FROM slack_daily_preferences").all();
  const started = await manual.startDailyManualRun(raw, auth, requestId);
  assert.equal(started.total, 2);
  assert.equal(started.pending, 2);
  await Promise.all([manual.processDailyManualRun(raw, "w", requestId), manual.processDailyManualRun(raw, "w", requestId)]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.channel).sort(), ["D-C", "D-ME"]);
  assert.ok(calls.every((c) => JSON.stringify(c.blocks).includes("daily_open")));
  const repeated = await manual.startDailyManualRun(raw, auth, requestId);
  assert.equal(repeated.sent, 2);
  assert.equal(repeated.status, "complete");
  assert.equal((await manual.latestDailyManualRun(raw, "w")).id, requestId);
  assert.equal(await manual.latestDailyManualRun(raw, "other"), null);
  await manual.processDailyManualRun(raw, "w", requestId);
  assert.equal(calls.length, 2);
  assert.deepEqual(db.prepare("SELECT * FROM slack_daily_preferences").all(), before);
  assert.equal(db.prepare("SELECT count(*) n FROM slack_daily_reminders").get().n, 0);
});

test("manual bulk reports partial failure and never retries an uncertain send", async (t) => {
  const { raw, manual, delivery, calls, behavior } = fixture(t);
  behavior.failChannel = "D-C";
  behavior.loseChannel = "D-ME";
  await manual.startDailyManualRun(raw, auth, requestId);
  await manual.processDailyManualRun(raw, "w", requestId);
  const result = await manual.getDailyManualRun(raw, "w", requestId);
  assert.equal(result.failed, 1); assert.equal(result.uncertain, 1); assert.equal(result.pending, 0);
  await delivery.runDueSlackBotDeliveries(raw, new Date(Date.now() + 180_000));
  await manual.processDailyManualRun(raw, "w", requestId);
  assert.equal(calls.length, 2);
});

test("manual bulk rechecks actor, recipient, Slack link and tenant before each POST", async (t) => {
  const { raw, db, manual, calls, behavior } = fixture(t);
  await assert.rejects(manual.startDailyManualRun(raw, { ...auth, role: "member" }, requestId), /Admin/);
  await manual.startDailyManualRun(raw, auth, requestId);
  await assert.rejects(manual.getDailyManualRun(raw, "other", requestId), /찾을/);
  db.exec("UPDATE workspace_members SET status='inactive' WHERE id='colleague'");
  behavior.beforeDecrypt = () => db.exec("UPDATE workspace_members SET role='member' WHERE id='me'");
  await manual.processDailyManualRun(raw, "w", requestId);
  assert.equal(calls.length, 0);
  assert.equal((await manual.getDailyManualRun(raw, "w", requestId)).failed, 2);
});

test("manual run rejects missing/invalid targets and expires without sending", async (t) => {
  const { raw, db, manual, calls } = fixture(t);
  await assert.rejects(manual.startDailyManualRun(raw, auth, "bad"), /확인/);
  await manual.startDailyManualRun(raw, auth, requestId);
  db.exec("UPDATE slack_daily_manual_runs SET expires_at='2000-01-01T00:00:00.000Z'");
  await manual.runDueDailyManualRuns(raw);
  assert.equal((await manual.getDailyManualRun(raw, "w", requestId)).failed, 2);
  assert.equal(calls.length, 0);
  db.exec("DELETE FROM slack_member_links");
  await assert.rejects(manual.startDailyManualRun(raw, auth, `${requestId}-2`), /멤버/);
});

test("disconnected task rules do not block other workspaces or replay on reconnect", async (t) => {
  const { db, raw, changes, events, calls } = fixture(t);
  db.exec("UPDATE items SET title='While connected' WHERE id='task'; DELETE FROM slack_connections");
  await changes.runDueTaskChanges(raw);
  assert.equal(calls.length, 0);
  assert.ok(events().every((event) => event.processed_at));
  db.exec("DELETE FROM workspaces WHERE id='w'");
  assert.equal(events().length, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("delivery queues resume each minute without accelerating existing maintenance jobs", async () => {
  const calls = [];
  const mark = (name) => async () => { calls.push(name); };
  const worker = compile(workerSource, {
    "vinext/server/image-optimization": {}, "vinext/server/app-router-entry": {},
    "@/lib/workspace-address": {}, "@/lib/api-error": {},
    "@/lib/kr-data-sync": { syncDueKrDataConnectionsWithDb: mark("kr") },
    "@/lib/workspace-backups": { runDueWorkspaceBackups: mark("backups") },
    "@/lib/workspace-management-bot": { runDueWorkspaceManagementBots: mark("management") },
    "@/lib/slack-daily": { runDueSlackDailyReminders: mark("reminders") },
    "@/lib/slack-bot-delivery": { runDueSlackBotDeliveries: mark("deliveries") },
    "@/lib/slack-task-changes": { runDueTaskChanges: mark("changes") },
    "@/lib/slack-daily-manual": { runDueDailyManualRuns: mark("manual") },
    "@/lib/billing": { runBillingBatch: mark("billing") },
  }).default;
  for (const minute of [0, 1, 14, 15]) {
    calls.length = 0;
    const pending = [];
    worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 5, 1, minute) }, { DB: {} }, { waitUntil: (job) => pending.push(job) });
    await Promise.all(pending);
    assert.deepEqual(calls.sort(), (minute % 15 === 0 ? ["deliveries", "changes", "manual", "kr", "backups", "management", "reminders", "billing"] : ["deliveries", "changes", "manual"]).sort());
  }
});
