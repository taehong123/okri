"use client";
import { useEffect, useState } from "react";
import { t, getClientLocale } from "@/lib/client-language";
import type { KrObservation } from "@/lib/kr-metric-history";
import { formatContribution } from "./project-contributions";
type History={observations:KrObservation[];limited:boolean};
const day=(iso:string)=>new Intl.DateTimeFormat(getClientLocale(),{month:"short",day:"numeric"}).format(new Date(iso));
const definition=(p:KrObservation)=>JSON.stringify([p.source,p.unit,p.baselineValue,p.targetValue]);
const calendarDay=(iso:string)=>{const date=new Date(iso);return date.getFullYear()+"-"+date.getMonth()+"-"+date.getDate();};
export default function KrMetricHistoryChart({keyResultId,unit,refreshToken}:{keyResultId:string;unit:string;refreshToken:number}){
  const [days,setDays]=useState(30),[data,setData]=useState<History|null>(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  const [end,setEnd]=useState(()=>Date.now());
  useEffect(()=>{
    const controller=new AbortController();
    void fetch("/api/kr-metric-history?keyResultId="+encodeURIComponent(keyResultId)+"&days="+days,{cache:"no-store",signal:controller.signal})
      .then(async r=>{if(!r.ok)throw new Error();return r.json() as Promise<History>;})
      .then(d=>{if(!controller.signal.aborted){setData(d);setError(false);setEnd(Date.now());}}).catch(()=>{if(!controller.signal.aborted)setError(true);});
    return()=>controller.abort();
  },[keyResultId,days,refreshToken,attempt]);
  const observations=data?.observations??[];
  // Keep the final sample of each day in each uninterrupted measurement definition.
  // A settings marker or a different unit/source starts a separate line.
  const segments:KrObservation[][]=[];
  let previous:KrObservation|undefined;
  for(const p of observations){
    if(p.currentValue===null||p.unit!==unit){previous=undefined;continue;}
    if(!previous||definition(previous)!==definition(p)||p.eventKind==="settings")segments.push([]);
    const segment=segments.at(-1)!;
    if(segment.length&&calendarDay(segment.at(-1)!.observedAt)===calendarDay(p.observedAt))segment[segment.length-1]=p;else segment.push(p);
    previous=p;
  }
  const points=segments.flat(),values=points.flatMap(p=>[p.currentValue!,p.targetValue]);
  const min=Math.min(0,...values),max=Math.max(1,...values),range=max-min||1;
  const start=end-days*86_400_000;
  const x=(p:KrObservation)=>8+Math.max(0,Math.min(1,(Date.parse(p.observedAt)-start)/(end-start)))*684;
  const y=(v:number)=>10+160*(max-v)/range;
  return <div className="kr-history">
    <div className="kr-history-controls"><span>{t("수치 추이")}</span><select value={days} onChange={e=>{setData(null);setError(false);setDays(Number(e.target.value));}} aria-label={t("지표 조회 기간")}><option value={7}>{t("최근 7일")}</option><option value={30}>{t("최근 30일")}</option><option value={90}>{t("최근 90일")}</option><option value={365}>{t("최근 1년")}</option></select></div>
    {error?<p role="alert" className="kr-metric-state">{t("측정 이력을 불러오지 못했습니다.")}<button onClick={()=>setAttempt(v=>v+1)}>{t("다시 시도")}</button></p>:!data?<p role="status" className="kr-metric-state">{t("측정 이력을 불러오는 중입니다.")}</p>:!points.length?<p className="kr-history-empty">{t("첫 측정부터 그래프가 쌓입니다. API 갱신 또는 Project 성과 반영 후 확인해 주세요.")}</p>:<figure>
      <div className="kr-history-range"><span>{formatContribution(max,unit)}</span><span>{t("실선: 현재값 · 점선: 목표값")}</span></div>
      <svg viewBox="0 0 700 180" preserveAspectRatio="none" role="img" aria-label={t("기록된 KR 수치의 날짜별 추이. 자세한 값은 측정 기록에서 확인할 수 있습니다.")}>
        {[10,90,170].map(v=><line key={v} className="kr-history-grid" x1="8" x2="692" y1={v} y2={v}/>)}
        {segments.map((segment,index)=><g key={index}>
          {segment.length>1&&<><path className="kr-history-target" d={segment.map((p,i)=>(i?"L":"M")+x(p)+","+y(p.targetValue)).join(" ")}/><path className="kr-history-line" d={segment.map((p,i)=>(i?"L":"M")+x(p)+","+y(p.currentValue!)).join(" ")}/></>}
          {segment.map(p=><circle key={p.id} cx={x(p)} cy={y(p.currentValue!)} r="3.5" className="kr-history-point"><title>{day(p.observedAt)} · {formatContribution(p.currentValue!,p.unit)}</title></circle>)}
        </g>)}
      </svg>
      <div className="kr-history-dates"><span>{day(new Date(start).toISOString())}</span><span>{day(new Date(end).toISOString())}</span></div>
      <figcaption>{points.length===1?t("첫 측정값입니다. 다음 기록부터 변화를 볼 수 있습니다."):t("날짜별 마지막 측정값입니다. 측정 방식·단위·목표가 바뀌면 선을 구분합니다.")}</figcaption>
    </figure>}
    {data&&observations.length>0&&<details className="kr-history-records"><summary>{t("측정 기록 보기")} · {observations.length}{data.limited?" +":""}</summary><div className="kr-history-table"><table><caption>{t("KR 측정 이력")}</caption><thead><tr><th scope="col">{t("측정 시각")}</th><th scope="col">{t("현재값")}</th><th scope="col">{t("목표값")}</th><th scope="col">{t("측정 방식")}</th></tr></thead><tbody>{observations.slice(-100).reverse().map(p=><tr key={p.id}><td>{new Date(p.observedAt).toLocaleString(getClientLocale())}</td><td>{p.currentValue===null?t("설정 변경"):formatContribution(p.currentValue,p.unit)}</td><td>{formatContribution(p.targetValue,p.unit)}</td><td>{p.source==="api"?t("API 연동"):t("Project 성과 합산")}</td></tr>)}</tbody></table></div><p>{t("최근 측정 기록 100개까지 표시합니다. 과거 값은 자동으로 추정하지 않습니다.")}</p></details>}
  </div>;
}
