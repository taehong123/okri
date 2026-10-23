import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { compileLanguageModule as compile } from "./helpers/language-fixture.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const daily = ts.createSourceFile("daily.ts", await read("lib/slack-daily.ts"), ts.ScriptTarget.Latest, true);
const transportSource = daily.statements.filter((node) => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
  && ["slackApi", "slackApiError", "SlackRequestError"].includes(node.name?.text)).map((node) => node.getText(daily)).join("\n");
const { slackApi } = compile(transportSource);
const parser = compile(await read("lib/slack-work-command-parser.ts"));
const intakeSource = await read("lib/slack-work-intake.ts");
const ticketSource = await read("lib/slack-ticket-intake.ts");
const recommendation=compile(await read("lib/ticket-recommendation.ts"));

function fixture(t, options = {}) {
  const requests = [], metering = [],budgetCalls=[];
  const runtime = { DB: {}, OPENAI_API_KEY: "mock-key", ...options.env };
  const usage = { requestsToday: 0, requestsThisMinute: 0, workspaceRequestsToday: 0, workspaceRequestsThisMinute: 0, ...options.usage };
  const data = {
    getAiUsageSummary: async () => usage,
    reserveAiUsageEvent: async (value) => { metering.push({ type: "reserve", value }); return options.noReservation ? null : "reservation"; },
    finalizeAiUsageEvent: async (_id, value) => metering.push({ type: "finalize", value }),
    releaseAiUsageReservation: async () => metering.push({ type: "release" }),
  };
  const billing = { assertAiBudget: async (...args) => {budgetCalls.push(args);if(options.budgetFailure)throw Object.assign(Error('budget'),{code:'ai_budget_exceeded'});return { limitWon: 500, spentWonMicros: 0 };}, BillingLimitError: class extends Error {} };
  const language = { readLanguagePreferences: async () => ({ resolvedLanguage: "ko" }) };
  const intake = compile(intakeSource, { "cloudflare:workers": { env: runtime }, "@/lib/billing": billing,
    "@/lib/language-preferences": language, "@/lib/pace-data": data, "@/lib/slack-daily": { slackApi },
    "@/lib/work-intake": {}, "@/lib/slack-mcp-context": {} });
  const ticket = compile(ticketSource, { "@/lib/ticket-recommendation":recommendation, "cloudflare:workers": { env: runtime }, "@/lib/billing": billing,
    "@/lib/language-preferences": language, "@/lib/pace-data": data, "@/lib/slack-work-command-parser": parser,
    "@/lib/slack-work-intake": intake });
  const original = globalThis.fetch;
  globalThis.fetch = async (raw, init) => {
    const url = new URL(raw);
    if (url.origin === "https://slack.com") {
      const method = url.pathname.split("/").at(-1);
      const readMethod = !["chat.postMessage", "views.open"].includes(method);
      assert.equal(init.method, readMethod ? "GET" : "POST");
      assert.equal(init.headers.Authorization, "Bearer mock-token");
      assert.ok(init.signal);
      if (readMethod) assert.equal(init.body, undefined, "Slack GET arguments must not be hidden in a JSON body");
      const body = readMethod ? Object.fromEntries(url.searchParams) : JSON.parse(init.body);
      requests.push({ method, body });
      if (method !== "conversations.replies") return Response.json({ ok: true });
      const index = body.cursor ? Number(body.cursor.slice(1)) : 0;
      if (options.failPage === index) return Response.json({ ok: false, error: "ratelimited" });
      const pages = options.pages ?? [
        [{ ts: "1.0", user: "UOTHER", text: "CRM 시험 서버 이관 요청\n시험 DB와 운영 전환 권한을 분리해 주세요." }],
        [{ ts: "2.0", user: "UOTHER", text: "최신 결정: 시험 DB만 먼저 준비. 운영 전환은 승인 전 금지." }],
        [{ ts: "3.0", user: "U1", text: "!티켓생성" }, { ts: "3.1", user: "UBOT", text: "Ticket 생성 양식 열기" }],
      ];
      return Response.json({ ok: true, messages: pages[index] ?? [], response_metadata: { next_cursor: index + 1 < pages.length ? `p${index + 1}` : "" } });
    }
    assert.equal(url.href, "https://api.openai.com/v1/responses");
    requests.push({ method: "model", body: JSON.parse(init.body) });
    if (options.modelFailure) throw new Error("offline");
    return Response.json({ output_text: options.modelOutput ?? JSON.stringify({ title: "CRM 시험 DB 이관 준비", description: "## 요청\n시험 DB와 제한된 이관 권한을 준비합니다.\n## 미확정\n운영 전환은 승인 후 별도 진행합니다." }), usage: { input_tokens: 123, output_tokens: 45 } });
  };
  t.after(() => { globalThis.fetch = original; });
  const input = { authorization: { ownerId: "ws", userId: "user", role: "member" }, token: "mock-token", botUserId: "UBOT",
    event: { channel: "C1", channelType: "channel", user: "U1", text: "!티켓생성", ts: "3.0", threadTs: "1.0" }, query: "" };
  return { ...ticket, intake, requests, metering,budgetCalls, input };
}

