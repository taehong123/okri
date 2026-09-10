import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { serverLanguage } from "./helpers/language-fixture.mjs";

const require = createRequire(import.meta.url);
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
function compile(source, dependencies = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => name in dependencies ? dependencies[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const usage = compile(await read("../lib/ai-usage.ts"));
const clientSource = await read("../lib/ai-usage-client.ts");
const clientLanguage = { getClientLocale: () => "ko-KR", messageValue: (value) => value,
  t: (key, values) => key.replace(/\{(\w+)\}/g, (match, name) => values && Object.hasOwn(values, name) ? String(values[name]) : match) };
const meter = compile(await read("../app/ai-usage-meter.tsx"), { "@/lib/ai-usage": usage, "@/lib/ai-usage-client": {}, "@/lib/client-language": clientLanguage, "./ai-usage-meter.css": {} });
const billingSource = await read("../lib/billing.ts");
const routeSource = await read("../app/api/billing/ai-usage/route.ts");

test("per-editor plan totals and AI budgets scale from one billable seat", () => {
  const ast = ts.createSourceFile("billing.ts", billingSource, ts.ScriptTarget.Latest, true);
  const constants = ast.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => ["GIB", "BILLING_PLANS"].includes(d.name.getText(ast)))).map((node) => node.getText(ast)).join("\n");
  const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && ["planMonthlyPriceWon", "planAiBudgetWon", "planStorageLimitBytes"].includes(node.name?.text)).map((node) => node.getText(ast)).join("\n");
  const pricing = compile(`${constants}\n${functions}`);
  assert.equal(pricing.planMonthlyPriceWon("team", 1), 2_900);
  assert.equal(pricing.planMonthlyPriceWon("team", 5), 14_500);
  assert.equal(pricing.planMonthlyPriceWon("business", 10), 49_000);
  assert.equal(pricing.planAiBudgetWon("free", 100), 500);
  assert.equal(pricing.planAiBudgetWon("team", 5), 3_000);
  assert.equal(pricing.planAiBudgetWon("business", 5), 7_500);
  assert.equal(pricing.planStorageLimitBytes("free", 100), 1024 ** 3);
  assert.equal(pricing.planStorageLimitBytes("team", 5), 25 * 1024 ** 3);
  assert.equal(pricing.planStorageLimitBytes("business", 5), 100 * 1024 ** 3);
});

test("usage is calculated from precise metering units without changing cost enforcement", () => {
  assert.deepEqual(usage.aiUsagePercent(120_000_000, 500_000_000), { usedPercent: 24, remainingPercent: 76 });
  assert.deepEqual(usage.aiUsagePercent(0, 500), { usedPercent: 0, remainingPercent: 100 });
  assert.ok(Math.abs(usage.aiUsagePercent(1_000, 500_000_000).usedPercent - 0.0002) < 1e-12);
  assert.deepEqual(usage.aiUsagePercent(600, 500), { usedPercent: 100, remainingPercent: 0 });
  for (const [used, limit] of [[null, 500], [NaN, 500], [-1, 500], [Infinity, 500], [0, 0], [0, null], [0, Infinity]]) assert.equal(usage.aiUsagePercent(used, limit), null);
  assert.match(billingSource, /aiUsagePercent\(aiUsage, aiBudgetWon \* 1_000_000\)/);
  assert.match(billingSource, /spentWonMicros >= limitWon \* 1_000_000/);
  assert.match(billingSource, /free: \{[\s\S]*?aiBudgetBaseWon: 500, aiBudgetPerEditorWon: 0 \}/);
  assert.match(billingSource, /projectLimit: 30/);
  assert.match(billingSource, /activityHistoryDays: 90/);
  assert.match(billingSource, /storageBaseBytes: GIB, storagePerEditorBytes: 0/);
  assert.match(billingSource, /storagePerEditorBytes: 5 \* GIB/);
  assert.match(billingSource, /storagePerEditorBytes: 20 \* GIB/);
});

test("percent formatting never says zero or full for positive, unfinished usage", () => {
  for (const [number, text] of [[0, "0%"], [24, "24%"], [0.0002, "0.1% 미만"], [99.999, "99.9% 초과"], [100, "100%"]]) assert.equal(usage.formatAiPercent(number), text);
  assert.deepEqual(usage.readAiUsagePercent({ usedPercent: 24, usedWon: 500, limitWon: 500 }), { usedPercent: 24, remainingPercent: 76 });
  assert.equal(usage.readAiUsagePercent({ usedPercent: null, usedWon: 0, limitWon: 500 }), null);
  assert.equal(usage.readAiUsagePercent({ usedWon: 120, limitWon: 500 }).usedPercent, 24);
});

