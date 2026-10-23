import {env} from 'cloudflare:workers';
import {getSlackConnection} from '@/lib/pace-data';
import {dailyMemberBySlack,slackApi,slackTokenForConnection} from '@/lib/slack-daily';
import {changeTicketRequest,ticketRequestFor,queueTicketUpdate,ticketSummary,ticketReplyDraft,type TicketDevelopmentProduct,type TicketRepository} from '@/lib/ticket-automation';
import {TICKET_CATEGORIES,TICKET_CATEGORY_LABELS} from '@/lib/ticket-recommendation';
import {TICKET_PRIORITIES,TICKET_PRIORITY_LABELS} from '@/lib/ticket-policy';
type State=Record<string,Record<string,{value?:string;selected_option?:{value:string};selected_options?:{value:string}[];selected_user?:string}>>;
type Option={text:{type:'plain_text';text:string};value:string};
const option=(value:string,label:string):Option=>({text:{type:'plain_text',text:label.slice(0,75)},value:value||'_'});
const rows=async<T>(sql:string,...args:unknown[])=>(await env.DB.prepare(sql).bind(...args).all<T>()).results||[];
const pick=(state:State,key:string)=>{const value=Object.values(state[key]||{})[0];return value?.selected_option?.value||value?.selected_user||value?.value||'';};
const scalar=(state:State,key:string)=>pick(state,key)==='_'?'':pick(state,key);
function metadata(value:string){const [id,revision]=value.split(':');if(!id||!Number.isInteger(Number(revision)))throw new Error('invalid_ticket_revision');return {id,revision:Number(revision)};}
async function actor(team:string,user:string,value:string){
  const linked=await dailyMemberBySlack(team,user);if(!linked)throw new Error('OKRI 계정을 먼저 연결해 주세요.');
  const m=metadata(value),r=await ticketRequestFor(linked.authorization,m.id);
  if(r.team_id!==team||r.revision!==m.revision)throw new Error('내용이 변경되었습니다. 최신 티켓 버튼으로 다시 열어 주세요.');
  const connection=await getSlackConnection(linked.authorization.ownerId);if(!connection||connection.teamId!==team)throw new Error('Slack 연결을 확인해 주세요.');
  return {a:linked.authorization,r,token:await slackTokenForConnection(connection)};
}
const field=(id:string,label:string,element:Record<string,unknown>,optional=false)=>({type:'input',block_id:id,label:{type:'plain_text',text:label},element:{action_id:id,...element},optional});
const input=(id:string,label:string,value:string,multiline=false,max=3000)=>field(id,label,{type:'plain_text_input',initial_value:value,multiline,max_length:max});
const select=(id:string,label:string,values:Option[],current:string)=>field(id,label,{type:'static_select',options:values,initial_option:values.find(v=>v.value===(current||'_'))||values[0]});
const external=(id:string,label:string,current:Option)=>field(id,label,{type:'external_select',min_query_length:0,placeholder:{type:'plain_text',text:'이름으로 검색'},initial_option:current});
export async function openMissingTicketAssignment(team:string,user:string,trigger:string,value:string,push=false){
  const {r}=await actor(team,user,value);
  if(r.state!=='created'||r.member_id)return false;
  await openTicketSlackEditor(team,user,trigger,value,push,true);return true;
}
export async function openTicketSlackAction(team:string,user:string,trigger:string,value:string,mode:'start'|'reply',push=false){
  const {a,r,token}=await actor(team,user,value);
  if(mode==='start'?!['recommended','created'].includes(r.state)||r.category==='guidance':!(r.state==='review'||r.category==='guidance'&&['recommended','created'].includes(r.state)))throw new Error('최신 티켓의 처리 상태를 확인해 주세요.');
  const settings=(await rows<{config_json:string}>('SELECT config_json FROM ticket_automation_settings WHERE owner_id=?',a.ownerId))[0];
  const customer=(settings?JSON.parse(settings.config_json).channels:[]).find((c:{id:string;name:string})=>c.id===r.source_channel)?.name||r.source_channel;
  const blocks:Record<string,unknown>[]=[{type:'section',text:{type:'mrkdwn',text:ticketSummary(r,customer)}}];
  if(mode==='reply'){
    blocks.push({type:'context',elements:[{type:'mrkdwn',text:`전송 위치: <#${r.source_channel}> 원문 스레드 · 아래 요청자를 태그합니다.`}]},input('ta_notice','회신 내용',ticketReplyDraft(r).slice(0,3000),true));
    const tail=ticketReplyDraft(r).slice(3000);if(tail)blocks.push(input('ta_notice_tail','회신 내용 (계속)',tail,true,1000));
    blocks.push(field('ta_requester','요청자',{type:'users_select',...(r.requester_slack_user?{initial_user:r.requester_slack_user}:{})}));
  }else{
    const self=(await rows<{id:string;display_name:string}>("SELECT id,display_name FROM workspace_members WHERE workspace_id=? AND user_id=? AND status='active'",a.ownerId,a.userId))[0];
    const member=r.member_id?(await rows<{id:string;display_name:string}>('SELECT id,display_name FROM workspace_members WHERE id=? AND workspace_id=?',r.member_id,a.ownerId))[0]:self;
    const port=r.port_id?(await rows<{name:string}>('SELECT name FROM ticket_execution_ports WHERE id=? AND owner_id=?',r.port_id,a.ownerId))[0]:null;
    blocks.push(external('ta_member','담당자',option(member?.id||'',member?.display_name||'담당자 선택')),external('ta_port','실행 포트',option(r.port_id||'',port?.name||'자동 배정')));
    if(!r.product_id||!r.repository_id)blocks.push(external('ta_repository','제품·Git 저장소',option('','제품 선택')));
    blocks.push({type:'context',elements:[{type:'mrkdwn',text:'티켓 생성·담당자 지정·개발 승인을 함께 처리합니다. 연결된 포트가 착수 전 보안 검사를 수행합니다.'}]});
  }
  await slackApi(token,push?'views.push':'views.open',{trigger_id:trigger,view:{type:'modal',callback_id:'ticket_edit_submit',private_metadata:`${r.id}:${r.revision}:${mode}`,title:{type:'plain_text',text:mode==='reply'?'고객에게 회신':'개발 시작'},submit:{type:'plain_text',text:mode==='reply'?'회신 보내기':'승인하고 시작'},close:{type:'plain_text',text:'취소'},blocks}});
}
export async function openTicketSlackEditor(team:string,user:string,trigger:string,value:string,push=false,requireAssignment=false){
  const {a,r,token}=await actor(team,user,value);
  const blocks:Record<string,unknown>[]=[{type:'context',elements:[{type:'mrkdwn',text:requireAssignment?'담당자를 지정해 저장한 뒤 같은 스레드에서 승인을 누르세요. 개발 티켓의 실행 포트는 자동 배정이 기본입니다.':'내용과 담당자를 확인해 저장한 뒤 같은 스레드에서 다음 단계를 선택하세요. 변경한 내용은 다시 승인이 필요합니다.'}]}];
  if(['recommended','created'].includes(r.state)){
    const products=await rows<TicketDevelopmentProduct>('SELECT * FROM ticket_development_products WHERE owner_id=?',a.ownerId);
    const product=products.find(p=>p.id===r.product_id),repo=product?(JSON.parse(product.repositories_json) as TicketRepository[]).find(v=>v.id===r.repository_id):undefined;
    const member=r.member_id?(await rows<{display_name:string}>('SELECT display_name FROM workspace_members WHERE id=? AND workspace_id=?',r.member_id,a.ownerId))[0]:null;
    const port=r.port_id?(await rows<{name:string}>('SELECT name FROM ticket_execution_ports WHERE id=? AND owner_id=?',r.port_id,a.ownerId))[0]:null;
    blocks.push(input('ta_title','제목',r.title,false,240),input('ta_description','고객의 문제·해결 제안',r.description.slice(0,3000),true));
    if(r.description.length>3000)blocks.push(input('ta_description_tail','요청 내용 (계속)',r.description.slice(3000),true,1000));
    blocks.push(select('ta_category','분류',TICKET_CATEGORIES.map(v=>option(v,TICKET_CATEGORY_LABELS[v])),r.category),select('ta_priority','우선순위',TICKET_PRIORITIES.map(v=>option(v,TICKET_PRIORITY_LABELS[v])),r.priority),external('ta_repository','제품·Git 저장소',option(product&&repo?`${product.id}:${repo.id}`:'',product&&repo?`${product.name} / ${repo.name}`:'미지정')),external('ta_member','담당자',option(r.member_id||'',member?.display_name||'미지정')),external('ta_port','실행 포트',option(r.port_id||'',port?.name||'자동 배정')));
    const dependencies=JSON.parse(r.dependencies_json||'[]') as string[];
    const selected=dependencies.length?await rows<{id:string;title:string}>('SELECT id,title FROM ticket_automation_requests WHERE owner_id=? AND id IN (SELECT value FROM json_each(?))',a.ownerId,JSON.stringify(dependencies)):[];
    blocks.push(field('ta_dependencies','선행 티켓',{type:'multi_external_select',min_query_length:0,placeholder:{type:'plain_text',text:'선행 티켓 검색'},...(selected.length?{initial_options:selected.map(v=>option(v.id,v.title))}:{})},true));
  }else if(r.state==='security_review'){
    const security=JSON.parse(r.security_json||'{}');if(security.verdict!=='warning')throw new Error('차단된 요청은 강제로 진행할 수 없습니다.');
    const labels:Record<string,string>={scope_ambiguous:'해결할 범위 확인 필요',sensitive_change:'민감 기능 변경 가능성',dependency_network:'외부 의존성 준비 필요',destructive:'삭제·대량 변경 확인 필요',coordination_conflict:'다른 포트와 수정 파일 중복'};
    blocks.push({type:'section',text:{type:'plain_text',text:`보안 경고\n${(security.codes||[]).map((c:string)=>`• ${labels[c]||'추가 검증 필요'}`).join('\n')}\n\n허용된 변경 범위를 확인해 주세요. 비밀정보·유출·권한 우회 차단은 해제할 수 없습니다.`}},input('ta_reason','경고 확인 사유','',true,500),field('ta_ack','경고 확인',{type:'checkboxes',options:[option('ack','경고와 작업 범위를 확인했습니다.')]},true));
  }else if(r.state==='waiting_answer'){
    blocks.push({type:'section',text:{type:'plain_text',text:r.question.slice(0,3000)}},input('ta_answer','담당자 답변','',true));
  }else if(r.state==='review'){
    blocks.push(input('ta_notice','고객에게 보낼 완료 안내',r.notice.slice(0,3000),true));
    if(r.notice.length>3000)blocks.push(input('ta_notice_tail','완료 안내 (계속)',r.notice.slice(3000),true,1000));
  }else{
    blocks.push({type:'section',text:{type:'plain_text',text:`${r.title}\n\n${r.description}`.slice(0,3000)}});
    await slackApi(token,push?'views.push':'views.open',{trigger_id:trigger,view:{type:'modal',title:{type:'plain_text',text:'티켓 처리 현황'},close:{type:'plain_text',text:'닫기'},blocks}});return;
  }
  if(['recommended','created','review'].includes(r.state))blocks.push(field('ta_requester','완료 안내를 받을 Slack 요청자',{type:'users_select',...(r.requester_slack_user?{initial_user:r.requester_slack_user}:{}),placeholder:{type:'plain_text',text:'원문 고객 채널의 요청자 선택'}},!r.requester_slack_user));
  if(['recommended','created','blocked','failed','security_review'].includes(r.state))blocks.push({type:'actions',elements:[{type:'button',text:{type:'plain_text',text:'원문 다시 분석'},action_id:'ticket_auto_refresh_source',value:`${r.id}:${r.revision}`},{type:'button',text:{type:'plain_text',text:'요청 제외'},action_id:'ticket_auto_dismiss',value:`${r.id}:${r.revision}`,confirm:{title:{type:'plain_text',text:'요청 제외'},text:{type:'plain_text',text:'원문과 처리 이력은 남기고 제외할까요?'},confirm:{type:'plain_text',text:'제외'},deny:{type:'plain_text',text:'취소'}}},{type:'button',text:{type:'plain_text',text:'티켓 목록'},action_id:'ticket_queue_open',value:'{}'}]});
  await slackApi(token,push?'views.push':'views.open',{trigger_id:trigger,view:{type:'modal',callback_id:'ticket_edit_submit',private_metadata:`${r.id}:${r.revision}${requireAssignment?':assignment':''}`,title:{type:'plain_text',text:r.state==='security_review'?'보안 경고 검토':requireAssignment?'담당자 지정 후 승인':'티켓 내용·담당자 수정'},submit:{type:'plain_text',text:r.state==='security_review'?'사유를 남기고 진행':requireAssignment?'담당자 저장':'수정 저장'},close:{type:'plain_text',text:'취소'},blocks}});
}
export async function ticketSlackEditorOptions(team:string,user:string,value:string,action:string,query:string,rawState:Record<string,Record<string,Record<string,unknown>>>={}){
  const state=rawState as State;
  const {a,r}=await actor(team,user,value),q=query.toLocaleLowerCase();
  let options:Option[]=[];
  // Slack suggestions may omit the other unsaved inputs. Show labeled workspace
  // candidates in that case; changeTicketRequest still validates the final tuple.
  const pair=scalar(state,'ta_repository'),[product='',repository='']=pair.split(':');
  if(action==='ta_member')options=[option('','미지정'),...(await rows<{id:string;display_name:string}>("SELECT id,display_name FROM workspace_members WHERE workspace_id=? AND status='active' AND user_id IS NOT NULL ORDER BY display_name",a.ownerId)).map(v=>option(v.id,v.display_name))];
  if(action==='ta_repository')options=[option('','미지정'),...(await rows<TicketDevelopmentProduct>('SELECT * FROM ticket_development_products WHERE owner_id=? ORDER BY name',a.ownerId)).flatMap(p=>(JSON.parse(p.repositories_json) as TicketRepository[]).map(repo=>option(`${p.id}:${repo.id}`,`${p.name} / ${repo.name}`)))];
  if(action==='ta_port'){
    const member=scalar(state,'ta_member');
    options=[option('','자동 배정'),...(await rows<{id:string;name:string;computer_label:string;member_name:string;product_name:string}>("SELECT p.id,p.name,p.computer_label,m.display_name AS member_name,d.name AS product_name FROM ticket_execution_ports p JOIN workspace_members m ON m.id=p.member_id AND m.workspace_id=p.owner_id JOIN ticket_development_products d ON d.id=p.product_id AND d.owner_id=p.owner_id WHERE p.owner_id=? AND p.enabled=1 AND m.status='active' AND (?='' OR p.member_id=?) AND (?='' OR (p.product_id=? AND p.repository_id=?)) ORDER BY p.name",a.ownerId,member,member,product,product,repository)).map(p=>option(p.id,`${p.name} · ${p.computer_label} · ${p.member_name} · ${p.product_name}`))];
  }
  if(action==='ta_dependencies')options=(await rows<{id:string;title:string}>("SELECT id,title FROM ticket_automation_requests WHERE owner_id=? AND (?='' OR (product_id=? AND repository_id=?)) AND id<>? AND state<>'dismissed' ORDER BY created_at DESC",a.ownerId,product,product,repository,r.id)).map(v=>option(v.id,v.title));
  return {options:options.filter(v=>v.value==='_'||v.text.text.toLocaleLowerCase().includes(q)).slice(0,100)};
}
export async function submitTicketSlackEditor(team:string,user:string,value:string,rawState:Record<string,Record<string,Record<string,unknown>>>){
  const state=rawState as State;
  const {a,r}=await actor(team,user,value),requester=scalar(state,'ta_requester');
  if(value.endsWith(':assignment')&&!scalar(state,'ta_member'))return {response_action:'errors',errors:{ta_member:'승인할 티켓의 담당자를 선택해 주세요. 포트는 자동 배정으로 두어도 됩니다.'}};
  try{
    if(value.endsWith(':start')){
      const [productId,repositoryId]=scalar(state,'ta_repository').split(':');
      await changeTicketRequest(a,{id:r.id,revision:r.revision,action:'start',memberId:scalar(state,'ta_member'),portId:scalar(state,'ta_port'),...(!r.product_id||!r.repository_id?{productId:productId||'',repositoryId:repositoryId||''}:{})});
    }else if(value.endsWith(':reply'))await changeTicketRequest(a,{id:r.id,revision:r.revision,action:'reply',notice:scalar(state,'ta_notice')+scalar(state,'ta_notice_tail'),requesterSlackUser:requester});
    else if(r.state==='security_review')await changeTicketRequest(a,{id:r.id,revision:r.revision,action:'force',reason:scalar(state,'ta_reason'),acknowledged:Boolean(Object.values(state.ta_ack||{})[0]?.selected_options?.some(o=>o.value==='ack'))});
    else if(r.state==='waiting_answer'){
      await changeTicketRequest(a,{id:r.id,revision:r.revision,action:'answer',answer:scalar(state,'ta_answer')});
      const latest=await ticketRequestFor(a,r.id);await changeTicketRequest(a,{id:r.id,revision:latest.revision,action:'approve'});
    }else if(r.state==='review')await changeTicketRequest(a,{id:r.id,revision:r.revision,action:'review_notice',notice:scalar(state,'ta_notice')+scalar(state,'ta_notice_tail'),...(requester?{requesterSlackUser:requester}:{})});
    else{
      const [productId,repositoryId]=scalar(state,'ta_repository').split(':');
      const dependencies=Object.values(state.ta_dependencies||{})[0]?.selected_options?.map(o=>o.value)||[];
      await changeTicketRequest(a,{id:r.id,revision:r.revision,action:'edit',title:scalar(state,'ta_title'),description:scalar(state,'ta_description')+scalar(state,'ta_description_tail'),category:scalar(state,'ta_category'),priority:scalar(state,'ta_priority'),productId:productId||'',repositoryId:repositoryId||'',memberId:scalar(state,'ta_member'),portId:scalar(state,'ta_port'),dependencies,...(requester?{requesterSlackUser:requester}:{})});
    }
    await queueTicketUpdate(a,r.id,'edited');
    return {};
  }catch(error){return {response_action:'errors',errors:{[value.endsWith(':start')?'ta_member':value.endsWith(':reply')||r.state==='review'?'ta_notice':r.state==='security_review'?'ta_reason':r.state==='waiting_answer'?'ta_answer':'ta_title']:error instanceof Error?error.message:'저장하지 못했습니다. 내용을 확인해 주세요.'}};}
}
