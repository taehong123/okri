import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { compileLanguageModule as compile, d1Fixture } from "./helpers/language-fixture.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const continuity = compile(await read("lib/slack-mcp-continuity.ts"));
const plan = compile(await read("lib/slack-mcp-plan.ts"));
const search = compile(await read("lib/slack-mcp-search.ts"), { "./slack-mcp-plan": plan });
const agentSource = await read("lib/slack-mcp-agent.ts");
const defaults = compile(await read("lib/slack-creation-defaults.ts"));
const context = compile(await read("lib/slack-mcp-context.ts"));
const mrkdwn = compile(await read("lib/slack-mrkdwn.ts"));
const day = "2026-10-19";
const requested = [
  { key: "green", kind: "project", title: "그린서비스 유료전환" },
  { key: "sheet", kind: "task", title: "그린서비스 시트 연동", parent_title: "그린서비스 유료전환", depends_on: "green", due_date: day },
  { key: "lens", kind: "project", title: "렌즈 AX" },
  { key: "lens-proposal", kind: "task", title: "렌즈 제안서 보내기", parent_title: "렌즈 AX", depends_on: "lens", due_date: day },
  { key: "finance", kind: "project", title: "샘플푸드 재무 자동화" },
  { key: "finance-proposal", kind: "task", title: "재무 자동화 제안서 보내기", parent_title: "샘플푸드 재무 자동화", depends_on: "finance", due_date: day },
];
const projects = requested.filter((item) => item.kind === "project");
const tasks = requested.filter((item) => item.kind === "task");
let callId = 0;
const call = (name, args) => ({ type: "function_call", call_id: `call-${++callId}`, name, arguments: JSON.stringify(args) });
const response = (...output) => ({ id: `response-${++callId}`, output, usage: { input_tokens: 100, output_tokens: 80 } });
const prose = (text) => ({ id: `response-${++callId}`, output_text: text });

function proposal(title, id, initiativeId = "growth") {
  return { id, version: `v-${id}`, state: "awaiting_user_confirmation", title,
    proposal: { title, description: `${title} 실행 및 결과 확인`, driMemberId: "member", workerMemberIds: [], requestedCycleId: "cycle" },
    summary: { dri: "요청자", workers: [], title, description: `${title} 실행 및 결과 확인`, status: "todo", priority: "medium" },
    editor: { revision: "a".repeat(64) }, recommendations: [{ initiativeId, reason: "사용자가 정한 성과 경로",
      initiative: { id: initiativeId, cycleId: "cycle", fingerprint: "b".repeat(64), path: ["팀 목표", initiativeId === "growth" ? "성장 매출" : "외주 매출", initiativeId] } }] };
}

