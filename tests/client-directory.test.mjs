import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function compile(code, dependencies = {}) {
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output)((name) => name in dependencies ? dependencies[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE workspace_backup_state (owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      archived_at TEXT
    );
    INSERT INTO workspaces (id) VALUES ('workspace-a'), ('workspace-b');
    INSERT INTO items (id, owner_id, kind, archived_at) VALUES
      ('ticket-a', 'workspace-a', 'ticket', NULL),
      ('ticket-b', 'workspace-b', 'ticket', NULL),
      ('project-a', 'workspace-a', 'project', NULL),
      ('archived-ticket', 'workspace-a', 'ticket', '2026-09-01T00:00:00.000Z');
  `);
  const d1 = {
    prepare(sql) {
      const statement = { sql, values: [] };
      statement.bind = (...values) => { statement.values = values; return statement; };
      statement.first = async () => sqlite.prepare(sql).get(...statement.values) ?? null;
      statement.all = async () => ({ results: sqlite.prepare(sql).all(...statement.values), success: true });
      statement.raw = async () => sqlite.prepare(sql).all(...statement.values).map((row) => Object.values(row));
      statement.run = async () => {
        const result = sqlite.prepare(sql).run(...statement.values);
        return { success: true, meta: { changes: Number(result.changes) } };
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, d1 };
}

const migration = await source("drizzle/0065_client_directory.sql");
const envBinding = { DB: null };
const directory = compile(await source("lib/client-directory.ts"), { "cloudflare:workers": { env: envBinding } });

test("client migration is additive, LF-only, isolated and cascading", () => {
  assert.doesNotMatch(migration, /\r/, "D1 migrations must use LF line endings");
  assert.doesNotMatch(migration, /DROP TABLE|ALTER TABLE|DELETE FROM/i);
  const { sqlite } = fixture();
  try {
    sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
    for (const table of ["clients", "client_products", "ticket_clients", "ticket_client_products", "integration_client_upserts", "integration_client_rate_limits"]) {
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1);
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM items").get().count, 4, "existing Ticket and Project rows must survive");
    sqlite.exec(`INSERT INTO clients (id, owner_id, name) VALUES ('client', 'workspace-a', '고객');
      INSERT INTO client_products (id, owner_id, client_id, name) VALUES ('product', 'workspace-a', 'client', '제품');
      INSERT INTO ticket_clients (id, owner_id, ticket_id, client_id) VALUES ('link', 'workspace-a', 'ticket-a', 'client');
      INSERT INTO ticket_client_products (id, owner_id, ticket_id, product_id) VALUES ('link-product', 'workspace-a', 'ticket-a', 'product');`);
    assert.throws(() => sqlite.exec("INSERT INTO ticket_clients (id, owner_id, ticket_id, client_id) VALUES ('duplicate', 'workspace-a', 'ticket-a', 'client')"), /UNIQUE/i);
    sqlite.exec("DELETE FROM clients WHERE id = 'client'");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ticket_clients").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM client_products").get().count, 0);
  } finally { sqlite.close(); }
});

test("manual client CRUD and Ticket links enforce workspace, kind and product ownership", async () => {
  const { sqlite, d1 } = fixture();
  envBinding.DB = d1;
  sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
  try {
    const alpha = await directory.createClient("workspace-a", "user-a", {
      name: "가나다 고객",
      phone: "010-1234-5678",
      email: "A@EXAMPLE.COM",
      products: [{ name: "Alpha" }, { name: "Beta" }],
    });
    const other = await directory.createClient("workspace-b", "user-b", { name: "다른 팀", products: [{ name: "Private" }] });
    assert.equal(alpha.email, "a@example.com");
    assert.equal(alpha.sourceType, "manual");
    assert.deepEqual((await directory.listClients("workspace-a")).map((entry) => entry.name), ["가나다 고객"]);
    assert.deepEqual(await directory.listClients("workspace-a", "Private"), []);
    const updated = await directory.updateClient("workspace-a", alpha.id, {
      phone: "02-000-0000",
      products: [{ id: alpha.products[1].id, name: "Beta Plus" }, { name: "Gamma" }],
    });
    assert.equal(updated.phone, "02-000-0000");
    assert.deepEqual(updated.products.map((product) => product.name), ["Beta Plus", "Gamma"]);
    const link = await directory.setTicketClientLink("workspace-a", "ticket-a", alpha.id, [updated.products[0].id, updated.products[1].id]);
    assert.equal(link.clientId, alpha.id);
    assert.deepEqual(link.productIds.sort(), updated.products.map((product) => product.id).sort());
    await assert.rejects(directory.setTicketClientLink("workspace-a", "project-a", alpha.id, []), (error) => error.code === "ticket_not_found");
    await assert.rejects(directory.setTicketClientLink("workspace-a", "archived-ticket", alpha.id, []), (error) => error.code === "ticket_not_found");
    await assert.rejects(directory.setTicketClientLink("workspace-a", "ticket-a", other.id, []), (error) => error.code === "client_not_found");
    await assert.rejects(directory.setTicketClientLink("workspace-a", "ticket-a", alpha.id, [other.products[0].id]), (error) => error.code === "product_client_mismatch");
    assert.equal((await directory.listTicketClientLinks("workspace-a", "ticket-a"))[0].client.name, "가나다 고객");
  } finally { sqlite.close(); }
});

test("external push upsert is idempotent and full resend preserves manual products", async () => {
  const { sqlite, d1 } = fixture();
  envBinding.DB = d1;
  sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
  try {
    const first = await directory.upsertClientsFromIntegration("workspace-a", "integration-user", [{
      externalCustomerId: "crm-100",
      name: "External Customer",
      phone: "010-0000-0000",
      products: [{ externalProductId: "sku-a", name: "External A" }, { externalProductId: "sku-b", name: "External B" }],
    }], "event-1", true, { name: "Example CRM", url: "https://crm.example.com/customers" });
    assert.equal(first.replayed, false);
    assert.equal(first.clients[0].sourceType, "api");
    assert.equal(first.clients[0].sourceName, "Example CRM");
    const replay = await directory.upsertClientsFromIntegration("workspace-a", "integration-user", [{
      externalCustomerId: "crm-100",
      name: "External Customer",
      phone: "010-0000-0000",
      products: [{ externalProductId: "sku-a", name: "External A" }, { externalProductId: "sku-b", name: "External B" }],
    }], "event-1", true, { name: "Example CRM", url: "https://crm.example.com/customers" });
    assert.equal(replay.replayed, true);
    await assert.rejects(directory.upsertClientsFromIntegration("workspace-a", "integration-user", [{ externalCustomerId: "crm-100", name: "Changed" }], "event-1", true, { name: "Example CRM" }), (error) => error.code === "idempotency_key_conflict");

    const saved = (await directory.listClients("workspace-a"))[0];
    await directory.updateClient("workspace-a", saved.id, { products: [...saved.products.map(({ id, name }) => ({ id, name })), { name: "Manual Keep" }] });
    assert.equal((await directory.getClient("workspace-a", saved.id)).sourceType, "manual");
    const second = await directory.upsertClientsFromIntegration("workspace-a", "integration-user", [{
      externalCustomerId: "crm-100",
      name: "External Customer Renamed",
      email: "external@example.com",
      products: [{ externalProductId: "sku-a", name: "External A2" }],
    }], "event-2", true, { name: "Example CRM", url: "https://crm.example.com/customers" });
    assert.equal(second.count, 1);
    const after = (await directory.listClients("workspace-a"))[0];
    assert.equal(after.name, "External Customer Renamed");
    assert.equal(after.sourceType, "api");
    assert.deepEqual(after.products.map((product) => [product.name, product.source]), [["External A2", "integration"], ["Manual Keep", "manual"]]);
    assert.equal((await directory.listClients("workspace-b")).length, 0);
  } finally { sqlite.close(); }
});

test("external bulk upsert is atomic, rejects unsafe source URLs and rate limits hashed callers", async () => {
  const { sqlite, d1 } = fixture();
  envBinding.DB = d1;
  sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
  try {
    const first = await directory.createClient("workspace-a", "user-a", { externalCustomerId: "crm-1", name: "Keep me" });
    await directory.createClient("workspace-a", "user-a", { externalCustomerId: "crm-2", name: "Second", products: [{ name: "Collision" }] });
    await assert.rejects(directory.upsertClientsFromIntegration("workspace-a", "integration-user", [
      { externalCustomerId: "crm-1", name: "Must roll back" },
      { externalCustomerId: "crm-2", name: "Second changed", products: [{ name: "Collision" }] },
    ], "atomic-event", true, { name: "Example CRM", url: "https://crm.example.com" }), (error) => error.code === "product_name_conflict");
    assert.equal((await directory.getClient("workspace-a", first.id)).name, "Keep me");
    assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM integration_client_upserts").get().count, 0);
    await assert.rejects(directory.upsertClientsFromIntegration("workspace-a", "integration-user", [
      { externalCustomerId: "crm-3", name: "Unsafe" },
    ], "unsafe-url", true, { name: "Example CRM", url: "http://127.0.0.1/private" }), (error) => error.code === "source_url_invalid");
    const now = new Date("2026-09-22T12:00:10.000Z");
    for (let index = 0; index < 30; index += 1) await directory.reserveClientIntegrationRequest("workspace-a", "fingerprint", now);
    await assert.rejects(directory.reserveClientIntegrationRequest("workspace-a", "fingerprint", now), (error) => error.code === "rate_limited" && error.status === 429);
  } finally { sqlite.close(); }
});

test("integration route accepts only workspace integration tokens and enforces strict JSON", async () => {
  const calls = [];
  const route = compile(await source("app/api/integrations/clients/upsert/route.ts"), {
    "@/lib/pace-data": {
      authorizeRequest: async (request) => ({ ownerId: "workspace-a", userId: "user-a", apiToken: request.headers.has("authorization"), integrationTokenId: request.headers.has("authorization") ? "token-a" : undefined }),
    },
    "@/lib/client-directory": {
      ClientDirectoryError: directory.ClientDirectoryError,
      reserveClientIntegrationRequest: async () => {},
      upsertClientsFromIntegration: async (...args) => { calls.push(args); return { clients: [], count: 0, replayed: false }; },
    },
  });
  const body = JSON.stringify({ source_name: "Example CRM", source_url: "https://crm.example.com", external_customer_id: "crm-1", name: "Customer" });
  const session = await route.POST(new Request("https://okri.ai/api/integrations/clients/upsert", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "one" }, body }));
  assert.equal(session.status, 403);
  const missingKey = await route.POST(new Request("https://okri.ai/api/integrations/clients/upsert", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body }));
  assert.equal(missingKey.status, 400);
  const wrongType = await route.POST(new Request("https://okri.ai/api/integrations/clients/upsert", { method: "POST", headers: { authorization: "Bearer token", "content-type": "text/plain", "idempotency-key": "wrong" }, body }));
  assert.equal(wrongType.status, 415);
  const oversized = await route.POST(new Request("https://okri.ai/api/integrations/clients/upsert", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", "content-length": "1048577", "idempotency-key": "large" }, body }));
  assert.equal(oversized.status, 413);
  const unknown = await route.POST(new Request("https://okri.ai/api/integrations/clients/upsert", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", "idempotency-key": "unknown" }, body: JSON.stringify({ ...JSON.parse(body), unexpected: true }) }));
  assert.equal(unknown.status, 400);
  const accepted = await route.POST(new Request("https://okri.ai/api/integrations/clients/upsert", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json", "idempotency-key": "event-1" }, body }));
  assert.equal(accepted.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "workspace-a");
  assert.equal(calls[0][3], "event-1");
  assert.deepEqual(calls[0][5], { name: "Example CRM", url: "https://crm.example.com" });
  assert.equal(accepted.headers.get("access-control-allow-origin"), null);
  assert.match(accepted.headers.get("cache-control"), /no-store/);
});

test("MCP, runtime schema and user guide expose the complete client integration contract", async () => {
  const [mcp, guide, runtime] = await Promise.all([source("app/mcp/route.ts"), source("app/api/codex-guide/route.ts"), source("lib/pace-data.ts")]);
  for (const tool of ["list_clients", "manage_client", "set_ticket_client"]) assert.match(mcp, new RegExp(`"${tool}"`));
  assert.match(mcp, /setTicketClientLink\(ownerId/);
  assert.match(guide, /\/api\/integrations\/clients\/upsert/);
  assert.match(guide, /Idempotency-Key/);
  assert.match(guide, /external_customer_id/);
  assert.match(guide, /push/i);
  assert.match(guide, /curl/);
  assert.match(runtime, /client\.source_type/);
  assert.match(runtime, /integration_client_rate_limits AS client_rate_limit/);
});
