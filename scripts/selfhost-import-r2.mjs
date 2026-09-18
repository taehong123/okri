import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const importRoot = resolve(process.env.OKRI_R2_EXPORT_PATH?.trim() || "");
const storageRoot = resolve(process.env.OKRI_STORAGE_PATH?.trim() || "/var/lib/okri/storage");
const manifestPath = join(importRoot, "manifest.json");
if (!existsSync(manifestPath)) throw new Error("Set OKRI_R2_EXPORT_PATH to an R2 export folder containing manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest?.version !== 1 || !Array.isArray(manifest.objects)) {
  throw new Error("R2 manifest must be { version: 1, objects: [{ key, contentType?, customMetadata? }] }");
}
if (existsSync(storageRoot) && existsSync(join(storageRoot, ".okri-metadata"))) {
  throw new Error("Target storage already has metadata; refusing to merge an R2 export");
}
mkdirSync(storageRoot, { recursive: true });
const metadataRoot = join(storageRoot, ".okri-metadata");
mkdirSync(metadataRoot, { recursive: true });

for (const raw of manifest.objects) {
  if (!raw || typeof raw.key !== "string") throw new Error("R2 manifest contains an invalid object key");
  const key = validKey(raw.key);
  const source = within(importRoot, join(importRoot, "objects", ...key.split("/")));
  if (!existsSync(source)) throw new Error(`R2 export is missing object: ${key}`);
  const target = within(storageRoot, join(storageRoot, ...key.split("/")));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { preserveTimestamps: true });
  const bytes = readFileSync(target);
  const etag = createHash("sha256").update(bytes).digest("hex");
  const metadata = {
    contentType: typeof raw.contentType === "string" ? raw.contentType : undefined,
    customMetadata: stringMap(raw.customMetadata),
    uploaded: typeof raw.uploaded === "string" ? raw.uploaded : new Date().toISOString(),
    etag,
  };
  const metadataFile = join(metadataRoot, `${createHash("sha256").update(key).digest("hex")}.json`);
  writeFileSync(metadataFile, JSON.stringify(metadata));
}
console.log(`Imported ${manifest.objects.length} R2 objects with metadata.`);

function validKey(value) {
  const pieces = value.split("/").filter(Boolean);
  if (!pieces.length || pieces.some((piece) => piece === "." || piece === ".." || piece.includes("\\"))) throw new Error("Invalid R2 object key");
  return pieces.join("/");
}

function within(root, path) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  if (!absolutePath.startsWith(absoluteRoot + sep)) throw new Error("R2 export path escapes its root");
  return absolutePath;
}

function stringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([, entry]) => typeof entry === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}