async function fixture(t) {
  const state = { session: null, messages: [], posted: [], writes: [], readItems: [], initiatives: [], reviews: new Map(), failConfirm: new Set(), budgetError: false, steps: [] };
  const db = { prepare: (sql) => ({ bind: (...args) => ({
    all: async () => ({ results: [] }),
    first: async () => state.session ? { result_json: JSON.stringify(state.session), updated_at: new Date().toISOString() } : null,
    run: async () => { assert.match(sql, /INSERT INTO slack_work_command_operations/); state.session = JSON.parse(args[4]); return { meta: { changes: 1 } }; },
  }) }) };
  const agent = compile(agentSource, {
    "cloudflare:workers": { env: { DB: db, OPENAI_API_KEY: "test-only" } },
    "@modelcontextprotocol/sdk/inMemory.js": { InMemoryTransport },
    "@/app/mcp/route": { createOkriServer: async () => {
      const server = new McpServer({ name: "thread-plan-fixture", version: "1" });
      const register = (name, properties, handler, readOnlyHint = false) => server.registerTool(name, {
        description: `${name}: authorized fixture tool with the same work semantics as production.`, inputSchema: properties, annotations: { readOnlyHint },
      }, async (args) => ({ content: [{ type: "text", text: "fixture" }], ...await handler(args) }));
      register("prepare_work", { kind: z.string(), source_text: z.string(), include_members: z.boolean(), limit: z.number() }, async () => ({ structuredContent: { context: {
        projects: state.readItems.filter((item) => item.kind === "project"), initiatives: state.initiatives, members: [{ id: "member", displayName: "요청자", role: "owner", status: "active" }],
      } } }), true);
      register("list_items", { kind: z.string().optional(), query: z.string().optional(), parent_id: z.string().optional(), limit: z.number().optional() }, async (args) => ({ structuredContent: {
        items: state.readItems.filter((item) => (!args.kind || item.kind === args.kind) && (!args.query || plan.workName(item.title).includes(plan.workName(args.query))) && (!args.parent_id || item.parentId === args.parent_id)),
      } }), true);
      register("list_routines", {}, async () => ({ structuredContent: { routines: [] } }), true);
      register("create_item", { kind: z.string(), title: z.string(), template_id: z.string().optional() }, async () => { throw new Error("Slack must never reach the legacy Project confirmation path"); });
      register("manage_project", { action: z.string(), title: z.string().optional(), dri_member_id: z.string().optional(),
        recommended_initiatives: z.array(z.object({ initiative_id: z.string(), reason: z.string() })).optional(), confirmation: z.record(z.string(), z.unknown()).optional() }, async (args) => {
        if (args.action === "propose") {
          const review = proposal(args.title, `review-${state.reviews.size}`, args.recommended_initiatives?.[0]?.initiative_id);
          state.reviews.set(review.id, review);
          return { structuredContent: { review } };
        }
        const review = state.reviews.get(args.confirmation.review_id);
        assert.ok(review, "only existing reviews may be confirmed");
        if (state.failConfirm.has(review.title)) throw new Error("fixture confirmation failure");
        assert.equal(review.state, "awaiting_user_confirmation");
        state.writes.push({ kind: "project", title: review.title });
        state.readItems.push({ id: `project-${review.title}`, kind: "project", title: review.title });
        return { structuredContent: { review: { ...review, state: "created", projectId: `project-${review.title}` } } };
      });
      register("create_tasks", { titles: z.array(z.string()), parent_id: z.string().optional(), due_date: z.string().optional(), assignee_member_id: z.string().optional() }, async (args) => {
        const items = args.titles.map((title) => ({ id: `task-${state.writes.length}-${title}`, kind: "task", title, parentId: args.parent_id, dueDate: args.due_date }));
        state.writes.push(...items);
        state.readItems.push(...items);
        return { structuredContent: { items, count: items.length } };
      });
      register("link_item", { id: z.string(), parent_id: z.string().optional(), routine_id: z.string().optional() }, async (args) => {
        const item = state.readItems.find((item) => item.id === args.id);
        assert.ok(item, "only an existing fixture Task may move");
        Object.assign(item, { parentId: args.parent_id ?? null, routineId: args.routine_id ?? null });
        state.writes.push({ operation: "link", id: item.id, parentId: item.parentId });
        return { structuredContent: { item } };
      });
      return server;
    } },
    "@/lib/billing": { BillingLimitError: class extends Error {}, assertAiBudget: async () => {
      if (state.budgetError) throw new Error("fixture billing unavailable");
      return { limitWon: null, spentWonMicros: 0 };
    } },
    "@/lib/pace-data": { getAiUsageSummary: async () => ({}), reserveAiUsageEvent: async () => "test-reservation", finalizeAiUsageEvent: async () => {}, releaseAiUsageReservation: async () => {} },
    "@/lib/slack-daily": { slackTokenForConnection: async () => "test-only", slackCanvasTokenForConnection: async () => null,
      resolveSlackMemberForEvent: async () => ({ authorization: { ownerId: "workspace", userId: "user", role: "owner" }, memberId: "member" }),
      slackApi: async (_token, method, payload) => { state.posted.push({ method, ...payload }); return { ok: true, ts: "reply" }; } },
    "@/lib/slack-creation-defaults": defaults,
    "@/lib/okri-manual": { isOkriManualQuestion: () => false },
    "@/lib/slack-mrkdwn": mrkdwn,
    "@/lib/slack-mcp-context": context,
    "@/lib/slack-work-intake": { SlackWorkIntakeError: class extends Error {}, readSlackThread: async () => ({ messages: state.messages, truncated: false, imageFiles: [], imagesTruncated: false }) },
    "@/lib/project-images": {},
    "@/lib/slack-mcp-continuity": continuity,
    "@/lib/slack-mcp-plan": plan,
    "@/lib/slack-mcp-search": { searchSlackWork: async (_db, owner, args) => { assert.equal(owner, "workspace"); return { query: args.query,
      items: [...state.readItems, ...state.initiatives].filter((item) => (!args.kind || item.kind === args.kind) && plan.workName(item.title).includes(plan.workName(args.query))) }; } },
  });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.ok(state.steps.length, "unexpected extra model request");
    const step = state.steps.shift();
    return Response.json(typeof step === "function" ? step(JSON.parse(init.body)) : step);
  });
  state.run = async (query, steps) => {
    state.steps = [...steps];
    const ts = String(Date.now() / 1000);
    state.messages.push({ user: "user", text: query, ts });
    await agent.handleSlackMcpConversation(new Request("https://okri.test"), { teamId: "team", botUserId: "bot", scope: "channels:history" },
      { channel: "channel", channelType: "channel", user: "user", ts, threadTs: "root", text: query }, query);
    assert.equal(state.steps.length, 0, "scripted model steps must all run");
    return state.posted.at(-1).text;
  };
  return state;
}

