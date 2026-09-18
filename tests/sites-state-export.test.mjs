import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/sites-state-export.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/internal/sites-state-export/route.ts", import.meta.url), "utf8");

test("migration export is an unlisted token-gated, no-store NDJSON stream", () => {
  assert.match(route, /exportState\(request, env\)/);
  assert.match(source, /OKRI_MIGRATION_EXPORT_TOKEN/);
  assert.match(source, /key !== "OKRI_MIGRATION_EXPORT_TOKEN"/);
  assert.match(source, /application\/x-ndjson/);
  assert.match(source, /Cache-Control": "no-store"/);
  assert.match(source, /status: 404/);
  assert.doesNotMatch(source, /console\./);
});

test("migration export includes paged D1 tables, paged R2 objects, and completion", () => {
  assert.match(source, /sqlite_master/);
  assert.match(source, /LIMIT \? OFFSET \?/);
  assert.match(source, /type: "table"/);
  assert.match(source, /WORKSPACE_AVATARS\.list/);
  assert.match(source, /page\.truncated \? page\.cursor/);
  assert.match(source, /type: "object"/);
  assert.match(source, /type: "complete"/);
});

test("CORS is restricted to ChatGPT and the requested headers", () => {
  assert.match(source, /https:\/\/chatgpt\.com/);
  assert.match(source, /x-okri-migration-token, content-type/);
  assert.match(source, /POST, OPTIONS/);
});
