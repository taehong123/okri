import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const databasePath = resolve(process.env.OKRI_DB_PATH?.trim() || "/var/lib/okri/okri.sqlite");
const sourcePath = resolve(process.env.OKRI_D1_EXPORT_PATH?.trim() || "");
if (!sourcePath || !existsSync(sourcePath)) throw new Error("Set OKRI_D1_EXPORT_PATH to the data-only D1 SQL export");
const sql = readFileSync(sourcePath, "utf8");
if (!sql.trim()) throw new Error("D1 export is empty");
if (/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/i.test(sql)) {
  throw new Error("D1 import must be data-only. Apply immutable drizzle migrations before importing customer data.");
}

const checksum = createHash("sha256").update(sql).digest("hex");
const db = new DatabaseSync(databasePath);
try {
  db.exec(`CREATE TABLE IF NOT EXISTS okri_selfhost_imports (
    source_checksum TEXT PRIMARY KEY NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const prior = db.prepare("SELECT source_checksum FROM okri_selfhost_imports WHERE source_checksum = ?").get(checksum);
  if (prior) {
    console.log("This D1 export was already imported.");
    process.exit(0);
  }
  const existing = db.prepare("SELECT count(*) AS count FROM users").get();
  if (Number(existing.count) > 0) throw new Error("Target database already contains users; refusing to merge a D1 export");

  // Cloudflare's data-only export is transaction-wrapped. Keeping that
  // transaction intact gives us an all-or-nothing import and avoids altering
  // its original statement order.
  db.exec(sql);
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`D1 import has ${violations.length} foreign-key violations`);
  db.prepare("INSERT INTO okri_selfhost_imports (source_checksum) VALUES (?)").run(checksum);
  const counts = db.prepare(`SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM workspaces) AS workspaces,
      (SELECT count(*) FROM items) AS items,
      (SELECT count(*) FROM workspace_members) AS members`).get();
  console.log(`Imported D1 data: users=${counts.users}, workspaces=${counts.workspaces}, items=${counts.items}, members=${counts.members}`);
} finally {
  db.close();
}