const proposeAll = (suffix = "") => response(...projects.map((item, i) => call("manage_project", {
  action: "propose", title: item.title, _plan_key: item.key,
  recommended_initiatives: [{ initiative_id: i === 0 ? `growth${suffix}` : `external-ax${suffix}`, reason: "사용자의 최신 방향" }],
})));
const createAllTasks = () => response(...tasks.map((item) => call("create_tasks", {
  titles: [item.title], parent_id: `project-${item.parent_title}`, due_date: day, _plan_key: item.key,
})));

test("multi-project thread retains every request, refreshes corrections, confirms all displayed reviews and continues child Tasks", async (t) => {
  const f = await fixture(t);
  const answer = await f.run("세 프로젝트와 테스크를 각각 생성해줘. 그린서비스 유료전환과 렌즈 AX 그리고 샘플푸드 재무 자동화 프로젝트 아래 오늘 기한 업무도 각각 추가해줘", [
    (body) => { assert.equal(body.tool_choice.name, "plan_work"); return response(call("plan_work", { items: requested })); },
    response(call("create_item", { kind: "project", title: projects[0].title, template_id: "internal-legacy-confirmation" })),
    (body) => { assert.match(body.input[0].output, /must use manage_project/);
      return response(call("search_work", { query: "그린서비스", kind: "project" }), call("search_work", { query: "렌즈", kind: "project" }), call("search_work", { query: "샘플푸드", kind: "project" })); },
    proposeAll(), prose("아래 생성안을 승인해 주세요."),
  ]);
  assert.equal(f.writes.length, 0);
  assert.equal(f.session.workPlan.length, 6);
  assert.equal(f.session.presentedReviewIds.length, 3);
  for (const item of requested) assert.ok(answer.includes(item.title));
  const oldIds = [...f.session.presentedReviewIds];
  // Simulate the earlier message having been shown before a later human correction.
  for (const turn of f.session.turns) turn.at = new Date(Date.now() - 10_000).toISOString();
  const corrected = await f.run("연결 수정해줘. 그린은 성장 매출이고 나머지는 구독이 아니라 외부 AX 매출이야", [
    (body) => { const input = JSON.parse(body.input[1].content[0].text); assert.equal(input.projectReviewMustRefresh, true);
      return response(call("manage_project", { action: "confirm", confirmation: { review_id: oldIds[0] } })); },
    (body) => { assert.match(body.input[0].output, /not approved|corrected/); return proposeAll("-corrected"); },
    prose("말씀하신 연결로 수정했습니다. 생성 전 확인해 주세요."),
  ]);
  assert.equal(f.writes.length, 0, "an old proposal cannot be silently confirmed");
  assert.equal(f.session.presentedReviewIds.length, 3);
  assert.ok(f.session.presentedReviewIds.every((id) => !oldIds.includes(id)));
  assert.match(corrected, /external-ax-corrected/);
  const complete = await f.run("진행해", [
    (body) => { const input = JSON.parse(body.input[1].content[0].text); assert.equal(input.alreadyConfirmedProjects.length, 3);
      assert.equal(f.writes.length, 3); return prose("프로젝트를 생성했습니다."); },
    (body) => { assert.equal(body.tool_choice, "required"); assert.match(body.input[0].content, /ALL remaining/); return createAllTasks(); },
    prose("세 프로젝트와 세 업무를 반영했습니다."),
  ]);
  assert.equal(f.writes.filter((row) => row.kind === "project").length, 3);
  assert.equal(f.writes.filter((row) => row.kind === "task").length, 3);
  for (const item of tasks) assert.ok(f.writes.some((row) => row.title === item.title && row.parentId === `project-${item.parent_title}` && row.dueDate === day));
  assert.ok(f.session.workPlan.every((item) => item.record));
  assert.doesNotMatch(complete, /미처리|승인 대기/);
  await f.run("아까 그 프로젝트와 테스크 생성해줘", [proposeAll(),
    (body) => { assert.ok(body.input.every((output) => /already has a saved record/.test(output.output))); return createAllTasks(); },
    (body) => { assert.ok(body.input.every((output) => /already has a successful/.test(output.output))); return prose("기존 저장 항목을 그대로 사용했습니다."); },
  ]);
  assert.equal(f.writes.length, 6, "repeating the same request must not duplicate child Tasks");
  await f.run("여기 모든사항 다 반영한거맞아?", [
    (body) => { const input = JSON.parse(body.input[1].content[0].text); assert.equal(input.statusQuestion, true);
      assert.ok(body.tools.every((tool) => ["prepare_work", "list_items", "list_routines", "search_work"].includes(tool.name)));
      return response(call("create_tasks", { titles: ["허용되지 않은 업무"] })); },
    (body) => { assert.match(body.input[0].output, /not available/); return prose("저장된 여섯 항목을 확인했습니다."); },
  ]);
  assert.equal(f.writes.length, 6);
});

