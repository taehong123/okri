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
    "@/lib/slack-mcp-context": {
      missingSlackThreadSourceMessage: () => "Slack에서 원본 스레드 내용을 받지 못해 아무 업무도 저장하지 않았습니다.",
    },
    "@/lib/work-intake": {
      assertConcreteWorkInput: () => {},
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
  const requests = [];
  const { readSlackThread } = load(async (_token, method, body) => {
    requests.push({ method, body });
    return {
      messages: [
        { user: "member-a", text: "", files: [{ id: "file-a", name: "error.png", mimetype: "image/png", size: 321, url_private_download: "https://files.slack.test/a" }] },
        { user: "member-a", text: "이 화면 오류 해결" },
      ],
      response_metadata: { next_cursor: "next" },
    };
  });
  const thread = await readSlackThread("token", { channel: "C1", channelType: "channel", user: "member-a", text: "", ts: "1.2" });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { method: "conversations.replies", body: { channel: "C1", ts: "1.2", limit: 15 } });
  assert.equal(thread.truncated, true);
  assert.equal(thread.imageFiles.length, 1);
  assert.deepEqual(thread.imageFiles[0], {
    id: "file-a", name: "error.png", mimeType: "image/png", size: 321, urlPrivateDownload: "https://files.slack.test/a",
  });
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].text, "이 화면 오류 해결");
});

test("Slack work draft stops before AI when thread history cannot be read", async () => {
  let modelCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    modelCalled = true;
    throw new Error("OpenAI must not be called");
  };
  try {
    const runtime = {
      OPENAI_API_KEY: "test-key",
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    };
    const { prepareSlackWorkDraft } = load(async () => { throw new Error("invalid_arguments"); }, { env: runtime });
    await assert.rejects(() => prepareSlackWorkDraft({
      authorization: { ownerId: "workspace-a", userId: "user-a" }, memberId: "member-a", token: "token",
      event: { channel: "C1", channelType: "channel", user: "member-a", text: "이 스레드로 Task 만들어줘", ts: "2.0", threadTs: "1.0" },
      query: "이 스레드로 Task 만들어줘",
    }), /아무 업무도 저장하지 않았습니다/);
    assert.equal(modelCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Slack thread reading recovers the root when replies returns only the current mention", async () => {
  const requests = [];
  const { readSlackThread } = load(async (_token, method, body) => {
    requests.push({ method, body });
    if (method === "conversations.replies") {
      return { messages: [{ user: "member-a", text: "<@BOT> 이 스레드 정리해줘", ts: "2.0" }] };
    }
    return { messages: [{
      user: "member-b", text: "고객 문의를 확인하고 수정한다", ts: "1.0",
      files: [{ id: "root-image", name: "issue.png", mimetype: "image/png", size: 100, url_private_download: "https://files.slack.test/root" }],
    }] };
  });
  const thread = await readSlackThread("token", {
    channel: "C1", channelType: "channel", user: "member-a", text: "이 스레드 정리해줘", ts: "2.0", threadTs: "1.0",
  });
  assert.deepEqual(requests.map((request) => request.method), ["conversations.replies", "conversations.history"]);
  assert.deepEqual(requests[1].body, { channel: "C1", latest: "1.0", inclusive: true, limit: 1 });
  assert.equal(thread.messages[0].text, "고객 문의를 확인하고 수정한다");
  assert.equal(thread.imageFiles[0].id, "root-image");
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

test("Slack work draft never falls back to a request when Slack cannot read the thread", async () => {
  let modelCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    modelCalled = true;
    throw new Error("OpenAI must not be called");
  };
  try {
    const runtime = {
      OPENAI_API_KEY: "test-key",
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    };
    const slackError = Object.assign(new Error("private channel history unavailable"), { code: "not_in_channel" });
    const { prepareSlackWorkDraft } = load(async () => { throw slackError; }, { env: runtime });
    await assert.rejects(() => prepareSlackWorkDraft({
      authorization: { ownerId: "workspace-a", userId: "user-a" }, memberId: "member-a", token: "token",
      event: { channel: "C1", channelType: "group", user: "member-a", text: "고객 오류 화면을 수정해 줘", ts: "1.2" },
      query: "고객 오류 화면을 수정해 줘",
    }), /아무 업무도 저장하지 않았습니다/);
    assert.equal(modelCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit thread creation intent never disappears when the model returns none", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    output_text: JSON.stringify({
      kind: "none", title: "", description: "", parentKind: "", parentId: "", parentReason: "",
      responsibleMemberId: "", participantMemberIds: [], dueDate: "", priority: "medium", typeReason: "",
    }),
    usage: { input_tokens: 80, output_tokens: 20 },
  });
  try {
    const runtime = {
      OPENAI_API_KEY: "test-key",
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    };
    const { prepareSlackWorkDraft } = load(async () => ({ messages: [
      { user: "member-b", text: "결제 오류 재현 조건을 문서화하고 수정한다" },
      { user: "member-a", text: "이 스레드 내용으로 업무 생성해 줘" },
    ] }), { env: runtime });
    const draft = await prepareSlackWorkDraft({
      authorization: { ownerId: "workspace-a", userId: "user-a" }, memberId: "member-a", token: "token",
      event: { channel: "C1", channelType: "channel", user: "member-a", text: "이 스레드 내용으로 업무 생성해 줘", ts: "1.2" },
      query: "이 스레드 내용으로 업무 생성해 줘",
    });
    assert.equal(draft.kind, "task");
    assert.equal(draft.title, "결제 오류 재현 조건을 문서화하고 수정한다");
    assert.equal(draft.parentId, "general-a");
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