test('automation can summarize already-validated evidence without fetching the raw thread again',async t=>{
  const f=fixture(t);await f.prepareSlackTicketForm({...f.input,textOnly:true,evidenceMessages:[{user:'U1',text:'Reviewed request with metadata removed.'}]});
  assert.equal(f.requests.filter(r=>r.method==='conversations.replies').length,0);const payload=f.requests.find(r=>r.method==='model').body;assert.deepEqual(JSON.parse(payload.input[1].content).messages,[{user:'U1',text:'Reviewed request with metadata removed.'}]);
});

test('daily exhaustion returns its cause and reset without reserving or sending a model request',async t=>{
  const f=fixture(t,{usage:{requestsToday:80}}),result=await f.prepareSlackTicketForm({...f.input,evidenceMessages:[{user:'U1',text:'New customer issue'}],recommendation:{temporaryAllowance:{extra:40,expiresAt:new Date(new Date().setUTCHours(24,0,0,0)).toISOString()}}});
  assert.equal(result.analysisFailure.code,'ai_daily_limit_reached');assert.equal(result.analysisFailure.retryAt,new Date(new Date().setUTCHours(24,0,0,0)).toISOString());assert.equal(f.requests.length,0);assert.equal(f.metering.length,0);
});

test('deployment-only test exemption is exact-account and ticket-only, retains metering and minute limits',async t=>{
  const allow=JSON.stringify([{workspaceId:'ws',userId:'user'}]),recommendation={model:'gpt-6.1-sol',knownRequests:[],sourceRoots:['1.0']},modelOutput=JSON.stringify({actionable:false,recommendations:[],existingRequestIds:[],updates:[],noWorkReason:'No new work.'});
  await t.test('authorized account continues beyond daily and billing limits with auditable test usage',async child=>{
    const f=fixture(child,{env:{OKRI_TICKET_AI_TEST_ACCOUNTS:allow},usage:{requestsToday:1000,workspaceRequestsToday:1000},budgetFailure:true,modelOutput});
    const result=await f.prepareSlackTicketForm({...f.input,recommendation});assert.equal(result.analysisModel,'gpt-6.1-sol');assert.equal(f.budgetCalls.length,0);assert.equal(f.metering[0].value.source,'slack_ticket_test');assert.equal(f.metering[1].value.source,'slack_ticket_test');assert.equal(f.metering[1].value.inputTokens,123);assert.equal(f.metering[0].value.limits.userMinute,5);assert.equal(f.metering[0].value.limits.workspaceMinute,12);assert.equal(f.metering[0].value.limits.userDay,Number.MAX_SAFE_INTEGER);
  });
  for(const policy of [JSON.stringify([{workspaceId:'other',userId:'user'}]),JSON.stringify([{workspaceId:'ws',userId:'other'}]),'true','invalid'])await t.test(`no privilege from ${policy}`,async child=>{
    const f=fixture(child,{env:{OKRI_TICKET_AI_TEST_ACCOUNTS:policy},budgetFailure:true});const result=await f.prepareSlackTicketForm({...f.input,recommendation});assert.equal(result.analysisFailure.code,'ai_budget_exceeded');assert.equal(f.budgetCalls.length,1);assert.equal(f.requests.some(r=>r.method==='model'),false);
  });
  await t.test('manual forms and minute bursts do not inherit unlimited privileges',async child=>{
    const f=fixture(child,{env:{OKRI_TICKET_AI_TEST_ACCOUNTS:allow},usage:{requestsThisMinute:5},budgetFailure:true});assert.equal((await f.prepareSlackTicketForm(f.input)).analysisFailure.code,'ai_budget_exceeded');assert.equal((await f.prepareSlackTicketForm({...f.input,recommendation})).analysisFailure.code,'ai_rate_limited');assert.equal(f.requests.some(r=>r.method==='model'),false);
  });
});

