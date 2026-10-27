import type {TicketState} from './ticket-policy';

export type TicketPortActivity = {requestId:string;title:string;state:TicketState;category:string;preparing?:boolean;preflightAllowed:boolean;jobStatus:string|null;progress:string;leaseExpiresAt:string|null;updatedAt:string};
export function ticketPortActivity(activity:TicketPortActivity|null|undefined,online:boolean,now=Date.now()){
  if(!activity)return {label:'배정 대기',next:'',moving:false};
  const executing=['queued','running'].includes(activity.state);
  if(executing&&activity.jobStatus==='completed')return {label:'완료 확인 중',next:'작업 결과를 티켓에 반영하고 있습니다.',moving:false};
  if(executing&&['failed','cancelled'].includes(activity.jobStatus||''))return {label:'처리 확인 필요',next:'티켓에서 실행 결과를 확인해 주세요.',moving:false};
  if(executing&&(!online||activity.jobStatus==='running'&&!(Date.parse(activity.leaseExpiresAt||'')>now)))return {label:'실행 연결 확인',next:'PC 연결과 실행 상태를 확인하고 있습니다.',moving:false};
  const flow=ticketWorkflow({...activity,analysis_json:activity.preparing?JSON.stringify({preparation:{stage:'reading'}}):undefined,security_json:JSON.stringify({allow:Boolean(activity.preflightAllowed)})});
  return {...flow,next:executing&&activity.jobStatus==='running'&&activity.progress?activity.progress:flow.next,moving:executing&&activity.jobStatus==='running'};
}

export const TICKET_WARNING_LABELS:Record<string,string>={scope_ambiguous:'구현할 범위 확인',sensitive_change:'주요 기능·데이터 변경',dependency_network:'외부 의존성 설치',destructive:'삭제·대량 변경',coordination_conflict:'다른 작업과 수정 파일 중복'};
export function ticketSolutionPreview(description:string){
  const solution=description.split(/(?:^|\n)(?:해결 제안|안내 초안)\n/u)[1]?.split('\n\n완료 확인 기준')[0]?.trim()||'';
  const sentence=solution.match(/^[\s\S]*?[.!?](?:\s|$)/u)?.[0]?.trim()||solution;
  return sentence.length<=240?sentence:sentence.slice(0,240).replace(/\s+\S*$/u,'')+'…';
}
export function ticketWarning(value:string){
  let security:{verdict?:string;codes?:string[];allow?:boolean;recheckReason?:string}={};
  try{security=JSON.parse(value||'{}');}catch{/* Invalid checks cannot be approved. */}
  const codes=Array.isArray(security.codes)?security.codes:[];
  return {...security,codes,approvable:security.verdict==='warning'&&codes.length>0&&codes.every(c=>Object.hasOwn(TICKET_WARNING_LABELS,c)),labels:codes.map(c=>TICKET_WARNING_LABELS[c]||'실행 경계 확인 필요')};
}
export function ticketWorkflow(r:{state:TicketState;category?:string;security_json?:string;analysis_json?:string}){
  const guidance=r.category==='guidance',security=ticketWarning(r.security_json||'{}');
  const conversation=JSON.parse(r.analysis_json||'{}').portConversation;
  if(conversation&&!['publishing','published','dismissed','blocked','security_review','failed'].includes(r.state))return {step:0,label:conversation.error?'포트 연결 대기':r.state==='queued'?'포트 전달 대기':r.state==='running'?security.allow?'포트 응답 중':'포트 수신 완료 · 준비 중':conversation.nextAction==='develop'?'개발 승인 대기':r.state==='review'?'회신 검토 대기':'포트와 대화 중',next:conversation.error||'이 Slack 스레드에 답하면 배정된 포트의 같은 대화로 이어집니다.'};
  const preparing=JSON.parse(r.analysis_json||'{}').preparation;
  if(preparing&&preparing.stage!=='ready'&&['recommended','created','queued','running'].includes(r.state))return {step:0,label:r.state==='running'?'제품 확인 중':r.state==='queued'?'시작 준비 중':'제품 확인 대기',next:'현재 제품 코드를 확인해 구체적인 해결안을 추천합니다.'};
  if(r.state==='security_review'&&(guidance||preparing?.stage==='reading'))return {step:0,label:'제품 확인 대기',next:'현재 제품 코드를 확인해 구체적인 해결안을 추천합니다.'};
  if(r.state==='recommended'||r.state==='created')return {step:0,label:guidance?'제품 확인 대기':'개발 승인 대기',next:guidance?'포트가 실제 제품 코드를 확인하고 회신을 준비합니다.':'승인하면 포트를 배정하고 자동 검사를 시작합니다.'};
  if(r.state==='security_review')return {step:1,label:'개발 시작 대기',next:security.recheckReason==='snapshot_changed'?'작업 코드가 변경되어 다시 확인이 필요합니다.':security.recheckReason==='additional_warning'?'새로운 주의 항목이 추가되어 확인이 필요합니다.':'주의 내용을 확인하고 개발 시작을 누르면 배정된 포트에서 이어갑니다.'};
  if(r.state==='queued')return {step:1,label:'시작 준비 중',next:guidance?'포트가 실제 제품 코드를 확인하고 회신을 준비합니다.':'포트가 자동 검사를 마치면 개발을 시작합니다.'};
  if(r.state==='running')return security.allow?{step:1,label:guidance?'제품 확인 중':'개발 중',next:guidance?'현재 구현과 제한 사항을 확인해 회신을 준비합니다.':'완료되면 고객에게 보낼 회신을 확인합니다.'}:{step:1,label:'자동 검사 중',next:guidance?'검사를 통과하면 제품 코드를 읽습니다.':'검사를 통과하면 개발을 시작합니다.'};
  if(r.state==='waiting_answer')return {step:1,label:'담당자 회신 대기',next:'포트가 확인한 내용을 검토하고 답변하면 같은 포트에서 이어갑니다.'};
  if(r.state==='review')return {step:2,label:'회신 승인 대기',next:'문안을 확인하고 승인하면 고객에게 보냅니다.'};
  if(r.state==='publishing')return {step:2,label:'회신 전송 중',next:'전송이 확인되면 완료로 바뀝니다.'};
  if(r.state==='published')return {step:3,label:'완료',next:'고객 원문 스레드에 회신했습니다.'};
  if(r.state==='dismissed')return {step:3,label:'추천 제외',next:'원문과 처리 이력은 보관합니다.'};
  return {step:0,label:r.state==='blocked'?'실행 차단':'처리 확인 필요',next:'상세·수정에서 원인과 원문을 확인해 주세요.'};
}
