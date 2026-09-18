import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("self-hosted schema includes additive D1 compatibility columns", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "okri-selfhost-schema-"));
  const databasePath = join(scratch, "okri.sqlite");
  try {
    execFileSync(process.execPath, ["--experimental-sqlite", "scripts/selfhost-migrate.mjs"], {
      cwd: root,
      env: { ...process.env, OKRI_DB_PATH: databasePath },
      stdio: "pipe",
    });
    const database = new DatabaseSync(databasePath);
    try {
      for (const [table, column] of [["okr_cycles", "department"], ["slack_daily_settings", "onboarding_completed_at"], ["routines", "trigger_point"]]) {
        const columns = database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name);
        assert.ok(columns.includes(column), `${table}.${column} is present`);
      }
    } finally {
      database.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
