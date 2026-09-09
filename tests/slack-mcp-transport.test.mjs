import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const sourceText = await readFile(new URL("../lib/slack-mcp-agent.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("slack-mcp-agent.ts", sourceText, ts.ScriptTarget.Latest, true);
const classNode = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "RawMcpClient");
const compiled = ts.transpileModule(classNode.getFullText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;
const RawMcpClient = new Function(`${compiled}; return RawMcpClient;`)();

test("raw Slack MCP transport completes handshake, tool discovery and execution", async () => {
  const server = new McpServer({ name: "fixture", version: "1.0.0" });
  server.registerTool("echo", { inputSchema: { value: z.string() } }, async ({ value }) => ({
    structuredContent: { value }, content: [{ type: "text", text: value }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new RawMcpClient(clientTransport);
  await server.connect(serverTransport);
  await client.connect();
  try {
    const listed = await client.request("tools/list", {});
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["echo"]);
    const result = await client.request("tools/call", { name: "echo", arguments: { value: "works" } });
    assert.equal(result.structuredContent.value, "works");
    assert.equal(result.content[0].text, "works");
  } finally {
    await client.close();
    await server.close();
  }
});
