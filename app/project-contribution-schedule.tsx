"use client";
import {useEffect,useRef,useState,type FormEvent} from "react";
import {X} from "lucide-react";
import {OverlayDialog} from "./overlay-dialog";
import {getClientLocale,t} from "@/lib/client-language";
import {localDate,scheduleCredits,scheduleInput,type MetricCalendar} from "@/lib/project-metric-schedule-model";
import type {ProjectScheduleState} from "@/lib/project-metric-schedules";
import "./project-contribution.css";
import "./contribution-schedule.css";
type Draft={mode:"once"|"business_days"|"daily";amount:string;startDate:string;endDate:string;pauses:{startDate:string;endDate:string}[]};
const format=(amount:number,unit:string)=>new Intl.NumberFormat(getClientLocale(),{maximumFractionDigits:6}).format(amount)+(unit?" "+unit:"");
const modeLabel=(mode:string)=>mode==="daily"?t("매일"):mode==="business_days"?t("영업일마다"):t("1회성");
export default function ProjectContributionScheduleDialog({projectId,onClose,onSaved}:{projectId:string;onClose:()=>void;onSaved:()=>void}) {
  const [state,setState]=useState<ProjectScheduleState|null>(null),[draft,setDraft]=useState<Draft|null>(null),[initial,setInitial]=useState("");
  const [calendar,setCalendar]=useState<MetricCalendar|null>(null),[timezone,setTimezone]=useState("Asia/Seoul"),[holidays,setHolidays]=useState(""),[canEditCalendar,setCanEditCalendar]=useState(false);
  const [attempt,setAttempt]=useState(0),[error,setError]=useState(""),[calendarError,setCalendarError]=useState(""),[calendarNotice,setCalendarNotice]=useState(""),[saving,setSaving]=useState(false),[savingCalendar,setSavingCalendar]=useState(false),[conflict,setConflict]=useState(false);
  const lock=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.all([fetch("/api/project-contribution-schedules?projectId="+encodeURIComponent(projectId),{cache:"no-store",signal:controller.signal}),fetch("/api/metric-calendar",{cache:"no-store",signal:controller.signal})])
      .then(async([r,c])=>{if(!r.ok||!c.ok)throw new Error();return [await r.json() as ProjectScheduleState,await c.json() as {calendar:MetricCalendar;canEdit:boolean}] as const;})
      .then(([next,cal])=>{
        if(controller.signal.aborted)return;const s=next.schedule;
        const value:Draft={mode:s?.mode==="weekly"?"daily":s?.mode??"daily",amount:s?String(s.amount):"",startDate:s?.startDate??localDate(new Date(),cal.calendar.timezone),endDate:s?.endDate??"",pauses:s?.pauses.map(p=>({startDate:p.startDate,endDate:p.endDate??""}))??[]};
        setState(next);setDraft(value);setInitial(JSON.stringify(value));setCalendar(cal.calendar);setTimezone(cal.calendar.timezone);setHolidays(cal.calendar.holidays.join("\n"));setCanEditCalendar(cal.canEdit);
      }).catch(()=>{if(!controller.signal.aborted)setError(t("기여 방식과 달력을 불러오지 못했습니다."));});
    return()=>controller.abort();
  },[projectId,attempt]);
  function reload(){setState(null);setDraft(null);setError("");setConflict(false);setAttempt(v=>v+1);}
  async function save(event:FormEvent) {
    event.preventDefault();if(!draft||!state||lock.current||savingCalendar)return;
    lock.current=true;setSaving(true);setError("");
    try {
      const input=scheduleInput({...draft,amount:Number(draft.amount)});
      const response=await fetch("/api/project-contribution-schedules",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId,revision:state.revision,...input})});
      if(!response.ok){if(response.status===409)setConflict(true);throw new Error();}
      window.dispatchEvent(new Event("okri:project-contributions"));window.dispatchEvent(new Event("okri:kr-data-sources"));onSaved();onClose();
    }catch {setError(t("저장하지 못했습니다. 운영 기간과 기여량을 확인해 주세요. 다른 변경이 있었다면 최신 설정을 불러오세요."));}
    finally {lock.current=false;setSaving(false);}
  }
  async function saveCalendar() {
    if(!calendar||lock.current||savingCalendar)return;setSavingCalendar(true);setCalendarError("");setCalendarNotice("");
    try {
      const response=await fetch("/api/metric-calendar",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({timezone,holidays:holidays.split(/[\n,]/).map(s=>s.trim()).filter(Boolean),version:calendar.version})});
      if(!response.ok)throw new Error();const result=await response.json() as {calendar:MetricCalendar};setCalendar(result.calendar);setTimezone(result.calendar.timezone);setHolidays(result.calendar.holidays.join("\n"));
      // Refresh the schedule revision without replacing the user's open draft.
      const current=await fetch("/api/project-contribution-schedules?projectId="+encodeURIComponent(projectId),{cache:"no-store"});if(!current.ok)throw new Error();setState(await current.json() as ProjectScheduleState);
      setCalendarNotice(t("달력을 저장했습니다. 워크스페이스의 추정값은 다음 집계에서 다시 계산됩니다."));
    }catch{setCalendarError(t("달력을 저장하지 못했습니다. 날짜·시간대를 확인하고 변경 충돌이 있다면 최신 설정을 불러오세요."));}
    finally{setSavingCalendar(false);}
  }
  let preview:ReturnType<typeof scheduleCredits>|null=null;
  try {if(draft&&calendar&&draft.amount.trim())preview=scheduleCredits(scheduleInput({...draft,amount:Number(draft.amount)}),calendar,new Date());}catch{/* Native form constraints and the inline save error explain invalid drafts. */}
  const dirty=Boolean(draft&&JSON.stringify(draft)!==initial)||Boolean(calendar&&(timezone!==calendar.timezone||holidays!==calendar.holidays.join("\n")));
  return <OverlayDialog title={t("KR 기여 방식")} variant="drawer" dirty={dirty} onRequestClose={()=>{if(!lock.current&&!savingCalendar)onClose();}}>
    {requestClose=><aside className="property-panel contribution-schedule-panel">
      <header><div><h2>{t("KR 기여 방식")}</h2><p>{state?.project.title}</p></div><button className="icon-button" aria-label={t("닫기")} disabled={saving||savingCalendar} onClick={()=>requestClose("close-button")}><X size={18}/></button></header>
      {!state||!draft||!calendar?<div className="schedule-status">{error?<><p role="alert">{error}</p><button className="secondary" onClick={reload}>{t("다시 시도")}</button></>:<p role="status">{t("데이터를 불러오는 중")}</p>}</div>:<form className="property-form" onSubmit={event=>void save(event)} aria-busy={saving}>
        <p>{state.keyResult.title}</p>
        {!state.keyResult.projectMode&&<p role="alert">{t("데이터 탭에서 상위 KR을 Project 성과 합산으로 설정한 뒤 저장해 주세요.")}</p>}
        {state.schedule?.suspendedAt&&<p role="status">{t("보관 또는 연결 변경으로 운영이 중지됐습니다. 일시중지 기간을 확인한 뒤 저장하면 재개됩니다.")}</p>}
        <fieldset disabled={saving||savingCalendar} className="schedule-fields">
          <label><span>{t("기여 방식")}</span><select aria-label={t("기여 방식")} value={draft.mode} onChange={e=>setDraft({...draft,mode:e.target.value as Draft["mode"],...(e.target.value==="once"?{endDate:"",pauses:[]}:{} )})}>{["once","business_days","daily"].map(mode=><option key={mode} value={mode}>{modeLabel(mode)}</option>)}</select></label>
          <label><span>{draft.mode==="once"?t("회당 기여량"):t("하루 기여량")}{state.keyResult.unit?" ("+state.keyResult.unit+")":""}</span><input type="number" min="0" max="1000000000000" step="any" required value={draft.amount} onChange={e=>setDraft({...draft,amount:e.target.value})}/></label>
          <div className="schedule-date-fields"><label><span>{draft.mode==="once"?t("반영일"):t("운영 시작일")}</span><input type="date" required value={draft.startDate} onChange={e=>setDraft({...draft,startDate:e.target.value})}/></label>{draft.mode!=="once"&&<label><span>{t("운영 종료일 (선택)")}</span><input type="date" min={draft.startDate} value={draft.endDate} onChange={e=>setDraft({...draft,endDate:e.target.value})}/></label>}</div>
          <small>{draft.mode==="once"?t("지정한 날짜에 한 번 반영합니다. Project 완료 상태와 무관합니다."):t("Project가 완료돼도 운영 기간 동안 쌓입니다. 지난 날짜까지 다음 날 자동 집계합니다.")}</small>
          {draft.mode!=="once"&&<section className="schedule-pauses"><h3>{t("일시중지 기간")}</h3>{draft.pauses.map((pause,index)=><div className="schedule-pause" key={index}><label><span>{t("중지 시작일")}</span><input type="date" required value={pause.startDate} onChange={e=>setDraft({...draft,pauses:draft.pauses.map((p,i)=>i===index?{...p,startDate:e.target.value}:p)})}/></label><label><span>{t("중지 종료일 (선택)")}</span><input type="date" min={pause.startDate} value={pause.endDate} onChange={e=>setDraft({...draft,pauses:draft.pauses.map((p,i)=>i===index?{...p,endDate:e.target.value}:p)})}/></label><button className="icon-button" type="button" aria-label={t("일시중지 기간 제거")} onClick={()=>setDraft({...draft,pauses:draft.pauses.filter((_,i)=>i!==index)})}><X size={16}/></button></div>)}<button type="button" className="secondary" disabled={draft.pauses.length>=50} onClick={()=>setDraft({...draft,pauses:[...draft.pauses,{startDate:localDate(new Date(),calendar.timezone),endDate:""}]})}>{t("일시중지 기간 추가")}</button><small>{t("시작일과 종료일을 모두 제외합니다. 종료일을 비워두면 계속 중지합니다.")}</small></section>}
        </fieldset>
        <dl className="schedule-totals"><div><dt>{t("누적 추정 기여")}</dt><dd>{format(preview?.accruedValue??state.schedule?.accruedValue??0,state.keyResult.unit)}</dd></div><div><dt>{t("이번 달 추정 기여")}</dt><dd>{format(preview?.monthValue??state.schedule?.monthValue??0,state.keyResult.unit)}</dd></div></dl>
        <p className="schedule-note">{t("설정한 기여량으로 계산한 추정치입니다. 운영 기간·기여량·제외일을 바꾸면 기존 추정값도 다시 계산합니다. 실제 API 측정값과 구분해 기록합니다.")}</p>
        <details className="schedule-calendar"><summary>{t("영업일 달력")} · {calendar.timezone}</summary><p>{t("영업일은 월~금에서 등록한 휴일을 제외합니다. 공휴일은 자동 추가하지 않습니다.")}</p><fieldset className="schedule-fields" disabled={!canEditCalendar||saving||savingCalendar}>
          <label><span>{t("워크스페이스 시간대")}</span><input value={timezone} onChange={e=>setTimezone(e.target.value)} placeholder="Asia/Seoul"/></label><label><span>{t("휴일 날짜")}</span><textarea aria-label={t("휴일 날짜")} rows={4} value={holidays} onChange={e=>setHolidays(e.target.value)} placeholder="YYYY-MM-DD"/><small>{t("한 줄에 날짜 하나를 입력합니다.")}</small></label>
          {canEditCalendar&&<button className="secondary" type="button" onClick={()=>void saveCalendar()}>{savingCalendar?t("저장 중"):t("워크스페이스 달력 저장")}</button>}
        </fieldset>{!canEditCalendar&&<small>{t("달력은 워크스페이스 관리자만 변경할 수 있습니다.")}</small>}{calendarError&&<p role="alert">{calendarError}</p>}{calendarNotice&&<p role="status">{calendarNotice}</p>}</details>
        {state.schedule&&<details className="schedule-records"><summary>{t("날짜별 추정 기여 보기")}</summary>{state.schedule.recentCredits.length?<ul>{state.schedule.recentCredits.map(c=><li key={c.date}><time>{c.date}</time><span>{t("추정")} {format(c.amount,state.keyResult.unit)}</span></li>)}</ul>:<p>{t("아직 반영한 날짜가 없습니다.")}</p>}</details>}
        {error&&<p className="contribution-error" role="alert">{error}</p>}{conflict&&<button type="button" className="secondary" onClick={reload}>{t("최신 설정 불러오기")}</button>}
        <footer><button className="secondary" type="button" disabled={saving||savingCalendar} onClick={()=>requestClose("close-button")}>{t("취소")}</button><button className="primary-action" type="submit" disabled={saving||savingCalendar||conflict||!preview||!state.keyResult.projectMode}>{saving?t("저장 중"):t("기여 방식 저장")}</button></footer>
      </form>}
    </aside>}
  </OverlayDialog>;
}
