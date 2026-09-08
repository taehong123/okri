import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import ts from "../../node_modules/typescript/lib/typescript.js";
import { compileLanguageModule, catalogs, language } from "../../tests/helpers/language-fixture.mjs";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const model = compileLanguageModule(await read("../src/model.ts"));
const i18n = compileLanguageModule(await read("../src/i18n.ts"), {
  "../../lib/language": language,
  ...Object.fromEntries(Object.entries(catalogs).map(([key, module]) => [`../../lib/locales/${key}`, module])),
});

test("device language fallback supports all five languages", () => {
  for (const [value, expected] of [["ko-KR", "ko"], ["EN_us", "en"], ["ja-JP", "ja"], ["zh-TW", "zh"], ["es-MX", "es"], ["fr", "en"], [null, "en"]]) assert.equal(i18n.resolveLanguage(value), expected);
});
test("native copy has no untranslated Korean in non-Korean languages", async () => {
  const keys = new Set();
  const files = ["../App.tsx"];
  for (const dir of ["../src/", "../src/screens/"]) for (const file of await readdir(new URL(dir, import.meta.url))) if (/\.tsx?$/.test(file) && file !== "i18n.ts") files.push(dir + file);
  for (const file of files) {
    const tree = ts.createSourceFile(file, await read(file), ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isStringLiteral(node) && /[가-힣]/.test(node.text)) keys.add(node.text);
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  const missing = [];
  for (const key of keys) for (const lang of ["en", "ja", "zh", "es"]) if (/[가-힣]/.test(i18n.translator(lang)(key))) missing.push(`${lang}: ${key}`);
  assert.deepEqual(missing, []);
});
test("projects and routines stay peers and tasks attach to their own parent", () => {
  const groups = model.workGroups([
    { key: "task:t", id: "t", kind: "task", title: "Task", parentId: "r", parentKind: "routine", parentTitle: "Routine" },
    { key: "routine:r", id: "r", kind: "routine", title: "Routine" },
    { key: "project:p", id: "p", kind: "project", title: "Project" },
  ]);
  assert.deepEqual(groups.map(g => [g.kind, g.children.length]), [["routine", 1], ["project", 0]]);
  assert.equal(groups[0].parent.id, "r");
});
test("overdue uses dates, excludes completed and archived tasks, and handles DST", () => {
  assert.equal(model.overdue({ dueDate: "2026-09-06", status: "todo" }, "2026-09-07"), true);
  for (const status of ["done", "development_done", "archived"]) assert.equal(model.overdue({ dueDate: "2020-01-01", status }, "2026-09-07"), false);
  assert.equal(model.plusDays("2026-03-08", 1), "2026-03-09");
  assert.equal(model.dayOffset("2026-11-02", "2026-10-31"), 2);
});
test("assigned tasks never include another member's tasks", () => {
  const data = { user: { id: "u" }, team: { members: [{ id: "m", userId: "u", status: "active" }] }, items: [
    { id: "mine", kind: "task", status: "todo", assignments: [{ role: "task_assignee", memberId: "m" }] },
    { id: "theirs", kind: "task", status: "todo", assignments: [{ role: "task_assignee", memberId: "other" }] },
  ] };
  assert.deepEqual(model.myTasks(data).map(i => i.id), ["mine"]);
});
test("API sends native bearer, language and workspace without cookies; writes are not retried", async () => {
  const api = compileLanguageModule(await read("../src/api.ts"));
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ ok: true }); };
  try {
    await api.request("/api/items", { accessToken: "mock" }, "workspace", "es", { method: "PATCH", body: "{}" });
    assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://okri.ai/api/items");
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer mock");
    assert.equal(calls[0].init.headers.get("x-okri-workspace-id"), "workspace");
    assert.equal(calls[0].init.headers.get("accept-language"), "es");
    assert.equal(calls[0].init.credentials, "omit");
    await assert.rejects(api.request("https://elsewhere.test/api/", null, null, "en"));
    globalThis.fetch = async () => Response.json({ error: "Expired" }, { status: 401 });
    await assert.rejects(api.request("/api/items", null, null, "en"), error => error.status === 401);
  } finally { globalThis.fetch = previous; }
});
