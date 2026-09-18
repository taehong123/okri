import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const configuredDataPath = process.env.OKRI_DATA_PATH?.trim();
const databasePath = resolve(process.env.OKRI_DB_PATH?.trim() || join(configuredDataPath || "/var/lib/okri", "okri.sqlite"));
const dataRoot = resolve(configuredDataPath || dirname(databasePath));
const storagePath = resolve(process.env.OKRI_STORAGE_PATH?.trim() || join(dataRoot, "storage"));
const backupRoot = resolve(process.env.OKRI_BACKUP_PATH?.trim() || join(dataRoot, "backups"));
if (!databasePath.startsWith(dataRoot) || !storagePath.startsWith(dataRoot) || !backupRoot.startsWith(dataRoot)) {
  throw new Error("Self-hosted backup paths must stay under OKRI_DATA_PATH");
}
if (!existsSync(databasePath)) throw new Error("OKRI database does not exist; refusing to create an empty backup");

const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
const target = join(backupRoot, stamp);
mkdirSync(target, { recursive: true });

const database = new DatabaseSync(databasePath);
try {
  // VACUUM INTO is SQLite's consistent online snapshot mechanism. Copying the
  // database file directly would lose committed WAL pages while the app runs.
  database.prepare("VACUUM INTO ?").run(join(target, "okri.sqlite"));
} finally {
  database.close();
}

if (existsSync(storagePath)) cpSync(storagePath, join(target, "storage"), { recursive: true, preserveTimestamps: true });
const backups = readdirSync(backupRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}\d{3}Z$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
for (const expired of backups.slice(0, Math.max(0, backups.length - 30))) {
  rmSync(join(backupRoot, expired), { recursive: true, force: true });
}
console.log(`Created self-hosted backup ${target}`);
