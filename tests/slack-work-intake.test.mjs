import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../lib/slack-work-intake.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;

function load() {
  const module = { exports: {} };
  const dependencies = {
    "cloudflare:workers": { env: {} },
    "@/lib/billing": { BillingLimitError: class BillingLimitError extends Error {}, assertAiBudget: async () => ({ limitWon: 500, spentWonMicros: 0 }) },
    "@/lib/language-preferences": { readLanguagePreferences: async () => ({ resolvedLanguage: "ko" }) },
    "@/lib/pace-data": { getAiUsageSummary: async () => ({}), getWorkspaceRules: async () => ({}), recordAiUsageEvent: async () => {} },
    "@/lib/slack-daily": { slackApi: async () => ({ messages: [] }) },
    "@/lib/work-intake": { readWorkContext: async () => ({}), WORK_CLASSIFICATION: {} },
  };
  new Function("require", "module", "exports", compiled)((name) => dependencies[name] ?? require(name), module, module.exports);
  return module.exports;
}

test("Slack work draft accepts only valid hierarchy IDs and falls back to General", () => {
  const { normalizeSlackWorkDraft } = load();
  const context = {
    members: [
      { id: "member-a", displayName: "A", isCurrent: true },
      { id: "member-b", displayName: "B", isCurrent: false },
    ],
    parents: [
      { id: "initiative-a", kind: "initiative", path: ["Objective", "KR", "Initiative"] },
      { id: "project-a", kind: "project", path: ["Project"] },
    ],
    routines: [{ id: "routine-a", title: "Sales" }],
    fallback: { id: "general-a", title: "General" },
  };
  const task = normalizeSlackWorkDraft({
    kind: "task", title: "  Interview   customer ", description: "Scope", parentKind: "initiative",
    parentId: "initiative-a", parentReason: "wrong type", responsibleMemberId: "unknown",
    participantMemberIds: ["member-b"], dueDate: "tomorrow", priority: "medium", typeReason: "one result",
  }, context, "member-a", false, "medium");
  assert.equal(task.parentId, "general-a");
  assert.equal(task.parentKind, "routine");
  assert.equal(task.responsibleMemberId, "member-a");
  assert.deepEqual(task.participantMemberIds, []);
  assert.equal(task.dueDate, "");

  const project = normalizeSlackWorkDraft({
    kind: "project", title: "Launch", description: "", parentKind: "project", parentId: "project-a",
    parentReason: "", responsibleMemberId: "member-b", participantMemberIds: ["member-a", "unknown"],
    dueDate: "2026-09-30", priority: "high", typeReason: "multiple deliverables",
  }, context, "member-a", true, "low");
  assert.equal(project.parentId, "");
  assert.equal(project.parentKind, "initiative");
  assert.deepEqual(project.participantMemberIds, ["member-a"]);
  assert.equal(project.threadTruncated, true);
});

test("Slack work AI rate limit blocks both user and whole-company overuse", () => {
  const { assertSlackWorkRequestRate, SlackWorkIntakeError } = load();
  const runtime = {};
  const baseline = { spentWonMicros: 0, requestsToday: 0, requestsThisMinute: 0, workspaceRequestsToday: 0, workspaceRequestsThisMinute: 0 };
  assert.doesNotThrow(() => assertSlackWorkRequestRate(runtime, baseline));
  for (const usage of [
    { ...baseline, requestsThisMinute: 5 },
    { ...baseline, workspaceRequestsThisMinute: 12 },
    { ...baseline, requestsToday: 40 },
    { ...baseline, workspaceRequestsToday: 120 },
  ]) {
    assert.throws(() => assertSlackWorkRequestRate(runtime, usage), (error) => error instanceof SlackWorkIntakeError);
  }
});
