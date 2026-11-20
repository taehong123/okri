"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, X } from "lucide-react";
import { t } from "@/lib/client-language";
import type { KrSourceSettings } from "@/lib/kr-data-sources";
import type { KrPerformanceState } from "@/lib/kr-performance";
import type { MeasurementRule, ProjectRule } from "@/lib/kr-performance-model";
import type { MetricCalendarInput } from "@/lib/project-metric-schedule-model";
import { OverlayDialog } from "./overlay-dialog";
import "./kr-performance.css";

type Tab = "rule" | "project" | "entry" | "history";
type Pause = { startDate: string; endDate: string };
type ProjectDraft = { mode: ProjectRule["mode"]; amount: string; startDate: string; endDate: string; pauses: Pause[];
  operating: boolean; isEstimate: boolean; basis: string; calendar: MetricCalendarInput | null };
type RuleDraft = Omit<MeasurementRule, "baseline" | "target" | "timezone"> & { baseline: string; target: string };
type Audit = { revision: number; kind: Tab; subjectId: string; effectiveDate: string; recordedAt: string; actorId: string; reason: string;
  before: unknown; after: unknown; affected: { from: string; through: string | null; periods: { start: string; end: string }[] } };

const modes = () => ({ once: t("1회성"), daily: t("매일"), business_days: t("영업일마다"), weekly: t("매주") });
const tabs = () => ({ rule: t("KR 측정 규칙"), project: t("Project 기여 규칙"), entry: t("실적 기록·정정"), history: t("변경 이력") });
const errors = () => ({
  performance_revision_conflict: t("다른 변경이 있었습니다. 최신 설정을 불러온 뒤 다시 저장해 주세요."),
  performance_correction_reason_required: t("과거 실적을 추가하거나 기존 기록을 바꿀 때는 사유를 입력해 주세요."),
  incompatible_performance_aggregation: t("데이터 형태에 맞는 집계 방식을 선택해 주세요."),
  invalid_performance_target: t("기준값과 목표값이 증가·감소 방향에 맞는지 확인해 주세요."),
  matching_api_source_required: t("같은 단위의 KR API 연결을 먼저 저장해 주세요."),
  legacy_schedule_unit_mismatch: t("기존 기여 일정과 같은 단위를 선택해 주세요."),
  manual_performance_rule_required: t("직접 입력 또는 Project 기여 규칙을 먼저 저장해 주세요."),
  project_performance_rule_required: t("Project 기여를 사용하는 KR 측정 규칙을 먼저 저장해 주세요."),
  performance_entry_not_found: t("정정할 기록을 찾을 수 없습니다."),
});

function ruleDraft(state: KrPerformanceState, legacy: KrSourceSettings, date: string): RuleDraft {
  const rule = state.configuration.rules.findLast(version => version.effectiveDate <= date)?.value;
  if (rule) {
    const { timezone, ...definition } = rule;
    return { ...definition, baseline: String(rule.baseline), target: String(rule.target) };
  }
  const api = legacy.mode === "api" ? legacy.api : null;
  const baseline = api?.baselineValue ?? 0, target = api?.targetValue ?? legacy.metric?.targetValue ?? 100;
  return { source: api ? "api" : "projects", input: api ? "samples" : "events", aggregation: api ? "last" : "sum",
    period: "monthly", start: null, end: null, direction: baseline < target ? "increase" : "decrease",
    baseline: String(baseline), target: String(target), unit: api?.unit ?? legacy.metric?.unit ?? "" };
}
function projectDraft(state: KrPerformanceState, id: string, date: string, legacy: KrSourceSettings): ProjectDraft {
  const rule = state.configuration.projects.findLast(version => version.projectId === id && version.effectiveDate <= date)?.value;
  return { mode: rule?.mode ?? "daily", amount: String(rule?.amount ?? legacy.projects.find(p => p.id === id)?.defaultValue ?? ""),
    startDate: rule?.startDate ?? date, endDate: rule?.endDate ?? "", pauses: rule?.pauses.map(p => ({ startDate: p.startDate, endDate: p.endDate ?? "" })) ?? [],
    operating: rule?.operating ?? true, isEstimate: rule?.isEstimate ?? true, basis: rule?.basis ?? "",
    calendar: rule ? { timezone: rule.calendar.timezone, holidays: rule.calendar.holidays, weekendDays: rule.calendar.weekendDays } : null };
}