test("AI usage thresholds and limit guidance use the active language and locale", async () => {
  const translate = await serverLanguage.serverTranslator("en");
  assert.equal(usage.formatAiPercent(0.05, "en-US", translate), "Less than 0.1%");
  assert.equal(usage.formatAiPercent(12.5, "de-DE", translate), "12,5%");
  assert.match(usage.aiUsageLimitMessage({ code: "ai_rate_limited" }, translate, "en-US"), /too quickly/i);
  const limited = usage.aiUsageLimitMessage({ code: "ai_budget_exceeded", spentWon: 495, limitWon: 500 }, translate, "en-US");
  assert.match(limited, /99%/);
  assert.match(limited, /1%/);
  assert.doesNotMatch(limited, /이번 달|작성 중인/);
});

test("meter renders percent-only labels with valid 0–100 accessibility and honest unknown state", () => {
  for (const usedPercent of [0, 24, 100, 120]) {
    const html = renderToStaticMarkup(React.createElement(meter.AiUsageMeter, { usage: { usedPercent } }));
    assert.match(html, /aria-valuemax="100"/);
    assert.match(html, new RegExp(`aria-valuenow="${Math.min(100, usedPercent)}"`));
    assert.match(html, /% 남음/);
    assert.doesNotMatch(html, /원|₩|NaN/);
  }
  const unknown = renderToStaticMarkup(React.createElement(meter.AiUsageMeter, { usage: null }));
  assert.match(unknown, /확인 불가/);
  assert.doesNotMatch(unknown, /aria-valuenow=|0%/);
  const loading = renderToStaticMarkup(React.createElement(meter.AiUsageMeter, { usage: null, loading: true }));
  assert.match(loading, /확인 중/);
  assert.doesNotMatch(loading, /불러오지 못|0%/);
});

test("rate, daily, monthly and insufficient-remaining errors have distinct nonmonetary messages", () => {
  assert.match(usage.aiUsageLimitMessage({ code: "ai_rate_limited" }), /잠시 후/);
  const daily = usage.aiUsageLimitMessage({ code: "ai_daily_limit_reached", usage: { spentWon: 1, budgetWon: 500 } });
  assert.match(daily, /오늘의 AI 요청 횟수/);
  assert.doesNotMatch(daily, /이번 달.*한도|원/);
  assert.match(usage.aiUsageLimitMessage({ code: "ai_budget_exceeded", spentWon: 500, limitWon: 500 }), /100% · 0% 남음/);
  const reserved = usage.aiUsageLimitMessage({ code: "ai_free_limit_reached", usage: { spentWon: 490, budgetWon: 500 } });
  assert.match(reserved, /남은 AI 사용량이 부족/);
  assert.match(reserved, /98% · 2% 남음/);
  assert.doesNotMatch(reserved, /무료|원|100%/);
});

test("chat cache coalesces requests, refreshes on invalidation and rejects cross-scope results", async (t) => {
  const client = compile(clientSource, { "./ai-usage": usage });
  let calls = 0;
  let usedPercent = 24;
  let responseWorkspace = "workspace-a";
  let status = 200;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/billing/ai-usage");
    assert.equal(init.cache, "no-store");
    calls++;
    return Response.json({ userId: "user-a", workspaceId: responseWorkspace, ai: { usedPercent, resetsAt: "2099-01-01T00:00:00Z" } }, { status });
  });
  const scope = { userId: "user-a", workspaceId: "workspace-a" };
  const first = client.loadAiUsage(scope);
  assert.equal(client.loadAiUsage(scope), first);
  await first;
  await client.loadAiUsage(scope);
  assert.equal(calls, 1);
  client.invalidateAiUsage();
  usedPercent = 28;
  assert.equal((await client.loadAiUsage(scope)).usedPercent, 28);
  assert.equal(calls, 2);
  responseWorkspace = "workspace-b";
  client.invalidateAiUsage();
  await assert.rejects(client.loadAiUsage(scope));
  responseWorkspace = "workspace-a";
  assert.equal((await client.loadAiUsage(scope)).usedPercent, 28);
  client.invalidateAiUsage();
  await assert.rejects(client.loadAiUsage({ ...scope, userId: "user-b" }));
  status = 503;
  await assert.rejects(client.loadAiUsage(scope));
});

