"use client";

import { Check, ChevronDown, ChevronLeft, ChevronRight, Diamond, FolderKanban } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { displayDate, getClientLocale, messageValue, t, useLanguage } from "@/lib/client-language";

type GanttStatus = "backlog" | "todo" | "policy_discussion" | "in_progress" | "developing" | "development_done" | "done" | "blocked" | "archived";
type GanttItem = {
  id: string;
  parentId: string | null;
  kind: string;
  title: string;
  status: GanttStatus;
  progress: number;
  dueDate: string | null;
  assignments: Array<{ role: string; displayName: string }>;
};

type GanttViewProps = {
  items: GanttItem[];
  onOpenProject: (id: string) => void;
  onOpenTask: (id: string) => void;
};

type Zoom = "fortnight" | "month";
const dayMs = 86_400_000;

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, count: number) {
  return new Date(value.getTime() + count * dayMs);
}

function addMonths(value: Date, count: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + count, 1));
}

function startOfWeek(value: Date) {
  const day = value.getUTCDay();
  return addDays(value, -(day === 0 ? 6 : day - 1));
}

function localToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function isComplete(status: GanttStatus) {
  return status === "done" || status === "development_done";
}

function statusLabel(status: GanttStatus) {
  return t({
    backlog: "백로그",
    todo: "할 일",
    policy_discussion: "정책 논의",
    in_progress: "진행 중",
    developing: "개발 중",
    development_done: "개발 완료",
    done: "완료",
    blocked: "막힘",
    archived: "보관",
  }[status]);
}

function dateDifference(left: Date, right: Date) {
  return Math.round((right.getTime() - left.getTime()) / dayMs);
}

function rangeFor(anchor: Date, zoom: Zoom) {
  if (zoom === "fortnight") {
    const start = startOfWeek(addDays(anchor, -7));
    return { start, end: addDays(start, 13) };
  }
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
  return { start, end };
}

function rangePosition(value: Date, start: Date, end: Date) {
  if (value < start) return { index: 0, edge: "before" as const };
  if (value > end) return { index: dateDifference(start, end), edge: "after" as const };
  return { index: dateDifference(start, value), edge: null };
}

function rangeLabel(start: Date, end: Date, locale: string) {
  const format = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return `${format.format(start)} - ${format.format(end)}`;
}

function assigneeLabel(project: GanttItem) {
  return project.assignments.find((assignment) => assignment.role === "project_dri")?.displayName ?? t("책임자 없음");
}

