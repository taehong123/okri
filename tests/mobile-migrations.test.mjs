import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
const root = new URL("../", import.meta.url);
const read = p => readFile(new URL(p, root), "utf8");
const digest = s => createHash("sha256").update(s).digest("hex");
test("mobile v1 migration history is immutable and new destructive SQL requires an exact reviewed plan", async () => {
  const baseline = JSON.parse(await read("tests/fixtures/mobile-v1-migrations.json"));
  const reviews = JSON.parse(await read("mobile/release/migration-reviews.json"));
  for (const [file, hash] of Object.entries(baseline)) assert.equal(digest(await read(file)), hash, file + " changed; append a migration instead");
  for (const name of await readdir(new URL("drizzle/", root))) {
    const file = "drizzle/" + name;
    if (!name.endsWith(".sql") || file in baseline) continue;
    const sql = await read(file);
    assert.ok(!sql.includes("\r"), file + " must be LF");
    // Conservative review trigger, not a SQL correctness/semantic proof.
    const tokens = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").toUpperCase();
    if (/\b(?:DROP|RENAME|DELETE|UPDATE|REPLACE|PRAGMA)\b/.test(tokens) || /\bALTER\b[\s\S]*\bNOT\s+NULL\b/.test(tokens)) {
      const review = reviews[file];
      assert.equal(review?.sha256, digest(sql), file + " needs a source-bound migration review");
      for (const key of ["v1Compatibility", "rollbackPlan", "dataPreservation", "reviewedBy"]) assert.ok(typeof review[key] === "string" && review[key].trim().length > 10, "Missing migration review: " + key);
    }
  }
});
