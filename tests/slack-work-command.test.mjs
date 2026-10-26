import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import { compileLanguageModule as compile, d1Fixture } from "./helpers/language-fixture.mjs";

const source = await readFile(new URL("../lib/slack-work-command-parser.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const parser = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const { parseSlackWorkCommand, slackWorkCommandFormContent } = parser;

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
    ["!프로젝트 신규 앱", "project_create", "신규 앱"],
    ["!루틴 주간 회고", "routine_create", "주간 회고"],
    ["!routine create Weekly review", "routine_create", "Weekly review"],
    ["!티켓 환불 문의", "ticket_create", "환불 문의"],
    ["!ticket create Refund request", "ticket_create", "Refund request"],
    ["!테스크 고객에게 답변", "task_create", "고객에게 답변"],
    ["!내 업무", "my_work", ""],
  ];
  for (const [input, command, query] of cases) assert.deepEqual(parseSlackWorkCommand(input), { command, query });
});

test("Slack work command parser ignores ordinary conversation and bot-like text", () => {
  for (const input of ["테스크 생성", "루틴 생성", "티켓 생성", "회의에서 !테스크생성을 설명해 줘", "!없는명령", "", "좋은 아침입니다"]) {
    assert.equal(parseSlackWorkCommand(input), null);
  }
});

test("Slack work command query is bounded for interaction metadata", () => {
  assert.equal(parseSlackWorkCommand(`!프로젝트조회 ${"가".repeat(300)}`).query.length, 240);
});

test("multiline creation commands retain details and skip a mention-only title", () => {
  for (const [alias, command] of [["티켓생성", "ticket_create"], ["프로젝트생성", "project_create"], ["루틴생성", "routine_create"], ["테스크생성", "task_create"], ["ticket create", "ticket_create"]]) {
    for (const newline of ["\n", "\r\n", "\u2028"]) {
      const message = `!${alias} <@UPERSON|팀원>${newline}> 업로드 오류 수정${newline}> 자세한 재현 과정${newline}> 완료 기준: 원본 파일 업로드 성공`;
      assert.deepEqual(parseSlackWorkCommand(message), { command, query: "업로드 오류 수정" });
      const content = slackWorkCommandFormContent(message);
      assert.equal(content.title, "업로드 오류 수정");
      assert.match(content.description, /자세한 재현 과정\n> 완료 기준/);
    }
  }
  assert.deepEqual(parseSlackWorkCommand("!티켓생성"), { command: "ticket_create", query: "" });
  assert.deepEqual(parseSlackWorkCommand("!티켓생성\n업로드 오류 수정\n1. 재현\n2. 검증"), { command: "ticket_create", query: "업로드 오류 수정" });
  assert.equal(parseSlackWorkCommand("일반 대화\n!티켓생성 오류 수정"), null);
});

test("channel, private channel, DM and tagged multiline commands reach their form once", async () => {
  const events = await readFile(new URL("../app/api/slack/events/route.ts", import.meta.url), "utf8");
  for (const [type, channelType, prefix] of [["message", "channel", ""], ["message", "group", ""], ["message", "im", ""], ["message", "mpim", ""], ["message", undefined, ""], ["message", "channel", "<@UBOT> "], ["app_mention", "channel", "<@UBOT> "], ["app_mention", "group", "<@UBOT|OKRI> "]]) {
    const calls = [], pending = [], receipts = new Set();
    const route = compile(events, {"@/lib/ticket-intake-queue":{captureTicketManagementReply:async()=>null,captureTicketMessage:async()=>null,processTicketReceipt:async()=>{}},
      "cloudflare:workers": { env: { DB: { prepare: () => ({ bind: (id) => ({ run: async () => {
        const changes = receipts.has(id) ? 0 : 1;
        receipts.add(id);
        return { meta: { changes } };
      } }) }) } }, waitUntil: (promise) => pending.push(promise) },
      "@/lib/pace-data": { getSlackConnectionByTeam: async () => ({ botUserId: "UBOT" }) },
      "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => true },
      "@/lib/slack-daily": {},
      "@/lib/okri-manual": { isOkriManualQuestion: () => false },
      "@/lib/slack-work-command": { ...parser, handleSlackWorkCommandEvent: async (_r, _c, event, parsed) => calls.push({ event, parsed }) },
      "@/lib/slack-mcp-agent": { handleSlackMcpConversation: async () => assert.fail("Explicit form command must not start AI") },
      "@/lib/slack-task-changes": { runDueTaskChanges: async () => {} },
    });
    const payload = { event_id: "E1", team_id: "T1", event: { type, channel_type: channelType, channel: "C1", user: "U1", ts: "1792000000.000001",
      text: `${prefix}!티켓생성\n업로드 오류 수정\n원본 파일 재현\n완료 기준: 성공` } };
    for (let retry = 0; retry < 2; retry++) {
      const response = await route.POST(new Request("https://okri.test/api/slack/events", { method: "POST", body: JSON.stringify(payload) }));
      assert.equal(response.status, 200);
      await Promise.all(pending);
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].parsed, { command: "ticket_create", query: "업로드 오류 수정" });
  }
});

