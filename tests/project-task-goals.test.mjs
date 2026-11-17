import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/project-task-goals.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const goals = {};
new Function("exports", output)(goals);
const migration = await readFile(new URL("../drizzle/0076_project_task_goals.sql", import.meta.url), "utf8");
function fixture(t) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  sql.exec(`PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE items (id TEXT PRIMARY KEY, owner_id TEXT, parent_id TEXT, kind TEXT, status TEXT, progress INTEGER DEFAULT 0, archived_at TEXT, updated_at TEXT);
    CREATE TABLE kr_data_connections (id TEXT PRIMARY KEY,owner_id TEXT,kr_item_id TEXT);
    CREATE TABLE workspace_backup_state (owner_id TEXT PRIMARY KEY, revision INTEGER DEFAULT 0);
    INSERT INTO workspaces VALUES ('w'), ('other');
    INSERT INTO workspace_backup_state VALUES ('w',0),('other',0);
    INSERT INTO items (id,owner_id,kind,status,progress) VALUES ('p','w','project','todo',27), ('q','w','project','todo',17), ('foreign','other','project','todo',9);
  `);
  sql.exec(migration);
  const prepare = (query, args = []) => ({
    bind: (...values) => prepare(query, values),
    first: async () => sql.prepare(query).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...args) }),
    run: async () => { const result = sql.prepare(query).run(...args); return { meta: { changes: Number(result.changes) } }; },
  });
  const db = { prepare };
  const task = (id, parent = "p", status = "todo", owner = "w") => sql.prepare("INSERT INTO items(id,owner_id,parent_id,kind,status) VALUES (?,?,?,'task',?)").run(id, owner, parent, status);
  const progress = id => sql.prepare("SELECT progress FROM items WHERE id=?").get(id).progress;
  const save = (targetCount = 10, expectedVersion = 0, project = "p") => goals.saveProjectTaskGoal(db, "w", project, { enabled: true, targetCount, expectedVersion, expectedId: sql.prepare("SELECT id FROM project_task_goals WHERE project_id=?").get(project)?.id });
  return { sql, db, task, progress, save };
}

test("completion goals count direct completed Tasks, undo, cap and preserve other Projects", async t => {
  const f = fixture(t);
  f.task("done-before", "p", "done"); f.task("open"); f.task("elsewhere", "q", "done");
  const saved = await f.save();
  assert.equal(saved.goal.completedCount, 1); assert.equal(f.progress("p"), 10); assert.equal(f.progress("q"), 17);
  f.sql.exec("UPDATE items SET status='done' WHERE id='open'");
  assert.equal(f.progress("p"), 20);
  f.sql.exec("UPDATE items SET status='done' WHERE id='open'");
  assert.equal(f.progress("p"), 20);
  f.sql.exec("UPDATE items SET status='todo' WHERE id='open'");
  assert.equal(f.progress("p"), 10);
  await f.save(1, saved.goal.version);
  f.sql.exec("UPDATE items SET status='development_done' WHERE id='open'");
  assert.equal(f.progress("p"), 100);
  f.sql.exec("UPDATE items SET progress=4 WHERE id='p'");
  assert.equal(f.progress("p"), 100);
  assert.equal(f.progress("foreign"), 9);
});

test("reparent, trash, restore, deletion and cross-workspace Tasks recalculate without accumulating duplicates", async t => {
  const f = fixture(t); await f.save(4); await f.save(2,0,"q");
  f.task("t","p","done"); assert.equal(f.progress("p"),25);
  f.task("cross","p","done","other"); assert.equal(f.progress("p"),25);
  f.sql.exec("UPDATE items SET parent_id='q' WHERE id='t'");
  assert.equal(f.progress("p"),0); assert.equal(f.progress("q"),50);
  f.sql.exec("UPDATE items SET archived_at='2026-11-17' WHERE id='t'");
  assert.equal(f.progress("q"),0);
  f.sql.exec("UPDATE items SET archived_at=NULL WHERE id='t'");
  assert.equal(f.progress("q"),50);
  f.sql.exec("DELETE FROM items WHERE id='t'"); assert.equal(f.progress("q"),0);
});

