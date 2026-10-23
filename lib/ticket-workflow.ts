import type {TicketState} from './ticket-policy';

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
export function ticketWorkflow(r:{state:TicketState;category?:string;security_json?:string}){
  const guidance=r.category==='guidance',security=ticketWarning(r.security_json||'{}');
  if(r.state==='recommended'||r.state==='created')return {step:0,label:guidance?'회신 승인 대기':'개발 승인 대기',next:guidance?'문안을 확인하고 승인하면 고객에게 보냅니다.':'승인하면 포트를 배정하고 자동 검사를 시작합니다.'};
  if(r.state==='security_review')return {step:0,label:'작업 내용 확인',next:security.recheckReason==='snapshot_changed'?'작업 코드가 변경되어 다시 확인이 필요합니다.':security.recheckReason==='additional_warning'?'새로운 주의 항목이 추가되어 확인이 필요합니다.':'아래 주의 내용을 확인하고 승인하면 개발을 이어갑니다.'};
  if(r.state==='queued')return {step:1,label:'시작 준비 중',next:'포트가 자동 검사를 마치면 개발을 시작합니다.'};
  if(r.state==='running')return security.allow?{step:1,label:'개발 중',next:'완료되면 고객에게 보낼 회신을 확인합니다.'}:{step:1,label:'자동 검사 중',next:'검사를 통과하면 개발을 시작합니다.'};
  if(r.state==='waiting_answer')return {step:1,label:'답변 대기',next:'담당자 답변을 반영한 뒤 개발을 이어갑니다.'};
  if(r.state==='review')return {step:2,label:'회신 승인 대기',next:'문안을 확인하고 승인하면 고객에게 보냅니다.'};
  if(r.state==='publishing')return {step:2,label:'회신 전송 중',next:'전송이 확인되면 완료로 바뀝니다.'};
  if(r.state==='published')return {step:3,label:'완료',next:'고객 원문 스레드에 회신했습니다.'};
  if(r.state==='dismissed')return {step:3,label:'추천 제외',next:'원문과 처리 이력은 보관합니다.'};
  return {step:0,label:r.state==='blocked'?'실행 차단':'처리 확인 필요',next:'상세·수정에서 원인과 원문을 확인해 주세요.'};
}
