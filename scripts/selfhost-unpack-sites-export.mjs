import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve, sep } from "node:path";

const [sourceInput, destinationInput] = process.argv.slice(2);
if (!sourceInput || !destinationInput) throw new Error("Usage: node scripts/selfhost-unpack-sites-export.mjs <migration.ndjson> <import-directory>");
const sourcePath = resolve(sourceInput);
const destination = resolve(destinationInput);
if (!existsSync(sourcePath)) throw new Error("The Sites migration stream is missing");
if (existsSync(destination)) throw new Error("The import directory already exists; use a new empty path");

const staging = `${destination}.partial-${randomBytes(8).toString("hex")}`;
const r2Root = join(staging, "r2");
const objectRoot = join(r2Root, "objects");
const manifest = { version: 1, objects: [] };
const tableCounts = new Map();
let receivedRuntime = false;
let completed = false;

try {
  await mkdir(objectRoot, { recursive: true, mode: 0o700 });
  const sql = createWriteStream(join(staging, "d1-data.sql"), { flags: "wx", mode: 0o600 });
  sql.write("BEGIN;\nPRAGMA defer_foreign_keys = ON;\n");
  const lines = createInterface({ input: createReadStream(sourcePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record?.type === "runtime") {
      if (receivedRuntime) throw new Error("The Sites migration stream repeats runtime configuration");
      await writeRuntimeEnv(join(staging, "runtime.env"), record.values);
      receivedRuntime = true;
      continue;
    }
    if (record?.type === "table") {
      // Sites keeps its own deployment bookkeeping in `__appgarden_*`.
      // It is not part of the application schema and must never be imported
      // into the self-hosted SQLite database.
      if (typeof record.name === "string" && record.name.startsWith("__appgarden_")) continue;
      const table = identifier(record.name);
      if (!Array.isArray(record.rows)) throw new Error(`Invalid table rows for ${table}`);
      for (const row of record.rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Invalid row for ${table}`);
        const columns = Object.keys(row);
        if (!columns.length) continue;
        sql.write(`INSERT OR REPLACE INTO ${table} (${columns.map(identifier).join(", ")}) VALUES (${columns.map((column) => sqlValue(row[column])).join(", ")});\n`);
      }
      tableCounts.set(table, (tableCounts.get(table) ?? 0) + record.rows.length);
      continue;
    }
    if (record?.type === "object") {
      const key = objectKey(record.key);
      if (typeof record.data !== "string") throw new Error(`Object ${key} has no base64 data`);
      const target = inside(objectRoot, join(objectRoot, ...key.split("/")));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(record.data, "base64"), { mode: 0o600, flag: "wx" });
      manifest.objects.push({ key, contentType: stringOrUndefined(record.contentType), customMetadata: stringMap(record.customMetadata), uploaded: stringOrUndefined(record.uploaded) });
      continue;
    }
    if (record?.type === "complete") { completed = true; continue; }
    throw new Error("The Sites migration stream contains an unknown record");
  }
  await new Promise((resolveStream, rejectStream) => sql.end("COMMIT;\n", (error) => error ? rejectStream(error) : resolveStream()));
  if (!receivedRuntime || !completed) throw new Error("The Sites migration stream ended before completion");
  await writeFile(join(r2Root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(join(staging, "counts.json"), JSON.stringify({ tables: Object.fromEntries(tableCounts), objects: manifest.objects.length }), { mode: 0o600 });
  await mkdir(dirname(destination), { recursive: true, mode: 0o750 });
  await writeFile(join(staging, ".complete"), "ok\n", { mode: 0o600 });
  await renameDirectory(staging, destination);
  console.log(`Prepared protected import: tables=${tableCounts.size}, objects=${manifest.objects.length}`);
} catch (error) {
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  throw error;
}

async function writeRuntimeEnv(path, rawValues) {
  if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) throw new Error("The Sites migration stream has no runtime configuration");
  const entries = Object.entries(rawValues)
    .filter(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === "string" && key !== "OKRI_MIGRATION_EXPORT_TOKEN")
    .sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) throw new Error("The Sites migration stream has no usable runtime configuration");
  for (const [key, value] of entries) {
    if (value.includes("\n") || value.includes("\r")) throw new Error(`Runtime value ${key} cannot be moved through env-file format`);
  }
  entries.push(["OKRI_SCHEDULER_TOKEN", randomBytes(48).toString("base64url")]);
  await writeFile(path, entries.map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
}

function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("The Sites migration stream has an invalid SQL identifier");
  return `\"${value}\"`;
}

function sqlValue(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("The Sites migration stream has a non-finite number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (value && typeof value === "object" && typeof value.base64 === "string" && Object.keys(value).length === 1) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) throw new Error("The Sites migration stream has an invalid blob");
    return `X'${Buffer.from(value.base64, "base64").toString("hex")}'`;
  }
  throw new Error("The Sites migration stream has an unsupported SQL value");
}

function objectKey(value) {
  if (typeof value !== "string") throw new Error("The Sites migration stream has an invalid object key");
  const pieces = value.split("/").filter(Boolean);
  if (!pieces.length || pieces.some((piece) => piece === "." || piece === ".." || piece.includes("\\"))) throw new Error("The Sites migration stream has an unsafe object key");
  return pieces.join("/");
}

function inside(root, path) {
  const relativePath = relative(root, path);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === ".." || resolve(root, relativePath) !== resolve(path)) throw new Error("The Sites migration stream escapes its import directory");
  return path;
}

function stringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([, entry]) => typeof entry === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function stringOrUndefined(value) { return typeof value === "string" ? value : undefined; }

async function renameDirectory(from, to) {
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
}
