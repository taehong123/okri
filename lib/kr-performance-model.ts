import { calendarInput, dateOnly, localDate, scheduleCredits, scheduleInput, shiftDate,
  type ContributionScheduleInput, type MetricCalendar } from "./project-metric-schedule-model";

export type Grain = "day" | "week" | "month";
export type Range = { start: string; end: string };
export type MeasurementRule = {
  source: "projects" | "api" | "manual";
  input: "events" | "samples" | "counter";
  aggregation: "sum" | "last" | "average";
  period: "monthly" | "weekly" | "fixed" | "all_time";
  start: string | null;
  end: string | null;
  baseline: number;
  target: number;
  direction: "increase" | "decrease";
  unit: string;
  timezone: string;
};
export type ProjectRule = ContributionScheduleInput & {
  operating: boolean;
  isEstimate: boolean;
  basis: string;
  calendar: MetricCalendar;
  title: string;
  unit: string;
  earnedDates?: string[];
  earnedThrough?: string;
};
export type Entry = {
  date: string;
  value: number;
  isEstimate: boolean;
  basis: string;
  projectId: string | null;
  title: string | null;
  unit: string;
  input: MeasurementRule["input"];
  source: MeasurementRule["source"];
  voided: boolean;
};
export type Version<T> = { effectiveDate: string; recordedAt: string; revision: number; value: T };
export type ProjectVersion = Version<ProjectRule> & { projectId: string };
export type Measurement = Omit<Entry, "voided"> & { id: string; recordedAt: string };
export type ApiSample = { id: string; observedAt: string; value: number; unit: string };
export type Stop = { projectId: string; recordedAt: string };
export type Data = {
  rules: Version<MeasurementRule>[];
  projects: ProjectVersion[];
  entries: Measurement[];
  samples: ApiSample[];
  stops: Stop[];
};

export class PerformanceError extends Error {
  constructor(public code: string, public status = 400) { super(code); this.name = "PerformanceError"; }
}
export function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PerformanceError("invalid_performance_input");
  return value as Record<string, unknown>;
}
export function textValue(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.trim().length > max || (!allowEmpty && !value.trim())) throw new PerformanceError("invalid_performance_input");
  return value.trim();
}
export function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e12) throw new PerformanceError("invalid_performance_value");
  return value;
}
export function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new PerformanceError("invalid_performance_option");
  return value as T[number];
}
export function bool(value: unknown, fallback?: boolean) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") throw new PerformanceError("invalid_performance_input");
  return value;
}
export function ruleInput(raw: unknown, timezone: string): MeasurementRule {
  const v = record(raw);
  const source = choice(v.source, ["projects", "api", "manual"]);
  const input = choice(v.input, ["events", "samples", "counter"]);
  const aggregation = choice(v.aggregation, ["sum", "last", "average"]);
  const period = choice(v.period, ["monthly", "weekly", "fixed", "all_time"]);
  if ((source === "projects" && input !== "events") || (source === "api" && input === "events") ||
      ((input === "samples") === (aggregation === "sum"))) throw new PerformanceError("incompatible_performance_aggregation");
  const direction = choice(v.direction, ["increase", "decrease"]);
  const baseline = amount(v.baseline), target = amount(v.target);
  if (direction === "increase" ? target <= baseline : target >= baseline) throw new PerformanceError("invalid_performance_target");
  const start = period === "fixed" ? dateOnly(v.start) : null, end = period === "fixed" ? dateOnly(v.end) : null;
  if (start && end) validateRange(start, end);
  return { source, input, aggregation, period, start, end, baseline, target, direction, unit: textValue(v.unit, 24, true), timezone };
}
export function projectRuleInput(raw: unknown, fallback: MetricCalendar, title: string, unit: string): ProjectRule {
  const v = record(raw);
  const custom = v.calendar == null ? null : record(v.calendar);
  const weekends = custom?.weekendDays;
  if (weekends !== undefined && (!Array.isArray(weekends) || weekends.length > 7 ||
      !weekends.every(day => Number.isInteger(day) && day >= 0 && day < 7))) {
    throw new PerformanceError("invalid_metric_calendar");
  }
  const calendar = custom ? { ...calendarInput(custom), weekendDays: [...new Set(weekends as number[] | undefined ?? [0, 6])], version: 0 } : fallback;
  return { ...scheduleInput(v), operating: bool(v.operating, true), isEstimate: bool(v.isEstimate, true),
    basis: textValue(v.basis, 1000), calendar, title, unit };
}