function commandFixture(sourceText, options = {}) {
  const calls = [], pending = [], writes = [], ticketReads = [];
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE slack_work_command_operations (
    request_id TEXT PRIMARY KEY, owner_id TEXT, team_id TEXT, slack_user_id TEXT,
    command TEXT, target_id TEXT, status TEXT, result_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE slack_event_receipts (event_id TEXT PRIMARY KEY, team_id TEXT, event_type TEXT, received_at TEXT);`);
  const db = d1Fixture(sqlite);
  let releaseSource;
  const sourceReady = options.slow ? new Promise((resolve) => { releaseSource = resolve; }) : Promise.resolve();
  const authorization = { ownerId: "workspace", userId: "user", role: "member" };
  const connection = { ownerId: "workspace", teamId: "T1", botUserId: "UBOT" };
  const event = { channel: "C1", channelType: "channel", user: "U1", ts: "1792000000.000002", ...(options.reply ? { threadTs: "1792000000.000001" } : {}), text: sourceText };
  const runtime = { waitUntil: (p) => pending.push(p), env: { DB: db } };
  const command = compile(options.domainSource, {
    "cloudflare:workers": runtime,
    "@/lib/pace-data": {
      ITEM_PRIORITIES: ["medium"], ITEM_STATUSES: ["backlog", "todo", "done"],
      getSlackConnection: async () => connection,
      getTeam: async () => ({ members: [{ id: "member", displayName: "요청자" }] }),
      createItem: async (_owner, fields) => { writes.push(fields); return { id: "ticket", ...fields }; },
    },
    "@/lib/client-directory": {},
    "@/lib/slack-daily": {
      slackTokenForConnection: async () => "test-token",
      slackCanvasTokenForConnection: async () => null,
      resolveSlackMemberForEvent: async () => ({ authorization, memberId: "member" }),
      slackApi: async (_token, method, payload) => {
        calls.push({ method, payload });
        if (method === "views.open") return { view: { id: "view-1", hash: "hash-1" } };
        if (method === "conversations.replies") {
          if (options.historyDenied) throw new Error("not_allowed_token_type");
          await sourceReady;
          return { messages: [{ ts: "1792000000.000001", user: "UOTHER", text: "다른 사람의 업무" },
            ...(!options.missing ? [{ ts: event.ts, user: "U1", text: sourceText }] : [])] };
        }
        return { ok: true };
      },
    },
    "@/lib/project-images": {},
    "@/lib/language-preferences": { readLanguagePreferences: async () => ({ resolvedLanguage: "ko" }) },
    "@/lib/server-language": { serverTranslator: async () => (key) => key },
    "@/lib/slack-work-command-parser": parser,
    "@/lib/slack-work-intake": { SlackWorkIntakeError: class extends Error {} },
    "@/lib/slack-ticket-intake": { prepareSlackTicketForm: async (input) => {
      ticketReads.push(input);
      await sourceReady;
      if (options.missing) throw new Error("not_in_channel");
      const content = slackWorkCommandFormContent(sourceText);
      const link = `https://slack.com/archives/C1/p${(event.threadTs || event.ts).replace(".", "")}`;
      return { title: content.title, description: `${content.description.slice(0, 3000 - link.length - 2)}\n\n${link}`, messageCount: 1 };
    } },
    "@/lib/slack-work-command-guide": {},
  });
  return { command, authorization, connection, event, calls, pending, writes, ticketReads, releaseSource, sqlite, runtime };
}