export default function KrPerformanceSettings({ legacy, onClose, onSaved }: { legacy: KrSourceSettings; onClose: () => void; onSaved: () => void }) {
  const keyResultId = legacy.keyResult.id;
  const [state, setState] = useState<KrPerformanceState>();
  const [tab, setTab] = useState<Tab>("rule");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [rule, setRule] = useState<RuleDraft>();
  const [project, setProject] = useState<ProjectDraft>();
  const [projectId, setProjectId] = useState(legacy.projects[0]?.id ?? "");
  const [entry, setEntry] = useState({ subjectId: "", amount: "", basis: "", isEstimate: false, voided: false });
  const [audit, setAudit] = useState<Audit[]>([]);
  const [nextRevision, setNextRevision] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useRef<{ serialized: string; id: string } | undefined>(undefined);
  const loading = useRef(false);
  const url = "/api/kr-performance?keyResultId=" + encodeURIComponent(keyResultId);
  const active = state?.configuration.rules.findLast(version => version.effectiveDate <= date);
  const projectEntry = active?.value.source === "projects";

  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw Error(); return response.json() as Promise<KrPerformanceState>; })
      .then(next => {
        if (controller.signal.aborted) return;
        setState(next);
        setDate(previous => previous || next.asOf);
        setRule(previous => previous ?? ruleDraft(next, legacy, next.asOf));
        setProject(previous => previous ?? projectDraft(next, legacy.projects[0]?.id ?? "", next.asOf, legacy));
        setError("");
      })
      .catch(() => { if (!controller.signal.aborted) setError(t("KR 설정을 불러오지 못했습니다.")); });
    return () => controller.abort();
  }, [url, legacy, attempt]);

  async function listChanges(after = 0) {
    try {
      const response = await fetch(url + "&view=changes&after=" + after, { cache: "no-store" });
      if (!response.ok) throw Error();
      const page = await response.json() as { changes: Audit[]; nextRevision: number | null };
      setAudit(rows => after ? [...rows, ...page.changes] : page.changes);
      setNextRevision(page.nextRevision);
    } catch { setError(t("변경 이력을 불러오지 못했습니다.")); }
  }

  function selectTab(next: Tab) {
    setTab(next); setNotice(""); setError("");
    if (next === "history") void listChanges();
  }

  function changeRule(patch: Partial<RuleDraft>) { setDirty(true); setRule(v => v && ({ ...v, ...patch })); }
  function changeProject(patch: Partial<ProjectDraft>) { setDirty(true); setProject(v => v && ({ ...v, ...patch })); }
  function changeDate(value: string) {
    setDate(value); setDirty(true);
    if (state && value && !dirty) { setRule(ruleDraft(state, legacy, value)); setProject(projectDraft(state, projectId, value, legacy)); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!state || !rule || !project || tab === "history" || loading.current) return;
    const value = tab === "rule" ? { ...rule, baseline: Number(rule.baseline), target: Number(rule.target) }
      : tab === "project" ? { ...project, amount: Number(project.amount), endDate: project.endDate || null,
        pauses: project.mode === "once" ? [] : project.pauses.map(p => ({ startDate: p.startDate, endDate: p.endDate || null })),
        calendar: project.calendar && { ...project.calendar, holidays: project.calendar.holidays.map(date => date.trim()).filter(Boolean) } }
      : { projectId: projectEntry ? projectId : undefined, value: Number(entry.amount), basis: entry.basis, isEstimate: entry.isEstimate, voided: entry.voided };
    const payload = { keyResultId, kind: tab, effectiveDate: date, reason, value,
      subjectId: tab === "project" ? projectId : tab === "entry" && !projectEntry ? entry.subjectId : undefined };
    const serialized = JSON.stringify(payload);
    if (retry.current?.serialized !== serialized) retry.current = { serialized, id: crypto.randomUUID() };
    loading.current = true;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/kr-performance", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, expectedRevision: state.revision, requestId: retry.current.id }) });
      const result = await response.json() as { code?: keyof ReturnType<typeof errors>; revision?: number };
      if (!response.ok) {
        setError((result.code && errors()[result.code]) || t("저장하지 못했습니다. 입력한 값을 확인해 주세요."));
        return;
      }
      if (result.revision) setState({ ...state, revision: result.revision });
      retry.current = undefined;
      setDirty(false); setReason(""); setNotice(t("저장했습니다."));
      setAttempt(n => n + 1);
      onSaved();
    } catch { setError(t("저장하지 못했습니다. 다시 시도해 주세요.")); }
    finally { loading.current = false; setSaving(false); }
  }

  const projectOptions = legacy.projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>);
  return <OverlayDialog title={t("성과 측정 설정")} variant="drawer" dirty={dirty} onRequestClose={() => { if (!loading.current) onClose(); }}>
    {requestClose => <aside className="property-panel kr-data-panel kr-source-panel">
      <header><div><h2>{t("성과 측정 설정")}</h2><p>{legacy.keyResult.title}</p></div>
        <button type="button" className="icon-button" disabled={saving} onClick={() => requestClose("close-button")} aria-label={t("성과 측정 설정 닫기")}><X size={18}/></button>
      </header>
      <div className="perf-settings-tabs" aria-label={t("성과 측정 설정")}>
        {Object.entries(tabs()).map(([key, label]) => <button key={key} type="button" className="secondary"
          disabled={saving} aria-pressed={tab === key} onClick={() => selectTab(key as Tab)}>{label}</button>)}
      </div>
      {error && <div className="kr-source-status" role="alert"><p>{error}</p>
        <button type="button" className="secondary" onClick={() => tab === "history" ? void listChanges() : setAttempt(n => n + 1)}>{t("최신 설정 불러오기")}</button>
      </div>}
      {notice && <p role="status" className="perf-notice">{notice}</p>}
      {tab === "history" ? <div className="perf-audit">
        {!audit.length && !error && <p>{t("변경 이력이 없습니다.")}</p>}
        {audit.map(row => <details className="kr-history-records" key={row.revision}>
          <summary>#{row.revision} · {tabs()[row.kind]} · {row.effectiveDate}</summary>
          <p>{t("변경 시각")} <time dateTime={row.recordedAt}>{new Date(row.recordedAt).toLocaleString()}</time></p>
          {row.reason && <p>{row.reason}</p>}
          <p>{t("영향 기간")} {row.affected.from} – {row.affected.through ?? t("이후")}</p>
          <AuditValue value={row.before} label={t("변경 전")} /><AuditValue value={row.after} label={t("변경 후")} />
        </details>)}
        {nextRevision !== null && <button type="button" className="secondary" onClick={() => void listChanges(nextRevision)}>{t("더 보기")}</button>}
      </div> : state && rule && project ? <form className="property-form perf-settings-form" onSubmit={event => void submit(event)}>
        <fieldset className="kr-source-fields" disabled={saving}>
          <label><span>{tab === "entry" ? t("성과 날짜") : t("적용 시작일")}</span>
            <input type="date" required value={date} max={tab === "entry" ? state.asOf : undefined} onChange={e => changeDate(e.target.value)}/></label>
          {tab === "rule" && <>
            <label><span>{t("데이터 소스")}</span><select value={rule.source} onChange={e => {
              const source = e.target.value as RuleDraft["source"];
              changeRule({ source, input: source === "api" ? "samples" : "events", aggregation: source === "api" ? "last" : "sum" });
            }}><option value="projects">{t("Project 성과 합산")}</option><option value="api">{t("API 연동")}</option><option value="manual">{t("직접 입력")}</option></select></label>
            {rule.source !== "projects" && <label><span>{t("데이터 형태")}</span><select value={rule.input} onChange={e => {
              const input = e.target.value as RuleDraft["input"]; changeRule({ input, aggregation: input === "samples" ? "last" : "sum" });
            }}>
              {rule.source === "manual" && <option value="events">{t("발생 건별 값")}</option>}
              <option value="samples">{t("시점별 측정값")}</option><option value="counter">{t("계속 증가하는 누적계")}</option>
            </select></label>}
            <div className="kr-data-number-grid">
              <label><span>{t("평가 기간")}</span><select value={rule.period} onChange={e => changeRule({ period: e.target.value as RuleDraft["period"] })}>
                <option value="monthly">{t("월간")}</option><option value="weekly">{t("주간")}</option>
                <option value="fixed">{t("지정 기간")}</option><option value="all_time">{t("전체 기간")}</option>
              </select></label>
              <label><span>{t("집계 방식")}</span><select value={rule.aggregation} onChange={e => changeRule({ aggregation: e.target.value as RuleDraft["aggregation"] })}>
                {rule.input === "samples" ? <><option value="last">{t("마지막 값")}</option><option value="average">{t("평균")}</option></>
                  : <option value="sum">{t("합계")}</option>}
              </select></label>
            </div>
            {rule.period === "fixed" && <div className="kr-data-number-grid">
              <label><span>{t("평가 시작일")}</span><input type="date" required value={rule.start ?? ""} onChange={e => changeRule({ start: e.target.value })}/></label>
              <label><span>{t("평가 종료일")}</span><input type="date" required min={rule.start ?? undefined} value={rule.end ?? ""} onChange={e => changeRule({ end: e.target.value })}/></label>
            </div>}
            <div className="kr-data-number-grid"><label><span>{t("단위")}</span><input maxLength={24} value={rule.unit} onChange={e => changeRule({ unit: e.target.value })}/></label>
              <label><span>{t("목표 방향")}</span><select value={rule.direction} onChange={e => changeRule({ direction: e.target.value as RuleDraft["direction"] })}>
                <option value="increase">{t("증가")}</option><option value="decrease">{t("감소")}</option></select></label></div>
            <div className="kr-data-number-grid"><label><span>{t("기준값")}</span><input type="number" step="any" required value={rule.baseline} onChange={e => changeRule({ baseline: e.target.value })}/></label>
              <label><span>{t("목표값")}</span><input type="number" step="any" required value={rule.target} onChange={e => changeRule({ target: e.target.value })}/></label></div>
          </>}
          {(tab === "project" || tab === "entry" && projectEntry) && <label><span>Project</span>
            <select required value={projectId} onChange={e => { setProjectId(e.target.value); setProject(projectDraft(state, e.target.value, date, legacy)); }}>
              <option value="">{t("선택")}</option>{projectOptions}
            </select></label>}
          {tab === "project" && <>
            <div className="kr-data-number-grid">
              <label><span>{t("기여 주기")}</span><select value={project.mode} onChange={e => changeProject({ mode: e.target.value as ProjectDraft["mode"] })}>
                {Object.entries(modes()).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
              </select></label>
              <label><span>{t("회당 기여량")}</span><input type="number" min="0" step="any" required value={project.amount} onChange={e => changeProject({ amount: e.target.value })}/></label>
            </div>
            <div className="kr-data-number-grid"><label><span>{t("운영 시작일")}</span><input type="date" required value={project.startDate} onChange={e => changeProject({ startDate: e.target.value })}/></label>
              {project.mode !== "once" && <label><span>{t("운영 종료일")}</span><input type="date" min={project.startDate} value={project.endDate} onChange={e => changeProject({ endDate: e.target.value })}/></label>}</div>
            <label className="perf-check"><input type="checkbox" checked={project.operating} onChange={e => changeProject({ operating: e.target.checked })}/>{t("운영 중")}</label>
            <label className="perf-check"><input type="checkbox" checked={project.isEstimate} onChange={e => changeProject({ isEstimate: e.target.checked })}/>{t("추정 성과")}</label>
            <label><span>{t("산정 근거")}</span><textarea required maxLength={1000} value={project.basis} onChange={e => changeProject({ basis: e.target.value })}/></label>
            {project.mode !== "once" && <fieldset className="kr-source-fields"><legend>{t("중지 기간")}</legend>
              {project.pauses.map((pause, index) => <div className="perf-pause" key={index}>
                <label><span>{t("중지 시작일")}</span><input type="date" required value={pause.startDate} onChange={e =>
                  changeProject({ pauses: project.pauses.map((p, i) => i === index ? { ...p, startDate: e.target.value } : p) })}/></label>
                <label><span>{t("중지 종료일")}</span><input type="date" min={pause.startDate} value={pause.endDate} onChange={e =>
                  changeProject({ pauses: project.pauses.map((p, i) => i === index ? { ...p, endDate: e.target.value } : p) })}/></label>
                <button type="button" className="secondary" onClick={() => changeProject({ pauses: project.pauses.filter((_, i) => i !== index) })}>{t("삭제")}</button>
              </div>)}
              <button type="button" className="secondary" disabled={project.pauses.length >= 50} onClick={() =>
                changeProject({ pauses: [...project.pauses, { startDate: date, endDate: "" }] })}>{t("중지 기간 추가")}</button>
            </fieldset>}
            <CalendarFields calendar={project.calendar} timezone={state.timezone} onChange={calendar => changeProject({ calendar })}/>
          </>}
          {tab === "entry" && <>
            {!projectEntry && <label><span>{t("성과 기록 ID")}</span><input required maxLength={128} value={entry.subjectId} onChange={e => { setDirty(true); setEntry({ ...entry, subjectId: e.target.value }); }}/></label>}
            <label className="perf-check"><input type="checkbox" checked={entry.voided} onChange={e => { setDirty(true); setEntry({ ...entry, voided: e.target.checked }); }}/>{t("기존 기록 취소")}</label>
            {!entry.voided && <label><span>{t("실적")}</span><input type="number" step="any" required value={entry.amount} onChange={e => { setDirty(true); setEntry({ ...entry, amount: e.target.value }); }}/></label>}
            <label className="perf-check"><input type="checkbox" checked={entry.isEstimate} onChange={e => { setDirty(true); setEntry({ ...entry, isEstimate: e.target.checked }); }}/>{t("추정 성과")}</label>
            <label><span>{t("산정 근거")}</span><textarea required maxLength={1000} value={entry.basis} onChange={e => { setDirty(true); setEntry({ ...entry, basis: e.target.value }); }}/></label>
          </>}
          <label><span>{t("변경 사유")}</span><textarea required={date < state.asOf || tab === "entry" && entry.voided}
            maxLength={1000} value={reason} onChange={e => { setDirty(true); setReason(e.target.value); }}/></label>
        </fieldset>
        <button type="submit" disabled={saving || tab === "project" && (!projectId || !projectEntry) ||
          tab === "entry" && (!active || active.value.source === "api")}>{saving ? t("저장 중") : <><Check size={15}/>{t("설정 저장")}</>}</button>
      </form> : !error && <p role="status" className="perf-notice">{t("데이터를 불러오는 중")}</p>}
    </aside>}
  </OverlayDialog>;
}

