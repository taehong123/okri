import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(agent, /await client\.listTools\(\)/);
  assert.match(agent, /await client\.callTool/);
  assert.match(agent, /chat\.postMessage/);
  assert.match(agent, /chat\.update/);
  assert.match(agent, /thread_ts: event\.threadTs \|\| event\.ts/);
  assert.match(agent, /dailyMemberBySlack/);
  assert.match(agent, /source: "slack_mcp"/);
  assert.match(agent, /workspaceRequestsThisMinute/);
  assert.match(agent, /workspaceRequestsToday/);
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
});