test("cache expires across monthly reset and late old requests cannot overwrite refreshed data", async (t) => {
  const client = compile(clientSource, { "./ai-usage": usage });
  let now = 1_000;
  const pending = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => pending.push(resolve)));
  const scope = { userId: "user-a", workspaceId: "workspace-a" };
  const respond = (index, usedPercent) => pending[index](Response.json({ ...scope, ai: { usedPercent, resetsAt: new Date(2_000).toISOString() } }));
  const old = client.loadAiUsage(scope);
  client.invalidateAiUsage();
  const fresh = client.loadAiUsage(scope);
  respond(1, 35);
  await fresh;
  respond(0, 24);
  await old;
  assert.equal((await client.loadAiUsage(scope)).usedPercent, 35);
  now = 2_001;
  const nextMonth = client.loadAiUsage(scope);
  assert.equal(pending.length, 3);
  respond(2, 0);
  assert.equal((await nextMonth).usedPercent, 0);
});

test("lightweight summary preserves Free owner aggregation and paid workspace boundaries", async () => {
  const ast = ts.createSourceFile("billing.ts", billingSource, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && ["getAiUsageStatus", "getAiMonthlyUsage", "kstPeriod", "validPlan", "planAiBudgetWon"].includes(node.name?.text)).map((node) => node.getText(ast)).join("\n");
  const constants = ast.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => ["GIB", "BILLING_PLANS"].includes(d.name.getText(ast)))).map((node) => node.getText(ast)).join("\n");
  for (const [plan, limit] of [["free", 500], ["team", 600], ["business", 1_500]]) {
    let query, params;
    const { getAiUsageStatus } = compile(`const { env, getWorkspaceSubscription, aiUsagePercent } = require("deps");\nconst getBillableEditorCount = async () => 1;\n${constants}\n${functions}`, {
      deps: { aiUsagePercent: usage.aiUsagePercent, getWorkspaceSubscription: async () => ({ plan, billing_owner_user_id: "billing-owner" }), env: { DB: { prepare(sql) { query = sql; return { bind(...args) { params = args; return { first: async () => ({ spent: limit * 1_000_000 * .24 }) }; } }; } } } },
    });
    assert.equal((await getAiUsageStatus("workspace-a")).usedPercent, 24);
    assert.equal(params[0], plan === "free" ? "billing-owner" : "workspace-a");
    assert.match(query, plan === "free" ? /coalesce\(subscription.plan, 'free'\) = 'free'/ : /WHERE owner_id = \?/);
  }
});

test("usage route is read-only, authorized and never leaks billing details", async () => {
  let scope;
  const route = compile(routeSource, {
    "@/lib/pace-data": { authorizeRequest: async () => ({ ownerId: "workspace-a", userId: "user-a", role: "viewer" }) },
    "@/lib/billing": { getAiUsageStatus: async (id) => { scope = id; return { usedPercent: 24, remainingPercent: 76 }; } },
  });
  const response = await route.GET(new Request("https://test/api/billing/ai-usage?workspaceId=other"));
  assert.equal(scope, "workspace-a");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { workspaceId: "workspace-a", userId: "user-a", ai: { usedPercent: 24, remainingPercent: 76 } });
  const denied = compile(routeSource, { "@/lib/pace-data": { authorizeRequest: async () => new Response(null, { status: 401 }) }, "@/lib/billing": { getAiUsageStatus: () => assert.fail("unauthenticated query") } });
  assert.equal((await denied.GET(new Request("https://test"))).status, 401);
});

test("billing plan allowances no longer expose won, while subscription prices remain", async () => {
  const source = await read("../app/billing-view.tsx");
  assert.doesNotMatch(source, /ai: "[^"]*원|label="AI 안전한도"/);
  assert.match(source, /seatPrice: 2_900/);
  assert.match(source, /seatPrice: 4_900/);
  assert.match(source, /<AiUsageMeter usage=\{billing.usage.ai\}/);
  assert.match(source, /ChatGPT·Claude와 제한 없이 사용/);
  assert.match(source, /<StorageUsage storage=\{billing.usage.storage\}/);
});
