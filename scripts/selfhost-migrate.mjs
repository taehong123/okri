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
console.log("OKRI SQLite schema is current.");
