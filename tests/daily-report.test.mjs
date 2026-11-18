import test from "node:test";import assert from "node:assert/strict";
import {fixture,model,reports,now,channel} from "./helpers/daily-report-fixture.mjs";
test("all three timing choices and safe custom conditions remain distinct",()=>{
  const facts={weekday:3,time:"11:00",all_submitted:true,manual:false,task_count:2};
  assert.equal(model.reportConditionMatches(model.defaultReportCondition("at_time","12:00",[1,2,3,4,5]),facts),false);
  assert.equal(model.reportConditionMatches(model.defaultReportCondition("all_or_deadline","12:00",[1,2,3,4,5]),facts),true);
  assert.equal(model.reportConditionMatches(model.defaultReportCondition("manual","12:00",[1,2,3,4,5]),facts),false);
  assert.equal(model.reportConditionMatches(model.parseReportCondition({all:[{field:"task_count",operator:"gte",value:2},{not:{field:"all_submitted",operator:"eq",value:false}}]}),facts),true);
  assert.throws(()=>model.parseReportCondition({eval:"process.env"}));assert.throws(()=>model.parseReportCondition({field:"secret",operator:"eq",value:true}));
});
test("reading preferences is side-effect free and defaults to the existing report time and invoking member",async t=>{
  const f=fixture(t),state=await reports.readReportPreferences(f.db,"w","u");assert.equal(state.policy.trigger,"at_time");assert.equal(state.policy.reportTime,"12:00");assert.equal(state.policy.approverMemberId,"m1");
  assert.equal(state.approvalRequired,true);assert.equal(f.sql.prepare("SELECT count(*) n FROM daily_report_policies").get().n,0);assert.equal(f.sql.prepare("SELECT count(*) n FROM slack_bot_deliveries").get().n,0);
  assert.equal((await reports.readReportPreferences(f.db,"w","unknown")).currentMemberId,null);
});
test("saved prose/conditions persist, unchanged saves do not invalidate reviews and stale revisions fail",async t=>{
  const f=fixture(t);const first=await f.save({instructions:"보고는 Project 아래 Task와 담당자. 차질은 마지막에."});
  const next=await f.save({instructions:first.policy.instructions});assert.equal(next.policy.version,first.policy.version);assert.equal(next.policy.instructions,first.policy.instructions);
  await assert.rejects(reports.saveReportPreferences(f.db,"w","u",next.policy,0,[channel],now),{code:"report_policy_conflict"});
  await assert.rejects(f.save({approverMemberId:"foreign"}),{code:"report_approver_slack_required"});
});
test("report groups Project→Task, deduplicates shared tasks and prints actual assignees next to Tasks",async t=>{
  const f=fixture(t);await f.save();const {facts}=await reports.getReportContext(f.db,"w","u",undefined,now);
  assert.equal(facts.groups.length,1);assert.equal(facts.groups[0].title,"Project A");assert.equal(facts.taskCount,2);assert.deepEqual(facts.groups[0].tasks.find(t=>t.id==="task1").assignees,["Member"]);
  const pages=reports.defaultReportPages(facts).join("\n");assert.match(pages,/Project · Project A/);assert.match(pages,/Task one · 담당: Member/);assert.doesNotMatch(pages,/팀원별/);
  assert.equal(facts.groups[0].tasks.find(t=>t.id==="task1").status,"must_do");
});
test("deleted Tasks keep the recorded title without counting the same snapshot twice",async t=>{
  const f=fixture(t);await f.save();f.sql.exec("DELETE FROM items WHERE id='task1'");const context=await reports.getReportContext(f.db,"w","u",undefined,now);
  assert.equal(context.facts.taskCount,2);assert.equal(context.facts.groups[0].tasks.filter(t=>t.title==="Task one").length,1);
});
test("drafts accept flexible pages, repeat safely and never publish without a reviewed DM",async t=>{
  const f=fixture(t);await f.save();const first=await f.draft(["오늘 보고","*Project A*\n• Task one · Member"]),same=await f.draft(first.pages);assert.equal(same.id,first.id);
  assert.equal(first.status,"draft");assert.equal(f.sql.prepare("SELECT count(*) n FROM slack_bot_deliveries").get().n,0);
  assert.throws(()=>f.sql.prepare("UPDATE daily_report_drafts SET status='approved' WHERE id=?").run(first.id),/approval identity required/);
  assert.throws(()=>model.reportPages(["<!channel> report"]));
});
test("only the configured member in the exact verified DM can approve; retry is idempotent",async t=>{
  const f=fixture(t),input=await f.review();
  for(const patch of [{slackUserId:"U2"},{teamId:"OTHER"},{channelId:"C1"},{messageTs:"wrong"}])await assert.rejects(reports.approveReportFromSlack(f.db,{...input,...patch},now),{code:"daily_report_approver_required"});
  const approved=await reports.approveReportFromSlack(f.db,input,now);assert.equal(approved.draft.status,"approved");assert.equal((await reports.approveReportFromSlack(f.db,input,now)).duplicate,true);
  assert.throws(()=>f.sql.prepare("UPDATE daily_report_drafts SET pages_json='[\"changed\"]' WHERE id=?").run(input.draftId),/snapshot is immutable/);
});
test("new source data and changed policies invalidate old approvals; rejected feedback is retained",async t=>{
  const f=fixture(t),input=await f.review();f.sql.exec("UPDATE daily_submissions SET blockers_note='New blocker' WHERE id='s1'");
  await assert.rejects(reports.approveReportFromSlack(f.db,input,now),{code:"daily_report_source_changed"});assert.equal((await reports.getReportDraft(f.db,"w",input.draftId)).status,"superseded");
  const next=await f.draft();assert.equal(next.revision,2);await f.save({instructions:"차질 우선"});assert.equal((await reports.getReportDraft(f.db,"w",next.id)).status,"superseded");
});
test("turning report threads off does not resume legacy unapproved posting",async t=>{
  const f=fixture(t);await f.save({enabled:false});
  f.seed("slack_bot_deliveries",{id:"legacy",owner_id:"w",bot_kind:"daily_digest",subject_id:"C1",event_key:"legacy",connection_key:"[]",policy:"{}",payload:"{}",retry_at:now.toISOString(),expires_at:"2026-11-19",created_at:now.toISOString(),updated_at:now.toISOString()});
  assert.throws(()=>f.sql.exec("UPDATE slack_bot_deliveries SET status='sending' WHERE id='legacy'"),/approval required/);
  await assert.rejects(f.draft(),{code:"daily_reports_disabled"});
});
