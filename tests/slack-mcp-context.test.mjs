import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/slack-mcp-context.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;
const context = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("Slack thread source detection rejects a mention-only conversation", () => {
  const query = "이 스레드 내용으로 업무 생성해줘";
  assert.equal(context.referencesSlackThreadSource(query), true);
  assert.equal(context.hasInlineSlackCreationDetails(query), false);
  assert.equal(context.hasSlackCreationSource([`<@U123> ${query}`], query, 0), false);
});

test("Slack thread source detection accepts actual replies, inline work, and images", () => {
  const query = "이 스레드 내용으로 Task 생성해줘";
  assert.equal(context.hasSlackCreationSource([
    "결제 오류 재현 조건을 문서화하고 수정한다.",
    `<@U123> ${query}`,
  ], query, 0), true);
  assert.equal(context.hasInlineSlackCreationDetails("결제 오류 화면 수정 Task 만들어줘"), true);
  assert.equal(context.hasSlackCreationSource([`<@U123> ${query}`], query, 1), true);
});

test("Slack source messages exclude the current mention and OKRI bot replies", () => {
  const messages = [
    { user: "U1", ts: "1.0", text: "결제 오류를 수정한다" },
    { user: "B1", ts: "1.1", text: "이전 OKRI 답변" },
    { user: "U1", ts: "1.2", text: "<@B1> 이 내용으로 Task 만들어줘" },
  ];
  assert.deepEqual(context.slackThreadSourceMessages(messages, "1.2", "B1"), [messages[0]]);
});

test("missing Slack thread messages state that nothing was saved", () => {
  assert.match(context.missingSlackThreadSourceMessage(true), /아무 업무도 저장하지 않았습니다/);
  assert.match(context.missingSlackThreadSourceMessage(false), /원본 스레드의 답글 입력창/);
});
