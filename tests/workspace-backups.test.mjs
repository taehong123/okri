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
    INSERT INTO kr_data_connections (id,owner_id,kr_item_id,name,endpoint_url,target_value) VALUES ('kr-link','w','kr','Metric','https://metrics.example.com/?key=secret',100);
    INSERT INTO slack_daily_publications (id,owner_id,member_id,submission_id,scrum_date,channel_id,slack_message_ts) VALUES ('publication','w','member','submission','2026-09-01','channel','original-ts');
    INSERT INTO integration_tokens (id,workspace_id,user_id,name,token_hash,token_prefix) VALUES ('token','w','u','MCP','secret-hash','prefix');
    INSERT INTO workspace_groups (id,workspace_id,name,handle) VALUES ('group','w','Team group','team');
    INSERT INTO workspace_group_members (id,group_id,member_id) VALUES ('group-member','group','member');
    INSERT INTO activity_log (id,owner_id,item_id,action) VALUES ('old-log','w','project','created');`);
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
  for (const table of backups.BACKUP_TABLES) assert.ok(snapshot.tables[table].length, table);
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
  for (const row of old.tables.daily_scrums) { delete row.work_selection_json; delete row.yesterday_work_selection_json; }
  for (const row of old.tables.daily_submissions) { delete row.work_snapshot_json; delete row.yesterday_work_snapshot_json; delete row.request_id; }
  const validated = backups.validateSnapshot(old, "w");
  assert.equal(validated.tables.daily_scrums[0].work_selection_json, "[]");
  assert.equal(validated.tables.daily_scrums[0].yesterday_work_selection_json, "[]");
  assert.equal(validated.tables.daily_submissions[0].work_snapshot_json, "[]");
  assert.equal(validated.tables.daily_submissions[0].yesterday_work_snapshot_json, "[]");
  assert.equal(validated.tables.daily_submissions[0].request_id, null);
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
  f.bucket.put = async () => { throw new Error("offline"); };
  await assert.rejects(backups.createWorkspaceBackup(f.ctx, "w", "daily"));
  assert.equal((await backups.listWorkspaceBackups(f.ctx, "w")).backups.length, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM items").get().n, 7);
  assert.ok(f.sqlite.prepare("SELECT last_error FROM workspace_backup_state WHERE owner_id='w'").get().last_error);
  f.bucket.put = async (key, bytes) => f.objects.set(key, new TextDecoder().decode(bytes));
  const original = await backups.createWorkspaceBackup(f.ctx, "w", "daily");
  const key = f.sqlite.prepare("SELECT object_key FROM workspace_backups WHERE id=?").get(original.id).object_key;
  f.objects.set(key, "corrupt");
  await assert.rejects(backups.restoreWorkspaceBackup(f.ctx, "w", original.id, "u"), { code: "invalid_backup" });
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM items").get().n, 7);
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
  for (const name of backups.BACKUP_TABLES) {
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(name).n, 3, name);
    const expectedColumns = Object.keys(currentSchema.tables[name].columns);
    if (name === "daily_scrums") {
      expectedColumns.splice(expectedColumns.indexOf("skip_reason"), 0, "work_status");
      expectedColumns.push("yesterday_work_selection_json");
    }
    if (name === "daily_submissions") {
      expectedColumns.splice(expectedColumns.indexOf("skip_reason"), 0, "work_status");
      expectedColumns.push("yesterday_work_snapshot_json", "request_id");
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
