import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { migrate } from "drizzle-orm/d1/migrator";
const root = new URL("../", import.meta.url);
const read = p => readFile(new URL(p, root), "utf8");
const digest = s => createHash("sha256").update(s).digest("hex");
test("native and store-feedback tables are created after the deployed 0062 migration and a second run preserves them", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER);");
  db.prepare("INSERT INTO __drizzle_migrations (hash,created_at) VALUES (?,?)").run("already-published-0062", 1789012386612);
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    raw: async () => { const s = db.prepare(sql); s.setReturnArrays(true); return s.all(...args); },
  });
  const d1 = { prepare: statement, batch: async commands => {
    db.exec("BEGIN"); try { const results = []; for (const c of commands) results.push(await c.run()); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  const orm = drizzle(d1), config = { migrationsFolder: fileURLToPath(new URL("drizzle/", root)) };
  await migrate(orm, config);
  for (const table of ["native_sessions", "native_auth_codes", "native_apple_nonces", "native_apple_grants", "native_identity_revocations", "native_account_deletion_guards", "store_review_feedback"]) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
  db.exec("INSERT INTO users (id) VALUES ('retained-user'); INSERT INTO native_sessions (token_hash,user_id,created_at,expires_at) VALUES ('retained-session','retained-user','2026-09-08','2026-10-08');");
  assert.throws(() => db.exec("INSERT INTO native_account_deletion_guards (id,valid) VALUES ('unsafe',0)"), /CHECK constraint failed/);
  const count = db.prepare("SELECT COUNT(*) n FROM __drizzle_migrations").get().n;
  await migrate(orm, config);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM __drizzle_migrations").get().n, count);
  assert.equal(db.prepare("SELECT user_id FROM native_sessions WHERE token_hash='retained-session'").get().user_id, "retained-user");
});
test("deployed-order native migration preserves the original schema and appended timestamps exceed history", async () => {
  const migration = (await read("drizzle/0063_native_sessions.sql")).replace(/^--[^\n]*\n/, "");
  assert.equal(migration, await read("drizzle/0054_native_sessions.sql"));
  const { entries } = JSON.parse(await read("drizzle/meta/_journal.json"));
  const baseline = JSON.parse(await read("tests/fixtures/mobile-v1-migrations.json"));
  for (let i = 1; i < entries.length; i++) {
    assert.equal(entries[i].idx, entries[i - 1].idx + 1);
    if (!("drizzle/" + entries[i].tag + ".sql" in baseline)) {
      assert.ok(entries[i].when > Math.max(...entries.slice(0, i).map(e => e.when)), entries[i].tag);
    }
  }
});
test("mobile v1 migration history is immutable and new destructive SQL requires an exact reviewed plan", async () => {
  const baseline = JSON.parse(await read("tests/fixtures/mobile-v1-migrations.json"));
  const reviews = JSON.parse(await read("mobile/release/migration-reviews.json"));
  for (const [file, hash] of Object.entries(baseline)) assert.equal(digest(await read(file)), hash, file + " changed; append a migration instead");
  for (const name of await readdir(new URL("drizzle/", root))) {
    const file = "drizzle/" + name;
    if (!name.endsWith(".sql") || file in baseline) continue;
    const sql = await read(file);
    assert.ok(!sql.includes("\r"), file + " must be LF");
    // Conservative review trigger, not a SQL correctness/semantic proof.
    const tokens = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").toUpperCase();
    if (/\b(?:DROP|RENAME|DELETE|UPDATE|REPLACE|PRAGMA)\b/.test(tokens) || /\bALTER\b[\s\S]*\bNOT\s+NULL\b/.test(tokens)) {
      const review = reviews[file];
      assert.equal(review?.sha256, digest(sql), file + " needs a source-bound migration review");
      for (const key of ["v1Compatibility", "rollbackPlan", "dataPreservation", "reviewedBy"]) assert.ok(typeof review[key] === "string" && review[key].trim().length > 10, "Missing migration review: " + key);
    }
  }
});
