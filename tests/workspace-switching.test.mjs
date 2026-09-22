import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { drizzle } from "drizzle-orm/d1";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function load(source, dependencies = {}) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)((id) => {
    if (!(id in dependencies)) throw new Error(`Unmocked dependency ${id}`);
    return dependencies[id];
  }, loaded, loaded.exports);
  return loaded.exports;
}

test("workspace summaries keep workspace IDs distinct from membership IDs", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      kind TEXT NOT NULL, deletion_requested_at TEXT, scheduled_deletion_at TEXT,
      avatar_key TEXT, avatar_updated_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE workspace_members (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO workspaces VALUES
      ('workspace-personal','Personal','user-1','personal',NULL,NULL,NULL,NULL,'2026-01-01'),
      ('workspace-team','Team','user-1','team',NULL,NULL,NULL,NULL,'2026-01-02');
    INSERT INTO workspace_members VALUES
      ('membership-personal','workspace-personal','user-1','owner','active','2026-01-01'),
      ('membership-team','workspace-team','user-1','legacy_owner','active','2026-01-02');
  `);
  const DB = {
    prepare(query) {
      return {
        values: [], query,
        bind(...values) { this.values = values; return this; },
        async first() { return sqlite.prepare(query).get(...this.values) ?? null; },
        async all() { return { results: sqlite.prepare(query).all(...this.values), success: true }; },
        async raw() { return sqlite.prepare(query).all(...this.values).map((row) => Object.values(row)); },
        async run() { return { success: true, meta: sqlite.prepare(query).run(...this.values) }; },
      };
    },
  };
  const schema = load(read("db/schema.ts"), { "drizzle-orm/sqlite-core": await import("drizzle-orm/sqlite-core"), "drizzle-orm": await import("drizzle-orm") });
  const roles = load(read("lib/team-role.ts"));
  const source = read("lib/pace-data.ts");
  const listFunction = source.slice(source.indexOf("export async function listUserWorkspaces("), source.indexOf("export async function createWorkspaceForUser("));
  const module = load(`
    import { and, asc, eq, isNull, or } from "drizzle-orm";
    import { getDb } from "@/db";
    import { workspaceMembers, workspaces } from "@/db/schema";
    import { normalizeTeamRole } from "@/lib/team-role";
    const purgeExpiredWorkspaces = async () => {};
    const workspaceAvatarUrl = () => null;
    ${listFunction}
  `, {
    "drizzle-orm": await import("drizzle-orm"),
    "@/db": { getDb: () => drizzle(DB) },
    "@/db/schema": schema,
    "@/lib/team-role": roles,
  });

  const summaries = await module.listUserWorkspaces("user-1", "workspace-personal");
  assert.deepEqual(summaries.map((workspace) => workspace.id), ["workspace-personal", "workspace-team"]);
  assert.equal(summaries[0].current, true);
  assert.equal(summaries[1].role, "owner");
  assert.ok(summaries.every((workspace) => !workspace.id.startsWith("membership-")));
  sqlite.close();
});
