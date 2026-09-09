import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { serverLanguage } from "./helpers/language-fixture.mjs";

const source = ts.createSourceFile("slack-daily.ts", await readFile(new URL("../lib/slack-daily.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const formSource = ts.createSourceFile("slack-daily-form.ts", await readFile(new URL("../lib/slack-daily-form.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const helper = formSource.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === "dailyWorkContainerLabel").map((node) => node.getFullText(formSource).replace(/\bexport\s+function/, "function")).join("\n");
const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && ["dailyCard", "escapeSlack"].includes(node.name?.text)).map((node) => node.getFullText(source)).join("\n");
const code = ts.transpileModule(`${helper}\n${functions}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const dailyCard = new Function("env", "dailySkipReasonLabel", "dailyWorkStatusLabel", code + "\nreturn dailyCard;")({}, () => "휴가", (status) => ({ office: "출근", remote: "재택", skip: "스킵" })[status]);
const work = (id, completedToday = false, kind = "task") => ({ id, key: `${kind}:${id}`, title: id, kind, parentId: "project", parentKind: "project", parentTitle: "Parent", status: completedToday ? "done" : "todo", completedToday });
const submission = (overrides = {}) => ({ memberName: "Member", date: "2026-09-05", tasks: [], work: [], yesterdayWork: [], yesterdayNote: "", todayNote: "", blockersNote: "", workStatus: "office", skipReason: null, ...overrides });
const sections = (card) => card.blocks.filter((block) => block.type === "section").map((block) => block.text.text);

test("Slack merges all completed work and keeps remaining plans separate without mutating snapshots", () => {
  const value = submission({ yesterdayWork: [work("Previous")], work: [work("Finished", true), work("Finished project", true, "project"), work("Planned")], tasks: [{ taskTitle: "Legacy plan", parentTitle: "Parent", parentKind: "project", parentId: "project" }] });
  const original = structuredClone(value);
  const [completed, planned] = sections(dailyCard(value));
  assert.match(completed, /^\*완료한 일\*/);
  assert.match(completed, /Previous/);
  assert.match(completed, /Finished project/);
  assert.doesNotMatch(completed, /Planned|Legacy plan/);
  assert.match(planned, /^\*오늘 할 일\*/);
  assert.match(planned, /Planned/);
  assert.match(planned, /Legacy plan/);
  assert.doesNotMatch(planned, /Finished|\[완료\]/);
  assert.deepEqual(value, original);
});

test("completion-only daily shows no remaining plan and legacy plan-only submissions remain readable", () => {
  const completed = sections(dailyCard(submission({ work: [work("Finished routine", true, "routine")], noPlannedTasks: false })));
  assert.equal(completed.length, 2);
  assert.match(completed[1], /오늘 예정 없음/);
  const planned = sections(dailyCard(submission({ work: [{ ...work("Legacy plan"), completedToday: undefined }] })));
  assert.equal(planned.length, 2);
  assert.doesNotMatch(planned.join("\n"), /어제 완료한 일|오늘 완료한 일/);
  assert.match(planned[1], /Legacy plan/);
});

test("shared Daily shows the selected work status and keeps the new skip card minimal", () => {
  const remote = dailyCard(submission({ workStatus: "remote", work: [work("today")] }));
  assert.match(JSON.stringify(remote.blocks), /오늘 근무/);
  assert.match(JSON.stringify(remote.blocks), /재택/);

  const skipped = dailyCard(submission({ workStatus: "skip" }));
  const body = JSON.stringify(skipped.blocks);
  assert.match(body, /오늘 근무/);
  assert.match(body, /스킵/);
  assert.doesNotMatch(body, /완료한 일|오늘 할 일|도움이 필요한 일/);
});

test("completed and planned lists have independent caps and escape user text", () => {
  const value = submission({ work: [...Array.from({ length: 21 }, (_, i) => work(`Done ${i} <&>`, true)), ...Array.from({ length: 22 }, (_, i) => work(`Plan ${i}`))] });
  const [completed, planned] = sections(dailyCard(value));
  assert.match(completed, /외 1개/);
  assert.match(planned, /외 2개/);
  assert.match(completed, /&lt;&amp;&gt;/);
  assert.doesNotMatch(completed, /Plan 0/);
  assert.doesNotMatch(planned, /Done 0/);
  for (const text of sections(dailyCard(submission({ yesterdayWork: [work("X".repeat(4000))], work: [work("Finished", true), work("Planned")] })))) assert.ok(text.length <= 2900);
  assert.match(sections(dailyCard(submission({ yesterdayWork: [work("X".repeat(4000))], work: [work("Finished", true), work("Planned")] })))[1], /Planned/);
});

test("daily completion headings use all supported languages and skipped reports stay unchanged", async () => {
  for (const language of ["ko", "en", "ja", "zh", "es"]) {
    const t = await serverLanguage.serverTranslator(language);
    const [completed, planned] = sections(dailyCard(submission({ work: [work("Done", true)] }), t));
    assert.ok(completed.startsWith(`*${t("완료한 일")}*`));
    assert.ok(planned.startsWith(`*${t("오늘 할 일")}*`));
    if (language !== "ko") assert.doesNotMatch(completed + planned, /[가-힣]/);
  }
  const skipped = sections(dailyCard(submission({ skipReason: "vacation", work: [work("Done", true)] })));
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /오늘 데일리 스킵/);
  assert.doesNotMatch(skipped[0], /완료한 일/);
});

test("published Daily renders direct completion buttons and strikes through completed Tasks in place", async () => {
  const tasks = Array.from({ length: 21 }, (_, index) => ({
    taskId: `task-${index}`, taskTitle: index === 0 ? "Done <&>" : `Plan ${index}`,
    parentTitle: "Launch", parentKind: "project", parentId: "project", status: "todo", isNew: false, sortOrder: index,
  }));
  const card = dailyCard(submission({ tasks }), undefined, {
    publicationId: "publication", completedTaskIds: new Set(["task-0"]),
  });
  const buttons = card.blocks.flatMap((block) => block.accessory?.action_id === "daily_publication_complete" ? [block.accessory] : []);
  assert.equal(buttons.length, 19);
  assert.ok(card.blocks.length < 50);
  assert.match(JSON.stringify(card.blocks), /Project · Launch/);
  assert.match(JSON.stringify(card.blocks), /~Done &lt;&amp;&gt;~/);
  assert.match(JSON.stringify(card.blocks), /외 1개/);
  assert.doesNotMatch(JSON.stringify(card.blocks.find((block) => block.text?.text?.includes("~Done"))), /daily_publication_complete/);
  assert.deepEqual(JSON.parse(buttons[0].value), { publicationId: "publication", taskId: "task-1" });
  for (const language of ["ko", "en", "ja", "zh", "es"]) {
    const t = await serverLanguage.serverTranslator(language);
    const translated = dailyCard(submission({ tasks: tasks.slice(0, 1) }), t, { publicationId: "publication" });
    assert.equal(translated.blocks.find((block) => block.accessory)?.accessory.text.text, t("완료"));
  }
});
