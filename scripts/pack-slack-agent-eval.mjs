// Build an opt-in real-model replay of the production Slack agent, with only
// fictional in-memory MCP/session/Slack adapters. No production domain module,
// database connection, Slack token or Slack API client is included in the bundle.
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const transpile = (text) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const fixtureSource = await read("tests/slack-thread-plan.test.mjs");
const ast = ts.createSourceFile("fixture.mjs", fixtureSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = (name) => ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(ast);
const routeText = await read("app/mcp/route.ts");
const routeAst = ts.createSourceFile("route.ts", routeText, ts.ScriptTarget.Latest, true);
const initializer = (source, name) => source.statements.filter(ts.isVariableStatement)
  .flatMap((node) => [...node.declarationList.declarations]).find((node) => node.name.getText(source) === name)?.initializer?.getText(source);
const pure = [];
for (const [path, names] of [["lib/pace-data.ts", ["ITEM_KINDS", "ITEM_STATUSES", "ITEM_PRIORITIES", "ITEM_CADENCES", "ROUTINE_CADENCES"]],
  ["lib/work-intake.ts", ["WORK_KINDS"]], ["lib/project-review-mcp.ts", ["mcpProjectConfirmationSchema"]],
  ["app/mcp/route.ts", ["propertyValueSchema", "memberIdInput", "dueDateInput", "projectProposalFields", "projectConversationInputSchema"]]]) {
  const parsed = ts.createSourceFile(path, await read(path), ts.ScriptTarget.Latest, true);
  for (const name of names) {
    const value = initializer(parsed, name);
    if (!value) throw new Error(`Missing production schema constant: ${name}`);
    pure.push(`const ${name} = ${value};`);
  }
}
const productionTools = {};
const visit = (node) => {
  if (ts.isCallExpression(node) && node.expression.getText(routeAst) === "server.registerTool" && ts.isStringLiteral(node.arguments[0])) {
    const name = node.arguments[0].text;
    if (["prepare_work", "list_items", "list_routines", "create_item", "manage_project", "create_tasks", "link_item"].includes(name)) {
      const properties = node.arguments[1].properties;
      productionTools[name] = Object.fromEntries(["inputSchema", "description"].map((key) => [key,
        properties.find((property) => property.name?.getText(routeAst) === key).initializer.getText(routeAst)]));
    }
  }
  ts.forEachChild(node, visit);
};
visit(routeAst);
const modules = {};
for (const name of ["slack-mcp-agent", "slack-mcp-plan", "slack-mcp-continuity", "slack-creation-defaults", "slack-mcp-context", "slack-mrkdwn"]) modules[name] = transpile(await read(`lib/${name}.ts`));
const outfile = process.argv[2];
if (!outfile) throw new Error("Provide an ignored build output path, e.g. dist/qa/slack-agent-eval.cjs");
const qaRoot = resolve(fileURLToPath(root), "dist/qa");
const outputPath = resolve(fileURLToPath(root), outfile);
const qaRelative = relative(qaRoot, outputPath);
if (!qaRelative || isAbsolute(qaRelative) || qaRelative === ".." || qaRelative.startsWith(`..${sep}`) || resolve(qaRoot, qaRelative) !== outputPath || !outputPath.endsWith(".cjs")) {
  throw new Error("Replay bundles must stay inside this checkout's ignored dist/qa directory and use .cjs.");
}
const source = `
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
${transpile(pure.join("\n"))}
const productionTools = { ${Object.entries(productionTools).map(([name, config]) => `${JSON.stringify(name)}: { inputSchema: ${config.inputSchema}, description: ${config.description} }`).join(",\n")} };
const registerProductionSchema = McpServer.prototype.registerTool;
McpServer.prototype.registerTool = function(name, config, handler) {
  return registerProductionSchema.call(this, name, { ...config, ...productionTools[name] }, handler);
};
const modules = ${JSON.stringify(modules)};
function compile(source, dependencies = {}) {
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)((id) => {
    if (!(id in dependencies)) throw new Error("Unmocked replay dependency: " + id);
    return dependencies[id];
  }, loaded, loaded.exports);
  return loaded.exports;
}
const agentSource = modules["slack-mcp-agent"];
const plan = compile(modules["slack-mcp-plan"]);
const continuity = compile(modules["slack-mcp-continuity"]);
const defaults = compile(modules["slack-creation-defaults"]);
const context = compile(modules["slack-mcp-context"]);
const mrkdwn = compile(modules["slack-mrkdwn"]);
${declaration("proposal")}
const fixtureProposal = proposal;
proposal = function(title, id, initiativeId) {
  const review = fixtureProposal(title, crypto.randomUUID(), initiativeId);
  review.version = crypto.randomUUID();
  return review;
};
${declaration("fixture")}
async function main() {
  if (process.env.OKRI_SLACK_EVAL_ALLOW_LIVE !== "1" || !process.env.OPENAI_API_KEY) throw new Error("Explicit live-eval opt-in and configured API key required.");
  const model = process.env.OKRI_OPENAI_MODEL || process.env.OKRPTR_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-luna";
  const upstreamFetch = globalThis.fetch;
  const metrics = { model, requests: 0, inputTokens: 0, outputTokens: 0, incomplete: 0, calls: [] };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses", "Only the model API may be reached; all business and Slack operations are in memory.");
    if (++metrics.requests > 18) throw new Error("Live replay API-call safety cap reached");
    const body = JSON.parse(init.body); body.model = model;
    const result = await upstreamFetch(url, { ...init, headers: { ...init.headers, Authorization: "Bearer " + process.env.OPENAI_API_KEY }, body: JSON.stringify(body) });
    const data = await result.clone().json();
    metrics.inputTokens += data.usage?.input_tokens || 0; metrics.outputTokens += data.usage?.output_tokens || 0;
    if (data.status === "incomplete") metrics.incomplete++;
    const calls = (data.output || []).filter((item) => item.type === "function_call");
    metrics.calls.push(...calls.map((item) => ({ name: item.name, arguments: JSON.parse(item.arguments || "{}") })));
    console.log(JSON.stringify({ stage: "model", request: metrics.requests, status: data.status || result.status, calls: calls.map((item) => item.name), incomplete: data.incomplete_details }));
    return result;
  };
  const f = await fixture({ mock: { method() {} } });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const existingParent = { id: "project-green", kind: "project", title: "그린서비스 유료전환", parentId: "growth", path: ["목표", "성장 매출", "상품 성장", "그린서비스 유료전환"] };
  const existingTasks = ["그린서비스 시트 연동", "렌즈 제안서 보내기", "재무 자동화 제안서 보내기"].map((title, i) => ({ id: "existing-task-" + i, kind: "task", title, parentId: existingParent.id, dueDate: day, status: i === 1 ? "done" : "todo", assigneeMemberId: "member" }));
  f.readItems.push(existingParent, ...structuredClone(existingTasks));
  f.initiatives.push({ id: "growth", kind: "initiative", title: "시장 반응이 좋은 상품의 성장에 집중", path: ["팀 목표", "성장 매출", "시장 반응이 좋은 상품의 성장에 집중"] }, { id: "external-ax", kind: "initiative", title: "고객사 AX 세일즈", path: ["팀 목표", "외주 매출", "고객사 AX 세일즈"] });
  f.session = { version: 1, turns: [
    { name: "manage_project", arguments: { action: "confirm" }, at: new Date(Date.now()-20000).toISOString(), result: { structuredContent: { review: { title: existingParent.title, state: "created", projectId: existingParent.id } } } },
    { name: "create_tasks", arguments: { titles: existingTasks.map((item) => item.title), parent_id: existingParent.id }, at: new Date(Date.now()-10000).toISOString(), result: { structuredContent: { items: existingTasks } } },
  ], answer: "세 업무를 모두 그린서비스 아래에 만들었습니다.", updatedAt: new Date().toISOString() };
  f.messages.push({ user: "user", ts: String(Date.now()/1000-30), text: "그린서비스 유료전환 프로젝트 아래 그린서비스 시트 연동을 오늘까지 할 일로 넣어줘. 렌즈 AX 프로젝트는 별도로 생성하고 렌즈 제안서 보내기 업무를 오늘 기한으로 넣어줘. 샘플푸드 재무 자동화 프로젝트도 별도로 생성하고 재무 자동화 제안서 보내기 업무를 오늘 기한으로 넣어줘. 그린서비스는 상품 성장 Initiative, 나머지 둘은 고객사 AX 세일즈에 연결해. 서로 다른 고객 업무를 하나에 몰아넣지 말고, 기존 Task가 있으면 새로 만들지 말고 올바른 프로젝트로 옮겨줘." });
  const first = await f.run("왜 자꾸 처리를 안하고 보고만 하는거야. 다 반영하라고 뭐하는거야", []);
  console.log(JSON.stringify({ stage: "proposal", answer: first, plan: f.session?.workPlan, pendingReviews: f.session?.presentedReviewIds?.length }));
  assert.equal(f.writes.filter((item) => item.kind === "task").length, 0, "No duplicate Tasks");
  assert.equal(f.session?.presentedReviewIds?.length, 2, "Both missing Project reviews must be prepared together");
  const second = await f.run("진행해", []);
  console.log(JSON.stringify({ stage: "approval", answer: second, writes: f.writes, plan: f.session?.workPlan }));
  assert.equal(f.writes.filter((item) => item.kind === "task").length, 0);
  assert.equal(f.writes.filter((item) => item.operation === "link").length, 2);
  assert.ok(f.session.workPlan.every((item) => plan.workPlanStatus(item, f.session.workPlan) === "saved"));
  assert.equal(f.readItems.find((item) => item.id === "existing-task-1").status, "done");
  const writesBeforeRepeat = f.writes.length;
  await f.run("남은 것도 다 반영해", []);
  assert.equal(f.writes.length, writesBeforeRepeat, "Repeated continuation must not create or move duplicate work");
  console.log(JSON.stringify({ stage: "passed", metrics, productionInputSchemas: true, businessData: "fictional-memory-only", productionBusinessWrites: 0, slackMessages: 0 }));
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
`;
await build({ stdin: { contents: source, resolveDir: fileURLToPath(root), sourcefile: "slack-agent-eval.mjs" },
  bundle: true, platform: "node", format: "cjs", target: "node22", outfile: outputPath, logLevel: "warning" });
console.log(JSON.stringify({ outfile, liveApiCallsDuringBuild: 0, productionBusinessModules: false }));