test('optional automation classification distinguishes acknowledgement from work without changing manual forms',async t=>{
  const f=fixture(t,{modelOutput:JSON.stringify({title:'',description:'',actionable:false})});
  const result=await f.prepareSlackTicketForm({...f.input,classifyRequest:true,evidenceMessages:[{user:'U1',text:'수고해 주세요. 감사합니다.'}]});assert.equal(result.actionable,false);assert.equal(result.title,'');
  const payload=f.requests.find(r=>r.method==='model').body;assert.ok(payload.text.format.schema.required.includes('actionable'));assert.equal(f.metering.filter(r=>r.type==='finalize').length,1);
});

test("real Slack wire contract sends read arguments in GET queries and keeps writes as JSON without retries", async (t) => {
  const f = fixture(t);
  await slackApi("mock-token", "conversations.info", { channel: "C1", include_locale: false, cursor: undefined });
  await slackApi("mock-token", "users.info", { user: "U1" });
  await slackApi("mock-token", "chat.postMessage", { channel: "C1", text: "Mock only", blocks: [] });
  assert.deepEqual(f.requests.map((entry) => entry.body), [{ channel: "C1", include_locale: "false" }, { user: "U1" }, { channel: "C1", text: "Mock only", blocks: [] }]);
});

test("bare Ticket command reads every thread page including the latest correction before one metered summary", async (t) => {
  const f = fixture(t);
  const form = await f.prepareSlackTicketForm(f.input);
  assert.equal(form.title, "CRM 시험 DB 이관 준비");
  assert.equal(form.messageCount, 2);
  assert.match(form.description, /운영 전환은 승인 후/);
  assert.match(form.description, /https:\/\/slack.com\/archives\/C1\/p10$/);
  const reads = f.requests.filter((entry) => entry.method === "conversations.replies");
  assert.deepEqual(reads.map((entry) => entry.body.cursor), [undefined, "p1", "p2"]);
  assert.ok(reads.every((entry) => entry.body.ts === "1.0" && entry.body.channel === "C1" && entry.body.limit === "15"));
  const model = f.requests.find((entry) => entry.method === "model").body;
  assert.equal(model.text.format.type, "json_schema");
  const payload = JSON.parse(model.input[1].content);
  assert.equal(payload.messages.length, 2);
  assert.match(payload.messages[1].text, /최신 결정/);
  assert.doesNotMatch(JSON.stringify(payload), /Ticket 생성 양식 열기|!티켓생성/);
  assert.deepEqual(f.metering.map((entry) => entry.type), ["reserve", "finalize"]);
  assert.equal(f.metering[1].value.inputTokens, 123);
});

test("partial, failed and oversized full-thread reads cannot create a partial summary", async (t) => {
  for (const options of [{ failPage: 1 }, { pages: [[{ ts: "1.0", user: "UOTHER", text: "가".repeat(100_001) }]] },
    { pages: Array.from({ length: 41 }, (_, i) => [{ ts: `${i}.0`, user: "UOTHER", text: `Message ${i}` }]) }]) {
    await t.test(JSON.stringify(Object.keys(options)), async (child) => {
      const f = fixture(child, options);
      await assert.rejects(f.prepareSlackTicketForm(f.input));
      assert.equal(f.requests.some((entry) => entry.method === "model"), false);
      assert.equal(f.metering.length, 0);
    });
  }
});

test("full-thread mode preserves line breaks and text after the old per-message 4000-character cap", async (t) => {
  const text = `최초 요청\n${"상세 내용 ".repeat(900)}\n최종 정정: 기존 범위는 취소하고 시험 환경만 준비`;
  const f = fixture(t, { pages: [[{ ts: "1.0", user: "UOTHER", text }]] });
  await f.prepareSlackTicketForm(f.input);
  const payload = JSON.parse(f.requests.find((entry) => entry.method === "model").body.input[1].content);
  assert.equal(payload.messages[0].text, text);
  assert.match(payload.messages[0].text, /최종 정정/);
});

