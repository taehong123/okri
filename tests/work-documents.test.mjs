import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrl = new URL("../drizzle/0057_work_documents.sql", import.meta.url);

test("Routine document migration is additive, LF-only, and preserves existing guides", async (t) => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.ok(!migration.includes("\r"));
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE routines (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    action_steps TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO routines (id, owner_id, description, action_steps) VALUES ('routine', 'workspace', 'purpose', 'step one');`);
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  const stored = db.prepare(`SELECT description, action_steps, document_content, document_plain_text,
    document_version, document_updated_at FROM routines WHERE id = 'routine'`).get();
  assert.deepEqual({ ...stored }, {
    description: "purpose",
    action_steps: "step one",
    document_content: "[]",
    document_plain_text: "",
    document_version: 0,
    document_updated_at: null,
  });
});

test("Task and Routine documents share the Project editor without changing hierarchy", async () => {
  const [page, route, data, backups] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/work-documents/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/workspace-backups.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /targetKind="task" targetId=\{task\.id\}/);
  assert.match(page, /targetKind="routine" targetId=\{routine\.id\}/);
  assert.match(page, /<ClientProjectBlockEditor[\s\S]*initialContent=\{document\.content\}/);
  assert.match(page, /routine\.systemKey !== "general"[\s\S]*<div className="routine-details"/);
  assert.match(route, /authorizeRequest\(request, \{ allowViewerWrite: true \}\)/);
  assert.match(route, /const authorization = await authorizeRequest\(request\);/);
  assert.match(data, /getItemBackedDocument\(ownerId, targetId, "task"\)/);
  assert.match(data, /systemKey === GENERAL_ROUTINE_SYSTEM_KEY/);
  assert.match(data, /document_version = \?/);
  assert.match(backups, /document_content,document_plain_text,document_version,document_updated_at/);
});

test("work document writes require an exact optimistic version", async () => {
  const data = await readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8");
  const itemSave = data.slice(data.indexOf("async function saveItemBackedDocument("), data.indexOf("export type WorkDocumentTargetKind"));
  const routineSave = data.slice(data.indexOf("export async function saveWorkDocument("), data.indexOf("export async function listProjectTemplates("));
  assert.match(itemSave, /input\.expectedVersion !== currentVersion/);
  assert.match(itemSave, /project_id = \? AND version = \?/);
  assert.match(routineSave, /input\.expectedVersion !== routine\.documentVersion/);
  assert.match(routineSave, /document_version = \?/);
  assert.match(routineSave, /AND document_version = \?/);
});
