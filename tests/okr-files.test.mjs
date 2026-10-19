import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
function compile(source, deps) {
  const loaded = { exports: {} };
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", output)((key) => {
    assert.ok(key in deps, `Unexpected dependency ${key}`); return deps[key];
  }, loaded, loaded.exports);
  return loaded.exports;
}
const schema = compile(await read("../db/schema.ts"), { "drizzle-orm": require("drizzle-orm"), "drizzle-orm/sqlite-core": require("drizzle-orm/sqlite-core") });
const snapshot = JSON.parse(await read("../drizzle/meta/0038_snapshot.json"));
const source = await read("../lib/okr-files.ts");
const paceSource = await read("../lib/pace-data.ts");
const paceAst = ts.createSourceFile("pace-data.ts", paceSource, ts.ScriptTarget.Latest, true);
const permissionSource = paceAst.statements.filter((node) => ts.isFunctionDeclaration(node) && ["getItemDeletePermissionMap", "getItemCreatorMap"].includes(node.name?.text)).map((node) => node.getText(paceAst)).join("\n");
const updateSource = paceAst.statements.filter((node) => ts.isFunctionDeclaration(node) && ["createItem", "updateItem", "getItem", "validateParent", "normalizeTaskStatus", "clampProgress"].includes(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ["parentKind", "completedStatuses", "TICKET_STATUSES"].includes(declaration.name.getText(paceAst))))
  .map(node => node.getText(paceAst)).join("\n");

