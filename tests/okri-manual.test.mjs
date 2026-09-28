import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { compileLanguageModule as compile } from "./helpers/language-fixture.mjs";
import { okriManual as manual, slackGuide } from "./helpers/okri-manual-fixture.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const parser = compile(await read("lib/slack-work-command-parser.ts"));

test("manual index, topic lookup and bounded search distinguish missing topics", () => {
  const index = manual.readOkriManual();
  assert.equal(index.index.length, 12);
  assert.equal(new Set(index.index.map(({ id }) => id)).size, index.index.length);
  assert.equal(index.articles.length, 0);
  assert.equal(manual.readOkriManual({ topic: "all" }).articles.length, index.index.length);
  assert.equal(manual.readOkriManual({ topic: "does-not-exist" }).found, false);
  assert.equal(manual.readOkriManual({ query: "xyzw-unknown-feature" }).found, false);
  for (const [query, id] of [["Task 생성 방법", "tasks"], ["허들 Canvas 오류", "troubleshooting"], ["명령어 전부 알려줘", "slack-commands"], ["봇 기능 알려줘", "slack-ai"], ["KR 진행률 데이터", "data"]]) {
    const result = manual.readOkriManual({ query, surface: "slack" });
    assert.ok(result.articles.some((article) => article.id === id), query);
    assert.ok(result.articles.length <= 4);
    assert.equal(result.surface, "slack");
  }
  assert.ok(JSON.stringify(manual.readOkriManual({ topic: "all" })).length < 24_000);
});

test("usage questions do not swallow live data requests or actions with manual titles", () => {
  for (const query of ["매뉴얼", "!도움말", "프로젝트 생성 방법 알려줘", "Task를 어떻게 만들어?", "OKRI 기능 모두 알려줘", "느낌표 명령어가 뭐야?", "How do I create a Project?", "What is a Routine?", "Canvas 사용 방법", "OKR과 프로젝트 차이"]) {
    assert.equal(manual.isOkriManualQuestion(query), true, query);
  }
  for (const query of ["안녕", "내 Task 알려줘", "오늘 데일리 보여줘", "현재 프로젝트는 뭐야?", "How many Tasks are due today?", "사용법 매뉴얼 프로젝트 만들어줘", "명령어 설명 Task 생성해줘", "프로젝트 A 삭제해줘", "Create a Task called manual", "우리 팀 데일리 왜 없어?"]) {
    assert.equal(manual.isOkriManualQuestion(query), false, query);
  }
});

test("all parsed command functions appear in the shared guide, with docs kept in sync", async () => {
  const documented = slackGuide.SLACK_WORK_GUIDE_GROUPS.flatMap(({ entries }) => entries)
    .flatMap(({ command }) => command.split(" · "))
    .map((command) => parser.parseSlackWorkCommand(command)?.command).filter(Boolean);
  assert.deepEqual(new Set(documented), new Set(parser.SLACK_WORK_COMMANDS));
  assert.equal((await read("docs/OKRI_MANUAL.md")).replaceAll("\r\n", "\n"), manual.renderOkriManualMarkdown());
  const article = manual.readOkriManual({ topic: "slack-commands" }).articles[0].content;
  assert.ok(article.includes(slackGuide.slackWorkGuideText((text) => text)));
});

