import test from "node:test";import assert from "node:assert/strict";
import {fixture,compile,read,model,reports,now,channel} from "./helpers/daily-report-fixture.mjs";
const botSource=await read("lib/slack-bot-delivery.ts"),adapterSource=await read("lib/daily-report-slack.ts");
class SlackMessageError extends Error {constructor(message,outcome,retryAfterSeconds=0,code=""){super(message);Object.assign(this,{outcome,retryAfterSeconds,code});}}
function delivery(t) {
  const f=fixture(t),posts=[],channels=[channel];let failNext=false;
  const post=async(_token,destination,text,options={})=>{
    if(failNext){failNext=false;throw new SlackMessageError("outcome unknown","uncertain");}
    const timestamp=options.messageTs??`${1000+posts.length}.1`;posts.push({channel:destination,text,options,timestamp});return {timestamp};
  };
  const bot=compile(botSource,{"cloudflare:workers":{env:{SLACK_TOKEN_ENCRYPTION_KEY:"test"}},"@/lib/slack-oauth":{decryptSlackSecret:async()=>"token"},"@/lib/slack-automation":{postSlackMessage:post,postSlackEphemeral:async()=>{},SlackMessageError},"./daily-report":reports});
  const adapter=compile(adapterSource,{"cloudflare:workers":{env:{DB:f.db}},"./pace-data":{getSlackConnection:async()=>({encryptedBotToken:"cipher"})},"./slack-daily":{listSlackChannels:async()=>channels,slackTokenForConnection:async()=>"token",slackApi:async(_token,method)=>{assert.equal(method,"conversations.open");return {ok:true,channel:{id:"D1"}};}},"./slack-bot-delivery":bot,"./slack-automation":{postSlackMessage:post},"./daily-report":reports,"./daily-report-model":model});
  return {...f,bot,adapter,posts,channels,fail:()=>{failNext=true;}};
}
test("a complete preview is delivered to the configured DM, then approved content forms one Project/Task channel thread",async t=>{
  const f=delivery(t);await f.save();const draft=await f.draft();
  const review=await f.adapter.requestReportReview(f.db,"w",draft.id,draft.revision,now);assert.equal(review.status,"awaiting_approval");assert.ok(f.posts.every(p=>p.channel==="D1"));
  const root=f.posts[0].timestamp;assert.ok(f.posts.slice(1).every(p=>p.options.threadTs===root));
  const action=f.posts.at(-1);assert.equal(action.options.blocks.at(-1).elements[0].action_id,"daily_report_approve");
  assert.equal(f.posts.some(p=>p.channel==="C1"),false);
  const sent=await f.adapter.handleReportSlackAction(f.db,{value:JSON.stringify({id:draft.id,revision:draft.revision}),teamId:"T1",slackUserId:"U1",channelId:"D1",messageTs:review.reviewActionTs,action:"daily_report_approve"},now);
  assert.equal(sent.status,"sent");const channelPosts=f.posts.filter(p=>p.channel==="C1");assert.equal(channelPosts.length,draft.pages.length);assert.deepEqual(channelPosts.map(p=>p.text),draft.pages);
  assert.equal(channelPosts[0].options.threadTs,undefined);assert.ok(channelPosts.slice(1).every(p=>p.options.threadTs===channelPosts[0].timestamp));
  assert.doesNotMatch(channelPosts.map(p=>p.text).join("\n"),/Sent using ChatGPT|다음을 사용하여 보냄/);
  const count=f.posts.filter(p=>p.channel==="C1").length;await f.adapter.publishApprovedReport(f.db,"w",draft.id,now);assert.equal(f.posts.filter(p=>p.channel==="C1").length,count);
});
test("approval is unavailable until every preview page is confirmed and an unknown send never retries blindly",async t=>{
  const f=delivery(t);await f.save();const draft=await f.draft();f.fail();const result=await f.adapter.requestReportReview(f.db,"w",draft.id,draft.revision,now);
  assert.equal(result.status,"uncertain");assert.equal(f.posts.length,0);await f.bot.runDueSlackBotDeliveries(f.db,new Date(now.getTime()+180000),"w");assert.equal(f.posts.length,0);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM slack_bot_deliveries WHERE status IN ('pending','retry')").get().n,0);
});
test("changing a destination after review cannot publish using the old approval",async t=>{
  const f=delivery(t);await f.save();const draft=await f.draft(),review=await f.adapter.requestReportReview(f.db,"w",draft.id,draft.revision,now);f.channels[0]={...channel,isExternal:true,isShared:true};
  await assert.rejects(f.adapter.handleReportSlackAction(f.db,{value:JSON.stringify({id:draft.id,revision:draft.revision}),teamId:"T1",slackUserId:"U1",channelId:"D1",messageTs:review.reviewActionTs,action:"daily_report_approve"},now),{code:"daily_report_channel_changed"});assert.equal(f.posts.some(p=>p.channel==="C1"),false);
});
test("a forged actor or team cannot trigger review actions or channel delivery",async t=>{
  const f=delivery(t);await f.save();const draft=await f.draft(),review=await f.adapter.requestReportReview(f.db,"w",draft.id,draft.revision,now),before=f.posts.length;
  await assert.rejects(f.adapter.handleReportSlackAction(f.db,{value:JSON.stringify({id:draft.id,revision:draft.revision}),teamId:"T1",slackUserId:"U2",channelId:"D1",messageTs:review.reviewActionTs,action:"daily_report_approve"},now),{code:"daily_report_approver_required"});assert.equal(f.posts.length,before);
});
test("deadline, all-submitted and manual conditions control automatic DM requests without duplicates",async t=>{
  const f=delivery(t);await f.save();await f.adapter.runDueDailyReports(f.db,new Date("2026-11-18T02:00:00Z"));assert.equal(f.posts.length,0);
  await f.adapter.runDueDailyReports(f.db,now);assert.equal(f.posts.length,0);await f.bot.runDueSlackBotDeliveries(f.db,now,"w");const count=f.posts.length;assert.ok(count>0);assert.ok(f.posts.every(p=>p.channel==="D1"));await f.adapter.runDueDailyReports(f.db,now);assert.equal(f.posts.length,count);
  await f.save({trigger:"manual"});await f.adapter.runDueDailyReports(f.db,new Date("2026-11-19T06:00:00Z"));assert.equal(f.posts.length,count);
});
test("every destination is accounted for and a revised approved report reuses that day's channel root",async t=>{
  const f=delivery(t),second={...channel,id:"C2",name:"second"};f.channels.push(second);const prefs=await reports.readReportPreferences(f.db,"w","u");
  await reports.saveReportPreferences(f.db,"w","u",{...prefs.policy,enabled:true,channelIds:["C1","C2"]},0,f.channels,now);
  async function round(pages){const context=await reports.getReportContext(f.db,"w","u",undefined,now),draft=await reports.createReportDraft(f.db,"w","u",{sourceHash:context.facts.sourceHash,policyVersion:context.preferences.policy.version,pages},f.channels,now),review=await f.adapter.requestReportReview(f.db,"w",draft.id,draft.revision,now);return f.adapter.handleReportSlackAction(f.db,{value:JSON.stringify({id:draft.id,revision:draft.revision}),teamId:"T1",slackUserId:"U1",channelId:"D1",messageTs:review.reviewActionTs,action:"daily_report_approve"},now);}
  const first=await round(["Project A","Task one · Member"]);assert.equal(first.status,"sent");const roots=Object.fromEntries(["C1","C2"].map(id=>[id,f.posts.find(p=>p.channel===id).timestamp]));
  const before=f.posts.length;const revised=await round(["Project A · revised","Task one · Member"]);assert.equal(revised.status,"sent");for(const id of ["C1","C2"]){const sent=f.posts.slice(before).filter(p=>p.channel===id);assert.equal(sent.length,2);assert.equal(sent[0].options.messageTs,roots[id]);assert.ok(sent.slice(1).every(p=>p.options.threadTs===roots[id]));}
  assert.throws(()=>f.sql.prepare("UPDATE daily_report_drafts SET pages_json='[\"tampered\"]' WHERE id=?").run(revised.id),/immutable/);
});
test("revoking the approver after the DM prevents channel publication",async t=>{
 const f=delivery(t);await f.save();const draft=await f.draft(),review=await f.adapter.requestReportReview(f.db,"w",draft.id,draft.revision,now);f.sql.exec("UPDATE workspace_members SET status='removed' WHERE id='m1'");
 await assert.rejects(f.adapter.handleReportSlackAction(f.db,{value:JSON.stringify({id:draft.id,revision:draft.revision}),teamId:"T1",slackUserId:"U1",channelId:"D1",messageTs:review.reviewActionTs,action:"daily_report_approve"},now),{code:"daily_report_approver_required"});assert.equal(f.posts.some(p=>p.channel==="C1"),false);
});
test("the leader can reject a draft without publishing; the next author reads retained feedback",async t=>{
 const f=delivery(t);await f.save();const draft=await f.draft(),review=await f.adapter.requestReportReview(f.db,"w",draft.id,draft.revision,now);
 const rejected=await f.adapter.handleReportSlackAction(f.db,{value:JSON.stringify({id:draft.id,revision:draft.revision}),teamId:"T1",slackUserId:"U1",channelId:"D1",messageTs:review.reviewActionTs,action:"daily_report_reject"},now);assert.equal(rejected.status,"rejected");assert.equal(f.posts.some(p=>p.channel==="C1"),false);const context=await reports.getReportContext(f.db,"w","u",undefined,now);assert.match(context.latest.feedback,/수정 요청/);
});