const minDate = (...values: string[]) => values.sort()[0];
const maxDate = (...values: string[]) => values.sort().at(-1)!;
function dayGap(start: string, end: string) {
  return (Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000;
}
export function validateRange(start: string, end: string) {
  if (dayGap(start, end) < 0 || dayGap(start, end) > 3660 || start < "1900-01-01" || end > "2199-12-31") {
    throw new PerformanceError("invalid_performance_range");
  }
}
function monthEnd(date: string) {
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7), 0)).toISOString().slice(0, 10);
}
function weekStart(date: string) {
  const weekday = new Date(date + "T00:00:00Z").getUTCDay();
  return shiftDate(date, -((weekday + 6) % 7));
}
export function evaluationRange(rule: MeasurementRule, date: string, first: string): Range {
  switch (rule.period) {
    case "monthly": return { start: date.slice(0, 7) + "-01", end: monthEnd(date) };
    case "weekly": return { start: weekStart(date), end: shiftDate(weekStart(date), 6) };
    case "fixed": return { start: rule.start!, end: rule.end! };
    case "all_time": return { start: first, end: date };
  }
}
export function ruleAt<T>(rules: Version<T>[], date: string) {
  return rules.filter(rule => rule.effectiveDate <= date).at(-1);
}
function chronological<T extends Version<unknown>>(rows: T[]) {
  return rows.slice().sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.revision - b.revision);
}
export function metricProgress(value: number | null, rule: MeasurementRule) {
  return value === null ? null : Math.max(0, Math.min(100, Math.round(100 * (value - rule.baseline) / (rule.target - rule.baseline))));
}
function endForGrain(date: string, grain: Grain) {
  return grain === "day" ? date : grain === "week" ? shiftDate(weekStart(date), 6) : monthEnd(date);
}
function series(rule: MeasurementRule) {
  return [rule.source, rule.input, rule.unit, rule.timezone].join("\u0000");
}

