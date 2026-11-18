"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, X } from "lucide-react";
import type { KrSourceMode, KrSourceSettings } from "@/lib/kr-data-sources";
import { t } from "@/lib/client-language";
import { OverlayDialog } from "./overlay-dialog";
import { formatContribution } from "./project-contributions";
import "./kr-metrics.css";
import ProjectContributionScheduleDialog from "./project-contribution-schedule";

type Draft={mode:KrSourceMode;starting:string;target:string;unit:string;projects:Record<string,string>;api:{name:string;endpointUrl:string;valuePath:string;baseline:string;target:string;unit:string;cadence:string;active:boolean}};
function draftFor(s:KrSourceSettings):Draft {
  return {mode:s.mode??"projects",starting:String(s.metric?.startingValue??s.keyResult.progress),target:String(s.metric?.targetValue??100),unit:s.metric?.unit??"%",
    projects:Object.fromEntries(s.projects.map(p=>[p.id,p.defaultValue===null?"":String(p.defaultValue)])),
    api:{name:s.api?.name??"",endpointUrl:s.api?.endpointUrl??"",valuePath:s.api?.valuePath??"",baseline:String(s.api?.baselineValue??0),target:String(s.api?.targetValue??100),unit:s.api?.unit??"",cadence:s.api?.cadence??"daily",active:s.api?.active??true}};
}
export default function KrSourceSettingsDialog({keyResultId,onClose,onSaved}:{keyResultId:string;onClose:()=>void;onSaved:(settings:KrSourceSettings)=>void}) {
  const [state,setState]=useState<KrSourceSettings|null>(null),[draft,setDraft]=useState<Draft|null>(null),[initial,setInitial]=useState(""),[error,setError]=useState(""),[attempt,setAttempt]=useState(0),[saving,setSaving]=useState(false),[conflict,setConflict]=useState(false);
  const savingRef=useRef(false);
  const [scheduledProject,setScheduledProject]=useState<string|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    void fetch("/api/kr-data-sources?keyResultId="+encodeURIComponent(keyResultId),{cache:"no-store",signal:controller.signal})
      .then(async r=>{if(!r.ok)throw new Error();return r.json() as Promise<KrSourceSettings>;})
      .then(s=>{if(controller.signal.aborted)return;const d=draftFor(s);setState(s);setDraft(d);setInitial(JSON.stringify(d));})
      .catch(()=>{if(!controller.signal.aborted)setError(t("KR 설정을 불러오지 못했습니다."));});
    return()=>controller.abort();
  },[keyResultId,attempt]);
  function reload(){setError("");setState(null);setDraft(null);setConflict(false);setAttempt(v=>v+1);}
  async function submit(event:FormEvent){
    event.preventDefault();if(!draft||!state||savingRef.current||conflict)return;
    savingRef.current=true;setSaving(true);setError("");
    try{
      const response=await fetch("/api/kr-data-sources",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({keyResultId,revision:state.revision,mode:draft.mode,
        startingValue:Number(draft.starting),targetValue:Number(draft.target),unit:draft.unit,
        projects:state.projects.map(p=>({id:p.id,defaultValue:draft.projects[p.id].trim()===""?null:Number(draft.projects[p.id])})),
        api:{...draft.api,baselineValue:Number(draft.api.baseline),targetValue:Number(draft.api.target)}})});
      if(!response.ok){if(response.status===409)setConflict(true);throw new Error();}
      const next=await response.json() as KrSourceSettings;
      onSaved(next);window.dispatchEvent(new Event("okri:project-contributions"));window.dispatchEvent(new Event("okri:kr-data-sources"));onClose();
    }catch{setError(t("저장하지 못했습니다. 입력한 내용은 유지됩니다. 다른 변경이 있었다면 최신 설정을 불러와 확인해 주세요."));}
    finally{savingRef.current=false;setSaving(false);}
  }
  const api=draft?.api;
  const earned=state?.metric?(state.metric.currentValue-state.metric.startingValue):0;
  const dirty=Boolean(draft&&JSON.stringify(draft)!==initial);
  return <><OverlayDialog title={t("KR 데이터 설정")} variant="drawer" dirty={dirty} onRequestClose={()=>{if(!savingRef.current)onClose();}}>
    {requestClose=><aside className="property-panel kr-data-panel kr-source-panel">
      <header><div><h2>{t("KR 데이터 설정")}</h2><p>{state?.keyResult.title??t("측정 방식을 선택해 주세요.")}</p></div><button className="icon-button" disabled={saving} onClick={()=>requestClose("close-button")} aria-label={t("KR 데이터 설정 닫기")}><X size={18}/></button></header>
      {!draft||!state?<div className="kr-source-status">{error?<><p role="alert">{error}</p><button onClick={reload}>{t("다시 시도")}</button></>:<p role="status">{t("데이터를 불러오는 중")}</p>}</div>:<form className="property-form" onSubmit={event=>void submit(event)} aria-busy={saving}>
        <fieldset className="kr-source-options" disabled={saving}><legend>{t("KR 수치 반영 방식")}</legend>
          <label aria-label={t("Project 성과 합산")}><input type="radio" name="krSource" value="projects" checked={draft.mode==="projects"} onChange={()=>setDraft({...draft,mode:"projects"})}/><span><b>{t("Project 성과 합산")}</b><small>{t("Project 완료 성과와 운영 중 쌓이는 기여량을 KR에 더합니다.")}</small></span></label>
          <label aria-label={t("API 연동")}><input type="radio" name="krSource" value="api" checked={draft.mode==="api"} onChange={()=>setDraft({...draft,mode:"api"})}/><span><b>{t("API 연동")}</b><small>{t("외부 API의 실제 수치로 KR을 갱신합니다.")}</small></span></label>
        </fieldset>
        <fieldset className="kr-source-fields" disabled={saving}>
        {draft.mode==="projects"?<>
          <div className="kr-data-number-grid"><label><span>{t("시작값")}</span><input type="number" step="any" min="0" max="1000000000000" required value={draft.starting} onChange={e=>setDraft({...draft,starting:e.target.value})}/></label><label><span>{t("목표값")}</span><input type="number" step="any" min="0.000000001" max="1000000000000" required value={draft.target} onChange={e=>setDraft({...draft,target:e.target.value})}/></label></div>
          <label><span>{t("단위")}</span><input maxLength={24} value={draft.unit} onChange={e=>setDraft({...draft,unit:e.target.value})} placeholder={t("예: 원, 명, %")}/></label>
          <p className="kr-source-preview">{t("현재값")} <strong>{formatContribution(Number(draft.starting||0)+earned,draft.unit)}</strong><small>{t("시작값에 이미 반영한 Project 성과를 더한 값입니다.")}</small></p>
          <div className="kr-source-projects"><h3>{t("Project별 기본 기여량")}</h3><p>{t("완료할 때 실제 증가량을 확인합니다. 비워두면 다음 완료부터 합산하지 않습니다.")}</p>
          {state.projects.map(p=><div className="kr-source-project" key={p.id}><label><span>{p.title}{p.applied&&<small>{t("반영한 성과 {value}",{value:formatContribution(p.actualValue??0,draft.unit)})}</small>}{p.schedule?<small>{p.schedule.mode==="daily"?t("매일"):p.schedule.mode==="business_days"?t("영업일마다"):t("1회성")} · {t("추정")} {formatContribution(p.schedule.accruedValue,draft.unit)}</small>:["done","development_done"].includes(p.status)&&!p.applied&&<small>{t("설정한 기여량은 다음 완료부터 반영됩니다.")}</small>}</span><input disabled={Boolean(p.schedule)} aria-label={t("{title} 기본 기여량",{title:p.title})} type="number" step="any" min="0" max="1000000000000" value={p.schedule?String(p.schedule.amount):draft.projects[p.id]} placeholder="—" onChange={e=>setDraft({...draft,projects:{...draft.projects,[p.id]:e.target.value}})}/></label><button className="secondary" type="button" disabled={dirty||state.mode!=="projects"} onClick={()=>setScheduledProject(p.id)}>{t("KR 기여 방식")}</button></div>)}
          {(dirty||state.mode!=="projects")&&<small>{t("KR 설정을 먼저 저장한 뒤 Project별 기여 방식을 설정할 수 있습니다.")}</small>}
          {!state.projects.length&&<p>{t("이 KR의 Initiative 아래에 Project를 연결하면 기본 기여량을 설정할 수 있습니다.")}</p>}</div>
          <small>{t("Project 자체의 API 연결은 별도로 유지됩니다.")}</small>
        </>:api&&<>
          <p className="kr-source-hint">{t("인증이 필요 없는 HTTPS JSON GET API를 연결할 수 있습니다.")}</p>
          <label><span>{t("데이터 소스 이름")}</span><input required maxLength={120} value={api.name} onChange={e=>setDraft({...draft,api:{...api,name:e.target.value}})}/></label>
          <label><span>API URL</span><input type="url" required value={api.endpointUrl} onChange={e=>setDraft({...draft,api:{...api,endpointUrl:e.target.value}})} placeholder="https://api.example.com/metrics"/></label>
          <label><span>{t("숫자 값 경로")}</span><input value={api.valuePath} onChange={e=>setDraft({...draft,api:{...api,valuePath:e.target.value}})} placeholder="data.value"/><small>{t("응답 자체가 숫자면 비워두세요. 배열은 data.items[0].value처럼 입력합니다.")}</small></label>
          <div className="kr-data-number-grid"><label><span>{t("기준값")}</span><input required type="number" step="any" value={api.baseline} onChange={e=>setDraft({...draft,api:{...api,baseline:e.target.value}})}/></label><label><span>{t("목표값")}</span><input required type="number" step="any" value={api.target} onChange={e=>setDraft({...draft,api:{...api,target:e.target.value}})}/></label></div>
          <label><span>{t("단위")}</span><input maxLength={24} value={api.unit} onChange={e=>setDraft({...draft,api:{...api,unit:e.target.value}})}/></label>
          <label><span>{t("자동 갱신 주기")}</span><select value={api.cadence} onChange={e=>setDraft({...draft,api:{...api,cadence:e.target.value}})}>{[["hourly",t("매시간")],["daily",t("매일")],["weekly",t("매주")],["manual",t("수동만")]].map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
          <label className="kr-data-active"><input type="checkbox" checked={api.active} onChange={e=>setDraft({...draft,api:{...api,active:e.target.checked}})}/><span>{t("자동 갱신 활성화")}</span></label>
          {state.metric&&<small>{t("Project 기본값과 기존 성과는 보존됩니다. API 방식에서는 새 Project 성과를 합산하지 않습니다.")}</small>}
        </>}
        </fieldset>
        {error&&<p className="kr-data-error" role="alert">{error}</p>}
        {conflict&&<button type="button" className="secondary" onClick={reload}>{t("최신 설정 불러오기")}</button>}
        <button type="submit" disabled={saving||conflict||(draft.mode==="api"&&api?.baseline===api?.target)}>{saving?t("저장 중"):<><Check size={15}/>{t("설정 저장")}</>}</button>
      </form>}
    </aside>}
  </OverlayDialog>{scheduledProject&&<ProjectContributionScheduleDialog projectId={scheduledProject} onClose={()=>setScheduledProject(null)} onSaved={()=>{reload();void fetch("/api/kr-data-sources?keyResultId="+encodeURIComponent(keyResultId),{cache:"no-store"}).then(async response=>{if(response.ok)onSaved(await response.json() as KrSourceSettings);}).catch(()=>{});}}/>}</>;
}