test("Ticket command reads the whole thread once, caches the form and creates only on submit", async () => {
  const domainSource = await readFile(new URL("../lib/slack-work-command.ts", import.meta.url), "utf8");
  const sourceText = "!티켓생성 <@UOTHER>\n> 업로드 오류 수정\n> 상세 내용\n> 완료 기준: 실제 파일 업로드";
  const f = commandFixture(sourceText, { domainSource, historyDenied: true, reply: true });
  await f.command.handleSlackWorkCommandEvent(new Request("https://okri.test"), f.connection, f.event, parseSlackWorkCommand(sourceText));
  const prompt = f.calls.find((call) => call.method === "chat.postMessage").payload;
  assert.equal(prompt.thread_ts, f.event.threadTs);
  assert.equal(prompt.channel, f.event.channel);
  assert.match(prompt.blocks[0].text.text, /<@U1>/);
  assert.equal(f.calls.some((call) => call.method === "chat.postEphemeral"), false);
  const button = prompt.blocks[1].elements[0];
  assert.ok(button.value.length < 2_000);
  await f.command.openSlackWorkCommandModal("trigger", f.authorization, "member", button.value, "T1", "U1");
  assert.equal(f.calls.find((call) => call.method === "views.open").payload.view.submit, undefined);
  assert.equal(f.writes.length, 0);
  await Promise.all(f.pending);
  assert.equal(f.calls.some((call) => call.method === "conversations.replies"), false);
  const view = f.calls.find((call) => call.method === "views.update").payload.view;
  const title = view.blocks.find((block) => block.block_id === "work_title").element.initial_value;
  const description = view.blocks.find((block) => block.block_id === "work_description").element.initial_value;
  assert.equal(title, "업로드 오류 수정");
  assert.match(description, /완료 기준: 실제 파일 업로드/);
  assert.doesNotMatch(description, /다른 사람의 업무/);
  assert.ok(view.submit);
  await f.command.openSlackWorkCommandModal("trigger-again", f.authorization, "member", button.value, "T1", "U1");
  await Promise.all(f.pending);
  assert.equal(f.ticketReads.length, 1);
  assert.equal(f.ticketReads[0].event.threadTs, f.event.threadTs);
  const state = { work_title: { work_title: { value: title } }, work_description: { work_description: { value: description } } };
  for (let retry = 0; retry < 2; retry++) await f.command.submitSlackWorkCommand(f.authorization, "member", view.private_metadata, state, "T1", "U1");
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].kind, "ticket");
  assert.equal(f.writes[0].description, description);
});

test("long Ticket details fit Slack bounds with an original link; missing sources and wrong members cannot submit", async () => {
  const domainSource = await readFile(new URL("../lib/slack-work-command.ts", import.meta.url), "utf8");
  for (const missing of [false, true]) {
    const text = `!티켓생성\n업로드 오류 수정\n${"자세한 내용과 완료 기준\n".repeat(500)}`;
    const f = commandFixture(text, { domainSource, missing });
    await f.command.handleSlackWorkCommandEvent(new Request("https://okri.test"), f.connection, f.event, parseSlackWorkCommand(text));
    const raw = f.calls.find((call) => call.method === "chat.postMessage").payload.blocks[1].elements[0].value;
    await assert.rejects(() => f.command.openSlackWorkCommandModal("trigger", f.authorization, "another-member", raw, "T1", "U1"));
    await f.command.openSlackWorkCommandModal("trigger", f.authorization, "member", raw, "T1", "U1");
    await Promise.all(f.pending);
    const view = f.calls.find((call) => call.method === "views.update").payload.view;
    if (missing) {
      assert.equal(view.submit, undefined);
      assert.match(view.blocks[0].text.text, /스레드 내용을 불러오지 못했습니다/);
    } else {
      const description = view.blocks.find((block) => block.block_id === "work_description").element.initial_value;
      assert.ok(description.length <= 3_000);
      assert.match(description, /https:\/\/slack.com\/archives\/C1\/p1792000000000002$/);
    }
    assert.ok(raw.length < 2_000);
    assert.equal(f.writes.length, 0);
  }
});

