"use client";

import { useEffect, useState, type FormEvent } from "react";
import { t } from "@/lib/client-language";
import type { getMetricRollupStatus, KrPerformanceState, listMetricEntries, previewMetricRollup } from "@/lib/kr-performance";
import type { MetricDisplaySettings } from "@/lib/kr-metric-display-format";
import type { Grain, PerformanceResult } from "@/lib/kr-performance-model";
import MetricComparisons from "./metric-comparisons";
import { formatContribution } from "./project-contributions";
import "./kr-performance.css";

type ValueLabel = (value: number | null, unit: string) => string;
const periodLabel = (rule: PerformanceResult["rule"]["value"]) => ({
  daily: t("일간"), quarterly: t("분기"), monthly: t("월간"), weekly: t("주간"), fixed: t("지정 기간"), all_time: t("전체 기간"),
})[rule.period];
const aggregationLabel = (rule: PerformanceResult["rule"]["value"]) => ({
  ratio: t("분자·분모 합산"), sum: t("합계"), last: t("마지막 값"), average: t("평균"),
})[rule.aggregation];

export default function KrPerformanceChart({ keyResultId, refreshToken, displaySettings }: {
  keyResultId: string; refreshToken: number; displaySettings?: MetricDisplaySettings;
}) {
  const fmt: ValueLabel = (value, unit) => value === null ? "—" : formatContribution(value, unit, displaySettings);
  const [state, setState] = useState<KrPerformanceState>();
  const [query, setQuery] = useState({ start: "", end: "", asOf: "", grain: "day" as Grain, includeEstimates: true });
  const [dates, setDates] = useState({ start: "", end: "", asOf: "" });
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [series, setSeries] = useState<"periodValue" | "cumulativeValue" | "value">("periodValue");
  const [limit, setLimit] = useState(25);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ keyResultId, grain: query.grain, includeEstimates: String(query.includeEstimates) });
    if (query.asOf) params.set("asOf", query.asOf);
    if (query.start && query.end) { params.set("start", query.start); params.set("end", query.end); }
    void fetch("/api/kr-performance?" + params, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw Error();
        return response.json() as Promise<KrPerformanceState>;
      })
      .then(next => {
        if (controller.signal.aborted) return;
        setState(next);
        setError(false);
        if (next.performance) setDates({ ...next.performance.range, asOf: next.asOf });
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [keyResultId, query, refreshToken, attempt]);

  function applyRange(event: FormEvent) {
    event.preventDefault();
    setLimit(25);
    setQuery({ ...query, ...dates });
  }
  if (error) return <p role="alert" className="kr-metric-state">{t("성과를 불러오지 못했습니다.")} <button type="button" className="secondary" onClick={() => setAttempt(n => n + 1)}>{t("다시 시도")}</button></p>;
  if (!state) return <p role="status" className="kr-metric-state">{t("데이터를 불러오는 중")}</p>;
  const result = state.performance;
  if (!result) return <p className="kr-metric-state">{t("적용 중인 성과 측정 규칙이 없습니다.")}</p>;
  const { current, evaluation, selected, rule: { value: rule } } = result;
  const chosen = selected.rule?.value;
  return <section className="kr-performance-chart" aria-label={t("KR 성과 추이")}>
    <div className="kr-inline-values">
      <span><b>{fmt(current.value, rule.unit)}</b><span className="kr-inline-target"> / {fmt(rule.target, rule.unit)}</span></span>
      <small>{periodLabel(rule)} · {aggregationLabel(rule)} · {evaluation.start} – {evaluation.end}</small>
      {current.hasEstimates && <small>{t("추정 포함")}</small>}
    </div>
    <MetricComparisons keyResultId={keyResultId} asOf={result.asOf} includeEstimates={query.includeEstimates} refreshToken={refreshToken}/>
    <p className="perf-meta">{t("집계 기준일")} <time>{result.asOf}</time> · {rule.timezone}</p>
    <form className="perf-range" onSubmit={applyRange}>
      <label>{t("조회 시작일")}<input type="date" required value={dates.start} onChange={e => setDates({ ...dates, start: e.target.value })}/></label>
      <label>{t("조회 종료일")}<input type="date" required min={dates.start} value={dates.end} onChange={e => setDates({ ...dates, end: e.target.value })}/></label>
      <label>{t("집계 기준일")}<input type="date" value={dates.asOf} onChange={e => setDates({ ...dates, asOf: e.target.value })}/></label>
      <button type="submit" className="secondary">{t("조회")}</button>
      <button type="button" className="secondary" onClick={() => setQuery({ ...query, start: "", end: "", asOf: "" })}>{t("평가 기간으로")}</button>
    </form>
    <div className="perf-range">
      <label>{t("집계 단위")}<select value={query.grain} onChange={e => setQuery({ ...query, grain: e.target.value as Grain })}>
        <option value="day">{t("일별")}</option><option value="week">{t("주별")}</option><option value="month">{t("월별")}</option>
      </select></label>
      <label>{t("그래프 표시")}<select value={series} onChange={e => setSeries(e.target.value as typeof series)}>
        <option value="periodValue">{t("기간 실적")}</option><option value="value">{t("구간 실적")}</option>
        {rule.aggregation === "sum" && <option value="cumulativeValue">{t("누적 추이")}</option>}
      </select></label>
      <label className="perf-check"><input type="checkbox" checked={query.includeEstimates}
        onChange={e => setQuery({ ...query, includeEstimates: e.target.checked })}/>{t("추정 포함")}</label>
    </div>
    <PerformancePlot points={result.points} series={series} fmt={fmt}/>
    <p className="perf-meta">{t("선택 기간 실적")} <strong>{fmt(selected.value, chosen?.unit ?? rule.unit)}</strong>
      {chosen && <> · {aggregationLabel(chosen)}</>}{selected.hasEstimates && <> · {t("추정 포함")}</>}
      {rule.aggregation === "sum" && <> · {t("전체 누적")} <strong>{fmt(result.lifetime?.value ?? null, rule.unit)}</strong></>}</p>
    {(selected.counterGaps || current.counterGaps) > 0 && <p className="perf-meta">{t("누적계의 첫 기록과 초기화 구간은 변화량에서 제외합니다.")}</p>}
    {selected.projectBreakdown.length > 0 && <details className="kr-history-records">
      <summary>{t("Project별 기여 합계")}</summary>
      <ul>{selected.projectBreakdown.map(project => <li key={project.projectId}>
        <span>{project.title}</span><strong>{fmt(project.value, chosen?.unit ?? rule.unit)}</strong>
        {project.estimatedValue !== 0 && <small>{t("추정")} {fmt(project.estimatedValue, chosen?.unit ?? rule.unit)}</small>}
      </li>)}</ul>
    </details>}
    <details className="kr-history-records">
      <summary>{t("성과 날짜별 기록")}</summary>
      <div className="kr-history-table">
        <table><thead><tr><th>{t("성과 날짜")}</th><th>Project</th><th>{t("실적")}</th><th>{t("산정 근거")}</th></tr></thead>
          <tbody>{result.records.slice().reverse().slice(0, limit).map(row => <tr key={row.id}>
            <td>{row.date}</td><td>{row.title ?? "—"}</td><td>{fmt(row.value, row.unit)} {row.isEstimate ? t("추정") : t("실측")}</td>
            <td>{row.basis || "—"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {limit < result.records.length && <button className="secondary" type="button" onClick={() => setLimit(n => n + 50)}>{t("더 보기")}</button>}
    </details>
    <MetricLedger key={[keyResultId, result.range.start, result.range.end, result.asOf, result.includeEstimates, refreshToken].join("/")}
      keyResultId={keyResultId} result={result} fmt={fmt}/>
  </section>;
}

function MetricLedger({ keyResultId, result, fmt }: { keyResultId: string; result: PerformanceResult; fmt: ValueLabel }) {
  const [ledger, setLedger] = useState<Awaited<ReturnType<typeof listMetricEntries>>>();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getMetricRollupStatus>>>();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewMetricRollup>>>();
  const [error, setError] = useState(false);
  const base = new URLSearchParams({ keyResultId, asOf: result.asOf, start: result.range.start, end: result.range.end,
    includeEstimates: String(result.includeEstimates) });
  async function load(view: "ledger" | "rollup" | "preview", offset = 0) {
    try {
      const query = new URLSearchParams(base);
      query.set("view", view);
      if (view === "ledger") { query.set("limit", "25"); query.set("offset", String(offset)); }
      const response = await fetch("/api/kr-performance?" + query, { cache: "no-store" });
      if (!response.ok) throw Error();
      if (view === "ledger") {
        const page = await response.json() as Awaited<ReturnType<typeof listMetricEntries>>;
        setLedger(before => offset && before ? { ...page, entries: [...before.entries, ...page.entries] } : page);
      } else if (view === "rollup") setStatus(await response.json());
      else setPreview(await response.json());
      setError(false);
    } catch { setError(true); }
  }
  const label = (state: string) => state === "applied" ? t("반영") : state === "undated" ? t("발생일 미상")
    : state === "cancelled" ? t("취소됨") : t("미반영");
  return <>
    <details className="kr-history-records" onToggle={e => { if (e.currentTarget.open && !ledger) void load("ledger"); }}>
      <summary>{t("실적 원장")}</summary>
      {ledger && <div className="kr-history-table"><table>
        <thead><tr><th>{t("성과 날짜")}</th><th>Project</th><th>{t("실적")}</th><th>{t("상태")}</th></tr></thead>
        <tbody>{ledger.entries.map(row => <tr key={row.id}>
          <td>{row.date ?? "—"}</td><td>{row.title ?? "—"}</td><td>{fmt(row.value, row.unit)} · {row.isEstimate ? t("추정") : t("실측")}</td><td>{label(row.status)}</td>
        </tr>)}</tbody>
      </table></div>}
      {ledger && ledger.nextOffset !== null &&
        <button type="button" className="secondary" onClick={() => void load("ledger", ledger.nextOffset!)}>{t("더 보기")}</button>}
    </details>
    {result.rule.value.source === "projects" && <details className="kr-history-records" onToggle={e => { if (e.currentTarget.open) void load("rollup"); }}>
      <summary>{t("집계 상태")}</summary>
      {status && <>
        <p className="perf-meta">{t("마지막 자동 집계")} {status.lastScheduledAt ? new Date(status.lastScheduledAt).toLocaleString() : "—"}
          {" · "}{t("누적 완료일")} {status.accumulatedThrough ?? "—"}</p>
        <button type="button" className="secondary" onClick={() => void load("preview")}>{t("재집계 미리보기")}</button>
      </>}
      {preview && <p role="status" className="perf-meta">
        {t("반영 예상 증감")} {fmt((preview.selectedAfter?.value ?? 0) - (preview.selectedBefore?.value ?? 0), result.rule.value.unit)}
      </p>}
    </details>}
    {error && <p className="perf-meta" role="alert">{t("집계 정보를 불러오지 못했습니다.")}</p>}
  </>;
}

function PerformancePlot({ points, series, fmt }: { points: PerformanceResult["points"]; series: "periodValue" | "cumulativeValue" | "value"; fmt: ValueLabel }) {
  const usable = points.filter(point => point[series] !== null);
  if (!usable.length) return <p className="kr-history-empty">{t("측정 기록이 없습니다.")}</p>;
  const goalVisible = series === "periodValue";
  const date = (value: string) => Date.parse(value + "T00:00:00Z");
  const first = date(usable[0].end), last = date(usable.at(-1)!.end);
  const ranges = new Map<string, { min: number; max: number }>();
  for (const point of usable) {
    const values = goalVisible ? [point[series]!, point.target] : [point[series]!];
    const range = ranges.get(point.unit) ?? { min: 0, max: 0 };
    ranges.set(point.unit, { min: Math.min(range.min, ...values), max: Math.max(range.max, ...values) });
  }
  const x = (p: typeof usable[number]) => last > first ? 8 + (date(p.end) - first) / (last - first) * 684 : 350;
  const y = (value: number, unit: string) => {
    const { min, max } = ranges.get(unit)!;
    return max === min ? 90 : 10 + 160 * (max - value) / (max - min);
  };
  const segments: typeof usable[] = [];
  let previous: typeof usable[number] | undefined;
  for (const point of points) {
    if (point[series] === null) { previous = undefined; continue; }
    if (!previous || previous.ruleRevision !== point.ruleRevision ||
        series === "periodValue" && previous.periodStart !== point.periodStart) segments.push([]);
    segments.at(-1)!.push(point);
    previous = point;
  }
  return <figure className="kr-history perf-figure">
    {goalVisible && <figcaption>{t("실선: 현재값 · 점선: 목표값")}</figcaption>}
    <svg viewBox="0 0 700 180" preserveAspectRatio="none" role="img" aria-label={t("KR 성과 추이")}>
      {[10, 90, 170].map(value => <line key={value} className="kr-history-grid" x1="8" x2="692" y1={value} y2={value}/>)}
      {segments.map((segment, i) => <g key={i}>
        {goalVisible && <path className="kr-history-target" d={segment.map((p, i) => (i ? "L" : "M") + x(p) + "," + y(p.target, p.unit)).join(" ")}/>}
        <path className="kr-history-line" d={segment.map((p, i) => (i ? "L" : "M") + x(p) + "," + y(p[series]!, p.unit)).join(" ")}/>
        {segment.map(p => <circle key={p.end} cx={x(p)} cy={y(p[series]!, p.unit)} r="3" className="kr-history-point">
          <title>{p.end} · {fmt(p[series], p.unit)}{goalVisible ? " / " + fmt(p.target, p.unit) : ""}{p.isEstimate ? " · " + t("추정 포함") : ""}</title>
        </circle>)}
      </g>)}
    </svg>
    <div className="kr-history-dates"><time>{usable[0].start}</time><time>{usable.at(-1)!.end}</time></div>
    <details className="kr-history-records"><summary>{t("집계 값 보기")}</summary>
      <div className="kr-history-table"><table><thead><tr><th>{t("성과 날짜")}</th><th>{t("실적")}</th><th>{t("목표값")}</th></tr></thead>
        <tbody>{usable.map(p => <tr key={p.end}><td><time>{p.start}</time> – <time>{p.end}</time></td>
          <td>{fmt(p[series], p.unit)}{p.isEstimate ? " · " + t("추정 포함") : ""}</td><td>{fmt(p.target, p.unit)}</td></tr>)}</tbody></table></div>
    </details>
  </figure>;
}
