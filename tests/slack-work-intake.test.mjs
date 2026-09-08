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

function load(slackApi = async () => ({ messages: [] }), options = {}) {
  const loaded = { exports: {} };
  const runtime = options.env ?? {};
  const dependencies = {
    "cloudflare:workers": { env: runtime },
    "@/lib/billing": { BillingLimitError: class BillingLimitError extends Error {}, assertAiBudget: async () => ({ limitWon: 500, spentWonMicros: 0 }) },
    "@/lib/language-preferences": { readLanguagePreferences: async () => ({ resolvedLanguage: "ko" }) },
    "@/lib/pace-data": {
      getAiUsageSummary: async () => ({ spentWonMicros: 0, requestsToday: 0, requestsThisMinute: 0, workspaceRequestsToday: 0, workspaceRequestsThisMinute: 0 }),
      getWorkspaceRules: async () => ({ defaultPriority: "medium" }),
      reserveAiUsageEvent: async () => "reservation-a",
      finalizeAiUsageEvent: async () => {},
      releaseAiUsageReservation: async () => {},
      ...options.paceData,
    },
    "@/lib/slack-daily": { slackApi },
    "@/lib/work-intake": {
      readWorkContext: async () => ({
        members: [{ id: "member-a", displayName: "A", isCurrent: true }],
        parents: [], routines: [], fallback: { id: "general-a", title: "General" },
      }),
      WORK_CLASSIFICATION: {},
      ...options.workIntake,
    },
  };
  new Function("require", "module", "exports", compiled)((name) => dependencies[name] ?? require(name), loaded, loaded.exports);
  return loaded.exports;
}

test("Slack thread reading keeps image-only messages as bounded Project attachments", async () => {
  const { readSlackThread } = load(async () => ({
    messages: [
      { user: "member-a", text: "", files: [{ id: "file-a", name: "error.png", mimetype: "image/png", size: 321, url_private_download: "https://files.slack.test/a" }] },
      { user: "member-a", text: "이 화면 오류 해결" },
    ],
  }));
  const thread = await readSlackThread("token", { channel: "C1", channelType: "channel", user: "member-a", text: "", ts: "1.2" });
  assert.equal(thread.imageFiles.length, 1);
  assert.deepEqual(thread.imageFiles[0], {
    id: "file-a", name: "error.png", mimeType: "image/png", size: 321, urlPrivateDownload: "https://files.slack.test/a",
  });
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].text, "이 화면 오류 해결");
});

test("Slack work draft retries a rejected structured response with JSON compatibility mode", async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) {
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "unsupported_format", param: "text.format" } }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    return Response.json({
      output_text: JSON.stringify({
        kind: "task", title: "오류 화면 수정", description: "화면 오류를 재현하고 수정한다.",
        parentKind: "routine", parentId: "general-a", parentReason: "", responsibleMemberId: "member-a",
        participantMemberIds: [], dueDate: "", priority: "medium", typeReason: "한 가지 완료 결과",
      }),
      usage: { input_tokens: 120, output_tokens: 60 },
    });
  };
  try {
    const runtime = {
      OPENAI_API_KEY: "test-key",
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    };
    const { prepareSlackWorkDraft } = load(async () => ({ messages: [{ user: "member-a", text: "오류 화면을 수정해 줘" }] }), { env: runtime });
    const draft = await prepareSlackWorkDraft({
      authorization: { ownerId: "workspace-a", userId: "user-a" }, memberId: "member-a", token: "token",
      event: { channel: "C1", channelType: "channel", user: "member-a", text: "오류 화면을 수정해 줘", ts: "1.2" },
      query: "오류 화면을 수정해 줘",
    });
    assert.equal(draft.kind, "task");
    assert.equal(draft.title, "오류 화면 수정");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].text.format.type, "json_schema");
    assert.equal(requests[1].text.format.type, "json_object");
    assert.equal("reasoning" in requests[1], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
