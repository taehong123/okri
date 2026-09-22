import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/team-role.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loadedModule = { exports: {} };
new Function("module", "exports", compiled)(loadedModule, loadedModule.exports);
const { normalizeTeamRole } = loadedModule.exports;

test("workspace roles normalize case and whitespace", () => {
  assert.equal(normalizeTeamRole(" Owner "), "owner");
  assert.equal(normalizeTeamRole("ADMIN"), "admin");
});

test("unknown workspace roles fail closed unless ownership is independently known", () => {
  assert.equal(normalizeTeamRole("legacy_admin"), "viewer");
  assert.equal(normalizeTeamRole(undefined), "viewer");
  assert.equal(normalizeTeamRole("legacy_owner", "owner"), "owner");
});
