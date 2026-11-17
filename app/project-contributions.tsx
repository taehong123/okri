"use client";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { OverlayDialog } from "./overlay-dialog";
import { getClientLocale, t } from "@/lib/client-language";
import type { CompletionContributionInput, ContributionState, ProjectMetric } from "@/lib/project-contributions";
import "./project-contribution.css";
type Save = (input?: CompletionContributionInput) => Promise<boolean>;
const Review = createContext<(id:string,save:Save)=>Promise<boolean>>(async (_id,save)=>save());
const changed = () => window.dispatchEvent(new Event("okri:project-contributions"));
export const useProjectCompletionReview = () => useContext(Review);
export const formatContribution = (value:number,unit:string) => new Intl.NumberFormat(getClientLocale(),{maximumFractionDigits:6}).format(value)+(unit ? " "+unit : "");
const valid = (text:string) => text.trim()!=="" && Number.isFinite(Number(text)) && Number(text)>=0 && Number(text)<=1e12;
async function load(projectId:string,signal?:AbortSignal):Promise<ContributionState>{
  const response=await fetch("/api/project-contributions?projectId="+encodeURIComponent(projectId),{cache:"no-store",signal});
  if(!response.ok)throw new Error("contribution_load_failed");
  return response.json() as Promise<ContributionState>;
}
function errorText(){return t("저장하지 못했습니다. 입력한 내용은 유지됩니다. 다시 시도하거나 현재 저장 상태를 확인해 주세요.");}

export function ProjectContributionProvider({children}:{children:ReactNode}){
  const [pending,setPending]=useState<{state:ContributionState;save:Save;resolve:(ok:boolean)=>void;requestId:string}|null>(null);
  const [actual,setActual]=useState(""),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const locked=useRef(false),savingRef=useRef(false),pendingRef=useRef(pending);
  pendingRef.current=pending;
  useEffect(()=>()=>{pendingRef.current?.resolve(false);},[]);
  async function review(id:string,save:Save){
    if(locked.current)return false;
    locked.current=true;
    try {
      const state=await load(id);
      if(!state.contribution?.enabled || state.contribution.applied)return await save();
      setActual(String(state.contribution.defaultValue));setError("");
      return await new Promise<boolean>(resolve=>setPending({state,save,resolve,requestId:crypto.randomUUID()}));
    }finally{locked.current=false;}
  }
  function close(){if(savingRef.current)return;pending?.resolve(false);setPending(null);}
  async function submit(event:FormEvent){
    event.preventDefault();
    if(!pending || savingRef.current || !valid(actual))return;
    savingRef.current=true;setSaving(true);setError("");
    try{
      const c=pending.state.contribution!;
      const ok=await pending.save({actualValue:Number(actual),expectedVersion:c.version,expectedId:c.id,requestId:pending.requestId});
      if(!ok)throw new Error();
      changed();pending.resolve(true);setPending(null);
    }catch{setError(errorText());}
    finally{savingRef.current=false;setSaving(false);}
  }
  const m=pending?.state.metric;
  return <Review.Provider value={review}>{children}{pending && <OverlayDialog title={t("완료 성과 확인")} initialFocus='input[name="actualContribution"]' onRequestClose={close}>
    <section className="contribution-dialog"><header><h2>{t("완료 성과 확인")}</h2><button className="icon-button" type="button" disabled={saving} onClick={close} aria-label={t("닫기")}><X size={18}/></button></header>
      <form className="property-form" onSubmit={event=>void submit(event)} aria-busy={saving}>
        <p>{pending.state.keyResult?.title}</p>
        <label><span>{t("실제로 얼마나 증가했나요?")}</span><input name="actualContribution" type="number" step="any" min="0" max="1000000000000" required value={actual} disabled={saving} onChange={event=>setActual(event.target.value)} aria-describedby="contribution-preview"/></label>
        <small>{t("기본 기여량 {value}",{value:formatContribution(pending.state.contribution!.defaultValue,m?.unit??"")})}</small>
        {m && <p id="contribution-preview" className="contribution-preview">{formatContribution(m.currentValue,m.unit)} → {formatContribution(m.currentValue+(valid(actual)?Number(actual):0),m.unit)}</p>}
        {error && <p className="contribution-error" role="alert">{error}</p>}
        <footer><button className="secondary" type="button" disabled={saving} onClick={close}>{t("취소")}</button><button className="primary-action" type="submit" disabled={saving||!valid(actual)}>{saving?t("저장 중"):<><Check size={16}/>{t("성과 반영하고 완료")}</>}</button></footer>
      </form>
    </section>
  </OverlayDialog>}</Review.Provider>;
}

