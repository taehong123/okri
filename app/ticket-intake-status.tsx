'use client';
import {useState} from 'react';
import {t} from '@/lib/client-language';
import type {TicketIntakeStatus} from '@/lib/ticket-intake-queue';
const labels:Record<string,string>={pending:'분석 대기',processing:'분석 중',retry:'재시도 대기',review:'담당자 검토',analyzed:'추천 완료',no_work:'업무 요청 아님',existing:'기존 티켓에 연결',ignored:'수집 대상 아님'};
const reasons:Record<string,string>={ai_daily_limit_reached:'오늘의 AI 분석 횟수 한도에 도달했습니다.',ai_budget_exceeded:'AI 금액 예산 한도에 도달했습니다.',ai_rate_limited:'AI 분석 요청이 몰려 잠시 대기합니다.',ai_reservation_limited:'AI 분석 요청이 몰려 잠시 대기합니다.',ai_provider_rate_limited:'AI 서비스의 요청 한도로 잠시 대기합니다.',analysis_invalid_response:'AI 분석 결과를 검증하지 못해 다시 분석합니다.',analysis_configuration_required:'AI 연결 설정을 확인해 주세요.',analysis_provider_unavailable:'AI 서비스에 연결하지 못해 다시 시도합니다.'};
export default function TicketIntakeStatusView({value,channels,canManage,onRetry}:{value?:TicketIntakeStatus;channels:{id:string;name:string;enabled:boolean}[];canManage:boolean;onRetry:(id?:string)=>Promise<unknown>}){
  const [page,setPage]=useState<TicketIntakeStatus>(),[filter,setFilter]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const data=page||value;
  async function load(offset:number,state=filter){setBusy(true);setError('');try{const response=await fetch(`/api/ticket-automation?intakeOffset=${offset}&intakeState=${encodeURIComponent(state)}`,{cache:'no-store'}),result=await response.json() as {intake:TicketIntakeStatus};if(!response.ok)throw new Error(t('수집 기록을 불러오지 못했습니다.'));setPage(result.intake);setFilter(state);}catch(e){setError(e instanceof Error?e.message:t('불러오지 못했습니다.'));}finally{setBusy(false);}}
  async function retry(id?:string){setBusy(true);try{await onRetry(id);setPage(undefined);}finally{setBusy(false);}}
  return <section aria-label={t('수집 점검')}>
    <h2>{t('수집 점검')}</h2>
    {data?.messages.some(m=>m.state==='retry'&&['ai_daily_limit_reached','ai_budget_exceeded'].includes(m.last_error))&&<p role="status">{t('수집은 계속되며 AI 분석은 한도 초기화까지 대기합니다.')}</p>}
    <p>{t('Slack에서 읽을 수 있는 전체 대화와 댓글을 페이지별로 대조합니다. 분석 실패는 재시도하며, 과거 대화에서 복구한 요청은 수동으로 검토합니다.')}</p>
    <div className="ticket-fields">{data?.counts.map(v=><span key={v.state}>{t(labels[v.state]||v.state)} {v.count}</span>)}{canManage&&<button type="button" className="secondary" disabled={busy} onClick={()=>void retry()}>{t('누락 대조·분석 재시도')}</button>}</div>
    <table className="ticket-intake-table"><caption>{t('고객 채널별 대조 현황')}</caption><thead><tr><th>{t('고객 채널')}</th><th>{t('전체 대화 대조')}</th><th>{t('댓글 대조 대기')}</th><th>{t('최근 확인')}</th></tr></thead><tbody>{channels.filter(c=>c.enabled).map(c=>{const s=data?.channels.find(v=>v.channel_id===c.id);return <tr key={c.id}><td>#{c.name}</td><td>{t(!s?'대조 대기':s.last_error||s.thread_errors?'연결·권한 확인 필요':s.cursor?'이전 대화 대조 중':s.completed_passes?s.pending_threads?'댓글 대조 중':'전체 대조 완료':'대조 중')}{s?.completed_passes?` (${s.completed_passes})`:''}</td><td>{s?.pending_threads??'—'}</td><td>{s?.last_checked_at?new Date(s.last_checked_at).toLocaleString():t('아직 확인 전')}</td></tr>;})}</tbody></table>
    <label>{t('수집 기록 상태')}<select value={filter} disabled={busy} onChange={e=>void load(0,e.target.value)}><option value="">{t('전체')}</option>{Object.entries(labels).map(([id,label])=><option value={id} key={id}>{t(label)}</option>)}</select></label>
    {error&&<p role="alert">{error}</p>}
    <p>{t('수집 기록')} {data?.total||0} · {data?.total?(data.offset||0)+1:0}–{(data?.offset||0)+(data?.messages.length||0)}</p>
    {data?.messages.map(m=><details className="ticket-intake-message" key={m.id}><summary>{channels.find(c=>c.id===m.channel_id)?.name||m.channel_id} · {t(labels[m.state]||m.state)} · {new Date(m.received_at).toLocaleString()}</summary><a href={`https://slack.com/archives/${m.channel_id}/p${m.message_ts.replace('.','')}`} target="_blank" rel="noreferrer">{t('Slack 원문')}</a><p className="ticket-original-text">{m.text||t('첨부 파일이 있는 메시지입니다. 원문을 확인해 주세요.')}</p>{m.last_error&&<p>{m.state==='no_work'?m.last_error:t(reasons[m.last_error]||'원문은 저장되어 있습니다. 연결·분석 상태를 확인한 뒤 재시도합니다.')}</p>}{m.state==='retry'&&m.next_attempt_at&&<p>{t('자동 재시도 예정')} · {new Date(m.next_attempt_at).toLocaleString()}</p>}{canManage&&m.state!=='processing'&&<button type="button" className="secondary" disabled={busy} onClick={()=>void retry(m.id)}>{t('요청으로 다시 검토')}</button>}</details>)}
    <div className="ticket-fields"><button type="button" className="secondary" disabled={busy||!data?.offset} onClick={()=>void load(Math.max(0,(data?.offset||0)-100))}>{t('이전')}</button><button type="button" className="secondary" disabled={busy||!data?.hasMore} onClick={()=>void load((data?.offset||0)+100)}>{t('다음')}</button></div>
  </section>;
}