test("company limit, reservation denial, missing key and provider errors keep editable source without unmetered AI", async (t) => {
  for (const options of [{ usage: { workspaceRequestsThisMinute: 100_000 } }, { noReservation: true }, { env: { OPENAI_API_KEY: "" } }, { modelFailure: true }]) {
    await t.test(JSON.stringify(Object.keys(options)), async (child) => {
      const f = fixture(child, options);
      const form = await f.prepareSlackTicketForm(f.input);
      assert.match(form.description, /최신 결정/);
      assert.match(form.notice, /원문/);
      assert.equal(form.messageCount, 2);
      if (options.modelFailure) assert.equal(f.metering.at(-1).type, "release");
      else assert.equal(f.requests.some((entry) => entry.method === "model"), false);
    });
  }
});

test("invalid model text is charged once and explicit titles stay under user control", async (t) => {
  const f = fixture(t, { modelOutput: "not JSON" });
  const form = await f.prepareSlackTicketForm({ ...f.input, query: "내가 지정한 제목" });
  assert.equal(form.title, "내가 지정한 제목");
  assert.match(form.notice, /원문/);
  assert.deepEqual(f.metering.map((entry) => entry.type), ["reserve", "finalize"]);
});
test('temporary ticket-only allowance expires at UTC reset and preserves atomic rate and budget reservations',async t=>{
  const f=fixture(t,{usage:{requestsToday:40}}),context={model:'gpt-6.1-sol',productSpecification:'Reviewed spec',focusMessage:'New request',knownRequests:[],temporaryAllowance:{extra:40,expiresAt:new Date(new Date().setUTCHours(24,0,0,0)).toISOString()}};
  await f.prepareSlackTicketForm({...f.input,recommendation:context});assert.equal(f.requests.filter(r=>r.method==='model').length,1);assert.equal(f.metering[0].value.limits.userDay,80);assert.equal(f.metering[0].value.limits.workspaceDay,120);
  assert.equal(JSON.parse(f.requests.find(r=>r.method==='model').body.input[1].content).context.temporaryAllowance,undefined);
  const before=f.requests.length;await f.prepareSlackTicketForm({...f.input,recommendation:{...context,temporaryAllowance:{extra:40,expiresAt:'2000-01-01T00:00:00Z'}}});assert.equal(f.requests.filter(r=>r.method==='model').length,1);assert.equal(f.requests.length,before+3,'expired extra must not cause a provider call');
});
test('cross-thread matches require known IDs, allowed roots and verbatim evidence anchors',()=>{
  const c={knownRequests:[{id:'r1'}],sourceRoots:['root1']},u={requestId:'r1',summary:'Latest fact',kind:'clarification',sourceRoots:['root1'],evidenceQuotes:['옵션 A에서 발생']};
  assert.equal(recommendation.validProblemUpdates([u],c,'옵션 A에서 발생합니다.'),true);
  for(const bad of [{...u,requestId:'foreign'},{...u,sourceRoots:['foreign']},{...u,evidenceQuotes:['모든 문제가 해결됨']}])assert.equal(recommendation.validProblemUpdates([bad],c,'옵션 A에서 발생합니다.'),false);
});

test('status-only replies can update an evidenced existing issue without authorizing a scope change',async t=>{
  const update={requestId:'r1',summary:'Customer reports the issue is resolved.',kind:'clarification',sourceRoots:['1.0'],evidenceQuotes:['해결되었습니다.']};
  const value={title:'',description:'',actionable:false,recommendations:[],existingRequestIds:['r1'],updates:[update],noWorkReason:'Resolved status update without new work.'};
  const context={model:'gpt-6.1-sol',knownRequests:[{id:'r1',title:'Known issue',description:'Prior scope'}],sourceRoots:['1.0']};
  for(const [name,changes,accepted] of [['valid',{},true],['scope change',{updates:[{...update,kind:'scope_change'}]},false],['unmatched update',{existingRequestIds:[]},false],['invented evidence',{updates:[{...update,evidenceQuotes:['No such source quote']} ]},false]])await t.test(name,async child=>{
    const f=fixture(child,{modelOutput:JSON.stringify({...value,...changes})}),result=await f.prepareSlackTicketForm({...f.input,evidenceMessages:[{user:'U1',text:'해결되었습니다.'}],recommendation:context});
    assert.equal(Boolean(result.analysisModel),accepted);if(accepted){assert.equal(result.actionable,false);assert.deepEqual(result.existingRequestIds,['r1']);assert.equal(result.updates[0].kind,'clarification');}else assert.equal(result.analysisFailure.code,'analysis_invalid_response');
  });
});