test("legacy form buttons still acknowledge before exact-message history lookup", async () => {
  const domainSource = await readFile(new URL("../lib/slack-work-command.ts", import.meta.url), "utf8");
  const f = commandFixture("!티켓생성\n업로드 오류 수정\n상세 설명", { domainSource, slow: true, reply: true });
  await f.command.handleSlackWorkCommandEvent(new Request("https://okri.test"), f.connection, f.event, parseSlackWorkCommand(f.event.text));
  const metadata = JSON.parse(f.calls.find((call) => call.method === "chat.postMessage").payload.blocks[1].elements[0].value);
  delete metadata.sourceSnapshot;
  delete metadata.ticketThread;
  await f.command.openSlackWorkCommandModal("trigger", f.authorization, "member", JSON.stringify(metadata), "T1", "U1");
  assert.equal(f.calls.find((call) => call.method === "views.open").payload.view.submit, undefined);
  f.releaseSource();
  await Promise.all(f.pending);
  const sourceCall = f.calls.find((call) => call.method === "conversations.replies");
  assert.equal(sourceCall.payload.ts, f.event.threadTs);
  assert.equal(sourceCall.payload.oldest, f.event.ts);
  assert.equal(sourceCall.payload.latest, f.event.ts);
  assert.ok(f.calls.find((call) => call.method === "views.update").payload.view.submit);
});

