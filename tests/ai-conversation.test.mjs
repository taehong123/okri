import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { clientLanguage } from "./helpers/client-language-fixture.mjs";

const require = createRequire(import.meta.url);
function compile(source, dependencies = {}) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => name in dependencies ? dependencies[name] : name === "@/lib/client-language" ? clientLanguage : name === "@/lib/language-preferences" ? { readLanguagePreferences: async () => ({ language: "en", resolvedLanguage: "en", revision: 0 }) } : require(name), loaded, loaded.exports);
  return loaded.exports;
}

const intake = compile(await readFile(new URL("../lib/work-intake.ts", import.meta.url), "utf8"));
const assistantCommand = compile(await readFile(new URL("../lib/assistant-command.ts", import.meta.url), "utf8"));
const routeSource = await readFile(new URL("../app/api/okr-organize/route.ts", import.meta.url), "utf8");
const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const guideDraft = compile(await readFile(new URL("../app/guide-draft.tsx", import.meta.url), "utf8"), {
  "@/lib/guide-copy": compile(await readFile(new URL("../lib/guide-copy.ts", import.meta.url), "utf8")),
  "@/lib/guide-draft": compile(await readFile(new URL("../lib/guide-draft.ts", import.meta.url), "utf8")),
  "./guide-draft.css": {},
});
const ast = ts.createSourceFile("page.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["HomeOkrChat", "countOkrDraft", "planStringFieldsWithValues", "hasOkrDraft", "assistantOpeningMessage"]);
const components = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(ast)).join("\n");
const { HomeOkrChat } = compile(`
import { useState, useMemo, useRef, useEffect } from "react";
import { t, messageValue } from "@/lib/client-language";
import { parseAssistantCommand } from "@/lib/assistant-command";
import { GuideDraft } from "./guide-draft";
import { Bot, Link2, LoaderCircle, CheckCircle2, AlertTriangle, Eye, Send } from "lucide-react";
${components}
export { HomeOkrChat };
`, { "@/lib/assistant-command": assistantCommand, "./guide-draft": guideDraft });

for (const entry of ["coach", "onboarding", "create", "task", "project", "routine"]) {
  test(`${entry} starts with conversation, not examples or an inventory`, () => {
    const html = renderToStaticMarkup(React.createElement(HomeOkrChat, {
      context: { key: entry, entry, cycleId: "cycle", cycleName: "Cycle", target: null, targetCandidates: [{ id: "p", kind: "project", title: "PRIVATE_PROJECT_TITLE" }] },
      workspaceContext: { items: [], cycleId: "cycle", cycleName: "Cycle", focusedItemId: null, blockedTaskCount: 0 },
      members: [], taskContainers: [], projectTargets: [], canWrite: true, defaultCycleId: "cycle", defaultDriMemberId: null,
    }));
    assert.match(html, /id="assistant-message"/);
    assert.match(html, /기존 OKR과 업무를 참고해/);
    assert.match(html, /aria-label="참고 항목 선택"[^>]*aria-expanded="false"/);
    assert.doesNotMatch(html, /PRIVATE_PROJECT_TITLE|assistant-target-picker|assistant-example|chat-presets|assistant-followups|chat-okr-context/);
    assert.doesNotMatch(html, /팀 OKR|개인 OKR|간단한 예시|상위 Initiative 미선택|첫 OKR 온보딩|지금은 건너뛰기/);
  });
}

test("MCP and web share conversation and mandatory Project approval policy", () => {
  assert.ok(intake.WORKFLOW_INSTRUCTIONS.includes(intake.CONVERSATION_POLICY));
  const { systemInstruction } = compile(`${routeSource}\nexport { systemInstruction };`, {
    "cloudflare:workers": { env: {} }, "@/lib/pace-data": {}, "@/lib/billing": {}, "@/lib/work-intake": intake,
  });
  for (const mode of ["okr", "coach", "onboarding", "task", "project", "routine"]) {
    const prompt = systemInstruction(mode);
    assert.ok(prompt.includes(intake.CONVERSATION_POLICY));
    assert.match(prompt, /never saves business records/);
    assert.match(prompt, /Projects always require the user's final approval/);
    assert.doesNotMatch(prompt, /use prepare_work|Use propose_project|Continue from the earliest useful gap/);
  }
});

test("web reads reference context and rules for the authenticated workspace, without creating work", async (t) => {
  const calls = [];
  const env = { DB: {}, OPENAI_API_KEY: "test-only-key" };
  const { POST } = compile(routeSource, {
    "cloudflare:workers": { env },
    "@/lib/pace-data": {
      authorizeRequest: async () => ({ ownerId: "workspace-a", userId: "user-a" }),
      ensureWorkspace: async (id) => calls.push(["ensure", id]),
      getWorkspaceRules: async (id) => { calls.push(["rules", id]); return { reviewBeforeCreate: true }; },
      getAiUsageSummary: async () => ({ requestsThisMinute: 0, requestsToday: 0 }),
      recordAiUsageEvent: async (event) => calls.push(["usage", event.ownerId]),
    },
    "@/lib/billing": { BillingLimitError: class extends Error {}, assertAiBudget: async () => ({ limitWon: null, spentWonMicros: 0 }) },
    "@/lib/work-intake": { ...intake, readWorkContext: async (db, ownerId, userId) => {
      assert.equal(db, env.DB);
      calls.push(["context", ownerId, userId]);
      return { workspace: { id: ownerId }, parents: [], truncated: { project: true } };
    } },
  });
  let sent;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    sent = JSON.parse(init.body);
    return Response.json({ output_text: JSON.stringify({ assistantMessage: "안녕하세요.", questions: [], plan: {} }), usage: { input_tokens: 10, output_tokens: 10 } });
  });
  const response = await POST(new Request("https://okri.test/api/okr-organize", {
    method: "POST", body: JSON.stringify({ message: "안녕", mode: "coach", ownerId: "workspace-b", workspaceContext: {} }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.organized.plan.objectiveTitle, "");
  assert.equal(body.organized.plan.project, "");
  assert.equal(body.organized.plan.tasks, "");
  assert.deepEqual(calls, [["ensure", "workspace-a"], ["rules", "workspace-a"], ["context", "workspace-a", "user-a"], ["usage", "workspace-a"]]);
  const context = JSON.parse(sent.input[1].content);
  assert.match(sent.input[0].content, /explicit response-language request first/);
  assert.match(sent.input[0].content, /preserve the established conversation language/);
  assert.match(sent.input[0].content, /current language \(en\)/);
  assert.equal(context.referenceContext.workspace.id, "workspace-a");
  assert.equal(context.workspaceRules.reviewBeforeCreate, true);
  assert.equal(context.referenceContext.truncated.project, true);
});

test("unauthenticated conversation never reads workspace or calls the model", async () => {
  const { POST } = compile(routeSource, {
    "cloudflare:workers": { env: {} },
    "@/lib/pace-data": { authorizeRequest: async () => new Response(null, { status: 401 }) },
    "@/lib/billing": {}, "@/lib/work-intake": intake,
  });
  assert.equal((await POST(new Request("https://okri.test/api/okr-organize", { method: "POST" }))).status, 401);
});
