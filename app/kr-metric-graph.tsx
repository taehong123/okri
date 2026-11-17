"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { KrMetricSummary } from "@/lib/kr-data-sources";
import { t } from "@/lib/client-language";
import { formatContribution } from "./project-contributions";
import "./kr-metrics.css";
import KrMetricHistoryChart from "./kr-metric-history-chart";
export default function KrMetricGraph({workspaceId,items,onOpenData}:{workspaceId:string;items:{id:string;title:string;progress:number}[];onOpenData:()=>void}){
  const [metrics,setMetrics]=useState<KrMetricSummary[]|null>(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  const [selected,setSelected]=useState(items[0]?.id??""),[refreshToken,setRefreshToken]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    const refresh=()=>{void fetch("/api/kr-data-sources",{cache:"no-store",signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error();return r.json() as Promise<{metrics:KrMetricSummary[]}>;}).then(s=>{if(!controller.signal.aborted){setMetrics(s.metrics);setError(false);setRefreshToken(v=>v+1);}}).catch(()=>{if(!controller.signal.aborted)setError(true);});};
    refresh();window.addEventListener("okri:kr-data-sources",refresh);window.addEventListener("okri:project-contributions",refresh);
    return()=>{controller.abort();window.removeEventListener("okri:kr-data-sources",refresh);window.removeEventListener("okri:project-contributions",refresh);};
  },[workspaceId,attempt]);
  if(!items.length)return null;
  const byId=new Map(metrics?.map(m=>[m.keyResultId,m]));
  const selectedItem=items.find(i=>i.id===selected)??items[0];
  return <section className="kr-metric-graph" aria-label={t("KR 지표 그래프")}>
    <header><div><h2>{t("KR 지표")}</h2><p>{t("현재 수치와 목표 달성 현황")}</p></div><button onClick={onOpenData}>{t("데이터 설정")}<ArrowUpRight size={14}/></button></header>
    <label className="kr-metric-select"><span>{t("조회할 KR")}</span><select value={selectedItem.id} onChange={e=>setSelected(e.target.value)}>{items.map(i=><option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
    {error?<p className="kr-metric-state" role="alert">{t("지표를 불러오지 못했습니다.")}<button onClick={()=>setAttempt(v=>v+1)}><RefreshCw size={14}/>{t("다시 시도")}</button></p>:metrics===null?<p className="kr-metric-state" role="status">{t("지표를 불러오는 중입니다.")}</p>:<ol>
    {[selectedItem].map(item=>{const m=byId.get(item.id),progress=Math.max(0,Math.min(100,m?.progress??item.progress));return <li key={item.id}>
      <div className="kr-metric-title"><span className="type-icon type-key_result">KR</span><h3>{item.title}</h3><strong>{progress}%</strong></div>
      <div className="kr-metric-track" role="progressbar" aria-label={item.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{width:progress+"%"}}/></div>
      <div className="kr-metric-caption"><span>{m?.mode==="projects"?t("Project 성과 합산"):m?.mode==="api"?t("API 연동"):t("직접 관리")}</span><span>{m?.targetValue!==null&&m?.targetValue!==undefined?<><b>{m.currentValue===null?t("업데이트 전"):formatContribution(m.currentValue,m.unit)}</b><span> / {formatContribution(m.targetValue,m.unit)}</span></>:t("수치 설정 전")}</span></div>
      <KrMetricHistoryChart key={workspaceId+item.id} keyResultId={item.id} unit={m?.unit??""} refreshToken={refreshToken}/>
    </li>;})}</ol>}
  </section>;
}