test("read_manual is a working MCP read-only tool, including unknown topics", async () => {
  const source = await read("app/mcp/route.ts");
  const ast = ts.createSourceFile("mcp.ts", source, ts.ScriptTarget.Latest, true);
  let registration;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "server.registerTool"
      && node.arguments[0]?.getText(ast) === '"read_manual"') registration = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(registration);
  // The extracted registration uses the production schema and handler.
  const js = ts.transpileModule(`export function register(server) { ${registration}; }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new Function("module", "exports", "z", "MANUAL_SURFACES", "readOkriManual", js)(loaded, loaded.exports, z, manual.MANUAL_SURFACES, manual.readOkriManual);
  const server = new McpServer({ name: "test-manual", version: "1" });
  loaded.exports.register(server);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const listing = await client.listTools();
    assert.equal(listing.tools[0].annotations.readOnlyHint, true);
    assert.equal(listing.tools[0].annotations.destructiveHint, false);
    const result = await client.callTool({ name: "read_manual", arguments: { query: "느낌표 명령어", surface: "slack" } });
    assert.notEqual(result.isError, true);
    assert.ok(result.structuredContent.manual.articles.some(({ id }) => id === "slack-commands"));
    const missing = await client.callTool({ name: "read_manual", arguments: { topic: "not-real" } });
    assert.equal(missing.structuredContent.manual.found, false);
    const invalid = await client.callTool({ name: "read_manual", arguments: { query: "x".repeat(501) } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
  const intake = compile(await read("lib/work-intake.ts"));
  assert.equal(intake.isReadOnlyMcpRequest({ method: "tools/call", params: { name: "read_manual" } }), true);
});

test("Slack routes tagged help without AI and natural DM usage without creating drafts", async () => {
  const events = await read("app/api/slack/events/route.ts");
  for (const [type, text, expected] of [
    ["app_mention", "<@UBOT> !도움말", "help"],
    ["app_mention", "<@UBOT> !manual", "help"],
    ["app_mention", "<@UBOT> 프로젝트 생성 방법 알려줘", "ai"],
    ["message", "Task 생성 방법 알려줘", "ai"],
    ["message", "고객 인터뷰 준비해줘", "work_create"],
  ]) {
    const calls = [], pending = [];
    const route = compile(events, {
      "@/lib/okri-manual": manual,
      "cloudflare:workers": { env: { DB: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) } }, waitUntil: (p) => pending.push(p) },
      "@/lib/pace-data": { getSlackConnectionByTeam: async () => ({ botUserId: "UBOT" }) },
      "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => true },
      "@/lib/slack-daily": {},
      "@/lib/slack-work-command": { ...parser, handleSlackWorkCommandEvent: async (_req, _c, _e, parsed) => calls.push(parsed.command) },
      "@/lib/slack-mcp-agent": { handleSlackMcpConversation: async () => calls.push("ai") },
      "@/lib/slack-task-changes": { runDueTaskChanges: async () => {} },
    });
    await route.POST(new Request("https://okri.test/api/slack/events", { method: "POST", body: JSON.stringify({
      event_id: "E1", team_id: "T1", event: { type, text, user: "U1", channel: "C1", channel_type: "im", ts: "1" },
    }) }));
    await Promise.all(pending);
    assert.deepEqual(calls, [expected], text);
  }
});

test("Slack manual questions read the manual without history/Canvas, writes or resetting pending approvals", async (t) => {
  const calls = [];
  const noWorkspaceAccess = () => { throw new Error("Manual questions must not read/write workspace context or sessions"); };
  const agent = compile(await read("lib/slack-mcp-agent.ts"), {
    "cloudflare:workers": { env: { DB: { prepare: noWorkspaceAccess }, OPENAI_API_KEY: "mock-only" } },
    "@modelcontextprotocol/sdk/inMemory.js": { InMemoryTransport },
    "@/app/mcp/route": { createOkriServer: async (auth) => {
      assert.equal(auth.role, "viewer");
      const server = new McpServer({ name: "manual-fixture", version: "1" });
      server.registerTool("read_manual", { inputSchema: { query: z.string(), surface: z.literal("slack") } }, async (input) => {
        calls.push("read_manual");
        return { content: [{ type: "text", text: JSON.stringify(manual.readOkriManual(input)) }] };
      });
      server.registerTool("create_item", { inputSchema: {} }, async () => { throw new Error("Unexpected write"); });
      return server;
    } },
    "@/lib/okri-manual": manual,
    "@/lib/billing": { BillingLimitError: class extends Error {}, assertAiBudget: async () => ({ limitWon: null }) },
    "@/lib/pace-data": {
      getAiUsageSummary: async () => ({}), reserveAiUsageEvent: async () => "reservation-test",
      finalizeAiUsageEvent: async () => calls.push("usage"), releaseAiUsageReservation: async () => {},
    },
    "@/lib/slack-daily": {
      slackTokenForConnection: async () => "test-only",
      slackCanvasTokenForConnection: async () => null,
      resolveSlackMemberForEvent: async () => ({ authorization: { ownerId: "workspace", userId: "viewer", role: "viewer" }, memberId: "member" }),
      slackApi: async (_token, method, payload) => { calls.push(method); return { ts: payload.ts || "reply", ok: true }; },
    },
    "@/lib/slack-mrkdwn": compile(await read("lib/slack-mrkdwn.ts")),
    "@/lib/slack-mcp-context": compile(await read("lib/slack-mcp-context.ts")),
    "@/lib/slack-work-intake": { readSlackThread: noWorkspaceAccess },
    "@/lib/project-images": {},
    "@/lib/slack-mcp-continuity": compile(await read("lib/slack-mcp-continuity.ts")),
  });
  let round = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools.map(({ name }) => name), ["read_manual"]);
    if (round++ === 0) {
      const context = JSON.parse(body.input[1].content[0].text);
      assert.equal(context.manualQuestion, true);
      assert.ok(context.productManual);
      assert.equal(context.hiddenMcpState, "없음");
      assert.equal(context.explicitCreationRequest, false);
      // Even a model proposing a write cannot run it in the manual-only path.
      return Response.json({ id: "r1", output: [{ type: "function_call", call_id: "c1", name: "create_item", arguments: "{}" }] });
    }
    assert.match(body.input[0].output, /not available/);
    return Response.json({ output_text: "!프로젝트로 생성 양식을 열고 내용을 확인하세요." });
  });
  await agent.handleSlackMcpConversation(new Request("https://okri.test"), { teamId: "team", botUserId: "bot", scope: "" }, {
    channel: "private-channel", channelType: "group", user: "viewer", ts: "now", threadTs: "pending-project-thread", text: "프로젝트 생성 방법 알려줘",
  }, "프로젝트 생성 방법 알려줘");
  assert.deepEqual(calls, ["chat.postMessage", "read_manual", "usage", "chat.update"]);
});

test("web usage answers preserve exact drafts even when the model proposes changes", async (t) => {
  const intake = compile(await read("lib/work-intake.ts"));
  const route = compile(await read("app/api/okr-organize/route.ts"), {
    "cloudflare:workers": { env: { DB: {}, OPENAI_API_KEY: "test-only" } },
    "@/lib/okri-manual": manual,
    "@/lib/language-preferences": { readLanguagePreferences: async () => ({ resolvedLanguage: "ko" }) },
    "@/lib/pace-data": {
      authorizeRequest: async () => ({ ownerId: "workspace", userId: "viewer", role: "viewer" }),
      ensureWorkspace: async () => {}, getWorkspaceRules: async () => ({}), getAiUsageSummary: async () => ({}),
      reserveAiUsageEvent: async () => "reservation", finalizeAiUsageEvent: async () => {}, releaseAiUsageReservation: async () => {},
    },
    "@/lib/billing": { BillingLimitError: class extends Error {}, assertAiBudget: async () => ({ limitWon: null, spentWonMicros: 0 }) },
    "@/lib/work-intake": { ...intake, readWorkContext: async () => ({}) },
  });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const context = JSON.parse(JSON.parse(init.body).input[1].content);
    assert.equal(context.manualQuestion, true);
    assert.ok(context.productManual.articles.some(({ id }) => id === "tasks"));
    return Response.json({ output_text: JSON.stringify({ assistantMessage: "Task는 실행 단위입니다.", questions: [], plan: { tasks: "UNREQUESTED_TASK", objectiveTitle: "UNREQUESTED_OBJECTIVE" } }) });
  });
  for (const draft of [{}, { objectiveTitle: "내 목표", keyResults: [{ clientId: "kr-existing", title: "기존 결과", initiatives: [{ clientId: "i-existing", title: "기존 방향" }] }], tasks: "작성 중인 업무" }]) {
    const response = await route.POST(new Request("https://okri.test/api/okr-organize", {
      method: "POST", body: JSON.stringify({ message: "Task 만드는 방법 알려줘", mode: "coach", plan: draft }),
    }));
    assert.equal(response.status, 200, await response.clone().text());
    const { organized } = await response.json();
    assert.equal(organized.plan.objectiveTitle, draft.objectiveTitle || "");
    assert.equal(organized.plan.tasks, draft.tasks || "");
    assert.deepEqual(organized.plan.keyResults, draft.keyResults || []);
    assert.doesNotMatch(JSON.stringify(organized), /UNREQUESTED/);
  }
});
