import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the protected Sites stream becomes a data-only D1/R2 import", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "okri-sites-export-"));
  try {
    const source = join(scratch, "transfer.ndjson");
    const output = join(scratch, "import");
    await writeFile(source, [
      JSON.stringify({ type: "runtime", values: { GOOGLE_CLIENT_ID: "client", SLACK_TOKEN_ENCRYPTION_KEY: "key", OKRI_MIGRATION_EXPORT_TOKEN: "never-copy" } }),
      JSON.stringify({ type: "table", name: "users", rows: [{ id: "user-1", email: "owner@example.com", enabled: true }, { id: "user-2", email: null, payload: { base64: "AQI=" } }] }),
      JSON.stringify({ type: "object", key: "document-images/v1/owner/project/picture", contentType: "image/png", customMetadata: { ownerId: "owner" }, data: "AQID" }),
      JSON.stringify({ type: "complete" }),
      "",
    ].join("\n"));
    execFileSync(process.execPath, ["scripts/selfhost-unpack-sites-export.mjs", source, output], { cwd: root, stdio: "pipe" });
    const sql = await readFile(join(output, "d1-data.sql"), "utf8");
    assert.match(sql, /^BEGIN;\nPRAGMA defer_foreign_keys = ON;/);
    assert.match(sql, /INSERT OR REPLACE INTO "users"/);
    assert.match(sql, /X'0102'/);
    assert.match(sql, /COMMIT;\n$/);
    const runtime = await readFile(join(output, "runtime.env"), "utf8");
    assert.match(runtime, /^GOOGLE_CLIENT_ID=client$/m);
    assert.doesNotMatch(runtime, /OKRI_MIGRATION_EXPORT_TOKEN/);
    assert.match(runtime, /^OKRI_SCHEDULER_TOKEN=.+$/m);
    const manifest = JSON.parse(await readFile(join(output, "r2", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.objects[0].customMetadata, { ownerId: "owner" });
    assert.deepEqual([...await readFile(join(output, "r2", "objects", "document-images", "v1", "owner", "project", "picture"))], [1, 2, 3]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the receiver keeps the temporary transfer path protected", async () => {
  const source = await readFile(new URL("../app/api/internal/migration-receiver/route.ts", import.meta.url), "utf8");
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /migration-receiver-token\.sha256/);
  assert.match(source, /Access-Control-Allow-Origin/);
  assert.match(source, /MAX_TRANSFER_BYTES/);
  assert.match(source, /migration-transfer\.ndjson/);
  assert.match(source, /Cache-Control.*no-store/);
});
