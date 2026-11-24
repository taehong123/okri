import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/workspace-backups.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const backups = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const schema = JSON.parse(await readFile(new URL("../drizzle/meta/0034_snapshot.json", import.meta.url), "utf8"));
const currentSchema = JSON.parse(await readFile(new URL("../drizzle/meta/0039_snapshot.json", import.meta.url), "utf8"));
const migration = await readFile(new URL("../drizzle/0036_workspace_backups.sql", import.meta.url), "utf8");
const linksMigration = await readFile(new URL("../drizzle/0037_restore_links.sql", import.meta.url), "utf8");
const routineMigration = await readFile(new URL("../drizzle/0042_routine_properties.sql", import.meta.url), "utf8");
const dailyWorkMigration = await readFile(new URL("../drizzle/0045_daily_work_selection.sql", import.meta.url), "utf8");
const dailyYesterdayMigration = await readFile(new URL("../drizzle/0047_daily_yesterday_selection.sql", import.meta.url), "utf8");
const dailyWorkStatusMigration = await readFile(new URL("../drizzle/0055_daily_work_status.sql", import.meta.url), "utf8");
const dailyCalendarMigration = await readFile(new URL("../drizzle/0072_daily_calendar.sql", import.meta.url), "utf8");
const workDocumentsMigration = await readFile(new URL("../drizzle/0057_work_documents.sql", import.meta.url), "utf8");
const clientDirectoryMigration = await readFile(new URL("../drizzle/0065_client_directory.sql", import.meta.url), "utf8");