test('speaker-aware intake requires an evidenced decision for every focus and no new ticket from coordination',async t=>{
  const staff={user:'USTAFF',ts:'1.0',sourceRoot:'1.0',speakerRole:'internal',text:'메일 연동 준비를 위해 사용 중인 서비스와 담당자를 알려주세요.'};
  const customer={user:'UCUSTOMER',ts:'2.0',sourceRoot:'2.0',speakerRole:'unverified',text:'상품 저장 버튼을 누르면 오류가 발생합니다.'};
  const decision=(m,intent)=>({sourceRoot:m.sourceRoot,messageTs:m.ts,intent,reason:intent==='coordination'?'Team member collecting setup information':'New product problem',evidenceQuotes:[m.text]});
  const proposal={category:'bug_fix',title:'상품 저장 실패',problem:customer.text,solution:'저장 실패를 재현하고 수정합니다.',acceptanceCriteria:['상품 저장 성공'],questions:[],sourceRoots:['2.0']};
  const focusMetadata=m=>({user:m.user,ts:m.ts,sourceRoot:m.sourceRoot,speakerRole:m.speakerRole});
  const context={model:'gpt-6.1-sol',productSpecification:'Reviewed specification',focusMessage:staff.text,knownRequests:[],sourceRoots:['1.0','2.0'],focusMessages:[staff,customer].map(focusMetadata)};
  const value={title:'',description:'',actionable:true,recommendations:[proposal],existingRequestIds:[],updates:[],noWorkReason:'',focusDecisions:[decision(staff,'coordination'),decision(customer,'new_request')]};
  for(const [name,changes,accepted] of [
    ['mixed customer request survives staff coordination',{},true],
    ['missing decision',{focusDecisions:[decision(customer,'new_request')]},false],
    ['duplicate decision',{focusDecisions:[decision(staff,'coordination'),decision(staff,'coordination')]},false],
    ['forged quote',{focusDecisions:[{...decision(staff,'coordination'),evidenceQuotes:[customer.text]},decision(customer,'new_request')]},false],
    ['coordination cannot support a new ticket',{recommendations:[{...proposal,sourceRoots:['1.0']}]},false],
    ['customer request cannot be silently discarded',{actionable:false,recommendations:[],noWorkReason:'No work'},false],
  ])await t.test(name,async child=>{
    const f=fixture(child,{modelOutput:JSON.stringify({...value,...changes})}),result=await f.prepareSlackTicketForm({...f.input,evidenceMessages:[staff,customer],recommendation:context});
    assert.equal(Boolean(result.analysisModel),accepted);if(!accepted)assert.equal(result.analysisFailure.code,'analysis_invalid_response');
    const request=f.requests.find(r=>r.method==='model').body,payload=JSON.parse(request.input[1].content);
    assert.deepEqual(payload.context.focusMessages,context.focusMessages);assert.equal(payload.messages[0].speakerRole,'internal');assert.match(request.input[0].content,/collecting setup information/);assert.match(request.input[0].content,/Do not exclude all internal speakers/);
    assert.ok(request.text.format.schema.required.includes('focusDecisions'));
  });
  for(const [message,intent,newWork] of [[staff,'coordination',false],[{...staff,text:'개발 진행중입니다. 완료되면 말씀드릴게요!'},'support_reply',false],[{...staff,text:'제가 확인해 보니 상품 저장 시 오류가 재현됩니다.'},'new_request',true],[{...customer,text:'이 양식은 어떻게 설정하나요?'},'new_request',true]])await t.test(intent+message.text,async child=>{
    const output={...value,actionable:newWork,recommendations:newWork?[{...proposal,sourceRoots:[message.sourceRoot]}]:[],noWorkReason:newWork?'':'담당자의 안내 또는 준비 요청이며 신규 고객 요구가 아닙니다.',focusDecisions:[decision(message,intent)]};
    const f=fixture(child,{modelOutput:JSON.stringify(output)}),result=await f.prepareSlackTicketForm({...f.input,evidenceMessages:[message],recommendation:{...context,focusMessages:[focusMetadata(message)]}});
    assert.equal(result.actionable,newWork);assert.equal(result.analysisModel,'gpt-6.1-sol');assert.equal(result.focusDecisions[0].intent,intent);
  });
});