test("approval never confirms a legacy review when intervening corrections were only acknowledged in prose", async (t) => {
  const f = await fixture(t);
  const review = proposal("그린서비스", "legacy-review");
  f.reviews.set(review.id, review);
  f.session = { version: 1, turns: [{ name: "manage_project", arguments: { action: "propose", title: review.title },
    result: { structuredContent: { review } }, at: new Date(Date.now() - 20_000).toISOString(), actorUserId: "user" }], answer: "옛 연결 생성안", updatedAt: new Date().toISOString() };
  f.messages.push({ user: "user", text: "구독 매출 말고 외부 AX 이니셔티브로 바꿔줘", ts: String(Date.now() / 1000 - 10) });
  await f.run("진행해", [
    (body) => { const input = JSON.parse(body.input[1].content[0].text); assert.equal(input.projectReviewMustRefresh, true); assert.equal(f.writes.length, 0);
      return response(call("plan_work", { items: [requested[0]] })); },
    response(call("manage_project", { action: "propose", title: requested[0].title, recommended_initiatives: [{ initiative_id: "corrected-ax", reason: "수정 반영" }] })),
    prose("수정된 연결을 확인해 주세요."),
  ]);
  assert.equal(f.writes.length, 0);
  assert.notDeepEqual(f.session.presentedReviewIds, [review.id]);
});

test("partial confirmation and subsequent AI/budget failure preserve actual receipts and unfinished work", async (t) => {
  const f = await fixture(t);
  f.session = { version: 1, workPlan: plan.updateWorkPlan([], requested), presentedReviewIds: [], turns: [], answer: "", updatedAt: new Date().toISOString() };
  for (const [i, item] of projects.entries()) {
    const review = proposal(item.title, `partial-${i}`);
    f.reviews.set(review.id, review); f.session.presentedReviewIds.push(review.id);
    f.session.turns.push({ name: "manage_project", arguments: { action: "propose", title: item.title }, result: { structuredContent: { review } }, at: new Date().toISOString(), actorUserId: "user" });
  }
  f.failConfirm.add(projects[1].title); f.budgetError = true;
  const answer = await f.run("승인해", []);
  assert.equal(f.writes.length, 2);
  assert.equal(f.session.workPlan.filter((item) => item.record).length, 2);
  assert.match(answer, /미처리/);
  assert.doesNotMatch(answer, /모두.*완료/);
});

