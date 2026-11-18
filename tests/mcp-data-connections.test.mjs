import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { drizzle } from "drizzle-orm/d1";
import * as orm from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const require = createRequire(import.meta.url);
const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
function compile(source, dependencies = {}) {
  const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const loaded = {exports: {}};
  new Function("require", "module", "exports", js)(name => name in dependencies ? dependencies[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const schema = compile(await read("db/schema.ts"));
const snapshot = JSON.parse(await read("drizzle/meta/0071_snapshot.json"));
const contributions = compile(await read("lib/project-contributions.ts"));
const sync = compile(await read("lib/kr-data-sync.ts"));
const sources = compile(await read("lib/kr-data-sources.ts"), {"./project-contributions": contributions, "./kr-data-sync": sync});
const serviceSource = await read("lib/mcp-data-connections.ts");
const paceSource = await read("lib/pace-data.ts");
const paceAst = ts.createSourceFile("pace-data.ts", paceSource, ts.ScriptTarget.Latest, true);
const selected = new Set(["listDataConnections", "createDataConnection", "updateDataConnection", "getDataConnection", "requireDataConnectionTarget", "dataConnectionTargetMap", "serializeDataConnection", "normalizeKrDataCadence", "finiteMetric", "normalizeKrDataEndpoint", "isPrivateHostname"]);
const paceFunctions = paceAst.statements.filter(n => ts.isFunctionDeclaration(n) && selected.has(n.name?.text)).map(n => n.getText(paceAst)).join("\n");
const migrations = await Promise.all(["0076_project_task_goals", "0077_project_contributions", "0078_kr_data_sources", "0079_kr_metric_history"].map(n => read(`drizzle/${n}.sql`)));
const auth = {ownerId: "w", userId: "u", role: "owner", apiToken: true};
const endpoint = "https://metrics.example.com/private/metric?token=secret-test-token";
const settings = {item_id: "kr", target_kind: "key_result", endpoint_url: endpoint, value_path: "", baseline_value: 37158, target_value: 50000, unit: "건/주", cadence: "hourly", active: true};

function fixture(t) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  sql.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;");
  for (const name of ["users", "workspaces", "items", "kr_data_connections", "activity_log", "workspace_backup_state", "workspace_backup_guards"]) {
    const table = snapshot.tables[name];
    const columns = Object.values(table.columns).map(c => `${c.name} ${c.type}${c.primaryKey ? " PRIMARY KEY" : ""}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${c.default}` : ""}`);
    sql.exec(`CREATE TABLE ${name} (${columns.join(",")})`);
  }
  sql.exec(`CREATE UNIQUE INDEX connection_item ON kr_data_connections(owner_id,kr_item_id);
    INSERT INTO users(id,email_normalized) VALUES('u','u@example.com');
    INSERT INTO workspaces(id,name,owner_user_id) VALUES('w','Workspace','u'),('other','Other','u');
    INSERT INTO workspace_backup_state(owner_id) VALUES('w'),('other');
    INSERT INTO items(id,owner_id,parent_id,kind,title) VALUES
    ('kr','w',NULL,'key_result','Weekly usage'),('kr2','w',NULL,'key_result','Second'),
    ('i','w','kr','initiative','Initiative'),('p','w','i','project','Project'),('q','w','i','project','Another'),
    ('foreign','other',NULL,'key_result','Foreign'),('task','w','p','task','Task');`);
  for (const migration of migrations) sql.exec(migration);
  const prepare = (query, args = []) => ({
    bind: (...values) => prepare(query, values),
    first: async () => sql.prepare(query).get(...args) ?? null,
    all: async () => ({results: sql.prepare(query).all(...args)}),
    run: async () => ({meta: {changes: Number(sql.prepare(query).run(...args).changes)}}),
    raw: async () => sql.prepare(query).all(...args).map(row => Object.values(row)),
  });
  const db = {prepare, batch: async statements => {
    sql.exec("BEGIN"); try {const out = []; for (const s of statements) out.push(await s.run()); sql.exec("COMMIT"); return out;} catch (e) {sql.exec("ROLLBACK"); throw e;}
  }};
  const data = compile(`const {getDb,ensureWorkspace,items,krDataConnections,eq,and,asc,inArray,isNull}=require('fixture');
    const DATA_CONNECTION_TARGET_KINDS=['key_result','project'],KR_DATA_CADENCES=['hourly','daily','weekly','manual'];
    ${paceFunctions}`, {fixture: {...orm, ...schema, getDb: () => drizzle(db), ensureWorkspace: async () => {}}});
  data.getItem = async (owner, id) => {
    const row = sql.prepare("SELECT id,kind,title,progress,archived_at FROM items WHERE owner_id=? AND id=?").get(owner, id);
    return row ? {...row, archivedAt: row.archived_at} : null;
  };
  data.syncDataConnection = (owner, id) => sync.syncKrDataConnectionWithDb(db, owner, id);
  const api = compile(serviceSource, {"./pace-data": data, "./kr-data-sources": sources, "./kr-data-sync": sync});
  const upsert = input => api.upsertMcpDataConnection(db, auth, {...settings, ...input});
  const rows = () => sql.prepare("SELECT * FROM kr_metric_observations ORDER BY rowid").all();
  return {sql, db, data, api, upsert, rows};
}

test("KR upsert saves the exact numeric-root hourly settings, retains its ID and redacts endpoint secrets", async t => {
  const f = fixture(t);
  const first = await f.upsert(); assert.equal(first.created, true);
  assert.equal(first.connection.baselineValue, 37158); assert.equal(first.connection.targetValue, 50000);
  assert.equal(first.connection.valuePath, ""); assert.equal(first.connection.cadence, "hourly");
  assert.equal(JSON.stringify(first).includes("secret-test-token"), false);
  assert.equal(first.connection.endpointOrigin, "https://metrics.example.com");
  const count = f.rows().length;
  const same = await f.upsert(); assert.equal(same.changed, false); assert.equal(f.rows().length, count);
  const changed = await f.api.upsertMcpDataConnection(f.db, auth, {item_id: "kr", unit: "건/주", target_value: 55000});
  assert.equal(changed.connection.id, first.connection.id); assert.equal(changed.created, false);
  assert.equal(f.sql.prepare("SELECT endpoint_url FROM kr_data_connections").get().endpoint_url, endpoint);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM kr_data_connections").get().n, 1);
});

test("actual numeric API reads update progress/history; failures preserve the last value and do not invent history", async t => {
  const f = fixture(t); await f.upsert();
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async () => new Response("37158", {headers: {"Content-Type": "application/json"}});
  const first = await f.api.syncMcpDataConnection(f.db, auth, {item_id: "kr"});
  assert.equal(first.success, true); assert.equal(first.value, 37158); assert.equal(first.progress, 0);
  const before = f.rows().length;
  await f.api.syncMcpDataConnection(f.db, auth, {item_id: "kr"}); assert.equal(f.rows().length, before + 1);
  globalThis.fetch = async () => new Response("43579", {headers: {"Content-Type": "application/json"}});
  const half = await f.api.syncMcpDataConnection(f.db, auth, {item_id: "kr"}); assert.equal(half.progress, 50);
  const after = f.rows().length;
  globalThis.fetch = async () => {throw new Error(`failed ${endpoint}`);};
  const failed = await f.api.syncMcpDataConnection(f.db, auth, {item_id: "kr"});
  assert.equal(failed.success, false); assert.equal(failed.value, null); assert.equal(failed.progress, 50);
  assert.equal(failed.connection.lastValue, 43579); assert.equal(f.rows().length, after);
  assert.equal(JSON.stringify(failed).includes("secret-test-token"), false);
});

test("KR source switching preserves Project defaults and applied credit; Project API remains independent", async t => {
  const f = fixture(t);
  const state = await sources.readKrSource(f.db, "w", "kr");
  await sources.saveKrSource(f.db, "w", "u", "kr", {revision: state.revision, mode: "projects", startingValue: 20, targetValue: 100, unit: "건", projects: [{id: "p", defaultValue: 10}, {id: "q", defaultValue: null}]});
  f.sql.exec("UPDATE items SET status='done',progress=100 WHERE id='p'");
  const credit = f.sql.prepare("SELECT default_value,actual_value,applied FROM project_contributions WHERE project_id='p'").get();
  await f.upsert({item_id: "p", target_kind: "project"});
  assert.equal((await sources.readKrSource(f.db, "w", "kr")).mode, "projects");
  await assert.rejects(f.api.syncMcpDataConnection(f.db, auth, {item_id: "kr"}), {code: "data_connection_not_found"});
  await f.upsert();
  assert.deepEqual(f.sql.prepare("SELECT default_value,actual_value,applied FROM project_contributions WHERE project_id='p'").get(), credit);
  const apiState = await sources.readKrSource(f.db, "w", "kr"); assert.equal(apiState.mode, "api");
  await sources.saveKrSource(f.db, "w", "u", "kr", {revision: apiState.revision, mode: "projects", startingValue: 20, targetValue: 100, unit: "건", projects: [{id: "p", defaultValue: 10}, {id: "q", defaultValue: null}]});
  await assert.rejects(f.api.syncMcpDataConnection(f.db, auth, {item_id: "kr"}), {code: "project_source_active"});
  const listed = await f.api.listMcpDataConnections(f.db, auth, {});
  assert.equal(listed.find(c => c.itemId === "kr").sourceMode, "projects");
  assert.equal(listed.find(c => c.itemId === "p").sourceMode, "api");
});

test("Project upsert reuses ID and optional compare-and-swap rejects stale settings", async t => {
  const f = fixture(t);
  const first = await f.upsert({item_id: "p", target_kind: "project"});
  const [old] = await f.data.listDataConnections("w", "p");
  const changed = await f.api.upsertMcpDataConnection(f.db, auth, {item_id: "p", target_value: 60000});
  assert.equal(first.connection.id, changed.connection.id);
  await assert.rejects(f.data.updateDataConnection("w", old.id, {unit: "stale"}, old), /Data connection changed/);
  assert.equal((await f.data.listDataConnections("w", "p"))[0].targetValue, 60000);
});

test("a source change during collection cannot overwrite Project progress or report API mode", async t => {
  const f = fixture(t); await f.upsert();
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async () => {
    const state = await sources.readKrSource(f.db, "w", "kr");
    await sources.saveKrSource(f.db, "w", "u", "kr", {revision: state.revision, mode: "projects", startingValue: 20, targetValue: 100, unit: "건", projects: [{id: "p", defaultValue: 10}, {id: "q", defaultValue: null}]});
    return new Response("50000");
  };
  const result = await f.api.syncMcpDataConnection(f.db, auth, {item_id: "kr"});
  assert.equal(result.success, false); assert.equal(result.progress, 20); assert.equal(result.connection.sourceMode, "projects");
  assert.equal(f.rows().filter(row => row.source === "api" && row.current_value !== null).length, 0);
});

test("scope, Viewer/OAuth write policy, target kind, archive and endpoint validation hold", async t => {
  const f = fixture(t);
  for (const actor of [{...auth, role: "viewer"}, {...auth, oauthScopes: "okri:read"}]) {
    await assert.rejects(f.api.upsertMcpDataConnection(f.db, actor, settings), {code: "write_access_required"});
    await assert.rejects(f.api.syncMcpDataConnection(f.db, actor, {item_id: "kr"}), {code: "write_access_required"});
    assert.deepEqual(await f.api.listMcpDataConnections(f.db, actor, {}), []);
  }
  for (const item_id of ["foreign", "task", "missing"]) await assert.rejects(f.upsert({item_id}), {code: "data_target_not_found"});
  await assert.rejects(f.upsert({target_kind: "project"}), {code: "data_target_kind_mismatch"});
  f.sql.exec("UPDATE items SET archived_at='2026-11-18' WHERE id='kr2'");
  await assert.rejects(f.upsert({item_id: "kr2"}), {code: "data_target_not_found"});
  for (const endpoint_url of ["http://example.com", "https://localhost", "https://127.0.0.1", "https://10.1.2.3", "https://u:p@example.com"]) await assert.rejects(f.upsert({endpoint_url}), {code: "invalid_data_endpoint"});
  await assert.rejects(f.upsert({target_value: 37158}), {code: "invalid_metric_range"});
  await assert.rejects(f.api.upsertMcpDataConnection(f.db, auth, {item_id: "kr", baseline_value: 0, target_value: 1}), {code: "endpoint_url_required"});
  assert.equal(f.sql.prepare("SELECT count(*) n FROM kr_data_connections").get().n, 0);
});

test("real MCP protocol advertises the three tools and validates structured success/error responses", async t => {
  const f = fixture(t), server = new McpServer({name: "test", version: "1"});
  f.api.registerDataConnectionTools(server, f.db, auth);
  const client = new Client({name: "test", version: "1"});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => {await client.close(); await server.close();});
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ["list_data_connections", "sync_data_connection", "upsert_data_connection"]);
  assert.equal(tools.find(t => t.name === "list_data_connections").annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === "sync_data_connection").annotations.readOnlyHint, false);
  const missing = await client.callTool({name: "upsert_data_connection", arguments: {item_id: "kr"}});
  assert.equal(missing.isError, true); assert.equal(JSON.parse(missing.content[0].text).code, "endpoint_url_required");
  const saved = await client.callTool({name: "upsert_data_connection", arguments: settings});
  assert.notEqual(saved.isError, true); assert.equal(saved.structuredContent.created, true);
  const listed = await client.callTool({name: "list_data_connections", arguments: {item_id: "kr"}});
  assert.equal(listed.structuredContent.connections.length, 1);
  const original = globalThis.fetch; t.after(() => {globalThis.fetch = original;});
  globalThis.fetch = async () => new Response("37158");
  const synced = await client.callTool({name: "sync_data_connection", arguments: {item_id: "kr"}});
  assert.equal(synced.structuredContent.success, true);
  globalThis.fetch = async () => new Response("unavailable", {status: 503});
  const failed = await client.callTool({name: "sync_data_connection", arguments: {item_id: "kr"}});
  assert.equal(failed.isError, true); assert.equal(failed.structuredContent.success, false);
});
