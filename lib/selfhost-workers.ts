/**
 * Node-side replacement for `cloudflare:workers`.
 *
 * Vite aliases this module only when OKRI_RUNTIME=selfhost. Keeping the
 * Cloudflare import sites intact means the current deployment remains usable
 * until a verified cutover, while the self-hosted image has no Sites binding.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

type SqlValue = null | string | number | bigint | Uint8Array | ArrayBuffer;
type Metadata = Record<string, string>;

type RuntimeEnv = {
  DB: D1Database;
  WORKSPACE_AVATARS: R2Bucket;
  [key: string]: any;
};

class LocalStatement {
  constructor(private readonly database: LocalD1Database, private readonly query: string, private readonly values: SqlValue[] = []) {}

  bind(...values: SqlValue[]) {
    return new LocalStatement(this.database, this.query, values);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.database.handle.prepare(this.query).get(...this.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] ?? null : row) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.readResult<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    // Drizzle's D1 dialect maps selected fields by position and therefore
    // calls D1PreparedStatement.raw(), not all(). Node SQLite returns named
    // objects, so preserve SQLite's selected-column order as D1 does.
    const rows = this.database.handle.prepare(this.query).all(...this.values) as Record<string, unknown>[];
    return rows.map((row) => Object.keys(row).map((key) => row[key]) as unknown as T);
  }

  async run(): Promise<D1Result> {
    return this.writeResult();
  }

  readResult<T = Record<string, unknown>>(): D1Result<T> {
    const statement = this.database.handle.prepare(this.query);
    const rows = statement.all(...this.values) as T[];
    return { success: true, results: rows, meta: this.database.meta(0) } as D1Result<T>;
  }

  writeResult(): D1Result {
    const result = this.database.handle.prepare(this.query).run(...this.values);
    return { success: true, meta: this.database.meta(Number(result.changes), Number(result.lastInsertRowid)) } as D1Result;
  }

  executeInBatch(): D1Result {
    // D1 batches may include reads (for example snapshot collection) as well
    // as writes. RETURNING queries have read semantics too.
    if (/^\s*(?:select|pragma|explain)\b/i.test(this.query) || /\breturning\b/i.test(this.query)) return this.readResult();
    return this.writeResult();
  }
}

class LocalD1Database {
  readonly handle: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.handle = new DatabaseSync(path);
    this.handle.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  prepare(query: string) {
    return new LocalStatement(this, query);
  }

  close() {
    this.handle.close();
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const local = statements.map((statement) => {
      if (!(statement instanceof LocalStatement)) throw new Error("Self-hosted SQLite only accepts its own prepared statements");
      return statement;
    });
    this.handle.exec("BEGIN IMMEDIATE");
    try {
      const results = local.map((statement) => statement.executeInBatch());
      this.handle.exec("COMMIT");
      return results;
    } catch (error) {
      this.handle.exec("ROLLBACK");
      throw error;
    }
  }

  meta(changes: number, lastRowId = 0): D1Meta {
    return {
      changes,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      duration: 0,
      served_by: "okri-selfhost",
      internal_stats: null,
    } as D1Meta;
  }
}

type StoredMetadata = {
  contentType?: string;
  customMetadata?: Metadata;
  uploaded: string;
  etag: string;
};

class LocalR2Bucket {
  private readonly root: string;
  private readonly metadataRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.metadataRoot = join(this.root, ".okri-metadata");
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.metadataRoot, { recursive: true });
  }

  async put(key: string, value: BodyInit, options: R2PutOptions = {}) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const path = this.objectPath(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const metadata: StoredMetadata = {
      contentType: options.httpMetadata?.contentType,
      customMetadata: options.customMetadata,
      uploaded: new Date().toISOString(),
      etag: hash(bytes),
    };
    writeFileSync(this.metadataPath(key), JSON.stringify(metadata));
    return this.toObject(key, bytes, metadata) as unknown as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const path = this.objectPath(key);
    if (!existsSync(path)) return null;
    const bytes = new Uint8Array(readFileSync(path));
    return this.toObject(key, bytes, this.readMetadata(key, bytes)) as unknown as R2ObjectBody;
  }

  async head(key: string): Promise<R2Object | null> {
    const object = await this.get(key);
    if (!object) return null;
    const { body: _body, arrayBuffer: _arrayBuffer, text: _text, json: _json, ...metadata } = object as unknown as Record<string, unknown>;
    return metadata as R2Object;
  }

  async delete(keys: string | string[]) {
    for (const key of (Array.isArray(keys) ? keys : [keys])) {
      for (const path of [this.objectPath(key), this.metadataPath(key)]) {
        try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }

  private toObject(key: string, bytes: Uint8Array, metadata: StoredMetadata) {
    const httpMetadata = metadata.contentType ? { contentType: metadata.contentType } : {};
    const body = new Response(bytes).body!;
    return {
      key,
      version: metadata.etag,
      size: bytes.byteLength,
      etag: metadata.etag,
      httpEtag: `\"${metadata.etag}\"`,
      uploaded: new Date(metadata.uploaded),
      httpMetadata,
      customMetadata: metadata.customMetadata,
      body,
      bodyUsed: false,
      writeHttpMetadata(headers: Headers) { if (metadata.contentType) headers.set("Content-Type", metadata.contentType); },
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
    };
  }

  private objectPath(key: string) {
    const normalized = key.split("/").filter(Boolean);
    if (!normalized.length || normalized.some((part) => part === "." || part === ".." || part.includes("\\"))) throw new Error("Invalid storage key");
    const path = resolve(this.root, ...normalized);
    if (!path.startsWith(this.root + sep)) throw new Error("Invalid storage key");
    return path;
  }

  private metadataPath(key: string) {
    return join(this.metadataRoot, `${hash(new TextEncoder().encode(key))}.json`);
  }

  private readMetadata(key: string, bytes: Uint8Array): StoredMetadata {
    try { return JSON.parse(readFileSync(this.metadataPath(key), "utf8")) as StoredMetadata; }
    catch { return { uploaded: new Date().toISOString(), etag: hash(bytes) }; }
  }
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

let database: LocalD1Database | undefined;
let bucket: LocalR2Bucket | undefined;

/** Test-only lifecycle hook for isolated local SQLite bindings. */
export function closeSelfhostBindingsForTest() {
  database?.close();
  database = undefined;
  bucket = undefined;
}

function databaseBinding() {
  database ??= new LocalD1Database(process.env.OKRI_DB_PATH?.trim() || "/var/lib/okri/okri.sqlite");
  return database as unknown as D1Database;
}

function storageBinding() {
  bucket ??= new LocalR2Bucket(process.env.OKRI_STORAGE_PATH?.trim() || "/var/lib/okri/storage");
  return bucket as unknown as R2Bucket;
}

export const env = new Proxy({} as RuntimeEnv, {
  get(_target, property) {
    if (property === "DB") return databaseBinding();
    if (property === "WORKSPACE_AVATARS") return storageBinding();
    return typeof property === "string" ? process.env[property] : undefined;
  },
}) as RuntimeEnv;

/** Keep fire-and-forget delivery behavior without unhandled rejections in Node. */
export function waitUntil(promise: Promise<unknown>) {
  void promise.catch((error) => console.error("[okri background task]", error));
}
