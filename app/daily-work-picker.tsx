"use client";
import { Check, ChevronDown, ChevronRight, LoaderCircle, Plus, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DailyWork } from "@/lib/daily-work";
import "./daily-work-picker.css";
import { t, messageValue } from "@/lib/client-language";

export function DailyWorkPicker({ label, work, selected, disabled, noPlanned, yesterday = false, conflictKeys = [], onChange, onNoPlanned, onOpen, containers = [], onCreate }: {
  label: string; work: DailyWork[]; selected: string[]; disabled: boolean; noPlanned?: boolean; yesterday?: boolean; conflictKeys?: string[];
  onChange: (keys: string[]) => void; onNoPlanned?: (value: boolean) => void; onOpen: (work: DailyWork) => void;
  containers?: Array<{ id: string; title: string; kind: "project" | "routine"; hasTasks?: boolean }>;
  onCreate?: (parentKey: string, title: string, requestId: string) => Promise<string | false>;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<{ parentKey: string; title: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [created, setCreated] = useState<typeof creating>(null);
  const inFlight = useRef(false);
  const feedback = useRef<HTMLDivElement | null>(null);
  const errorId = useId();
  const addButton = useRef<HTMLButtonElement | null>(null);
  const titleInput = useRef<HTMLInputElement | null>(null);
  const entryId = creating?.requestId;
  useEffect(() => { if (entryId) titleInput.current?.focus(); }, [entryId]);
  useEffect(() => { if (created) feedback.current?.focus(); }, [created]);
  function closeEntry() { setCreating(null); setCreateFailed(false); requestAnimationFrame(() => addButton.current?.focus()); }
  function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !busy) { event.stopPropagation(); closeEntry(); } }
  const normalized = query.trim().toLocaleLowerCase();
  const groups = useMemo(() => {
    const rows = new Map<string, { title: string; parentKey?: string; kind?: "project" | "routine"; hasTasks?: boolean; entries: DailyWork[] }>();
    if (!yesterday) {
      for (const container of containers) {
        const parentKey = `${container.kind}:${container.id}`;
        rows.set(parentKey, { title: container.title, parentKey, kind: container.kind, hasTasks: container.hasTasks, entries: [] });
      }
    }
    for (const entry of work) {
      if (entry.kind === "project" || entry.kind === "routine") {
        if (!yesterday && !rows.has(entry.key)) rows.set(entry.key, { title: entry.title, parentKey: entry.key, kind: entry.kind, entries: [] });
        continue;
      }
      const key = entry.parentId ? `${entry.parentKind ?? "parent"}:${entry.parentId}` : "general";
      const parentKind = entry.parentKind === "project" || entry.parentKind === "routine" ? entry.parentKind : undefined;
      const group = rows.get(key) ?? { title: entry.parentId ? entry.parentTitle : "General", kind: parentKind, entries: [] };
      group.entries.push(entry); rows.set(key, group);
    }
    return [...rows.entries()].flatMap(([key, group]) => {
      const matchesGroup = !normalized || group.title.toLocaleLowerCase().includes(normalized);
      const entries = group.entries.filter((entry) => matchesGroup || entry.title.toLocaleLowerCase().includes(normalized));
      return matchesGroup || entries.length ? [{ ...group, key, entries }] : [];
    });
  }, [work, containers, normalized, yesterday]);
  async function createTask() {
    if (!creating?.title.trim() || !onCreate || disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setCreateFailed(false);
    try {
      const title = await onCreate(creating.parentKey, creating.title, creating.requestId);
      if (title !== false) {
        setQuery("");
        setCreating(null);
        setCreated({ ...creating, title });
      } else setCreateFailed(true);
    } catch { setCreateFailed(true); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const hasConflict = conflictKeys.length > 0;
  return <details className={`daily-task-picker${hasConflict ? " has-error" : ""}`} aria-label={label} open={yesterday ? undefined : true}>
    <summary aria-label={t("{value1} 선택 열기", { value1: messageValue(label) })}><span><b>{label}</b><small>{selected.length ? t("{count}개 선택", { count: selected.length }) : t("선택 없음")}</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
    <div className="daily-picker-panel">
      <label className="daily-picker-search"><Search size={16} aria-hidden="true" /><span className="sr-only">{t("업무 검색")}</span><input type="search" value={query} disabled={Boolean(creating)} onChange={(event) => setQuery(event.target.value)} placeholder={t("Project · Task · Routine 검색")} /></label>
      <div className="daily-task-groups">{groups.map((group) => {
        const container = work.find((entry) => (entry.kind === "project" || entry.kind === "routine") && entry.key === group.key);
        return <section key={group.key} aria-label={group.title} data-kind={group.kind}><header className="daily-project-heading"><h3>{group.kind && <span className="daily-container-kind">{t(group.kind === "project" ? "Project" : "Routine")}</span>}{container ? <button type="button" title={t("{value1} 열기", { value1: container.title })} onClick={() => onOpen(container)}>{group.title}</button> : group.title}</h3>{group.parentKey && onCreate && <button className="icon-button" type="button" disabled={disabled || busy || Boolean(creating)} title={t("{value1}에 Task 추가", { value1: group.title })} aria-label={t("{value1}에 Task 추가", { value1: group.title })} onClick={(event) => { addButton.current = event.currentTarget; setCreated(null); setCreateFailed(false); setCreating({ parentKey: group.parentKey!, title: "", requestId: crypto.randomUUID() }); }}><Plus size={16} /></button>}</header>
        {created && created.parentKey === group.parentKey && <div className="daily-create-feedback" role="status" aria-atomic="true" tabIndex={-1} ref={feedback}>
          <Check size={18} aria-hidden="true" /><div><b>{created.title}</b><span>{t("Task를 추가하고 오늘 할 일에 선택했습니다.")}</span></div>
          <button className="icon-button" type="button" aria-label={t("추가 결과 닫기")} title={t("추가 결과 닫기")} onClick={() => { setCreated(null); requestAnimationFrame(() => addButton.current?.focus()); }}><X size={16} /></button>
        </div>}
        {group.entries.map((entry) => {
          const checked = selected.includes(entry.key);
          const conflict = conflictKeys.includes(entry.key);
          return <div className={`daily-task-option${checked ? " is-selected" : ""}${conflict ? " conflict" : ""}`} data-kind={entry.kind} key={entry.key}><label><input type="checkbox" aria-label={t("{value1} 선택", { value1: messageValue(entry.title) })} checked={checked} disabled={disabled || Boolean(noPlanned) || (!checked && selected.length >= 50)} onChange={() => { setCreated(null); onChange(checked ? selected.filter((key) => key !== entry.key) : [...selected, entry.key]); }} /><span><b>{entry.title}</b><small>{entry.parentTitle}{entry.dueDate ? ` · ${entry.dueDate}` : ""}{yesterday && entry.willCompleteOnSubmit ? ` · ${t("제출 시 완료 처리")}` : ""}</small></span></label><button type="button" aria-label={t("{value1} 열기", { value1: messageValue(entry.title) })} title={t("{value1} 열기", { value1: messageValue(entry.title) })} onClick={() => onOpen(entry)}><ChevronRight size={16} /></button></div>;
        })}{!group.entries.length && <p className="daily-empty">{t(group.hasTasks === false ? "아직 Task가 없습니다." : "내게 할당된 미완료 Task가 없습니다.")}</p>}
        {creating && creating.parentKey === group.parentKey && <form className="daily-project-create" aria-label={t("Task 추가")} onSubmit={(event) => { event.preventDefault(); void createTask(); }}>
          <label><span>{t("새 Task 제목")}</span><input ref={titleInput} value={creating.title} disabled={busy} maxLength={240} aria-describedby={createFailed ? errorId : undefined} onKeyDown={closeOnEscape} onChange={(event) => setCreating({ ...creating, title: event.target.value })} /></label>
          {createFailed && <p id={errorId} className="daily-create-error" role="alert">{t("추가를 완료하지 못했습니다. 입력한 내용으로 다시 시도할 수 있습니다.")}</p>}
          <div><button className="secondary" type="submit" disabled={busy || disabled || !creating.title.trim()} aria-busy={busy} onKeyDown={closeOnEscape}>{busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}<span className="daily-create-label"><span aria-hidden="true">{t("추가하고 오늘 할 일에 선택")}</span><span>{busy ? t("추가하고 선택 중") : createFailed ? t("다시 시도") : t("추가하고 오늘 할 일에 선택")}</span></span></button><button className="icon-button" type="button" disabled={busy} title={t("취소")} aria-label={t("취소")} onClick={closeEntry} onKeyDown={closeOnEscape}><X size={16} /></button></div>
          <span className="sr-only" role="status">{busy ? t("추가하고 선택 중") : ""}</span>
        </form>}
        </section>;
      })}</div>
      {!groups.length && <p className="daily-empty">{query ? t("검색 결과가 없습니다.") : yesterday ? t("선택할 수 있는 업무가 없습니다.") : t("배정된 미완료 업무가 없습니다.")}</p>}
      {onNoPlanned && <label className="daily-none"><input type="checkbox" checked={Boolean(noPlanned)} disabled={disabled} onChange={(event) => { setCreated(null); onNoPlanned(event.target.checked); }} />{t("오늘 예정 없음")}</label>}
    </div>
    {hasConflict && <p className="daily-picker-error" role="alert">{t("같은 업무를 완료한 일과 오늘 할 일에 동시에 선택할 수 없습니다.")}</p>}
  </details>;
}
