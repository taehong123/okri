import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import ts from "typescript";

const source = await readFile(new URL("../lib/selfhost-workers.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;

async function loadSelfhostWorkers() {
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}#${crypto.randomUUID()}`);
}

test("self-hosted D1 binding supports Drizzle field mapping", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "okri-selfhost-workers-"));
  const databasePath = join(scratch, "okri.sqlite");
  const previousPath = process.env.OKRI_DB_PATH;
  process.env.OKRI_DB_PATH = databasePath;
  let runtime;
  try {
    runtime = await loadSelfhostWorkers();
    const { env } = runtime;
    await env.DB.prepare("CREATE TABLE records (id TEXT PRIMARY KEY, title TEXT NOT NULL)").run();
    await env.DB.prepare("INSERT INTO records (id, title) VALUES (?, ?)").bind("record-1", "Slack 연결").run();
    assert.deepEqual(await env.DB.prepare("SELECT id, title FROM records").raw(), [["record-1", "Slack 연결"]]);

    const db = drizzle(env.DB);
    const rows = await db.select({ id: sql`id`, title: sql`title` }).from(sql`records`);
    assert.deepEqual(rows, [{ id: "record-1", title: "Slack 연결" }]);
  } finally {
    runtime?.closeSelfhostBindingsForTest();
    if (previousPath === undefined) delete process.env.OKRI_DB_PATH;
    else process.env.OKRI_DB_PATH = previousPath;
    await rm(scratch, { recursive: true, force: true });
  }
});
