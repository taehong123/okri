import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileLanguageModule, d1Fixture } from "./helpers/language-fixture.mjs";

const source = await readFile(new URL("../lib/workspace-search.ts", import.meta.url), "utf8");
const search = compileLanguageModule(source);
const query = (value) => search.parseSearchRequest(new URLSearchParams({ date: "2026-09-06", ...value }));
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE items(id TEXT PRIMARY KEY, owner_id TEXT, kind TEXT, title TEXT, description TEXT DEFAULT '', parent_id TEXT, cycle_id TEXT, routine_id TEXT, status TEXT DEFAULT 'todo', due_date TEXT, archived_at TEXT, updated_at TEXT DEFAULT '2026-09-01');
    CREATE INDEX idx_items_owner_archived ON items(owner_id,archived_at);
    CREATE TABLE routines(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,description TEXT DEFAULT '',system_key TEXT,assignee_member_id TEXT,active INTEGER DEFAULT 1,updated_at TEXT DEFAULT '2026-09-01');
    CREATE TABLE okr_cycles(id TEXT PRIMARY KEY,owner_id TEXT,name TEXT,department TEXT DEFAULT '',status TEXT DEFAULT 'active',end_date TEXT,updated_at TEXT DEFAULT '2026-09-01');
    CREATE TABLE workspace_members(id TEXT PRIMARY KEY,workspace_id TEXT,display_name TEXT,status TEXT DEFAULT 'active',updated_at TEXT DEFAULT '2026-09-01');
    CREATE TABLE item_assignments(owner_id TEXT,item_id TEXT,member_id TEXT,role TEXT);
    INSERT INTO okr_cycles(id,owner_id,name) VALUES ('cycle','team','성장 파일'),('private-cycle','other','기밀 파일');
    INSERT INTO workspace_members(id,workspace_id,display_name) VALUES ('member','team','조성배'),('private-member','other','기밀 담당자');
    INSERT INTO items(id,owner_id,kind,title,cycle_id) VALUES ('objective','team','objective','성장 목표','cycle'),('kr','team','key_result','성장 지표','cycle'),('ini','team','initiative','성장 계획','cycle');
    INSERT INTO items(id,owner_id,kind,title,parent_id,cycle_id,due_date) VALUES ('project','team','project','대시보드','ini','cycle','2026-09-06'),('task','team','task','대시보드 연결','project','cycle','2026-09-05');
    INSERT INTO items(id,owner_id,kind,title,status) VALUES ('done','team','project','대시보드','done'),('dev-done','team','task','개발 완료 업무','development_done'),('private','other','task','대시보드 기밀','todo'),('status-trash','team','task','삭제된 업무','archived');
    INSERT INTO items(id,owner_id,kind,title,archived_at) VALUES ('trash','team','project','대시보드 삭제','2026-09-01');
    INSERT INTO items(id,owner_id,kind,title,description,parent_id) VALUES ('orphan','team','task','안전한 항목','설명으로 찾아요','private');
    INSERT INTO items(id,owner_id,kind,title) VALUES ('literal','team','task','100%_완료'),('similar','team','task','100abc완료');
    INSERT INTO item_assignments VALUES ('team','project','member','project_dri'),('team','task','member','task_assignee'),('other','orphan','private-member','task_assignee');
    INSERT INTO routines(id,owner_id,title,assignee_member_id) VALUES ('routine','team','정기 리뷰','member'),('private-routine','other','기밀 루틴','private-member');
    INSERT INTO routines(id,owner_id,title,system_key) VALUES ('general','team','General','general');
  `);
  return { db, d1: d1Fixture(db) };
}

test("server searches all kinds, excludes trash and isolates every workspace join", async (t) => {
  const { d1 } = fixture(t);
  const all = await search.searchWorkspace(d1, "team", query({}));
  assert.deepEqual(new Set(all.results.map((row) => row.kind)), new Set(search.SEARCH_KINDS));
  assert.ok(all.results.every((row) => !['trash','status-trash','private','private-cycle','private-member','private-routine','general'].includes(row.id)));
  const orphan = all.results.find((row) => row.id === "orphan");
  assert.equal(orphan.parentTitle, null); assert.equal(orphan.assignee, null);
  const project = all.results.find((row) => row.id === "project");
  assert.equal(project.assignee, "조성배"); assert.equal(project.cycleName, "성장 파일");
});

test("title and description matching escapes wildcards and ranks active after relevance", async (t) => {
  const { d1 } = fixture(t);
  const rows = (await search.searchWorkspace(d1, "team", query({ q: "대시보드" }))).results;
  assert.equal(rows[0].id, "project"); assert.ok(rows.find((row) => row.id === "done"));
  assert.deepEqual((await search.searchWorkspace(d1, "team", query({ q: "%_" }))).results.map((row) => row.id), ["literal"]);
  assert.equal((await search.searchWorkspace(d1, "team", query({ q: "설명으로" }))).results[0].id, "orphan");
  assert.equal((await search.searchWorkspace(d1, "team", query({ q: "' OR 1=1 --" }))).results.length, 0);
});

test("filters combine real assignees, file, type, state and user-local due date", async (t) => {
  const { d1 } = fixture(t);
  const results = async (filters) => (await search.searchWorkspace(d1, "team", query(filters))).results.map((row) => row.id).sort();
  assert.deepEqual(await results({ assignee: "member" }), ["project", "routine", "task"]);
  assert.deepEqual(await results({ assignee: "private-member" }), []);
  assert.deepEqual(await results({ kind: "task", cycle: "cycle", due: "overdue" }), ["task"]);
  assert.deepEqual(await results({ due: "today" }), ["project"]);
  assert.deepEqual(await results({ status: "completed" }), ["dev-done", "done"]);
  assert.ok(!(await results({ status: "active" })).includes("done"));
  assert.ok(!(await results({ due: "none" })).includes("project"));
  assert.deepEqual(await results({ cycle: "private-cycle" }), []);
});

test("pagination searches beyond bootstrap's 200 rows without duplicate or missing stable results", async (t) => {
  const { db, d1 } = fixture(t);
  const insert = db.prepare("INSERT INTO items(id,owner_id,kind,title) VALUES (?, 'team','task',?)");
  for (let index = 0; index < 251; index++) insert.run(`bulk-${String(index).padStart(3, "0")}`, `전체검색 ${index}`);
  const ids = [];
  let offset = 0;
  do {
    const data = await search.searchWorkspace(d1, "team", query({ q: "전체검색", offset: String(offset) }));
    assert.ok(data.results.length <= 30); ids.push(...data.results.map((row) => row.id)); offset = data.nextOffset;
  } while (offset !== null);
  assert.equal(ids.length, 251); assert.equal(new Set(ids).size, 251);
  assert.ok(ids.includes("bulk-250"));
});

test("recent references are revalidated, typed and scoped instead of trusting saved titles", async (t) => {
  const { d1, db } = fixture(t);
  const params = new URLSearchParams("date=2026-09-06&ref=project:project&ref=task:private&ref=project:trash&ref=task:project");
  assert.deepEqual((await search.searchWorkspace(d1, "team", search.parseSearchRequest(params))).results.map((row) => row.id), ["project"]);
  db.prepare("UPDATE items SET title = '즉시 변경' WHERE id='project'").run();
  assert.equal((await search.searchWorkspace(d1, "team", search.parseSearchRequest(params))).results[0].title, "즉시 변경");
  db.prepare("UPDATE items SET archived_at='2026-09-06' WHERE id='project'").run();
  assert.equal((await search.searchWorkspace(d1, "team", search.parseSearchRequest(params))).results.length, 0);
});

test("invalid input is rejected with bounded page size and parameterized values", () => {
  for (const invalid of [{ offset: "-1" }, { offset: "1.5" }, { offset: "100001" }, { date: "2026-02-30" }, { date: "not-date" }, { q: "x".repeat(161) }, { kind: "users" }, { status: "archived" }, { due: "sql" }]) assert.throws(() => query(invalid));
  assert.throws(() => search.parseSearchRequest(new URLSearchParams("ref=" + "x".repeat(500))));
  const compiled = search.buildSearchQuery("workspace-secret", query({ q: "private-input" }));
  assert.ok(!compiled.sql.includes("workspace-secret")); assert.ok(!compiled.sql.includes("private-input"));
});

test("search route uses server authorization, permits viewer reads and never caches personalized responses publicly", async () => {
  const routeSource = await readFile(new URL("../app/api/search/route.ts", import.meta.url), "utf8");
  let authorized = new Response("No membership", { status: 403 });
  const owners = [];
  const route = compileLanguageModule(routeSource, {
    "cloudflare:workers": { env: { DB: {} } },
    "@/lib/pace-data": { authorizeRequest: async () => authorized },
    "@/lib/workspace-search": { ...search, searchWorkspace: async (_db, owner) => { owners.push(owner); return { results: [], nextOffset: null }; } },
  });
  const request = new Request("https://okrptr.com/api/search?ownerId=other");
  assert.equal((await route.GET(request)).status, 403); assert.deepEqual(owners, []);
  authorized = { ownerId: "viewer-workspace", role: "viewer" };
  const response = await route.GET(request);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(owners, ["viewer-workspace"]);
  assert.equal((await route.GET(new Request("https://okrptr.com/api/search?offset=-1"))).status, 400);
});