const contributionMigration = await readFile(new URL("../drizzle/0077_project_contributions.sql", import.meta.url), "utf8");
const sourceMigration = await readFile(new URL("../drizzle/0078_kr_data_sources.sql", import.meta.url), "utf8");
const historyMigration = await readFile(new URL("../drizzle/0079_kr_metric_history.sql", import.meta.url), "utf8");
const recurringMigration = await readFile(new URL("../drizzle/0080_project_metric_schedules.sql", import.meta.url), "utf8");
const metricLedgerMigration = await readFile(new URL("../drizzle/0085_metric_ledger.sql", import.meta.url), "utf8");
const performanceMigration = await readFile(new URL("../drizzle/0084_kr_performance.sql", import.meta.url), "utf8");
const displayMigration = await readFile(new URL("../drizzle/0086_metric_display.sql", import.meta.url), "utf8");
const performanceSchema = JSON.parse(await readFile(new URL("../drizzle/meta/0077_snapshot.json", import.meta.url), "utf8"));
const awaitTaskGoalMigration = await readFile(new URL("../drizzle/0076_project_task_goals.sql", import.meta.url), "utf8");

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const table of Object.values(schema.tables)) {
    if (table.name.startsWith("workspace_backup") || table.name === "workspace_restore_links") continue;
    const columns = Object.values(table.columns).map((column) => `${column.name} ${column.type}${column.primaryKey ? " PRIMARY KEY" : ""}${column.notNull ? " NOT NULL" : ""}${column.default !== undefined ? ` DEFAULT ${column.default}` : ""}`);
    for (const fk of Object.values(table.foreignKeys)) columns.push(`FOREIGN KEY (${fk.columnsFrom.join(",")}) REFERENCES ${fk.tableTo} (${fk.columnsTo.join(",")}) ON DELETE ${fk.onDelete}`);
    sqlite.exec(`CREATE TABLE ${table.name} (${columns.join(",")})`);
    for (const index of Object.values(table.indexes)) sqlite.exec(`CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${index.name} ON ${table.name} (${index.columns.join(",")})${index.where ? ` WHERE ${index.where}` : ""}`);
  }
  for (const sql of migration.split("--> statement-breakpoint")) if (sql.trim()) sqlite.exec(sql);
  for (const sql of linksMigration.split("--> statement-breakpoint")) if (sql.trim()) sqlite.exec(sql);
  sqlite.exec(routineMigration);
  sqlite.exec(dailyWorkMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(dailyYesterdayMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(dailyWorkStatusMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(dailyCalendarMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(workDocumentsMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(clientDirectoryMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec((awaitTaskGoalMigration).replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(contributionMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(sourceMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(historyMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(recurringMigration.replaceAll("--> statement-breakpoint", ""));
  sqlite.exec(performanceMigration);
  sqlite.exec(metricLedgerMigration);
  sqlite.exec(displayMigration);
  const d1 = {
    prepare(sql) {
      return { sql, params: [], bind(...params) { return { ...this, params }; },
        execute() {
          const statement = sqlite.prepare(this.sql);
          const results = statement.all(...this.params).map((row) => ({ ...row }));
          return { results, success: true, meta: { changes: Number(sqlite.prepare("SELECT changes() AS n").get().n) } };
        },
        async all() { return this.execute(); }, async run() { return this.execute(); }, async first() { return this.execute().results[0] ?? null; },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const results = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const objects = new Map();
  const bucket = {
    async put(key, bytes) { objects.set(key, new TextDecoder().decode(bytes)); },
    async get(key) { const payload = objects.get(key); return payload === undefined ? null : { size: Buffer.byteLength(payload), async text() { return payload; } }; },
    async delete(key) { objects.delete(key); },
  };
  const ctx = { DB: d1, WORKSPACE_AVATARS: bucket };
  sqlite.exec(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ('w','Team','u'), ('other','Other','other-user');
    INSERT INTO workspace_members (id,workspace_id,user_id,display_name,role,status) VALUES ('member','w','u','Owner','owner','active'), ('former','w','old-user','Former','member','active');
    INSERT INTO okr_cycles (id,owner_id,name,start_date,end_date) VALUES ('cycle','w','Quarter','2026-07-01','2026-09-30');
    INSERT INTO routines (id,owner_id,title,assignee_member_id) VALUES ('routine','w','Daily','member');
    INSERT INTO routine_property_definitions (id,owner_id,name,type,created_at,updated_at) VALUES ('routine-property','w','점검 수','number','now','now');
    UPDATE routines SET properties_json='{"routine-property":3}' WHERE id='routine';
    INSERT INTO items (id,owner_id,kind,title,cycle_id,parent_id,routine_id) VALUES
      ('objective','w','objective','Objective','cycle',NULL,NULL), ('kr','w','key_result','KR','cycle','objective',NULL),
      ('initiative','w','initiative','Initiative','cycle','kr',NULL), ('project','w','project','Project','cycle','initiative',NULL),
      ('task','w','task','Task',NULL,'project',NULL), ('routine-task','w','task','Routine task',NULL,NULL,'routine'),
      ('unrelated','other','project','Other workspace',NULL,NULL,NULL);
    INSERT INTO clients (id,owner_id,name,phone,email) VALUES ('client','w','Customer','010-1234-5678','customer@example.com');
    INSERT INTO client_products (id,owner_id,client_id,name) VALUES ('client-product','w','client','Product');
    INSERT INTO ticket_clients (id,owner_id,ticket_id,client_id) VALUES ('ticket-client','w','project','client');
    INSERT INTO ticket_client_products (id,owner_id,ticket_id,product_id) VALUES ('ticket-client-product','w','project','client-product');
    INSERT INTO property_definitions (id,owner_id,name,type) VALUES ('property','w','Priority','text');
    INSERT INTO item_property_values (id,owner_id,item_id,property_id,value) VALUES ('value','w','project','property','"high"');
    INSERT INTO project_hidden_properties (id,owner_id,project_id,property_id) VALUES ('hidden','w','project','property');
    INSERT INTO project_documents (id,owner_id,project_id,content,plain_text,version) VALUES ('doc','w','project','[{"type":"paragraph"}]','Original body',3);
    INSERT INTO project_templates (id,owner_id,name) VALUES ('template','w','Default');
    INSERT INTO checklist_items (id,owner_id,task_id,title) VALUES ('check','w','task','Verify');
    INSERT INTO routine_completions (id,owner_id,routine_id,completion_date) VALUES ('completion','w','routine','2026-09-01');
    INSERT INTO item_assignments (id,owner_id,item_id,member_id,role) VALUES ('dri','w','project','member','project_dri'), ('assignee','w','task','former','task_assignee');
    INSERT INTO daily_scrums (id,owner_id,member_id,scrum_date,today_note) VALUES ('scrum','w','member','2026-09-01','Notes');
    INSERT INTO daily_scrum_task_selections (id,owner_id,daily_scrum_id,member_id,task_id) VALUES ('selection','w','scrum','member','task');
    INSERT INTO daily_submissions (id,owner_id,member_id,scrum_date,version) VALUES ('submission','w','member','2026-09-01',1);
    INSERT INTO daily_task_snapshots (id,owner_id,submission_id,task_title) VALUES ('daily-task','w','submission','Old title');
    INSERT INTO google_connections (id,owner_id,user_id,encrypted_refresh_token) VALUES ('google','w','u','secret-refresh-token');
    INSERT INTO google_calendar_events (id,owner_id,user_id,item_id,google_event_id) VALUES ('event','w','u','task','gcal-event');
    INSERT INTO kr_data_connections (id,owner_id,kr_item_id,name,endpoint_url,target_value) VALUES ('kr-link','w','project','Metric','https://metrics.example.com/?key=secret',100);
    INSERT INTO slack_daily_publications (id,owner_id,member_id,submission_id,scrum_date,channel_id,slack_message_ts) VALUES ('publication','w','member','submission','2026-09-01','channel','original-ts');
    INSERT INTO integration_tokens (id,workspace_id,user_id,name,token_hash,token_prefix) VALUES ('token','w','u','MCP','secret-hash','prefix');
    INSERT INTO workspace_groups (id,workspace_id,name,handle) VALUES ('group','w','Team group','team');
    INSERT INTO workspace_group_members (id,group_id,member_id) VALUES ('group-member','group','member');
    INSERT INTO activity_log (id,owner_id,item_id,action) VALUES ('old-log','w','project','created');`);
  sqlite.exec("INSERT INTO project_task_goals(id,owner_id,project_id,target_count) VALUES ('project','w','project',10)");
  sqlite.exec("INSERT INTO kr_project_metrics(id,owner_id,kr_item_id,starting_value,target_value) VALUES ('metric','w','kr',20,100);INSERT INTO project_contributions(id,owner_id,project_id,kr_item_id,default_value) VALUES ('contribution','w','project','kr',10)");
  sqlite.exec(`INSERT INTO workspace_metric_calendars(id,owner_id,timezone,holidays_json,created_at,updated_at) VALUES('w','w','Asia/Seoul','["2026-12-25"]','2026-11-18','2026-11-18');
    INSERT INTO items(id,owner_id,parent_id,kind,title) VALUES('scheduled-project','w','initiative','project','Scheduled automation');
    INSERT INTO project_metric_schedules(id,owner_id,project_id,kr_item_id,mode,amount,start_date,credit_dates_json,accrued_value,through_date,calendar_version,active,created_at,updated_at)
      VALUES('schedule','w','scheduled-project','kr','once',0,'2050-01-01','[]',0,'2026-11-18',1,0,'2026-11-18','2026-11-18');`);
  return { sqlite, ctx, objects, bucket };
}

test("snapshot uses separate storage, includes complete business hierarchy, and excludes secrets", async () => {
  const f = fixture();
  const entry = await backups.createWorkspaceBackup(f.ctx, "w", "manual", "u");
  const payload = [...f.objects.values()][0];
  assert.ok(!payload.includes("secret-refresh-token"));
  assert.ok(!payload.includes("secret-hash"));
  assert.ok(!payload.includes("metrics.example.com"));
  assert.ok(!payload.includes("Other workspace"));
  const snapshot = JSON.parse(payload);
  assert.deepEqual(Object.keys(snapshot.tables), backups.BACKUP_TABLES);
  for (const table of backups.BACKUP_TABLES.filter(table => !table.startsWith("kr_performance_") && !["project_operation_versions", "kr_metric_display_settings"].includes(table))) assert.ok(snapshot.tables[table].length, table);
  assert.equal(entry.summary.tasks, 2);
  assert.equal(Date.parse(entry.expiresAt) - Date.parse(entry.createdAt), 30 * 86400000);
  assert.equal((await backups.listWorkspaceBackups(f.ctx, "other")).backups.length, 0);
  await assert.rejects(backups.previewWorkspaceBackup(f.ctx, "other", entry.id), { code: "backup_not_found" });
  await assert.rejects(backups.createWorkspaceBackup(f.ctx, "w", "manual", "u"), { code: "rate_limited" });
  f.sqlite.close();
});

test("backups predating personal work selection restore with empty work arrays without losing routine properties", async () => {
  const f = fixture();
  await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  const old = JSON.parse([...f.objects.values()][0]);
  for (const row of old.tables.clients) {
    delete row.source_type;
    delete row.source_name;
    delete row.source_url;
    delete row.source_updated_at;
  }
  for (const row of old.tables.daily_scrums) { delete row.work_selection_json; delete row.yesterday_work_selection_json; }
  for (const row of old.tables.daily_submissions) { delete row.work_snapshot_json; delete row.yesterday_work_snapshot_json; delete row.request_id; }
  for (const row of old.tables.kr_metric_observations) {
    delete row.numerator; delete row.denominator; delete row.snapshot_key;
  }
  const validated = backups.validateSnapshot(old, "w");
  assert.equal(validated.tables.daily_scrums[0].work_selection_json, "[]");
  assert.equal(validated.tables.daily_scrums[0].yesterday_work_selection_json, "[]");
  assert.equal(validated.tables.daily_submissions[0].work_snapshot_json, "[]");
  assert.equal(validated.tables.daily_submissions[0].yesterday_work_snapshot_json, "[]");
  assert.equal(validated.tables.daily_submissions[0].request_id, null);
  assert.equal(validated.tables.clients[0].source_type, "manual");
  assert.equal(validated.tables.clients[0].source_updated_at, validated.tables.clients[0].updated_at);
  assert.equal(validated.tables.routine_property_definitions.length, 1);
  f.sqlite.close();
});

test("restore replaces all business tables atomically, preserves live links, permissions and other workspaces, and can be undone", async () => {
  const f = fixture();
  const original = await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  f.sqlite.exec(`UPDATE items SET title='Changed title' WHERE id='project';
    UPDATE project_documents SET plain_text='Changed body', version=8 WHERE id='doc';
    INSERT INTO items (id,owner_id,kind,title) VALUES ('new-task','w','task','New task');
    UPDATE google_calendar_events SET google_event_id='latest-external-event' WHERE id='event';
    UPDATE slack_daily_publications SET slack_message_ts='latest-ts' WHERE id='publication';
    UPDATE workspace_groups SET name='Current group' WHERE id='group';
    UPDATE integration_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE id='token';
    DELETE FROM workspace_members WHERE id='former';`);
  const restored = await backups.restoreWorkspaceBackup(f.ctx, "w", original.id, "u");
  assert.equal(f.sqlite.prepare("SELECT title FROM items WHERE id='project'").get().title, "Project");
  assert.equal(f.sqlite.prepare("SELECT plain_text,version FROM project_documents").get().plain_text, "Original body");
  assert.equal(f.sqlite.prepare("SELECT version FROM project_documents").get().version, 9);
  assert.equal(f.sqlite.prepare("SELECT id FROM items WHERE id='new-task'").get(), undefined);
  assert.equal(f.sqlite.prepare("SELECT title FROM items WHERE id='unrelated'").get().title, "Other workspace");
  assert.equal(f.sqlite.prepare("SELECT name FROM workspace_groups").get().name, "Current group");
  assert.equal(f.sqlite.prepare("SELECT google_event_id FROM google_calendar_events").get().google_event_id, "latest-external-event");
  assert.equal(f.sqlite.prepare("SELECT slack_message_ts FROM slack_daily_publications").get().slack_message_ts, "latest-ts");
  assert.ok(f.sqlite.prepare("SELECT revoked_at FROM integration_tokens").get().revoked_at);
  assert.equal(f.sqlite.prepare("SELECT id FROM item_assignments WHERE id='assignee'").get(), undefined);
  assert.equal(f.sqlite.prepare("SELECT id FROM workspace_members WHERE id='former'").get(), undefined);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM activity_log").get().n, 2);
  assert.equal(f.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  await backups.restoreWorkspaceBackup(f.ctx, "w", restored.rollbackBackupId, "u");
  assert.equal(f.sqlite.prepare("SELECT title FROM items WHERE id='project'").get().title, "Changed title");
  assert.equal(f.sqlite.prepare("SELECT title FROM items WHERE id='new-task'").get().title, "New task");
  f.sqlite.close();
});
test("restoring measured KR history records only the final restored total, preserving paused KR API configuration",async()=>{
  const f=fixture();
  f.sqlite.exec("UPDATE items SET status='done' WHERE id='project';INSERT INTO kr_data_connections(id,owner_id,kr_item_id,name,endpoint_url,target_value,active) VALUES('dormant','w','kr','Saved API','https://metrics.example.com',100,0)");
  const before=f.sqlite.prepare("SELECT id FROM kr_metric_observations").all().map(r=>r.id),backup=await backups.createWorkspaceBackup(f.ctx,"w","manual","u");
  f.sqlite.exec("UPDATE items SET status='todo' WHERE id='project'");
  await backups.restoreWorkspaceBackup(f.ctx,"w",backup.id,"u");
  const rows=f.sqlite.prepare("SELECT * FROM kr_metric_observations").all(),newRows=rows.filter(r=>!before.includes(r.id));
  assert.equal(newRows.length,1);assert.equal(newRows[0].event_kind,"restored");assert.equal(newRows[0].current_value,30);
  assert.equal(f.sqlite.prepare("SELECT active FROM kr_data_connections WHERE id='dormant'").get().active,0);
  f.sqlite.close();
});
test("schedule/calendar restore retains dated estimates and records only the final restored total",async()=>{
  const f=fixture();
  f.sqlite.exec(`UPDATE project_metric_schedules SET amount=3,start_date='2026-11-17',credit_dates_json='["2026-11-17"]',accrued_value=3,active=1 WHERE id='schedule'`);
  const backup=await backups.createWorkspaceBackup(f.ctx,"w","manual","u");
  f.sqlite.exec("UPDATE project_metric_schedules SET amount=6,accrued_value=6,version=version+1 WHERE id='schedule';UPDATE workspace_metric_calendars SET holidays_json='[]',version=version+1");
  await backups.restoreWorkspaceBackup(f.ctx,"w",backup.id,"u");
  const restored=f.sqlite.prepare("SELECT * FROM project_metric_schedules WHERE id='schedule'").get();
  assert.equal(restored.accrued_value,3);assert.deepEqual(JSON.parse(restored.credit_dates_json),["2026-11-17"]);
  assert.deepEqual(JSON.parse(f.sqlite.prepare("SELECT holidays_json FROM workspace_metric_calendars").get().holidays_json),["2026-12-25"]);
  const point=f.sqlite.prepare("SELECT * FROM kr_metric_observations ORDER BY rowid DESC LIMIT 1").get();assert.equal(point.current_value,23);assert.equal(point.is_estimate,1);
  assert.equal(f.sqlite.prepare("SELECT progress FROM items WHERE id='kr'").get().progress,23);f.sqlite.close();
});

test("restoring performance preserves the dated audit and invalidates stale rule revisions", async () => {
  const f = fixture();
  const add = f.sqlite.prepare(`INSERT INTO kr_performance_changes
    (id,owner_id,kr_item_id,revision,request_id,kind,effective_date,recorded_at,actor_id,reason,request_json,value_json,receipt_json)
    VALUES (?,'w','kr',?,?,'rule','2026-11-01','2026-11-03T02:00:00Z','u','Historical correction','{}','{}',?)`);
  add.run("rule", 1, "first", '{"revision":1}');
  const saved = await backups.createWorkspaceBackup(f.ctx, "w", "u");
  add.run("rule-edit", 2, "second", '{"revision":2}');
  const result = await backups.restoreWorkspaceBackup(f.ctx, "w", saved.id, "u");
  const rows = f.sqlite.prepare("SELECT revision,reason,effective_date,recorded_at,receipt_json FROM kr_performance_changes").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].revision, 4);
  assert.equal(JSON.parse(rows[0].receipt_json).revision, 4);
  assert.equal(rows[0].reason, "Historical correction");
  assert.equal(rows[0].effective_date, "2026-11-01");
  assert.equal(rows[0].recorded_at, "2026-11-03T02:00:00Z");
  assert.ok(result.rollbackBackupId);
  f.sqlite.close();
});

test("backup restoration preserves measurement order when timestamps tie",async()=>{
  const f=fixture(),at="2026-11-01T09:00:00.000Z",insert=f.sqlite.prepare("INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) VALUES(?,'w','kr','projects','completed',?,0,100,'건',?)");
  for(const [id,value] of [["z-first",20],["a-second",28],["m-last",30]])insert.run(id,value,at);
  const backup=await backups.createWorkspaceBackup(f.ctx,"w","manual","u");
  await backups.restoreWorkspaceBackup(f.ctx,"w",backup.id,"u");
  assert.deepEqual(f.sqlite.prepare("SELECT current_value FROM kr_metric_observations WHERE observed_at=? ORDER BY observed_at,rowid").all(at).map(r=>r.current_value),[20,28,30]);
  f.sqlite.close();
});

test("concurrent business writes during backup abort restore without losing those writes", async () => {
  const f = fixture();
  const original = await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  const put = f.bucket.put;
  f.bucket.put = async (...args) => { await put(...args); f.sqlite.exec("UPDATE items SET title='Concurrent edit' WHERE id='task'"); };
  await assert.rejects(backups.restoreWorkspaceBackup(f.ctx, "w", original.id, "u"), { code: "workspace_changed" });
  assert.equal(f.sqlite.prepare("SELECT title FROM items WHERE id='task'").get().title, "Concurrent edit");
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM workspace_backup_guards").get().n, 0);
  f.sqlite.close();
});

test("restore and undo retain links belonging to newly-created items and submissions", async () => {
  const f = fixture();
  const old = await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  f.sqlite.exec(`INSERT INTO items (id,owner_id,kind,title) VALUES ('new-kr','w','key_result','New KR'), ('new-task','w','task','New Task');
    INSERT INTO kr_data_connections (id,owner_id,kr_item_id,name,endpoint_url,target_value) VALUES ('new-link','w','new-kr','New metric','https://metric.example.com',50);
    INSERT INTO google_calendar_events (id,owner_id,user_id,item_id,google_event_id) VALUES ('new-event','w','u','new-task','new-remote-event');
    INSERT INTO daily_submissions (id,owner_id,member_id,scrum_date,version) VALUES ('new-submission','w','member','2026-09-02',1);
    INSERT INTO slack_daily_publications (id,owner_id,member_id,submission_id,scrum_date,channel_id,slack_message_ts) VALUES ('new-publication','w','member','new-submission','2026-09-02','channel','new-remote-ts');`);
  const result = await backups.restoreWorkspaceBackup(f.ctx, "w", old.id, "u");
  assert.equal(f.sqlite.prepare("SELECT id FROM kr_data_connections WHERE id='new-link'").get(), undefined);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM workspace_restore_links").get().n, 3);
  await backups.restoreWorkspaceBackup(f.ctx, "w", result.rollbackBackupId, "u");
  assert.equal(f.sqlite.prepare("SELECT kr_item_id FROM kr_data_connections WHERE id='new-link'").get().kr_item_id, "new-kr");
  assert.equal(f.sqlite.prepare("SELECT google_event_id FROM google_calendar_events WHERE id='new-event'").get().google_event_id, "new-remote-event");
  assert.equal(f.sqlite.prepare("SELECT slack_message_ts FROM slack_daily_publications WHERE id='new-publication'").get().slack_message_ts, "new-remote-ts");
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM workspace_restore_links").get().n, 0);
  assert.equal(f.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  // An explicit disconnect after recovery must not be reversed by another restore.
  f.sqlite.exec("DELETE FROM kr_data_connections WHERE id='new-link'");
  await backups.restoreWorkspaceBackup(f.ctx, "w", result.rollbackBackupId, "u");
  assert.equal(f.sqlite.prepare("SELECT id FROM kr_data_connections WHERE id='new-link'").get(), undefined);
  f.sqlite.close();
});

test("detached Calendar mapping is not attached to a replacement Google connection", async () => {
  const f = fixture();
  const old = await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  f.sqlite.exec(`INSERT INTO items (id,owner_id,kind,title) VALUES ('new-task','w','task','New Task');
    INSERT INTO google_calendar_events (id,owner_id,user_id,item_id,google_event_id) VALUES ('new-event','w','u','new-task','old-account-event');`);
  const result = await backups.restoreWorkspaceBackup(f.ctx, "w", old.id, "u");
  f.sqlite.exec(`DELETE FROM google_connections WHERE id='google';
    INSERT INTO google_connections (id,owner_id,user_id,encrypted_refresh_token) VALUES ('replacement','w','u','new-secret');`);
  await backups.restoreWorkspaceBackup(f.ctx, "w", result.rollbackBackupId, "u");
  assert.equal(f.sqlite.prepare("SELECT id FROM google_calendar_events WHERE id='new-event'").get(), undefined);
  f.sqlite.close();
});

test("revoked admin permission during restore prevents committing", async () => {
  const f = fixture();
  const original = await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  const put = f.bucket.put;
  f.bucket.put = async (...args) => { await put(...args); f.sqlite.exec("UPDATE workspace_members SET role='viewer' WHERE id='member'"); };
  await assert.rejects(backups.restoreWorkspaceBackup(f.ctx, "w", original.id, "u"), { code: "workspace_changed" });
  assert.equal(f.sqlite.prepare("SELECT role FROM workspace_members WHERE id='member'").get().role, "viewer");
  f.sqlite.close();
});

test("storage failure and corrupt backup never modify live data or present a ready backup", async () => {
  const f = fixture();
  const itemCount=f.sqlite.prepare("SELECT count(*) n FROM items").get().n;
  f.bucket.put = async () => { throw new Error("offline"); };
  await assert.rejects(backups.createWorkspaceBackup(f.ctx, "w", "daily"));
  assert.equal((await backups.listWorkspaceBackups(f.ctx, "w")).backups.length, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM items").get().n, itemCount);
  assert.ok(f.sqlite.prepare("SELECT last_error FROM workspace_backup_state WHERE owner_id='w'").get().last_error);
  f.bucket.put = async (key, bytes) => f.objects.set(key, new TextDecoder().decode(bytes));
  const original = await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  const key = f.sqlite.prepare("SELECT object_key FROM workspace_backups WHERE id=?").get(original.id).object_key;
  f.objects.set(key, "corrupt");
  await assert.rejects(backups.restoreWorkspaceBackup(f.ctx, "w", original.id, "u"), { code: "invalid_backup" });
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM items").get().n, itemCount);
  f.sqlite.close();
});

test("SQL constraint failure rolls back every delete and insert", async () => {
  const f = fixture();
  const original = await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  f.sqlite.exec("UPDATE items SET title='Keep current' WHERE id='project'");
  f.sqlite.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON checklist_items BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  await assert.rejects(backups.restoreWorkspaceBackup(f.ctx, "w", original.id, "u"), /injected failure/);
  assert.equal(f.sqlite.prepare("SELECT title FROM items WHERE id='project'").get().title, "Keep current");
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM checklist_items").get().n, 1);
  assert.equal(f.sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
  f.sqlite.close();
});

test("daily backups are idempotent, use Seoul dates, and retention purges objects plus metadata", async () => {
  const f = fixture();
  const run = await backups.runDueWorkspaceBackups(f.ctx);
  assert.equal(run.completed, 2);
  assert.equal((await backups.runDueWorkspaceBackups(f.ctx)).completed, 0);
  assert.equal(backups.backupDay(new Date("2026-09-01T15:00:00Z")), "2026-09-02");
  assert.equal(backups.backupDay(new Date("2026-09-01T14:59:59Z")), "2026-09-01");
  assert.equal(await backups.purgeExpiredBackups(f.ctx, new Date(Date.now() + 31 * 86400000)), 2);
  assert.equal(f.objects.size, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM workspace_backups").get().n, 0);
  f.sqlite.close();
});

test("leases prevent duplicate work and invalid payloads are rejected", async () => {
  const f = fixture();
  f.sqlite.prepare("UPDATE workspace_backup_state SET lease_token='busy',lease_until=? WHERE owner_id='w'").run(new Date(Date.now() + 60000).toISOString());
  await assert.rejects(backups.createWorkspaceBackup(f.ctx, "w", "manual", "u"), { code: "backup_busy" });
  assert.throws(() => backups.validateSnapshot({ version: 1, workspaceId: "other", tables: {} }, "w"), { code: "invalid_backup" });
  assert.throws(() => backups.validateSnapshot({ version: 1, revision: 0, workspaceId: "w", tables: {} }, "w"), { code: "invalid_backup" });
  f.sqlite.close();
});

test("revision triggers cover all restored tables and business changes do not alter other workspace revisions", () => {
  const f = fixture();
  const clientColumns = {
    kr_project_metrics: ["id","owner_id","kr_item_id","starting_value","target_value","unit","active","version","created_at","updated_at"],
    kr_metric_observations: ["id","owner_id","kr_item_id","source","event_kind","current_value","baseline_value","target_value","unit","observed_at","is_estimate","numerator","denominator","snapshot_key"],
    workspace_metric_calendars: ["id","owner_id","timezone","holidays_json","version","created_at","updated_at"],
    project_metric_schedules: ["id","owner_id","project_id","kr_item_id","mode","amount","start_date","end_date","pauses_json","credit_dates_json","accrued_value","through_date","calendar_version","active","suspended_at","version","created_at","updated_at"],
    project_contributions: ["id","owner_id","project_id","kr_item_id","default_value","actual_value","applied","enabled","last_request_id","version","created_at","updated_at"],
    project_task_goals: ["id", "owner_id", "project_id", "target_count", "version", "created_at", "updated_at"],
    clients: ["id", "owner_id", "external_customer_id", "name", "phone", "email", "source_type", "source_name", "source_url", "source_updated_at", "created_by_user_id", "created_at", "updated_at"],
    client_products: ["id", "owner_id", "client_id", "external_product_id", "name", "source", "created_at", "updated_at"],
    ticket_clients: ["id", "owner_id", "ticket_id", "client_id", "created_at", "updated_at"],
    ticket_client_products: ["id", "owner_id", "ticket_id", "product_id", "created_at"],
  };
  for (const name of backups.BACKUP_TABLES) {
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name LIKE 'backup_revision_%'").get(name).n, 3, name);
    const expectedColumns = clientColumns[name] ? [...clientColumns[name]] :
      Object.keys((currentSchema.tables[name] ?? performanceSchema.tables[name]).columns);
    if (name === "daily_scrums") {
      expectedColumns.splice(expectedColumns.indexOf("skip_reason"), 0, "work_status");
      expectedColumns.push("yesterday_work_selection_json", "calendar_events_json");
    }
    if (name === "daily_submissions") {
      expectedColumns.splice(expectedColumns.indexOf("skip_reason"), 0, "work_status");
      expectedColumns.push("yesterday_work_snapshot_json", "request_id", "calendar_events_json");
    }
    if (name === "routines") {
      expectedColumns.splice(expectedColumns.indexOf("properties_json"), 0, "document_content", "document_plain_text", "document_version", "document_updated_at");
    }
    assert.deepEqual(backups.BACKUP_COLUMNS[name], expectedColumns);
  }
  const before = f.sqlite.prepare("SELECT revision FROM workspace_backup_state WHERE owner_id='other'").get().revision;
  f.sqlite.exec("UPDATE items SET title='Changed' WHERE id='task'");
  assert.equal(f.sqlite.prepare("SELECT revision FROM workspace_backup_state WHERE owner_id='other'").get().revision, before);
  f.sqlite.close();
});

test("backup API enforces active admin access, explicit workspace scope, same-origin writes, and restore confirmation", async () => {
  const f = fixture();
  let auth = { ownerId: "w", userId: "u", role: "owner", apiToken: false };
  globalThis.__backupRouteTest = { env: f.ctx, authorizeRequest: async () => auth, ...backups };
  const routeSource = await readFile(new URL("../app/api/workspace-backups/route.ts", import.meta.url), "utf8");
  const noImports = routeSource.replace(/^import[\s\S]*?from ["'][^"']+["'];\r?\n/gm, "");
  const routeJs = ts.transpileModule(`const { env, authorizeRequest, BackupError, createWorkspaceBackup, listWorkspaceBackups, previewWorkspaceBackup, restoreWorkspaceBackup } = globalThis.__backupRouteTest;\n${noImports}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const routes = await import(`data:text/javascript;base64,${Buffer.from(routeJs).toString("base64")}`);
  const request = (method, body, extra = {}) => new Request("https://okri.ai/api/workspace-backups", { method, headers: { "Content-Type": "application/json", "x-okri-workspace-id": "w", ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  auth = new Response("unauthorized", { status: 401 });
  assert.equal((await routes.GET(request("GET"))).status, 401);
  for (const role of ["member", "viewer"]) {
    auth = { ownerId: "w", userId: "u", role };
    assert.equal((await routes.GET(request("GET"))).status, 403);
    assert.equal((await routes.POST(request("POST", { action: "create" }))).status, 403);
  }
  auth = { ownerId: "w", userId: "u", role: "owner" };
  assert.equal((await routes.GET(request("GET", null, { "x-okri-workspace-id": "other" }))).status, 403);
  assert.equal((await routes.POST(request("POST", { action: "create" }, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await routes.PATCH(request("PATCH", { action: "restore", id: "anything" }))).status, 400);
  const create = await routes.POST(request("POST", { action: "create" }));
  assert.equal(create.status, 200);
  const entry = (await create.json()).backup;
  const listing = await routes.GET(request("GET"));
  assert.equal(listing.headers.get("cache-control"), "private, no-store");
  assert.equal((await listing.json()).backups.length, 1);
  f.sqlite.exec("UPDATE workspace_members SET status='removed' WHERE id='member'");
  assert.equal((await routes.PATCH(request("PATCH", { action: "restore", id: entry.id, confirmation: "RESTORE WORKSPACE" }))).status, 403);
  delete globalThis.__backupRouteTest;
  f.sqlite.close();
});

test("pending snapshots are cleaned up and deleting a workspace purges its backup objects", async () => {
  const f = fixture();
  await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  f.sqlite.exec("DELETE FROM workspaces WHERE id='w'");
  assert.equal(await backups.purgeExpiredBackups(f.ctx), 1);
  assert.equal(f.objects.size, 0);
  f.sqlite.close();
});
