import {env} from 'cloudflare:workers';
import {getSlackConnection,canManageTeam} from '@/lib/pace-data';
import {dailyMemberBySlack,slackApi,slackTokenForConnection} from '@/lib/slack-daily';
import {TICKET_STATE_LABELS} from '@/lib/ticket-policy';
import {TICKET_CATEGORY_LABELS} from '@/lib/ticket-recommendation';
import {ticketIntakeStatus,requestTicketReconciliation} from '@/lib/ticket-intake-queue';
import type {TicketAutomationRequest} from '@/lib/ticket-automation';
const rows=async<T>(sql:string,...args:unknown[])=>(await env.DB.prepare(sql).bind(...args).all<T>()).results||[];
const option=(value:string,text:string)=>({text:{type:'plain_text',text},value});
type QueueState={status:string;query:string;offset:number;coverage?:boolean};
function state(value:string):QueueState{try{const p=JSON.parse(value);return {status:typeof p.status==='string'?p.status:'all',query:typeof p.query==='string'?p.query.slice(0,100):'',offset:Number.isSafeInteger(p.offset)?Math.max(0,p.offset):0,coverage:p.coverage===true};}catch{return {status:'all',query:'',offset:0};}}
async function actor(team:string,user:string){const linked=await dailyMemberBySlack(team,user);if(!linked||linked.authorization.role==='viewer')throw new Error('담당자 또는 관리자 계정을 연결해 주세요.');const connection=await getSlackConnection(linked.authorization.ownerId);if(!connection||connection.teamId!==team)throw new Error('Slack 연결을 확인해 주세요.');return {a:linked.authorization,token:await slackTokenForConnection(connection)};}
async function queueView(team:string,user:string,p:QueueState){
  const {a}=await actor(team,user),blocks:Record<string,unknown>[]=[];
  const metadata=JSON.stringify(p);
  if(p.coverage){
    const coverage=await ticketIntakeStatus(a.ownerId);
    const labels:Record<string,string>={pending:'분석 대기',processing:'분석 중',retry:'재시도 대기',analyzed:'추천 완료',existing:'기존 티켓 연결',no_work:'업무 요청 아님',ignored:'수집 제외'};
    const count=coverage.counts.map(v=>`${labels[v.state]||v.state}: ${v.count}`).join(' · ')||'아직 수집된 메시지가 없습니다.';
    const configuration=(await rows<{config_json:string}>('SELECT config_json FROM ticket_automation_settings WHERE owner_id=?',a.ownerId))[0],channels=(configuration?JSON.parse(configuration.config_json).channels:[]) as {id:string;name:string;enabled:boolean}[];
    const active=channels.filter(c=>c.enabled);
    blocks.push({type:'section',text:{type:'plain_text',text:`원문 수집 후 분석합니다. 실패는 재시도하고 과거 복구 요청은 수동 검토합니다.\n${count}`}});
    for(const ch of active.slice(p.offset,p.offset+20)){const c=coverage.channels.find(v=>v.channel_id===ch.id);blocks.push({type:'section',text:{type:'plain_text',text:`#${ch.name} · ${!c?'대조 대기':c.last_error||c.thread_errors?'연결·권한 확인 필요':c.cursor?'과거 대화 대조 중':c.completed_passes?c.pending_threads?'댓글 대조 중':'전체 대조 완료':'대조 중'} · 댓글 대조 대기 ${c?.pending_threads||0}\n최근 확인: ${c?.last_checked_at||'대기'}`}});}
    const uncertain=(await rows<{count:number}>("SELECT count(*) AS count FROM ticket_automation_outbox WHERE owner_id=? AND state='uncertain'",a.ownerId))[0]?.count||0;
    if(uncertain)blocks.push({type:'section',text:{type:'plain_text',text:`Slack 전송 확인 필요 ${uncertain}건. 같은 메시지가 실제로 전송됐는지 대조하며 중복 발신하지 않습니다.`}});
    blocks.push({type:'actions',elements:[{type:'button',text:{type:'plain_text',text:'티켓 목록'},action_id:'ticket_queue_back',value:JSON.stringify({...p,coverage:false,offset:0})},...(p.offset?[{type:'button',text:{type:'plain_text',text:'이전'},action_id:'ticket_queue_previous',value:JSON.stringify({...p,offset:Math.max(0,p.offset-20)})}]:[]),...(active.length>p.offset+20?[{type:'button',text:{type:'plain_text',text:'다음'},action_id:'ticket_queue_next',value:JSON.stringify({...p,offset:p.offset+20})}]:[]),...(canManageTeam(a)?[{type:'button',text:{type:'plain_text',text:'누락 대조·분석 재시도'},action_id:'ticket_queue_reconcile',value:metadata}]:[])]});
  }else{
    const statuses=[option('all','전체'),option('unassigned','담당자 미지정'),option('approval','승인 대기'),option('waiting_answer','답변 대기'),option('review','완료 공유 대기'),option('security_review','보안 경고'),option('blocked','보안 차단'),option('published','공유 완료')];
    blocks.push({type:'input',block_id:'ticket_queue_status',dispatch_action:true,label:{type:'plain_text',text:'처리 상태'},element:{type:'static_select',action_id:'ticket_queue_filter',options:statuses,initial_option:statuses.find(v=>v.value===p.status)||statuses[0]}},{type:'input',block_id:'ticket_queue_query',optional:true,label:{type:'plain_text',text:'티켓 검색'},element:{type:'plain_text_input',action_id:'ticket_queue_query',...(p.query?{initial_value:p.query}:{}),dispatch_action_config:{trigger_actions_on:['on_enter_pressed']}}});
    const where=p.status==='unassigned'?"member_id IS NULL AND state NOT IN ('published','dismissed')":p.status==='approval'?"state IN ('recommended','created')":p.status==='all'?'1=1':'state=?';
    const values:unknown[]=[a.ownerId,...(where==='state=?'?[p.status]:[]),p.query,p.query,p.query];
    const tickets=await rows<TicketAutomationRequest>(`SELECT * FROM ticket_automation_requests WHERE owner_id=? AND ${where} AND (?='' OR instr(lower(title),lower(?))>0 OR instr(lower(description),lower(?))>0) ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,created_at,id LIMIT 11 OFFSET ?`,...values,p.offset);
    for(const r of tickets.slice(0,10)){
      blocks.push({type:'section',text:{type:'plain_text',text:`[${TICKET_CATEGORY_LABELS[r.category]}] ${r.title}\n${TICKET_STATE_LABELS[r.state]} · ${r.member_id?'담당자 지정됨':'담당자 미지정'}\n${r.description.slice(0,1200)}`},accessory:{type:'button',text:{type:'plain_text',text:['queued','running'].includes(r.state)?'실행 중지':'열기·수정'},action_id:['queued','running'].includes(r.state)?'ticket_auto_stop':'ticket_auto_edit',value:`${r.id}:${r.revision}`}});
      if(['recommended','created','review'].includes(r.state))blocks.push({type:'actions',elements:[{type:'button',text:{type:'plain_text',text:r.state==='recommended'?'티켓 생성':r.state==='created'?r.category==='guidance'?'안내문 검토':'개발 승인':'완료 안내 공유 승인'},action_id:`ticket_auto_${r.state==='recommended'?'create':r.state==='created'?'approve':'publish'}`,value:`${r.id}:${r.revision}`}]});
    }
    if(!tickets.length)blocks.push({type:'section',text:{type:'plain_text',text:'이 상태의 티켓이 없습니다.'}});
    blocks.push({type:'actions',elements:[{type:'button',text:{type:'plain_text',text:'새로고침'},action_id:'ticket_queue_refresh',value:metadata},...(p.offset?[{type:'button',text:{type:'plain_text',text:'이전'},action_id:'ticket_queue_previous',value:JSON.stringify({...p,offset:Math.max(0,p.offset-10)})}]:[]),...(tickets.length>10?[{type:'button',text:{type:'plain_text',text:'다음'},action_id:'ticket_queue_next',value:JSON.stringify({...p,offset:p.offset+10})}]:[]),{type:'button',text:{type:'plain_text',text:'수집 점검'},action_id:'ticket_queue_coverage',value:JSON.stringify({...p,coverage:true,offset:0})}]});
  }
  return {type:'modal',callback_id:'ticket_queue',private_metadata:metadata,title:{type:'plain_text',text:'티켓 운영'},close:{type:'plain_text',text:'닫기'},blocks};
}
export async function openTicketSlackQueue(team:string,user:string,trigger:string,query=''){const {token}=await actor(team,user);await slackApi(token,'views.open',{trigger_id:trigger,view:await queueView(team,user,{status:'all',query,offset:0})});}
export async function postTicketSlackQueueEntry(team:string,user:string,channel:string){const {token}=await actor(team,user);await slackApi(token,'chat.postEphemeral',{channel,user,text:'티켓 운영을 Slack에서 여세요.',blocks:[{type:'section',text:{type:'plain_text',text:'요청 검토·담당자 지정·승인·완료 안내와 수집 상태를 확인합니다.'}},{type:'actions',elements:[{type:'button',text:{type:'plain_text',text:'티켓 운영 열기'},action_id:'ticket_queue_open',value:'{}'}]}]});}
export async function updateTicketSlackQueue(team:string,user:string,viewId:string,value:string,action:string,rawState:Record<string,Record<string,Record<string,unknown>>>={}){
  const {a,token}=await actor(team,user),p=state(value);
  if(action==='ticket_queue_reconcile')await requestTicketReconciliation(a);
  const selected=Object.values(rawState.ticket_queue_status||{})[0]?.selected_option as {value?:string}|undefined;
  if(action==='ticket_queue_filter'){p.status=selected?.value||'all';p.offset=0;}
  const query=Object.values(rawState.ticket_queue_query||{})[0]?.value;
  if(typeof query==='string'&&['ticket_queue_query','ticket_queue_filter','ticket_queue_refresh'].includes(action)){p.query=query.slice(0,100);if(action==='ticket_queue_query')p.offset=0;}
  await slackApi(token,'views.update',{view_id:viewId,view:await queueView(team,user,p)});
}
