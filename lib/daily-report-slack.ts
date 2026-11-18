import {env} from "cloudflare:workers";
import {getSlackConnection} from "./pace-data";
import {listSlackChannels,slackApi,slackTokenForConnection} from "./slack-daily";
import {deliverSlackBotMessages} from "./slack-bot-delivery";
import {postSlackMessage} from "./slack-automation";
import {approveReportFromSlack,createReportDraft,getReportContext,getReportDraft,loadReportFacts,readReportPreferences,reportConnection,type DailyReportDraft,type ReportChannel} from "./daily-report";
import {DailyReportError,escapeReportText,parseReportPolicy,reportClock,reportConditionMatches} from "./daily-report-model";
type Row=Record<string,string|number|null>;
const section=(text:string)=>({type:"section",text:{type:"mrkdwn",text}});
export async function reportChannels(ownerId:string,ids:string[]):Promise<ReportChannel[]> {
  const all=await listSlackChannels(ownerId);
  const channels=ids.map(id=>all.find(c=>c.id===id&&c.isMember));
  if(channels.some(c=>!c))throw new DailyReportError("report_channel_unavailable",409);
  return channels.map(c=>({id:c!.id,name:c!.name,isMember:c!.isMember,isExternal:c!.isExternal,isShared:c!.isShared,isPrivate:c!.isPrivate}));
}
async function verifiedDraftChannels(db:D1Database,ownerId:string,draft:DailyReportDraft) {
  const channels=await reportChannels(ownerId,draft.channels.map(c=>c.id));
  if(JSON.stringify(channels)!==JSON.stringify(draft.channels)) {
    await db.batch([
      db.prepare("UPDATE daily_report_drafts SET status='superseded',last_error='daily_report_channel_changed' WHERE owner_id=? AND id=? AND status!='sent'").bind(ownerId,draft.id),
      db.prepare("UPDATE slack_bot_deliveries SET status='cancelled',last_error='daily_report_channel_changed' WHERE owner_id=? AND subject_id=? AND bot_kind IN ('daily_report_review','daily_report_publication') AND status IN ('pending','retry','preparing')").bind(ownerId,draft.id),
    ]);throw new DailyReportError("daily_report_channel_changed",409);
  }return channels;
}
async function rawDraft(db:D1Database,ownerId:string,id:string) {
  const row=await db.prepare("SELECT * FROM daily_report_drafts WHERE owner_id=? AND id=?").bind(ownerId,id).first<Row>();if(!row)throw new DailyReportError("daily_report_not_found",404);return row;
}
export async function requestReportReview(db:D1Database,ownerId:string,id:string,revision:number,now=new Date(),defer=false) {
  let draft=await getReportDraft(db,ownerId,id);
  if(draft.revision!==revision)throw new DailyReportError("daily_report_conflict",409);
  if(["approved","publishing","sent"].includes(draft.status))return draft;
  if(!["draft","review_queued","awaiting_approval"].includes(draft.status)||draft.expiresAt<=now.toISOString())throw new DailyReportError("daily_report_review_expired",409);
  const row=await rawDraft(db,ownerId,id),preferences=await readReportPreferences(db,ownerId,""),connection=await reportConnection(db,ownerId);
  if(!connection||row.connection_key!==connection.key||preferences.policy.version!==draft.policyVersion||!preferences.policy.enabled)throw new DailyReportError("daily_report_policy_changed",409);
  const facts=await loadReportFacts(db,ownerId,preferences.policy,draft.date);
  if(facts.sourceHash!==draft.sourceHash) {
    await db.prepare("UPDATE daily_report_drafts SET status='superseded',last_error='daily_report_source_changed',updated_at=? WHERE owner_id=? AND id=? AND status IN ('draft','review_queued','awaiting_approval')").bind(now.toISOString(),ownerId,id).run();
    throw new DailyReportError("daily_report_source_changed",409);
  }
  await verifiedDraftChannels(db,ownerId,draft);
  if(draft.status==="awaiting_approval")return draft;
  const link=await db.prepare(`SELECT l.id,l.slack_user_id,l.dm_channel_id FROM slack_member_links l JOIN workspace_members m ON m.workspace_id=l.owner_id AND m.id=l.member_id AND m.status='active'
    JOIN slack_connections c ON c.owner_id=l.owner_id AND c.team_id=l.team_id WHERE l.owner_id=? AND l.member_id=? AND json_array(c.id,c.team_id,c.connected_at)=?`).bind(ownerId,draft.approverMemberId,connection.key).first<Row>();
  if(!link)throw new DailyReportError("report_approver_slack_required",409);
  const slack=await getSlackConnection(ownerId);if(!slack)throw new DailyReportError("report_slack_connection_required",409);
  const token=await slackTokenForConnection(slack);
  // Resolve the actual single-recipient DM rather than trusting an arbitrary cached channel.
  const opened=await slackApi<{ok?:boolean;channel?:{id?:string}}>(token,"conversations.open",{users:link.slack_user_id,return_im:true});
  const dm=opened.channel?.id;if(!dm||!dm.startsWith("D"))throw new DailyReportError("report_approver_dm_unavailable",409);
  if(draft.status==="review_queued"&&draft.dmChannelId&&draft.dmChannelId!==dm)throw new DailyReportError("daily_report_policy_changed",409);
  await db.batch([
    db.prepare("UPDATE slack_member_links SET dm_channel_id=?,updated_at=? WHERE owner_id=? AND id=? AND slack_user_id=? AND team_id=?").bind(dm,now.toISOString(),ownerId,link.id,link.slack_user_id,connection.teamId),
    db.prepare(`UPDATE daily_report_drafts SET status='review_queued',dm_channel_id=?,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND status='draft'
      AND EXISTS(SELECT 1 FROM daily_report_policies p WHERE p.owner_id=daily_report_drafts.owner_id AND p.version=daily_report_drafts.policy_version AND p.enabled=1)
      AND EXISTS(SELECT 1 FROM slack_member_links l JOIN workspace_members m ON m.workspace_id=l.owner_id AND m.id=l.member_id AND m.status='active' WHERE l.owner_id=daily_report_drafts.owner_id AND l.member_id=daily_report_drafts.approver_member_id AND l.slack_user_id=? AND l.team_id=?)`)
      .bind(dm,now.toISOString(),ownerId,id,revision,link.slack_user_id,connection.teamId),
  ]);
  draft=await getReportDraft(db,ownerId,id);if(draft.status!=="review_queued")throw new DailyReportError("daily_report_conflict",409);
  const destinations=draft.channels.map(c=>`#${escapeReportText(c.name)}${c.isExternal?" · 외부 연결":c.isShared?" · 공유 채널":""}`).join("\n");
  const instructions=escapeReportText(preferences.policy.instructions).slice(0,500);
  const heading=`${draft.date} · 데일리 보고 승인 요청 · ${draft.revision}차\n공유 대상\n${destinations}\n\n아래 스레드의 게시 본문을 모두 확인한 뒤 승인해 주세요.${instructions?"\n\n작성 지침 (참고)\n"+instructions:""}`;
  if(heading.length>2800)throw new DailyReportError("daily_report_review_too_large",409);
  const value=JSON.stringify({id,revision});
  const payloads=[{channel:dm,text:heading,blocks:[section(heading)]},...draft.pages.map((text,index)=>({channel:dm,text,blocks:[{type:"context",elements:[{type:"plain_text",text:`게시 본문 ${index+1}/${draft.pages.length}`} ]},section(text)]})),
    {channel:dm,text:"이 원문을 표시된 채널의 보고 스레드에 공유할까요?",blocks:[section("이 원문을 표시된 채널의 보고 스레드에 공유할까요?"),{type:"actions",elements:[{type:"button",text:{type:"plain_text",text:"승인하고 공유"},style:"primary",action_id:"daily_report_approve",value},{type:"button",text:{type:"plain_text",text:"수정 요청"},action_id:"daily_report_reject",value}]}]}];
  await deliverSlackBotMessages(db,{ownerId,botKind:"daily_report_review",subjectId:id,eventKey:id+"/review",payloads,expiresAt:draft.expiresAt,defer},now);
  return getReportDraft(db,ownerId,id);
}
export async function publishApprovedReport(db:D1Database,ownerId:string,id:string,now=new Date()) {
  let draft=await getReportDraft(db,ownerId,id);if(draft.status==="sent")return draft;
  if(!["approved","publishing"].includes(draft.status))throw new DailyReportError("daily_report_not_approved",409);
  if(draft.expiresAt<=now.toISOString())throw new DailyReportError("daily_report_review_expired",409);
  const preferences=await readReportPreferences(db,ownerId,""),connection=await reportConnection(db,ownerId),raw=await rawDraft(db,ownerId,id);
  if(!connection||connection.key!==raw.connection_key||preferences.policy.version!==draft.policyVersion||!preferences.policy.enabled)throw new DailyReportError("daily_report_policy_changed",409);
  await verifiedDraftChannels(db,ownerId,draft);
  if(draft.status==="approved") {
    const facts=await loadReportFacts(db,ownerId,preferences.policy,draft.date);
    if(facts.sourceHash!==draft.sourceHash) {
      await db.prepare("UPDATE daily_report_drafts SET status='superseded',last_error='daily_report_source_changed',updated_at=? WHERE owner_id=? AND id=? AND status='approved'").bind(now.toISOString(),ownerId,id).run();throw new DailyReportError("daily_report_source_changed",409);
    }
    await db.prepare("UPDATE daily_report_drafts SET status='publishing',updated_at=? WHERE owner_id=? AND id=? AND status='approved'").bind(now.toISOString(),ownerId,id).run();
  }
  for(const channel of draft.channels) {
    await deliverSlackBotMessages(db,{ownerId,botKind:"daily_report_publication",subjectId:id,eventKey:id+"/"+channel.id,payloads:draft.pages.map(text=>({channel:channel.id,text,blocks:[section(text)]})),expiresAt:draft.expiresAt},now);
  }
  return getReportDraft(db,ownerId,id);
}
export async function handleReportSlackAction(db:D1Database,input:{value:string;teamId:string;slackUserId:string;channelId:string;messageTs:string;action:string},now=new Date()) {
  let parsed:{id?:string;revision?:number};try{parsed=JSON.parse(input.value);}catch{throw new DailyReportError("invalid_daily_report_action");}
  if(!parsed.id||!Number.isSafeInteger(parsed.revision)||!["daily_report_approve","daily_report_reject"].includes(input.action))throw new DailyReportError("invalid_daily_report_action");
  const raw=await db.prepare(`SELECT d.owner_id FROM daily_report_drafts d JOIN workspace_members m ON m.workspace_id=d.owner_id AND m.id=d.approver_member_id AND m.status='active'
    JOIN slack_member_links l ON l.owner_id=d.owner_id AND l.member_id=m.id AND l.slack_user_id=? AND l.team_id=?
    JOIN slack_connections c ON c.owner_id=d.owner_id AND c.team_id=l.team_id
    WHERE d.id=? AND d.revision=? AND d.dm_channel_id=? AND d.review_action_ts=? AND d.connection_key=json_array(c.id,c.team_id,c.connected_at)`)
    .bind(input.slackUserId,input.teamId,parsed.id,parsed.revision,input.channelId,input.messageTs).first<{owner_id:string}>();if(!raw)throw new DailyReportError("daily_report_approver_required",403);
  const original=await getReportDraft(db,raw.owner_id,parsed.id);await verifiedDraftChannels(db,raw.owner_id,original);
  const result=await approveReportFromSlack(db,{...input,draftId:parsed.id,revision:parsed.revision!,decision:input.action==="daily_report_approve"?"approve":"reject",feedback:input.action==="daily_report_reject"?"팀장이 수정 요청했습니다.":""},now);
  let draft=result.draft;
  if(input.action==="daily_report_approve"&&["approved","publishing"].includes(draft.status))draft=await publishApprovedReport(db,result.ownerId,draft.id,now);
  const connection=await getSlackConnection(result.ownerId);
  if(connection&&draft.reviewActionTs&&draft.dmChannelId) {
    const text=draft.status==="sent"?"승인한 데일리 보고를 채널 스레드에 공유했습니다.":draft.status==="rejected"?"수정 요청을 남겼습니다. 저장된 지침과 피드백을 확인해 새 초안을 작성해 주세요.":"승인했습니다. 채널 공유 상태는 OKRI에서 확인할 수 있습니다.";
    await postSlackMessage(await slackTokenForConnection(connection),draft.dmChannelId,text,{messageTs:draft.reviewActionTs,blocks:[section(text)]});
  }
  return draft;
}
export async function runDueDailyReports(db:D1Database,now=new Date(),ownerId?:string) {
  const policies=await db.prepare(`SELECT p.* FROM daily_report_policies p JOIN workspaces w ON w.id=p.owner_id AND w.scheduled_deletion_at IS NULL JOIN slack_connections c ON c.owner_id=p.owner_id WHERE p.enabled=1 ${ownerId?"AND p.owner_id=?":""} ORDER BY p.owner_id`).bind(...(ownerId?[ownerId]:[])).all<Row>();
  let checked=0;
  for(const row of policies.results) {
    try {
      const policy=parseReportPolicy(JSON.parse(String(row.config_json))),owner=String(row.owner_id),clock=reportClock(now,policy.timezone);
      const pending=await db.prepare("SELECT id FROM daily_report_drafts WHERE owner_id=? AND status IN ('approved','publishing') ORDER BY created_at LIMIT 5").bind(owner).all<{id:string}>();
      for(const draft of pending.results)await publishApprovedReport(db,owner,draft.id,now);
      const context=await getReportContext(db,owner,"",clock.date,now),facts=context.facts;
      if(context.latest?.status==="draft"&&context.latest.automatic) {await requestReportReview(db,owner,context.latest.id,context.latest.revision,now,true);continue;}
      if(!facts.members.length||context.latest&&["draft","review_queued","awaiting_approval","approved","publishing","sent","rejected","uncertain"].includes(context.latest.status))continue;
      if(!reportConditionMatches(policy.condition,{...clock,all_submitted:facts.members.length>0&&facts.missingCount===0,manual:false,submitted_count:facts.submittedCount,missing_count:facts.missingCount,task_count:facts.taskCount,blocker_count:facts.blockerCount}))continue;
      const channels=await reportChannels(owner,policy.channelIds),draft=await createReportDraft(db,owner,"system",{date:clock.date,sourceHash:facts.sourceHash,policyVersion:Number(row.version)},channels,now,true);
      await requestReportReview(db,owner,draft.id,draft.revision,now,true);checked++;
      await db.prepare("UPDATE daily_report_policies SET last_error='' WHERE owner_id=?").bind(owner).run();
    }catch(error) {
      await db.prepare("UPDATE daily_report_policies SET last_error=? WHERE owner_id=?").bind(error instanceof DailyReportError?error.code:"daily_report_job_failed",row.owner_id).run();
    }
  }
  return {checked};
}
export const runConfiguredDailyReports=(now=new Date(),ownerId?:string)=>runDueDailyReports(env.DB,now,ownerId);