test("validation, workspace scoping, API exclusivity and stale saves preserve the previous setting", async t => {
  const f = fixture(t);
  for (const count of [0,-1,1.5,NaN,Infinity,"10",1_000_001]) await assert.rejects(f.save(count), { code: "invalid_goal" });
  await assert.rejects(f.save(10,0,"foreign"), { code: "project_not_found" });
  f.sql.exec("INSERT INTO kr_data_connections VALUES ('api','w','p')");
  await assert.rejects(f.save(), { code: "api_connected" });
  assert.throws(() => f.sql.exec("INSERT INTO project_task_goals(id,owner_id,project_id,target_count) VALUES ('p','w','p',10)"), /constraint/);
  f.sql.exec("DELETE FROM kr_data_connections");
  const first = await f.save(10);
  assert.throws(() => f.sql.exec("INSERT INTO kr_data_connections VALUES ('api','w','p')"), /constraint/);
  await assert.rejects(f.save(20,0), { code: "goal_conflict" });
  assert.equal((await goals.readProjectTaskGoal(f.db,"w","p")).goal.targetCount,10);
  f.task("done","p","done");
  await goals.saveProjectTaskGoal(f.db,"w","p",{enabled:false,expectedVersion:first.goal.version,expectedId:first.goal.id});
  assert.equal(f.progress("p"),10);
  f.sql.exec("UPDATE items SET status='todo' WHERE id='done'");
  assert.equal(f.progress("p"),10);
  await f.save(8);
  await assert.rejects(goals.saveProjectTaskGoal(f.db,"w","p",{enabled:true,targetCount:20,expectedVersion:first.goal.version,expectedId:first.goal.id}), { code: "goal_conflict" });
  assert.ok(f.sql.prepare("SELECT revision FROM workspace_backup_state WHERE owner_id='w'").get().revision >= 2);
});

test("migration SQL is LF and Project deletion cascades its goal", async t => {
  const f = fixture(t); assert.ok(!migration.includes("\r"));
  await f.save(); f.sql.exec("DELETE FROM items WHERE id='p'");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM project_task_goals").get().n,0);
});

test("goal route retains authorization, Viewer reads, scoped writes and private no-store responses", async t => {
  const f = fixture(t);
  let auth = { ownerId: "w", userId: "u", role: "owner" };
  const authorizationCalls = [];
  const dependencies = {
    "cloudflare:workers": { env: { DB: f.db } },
    "@/lib/project-task-goals": goals,
    "@/lib/pace-data": {
      ensureWorkspace: async () => {},
      authorizeRequest: async (_request, options) => {
        authorizationCalls.push(options);
        if (auth instanceof Response) return auth;
        if (auth.role === "viewer" && !options?.allowViewerWrite) return new Response("forbidden", { status: 403 });
        return auth;
      },
    },
  };
  const routeSource = await readFile(new URL("../app/api/project-task-goals/route.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const routes = {};
  new Function("require","exports",js)(name => dependencies[name], routes);
  const get = id => new Request("https://okri.ai/api/project-task-goals?projectId=" + id);
  const put = body => new Request("https://okri.ai/api/project-task-goals", { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
  auth = new Response("unauthorized",{status:401});
  assert.equal((await routes.GET(get("p"))).status,401);
  auth = { ownerId:"w",userId:"v",role:"viewer" };
  const readable = await routes.GET(get("p"));
  assert.equal(readable.status,200); assert.equal(readable.headers.get("Cache-Control"),"private, no-store");
  assert.equal((await routes.PUT(put({projectId:"p",enabled:true,targetCount:10,expectedVersion:0}))).status,403);
  auth = { ownerId:"w",userId:"u",role:"owner" };
  assert.equal((await routes.PUT(put({projectId:"foreign",enabled:true,targetCount:10,expectedVersion:0}))).status,404);
  assert.equal((await routes.PUT(put({projectId:"p",enabled:true,targetCount:10,expectedVersion:0}))).status,200);
  assert.equal((await routes.PUT(put({projectId:"p",enabled:true,targetCount:20,expectedVersion:0}))).status,409);
  assert.equal((await routes.PUT(put(null))).status,400);
  assert.equal((await routes.GET(get("foreign"))).status,404);
  assert.ok(authorizationCalls.some(options => options?.allowViewerWrite));
});