test("legacy thread with only one created Project reconstructs the missing plan on a short continuation without duplicating that Project", async (t) => {
  const f = await fixture(t);
  const review = { ...proposal(projects[0].title, "legacy-created"), state: "created", projectId: `project-${projects[0].title}` };
  f.session = { version: 1, turns: [{ name: "manage_project", arguments: { action: "confirm", confirmation: { review_id: review.id } },
    result: { structuredContent: { review } }, at: new Date(Date.now() - 20_000).toISOString(), actorUserId: "user" }], answer: "프로젝트 하나 생성했습니다.", updatedAt: new Date().toISOString() };
  f.messages.push({ user: "user", text: "세 프로젝트와 테스크를 각각 생성해줘. 그린서비스 유료전환, 렌즈 AX, 샘플푸드 재무 자동화 및 각 제안서 업무는 오늘 기한으로", ts: String(Date.now() / 1000 - 30) });
  const answer = await f.run("진행해", [
    (body) => { const input = JSON.parse(body.input[1].content[0].text); assert.equal(input.explicitCreationRequest, true);
      assert.equal(body.tool_choice.name, "plan_work"); return response(call("plan_work", { items: requested })); },
    (body) => { const updated = JSON.parse(body.input[0].output).structuredContent.workPlan;
      assert.equal(updated[0].record.id, review.projectId);
      return response(...projects.slice(1).map((item) => call("manage_project", { action: "propose", title: item.title })),
        call("create_tasks", { titles: [tasks[0].title], parent_id: review.projectId, due_date: day })); },
    prose("이미 생성된 프로젝트는 유지하고 나머지 생성안을 준비했습니다."),
  ]);
  assert.equal(f.writes.filter((row) => row.kind === "project").length, 0);
  assert.equal(f.writes.filter((row) => row.kind === "task").length, 1);
  assert.equal(f.session.workPlan.length, 6);
  assert.equal(f.session.presentedReviewIds.length, 2);
  assert.match(answer, /생성 승인 대기/);
});

test("plan guards reject cross-parent batches, missing dependencies, wrong deadlines, mismatched receipts and dependency cycles", () => {
  let items = plan.updateWorkPlan([], requested);
  assert.match(plan.taskPlanGuard(items, "create_tasks", { titles: tasks.map((item) => item.title), due_date: day }), /different requested containers/);
  assert.match(plan.taskPlanGuard(items, "create_tasks", { titles: [tasks[0].title], due_date: day }), /parent is not saved/);
  assert.match(plan.taskPlanGuard(items, "create_tasks", { titles: [tasks[0].title] }), /deadline/);
  const selection = { name: "create_tasks", arguments: {}, result: { structuredContent: { placement: { status: "selection_required" }, items: [], count: 0 } } };
  assert.equal(plan.toolSucceeded(selection), false);
  items = plan.reconcileWorkPlan(items, [{ name: "manage_project", arguments: {}, result: { structuredContent: { review: { title: "別のプロジェクト", state: "created", projectId: "wrong" } } }, planKey: "green" }]);
  assert.equal(items[0].record, undefined, "a plan key cannot turn an unrelated write into a successful requested item");
  items[0].record = { id: "green-project", title: projects[0].title };
  assert.match(plan.taskPlanGuard(items, "create_tasks", { titles: [tasks[0].title], due_date: day, parent_id: "other" }), /saved ID/);
  const taskReceipt = { name: "create_tasks", arguments: {}, result: { structuredContent: { items: [{ id: "wrong-task", kind: "task", title: tasks[0].title, parentId: "other" }] } } };
  const misplaced = plan.reconcileWorkPlan(items, [taskReceipt]);
  assert.equal(misplaced[1].record.id, "wrong-task");
  assert.equal(plan.workPlanStatus(misplaced[1], misplaced), "needs_placement");
  assert.match(plan.taskPlanGuard(misplaced, "create_tasks", { titles: [tasks[0].title], due_date: day, parent_id: "green-project" }), /already has a successful/);
  assert.throws(() => plan.updateWorkPlan([], [{ key: "a", title: "a", kind: "project", depends_on: "b" }, { key: "b", title: "b", kind: "project", depends_on: "a" }]), /Only a Task|cycle/);
  assert.throws(() => plan.updateWorkPlan([], [{ key: "p", title: "제품", kind: "project" }, { key: "t", title: "구현", kind: "task", parent_title: "제품" }]), /must include depends_on/);
  assert.throws(() => plan.updateWorkPlan([], [{ key: "i", title: "AX 세일즈", kind: "ticket" }, { key: "p", title: "AX", kind: "project", depends_on: "i" }]), /never a fabricated Ticket/);
  assert.equal(continuity.isThreadStatusQuestion("아직 생성 안된 업무 확인하고 생성해줘"), false);
});

