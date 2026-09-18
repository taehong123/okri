import assert from "node:assert/strict";
import test from "node:test";
import { exportState } from "../lib/sites-state-export";

type Row = Record<string, unknown>;

function mockEnv(options: { failPreflight?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    __appgarden_migrations: Array.from({ length: 64 }, (_, id) => ({ id })),
    account_registrations: [{ id: "a1", enabled: true, payload: new Uint8Array([1, 2, 3]) }],
    items: Array.from({ length: 251 }, (_, id) => ({ id, title: `item-${id}` })),
  };
  const prepared: string[] = [];
  const DB = {
    prepare(sql: string) {
      prepared.push(sql);
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) { bindings = values; return this; },
        async all() {
          if (sql.includes("sqlite_master")) return { results: [{ name: "__appgarden_migrations" }, { name: "account_registrations" }, { name: "items" }] };
          const name = sql.match(/FROM "([^"]+)"/)?.[1];
          if (!name) throw new Error("bad query");
          if (options.failPreflight && sql.includes("LIMIT 0") && name === "items") throw new Error("unreadable table");
          if (sql.includes("LIMIT 0")) return { results: [] };
          const [limit, offset] = bindings as number[];
          return { results: tables[name].slice(offset, offset + limit) };
        },
      };
    },
  };
  const objectPages = [
    { objects: [{ key: "one", uploaded: new Date("2026-01-01"), httpMetadata: { contentType: "text/plain" }, customMetadata: { a: "b" } }], truncated: true, cursor: "next" },
    { objects: [{ key: "two", uploaded: new Date("2026-01-02"), httpMetadata: {}, customMetadata: {} }], truncated: false },
  ];
  const WORKSPACE_AVATARS = {
    async list({ cursor }: { cursor?: string }) { return cursor ? objectPages[1] : objectPages[0]; },
    async get(key: string) { return { body: new Blob([key]).stream() }; },
  };
  return { env: { DB, WORKSPACE_AVATARS, OKRI_MIGRATION_EXPORT_TOKEN: "secret", PUBLIC_VALUE: "kept" }, prepared };
}

function request() {
  return new Request("https://okri.ai/api/internal/sites-state-export", { method: "POST", headers: { "x-okri-migration-token": "secret", origin: "https://chatgpt.com" } });
}

test("exports every planned table and every R2 page before one final complete record", async () => {
  const { env, prepared } = mockEnv();
  const response = await exportState(request(), env as never);
  assert.equal(response.status, 200);
  const records = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records[0].type, "runtime");
  assert.deepEqual(records.filter((record) => record.type === "table").map((record) => record.name), ["__appgarden_migrations", "account_registrations", "items", "items"]);
  assert.deepEqual(records.filter((record) => record.type === "object").map((record) => record.key), ["one", "two"]);
  assert.deepEqual(records.at(-1), { type: "complete" });
  assert.equal(records.filter((record) => record.type === "complete").length, 1);
  assert.equal(records[2].rows[0].payload.base64, "AQID");
  assert.ok(prepared.every((sql) => !sql.includes('FROM "_cf_')));
});

test("returns 500 before streaming when a target table cannot be read", async () => {
  const { env } = mockEnv({ failPreflight: true });
  const response = await exportState(request(), env as never);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { type: "error", code: "export_failed" });
});
