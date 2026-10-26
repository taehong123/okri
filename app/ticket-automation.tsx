"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, ExternalLink, LoaderCircle, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { t } from "@/lib/client-language";
import { TICKET_STATE_LABELS,TICKET_PRIORITIES,TICKET_PRIORITY_LABELS,type TicketPriority } from "@/lib/ticket-policy";
import { ticketPortInstructions, ticketPortsInstructions } from "@/lib/ticket-port-setup";
import type { TicketAutomationConfig, TicketAutomationRequest, TicketChannelRule,TicketDevelopmentProduct,TicketRepository } from "@/lib/ticket-automation";
import {ticketWorkflow,ticketWarning,ticketSolutionPreview} from '@/lib/ticket-workflow';
import TicketProductSettings from './ticket-product-settings';
import TicketIntakeStatusView from './ticket-intake-status';
import type {TicketIntakeStatus} from '@/lib/ticket-intake-queue';
import {TICKET_CATEGORIES,TICKET_CATEGORY_LABELS,type TicketCategory} from '@/lib/ticket-recommendation';
import "./ticket-automation.css";
type Port = { id: string; member_id: string; name: string; device_id: string | null; enabled: number; online?:boolean; last_seen_at: string | null; model?: string; models_json?: string; channel_ids_json?: string;computer_label?:string;product_id?:string|null;repository_id?:string };
type Data = { intake?:TicketIntakeStatus;requestPage?:{total:number;offset:number;hasMore:boolean};products?:TicketDevelopmentProduct[]; settings: TicketAutomationConfig & { enabled: boolean }; requests: TicketAutomationRequest[]; ports: Port[]; members: { id: string; display_name: string; user_id: string }[]; devices: { id: string; name: string }[]; deliveries?: { id: string; request_id: string; state: string }[]; securityLog?:{id:string;request_id:string;actor_user_id:string;action:string;created_at:string}[]; missingScopes?:string[]; canManage: boolean; userId: string };
const empty: Data = { settings: { enabled: false, destination: "", prefix: "고객-", channels: [], actorUserId: "", notificationsAuthorized: false }, requests: [], ports: [], members: [], devices: [], canManage: false, userId: "" };
type PairingSlot={name:string;code:string;expiresAt:string;channels?:string[];computerLabel?:string;product?:TicketDevelopmentProduct;repository?:TicketRepository};
function setupSlot(slot:PairingSlot){return {name:slot.name,code:slot.code,expiresAt:slot.expiresAt,channels:slot.channels,computerLabel:slot.computerLabel,repository:slot.repository,product:slot.product?{name:slot.product.name,revision:slot.product.revision,specification:slot.product.specification,setupInstructions:slot.product.setup_instructions}:undefined};}
async function request(body?: Record<string, unknown>,query="") {
  const response = await fetch("/api/ticket-automation"+query, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const data = await response.json() as Data & { error?: string }; if (!response.ok) throw new Error(data.error || t("요청을 처리하지 못했습니다.")); return data;
}
export default function TicketAutomation({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<Data>(empty), [settings, setSettings] = useState(empty.settings);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [section, setSection] = useState<"queue" | "ports" | "settings"|"products"|"releases"|"intake">("queue");
  const [categoryFilter,setCategoryFilter]=useState("all");
  const [filter, setFilter] = useState("all"), [selected, setSelected] = useState<string | null>(()=>typeof window==='undefined'?null:new URLSearchParams(window.location.search).get('request'));
  const [channels, setChannels] = useState<{ id: string; name: string; isMember: boolean }[]>([]);
  const refresh = useCallback(async () => { try { const value = await request(); setData(value); setSettings(value.settings); setError(""); } catch(e) { setError(e instanceof Error ? e.message : t("불러오지 못했습니다.")); } finally { setLoaded(true); } }, []);
  useEffect(() => {
    let current=true;
    const requestId=new URLSearchParams(window.location.search).get("request");
    request(undefined,requestId?`?request=${encodeURIComponent(requestId)}`:"").then(value=>{if(current){setData(value);setSettings(value.settings);setError("");}}).catch(e=>{if(current)setError(e instanceof Error?e.message:t("불러오지 못했습니다."));}).finally(()=>{if(current)setLoaded(true);});
    return()=>{current=false;};
  }, [workspaceId]);
  const mutating=useRef(false),mutationEpoch=useRef(0);
  function selectRequest(id:string|null){setSelected(id);const url=new URL(window.location.href);if(id)url.searchParams.set('request',id);else url.searchParams.delete('request');window.history.replaceState(null,'',url);}
  async function mutate(body: Record<string, unknown>) {
    if(mutating.current)return null;mutating.current=true;mutationEpoch.current++;
    setBusy(true); setError(""); try { const result = await request(body); if (result.requests) { setData(result); setSettings(result.settings); } return result; } catch(e) { setError(e instanceof Error ? e.message : t("요청을 처리하지 못했습니다.")); return null; } finally { mutating.current=false;setBusy(false); }
  }
  const visible = data.requests.filter(r => filter === "all" ? true : filter === "unassigned" ? !r.member_id && !["published", "dismissed"].includes(r.state) : filter === "approval" ? ["recommended", "created","security_review"].includes(r.state) : filter === "sharing" ? r.state === "review" : r.state === filter).filter(r=>categoryFilter==="all"||r.category===categoryFilter);
  const active = data.requests.find(r => r.id === selected);
  const activeId=active?.id,activeState=active?.state;
  useEffect(()=>{
    if(!activeId||!activeState||!['queued','running','publishing','waiting_answer','security_review'].includes(activeState))return;
    let cancelled=false,inFlight=false;
    const timer=setInterval(async()=>{if(document.hidden||mutating.current||inFlight)return;inFlight=true;const epoch=mutationEpoch.current;try{const next=await request(undefined,'?request='+encodeURIComponent(activeId));if(!cancelled&&!mutating.current&&epoch===mutationEpoch.current)setData(next);}catch{/* Preserve the last confirmed state and editable inputs while offline. */}finally{inFlight=false;}},activeState==='queued'?2000:5000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[activeId,activeState]);
  const availableModels = [...new Set(data.ports.flatMap(p=>JSON.parse(p.models_json || "[]") as string[]))];
  async function loadChannels() {
    setBusy(true); try { const response = await fetch("/api/slack/channels", { cache: "no-store" }); const result = await response.json() as { error?: string; channels?: { id: string; name: string; isMember: boolean }[] }; if (!response.ok) throw new Error(result.error); setChannels(result.channels ?? []); } catch(e) { setError(e instanceof Error ? e.message : t("채널을 불러오지 못했습니다.")); } finally { setBusy(false); }
  }
  return <section className="ticket-automation" aria-label={t("티켓 자동화")} aria-busy={busy}>
    <div className="ticket-automation-toolbar"><div role="group" aria-label={t("자동화 화면")}>
      <button type="button" className="secondary" aria-pressed={section==='queue'} onClick={()=>setSection('queue')}>{t("처리 현황")}</button><details className="ticket-tools" open={section!=='queue'}><summary>{t("설정·운영")}</summary><div>      {(["intake", "ports", "products","releases","settings"] as const).map(key => <button type="button" className="secondary" key={key} aria-pressed={section===key} onClick={() => setSection(key)}>{t(key === "ports" ? "실행 포트" : key==='products'?'제품·저장소':key==='releases'?'배포 순서':key==='intake'?'수집 점검':"채널 설정")}</button>)}</div></details>
    </div><button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14}/>{t("새로고침")}</button></div>
    {error && <p role="alert">{error}</p>}
    {Boolean(data.deliveries?.length) && <p role="alert">{t("Slack 전송 결과 확인 필요")}: {data.deliveries!.length}</p>}
    {!loaded ? <p role="status">{t("불러오는 중입니다.")}</p> : section === "intake" ? <TicketIntakeStatusView value={data.intake} channels={settings.channels} canManage={data.canManage} onRetry={id=>mutate({operation:"reconcile",...(id?{id}:{})})}/> : section === "queue" ? <>
      {active && <><button type="button" className="secondary" onClick={()=>selectRequest(null)}>{t("목록으로")}</button><TicketRequestEditor key={`${active.id}:${active.revision}`} value={active} data={data} busy={busy} onAction={async p => { const result = await mutate({ operation: "request", id: active.id, revision: active.revision, ...p }); return Boolean(result); }}/></>}
      {!active&&<><label>{t("티켓 분류")}<select value={categoryFilter} onChange={e=>setCategoryFilter(e.target.value)}><option value="all">{t("전체")}</option>{TICKET_CATEGORIES.map(c=><option key={c} value={c}>{t(TICKET_CATEGORY_LABELS[c])}</option>)}</select></label>
      <div className="ticket-queue-filters" role="group" aria-label={t("대기 상태")}>
        {[["all", "전체"], ["unassigned", "담당자 미지정"], ["approval", "승인 대기"], ["sharing", "완료 공유 대기"], ["waiting_answer", "답변 대기"], ["security_review", "작업 내용 확인"], ["blocked", "보안 차단"]].map(([value,label]) => <button type="button" key={value} className="secondary" aria-pressed={filter===value} onClick={() => setFilter(value)}>{t(label)}</button>)}
      </div>
      {!visible.length ? <p className="ticket-automation-empty">{t("해당 상태의 티켓 요청이 없습니다.")}</p> : <div className="ticket-request-list">{visible.map(r => <button className="ticket-request-row" key={r.id} onClick={() => selectRequest(selected===r.id ? null : r.id)} aria-expanded={selected===r.id}>
        <span><strong>{r.title}</strong><small>{t(TICKET_CATEGORY_LABELS[r.category]||'분류 검토')} · {t(TICKET_PRIORITY_LABELS[r.priority]||'보통')} · {data.products?.find(p=>p.id===r.product_id)?.name||t('제품 미지정')} · {settings.channels.find(c=>c.id===r.source_channel)?.name || r.source_channel}</small></span>
        <span>{t(ticketWorkflow(r).label)}</span><span>{r.category==='guidance'?r.requester_name||t('요청자 지정 필요'):data.members.find(m=>m.id===r.member_id)?.display_name || t("담당자 미지정")}</span><span>{r.category==='guidance'?t('회신 작성'):data.ports.find(p=>p.id===r.port_id)?.name || t("자동 배정")}</span>
      </button>)}</div>}
      {data.requestPage&&<div className="ticket-fields"><span>{data.requests.length} / {data.requestPage.total}</span>{data.requestPage.hasMore&&<button type="button" className="secondary" disabled={busy} onClick={async()=>{setBusy(true);try{const next=await request(undefined,`?offset=${data.requestPage!.offset+200}`);setData({...next,requests:[...data.requests,...next.requests.filter(r=>!data.requests.some(v=>v.id===r.id))]});}catch{setError(t("다음 티켓을 불러오지 못했습니다."));}finally{setBusy(false);}}}>{t("티켓 더 불러오기")}</button>}</div>}

      </>}<details><summary>{t("보안·처리 이력")}</summary><ol>{data.securityLog?.map(log=><li key={log.id}><time>{new Date(log.created_at).toLocaleString()}</time> · {log.action} · {data.members.find(m=>m.user_id===log.actor_user_id)?.display_name||log.actor_user_id}{log.request_id&&<> · {data.requests.find(r=>r.id===log.request_id)?.title||log.request_id}</>}</li>)}</ol></details>
    </> : section === "ports" ? <TicketPorts data={data} busy={busy} onMutate={mutate}/> : section==='products'?<TicketProductSettings products={data.products||[]} busy={busy} canManage={data.canManage} onSave={mutate}/>:section==='releases'?<TicketReleaseQueue data={data} busy={busy} onMutate={mutate}/>:<form onSubmit={async e => {e.preventDefault(); await mutate({operation:"settings",...settings});}}>
      <h2>{t("고객 채널 연결")}</h2>
      {!data.canManage && <p>{t("관리자만 채널 설정을 변경할 수 있습니다.")}</p>}
      {Boolean(data.missingScopes?.length)&&data.canManage&&<p>{t("진행·완료 이모지를 사용하려면 Slack 권한을 추가해 주세요.")} <a href="/api/slack/auth?ticket=1&returnTo=%2F%3Fview%3Dtickets%26ticketAutomation%3D1">{t("Slack 이모지 권한 추가")}</a></p>}
      <fieldset disabled={!data.canManage || busy}><label>{t("티켓 공유 채널")}<select value={settings.destination} onChange={e=>setSettings({...settings,destination:e.target.value})}><option value="">{t("채널 선택")}</option>{channels.map(c=><option value={c.id} key={c.id}>#{c.name}</option>)}{settings.destination&&!channels.some(c=>c.id===settings.destination)&&<option value={settings.destination}>{settings.destination}</option>}</select></label>
      <label>{t("워크스페이스 기본 모델")}<select value={settings.defaultModel || ""} onChange={e=>setSettings({...settings,defaultModel:e.target.value})}><option value="">{t("컴퓨터의 Codex 기본 모델")}</option>{availableModels.map(model=><option key={model} value={model}>{model}</option>)}</select></label>
      <div className="ticket-fields"><label>{t("고객 채널 이름 시작")}<input value={settings.prefix} onChange={e=>setSettings({...settings,prefix:e.target.value})}/></label><button className="secondary" type="button" onClick={()=>void loadChannels()}>{t("Slack 채널 불러오기")}</button><button className="secondary" type="button" disabled={!channels.length} onClick={()=>setSettings({...settings,channels:channels.filter(c=>c.id!==settings.destination&&c.name.startsWith(settings.prefix)).map(c=>settings.channels.find(r=>r.id===c.id)??{id:c.id,name:c.name,enabled:true,autoApprove:"manual",memberId:"",portId:""})})}>{t("이름에 맞는 채널 모두 연결")}</button></div>
      <p>{t("비공개 채널은 먼저 채널에서 OKRI 앱을 추가해야 목록에 표시됩니다.")}</p>
      {settings.channels.map((c,index)=><div className="ticket-channel-rule" key={c.id}><label className="ticket-check"><input type="checkbox" checked={c.enabled} onChange={e=>rule(index,{enabled:e.target.checked})}/>#{c.name}</label>
        <ProductSelection products={data.products||[]} productId={c.productId||''} repositoryId={c.repositoryId||''} onChange={(productId,repositoryId)=>rule(index,{productId,repositoryId,portId:''})}/>
        <label>{t("승인 방식")}<select value={c.autoApprove} onChange={e=>rule(index,{autoApprove:e.target.value as TicketChannelRule["autoApprove"]})}><option value="manual">{t("담당자 승인")}</option><option value="low_risk">{t("문구·스타일 자동 승인")}</option></select></label>
        <label>{t("담당자")}<select value={c.memberId} onChange={e=>rule(index,{memberId:e.target.value,portId:""})}><option value="">{t("미지정")}</option>{data.members.map(m=><option value={m.id} key={m.id}>{m.display_name}</option>)}</select></label>
        <label>{t("실행 포트")}<select value={c.portId} onChange={e=>rule(index,{portId:e.target.value})}><option value="">{t("자동 배정")}</option>{data.ports.filter(p=>p.member_id===c.memberId).map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
        <details className="ticket-relay-settings"><summary>{t('중계 앱 요청')}</summary><div className="ticket-fields"><label>{t('허용할 중계 봇 사용자 ID')}<input value={(c.relayUserIds||[]).join(',')} onChange={e=>rule(index,{relayUserIds:e.target.value.split(',').map(v=>v.trim()).filter(Boolean)})}/></label><label>{t('수신 메시지 시작 문구')}<input maxLength={100} value={c.relayPrefix||''} onChange={e=>rule(index,{relayPrefix:e.target.value})}/></label><label>{t('본문 시작 표시')}<input maxLength={100} value={c.relayContentStart||''} onChange={e=>rule(index,{relayContentStart:e.target.value})}/></label><label>{t('본문 끝 표시')}<input maxLength={100} value={c.relayContentEnd||''} onChange={e=>rule(index,{relayContentEnd:e.target.value})}/></label></div><p>{t('허용한 봇의 수신 본문만 분석합니다. 발송 결과는 제외하고 완료 공유 전 실제 Slack 요청자를 지정하세요.')}</p></details>
      </div>)}
      <div className="ticket-security-note"><ShieldCheck size={18}/><p>{t("자동 승인도 보안 검증을 통과해야 실행됩니다. 인증·권한·결제·데이터 변경은 담당자가 검토합니다.")}</p></div>
      <details><summary>{t("Slack 발신 내용 확인")}</summary><p>{t("티켓 공유 채널: 고객 요청 티켓 추천 · 제목 · 원문 링크. 실행 중에는 10분마다 진행 상황, 질문, 완료 검토 안내가 같은 스레드에 추가됩니다.")}</p><p>{t("고객 원문 스레드: 담당자가 최종 문안을 확인하고 공유 승인을 누른 경우에만 완료 안내가 전송됩니다.")}</p></details>
      <label className="ticket-check"><input type="checkbox" checked={settings.notificationsAuthorized} onChange={e=>setSettings({...settings,notificationsAuthorized:e.target.checked})}/>{t("선택한 채널과 발신 내용을 확인하고 OKRI 알림을 허용합니다.")}</label>
      <label className="ticket-check"><input type="checkbox" checked={settings.enabled} onChange={e=>setSettings({...settings,enabled:e.target.checked})}/>{t("티켓 자동화 사용")}</label>
      <button className="primary-action" type="submit" disabled={busy}>{t("설정 저장")}</button></fieldset>
    </form>}
  </section>;
  function rule(index: number, patch: Partial<TicketChannelRule>) {setSettings({...settings,channels:settings.channels.map((c,i)=>i===index?{...c,...patch}:c)});}
}
function TicketPorts({data,busy,onMutate}:{data:Data;busy:boolean;onMutate:(p:Record<string,unknown>)=>Promise<(Data & { code?: string; expiresAt?: string }) | null>}) {
  const self = data.members.find(m=>m.user_id===data.userId);
  const [memberId,setMemberId]=useState(self?.id??""),[prefix,setPrefix]=useState(self?.display_name??""),[count,setCount]=useState(1),[setup,setSetup]=useState(""),[channelId,setChannelId]=useState(""),[computerLabel,setComputerLabel]=useState('PC 01'),[productId,setProductId]=useState(''),[repositoryId,setRepositoryId]=useState('');
  async function add(e:FormEvent){e.preventDefault();await onMutate({operation:"ports",memberId,prefix,count,channelId,computerLabel,productId,repositoryId});}
  async function pair(p:Port){const result=await onMutate({operation:"pair",id:p.id});if(!result)return;const slot=result as unknown as PairingSlot;setSetup(ticketPortInstructions({ ...setupSlot(slot),origin:window.location.origin,channels:data.settings.channels.filter(c=>(JSON.parse(p.channel_ids_json||"[]") as string[]).includes(c.id)).map(c=>c.name) }));}
  return <><h2>{t("실행 포트")}</h2><p>{t("담당자와 개수를 선택해 포트를 만들고, 연결 문구를 본인의 Codex 채팅에 붙여넣으세요.")}</p>
    <form className="ticket-fields" onSubmit={add}>
      <label>{t("담당자")}<select value={memberId} onChange={e=>{setMemberId(e.target.value);setPrefix(data.members.find(m=>m.id===e.target.value)?.display_name??"");}}>{data.members.filter(m=>data.canManage||m.user_id===data.userId).map(m=><option value={m.id} key={m.id}>{m.display_name}</option>)}</select></label>
      <label>{t("이름 앞부분")}<input required maxLength={50} value={prefix} onChange={e=>setPrefix(e.target.value)}/></label><label>{t("개수")}<input type="number" min={1} max={20} value={count} onChange={e=>setCount(Number(e.target.value))}/></label>
      <label>{t('PC 이름')}<input list="ticket-computers" maxLength={80} value={computerLabel} onChange={e=>setComputerLabel(e.target.value)}/><datalist id="ticket-computers">{[...new Set(data.ports.filter(p=>p.member_id===memberId).map(p=>p.computer_label||''))].map(v=><option key={v} value={v}/>)}</datalist></label>
      <label>{t("고객 프로젝트")}<select value={channelId} onChange={e=>{setChannelId(e.target.value);const rule=data.settings.channels.find(c=>c.id===e.target.value);if(rule?.productId){setProductId(rule.productId);setRepositoryId(rule.repositoryId||'');}}}><option value="">{t("미지정")}</option>{data.settings.channels.filter(c=>c.enabled).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <ProductSelection products={data.products||[]} productId={productId} repositoryId={repositoryId} onChange={(p,r)=>{setProductId(p);setRepositoryId(r);}}/>
      <button className="primary-action" disabled={busy||!memberId}><Plus size={14}/>{t("포트 만들기")}</button>
    </form><p>{t('같은 계정으로 PC마다 포트를 나눠 만들 수 있습니다. 연결할 PC 이름을 고른 뒤 그 PC의 Codex에 문구를 붙여넣으세요.')}</p>
    {data.ports.some(p=>p.member_id===self?.id&&!p.device_id&&(p.computer_label||'')===computerLabel)&&<button className="secondary" disabled={busy} onClick={async()=>{const result=await onMutate({operation:"pair_bulk",computerLabel});if(result&&'slots' in result)setSetup(ticketPortsInstructions({origin:window.location.origin,slots:(result.slots as PairingSlot[]).map(setupSlot)}));}}><Copy size={14}/>{t("내 미연결 포트 한 번에 연결")}</button>}
    <div className="ticket-port-list">{data.ports.map(p=>{const owned=p.member_id===self?.id;const current=data.requests.find(r=>r.port_id===p.id&&["queued","running"].includes(r.state));return <div className="ticket-port-row" key={p.id}><div><strong>{p.name}</strong><small>{p.computer_label||t('기본 PC')} · {data.products?.find(v=>v.id===p.product_id)?.name||t('제품 미지정')}</small>{owned&&<details><summary>{t('포트 설정')}</summary><PortConfiguration key={[p.id,p.device_id,p.product_id,p.repository_id,p.computer_label,p.model,p.channel_ids_json].join(":")} port={p} data={data} busy={busy} onMutate={onMutate}/></details>}</div><span>{p.device_id?(p.online?t("연결됨"):t("오프라인")):t("연결 대기")}</span><span>{current?.title||t("배정 대기")}</span>{owned&&<button className="secondary" disabled={busy||!p.product_id||!p.repository_id||!JSON.parse(p.channel_ids_json||"[]").length} onClick={()=>void pair(p)}><Copy size={14}/>{t("연결 문구 만들기")}</button>}</div>;})}</div>
    {setup&&<div className="ticket-port-setup"><label>{t("Codex에 붙여넣을 연결 문구")}<textarea readOnly value={setup} rows={10}/></label><button className="secondary" onClick={async()=>{await navigator.clipboard.writeText(setup);}}><Copy size={14}/>{t("문구 복사")}</button><p>{t("연결 코드는 10분 동안 한 번 사용할 수 있습니다. 새 문구를 만들면 이전 미사용 코드는 만료됩니다.")}</p></div>}
  </>;
}
function PortConfiguration({port:p,data,busy,onMutate}:{port:Port;data:Data;busy:boolean;onMutate:(p:Record<string,unknown>)=>Promise<unknown>}) {
  const initial=JSON.parse(p.channel_ids_json||'[]') as string[];
  const [channels,setChannels]=useState(initial.length>1?'all':initial[0]||''),[model,setModel]=useState(p.model||''),[computer,setComputer]=useState(p.computer_label||''),[product,setProduct]=useState(p.product_id||''),[repository,setRepository]=useState(p.repository_id||'');
  const save=(patch:Record<string,unknown>={})=>onMutate({operation:'bind',id:p.id,deviceId:p.device_id||'',enabled:Boolean(p.enabled),model,computerLabel:computer,productId:product,repositoryId:repository,channelIds:channels==='all'?data.settings.channels.filter(c=>c.enabled).map(c=>c.id):channels?[channels]:[],...patch});
  return <form onSubmit={async e=>{e.preventDefault();await save();}}><fieldset disabled={busy}>
    <label>{t('PC 이름')}<input disabled={Boolean(p.device_id)} value={computer} onChange={e=>setComputer(e.target.value)}/></label>
    <ProductSelection disabled={Boolean(p.device_id)} products={data.products||[]} productId={product} repositoryId={repository} onChange={(id,repo)=>{setProduct(id);setRepository(repo);}}/>
    <label>{t('고객 프로젝트')}<select value={channels} onChange={e=>setChannels(e.target.value)}><option value="">{t('미지정')}</option>{data.settings.channels.filter(c=>c.enabled).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}<option value="all">{t('연결된 모든 고객')}</option></select></label>
    <label>{t('포트 모델')}<select value={model} onChange={e=>setModel(e.target.value)}><option value="">{t('워크스페이스 기본 모델')}</option>{(JSON.parse(p.models_json||'[]') as string[]).map(id=><option value={id} key={id}>{id}</option>)}</select></label>
    <button className="secondary">{t('포트 설정 저장')}</button>{p.device_id&&<button type="button" className="secondary" onClick={()=>void save({deviceId:''})}>{t('연결 해제')}</button>}
  </fieldset></form>;
}
function ProductSelection({products,productId,repositoryId,onChange,disabled=false}:{products:TicketDevelopmentProduct[];productId:string;repositoryId:string;onChange:(productId:string,repositoryId:string)=>void;disabled?:boolean}) {
  const repositories:TicketRepository[]=JSON.parse(products.find(p=>p.id===productId)?.repositories_json||'[]');
  return <><label>{t('제품')}<select disabled={disabled} value={productId} onChange={e=>{const repos:TicketRepository[]=JSON.parse(products.find(p=>p.id===e.target.value)?.repositories_json||'[]');onChange(e.target.value,repos.length===1?repos[0].id:'');}}><option value="">{t('미지정')}</option>{products.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label><label>{t('Git 저장소')}<select disabled={disabled||!productId} value={repositoryId} onChange={e=>onChange(productId,e.target.value)}><option value="">{t('미지정')}</option>{repositories.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label></>;
}
function TicketReleaseQueue({data,busy,onMutate}:{data:Data;busy:boolean;onMutate:(p:Record<string,unknown>)=>Promise<unknown>}) {
  const self=data.members.find(m=>m.user_id===data.userId);
  const queue=data.requests.filter(r=>r.ticket_id&&!['dismissed','blocked','failed'].includes(r.state));
  return <><h2>{t('배포 순서')}</h2><p>{t('선행 티켓이 반영된 작업부터 긴급·높음·보통·낮음 순으로 검토합니다. 진행 중인 개발은 강제로 중단하지 않습니다.')}</p><p>{t('개발 포트는 검토용 패치를 준비합니다. 실제 병합·배포는 별도 승인 절차로 수행하고 확인한 Git 커밋을 기록하세요.')}</p>
    {!queue.length&&<p>{t('배포 검토할 티켓이 없습니다.')}</p>}
    {queue.map(r=>{const dependencies=JSON.parse(r.dependencies_json||'[]') as string[],waiting=dependencies.some(id=>!data.requests.find(v=>v.id===id)?.release_commit),plan=JSON.parse(r.coordination_json||'{}');return <article className="ticket-release-row" key={r.id}><p>{t(TICKET_PRIORITY_LABELS[r.priority]||'보통')} · {r.title}</p><p>{data.products?.find(v=>v.id===r.product_id)?.name} · {r.release_commit?t('반영 확인됨'):waiting?t('선행 티켓 대기'):t(TICKET_STATE_LABELS[r.state])}</p>
      {dependencies.length>0&&<ul>{dependencies.map(id=><li key={id}>{data.requests.find(v=>v.id===id)?.title||id}</li>)}</ul>}
      {plan.paths?.length>0&&<details><summary>{t('포트 공유 계획')}</summary><ul>{(plan.paths as string[]).map(path=><li key={path}>{path}</li>)}</ul></details>}
      {['review','published'].includes(r.state)&&!r.release_commit&&<ReleaseConfirmation key={`${r.id}:${r.revision}`} disabled={busy||waiting||(!data.canManage&&self?.id!==r.member_id)} onConfirm={(commit,acknowledged)=>onMutate({operation:'request',action:'release_confirm',id:r.id,revision:r.revision,commit,acknowledged})}/>}
      {r.release_commit&&<code>{r.release_commit}</code>}
    </article>;})}
  </>;
}
function ReleaseConfirmation({disabled,onConfirm}:{disabled:boolean;onConfirm:(commit:string,acknowledged:boolean)=>Promise<unknown>}) {
  const [commit,setCommit]=useState(''),[ack,setAck]=useState(false);
  return <form onSubmit={async e=>{e.preventDefault();await onConfirm(commit,ack);}}><fieldset disabled={disabled}><label>{t('반영 Git 커밋')}<input maxLength={64} value={commit} onChange={e=>setCommit(e.target.value)}/></label><label className="ticket-check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>{t('실제 병합·배포 결과를 직접 확인했습니다.')}</label><button className="secondary" disabled={!ack||!/^[a-f0-9]{40,64}$/.test(commit)}>{t('반영 확인 기록')}</button></fieldset></form>;
}
function TicketRequestEditor({value:r,data,busy,onAction}:{value:TicketAutomationRequest;data:Data;busy:boolean;onAction:(p:Record<string,unknown>)=>Promise<boolean>}) {
  const self=data.members.find(m=>m.user_id===data.userId);
  const [title,setTitle]=useState(r.title),[description,setDescription]=useState(r.description),[memberId,setMember]=useState(r.member_id||self?.id||""),[portId,setPort]=useState(r.port_id??""),[notice,setNotice]=useState(r.notice||(r.category==='guidance'?r.description.split('안내 초안\n')[1]?.split('\n\n완료 확인 기준')[0]||'':'')),[answer,setAnswer]=useState("");
  const [category,setCategory]=useState<TicketCategory>(r.category||"improvement");
  const [priority,setPriority]=useState<TicketPriority>(r.priority||'medium'),[productId,setProduct]=useState(r.product_id||''),[repositoryId,setRepository]=useState(r.repository_id||''),[dependencies,setDependencies]=useState<string[]>(JSON.parse(r.dependencies_json||'[]'));
  const editable=["recommended","created"].includes(r.state),dirty=category!==(r.category||"improvement")||title!==r.title||description!==r.description||memberId!==(r.member_id??"")||portId!==(r.port_id??"")||priority!==(r.priority||'medium')||productId!==(r.product_id||'')||repositoryId!==(r.repository_id||'')||JSON.stringify(dependencies)!==JSON.stringify(JSON.parse(r.dependencies_json||'[]'));
  const allowed=data.canManage||self?.id===r.member_id;
  const scopeDirty=category!==r.category||title!==r.title||description!==r.description||priority!==(r.priority||'medium')||JSON.stringify(dependencies)!==JSON.stringify(JSON.parse(r.dependencies_json||'[]'));
  return <section className="ticket-request-detail" aria-label={t("요청 검토")}><TicketWorkflowProgress value={r} busy={busy}/><a href={`https://slack.com/archives/${r.source_channel}/p${r.source_ts.replace(".","")}`} target="_blank" rel="noreferrer"><ExternalLink size={14}/>{t("Slack 원문")}</a>
    {(r.member_id||r.port_id)&&<TicketExecutionAssignment value={r} data={data}/>}
    {(r.risk==="blocked"||r.state==="blocked")&&<p role="alert">{t("보안 검증에서 차단된 요청입니다. 승인으로 우회할 수 없습니다.")}</p>}
    <ul className="ticket-request-summary"><li>{t('고객사')}: {data.settings.channels.find(c=>c.id===r.source_channel)?.name||r.source_channel}</li><li>{t('요청자')}: {r.requester_name||r.requester_slack_user||t('미지정')}</li><li>{t('요구사항')}: {r.title}</li><li>{t('분류')}: {t(TICKET_CATEGORY_LABELS[r.category]||'분류 검토')}</li></ul>
    {r.category!=='guidance'&&ticketSolutionPreview(r.description)&&<p className="ticket-solution">{t('해결 제안')}: {ticketSolutionPreview(r.description)}</p>}
    <details><summary>{t("고객 원문 대화")}</summary><p className="ticket-original-text">{r.source_text}</p></details>
    <fieldset disabled={busy||!allowed}>
    {editable&&r.category!=='guidance'&&<><p className="ticket-assignment">{data.members.find(m=>m.id===memberId)?.display_name||t("담당자 미지정")} · {data.ports.find(p=>p.id===portId)?.name||t("자동 배정")}</p><details open={!memberId||!productId||!repositoryId}><summary>{t("담당자·포트 변경")}</summary><div className="ticket-fields"><label>{t('담당자')}<select value={memberId} onChange={e=>{setMember(e.target.value);setPort('');}}><option value="">{t('미지정')}</option>{data.members.map(m=><option key={m.id} value={m.id}>{m.display_name}</option>)}</select></label><label>{t('실행 포트')}<select value={portId} onChange={e=>setPort(e.target.value)}><option value="">{t('자동 배정')}</option>{data.ports.filter(p=>p.member_id===memberId&&p.product_id===productId&&p.repository_id===repositoryId).map(p=><option key={p.id} value={p.id}>{p.name} · {p.computer_label}{p.online?'':` · ${t('오프라인')}`}</option>)}</select></label>{(!r.product_id||!r.repository_id)&&<ProductSelection products={data.products||[]} productId={productId} repositoryId={repositoryId} onChange={(p,repo)=>{setProduct(p);setRepository(repo);setPort('');}}/>}</div></details><button className="primary-action" disabled={scopeDirty||!memberId||!productId||!repositoryId||r.risk==='blocked'} onClick={()=>void onAction({action:'start',memberId,portId,productId,repositoryId})}>{busy?<LoaderCircle size={14} className="ticket-working"/>:<Check size={14}/>} {t('개발 승인')}</button>{r.port_id&&<p>{data.ports.find(p=>p.id===r.port_id)?.name}</p>}</>}
    {(r.state==='review'||editable&&r.category==='guidance')&&<><details open={!r.requester_slack_user}><summary>{t('요청자 변경')}</summary><RequesterEditor value={r} onAction={onAction}/></details><label>{t('회신 내용')}<textarea value={notice} maxLength={4000} rows={5} onChange={e=>setNotice(e.target.value)}/></label><button className="primary-action" disabled={!notice.trim()||!r.requester_slack_user||r.risk==='blocked'} onClick={()=>void onAction({action:'reply',notice,requesterSlackUser:r.requester_slack_user})}>{t('승인하고 보내기')}</button></>}
    {r.state==="security_review"&&<TicketSecurityWarning value={r} onAction={onAction}/>}
    <details><summary>{t('상세·수정')}</summary><p>{t('추천 모델')}: {JSON.parse(r.analysis_json||'{}').model||t('분석 대기')}</p><RequesterEditor value={r} onAction={onAction}/><label>{t("제목")}<input value={title} readOnly={!editable} onChange={e=>setTitle(e.target.value)}/></label><label>{t("요청 내용")}<textarea value={description} readOnly={!editable} rows={6} onChange={e=>setDescription(e.target.value)}/></label>
    {editable&&<><div className="ticket-fields"><label>{t("분류")}<select value={category} onChange={e=>setCategory(e.target.value as TicketCategory)}>{TICKET_CATEGORIES.map(v=><option key={v} value={v}>{t(TICKET_CATEGORY_LABELS[v])}</option>)}</select></label><label>{t('우선순위')}<select value={priority} onChange={e=>setPriority(e.target.value as TicketPriority)}>{TICKET_PRIORITIES.map(p=><option key={p} value={p}>{t(TICKET_PRIORITY_LABELS[p])}</option>)}</select></label>
      <ProductSelection products={data.products||[]} productId={productId} repositoryId={repositoryId} onChange={(p,repo)=>{setProduct(p);setRepository(repo);setPort('');setDependencies([]);}}/>
      <label>{t("담당자")}<select value={memberId} onChange={e=>{setMember(e.target.value);setPort("");}}><option value="">{t("미지정")}</option>{data.members.map(m=><option key={m.id} value={m.id}>{m.display_name}</option>)}</select></label><label>{t("실행 포트")}<select value={portId} onChange={e=>setPort(e.target.value)}><option value="">{t("자동 배정")}</option>{data.ports.filter(p=>p.member_id===memberId&&p.product_id===productId&&p.repository_id===repositoryId).map(p=><option key={p.id} value={p.id}>{p.name} · {p.computer_label}</option>)}</select></label></div>
      <label>{t('선행 티켓')}<select multiple value={dependencies} onChange={e=>setDependencies(Array.from(e.target.selectedOptions,v=>v.value))}>{data.requests.filter(v=>v.id!==r.id&&v.product_id===productId&&v.repository_id===repositoryId&&v.state!=='dismissed').map(v=><option key={v.id} value={v.id}>{v.title}</option>)}</select></label>
      <div className="ticket-fields"><button type="button" className="secondary" disabled={!dirty} onClick={()=>void onAction({action:"edit",category,title,description,memberId,portId,priority,productId,repositoryId,dependencies})}>{t("수정 저장")}</button></div></>}
    {r.state==='security_review'&&ticketWarning(r.security_json).approvable&&<button className="secondary" onClick={()=>void onAction({action:'recheck'})}>{t('보안 검사 다시 실행')}</button>}
    {["recommended","created","security_review","blocked","failed"].includes(r.state)&&<div className="ticket-fields"><button className="secondary" onClick={()=>void onAction({action:"refresh_source"})}>{t("원문 다시 검토")}</button><button className="secondary" onClick={()=>void onAction({action:"dismiss"})}>{t("요청 제외")}</button></div>}
    {['queued','running','waiting_answer'].includes(r.state)&&<button className="secondary" onClick={()=>void onAction({action:'stop'})}>{t('실행 중지')}</button>}
    </details>
    {r.state==='publishing'&&<><p>{t('승인한 완료 안내의 전송을 기다리고 있습니다.')}</p><button className="secondary" onClick={()=>void onAction({action:'cancel_publish'})}>{t('전송 전 취소하고 문안 수정')}</button></>}
    {r.state==="waiting_answer"&&<><p>{r.question}</p><label>{t("담당자 답변")}<textarea rows={3} value={answer} onChange={e=>setAnswer(e.target.value)}/></label><button className="primary-action" disabled={!answer.trim()} onClick={()=>void onAction({action:"answer_resume",answer})}>{t("답변하고 계속 진행")}</button></>}
    </fieldset></section>;
}
function TicketExecutionAssignment({value:r,data}:{value:TicketAutomationRequest;data:Data}){
  const port=data.ports.find(p=>p.id===r.port_id),member=data.members.find(m=>m.id===r.member_id);
  return <dl className="ticket-execution" aria-label={t('개발 배정')}><div><dt>{t('담당자')}</dt><dd>{member?.display_name||t('확인 필요')}</dd></div><div><dt>{t('PC 이름')}</dt><dd>{port?.computer_label||t('기본 PC')}</dd></div><div><dt>{t('실행 포트')}</dt><dd>{port?.name||t('배정 대기')}</dd></div><div><dt>{t('모델')}</dt><dd>{port?.model||data.settings.defaultModel||t('기본 모델 상속')}</dd></div></dl>;
}
function TicketWorkflowProgress({value:r,busy}:{value:TicketAutomationRequest;busy:boolean}){
  const flow=ticketWorkflow(r),guidance=r.category==='guidance',steps=guidance?['승인','회신','완료']:['승인','개발','회신','완료'],currentStep=guidance?Math.max(0,flow.step-1):flow.step;
  return <div className="ticket-workflow"><ol data-guidance={guidance} aria-label={t('티켓 진행 단계')}>{steps.map((label,i)=><li key={label} aria-current={i===currentStep?'step':undefined} data-complete={i<currentStep}><span aria-hidden="true">{i===currentStep&&['queued','running','publishing'].includes(r.state)?<LoaderCircle size={14} className="ticket-working"/>:i<currentStep?<Check size={14}/>:i+1}</span>{t(label)}</li>)}</ol><div role="status" aria-live="polite" aria-atomic="true"><strong>{busy?<><LoaderCircle size={16} className="ticket-working"/>{t('처리 중…')}</>:t(flow.label)}</strong><p>{busy?t('완료되면 다음 단계가 여기에 표시됩니다.'):t(flow.next)}</p></div></div>;
}
function TicketSecurityWarning({value:r,onAction}:{value:TicketAutomationRequest;onAction:(p:Record<string,unknown>)=>Promise<boolean>}) {
  const warning=ticketWarning(r.security_json||'{}');
  return <div className="ticket-approval"><p>{t('개발 시작 전 확인')}</p><ul>{warning.labels.map(label=><li key={label}>{t(label)}</li>)}</ul>{warning.approvable&&<button className="primary-action" onClick={()=>void onAction({action:'approve_warning'})}><Check size={14}/>{t('개발 시작')}</button>}</div>;
}
function RequesterEditor({value:r,onAction}:{value:TicketAutomationRequest;onAction:(p:Record<string,unknown>)=>Promise<boolean>}) {
  const [query,setQuery]=useState(""),[users,setUsers]=useState(r.requester_slack_user?[{id:r.requester_slack_user,name:r.requester_name||r.requester_slack_user}]:[]),[selected,setSelected]=useState(r.requester_slack_user||''),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function search(){setBusy(true);setError("");try{const result=await request({operation:"requester_options",id:r.id,query}) as unknown as {users:{id:string;name:string}[]};setUsers(result.users);}catch(e){setError(e instanceof Error?e.message:t("불러오지 못했습니다."));}finally{setBusy(false);}}
  return <div><p>{t("요청자")}: {r.requester_slack_user?'@'+(r.requester_name||r.requester_slack_user):t('요청자 지정 필요')}</p>{["recommended","created","review"].includes(r.state)&&<><div className="ticket-fields"><label>{t("Slack 요청자 검색")}<input value={query} onChange={e=>setQuery(e.target.value)} /></label><button type="button" className="secondary" disabled={busy} onClick={()=>void search()}>{t("Slack에서 찾기")}</button></div><div className="ticket-fields"><label>{t("완료 안내 요청자")}<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">{t('미지정')}</option>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label><button type="button" className="secondary" disabled={busy||!selected||selected===r.requester_slack_user} onClick={()=>void onAction({action:"requester",requesterSlackUser:selected})}>{t("요청자 지정")}</button></div>{error&&<p role="alert">{error}</p>}</>}{r.state==="review"&&<p>{t("승인한 완료 안내 앞에 이 요청자의 Slack 멘션이 포함됩니다.")}</p>}</div>;
}
