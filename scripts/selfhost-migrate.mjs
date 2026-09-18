import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const databasePath = resolve(process.env.OKRI_DB_PATH?.trim() || "/var/lib/okri/okri.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
db.exec(`CREATE TABLE IF NOT EXISTS okri_selfhost_migrations (
  tag TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

// Historical D1 releases have a few manually applied migrations that are
// intentionally absent from Drizzle's journal. The SQL files are immutable
// compatibility artifacts, so the self-hosted database uses the complete
// ordered file set rather than silently skipping those schema changes.
const tags = readdirSync(join(root, "drizzle"))
  .filter((name) => name.endsWith(".sql"))
  .map((name) => name.slice(0, -4))
  .sort();
for (const tag of tags) {
  const sql = readFileSync(join(root, "drizzle", `${tag}.sql`), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const prior = db.prepare("SELECT checksum FROM okri_selfhost_migrations WHERE tag = ?").get(tag);
  if (prior) {
    if (prior.checksum !== checksum) throw new Error(`Migration checksum changed: ${tag}`);
    continue;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO okri_selfhost_migrations (tag, checksum) VALUES (?, ?)").run(tag, checksum);
    db.exec("COMMIT");
    console.log(`Applied ${tag}`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
const compatibilityColumns = [
  ["routines", "trigger_point", "TEXT NOT NULL DEFAULT ''"],
  ["routines", "action_place", "TEXT NOT NULL DEFAULT ''"],
  ["routines", "action_steps", "TEXT NOT NULL DEFAULT ''"],
  ["routines", "system_key", "TEXT"],
  ["routines", "assignee_member_id", "TEXT REFERENCES workspace_members(id) ON DELETE SET NULL"],
  ["okr_cycles", "department", "TEXT NOT NULL DEFAULT ''"],
  ["items", "cycle_id", "TEXT REFERENCES okr_cycles(id) ON DELETE SET NULL"],
  ["items", "routine_id", "TEXT REFERENCES routines(id) ON DELETE SET NULL"],
  ["items", "archived_at", "TEXT"],
  ["items", "archived_from_status", "TEXT"],
  ["items", "archive_root_id", "TEXT"],
  ["items", "created_by_user_id", "TEXT"],
  ["integration_tokens", "last_used_at", "TEXT"],
  ["workspaces", "deletion_requested_at", "TEXT"],
  ["workspaces", "scheduled_deletion_at", "TEXT"],
  ["workspaces", "deletion_requested_by_user_id", "TEXT"],
  ["workspaces", "avatar_key", "TEXT"],
  ["workspaces", "avatar_updated_at", "TEXT"],
  ["workspaces", "kind", "TEXT NOT NULL DEFAULT 'team'"],
  ["property_definitions", "default_value", "TEXT NOT NULL DEFAULT 'null'"],
  ["property_definitions", "system_key", "TEXT"],
  ["property_definitions", "active", "INTEGER NOT NULL DEFAULT 1"],
  ["item_property_values", "legacy_value", "TEXT"],
  ["daily_scrums", "member_id", "TEXT REFERENCES workspace_members(id) ON DELETE CASCADE"],
  ["daily_scrums", "no_planned_tasks", "INTEGER NOT NULL DEFAULT 0"],
  ["daily_scrums", "work_status", "TEXT NOT NULL DEFAULT 'office'"],
  ["daily_scrums", "skip_reason", "TEXT"],
  ["daily_scrums", "skip_note", "TEXT NOT NULL DEFAULT ''"],
  ["daily_scrums", "source", "TEXT NOT NULL DEFAULT 'web'"],
  ["daily_submissions", "skip_reason", "TEXT"],
  ["daily_submissions", "skip_note", "TEXT NOT NULL DEFAULT ''"],
  ["daily_submissions", "work_status", "TEXT NOT NULL DEFAULT 'office'"],
  ["slack_daily_settings", "onboarding_completed_at", "TEXT"],
  ["slack_daily_settings", "summary_enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["slack_daily_settings", "summary_time", "TEXT NOT NULL DEFAULT '12:00'"],
  ["slack_daily_settings", "work_statuses", "TEXT NOT NULL DEFAULT '[\"office\",\"remote\",\"skip\"]'"],
];

function addColumnIfMissing(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info("${table}")`).all();
  if (columns.some((entry) => entry.name === column)) return;
  database.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
}

// Production D1 deployments have a small set of additive runtime schema
// upgrades that predate the immutable Drizzle journal. Apply the same
// idempotent compatibility shape before importing a Sites snapshot so no
// customer column is discarded merely because the target starts from empty.
for (const [table, column, definition] of compatibilityColumns) addColumnIfMissing(db, table, column, definition);
console.log("OKRI SQLite schema is current.");
