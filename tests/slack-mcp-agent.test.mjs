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
  assert.match(agent, /tool_choice: mustProgressCreation \? "required" : "auto"/);
  assert.match(agent, /never ask the user to repeat a title or work description/);
  assert.match(agent, /Slack MCP thread read failed/);
  assert.match(agent, /requiredThreadScope/);
  assert.match(agent, /if \(!threadHasSourceContent && needsMissingThreadSource\)/);
  assert.ok(agent.indexOf("if (!threadHasSourceContent && needsMissingThreadSource)") < agent.indexOf("const preparation = await client.request"));
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
});