test("concurrent Ticket opens share one preparation and changed roles or foreign scopes cannot read it", async () => {
  const domainSource = await readFile(new URL("../lib/slack-work-command.ts", import.meta.url), "utf8");
  const f = commandFixture("!티켓생성\n서버 오류 확인\n최신 스레드 내용", { domainSource, slow: true, reply: true });
  await f.command.handleSlackWorkCommandEvent(new Request("https://okri.test"), f.connection, f.event, parseSlackWorkCommand(f.event.text));
  const raw = f.calls.find((call) => call.method === "chat.postMessage").payload.blocks[1].elements[0].value;
  await assert.rejects(() => f.command.openSlackWorkCommandModal("t", { ...f.authorization, role: "viewer" }, "member", raw, "T1", "U1"));
  await assert.rejects(() => f.command.openSlackWorkCommandModal("t", { ...f.authorization, ownerId: "other" }, "member", raw, "T1", "U1"));
  await assert.rejects(() => f.command.openSlackWorkCommandModal("t", f.authorization, "member", raw, "T2", "U1"));
  await assert.rejects(() => f.command.openSlackWorkCommandModal("t", f.authorization, "member", raw, "T1", "U2"));
  await f.command.openSlackWorkCommandModal("first", f.authorization, "member", raw, "T1", "U1");
  // Let the first request claim the source before opening a second view.
  await new Promise((resolve) => setImmediate(resolve));
  await f.command.openSlackWorkCommandModal("second", f.authorization, "member", raw, "T1", "U1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ticketReads.length, 1);
  assert.ok(f.calls.some((call) => call.method === "views.update" && !call.payload.view.submit));
  f.releaseSource();
  await Promise.all(f.pending);
  assert.equal(f.ticketReads.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM slack_work_command_operations WHERE command='ticket_source' AND status='succeeded'").get().n, 1);
  f.sqlite.close();
});

test("Ticket forms distinguish received/reviewing/ready/processing/closed and default to ready", async () => {
  const domainSource = await readFile(new URL("../lib/slack-work-command.ts", import.meta.url), "utf8");
  for (const selected of [undefined, "backlog", "policy_discussion", "todo", "in_progress", "done"]) {
    const f = commandFixture("!티켓생성 새로운 요청", { domainSource });
    await f.command.handleSlackWorkCommandEvent(new Request("https://okri.test"), f.connection, f.event, parseSlackWorkCommand(f.event.text));
    const raw = f.calls.find((call) => call.method === "chat.postMessage").payload.blocks[1].elements[0].value;
    await f.command.openSlackWorkCommandModal("trigger", f.authorization, "member", raw, "T1", "U1");
    await Promise.all(f.pending);
    const view = f.calls.find((call) => call.method === "views.update").payload.view;
    const status = view.blocks.find((block) => block.block_id === "work_status").element;
    assert.equal(status.initial_option.value, "todo");
    assert.deepEqual(status.options.map((entry) => [entry.value, entry.text.text]), [
      ["backlog", "접수"], ["policy_discussion", "검토 중"], ["todo", "처리 대기"], ["in_progress", "처리 중"], ["done", "종료"],
    ]);
    const state = { work_title: { work_title: { value: "새로운 요청" } },
      ...(selected ? { work_status: { work_status: { selected_option: { value: selected } } } } : {}) };
    await f.command.submitSlackWorkCommand(f.authorization, "member", view.private_metadata, state, "T1", "U1");
    assert.equal(f.writes[0].status, selected ?? "todo");
    f.sqlite.close();
  }
});

test("a failed thread read is retryable without creating an item or caching an empty success", async () => {
  const domainSource = await readFile(new URL("../lib/slack-work-command.ts", import.meta.url), "utf8");
  const options = { domainSource, missing: true, reply: true };
  const f = commandFixture("!티켓생성\n실제 스레드 요청\n복구 후에 읽을 내용", options);
  await f.command.handleSlackWorkCommandEvent(new Request("https://okri.test"), f.connection, f.event, parseSlackWorkCommand(f.event.text));
  const raw = f.calls.find((call) => call.method === "chat.postMessage").payload.blocks[1].elements[0].value;
  await f.command.openSlackWorkCommandModal("first", f.authorization, "member", raw, "T1", "U1");
  await Promise.all(f.pending);
  assert.equal(f.sqlite.prepare("SELECT status FROM slack_work_command_operations WHERE command='ticket_source'").get().status, "failed");
  assert.equal(f.writes.length, 0);
  options.missing = false;
  await f.command.openSlackWorkCommandModal("retry", f.authorization, "member", raw, "T1", "U1");
  await Promise.all(f.pending);
  assert.equal(f.sqlite.prepare("SELECT status FROM slack_work_command_operations WHERE command='ticket_source'").get().status, "succeeded");
  assert.equal(f.ticketReads.length, 2);
  assert.equal(f.writes.length, 0);
  assert.ok(f.calls.filter((call) => call.method === "views.update").at(-1).payload.view.submit);
  f.sqlite.close();
});

test("production-shaped Ticket event reaches a durable button and source-filled modal with duplicate delivery suppressed", async () => {
  const domainSource = await readFile(new URL("../lib/slack-work-command.ts", import.meta.url), "utf8");
  const f = commandFixture("!티켓생성\nCI 실행기 시작 지연 원인 확인\n저장소: https://github.com/example/service\n완료 기준: 필수 CI 성공", { domainSource, reply: true, historyDenied: true });
  const route = compile(await readFile(new URL("../app/api/slack/events/route.ts", import.meta.url), "utf8"), {"@/lib/ticket-intake-queue":{captureTicketManagementReply:async()=>null,captureTicketMessage:async()=>null,processTicketReceipt:async()=>{}},
    "cloudflare:workers": f.runtime,
    "@/lib/pace-data": { getSlackConnectionByTeam: async () => f.connection },
    "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => true },
    "@/lib/slack-daily": {},
    "@/lib/okri-manual": { isOkriManualQuestion: () => false },
    "@/lib/slack-work-command": f.command,
    "@/lib/slack-mcp-agent": { handleSlackMcpConversation: async () => assert.fail("Explicit Ticket command must not call AI") },
    "@/lib/slack-task-changes": { runDueTaskChanges: async () => {} },
  });
  for (const type of ["message", "app_mention"]) {
    const payload = { event_id: `E-${type}`, team_id: "T1", event: { type, channel: f.event.channel, user: "U1",
      ts: f.event.ts, thread_ts: f.event.threadTs, text: `<@UBOT> ${f.event.text}` } };
    assert.equal((await route.POST(new Request("https://okri.test/api/slack/events", { method: "POST", body: JSON.stringify(payload) }))).status, 200);
    await Promise.all(f.pending);
  }
  const prompts = f.calls.filter((call) => call.method === "chat.postMessage");
  assert.equal(prompts.length, 1);
  const raw = prompts[0].payload.blocks[1].elements[0].value;
  const interactions = compile(await readFile(new URL("../app/api/slack/interactions/route.ts", import.meta.url), "utf8"), {
    "cloudflare:workers": f.runtime,
    "@/lib/pace-data": { getSlackConnectionByTeam: async () => f.connection },
    "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => true },
    "@/lib/slack-daily": { dailyMemberBySlack: async () => ({ authorization: f.authorization, memberId: "member" }) },
    "@/lib/language-preferences": { workspaceMessageLanguage: async () => "ko", memberMessageLanguage: async () => "ko" },
    "@/lib/server-language": { serverTranslator: async () => (text) => text },
    "@/lib/slack-work-command": f.command,
    "@/lib/daily-bot": {}, "@/lib/slack-daily-checklist": {}, "@/lib/slack-management-actions": {},
  });
  const interact = (payload) => interactions.POST(new Request("https://okri.test/api/slack/interactions", {
    method: "POST", body: new URLSearchParams({ payload: JSON.stringify({ team: { id: "T1" }, user: { id: "U1" }, ...payload }) }),
  }));
  assert.equal((await interact({ type: "block_actions", trigger_id: "trigger", actions: [{ action_id: "work_command_open", value: raw }] })).status, 200);
  await Promise.all(f.pending);
  const view = f.calls.find((call) => call.method === "views.update").payload.view;
  assert.equal(view.blocks.find((block) => block.block_id === "work_title").element.initial_value, "CI 실행기 시작 지연 원인 확인");
  assert.match(view.blocks.find((block) => block.block_id === "work_description").element.initial_value, /완료 기준: 필수 CI 성공/);
  assert.ok(view.submit);
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.some((call) => call.method === "conversations.replies"), false);
  const values = Object.fromEntries(["work_title", "work_description"].map((id) => [id, { [id]: { value: view.blocks.find((block) => block.block_id === id).element.initial_value } }]));
  for (let retry = 0; retry < 2; retry++) {
    const response = await interact({ type: "view_submission", view: { callback_id: "work_command_submit", private_metadata: view.private_metadata, state: { values } } });
    assert.equal((await response.json()).response_action, "update");
  }
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].kind, "ticket");
});