function AuditValue({ label, value }: { label: string; value: unknown }) {
  return <details className="perf-audit-value"><summary>{label}</summary><pre>{value ? JSON.stringify(value, null, 2) : "—"}</pre></details>;
}
function CalendarFields({ calendar, timezone, onChange }: { calendar: MetricCalendarInput | null; timezone: string; onChange: (v: MetricCalendarInput | null) => void }) {
  return <fieldset className="kr-source-fields"><legend>{t("영업일 달력")}</legend>
    <label className="perf-check"><input type="checkbox" checked={Boolean(calendar)} onChange={e =>
      onChange(e.target.checked ? { timezone, weekendDays: [0, 6], holidays: [] } : null)}/>{t("Project 달력 지정")}</label>
    {calendar ? <>
      <label><span>{t("시간대")}</span><input required value={calendar.timezone} onChange={e => onChange({ ...calendar, timezone: e.target.value })}/></label>
      <div className="perf-weekdays" aria-label={t("휴무 요일")}>{[t("일"), t("월"), t("화"), t("수"), t("목"), t("금"), t("토")].map((label, day) => {
        const days = calendar.weekendDays ?? [0, 6];
        return <label className="perf-check" key={day}><input type="checkbox" checked={days.includes(day)} onChange={e =>
          onChange({ ...calendar, weekendDays: e.target.checked ? [...days, day] : days.filter(value => value !== day) })}/>{label}</label>;
      })}</div>
      <label><span>{t("휴일 (한 줄에 YYYY-MM-DD 하나)")}</span><textarea value={calendar.holidays.join("\n")} onChange={e =>
        onChange({ ...calendar, holidays: e.target.value.split("\n") })}/></label>
    </> : <small>{t("저장 시 워크스페이스 달력을 적용합니다.")}</small>}
  </fieldset>;
}
