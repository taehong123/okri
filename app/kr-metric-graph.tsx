"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Check, Circle, Minus } from "lucide-react";
import type { KrMetricSummary } from "@/lib/kr-data-sources";
import type { KrObservation } from "@/lib/kr-metric-history";
import { t } from "@/lib/client-language";
import { formatContribution } from "./project-contributions";
import { latestKrTrendSegment, krTrendSignal, type KrSignal } from "./kr-trend-model";
import MetricComparisons from "./metric-comparisons";
import KrMetricHistoryChart from "./kr-metric-history-chart";
import KrPerformanceChart from "./kr-performance-chart";
import "./kr-metrics.css";

export type KrHistoryRead = { observations: KrObservation[]; limited: boolean; receivedAt: number; error?: boolean };
const Metrics = createContext<{metrics: Map<string, KrMetricSummary>; revision: number}>({metrics: new Map(), revision: 0});
export function KrMetricsProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [metrics, setMetrics] = useState<Map<string, KrMetricSummary>>(new Map());
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let loadVersion = 0;
    const load = async () => {
      const version = ++loadVersion;
      try {
        const response = await fetch("/api/kr-data-sources", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json() as {metrics: KrMetricSummary[]};
        if (!controller.signal.aborted && version === loadVersion) setMetrics(new Map(data.metrics.map(m => [m.keyResultId, m])));
      } catch { /* Row history and the OKR document remain usable. */ }
    };
    const refresh = () => { setRevision(value => value + 1); void load(); };
    void load();
    window.addEventListener("okri:kr-data-sources", refresh);
    window.addEventListener("okri:project-contributions", refresh);
    return () => { controller.abort(); window.removeEventListener("okri:kr-data-sources", refresh); window.removeEventListener("okri:project-contributions", refresh); };
  }, [workspaceId]);
  return <Metrics.Provider value={{metrics, revision}}>{children}</Metrics.Provider>;
}

export function useKrMetricData(keyResultId: string) {
  const {metrics, revision} = useContext(Metrics);
  const [history, setHistory] = useState<KrHistoryRead>();
  const [attempt, setAttempt] = useState(0);
  const metric = metrics.get(keyResultId);
  const managed = Boolean(metric?.performance);
  useEffect(() => {
    if (managed) return;
    const controller = new AbortController();
    void fetch("/api/kr-metric-history?keyResultId=" + encodeURIComponent(keyResultId) + "&days=30", {cache: "no-store", signal: controller.signal})
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<KrHistoryRead>; })
      .then(data => { if (!controller.signal.aborted) setHistory({...data, receivedAt: Date.now(), error: false}); })
      .catch(() => { if (!controller.signal.aborted) setHistory(previous => ({observations: [], limited: false, receivedAt: Date.now(), ...previous, error: true})); });
    return () => controller.abort();
  }, [keyResultId, revision, attempt, managed]);
  const unit = metric?.unit ?? history?.observations.at(-1)?.unit ?? "";
  const recent = metric?.trend?.at(-1);
  const points: KrObservation[] = managed ? (metric?.trend ?? []).filter(p => p.periodValue !== null &&
    p.periodStart === recent?.periodStart && p.ruleRevision === recent.ruleRevision).map(p => ({
    id: p.end, source: metric?.mode === "api" ? "api" : "projects", eventKind: "period",
    unit: p.unit, observedAt: p.end + "T00:00:00Z", currentValue: p.periodValue,
    baselineValue: p.baseline, targetValue: p.target, isEstimate: p.isEstimate,
  })) : latestKrTrendSegment(history?.observations ?? [], unit, metric?.mode, metric?.targetValue);
  const signal = krTrendSignal(points, !managed && history?.error);
  return {metric, history, unit, points, signal, revision, retry: () => setAttempt(value => value + 1)};
}
export type KrMetricData = ReturnType<typeof useKrMetricData>;
function signalLabel(signal: KrSignal) {
  return {reached: t("달성"), improving: t("개선"), steady: t("변화 없음"), declining: t("후퇴"), insufficient: t("기록 부족"), error: t("이력 확인 필요")}[signal];
}
function SignalIcon({signal}: {signal: KrSignal}) {
  const Icon = {reached: Check, improving: ArrowUpRight, steady: Minus, declining: ArrowDownRight, insufficient: Circle, error: AlertTriangle}[signal];
  return <Icon size={12} aria-hidden="true"/>;
}
export function KrTrendSummary({data}: {data: KrMetricData}) {
  const {points, signal, unit, history} = data;
  const label = (!history && !data.metric?.performance ? t("측정 이력을 불러오는 중입니다.") : signalLabel(signal))+(data.metric?.isEstimate?" · "+t("추정 포함"):"");
  const title = points.length > 1 ? t("최근 30일") + " · " + label + " · " + formatContribution(points[0].currentValue!, unit, data.metric?.displaySettings) + " → " + formatContribution(points.at(-1)!.currentValue!, unit, data.metric?.displaySettings) : label;
  const values = points.map(p => p.currentValue!), low = Math.min(...values), high = Math.max(...values), span = high - low;
  const start = Date.parse(points[0]?.observedAt ?? ""), end = Date.parse(points.at(-1)?.observedAt ?? "");
  const x = (p: KrObservation) => end > start ? 3 + (Date.parse(p.observedAt) - start) / (end - start) * 90 : 48;
  const y = (p: KrObservation) => span ? 23 - (p.currentValue! - low) / span * 18 : 14;
  return <span className={"kr-trend-summary signal-" + signal} role="img" aria-label={title} title={title}>
    <svg viewBox="0 0 96 28" preserveAspectRatio="none" aria-hidden="true">
      {points.length > 1 && <path d={points.map((p, i) => (i ? "L" : "M") + x(p) + "," + y(p)).join(" ")}/>}
      {points.length === 1 && <circle cx={x(points[0])} cy={y(points[0])} r="2"/>}
    </svg>
    <span className="kr-trend-signal"><SignalIcon signal={signal}/></span>
  </span>;
}
export function KrMetricDetails({data, keyResultId}: {data: KrMetricData; keyResultId: string}) {
  const {metric, history, unit, signal, revision, retry} = data;
  if (metric?.performance) return <div className="kr-inline-metric"><KrPerformanceChart keyResultId={keyResultId} refreshToken={revision} displaySettings={metric.displaySettings}/></div>;
  const latest = history?.observations.filter(p => p.currentValue !== null && p.unit === unit).at(-1);
  const current = metric?.currentValue ?? latest?.currentValue, target = metric?.targetValue ?? latest?.targetValue;
  return <div className="kr-inline-metric">
    <MetricComparisons keyResultId={keyResultId} refreshToken={revision}/>
    <KrMetricHistoryChart keyResultId={keyResultId} unit={unit} refreshToken={revision} initialHistory={history} displaySettings={metric?.displaySettings} onRetry={retry} summary={<div className="kr-inline-values">
      <span>{current != null ? <><b>{formatContribution(current, unit, metric?.displaySettings)}</b>{target != null && <span className="kr-inline-target"> / {formatContribution(target, unit, metric?.displaySettings)}</span>}</> : t("업데이트 전")}</span>
      {(metric?.isEstimate??latest?.isEstimate)&&<small>{t("추정 포함")}</small>}
      {history && <span className={"kr-inline-signal signal-" + signal}><SignalIcon signal={signal}/>{signalLabel(signal)}</span>}
    </div>}/>
  </div>;
}