export function ProjectContributionSettings({projectId,status,readOnly,onMetricChange}:{projectId:string;status:string;readOnly:boolean;onMetricChange:(metric:ProjectMetric)=>void}){
  const [state,setState]=useState<ContributionState|null>(null),[attempt,setAttempt]=useState(0),[loadError,setLoadError]=useState(false);
  const [open,setOpen]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const [amount,setAmount]=useState(""),[starting,setStarting]=useState(""),[target,setTarget]=useState("100"),[unit,setUnit]=useState("%");
  const saveRef=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();setLoadError(false);
    void load(projectId,controller.signal).then(setState).catch(()=>{if(!controller.signal.aborted)setLoadError(true);});
    return ()=>controller.abort();
  },[projectId,status,attempt]);
  useEffect(()=>{const refresh=()=>setAttempt(value=>value+1);window.addEventListener("okri:project-contributions",refresh);return()=>window.removeEventListener("okri:project-contributions",refresh);},[]);
  function edit(){if(!state)return;setAmount(state.contribution?.enabled?String(state.contribution.defaultValue):"");setStarting(String(state.metric?.currentValue??state.keyResult?.progress??0));setTarget(String(state.metric?.targetValue??100));setUnit(state.metric?.unit??"%");setError("");setOpen(true);}
  async function submit(event:FormEvent){
    event.preventDefault();if(!state||saveRef.current||!valid(amount)||!state.metric&&(!valid(starting)||!valid(target)||Number(target)===0))return;
    saveRef.current=true;setSaving(true);setError("");
    try{
      const response=await fetch("/api/project-contributions",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId,defaultValue:Number(amount),startingValue:Number(starting),targetValue:Number(target),unit,expectedVersion:state.contribution?.version??0,expectedId:state.contribution?.id,expectedMetricVersion:state.metric?.version??0})});
      if(!response.ok)throw new Error();
      const next=await response.json() as ContributionState;setState(next);if(next.metric)onMetricChange(next.metric);setOpen(false);changed();
    }catch{
      setError(errorText());
      // Recover a lost save response or stale revision without clearing typed amounts.
      try { const latest=await load(projectId);if(latest.keyResult?.id===state.keyResult?.id)setState(latest); } catch { /* Retry retains the draft. */ }
    }finally{saveRef.current=false;setSaving(false);}
  }
  const c=state?.contribution,m=state?.metric;
  return <div className="project-contribution">
    {loadError?<p role="alert">{t("성과 설정을 불러오지 못했습니다.")} <button className="secondary" onClick={()=>setAttempt(v=>v+1)}>{t("다시 시도")}</button></p>:!state?<span role="status">{t("데이터를 불러오는 중")}</span>:<>
      <div className="contribution-summary"><b>{t("성과 쌓기")}</b>{c?.enabled&&<span>{c.applied?t("반영한 성과 {value}",{value:formatContribution(c.actualValue??0,m?.unit??"")}):t("기본 기여량 {value}",{value:formatContribution(c.defaultValue,m?.unit??"")})}</span>}</div>
      {!readOnly&&<button className="secondary" type="button" disabled={!state.keyResult||state.apiConnected} onClick={edit}>{c?.enabled?t("기여량 변경"):t("기여량 설정")}</button>}
      {!state.keyResult&&<small>{t("상위 Initiative와 KR을 연결한 뒤 기여량을 설정해 주세요.")}</small>}
      {state.apiConnected&&<small>{t("성과 쌓기를 사용하려면 상위 KR의 API 연결을 먼저 해제해 주세요.")}</small>}
      {m&&<small>{m.title} · {formatContribution(m.currentValue,m.unit)} / {formatContribution(m.targetValue,m.unit)}</small>}
    </>}
    {open&&state&&<OverlayDialog title={t("성과 쌓기 설정")} initialFocus='input[name="defaultContribution"]' onRequestClose={()=>{if(!saveRef.current)setOpen(false);}}>
      <section className="contribution-dialog"><header><h2>{t("성과 쌓기 설정")}</h2><button className="icon-button" type="button" aria-label={t("닫기")} disabled={saving} onClick={()=>setOpen(false)}><X size={18}/></button></header>
        <form className="property-form" onSubmit={event=>void submit(event)} aria-busy={saving}>
          <p>{state.keyResult?.title}</p><label><span>{t("기본 기여량")}</span><input name="defaultContribution" type="number" step="any" min="0" max="1000000000000" required value={amount} disabled={saving} onChange={event=>setAmount(event.target.value)}/></label>
          <small>{t("Project 완료 시 기본값을 보여 드립니다. 실제 증가량으로 바꿔 반영할 수 있습니다.")}</small>
          {!m&&<><div className="contribution-fields"><label><span>{t("KR 현재값")}</span><input type="number" step="any" min="0" required value={starting} disabled={saving} onChange={event=>setStarting(event.target.value)}/></label><label><span>{t("KR 목표값")}</span><input type="number" step="any" min="0.000001" required value={target} disabled={saving} onChange={event=>setTarget(event.target.value)}/></label></div><label><span>{t("단위")}</span><input value={unit} maxLength={24} disabled={saving} onChange={event=>setUnit(event.target.value)}/></label></>}
          {m&&<p>{formatContribution(m.currentValue,m.unit)} / {formatContribution(m.targetValue,m.unit)}</p>}
          {["done","development_done"].includes(status)&&!c?.applied&&<small>{t("설정한 기여량은 다음 완료부터 반영됩니다.")}</small>}
          {error&&<p className="contribution-error" role="alert">{error}</p>}
          <footer><button className="secondary" type="button" disabled={saving} onClick={()=>setOpen(false)}>{t("취소")}</button><button className="primary-action" disabled={saving||!valid(amount)}>{saving?t("저장 중"):t("저장")}</button></footer>
        </form>
      </section>
    </OverlayDialog>}
  </div>;
}