async function fixture(t) {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec("PRAGMA foreign_keys=ON");
  for (const table of Object.values(snapshot.tables)) {
    const columns = Object.values(table.columns).map((c) => `${c.name} ${c.type}${c.primaryKey ? " PRIMARY KEY" : ""}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${c.default}` : ""}`);
    for (const fk of Object.values(table.foreignKeys)) columns.push(`FOREIGN KEY (${fk.columnsFrom}) REFERENCES ${fk.tableTo} (${fk.columnsTo}) ON DELETE ${fk.onDelete}`);
    sql.exec(`CREATE TABLE ${table.name} (${columns.join(",")})`);
    for (const index of Object.values(table.indexes)) sql.exec(`CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${index.name} ON ${table.name} (${index.columns})${index.where ? ` WHERE ${index.where}` : ""}`);
  }
  for (const path of ["0057_work_documents.sql"]) sql.exec((await read(`../drizzle/${path}`)).replaceAll("--> statement-breakpoint", ""));
  let beforeBatch;
  const db = {
    prepare(query) {
      let args = [];
      return { bind(...values) { args = values; return this; },
        async first() { return sql.prepare(query).get(...args) ?? null; },
        async all() { return { results: sql.prepare(query).all(...args) }; },
        async raw() { return sql.prepare(query).all(...args).map((row) => Object.values(row)); },
        async run() { return { results: sql.prepare(query).all(...args), meta: { changes: Number(sql.prepare("SELECT changes() n").get().n) } }; } };
    },
    async batch(statements) {
      beforeBatch?.(); beforeBatch = undefined;
      sql.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec("COMMIT"); return results; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  const orm = require("drizzle-orm/d1").drizzle(db);
  const permissions = compile(`const { getDb, workspaceMembers, itemAssignments, env, and, eq, inArray, normalizeTeamRole } = require("deps");\n${permissionSource}`, {
    deps: { getDb: () => orm, env: { DB: db }, normalizeTeamRole: (role) => role?.trim().toLowerCase() ?? "viewer", ...schema, ...require("drizzle-orm") },
  });
  const updates = compile(`const { getDb, items, env, and, eq, ensureWorkspace, logActivity, dispatchSlackAutomationEvent, parsePropertyValue, defaultCycleIdForKind, getWorkspaceRules, releaseProjectCreation } = require("deps");\n${updateSource}`, {
    deps: { getDb: () => orm, env: { DB: db }, ensureWorkspace: async () => {}, logActivity: async () => {}, dispatchSlackAutomationEvent: async () => {},
      parsePropertyValue: (value) => JSON.parse(value), defaultCycleIdForKind: async () => null,
      getWorkspaceRules: async () => ({ defaultPriority: "medium", defaultCadence: "weekly" }), releaseProjectCreation: async () => {}, ...schema, ...require("drizzle-orm") },
  });
  const routineProperties = compile(await read("../lib/routine-properties.ts"), {});
  const api = compile(source, {
    "cloudflare:workers": { env: { DB: db } }, "drizzle-orm": require("drizzle-orm"), "@/db": { getDb: () => orm }, "@/db/schema": schema,
    "@/lib/routine-properties": routineProperties,
    "@/lib/pace-data": { ...permissions, ITEM_STATUSES: ["todo", "in_progress", "done", "blocked", "backlog", "development_done"], getWorkspaceRules: async () => ({ defaultPriority: "medium", defaultCadence: "weekly" }), listOkrCycles: async () => [] },
  });
  sql.exec(`INSERT INTO users (id, display_name, email_normalized) VALUES ('u','Creator','u@example.test'),('admin','Admin','admin@example.test'),('member','Colleague','member@example.test'),('viewer','Viewer','viewer@example.test');
    INSERT INTO workspaces (id,name,owner_user_id) VALUES ('w','Team','u'),('other','Other','member');
    INSERT INTO workspace_members (id,workspace_id,user_id,display_name,role,status) VALUES
      ('creator','w','u','Creator','owner','active'),('admin','w','admin','Admin','admin','active'),('member','w','member','Colleague','member','active'),('viewer','w','viewer','Viewer','viewer','active');
    INSERT INTO okr_cycles (id,owner_id,name,version,start_date,end_date) VALUES ('cycle','w','Quarter',1,'2026-10-01','2026-12-31'),('next','w','Next',2,'2027-01-01','2027-03-31');
    INSERT INTO items (id,owner_id,cycle_id,parent_id,kind,title,created_by_user_id) VALUES
      ('o','w','cycle',NULL,'objective','Goal','u'),('kr','w','cycle','o','key_result','Result','u'),
      ('i','w','cycle','kr','initiative','Direction','u'),('target','w','next',NULL,'initiative','Next direction','u'),
      ('p','w','cycle','i','project','Project','u'),('task','w','cycle','p','task','Task','member'),
      ('done','w','cycle','p','task','Finished','member'),('foreign','other',NULL,NULL,'project','Foreign','member');
    UPDATE items SET status='done',progress=100 WHERE id='done';
    UPDATE items SET due_date='2026-12-01' WHERE id='task';
    INSERT INTO item_assignments (id,owner_id,item_id,member_id,role) VALUES ('dri','w','p','creator','project_dri'),('worker','w','task','member','task_assignee');
    INSERT INTO project_documents (id,owner_id,project_id,content,plain_text,version) VALUES ('doc','w','p','[{"type":"paragraph"}]','Keep the document',3);`);
  async function input() {
    const file = await api.getOkrFile("w", "admin", "cycle");
    return { expectedRevision: file.revision, metadata: { ...file.cycle }, objective: structuredClone(file.objective), projectResolutions: [] };
  }
  return { sql, db, api, permissions, updates, input, beforeBatch: (callback) => { beforeBatch = callback; } };
}

test("Tickets default to ready-to-process, preserve received records and accept only their five statuses", async (t) => {
  const f = await fixture(t);
  const ticket = await f.updates.createItem("w", { kind: "ticket", title: "処理待ち Ticket", createdByUserId: "u" });
  assert.equal(ticket.status, "todo");
  assert.equal(ticket.cycleId, null);
  const received = await f.updates.createItem("w", { kind: "ticket", title: "Received request", status: "backlog", createdByUserId: "u" });
  for (const status of ["policy_discussion", "todo", "in_progress", "done", "backlog"]) {
    const updated = await f.updates.updateItem("w", ticket.id, { status });
    assert.equal(updated.status, status);
  }
  assert.equal((await f.updates.updateItem("w", received.id, { description: "Keep its original status" })).status, "backlog");
  for (const status of ["blocked", "developing", "development_done"]) {
    await assert.rejects(f.updates.createItem("w", { kind: "ticket", title: "Invalid", status }), /Ticket status/);
    await assert.rejects(f.updates.updateItem("w", received.id, { status }), /Ticket status/);
  }
  assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
});

test("any linked Project can move across OKR files and all Tasks follow without losing work", async (t) => {
  const f = await fixture(t), input = await f.input();
  input.projectResolutions = [{ projectId: "p", action: "move", targetInitiativeRef: "target" }];
  await f.api.updateOkrFile("w", "admin", "cycle", input);
  assert.deepEqual({ ...f.sql.prepare("SELECT parent_id,cycle_id FROM items WHERE id='p'").get() }, { parent_id: "target", cycle_id: "next" });
  assert.equal(f.sql.prepare("SELECT count(*) n FROM items WHERE parent_id='p' AND cycle_id='next'").get().n, 2);
  assert.equal(f.sql.prepare("SELECT due_date FROM items WHERE id='task'").get().due_date, "2026-12-01");
  assert.equal(f.sql.prepare("SELECT status FROM items WHERE id='done'").get().status, "done");
  assert.equal(f.sql.prepare("SELECT member_id FROM item_assignments WHERE id='worker'").get().member_id, "member");
});

test("Routine conversion preserves Tasks, assignments and the document and keeps the Project in Trash", async (t) => {
  const f = await fixture(t), input = await f.input();
  input.objective.keyResults[0].initiatives = [];
  input.projectResolutions = [{ projectId: "p", action: "routine" }];
  await f.api.updateOkrFile("w", "admin", "cycle", input);
  const routine = f.sql.prepare("SELECT * FROM routines WHERE id='p'").get();
  assert.equal(routine.title, "Project"); assert.equal(routine.assignee_member_id, "creator");
  assert.equal(routine.document_plain_text, "Keep the document"); assert.equal(routine.document_version, 3);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM items WHERE routine_id='p' AND parent_id IS NULL AND cycle_id IS NULL AND archived_at IS NULL").get().n, 2);
  assert.equal(f.sql.prepare("SELECT status FROM items WHERE id='done'").get().status, "done");
  assert.equal(f.sql.prepare("SELECT status FROM items WHERE id='p'").get().status, "archived");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM item_assignments WHERE item_id='task'").get().n, 1);
  assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Project deletion is recoverable, includes Tasks, and honors admin/member/viewer boundaries", async (t) => {
  const f = await fixture(t), input = await f.input();
  const project = (await require("drizzle-orm/d1").drizzle(f.db).select().from(schema.items)).find((row) => row.id === "p");
  assert.equal((await f.permissions.getItemDeletePermissionMap("w", "admin", [project])).p, true);
  assert.equal((await f.permissions.getItemDeletePermissionMap("w", "member", [project])).p, false);
  assert.equal((await f.permissions.getItemDeletePermissionMap("w", "viewer", [project])).p, false);
  input.projectResolutions = [{ projectId: "p", action: "trash" }];
  await assert.rejects(f.api.updateOkrFile("w", "member", "cycle", input), /cannot move/);
  await f.api.updateOkrFile("w", "admin", "cycle", input);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM items WHERE archive_root_id='p' AND status='archived'").get().n, 3);
});

test("concurrent edits return the latest revision; the preserved draft can overwrite on retry", async (t) => {
  const f = await fixture(t), input = await f.input();
  input.objective.title = "My preserved draft";
  f.sql.exec("UPDATE items SET title='Other edit' WHERE id='o'");
  let conflict;
  try { await f.api.updateOkrFile("w", "admin", "cycle", input); } catch (error) { conflict = error; }
  assert.ok(conflict instanceof f.api.OkrFileConflictError);
  assert.equal(conflict.file.objective.title, "Other edit");
  input.expectedRevision = conflict.file.revision;
  await f.api.updateOkrFile("w", "admin", "cycle", input);
  assert.equal(f.sql.prepare("SELECT title FROM items WHERE id='o'").get().title, "My preserved draft");
});

test("a race during save rolls back the entire OKR/Project/Task transaction", async (t) => {
  const f = await fixture(t), input = await f.input();
  input.objective.title = "Should not commit";
  input.projectResolutions = [{ projectId: "p", action: "routine" }];
  f.beforeBatch(() => f.sql.exec("UPDATE items SET title='Late change' WHERE id='task'"));
  await assert.rejects(f.api.updateOkrFile("w", "admin", "cycle", input), f.api.OkrFileConflictError);
  assert.equal(f.sql.prepare("SELECT title FROM items WHERE id='o'").get().title, "Goal");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM routines WHERE id='p'").get().n, 0);
  assert.equal(f.sql.prepare("SELECT status FROM items WHERE id='p'").get().status, "todo");
});

test("foreign Projects and invalid move targets never partially write an Objective", async (t) => {
  const f = await fixture(t);
  for (const resolution of [{ projectId: "foreign", action: "trash" }, { projectId: "p", action: "move", targetInitiativeRef: "missing" }]) {
    const input = await f.input(); input.objective.title = "Not committed"; input.projectResolutions = [resolution];
    await assert.rejects(f.api.updateOkrFile("w", "admin", "cycle", input), /belong|available/);
    assert.equal(f.sql.prepare("SELECT title FROM items WHERE id='o'").get().title, "Goal");
  }
});

test("creator names are scoped to the workspace and do not create assignments", async (t) => {
  const f = await fixture(t);
  const rows = await require("drizzle-orm/d1").drizzle(f.db).select().from(schema.items);
  const names = await f.permissions.getItemCreatorMap("w", rows);
  assert.equal(names.p, "Creator");
  assert.equal(names.task, "Colleague");
  assert.equal(names.foreign, undefined);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM item_assignments").get().n, 2);
});

test("direct Project edits propagate their cycle to Tasks and completion preserves the hierarchy", async (t) => {
  const f = await fixture(t);
  await f.updates.updateItem("w", "p", { parentId: "target" });
  assert.equal(f.sql.prepare("SELECT cycle_id FROM items WHERE id='p'").get().cycle_id, "next");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM items WHERE parent_id='p' AND cycle_id='next'").get().n, 2);
  await f.updates.updateItem("w", "task", { status: "done" });
  assert.deepEqual({ ...f.sql.prepare("SELECT status,progress,parent_id,cycle_id FROM items WHERE id='task'").get() }, { status: "done", progress: 100, parent_id: "p", cycle_id: "next" });
  await assert.rejects(f.updates.updateItem("w", "p", { parentId: "foreign" }), /target Initiative/);
});
