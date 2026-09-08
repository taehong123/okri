import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/slack-work-command-parser.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { parseSlackWorkCommand } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("Slack work commands accept Task spelling and whitespace variants", () => {
  const cases = [
    ["!task Customer interview", "task_create", "Customer interview"],
    ["!project create Onboarding", "project_create", "Onboarding"],
    ["!project view Mobile", "project_view", "Mobile"],
    ["!work create Launch page", "work_create", "Launch page"],
    ["!업무생성 온보딩 개선", "work_create", "온보딩 개선"],
    ["업무 생성 고객 인터뷰", "work_create", "고객 인터뷰"],
    ["!my work", "my_work", ""],
    ["!okri", "help", ""],
    ["!메뉴얼", "help", ""],
    ["!매뉴얼", "help", ""],
    ["!manual", "help", ""],
    ["!테스크생성 명함", "task_create", "명함"],
    [" ! 태스크   완료   명함 ", "task_complete", "명함"],
    ["!테스크 재 열기 명함", "task_reopen", "명함"],
    ["! 프로젝트 생성 신규 앱", "project_create", "신규 앱"],
    ["!내 업무", "my_work", ""],
  ];
  for (const [input, command, query] of cases) assert.deepEqual(parseSlackWorkCommand(input), { command, query });
});

test("Slack work command parser ignores ordinary conversation and bot-like text", () => {
  for (const input of ["테스크 생성", "회의에서 !테스크생성을 설명해 줘", "!없는명령", "", "좋은 아침입니다"]) {
    assert.equal(parseSlackWorkCommand(input), null);
  }
});

test("Slack work command query is bounded for interaction metadata", () => {
  assert.equal(parseSlackWorkCommand(`!프로젝트조회 ${"가".repeat(300)}`).query.length, 240);
});

test("Slack channel events, private responses, permissions, and request idempotency stay wired", async () => {
  const [events, commands, interactions, domain, intake, pace, oauth, manifest, schema] = await Promise.all([
    readFile(new URL("../app/api/slack/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/commands/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/interactions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/slack-work-command.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/slack-work-intake.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/slack-oauth.ts", import.meta.url), "utf8"),
    readFile(new URL("../slack-app-manifest.yml", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(events, /event\.user !== connection\.botUserId/);
  assert.match(events, /const commandMessage = Boolean/);
  assert.match(events, /command: "work_create" as const/);
  assert.match(events, /ts: commandEvent\.ts/);
  assert.ok(events.indexOf("const commandMessage") < events.indexOf("INSERT OR IGNORE INTO slack_event_receipts"));
  assert.match(domain, /chat\.postEphemeral/);
  assert.match(domain, /prepareSlackWorkDraft/);
  assert.match(domain, /검토 후 생성/);
  assert.match(domain, /selectedValue\(state, "work_target", targetAction\(command\)\)/);
  assert.ok(domain.indexOf('parsed.command === "help"') < domain.indexOf("if (!linked)"));
  for (const command of ["/okri daily", "!내 업무", "!프로젝트 생성 [이름]", "!태스크 완료 [검색어]", "!메뉴얼"]) assert.ok(domain.includes(command));
  assert.match(domain, /authorization\.role === "viewer"/);
  assert.match(domain, /metadata\.teamId !== teamId/);
  assert.match(domain, /metadata\.slackUserId !== slackUserId/);
  assert.match(domain, /Date\.now\(\) - metadata\.createdAt > 15 \* 60_000/);
  assert.match(domain, /INSERT OR IGNORE INTO slack_work_command_operations/);
  assert.match(commands, /command: "work_create"/);
  assert.doesNotMatch(commands, /createItem\(/);
  assert.match(intake, /conversations\.replies/);
  assert.match(intake, /source: "slack_work"/);
  assert.match(intake, /workspaceRequestsThisMinute/);
  assert.match(intake, /workspaceRequestsToday/);
  assert.match(pace, /export async function reserveAiUsageEvent/);
  assert.match(pace, /INSERT INTO ai_usage_events[\s\S]+WHERE \(SELECT count\(\*\)/);
  assert.match(pace, /source LIKE 'pending:%'/);
  assert.match(interactions, /dailyMemberBySlack/);
  for (const scope of ["channels:history", "groups:history"]) {
    assert.match(oauth, new RegExp(scope));
    assert.match(manifest, new RegExp(scope));
  }
  for (const event of ["message.channels", "message.groups"]) assert.match(manifest, new RegExp(event.replace(".", "\\.")));
  assert.match(schema, /slack_work_command_operations/);
});
