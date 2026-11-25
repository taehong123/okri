"use client";

import { useEffect, useState, type FormEvent } from "react";
import { t, getClientLocale } from "@/lib/client-language";
import type { readMetricComparisons } from "@/lib/metric-comparisons";
import "./metric-comparisons.css";

type Response = Awaited<ReturnType<typeof readMetricComparisons>>;
type Comparison = Response["comparisons"][number];
const labels = () => ({ dod: t("전일 대비"), wow: t("전주 대비"), mom: t("전월 대비"), yoy: t("전년 대비"), custom: t("직접 비교") });
const aggregates = () => ({ sum: t("합계"), last: t("마지막 값"), average: t("평균"), ratio: t("분자·분모 합산") });

export default function MetricComparisons({ keyResultId, projectId, asOf, includeEstimates = true, refreshToken = 0 }: {
  keyResultId?: string; projectId?: string; asOf?: string; includeEstimates?: boolean; refreshToken?: number;
}) {
  const [data, setData] = useState<Response>();
  const [custom, setCustom] = useState({ currentStart: "", currentEnd: "", previousStart: "", previousEnd: "" });
  const [selected, setSelected] = useState<Comparison>();
  const [error, setError] = useState(false);
  const params = new URLSearchParams();
  if (keyResultId) params.set("keyResultId", keyResultId);
  if (projectId) params.set("projectId", projectId);
  if (asOf) params.set("asOf", asOf);
  params.set("includeEstimates", String(includeEstimates));
  params.set("locale", getClientLocale());
  const query = params.toString();
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined); setSelected(undefined); setError(false);
    fetch("/api/metric-comparisons?" + query, { cache: "no-store", signal: controller.signal })
      .then(r => { if (!r.ok) throw Error(); return r.json() as Promise<Response>; })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(() => { if (!controller.signal.aborted) setData(undefined); });
    return () => controller.abort();
  }, [query, refreshToken]);

  async function compare(event: FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams(query);
    Object.entries(custom).forEach(([key, value]) => params.set(key, value));
    try {
      const response = await fetch("/api/metric-comparisons?" + params, { cache: "no-store" });
      if (!response.ok) throw Error();
      const result = await response.json() as Response;
      setSelected(result.comparisons[0]); setError(!result.comparisons.length);
    } catch { setError(true); }
  }

  return <div className="metric-comparisons">
    <div className="metric-comparison-list">
      {[...(data?.comparisons ?? []), ...(selected ? [selected] : [])].map(item =>
        <details key={item.kind} className={"metric-comparison " + (item.favorable === null ? "" : item.favorable ? "is-positive" : "is-negative")}>
          <summary>{labels()[item.kind as keyof ReturnType<typeof labels>]} {item.display.percent ?? item.display.change}</summary>
          <div className="metric-comparison-detail">
            <p>{item.previous.start} – {item.previous.end} · {item.display.previousValue}</p>
            <p>{item.current.start} – {item.current.end} · {item.display.currentValue}</p>
            <p>{aggregates()[item.aggregation as keyof ReturnType<typeof aggregates>] ?? item.aggregation} · {item.display.change}{item.display.percent ? " · " + item.display.percent : ""}</p>
          </div>
        </details>)}
    </div>
    <details className="metric-custom">
      <summary>{t("기간 비교")}</summary>
      <form onSubmit={event => void compare(event)}>
        <label>{t("이전 시작")}<input type="date" required value={custom.previousStart} onChange={e => setCustom({ ...custom, previousStart: e.target.value })}/></label>
        <label>{t("이전 종료")}<input type="date" required value={custom.previousEnd} onChange={e => setCustom({ ...custom, previousEnd: e.target.value })}/></label>
        <label>{t("현재 시작")}<input type="date" required value={custom.currentStart} onChange={e => setCustom({ ...custom, currentStart: e.target.value })}/></label>
        <label>{t("현재 종료")}<input type="date" required value={custom.currentEnd} onChange={e => setCustom({ ...custom, currentEnd: e.target.value })}/></label>
        <button type="submit" className="secondary">{t("비교")}</button>
      </form>
      {error && <p role="status">{t("비교할 데이터가 없습니다. 기간을 확인해 주세요.")}</p>}
    </details>
  </div>;
}