test("다 반영하라고 is an execution continuation: reuse misplaced legacy Tasks and relink them after their separate Projects are approved", async (t) => {
  const f = await fixture(t);
  const parentId = `project-${projects[0].title}`;
  const existingTasks = tasks.map((item, i) => ({ id: `existing-${i}`, kind: "task", title: item.title, parentId, dueDate: day, status: i === 1 ? "done" : "todo", assigneeMemberId: "member" }));
  f.readItems.push({ id: parentId, kind: "project", title: projects[0].title }, ...structuredClone(existingTasks));
  f.session = { version: 1, turns: [
    { name: "manage_project", arguments: { action: "confirm" }, at: new Date(Date.now() - 20_000).toISOString(), result: { structuredContent: { review: { title: projects[0].title, state: "created", projectId: parentId } } } },
    { name: "create_tasks", arguments: { titles: tasks.map((item) => item.title), parent_id: parentId }, at: new Date(Date.now() - 10_000).toISOString(), result: { structuredContent: { items: existingTasks } } },
  ], updatedAt: new Date().toISOString(), answer: "세 업무를 같은 프로젝트 아래 만들었습니다." };
  f.messages.push({ user: "user", text: "그린서비스 유료전환, 렌즈 AX, 샘플푸드 재무 자동화 프로젝트 각각 생성해주고 각자 업무를 넣어줘. 기존 도입 확장 관리 밑에는 넣지 말아줘.", ts: String(Date.now() / 1000 - 30) });
  await f.run("왜 자꾸 처리를 안하고 보고만 하는거야. 다 반영하라고 뭐하는거야", [
    (body) => { assert.equal(body.tool_choice.name, "plan_work"); return response(call("plan_work", { items: requested })); },
    (body) => { const items = JSON.parse(body.input[0].output).structuredContent.workPlan;
      assert.equal(items.filter((item) => item.kind === "task" && item.record).length, 3);
      return response(...projects.slice(1).map((item) => call("manage_project", { action: "propose", title: item.title })),
        call("create_tasks", { titles: [tasks[1].title], parent_id: parentId, due_date: day }),
        call("link_item", { id: "existing-1", parent_id: parentId })); },
    (body) => { assert.match(body.input[2].output, /already has a successful/); assert.match(body.input[3].output, /parent is not saved/); return prose("남은 두 프로젝트 생성안을 승인해 주세요. 기존 업무는 중복 생성하지 않고 옮깁니다."); },
  ]);
  assert.equal(f.writes.length, 0);
  assert.equal(f.session.workPlan.filter((item) => plan.workPlanStatus(item, f.session.workPlan) === "needs_placement").length, 2);
  await f.run("진행해", [
    prose("프로젝트 두 개를 생성했습니다."),
    (body) => { assert.equal(body.tool_choice, "required"); return response(...tasks.slice(1).map((item, i) => call("link_item", { id: `existing-${i + 1}`, parent_id: `project-${item.parent_title}` }))); },
    prose("기존 업무 두 개를 각 프로젝트로 옮겼습니다."),
  ]);
  assert.equal(f.writes.filter((row) => row.kind === "task").length, 0);
  assert.equal(f.writes.filter((row) => row.operation === "link").length, 2);
  assert.ok(f.session.workPlan.every((item) => plan.workPlanStatus(item, f.session.workPlan) === "saved"));
  assert.equal(f.readItems.find((item) => item.id === "existing-1").status, "done");
  assert.equal(f.readItems.find((item) => item.id === "existing-1").assigneeMemberId, "member");
});

test("an explicit tool-backed existing_id can reuse a spelling variant, but an invented ID or ambiguous title never resolves a Task", () => {
  const items = plan.updateWorkPlan([], [{ ...requested[0] }, { ...requested[1], title: "그린 서비스 시트 연동", existing_id: "known-task" }]);
  const receipt = { name: "search_work", arguments: {}, result: { structuredContent: { items: [{ id: "known-task", kind: "task", title: "그린서비스 시트연동", parentId: "wrong" }] } } };
  const resolved = plan.reconcileWorkPlan(items, [receipt]);
  assert.equal(resolved[1].record.id, "known-task");
  const changedReference = plan.updateWorkPlan(resolved, [{ ...requested[1], title: "그린 서비스 시트 연동", existing_id: "invented" }]);
  assert.equal(changedReference[1].record, undefined, "changing a selected ID requires fresh read evidence");
  const unknown = plan.updateWorkPlan([], [{ ...requested[0] }, { ...requested[1], existing_id: "invented" }]);
  assert.equal(plan.reconcileWorkPlan(unknown, [receipt])[1].record, undefined);
  assert.match(plan.taskPlanGuard(unknown, "create_tasks", { titles: [tasks[0].title], due_date: day }), /verify/);
  const ambiguous = { name: "list_items", arguments: {}, result: { structuredContent: { items: [
    { id: "a", kind: "task", title: tasks[0].title, parentId: "one" }, { id: "b", kind: "task", title: tasks[0].title, parentId: "two" },
  ] } } };
  assert.equal(plan.reconcileWorkPlan(plan.updateWorkPlan([], requested), [ambiguous])[1].record, undefined);
  const routineOnly = { name: "list_routines", arguments: {}, result: { structuredContent: { routines: [{ id: "routine", title: tasks[0].title }] } } };
  assert.equal(plan.reconcileWorkPlan(plan.updateWorkPlan([], requested), [routineOnly])[1].record, undefined);
});

