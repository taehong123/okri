import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function compile(file) {
  const source = await readFile(new URL(`../lib/${file}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const compiled = { exports: {} };
  new Function("module", "exports", code)(compiled, compiled.exports);
  return compiled.exports;
}
const { guideCopy, guideKinds } = await compile("guide-copy");
const { buildGuideTree } = await compile("guide-example");
const { parseGuideDraft, saveGuideDraft, GUIDE_DRAFT_KEY } = await compile("guide-draft");

for (const language of ["ko", "en", "ja", "zh", "es"]) {
  test(`${language}: complete localized explanations and a valid five-level example`, () => {
    const copy = guideCopy[language];
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(guideCopy.ko).sort());
    function strings(value) {
      for (const entry of Object.values(value)) {
        if (typeof entry === "string") {
          assert.ok(entry.trim());
          if (language !== "ko") assert.doesNotMatch(entry, /[가-힣]/);
        } else strings(entry);
      }
    }
    strings(copy);
    const nodes = [];
    function walk(node, depth = 0) {
      nodes.push(node);
      assert.equal(node.kind, guideKinds[depth]);
      assert.ok(node.title);
      if (node.kind === "project") { assert.ok(node.person); assert.ok(Number.isFinite(Date.parse(node.date))); }
      if (node.kind === "task") { assert.ok(node.person); assert.equal(node.children, undefined); }
      if (node.kind === "key_result") assert.ok(node.metric[0] < node.metric[1]);
      for (const child of node.children ?? []) walk(child, depth + 1);
    }
    walk(buildGuideTree(copy));
    assert.equal(nodes.length, 17);
    assert.equal(new Set(nodes.map((node) => node.id)).size, 17);
  });
}
test("guide drafts are local, trimmed, bounded and expire after two hours", () => {
  const now = 1_000_000_000;
  const storage = new Map();
  saveGuideDraft({ setItem: (key, value) => storage.set(key, value) }, "  Goal\nDetails  ", now);
  const raw = storage.get(GUIDE_DRAFT_KEY);
  assert.equal(parseGuideDraft(raw, now), "Goal\nDetails");
  assert.equal(parseGuideDraft(raw, now + 7_200_001), null);
  assert.equal(parseGuideDraft(raw, now - 1), null);
  for (const invalid of [null, "", "null", "[]", "broken", JSON.stringify({ text: "x", savedAt: "today" }), JSON.stringify({ text: " ", savedAt: now }), JSON.stringify({ text: "a".repeat(1001), savedAt: now }), "x".repeat(7001)]) {
    assert.equal(parseGuideDraft(invalid, now), null);
  }
  assert.throws(() => saveGuideDraft({ setItem() {} }, ""));
  assert.throws(() => saveGuideDraft({ setItem() {} }, "x".repeat(1001)));
  assert.throws(() => saveGuideDraft({ setItem() { throw new Error("blocked"); } }, "Goal"), /blocked/);
});