function materialize(data: Data, rules: Version<MeasurementRule>[], asOf: string, now: Date) {
  const rows: Measurement[] = data.entries.filter(entry => entry.date <= asOf);
  const overrides = new Set(rows.filter(row => row.projectId).map(row => row.projectId + "/" + row.date));
  const byProject = new Map<string, ProjectVersion[]>();
  for (const p of chronological(data.projects)) byProject.set(p.projectId, [...(byProject.get(p.projectId) ?? []), p]);
  for (const [id, versions] of byProject) {
    for (const [index, version] of versions.entries()) {
      const rule = version.value;
      const next = versions[index + 1]?.effectiveDate;
      let end = next ? minDate(asOf, shiftDate(next, -1)) : asOf;
      const stop = data.stops.find(s => s.projectId === id && s.recordedAt > version.recordedAt);
      if (stop) end = minDate(end, shiftDate(localDate(new Date(stop.recordedAt), rule.calendar.timezone), -1));
      const start = maxDate(version.effectiveDate, rule.startDate);
      if (start > end) continue;
      const inherited = rule.earnedDates?.filter(date => date >= start && date <= end) ?? [];
      let newDates: string[] = [];
      if (rule.operating && !(rule.mode === "once" && rule.startDate < start)) {
        let scheduledStart = rule.earnedThrough ? maxDate(start, shiftDate(rule.earnedThrough, 1)) : start;
        if (rule.mode === "weekly") scheduledStart = shiftDate(scheduledStart, (7 - dayGap(rule.startDate, scheduledStart) % 7) % 7);
        if (scheduledStart <= minDate(end, rule.endDate ?? end) && (rule.mode !== "once" || scheduledStart === rule.startDate)) {
          newDates = scheduleCredits({ ...rule, startDate: scheduledStart, endDate: minDate(end, rule.endDate ?? end) }, rule.calendar, now).dates;
        }
      }
      for (const date of new Set([...inherited, ...newDates])) {
        if (overrides.has(id + "/" + date)) continue;
        rows.push({ id: id + "/" + date, date, value: rule.amount, isEstimate: rule.isEstimate,
          basis: rule.basis, projectId: id, title: rule.title, unit: rule.unit, input: "events",
          source: "projects", recordedAt: version.recordedAt });
      }
    }
  }
  const apiZones = [...new Set(rules.filter(r => r.value.source === "api").map(r => r.value.timezone))];
  for (const timezone of apiZones) {
    for (const sample of data.samples) {
      const date = localDate(new Date(sample.observedAt), timezone);
      const rule = ruleAt(rules, date)?.value;
      if (!rule || rule.source !== "api" || rule.timezone !== timezone || rule.unit !== sample.unit || date > asOf) continue;
      rows.push({ id: sample.id, date, value: sample.value, isEstimate: false, basis: "",
        projectId: null, title: null, unit: sample.unit, input: rule.input,
        source: "api", recordedAt: sample.observedAt });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
}

function measured(rows: Measurement[], rule: MeasurementRule, asOf: string, start: string, end: string) {
  if (end < start || asOf < start) return { value: null, records: [] as Measurement[], hasEstimates: false, counterGaps: 0 };
  const to = minDate(asOf, end);
  if (rule.input === "counter") {
    let previous: number | undefined, gaps = 0;
    const deltas: Measurement[] = [];
    for (const row of rows) {
      if (row.date > to) break;
      if (row.date >= start) {
        if (previous !== undefined && row.value >= previous) deltas.push({ ...row, value: row.value - previous });
        else gaps++;
      }
      previous = row.value;
    }
    return { value: deltas.length ? deltas.reduce((sum, row) => sum + row.value, 0) : null,
      records: deltas, hasEstimates: deltas.some(r => r.isEstimate), counterGaps: gaps };
  }
  const records = rows.filter(row => row.date >= start && row.date <= to);
  const sum = records.reduce((total, row) => total + row.value, 0);
  const value = rule.aggregation === "sum" ? sum : !records.length ? null : rule.aggregation === "average" ? sum / records.length : records.at(-1)!.value;
  return { value, records, hasEstimates: rule.aggregation === "last" ? Boolean(records.at(-1)?.isEstimate) : records.some(r => r.isEstimate), counterGaps: 0 };
}

export function aggregatePerformance(data: Data, options: { asOf: string; range?: Range; grain: Grain; includeEstimates: boolean }, now: Date) {
  const rules = chronological(data.rules);
  const effective = ruleAt(rules, options.asOf);
  if (!effective) return null;
  const first = rules[0].effectiveDate;
  const evaluation = evaluationRange(effective.value, options.asOf, first);
  const range = options.range ?? evaluation;
  validateRange(range.start, range.end);
  const rows = materialize(data, rules, options.asOf, now).filter(row => options.includeEstimates || !row.isEstimate);
  function run(version: Version<MeasurementRule>, date: string, start: string, end: string) {
    const rule = version.value;
    const active = rules.filter(r => r.effectiveDate <= date);
    const lastIncompatible = active.findLastIndex(r => series(r.value) !== series(rule));
    const since = active[lastIncompatible + 1].effectiveDate;
    const sourceRows = rows.filter(row => row.date >= since && row.source === rule.source && row.input === rule.input && row.unit === rule.unit);
    return measured(sourceRows, rule, date, maxDate(start, since), end);
  }
  const current = run(effective, options.asOf, evaluation.start, evaluation.end);
  const selectedAsOf = minDate(options.asOf, range.end);
  const selectedRule = ruleAt(rules, selectedAsOf);
  const selected = selectedRule ? run(selectedRule, selectedAsOf, range.start, range.end) : { value: null, records: [], hasEstimates: false, counterGaps: 0 };
  const points = [];
  const last = minDate(range.end, options.asOf);
  for (let start = range.start; start <= last;) {
    let end = minDate(endForGrain(start, options.grain), last);
    const nextChange = rules.find(r => r.effectiveDate > start && r.effectiveDate <= end);
    if (nextChange) end = shiftDate(nextChange.effectiveDate, -1);
    const version = ruleAt(rules, end);
    if (version) {
      const rule = version.value;
      let period = evaluationRange(rule, end, first);
      if ((rule.period === "monthly" || rule.period === "weekly") && start < period.start) {
        end = shiftDate(period.start, -1);
        period = evaluationRange(rule, end, first);
      }
      const detail = run(version, end, start, end);
      const evaluated = run(version, end, period.start, period.end);
      const cumulative = rule.aggregation === "sum" ? run(version, end, first, end).value : null;
      points.push({ start, end, value: detail.value, periodValue: evaluated.value, cumulativeValue: cumulative,
        target: rule.target, baseline: rule.baseline, direction: rule.direction, unit: rule.unit,
        aggregation: rule.aggregation, periodStart: period.start, isEstimate: evaluated.hasEstimates,
        counterGaps: evaluated.counterGaps, ruleRevision: version.revision });
    }
    start = shiftDate(end, 1);
  }
  const detail = ({ records, ...summary }: ReturnType<typeof measured>) => {
    const projects = new Map<string, { projectId: string; title: string; value: number; estimatedValue: number; occurrences: number }>();
    for (const row of records) {
      if (!row.projectId) continue;
      const item = projects.get(row.projectId) ?? { projectId: row.projectId, title: row.title ?? row.projectId, value: 0, estimatedValue: 0, occurrences: 0 };
      item.value += row.value;
      if (row.isEstimate) item.estimatedValue += row.value;
      item.occurrences++;
      projects.set(item.projectId, item);
    }
    return { ...summary, projectBreakdown: [...projects.values()], count: records.length };
  };
  return { asOf: options.asOf, grain: options.grain, includeEstimates: options.includeEstimates,
    rule: effective, evaluation, range, current: { ...detail(current), progress: metricProgress(current.value, effective.value) },
    selected: { ...detail(selected), rule: selectedRule ?? null }, points, records: selected.records };
}
export type PerformanceResult = NonNullable<ReturnType<typeof aggregatePerformance>>;
