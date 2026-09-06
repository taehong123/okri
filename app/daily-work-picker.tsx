"use client";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { DailyWork } from "@/lib/daily-work";
import "./daily-work-picker.css";
import { t, messageValue } from "@/lib/client-language";

export function DailyWorkPicker({ label, work, selected, disabled, noPlanned, yesterday = false, conflictKeys = [], onChange, onNoPlanned, onOpen }: {
  label: string; work: DailyWork[]; selected: string[]; disabled: boolean; noPlanned?: boolean; yesterday?: boolean; conflictKeys?: string[];
  onChange: (keys: string[]) => void; onNoPlanned?: (value: boolean) => void; onOpen: (work: DailyWork) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => work.filter((entry) => !normalized || `${entry.title} ${entry.parentTitle}`.toLocaleLowerCase().includes(normalized)), [work, normalized]);
  const hasConflict = conflictKeys.length > 0;
  return <details className={`daily-task-picker${hasConflict ? " has-error" : ""}`} aria-label={label}>
    <summary aria-label={t("{value1} 선택 열기", { value1: messageValue(label) })}><span><b>{label}</b><small>{selected.length ? t("{count}개 선택", { count: selected.length }) : t("선택 없음")}</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
    <div className="daily-picker-panel">
      <label className="daily-picker-search"><Search size={16} aria-hidden="true" /><span className="sr-only">{t("업무 검색")}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Project · Task · Routine 검색")} /></label>
      <div className="daily-task-groups">{(["project", "task", "routine"] as const).map((kind) => {
        const entries = visible.filter((entry) => entry.kind === kind);
        return entries.length ? <section key={kind}><h3>{{ project: "Project", task: "Task", routine: "Routine" }[kind]}</h3>{entries.map((entry) => {
          const checked = selected.includes(entry.key);
          const conflict = conflictKeys.includes(entry.key);
          return <div className={`daily-task-option${conflict ? " conflict" : ""}`} data-kind={entry.kind} key={entry.key}><label><input type="checkbox" aria-label={t("{value1} 선택", { value1: messageValue(entry.title) })} checked={checked} disabled={disabled || Boolean(noPlanned) || (!checked && selected.length >= 50)} onChange={() => onChange(checked ? selected.filter((key) => key !== entry.key) : [...selected, entry.key])} /><span><b>{entry.title}</b><small>{entry.parentTitle}{entry.dueDate ? ` · ${entry.dueDate}` : ""}{yesterday && entry.willCompleteOnSubmit ? ` · ${t("제출 시 완료 처리")}` : ""}</small></span></label><button type="button" aria-label={t("{value1} 열기", { value1: messageValue(entry.title) })} title={t("{value1} 열기", { value1: messageValue(entry.title) })} onClick={() => onOpen(entry)}><ChevronRight size={16} /></button></div>;
        })}</section> : null;
      })}</div>
      {!visible.length && <p className="daily-empty">{query ? t("검색 결과가 없습니다.") : yesterday ? t("선택할 수 있는 업무가 없습니다.") : t("배정된 미완료 업무가 없습니다.")}</p>}
      {onNoPlanned && <label className="daily-none"><input type="checkbox" checked={Boolean(noPlanned)} disabled={disabled} onChange={(event) => onNoPlanned(event.target.checked)} />{t("오늘 예정 없음")}</label>}
    </div>
    {hasConflict && <p className="daily-picker-error" role="alert">{t("같은 업무를 완료한 일과 오늘 할 일에 동시에 선택할 수 없습니다.")}</p>}
  </details>;
}