test("workspace search finds older, normalized, misspelled and contextual candidates without crossing owners or archived/closed OKRs", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,owner_id TEXT,kind TEXT,title TEXT,description TEXT DEFAULT '',parent_id TEXT,routine_id TEXT,due_date TEXT,cycle_id TEXT,archived_at TEXT,status TEXT DEFAULT 'todo');
      CREATE TABLE okr_cycles(id TEXT,owner_id TEXT,status TEXT);
      CREATE TABLE routines(id TEXT,owner_id TEXT,title TEXT,description TEXT,active INTEGER,system_key TEXT);
      INSERT INTO okr_cycles VALUES('active','w','active'),('old','w','closed');`);
    const add = sqlite.prepare("INSERT INTO items(id,owner_id,kind,title,description,parent_id,cycle_id,archived_at) VALUES(?,?,?,?,?,?,?,?)");
    add.run("o", "w", "objective", "목표", "", null, "active", null);
    add.run("kr", "w", "key_result", "외부 AX 매출", "", "o", "active", null);
    add.run("i", "w", "initiative", "기존 고객사 AX 세일즈", "재무 자동화 제안", "kr", "active", null);
    add.run("p", "w", "project", "샘플 푸드 재무자동화", "고객 재무 보고서", "i", "active", null);
    add.run("t", "w", "task", "샘플 푸드 제안서 보내기", "고객 재무 보고서", "p", "active", null);
    add.run("old", "w", "project", "샘플 푸드 종료", "", null, "old", null);
    add.run("archived", "w", "project", "샘플 푸드 삭제", "", null, null, "yesterday");
    add.run("foreign", "other", "project", "샘플 푸드 비밀", "", null, null, null);
    add.run("broken", "w", "initiative", "재무 자동화 잘못된 계층", "", "o", "active", null);
    sqlite.exec("INSERT INTO routines VALUES('r','w','샘플 푸드 지원','',1,NULL),('general','w','General','',1,'general')");
    const db = d1Fixture(sqlite); db.batch = (statements) => Promise.all(statements.map((statement) => statement.all()));
    const exact = await search.searchSlackWork(db, "w", { query: "샘플푸드 재무 자동화", kind: "project" });
    assert.deepEqual(exact.items.map((row) => row.id), ["p"]);
    assert.equal(exact.items[0].match, "exact");
    assert.deepEqual(exact.items[0].path, ["목표", "외부 AX 매출", "기존 고객사 AX 세일즈", "샘플 푸드 재무자동화"]);
    const typo = await search.searchSlackWork(db, "w", { query: "샘풀푸드재무자동화", kind: "project" });
    assert.equal(typo.items[0].id, "p"); assert.equal(typo.items[0].match, "candidate");
    const initiative = await search.searchSlackWork(db, "w", { query: "재무 자동화", kind: "initiative" });
    assert.deepEqual(initiative.items.map((row) => row.id), ["i"]);
    const task = await search.searchSlackWork(db, "w", { query: "샘플푸드제안서보내기", kind: "task" });
    assert.equal(task.items[0].parentId, "p");
    assert.deepEqual(task.items[0].path, ["목표", "외부 AX 매출", "기존 고객사 AX 세일즈", "샘플 푸드 재무자동화", "샘플 푸드 제안서 보내기"]);
    assert.equal(exact.truncated, false);
    assert.match(exact.instruction, /not automatic placement/);
  } finally { sqlite.close(); }
});