export default function GanttView({ items, onOpenProject, onOpenTask }: GanttViewProps) {
  useLanguage();
  const today = useMemo(() => localToday(), []);
  const todayIso = isoDate(today);
  const [zoom, setZoom] = useState<Zoom>("fortnight");
  const [anchor, setAnchor] = useState(today);
  const projects = useMemo(() => items.filter((item) => item.kind === "project")
    .sort((left, right) => {
      const leftOverdue = Boolean(left.dueDate && left.dueDate < todayIso && !isComplete(left.status));
      const rightOverdue = Boolean(right.dueDate && right.dueDate < todayIso && !isComplete(right.status));
      if (leftOverdue !== rightOverdue) return leftOverdue ? -1 : 1;
      return (left.dueDate ?? "9999-12-31").localeCompare(right.dueDate ?? "9999-12-31") || left.title.localeCompare(right.title);
    }), [items, todayIso]);
  const tasksByProject = useMemo(() => {
    const result = new Map<string, GanttItem[]>();
    for (const task of items.filter((item) => item.kind === "task" && item.parentId)) {
      const tasks = result.get(task.parentId!) ?? [];
      tasks.push(task);
      result.set(task.parentId!, tasks);
    }
    for (const tasks of result.values()) tasks.sort((left, right) => (left.dueDate ?? "9999-12-31").localeCompare(right.dueDate ?? "9999-12-31") || left.title.localeCompare(right.title));
    return result;
  }, [items]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const { start, end } = useMemo(() => rangeFor(anchor, zoom), [anchor, zoom]);
  const days = useMemo(() => Array.from({ length: dateDifference(start, end) + 1 }, (_, index) => addDays(start, index)), [start, end]);
  const overdueCount = projects.filter((project) => project.dueDate && project.dueDate < todayIso && !isComplete(project.status)).length;
  const undatedCount = projects.filter((project) => !project.dueDate).length;
  const locale = getClientLocale();
  const weekdayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" }), [locale]);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", timeZone: "UTC" }), [locale]);
  const timelineStyle = { "--gantt-day-count": days.length, "--gantt-day-width": zoom === "fortnight" ? "3.5rem" : "2.25rem" } as CSSProperties;

  function moveRange(direction: -1 | 1) {
    setAnchor((current) => zoom === "fortnight" ? addDays(current, direction * 14) : addMonths(current, direction));
  }

  function chooseZoom(next: Zoom) {
    setZoom(next);
    setAnchor((current) => current);
  }

  function toggleProject(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="gantt-view" aria-label={t("Project 일정")}>
      <header className="gantt-toolbar">
        <div className="gantt-range-control">
          <div className="gantt-range-navigation" role="group" aria-label={t("날짜")}>
            <button type="button" onClick={() => moveRange(-1)} aria-label={t("이전")} title={t("이전")}><ChevronLeft size={17} /></button>
            <button className="gantt-today" type="button" aria-current={isoDate(anchor) === todayIso ? "date" : undefined} onClick={() => setAnchor(today)}>{t("오늘")}</button>
            <button type="button" onClick={() => moveRange(1)} aria-label={t("다음")} title={t("다음")}><ChevronRight size={17} /></button>
          </div>
          <strong>{rangeLabel(start, end, locale)}</strong>
        </div>
        <div className="gantt-zoom" role="group" aria-label={t("일정 범위")}>
          <button type="button" className={zoom === "fortnight" ? "selected" : ""} aria-pressed={zoom === "fortnight"} onClick={() => chooseZoom("fortnight")}>{t("2주")}</button>
          <button type="button" className={zoom === "month" ? "selected" : ""} aria-pressed={zoom === "month"} onClick={() => chooseZoom("month")}>{t("월간")}</button>
        </div>
      </header>

      <div className="gantt-summary" aria-label={t("일정 요약")}>
        <span>{t("Project {count}개", { count: projects.length })}</span>
        <span className={overdueCount ? "danger" : ""}>{t("기한 초과")} {messageValue(overdueCount)}</span>
        <span>{t("기한 없음")} {messageValue(undatedCount)}</span>
      </div>

      {!projects.length ? (
        <div className="gantt-empty"><FolderKanban size={22} /><div><h2>{t("간트에 표시할 Project가 없습니다.")}</h2><p>{t("Project를 만들면 마감 일정과 하위 Task가 여기에 표시됩니다.")}</p></div></div>
      ) : (
        <div className="gantt-scroll" role="group" aria-label={t("Project와 Task 일정표")}>
          <div className="gantt-table" style={timelineStyle}>
            <div className="gantt-row gantt-date-row">
              <div className="gantt-label gantt-label-header"><span>{t("Project")}</span><small>{t("오늘과 마감일 기준")}</small></div>
              <div className="gantt-track gantt-days" aria-hidden="true">
                {days.map((day) => {
                  const value = isoDate(day);
                  const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
                  return <span className={`${weekend ? "weekend" : ""} ${value === todayIso ? "today" : ""}`} key={value}><small>{weekdayFormat.format(day)}</small><b>{dateFormat.format(day)}</b></span>;
                })}
              </div>
            </div>

            {projects.map((project) => {
              const tasks = tasksByProject.get(project.id) ?? [];
              const open = expanded.has(project.id);
              const completed = isComplete(project.status);
              const overdue = Boolean(project.dueDate && project.dueDate < todayIso && !completed);
              const projectDue = project.dueDate ? parseDate(project.dueDate) : null;
              const position = projectDue ? rangePosition(projectDue, start, end) : null;
              let interval: { start: number; end: number } | null = null;
              if (projectDue) {
                const earlier = projectDue < today ? projectDue : today;
                const later = projectDue < today ? today : projectDue;
                if (later < start) interval = { start: 0, end: 0 };
                else if (earlier > end) interval = { start: days.length - 1, end: days.length - 1 };
                else interval = {
                  start: Math.max(0, dateDifference(start, earlier)),
                  end: Math.min(days.length - 1, dateDifference(start, later)),
                };
                if (completed && position) interval = { start: position.index, end: position.index };
              }
              const dueDistance = projectDue ? Math.abs(dateDifference(today, projectDue)) : 0;
              const barLabel = completed ? t("완료") : project.dueDate === todayIso ? t("오늘 마감") : overdue
                ? t("{count}일 지연", { count: dueDistance }) : t("{count}일 남음", { count: dueDistance });
              return <div className="gantt-project" key={project.id}>
                <div className={`gantt-row gantt-project-row ${overdue ? "overdue" : ""}`}>
                  <div className="gantt-label gantt-project-label">
                    <button className="gantt-expand" type="button" aria-expanded={open} aria-label={`${project.title} · ${open ? t("접기") : t("펼치기")}`} onClick={() => toggleProject(project.id)} disabled={!tasks.length}><ChevronDown size={17} /></button>
                    <button className="gantt-title" type="button" onClick={() => onOpenProject(project.id)}><b>{project.title}</b><small><span className={`status-tag status-${project.status}`}>{statusLabel(project.status)}</span><span>{assigneeLabel(project)}</span><span>{project.dueDate ? displayDate(project.dueDate) : t("기한 없음")}</span></small></button>
                  </div>
                  <div className="gantt-track" aria-label={`${project.title} · ${project.dueDate ? displayDate(project.dueDate) : t("기한 없음")}`}>
                    {days.map((day) => <span className={`gantt-cell ${day.getUTCDay() === 0 || day.getUTCDay() === 6 ? "weekend" : ""} ${isoDate(day) === todayIso ? "today" : ""}`} key={isoDate(day)} />)}
                    {interval && <button type="button" className={`gantt-bar ${overdue ? "overdue" : completed ? "complete" : ""} ${position?.edge ? `edge-${position.edge}` : ""}`} style={{ gridColumn: `${interval.start + 1} / ${interval.end + 2}` }} onClick={() => onOpenProject(project.id)} aria-label={`${project.title} · ${barLabel}`} title={`${project.title} · ${barLabel}`}><span className="gantt-bar-progress" style={{ width: `${Math.max(0, Math.min(100, project.progress))}%` }} /><span className="gantt-bar-copy">{position?.edge === "before" ? "‹ " : ""}{barLabel}{position?.edge === "after" ? " ›" : ""}</span></button>}
                    {!projectDue && <span className="gantt-no-date">{t("기한 없음")}</span>}
                  </div>
                </div>
                {open && tasks.map((task) => {
                  const taskDue = task.dueDate ? parseDate(task.dueDate) : null;
                  const taskPosition = taskDue ? rangePosition(taskDue, start, end) : null;
                  return <div className="gantt-row gantt-task-row" key={task.id}>
                    <div className="gantt-label gantt-task-label"><span className={`gantt-task-icon ${isComplete(task.status) ? "complete" : ""}`}>{isComplete(task.status) ? <Check size={13} /> : <Diamond size={12} />}</span><button className="gantt-title" type="button" onClick={() => onOpenTask(task.id)}><b>{task.title}</b><small><span>{statusLabel(task.status)}</span><span>{task.dueDate ? displayDate(task.dueDate) : t("기한 없음")}</span></small></button></div>
                    <div className="gantt-track" aria-label={`${task.title} · ${task.dueDate ? displayDate(task.dueDate) : t("기한 없음")}`}>
                      {days.map((day) => <span className={`gantt-cell ${day.getUTCDay() === 0 || day.getUTCDay() === 6 ? "weekend" : ""} ${isoDate(day) === todayIso ? "today" : ""}`} key={isoDate(day)} />)}
                      {taskPosition && <button type="button" className={`gantt-milestone ${isComplete(task.status) ? "complete" : task.dueDate! < todayIso ? "overdue" : ""} ${taskPosition.edge ? `edge-${taskPosition.edge}` : ""}`} style={{ gridColumn: `${taskPosition.index + 1}` }} onClick={() => onOpenTask(task.id)} aria-label={`${task.title} · ${displayDate(task.dueDate!)}`} title={`${task.title} · ${displayDate(task.dueDate!)}`}><span /></button>}
                      {!taskDue && <span className="gantt-no-date">{t("기한 없음")}</span>}
                    </div>
                  </div>;
                })}
              </div>;
            })}
          </div>
        </div>
      )}
    </section>
  );
}
