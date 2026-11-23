"use client";

import { useRef, useState, type FormEvent } from "react";
import { t } from "@/lib/client-language";
import type { listProjectOperations } from "@/lib/project-operations";
import type { ProjectOperations } from "@/lib/kr-performance-model";
import "./kr-performance.css";

type State = Awaited<ReturnType<typeof listProjectOperations>>;
const statuses = () => ({ planned: t("운영 예정"), operating: t("운영 중"), paused: t("운영 중지"),
  ended: t("운영 종료"), needs_confirmation: t("운영 확인 필요") });
const adoption = () => ({ unknown: t("사용 확인 필요"), unused: t("미사용"), partial: t("부분 도입"), in_use: t("사용 중") });
const initial: ProjectOperations = { status: "needs_confirmation", adoption: "unknown", startDate: null, endDate: null,
  lastOperationCheck: null, lastUseCheck: null, evidence: "", evidenceUrl: null, reviewAfterDays: 30, pauses: [] };

export default function ProjectOperationsSettings({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const [data, setData] = useState<State>();
  const [draft, setDraft] = useState<ProjectOperations>(initial);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef("");
  const item = data?.items[0];
  const set = (patch: Partial<ProjectOperations>) => {
    setDraft(value => ({ ...value, ...patch }));
    requestId.current = "";
    setNotice("");
  };

  async function load() {
    try {
      const response = await fetch("/api/project-operations?projectId=" + encodeURIComponent(projectId), { cache: "no-store" });
      if (!response.ok) throw Error();
      const next = await response.json() as State;
      setData(next); setDraft(next.items[0]?.operations ?? initial); setDate(next.asOf); setError("");
    } catch { setError(t("운영 정보를 불러오지 못했습니다.")); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!item || saving) return;
    setSaving(true); setError("");
    requestId.current ||= crypto.randomUUID();
    try {
      const response = await fetch("/api/project-operations", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, value: draft, effectiveDate: date, reason, expectedRevision: item.revision, requestId: requestId.current }) });
      if (!response.ok) throw Error(response.status === 409 ? "conflict" : "save");
      requestId.current = "";
      setNotice(t("저장했습니다."));
      setReason("");
      await load();
    } catch (failure) {
      setError(failure instanceof Error && failure.message === "conflict" ?
        t("다른 변경이 있었습니다. 최신 설정을 불러온 뒤 다시 저장해 주세요.") : t("저장하지 못했습니다. 입력한 값을 확인해 주세요."));
    } finally { setSaving(false); }
  }

  return <details className="kr-history-records" onToggle={event => { if (event.currentTarget.open && !data && !error) void load(); }}>
    <summary>{t("운영·사용 현황")}{item?.operations && " · " + statuses()[item.operations.status]}</summary>
    {error && <p role="alert">{error} <button type="button" className="secondary" onClick={() => void load()}>{t("최신 설정 불러오기")}</button></p>}
    {notice && <p role="status">{notice}</p>}
    {!data && !error && <p role="status">{t("데이터를 불러오는 중")}</p>}
    {item && <>
      <p className="perf-meta">{adoption()[item.operations?.adoption ?? "unknown"]}
        {item.useEvidence === "stale" && " · " + t("사용 재확인 필요")}</p>
      {item.operations?.evidenceUrl && <a href={item.operations.evidenceUrl} target="_blank" rel="noreferrer">{t("확인 근거 링크")}</a>}
    </>}
    {!readOnly && item && <form className="property-form perf-settings-form" onSubmit={e => void save(e)}>
      <fieldset className="kr-source-fields" disabled={saving}>
        <div className="kr-data-number-grid">
          <label><span>{t("운영 상태")}</span><select value={draft.status} onChange={e => set({ status: e.target.value as ProjectOperations["status"] })}>
            {Object.entries(statuses()).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label><span>{t("사용 상태")}</span><select value={draft.adoption} onChange={e => set({ adoption: e.target.value as ProjectOperations["adoption"] })}>
            {Object.entries(adoption()).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        </div>
        <div className="kr-data-number-grid">
          <label><span>{t("운영 시작일")}</span><input type="date" value={draft.startDate ?? ""} onChange={e => set({ startDate: e.target.value || null })}/></label>
          <label><span>{t("운영 종료일")}</span><input type="date" min={draft.startDate ?? undefined} value={draft.endDate ?? ""} onChange={e => set({ endDate: e.target.value || null })}/></label>
        </div>
        <div className="kr-data-number-grid">
          <label><span>{t("마지막 운영 확인일")}</span><input type="date" max={data.asOf} value={draft.lastOperationCheck ?? ""} onChange={e => set({ lastOperationCheck: e.target.value || null })}/></label>
          <label><span>{t("마지막 사용 확인일")}</span><input type="date" max={data.asOf} value={draft.lastUseCheck ?? ""} onChange={e => set({ lastUseCheck: e.target.value || null })}/></label>
        </div>
        <label><span>{t("확인 근거")}</span><textarea maxLength={1000} value={draft.evidence} onChange={e => set({ evidence: e.target.value })}/></label>
        <label><span>{t("확인 근거 링크")}</span><input type="url" maxLength={2000} value={draft.evidenceUrl ?? ""} onChange={e => set({ evidenceUrl: e.target.value || null })}/></label>
        <fieldset className="kr-source-fields"><legend>{t("중지 기간")}</legend>
          {draft.pauses.map((pause, index) => <div className="perf-pause" key={index}>
            <label><span>{t("중지 시작일")}</span><input type="date" required value={pause.startDate} onChange={e =>
              set({ pauses: draft.pauses.map((p, i) => i === index ? { ...p, startDate: e.target.value } : p) })}/></label>
            <label><span>{t("중지 종료일")}</span><input type="date" value={pause.endDate ?? ""} min={pause.startDate} onChange={e =>
              set({ pauses: draft.pauses.map((p, i) => i === index ? { ...p, endDate: e.target.value || null } : p) })}/></label>
            <button type="button" className="secondary" onClick={() => set({ pauses: draft.pauses.filter((_, i) => i !== index) })}>{t("삭제")}</button>
          </div>)}
          <button type="button" className="secondary" disabled={draft.pauses.length >= 50} onClick={() =>
            set({ pauses: [...draft.pauses, { startDate: date, endDate: null }] })}>{t("중지 기간 추가")}</button>
        </fieldset>
        <label><span>{t("적용 시작일")}</span><input required type="date" value={date} onChange={e => { setDate(e.target.value); requestId.current = ""; }}/></label>
        <label><span>{t("변경 사유")}</span><textarea required={date < data.asOf} maxLength={1000} value={reason} onChange={e => { setReason(e.target.value); requestId.current = ""; }}/></label>
      </fieldset>
      <button type="submit" disabled={saving}>{saving ? t("저장 중") : t("설정 저장")}</button>
    </form>}
  </details>;
}
