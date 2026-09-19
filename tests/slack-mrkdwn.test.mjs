import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/slack-mrkdwn.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;
const { formatSlackMrkdwn } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("Slack answers convert escaped and CommonMark emphasis to mrkdwn", () => {
  assert.equal(formatSlackMrkdwn("\\- \\*\\*제목:\\*\\* 주문 알림 연동"), "• *제목:* 주문 알림 연동");
  assert.equal(formatSlackMrkdwn("**완료 기준:** 알림이 전달됩니다."), "*완료 기준:* 알림이 전달됩니다.");
  assert.equal(formatSlackMrkdwn("\\*책임자:\\* 장재욱"), "*책임자:* 장재욱");
});

test("Slack answers normalize nested escaping and unescaped Markdown bullets", () => {
  assert.equal(formatSlackMrkdwn("-** Title **:"), "• * Title *:");
  assert.equal(formatSlackMrkdwn("\\\\*\\\\* Title \\\\*\\\\*"), "* Title *");
  assert.equal(formatSlackMrkdwn("-\\\\*\\\\* Title \\\\*\\\\*:"), "• * Title *:");
});