test("Slack channel events, private responses, permissions, and request idempotency stay wired", async () => {
  const [events, commands, interactions, domain, guide, guideRoute, page, intake, pace, oauth, manifest, schema] = await Promise.all([
    readFile(new URL("../app/api/slack/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/commands/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/interactions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/slack-work-command.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/slack-work-command-guide.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/slack/work-guide/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
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
  assert.ok(events.indexOf("const commandMessage") < events.indexOf("INSERT OR IGNORE INTO slack_event_receipts (event_id"));
  assert.match(domain, /chat\.postEphemeral/);
  assert.match(domain, /prepareSlackWorkDraft/);
  assert.match(domain, /검토 후 생성/);
  assert.match(domain, /createRoutine/);
  assert.match(domain, /kind: "ticket"/);
  assert.match(domain, /setTicketClientLink/);
  assert.match(domain, /if \(parentValue &&/);
  assert.match(domain, /General\(기본\)에 저장됩니다/);
  assert.match(domain, /selectedValue\(state, "work_target", targetAction\(command\)\)/);
  assert.match(domain, /listItems\(authorization\.ownerId, \{ kind: "ticket"/);
  assert.match(domain, /\["project", "ticket", "routine"\]\.includes\(parentKind\)/);
  assert.match(domain, /parentKind === "project" \|\| parentKind === "ticket"/);
  assert.ok(domain.indexOf('parsed.command === "help"') < domain.indexOf("if (!linked)"));
  for (const command of ["/okri daily", "!내업무", "!프로젝트 [이름]", "!루틴 [이름]", "!티켓 [이름]", "!테스크 [이름]", "@OKRI [요청]"]) assert.ok(`${domain}\n${guide}`.includes(command));
  assert.match(guideRoute, /canManageTeam\(authorization\)/);
  assert.match(guideRoute, /includeJoinablePublic: true/);
  assert.match(guideRoute, /canAutoJoinSlackChannel\(channel\)/);
  assert.match(guideRoute, /chat\.postMessage/);
  assert.match(page, /\/api\/slack\/work-guide/);
  assert.match(page, /매뉴얼 공유/);
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
  for (const scope of ["channels:history", "groups:history", "files:read", "canvases:read"]) {
    assert.match(oauth, new RegExp(scope));
    assert.match(manifest, new RegExp(scope));
  }
  for (const event of ["message.channels", "message.groups"]) assert.match(manifest, new RegExp(event.replace(".", "\\.")));
  assert.match(schema, /slack_work_command_operations/);
  assert.match(domain, /saveSlackProjectImages/);
  assert.match(domain, /sourceThread/);
  assert.match(domain, /conversations\.join/);
  assert.match(domain, /conversations\.open/);
  assert.match(schema, /project_images/);
});

test("shared Slack guide keeps forms and natural-language requests distinct", async () => {
  const guide = compile(await readFile(new URL("../lib/slack-work-command-guide.ts", import.meta.url), "utf8"));
  const t = (value) => value;
  const text = guide.slackWorkGuideText(t);
  for (const command of ["!프로젝트 [이름]", "!루틴 [이름]", "!티켓 [이름]", "!테스크 [이름]", "@OKRI [요청]"]) assert.match(text, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /느낌표 명령은 양식을 열고/);
  assert.match(text, /Ticket의 실행 담당자는 하위 Task/);
  assert.ok(guide.slackWorkGuideBlocks(t).length <= 50, "Slack block limit stays bounded");
});

test("manual share joins an eligible public channel and posts the shared guide once", async () => {
  const guide = compile(await readFile(new URL("../lib/slack-work-command-guide.ts", import.meta.url), "utf8"));
  const routeSource = await readFile(new URL("../app/api/slack/work-guide/route.ts", import.meta.url), "utf8");
  const calls = [];
  const route = compile(routeSource, {
    "@/lib/pace-data": {
      authorizeRequest: async () => ({ ownerId: "ws", userId: "owner", role: "owner" }),
      canManageTeam: () => true,
      getSlackConnection: async () => ({ ownerId: "ws", teamId: "T1" }),
    },
    "@/lib/slack-daily": {
      canAutoJoinSlackChannel: () => true,
      listSlackChannels: async (_ownerId, options) => {
        assert.deepEqual(options, { includeJoinablePublic: true });
        return [{ id: "C123", name: "ops", isPrivate: false, isMember: false, isShared: false, isExternal: false }];
      },
      slackTokenForConnection: async () => "encrypted-token-was-decoded",
      slackApi: async (_token, method, payload) => { calls.push({ method, payload }); return { ok: true }; },
    },
    "@/lib/language-preferences": { workspaceMessageLanguage: async () => "ko" },
    "@/lib/server-language": { serverTranslator: async () => (value) => value },
    "@/lib/slack-work-command-guide": guide,
    "cloudflare:workers": { env: { DB: {} } },
  });
  const response = await route.POST(new Request("https://okri.example/api/slack/work-guide", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: "C123" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.method), ["conversations.join", "chat.postMessage"]);
  assert.match(calls[1].payload.text, /!티켓 \[이름\]/);
  assert.equal(calls[1].payload.channel, "C123");
});

test('assigned ticket-thread mentions are captured before the general chatbot can respond',async()=>{
  const pending=[],forwarded=[],captured=[];
  const route=compile(await readFile(new URL('../app/api/slack/events/route.ts',import.meta.url),'utf8'),{
    'cloudflare:workers':{env:{},waitUntil:p=>pending.push(p)},
    '@/lib/pace-data':{getSlackConnectionByTeam:async()=>({ownerId:'w1',teamId:'T1',botUserId:'UBOT'})},
    '@/lib/slack-oauth':{slackConfigured:()=>true,verifySlackRequest:async()=>true},
    '@/lib/slack-daily':{},'@/lib/okri-manual':{isOkriManualQuestion:()=>false},
    '@/lib/slack-work-command':parser,
    '@/lib/slack-mcp-agent':{handleSlackMcpConversation:async()=>assert.fail('Ticket conversations must stay with their assigned port')},
    '@/lib/ticket-intake-queue':{captureTicketManagementReply:async(_c,e)=>{captured.push(e);return 'durable-reply';},processTicketReceipt:async id=>forwarded.push(id)}
  });
  for(const type of ['message','app_mention'])assert.equal((await route.POST(new Request('https://okri.test/api/slack/events',{method:'POST',body:JSON.stringify({event_id:type,team_id:'T1',event:{type,channel:'CMGMT',channel_type:'channel',user:'U1',ts:'11.000',thread_ts:'10.000',text:'<@UBOT> 현재 제품을 확인하고 범위를 제안해 주세요.'}})}))).status,200);
  await Promise.all(pending);assert.equal(captured.length,2);assert.equal(captured[0].text,captured[1].text);assert.doesNotMatch(captured[0].text,/UBOT/);assert.deepEqual(forwarded,['durable-reply','durable-reply']);
});
