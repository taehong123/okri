import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const continuitySource = await readFile(new URL("../lib/slack-mcp-continuity.ts", import.meta.url), "utf8");
const continuityCompiled = ts.transpileModule(continuitySource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;
const continuity = await import(`data:text/javascript;base64,${Buffer.from(continuityCompiled).toString("base64")}`);

function pendingProjectTurn(overrides = {}) {
  const initiative = {
    id: "initiative-1",
    cycleId: "cycle-1",
    fingerprint: "a".repeat(64),
    path: ["Objective", "KR", "Initiative"],
  };
  return {
    name: "manage_project",
    arguments: {
      action: "propose",
      recommended_initiatives: [{ initiative_id: initiative.id, reason: "직접 기여" }],
    },
    result: {
      structuredContent: {
        action: "propose",
        review: {
          id: "00000000-0000-4000-8000-000000000001",
          version: "00000000-0000-4000-8000-000000000002",
          state: "awaiting_user_confirmation",
          title: "오더플로우 알럿 연동",
          proposal: { title: "오더플로우 알럿 연동", requestedCycleId: null },
          editor: { revision: "b".repeat(64) },
          recommendations: [{ initiativeId: initiative.id, reason: "직접 기여", initiative }],
        },
      },
    },
    at: "2026-09-10T03:07:00.000Z",
    actorUserId: "member-a",
    ...overrides,
  };
}

test("every Slack @OKRI mention enters the public MCP conversation path", async () => {
  const source = await readFile(new URL("../app/api/slack/events/route.ts", import.meta.url), "utf8");
  assert.match(source, /commandEvent\?\.type === "app_mention"/);
  assert.match(source, /handleSlackMcpConversation/);
  assert.match(source, /mcpConversation \? null : parsedCommand/);
  assert.ok(source.indexOf("if (mcpConversation && commandEvent)") < source.indexOf("else if (dailyMessage"));
});

test("Slack MCP agent reuses the authorized MCP server and publishes one updated thread reply", async () => {
  const [agent, mcp] = await Promise.all([
    readFile(new URL("../lib/slack-mcp-agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/mcp/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(mcp, /export async function createOkriServer/);
  assert.match(agent, /InMemoryTransport\.createLinkedPair/);
  assert.match(agent, /new RawMcpClient/);
  assert.match(agent, /"tools\/list"/);
  assert.match(agent, /"tools\/call"/);
  assert.match(agent, /"notifications\/initialized"/);
  assert.doesNotMatch(agent, /sdk\/client\/index/);
  assert.match(agent, /chat\.postMessage/);
  assert.match(agent, /chat\.update/);
  assert.match(agent, /thread_ts: event\.threadTs \|\| event\.ts/);
  assert.match(agent, /dailyMemberBySlack/);
  assert.match(agent, /source: "slack_mcp"/);
  assert.match(agent, /workspaceRequestsThisMinute/);
  assert.match(agent, /workspaceRequestsToday/);
  assert.match(agent, /name: "prepare_work"/);
  assert.match(agent, /boundedCreationSource/);
  assert.match(agent, /source_text: sourceText/);
  assert.match(agent, /sourceMatched=true/);
  assert.match(agent, /\["list_items", "capture_item", "create_item", "create_tasks"\]/);
  assert.match(agent, /"trash_task"/);
  assert.match(agent, /never claim that Task deletion is unavailable/);
  assert.match(agent, /const creationIntent = !hasTaskRemovalIntent\(input\.query\) && hasExplicitCreationIntent/);
  assert.match(agent, /tool_choice: mustProgressCreation \? "required" : "auto"/);
  assert.match(agent, /never ask the user to repeat a title or work description/);
  assert.match(agent, /Slack MCP thread read failed/);
  assert.match(agent, /requiredThreadScope/);
  assert.match(agent, /if \(thread\.readFailed\)/);
  assert.ok(agent.indexOf("if (thread.readFailed)") < agent.indexOf("const server = await createOkriServer"));
  assert.ok(agent.indexOf("if (!hasCreationSourceContent && needsMissingThreadSource)") < agent.indexOf("const preparation = await client.request"));
  assert.match(agent, /slackThreadSourceMessages\(thread\.messages, input\.event\.ts, input\.botUserId\)/);
});

test("Slack MCP OAuth covers public, private, direct, and group-direct thread history", async () => {
  const [oauth, manifest] = await Promise.all([
    readFile(new URL("../lib/slack-oauth.ts", import.meta.url), "utf8"),
    readFile(new URL("../slack-app-manifest.yml", import.meta.url), "utf8"),
  ]);
  for (const scope of ["channels:history", "groups:history", "im:history", "mpim:history"]) {
    assert.match(oauth, new RegExp(scope));
    assert.match(manifest, new RegExp(scope));
  }
  assert.match(manifest, /message\.mpim/);
});

test("Slack MCP conversation preserves Project approval state without exposing it", async () => {
  const agent = await readFile(new URL("../lib/slack-mcp-agent.ts", import.meta.url), "utf8");
  assert.match(agent, /command = 'mcp_chat'/);
  assert.match(agent, /slack_work_command_operations/);
  assert.match(agent, /Never confirm a Project in the same turn/);
  assert.match(agent, /Never expose internal IDs/);
  assert.match(agent, /\[내부 식별자\]/);
  assert.match(agent, /saveSlackProjectImages/);
  assert.match(agent, /read_project_image/);
  assert.match(agent, /pendingProjectApproval/);
  assert.match(agent, /projectReviewUserId/);
  assert.match(agent, /legacySessionId/);
  assert.ok(agent.indexOf("if (directApproval && listed.tools.some") < agent.indexOf("const apiKey = runtime.OPENAI_API_KEY"));
});

test("short Slack approvals confirm the latest Project proposal without accepting edits", () => {
  for (const phrase of ["ㄱㄱ", "진행해", "확정", "프로젝트 생성해줘", "<@U123> 이대로 생성해주세요"]) {
    assert.equal(continuity.isExplicitProjectApproval(phrase), true, phrase);
  }
  for (const phrase of ["생성해줘 근데 책임자는 태홍", "기한 바꾸고 진행해", "프로젝트 다시 추천해줘"]) {
    assert.equal(continuity.isExplicitProjectApproval(phrase), false, phrase);
  }
});

test("Project approval reuses the exact pending review and recommended Initiative", () => {
  const approval = continuity.pendingProjectApproval([pendingProjectTurn()]);
  assert.ok(approval);
  assert.equal(approval.reviewUserId, "member-a");
  assert.equal(approval.arguments.action, "confirm");
  assert.deepEqual(approval.arguments.confirmation, {
    review_id: "00000000-0000-4000-8000-000000000001",
    version: "00000000-0000-4000-8000-000000000002",
    confirmed: true,
    initiative_id: "initiative-1",
    initiative_fingerprint: "a".repeat(64),
    editor_revision: "b".repeat(64),
    proposal: { title: "오더플로우 알럿 연동", requestedCycleId: "cycle-1" },
  });
  assert.deepEqual(approval.initiativePath, ["Objective", "KR", "Initiative"]);
});

test("completed or cancelled Project turns do not leave a confirmable proposal", () => {
  const proposal = pendingProjectTurn();
  for (const action of ["confirm", "cancel"]) {
    assert.equal(continuity.pendingProjectApproval([
      proposal,
      { ...proposal, arguments: { action }, at: "2026-09-10T03:08:00.000Z" },
    ]), null);
  }
});
