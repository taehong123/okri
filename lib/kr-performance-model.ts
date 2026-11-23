import { calendarInput, dateOnly, localDate, scheduleCredits, scheduleInput, shiftDate,
  type ContributionScheduleInput, type MetricCalendar } from "./project-metric-schedule-model";

export type Grain = "day" | "week" | "month";
export type Range = { start: string; end: string };
export type MeasurementRule = {
  source: "projects" | "api" | "manual" | "throughput";
  input: "events" | "samples" | "counter" | "ratio";
  aggregation: "sum" | "last" | "average" | "ratio";
  period: "daily" | "weekly" | "monthly" | "quarterly" | "fixed" | "all_time";
  progressBasis?: "baseline" | "target";
  ratioScale?: number;
  numeratorPath?: string;
  denominatorPath?: string;
  snapshotKeyPath?: string;
  start: string | null;
  end: string | null;
  baseline: number;
  target: number;
  direction: "increase" | "decrease";
  unit: string;
  timezone: string;
};
export type Quantity = { value: number; unit: string; isEstimate: boolean };
export type Formula =
  | { kind: "fixed"; amount: number; isEstimate: boolean }
  | { kind: "product"; quantity: Quantity; perUnit: number; factorIsEstimate: boolean }
  | { kind: "difference"; quantity: Quantity; before: number; after: number; factorIsEstimate: boolean };
export type ProjectRule = Omit<ContributionScheduleInput, "mode"> & {
  mode: ContributionScheduleInput["mode"] | "monthly" | "actual";
  effectKey?: string;
  closePeriod?: boolean;
  formula?: Formula;
  evidenceUrl?: string | null;
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
  date: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  sourceKey?: string;
  effectKey?: string;
  evidenceUrl?: string | null;
  numerator?: number;
  denominator?: number;
  formula?: Formula;
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
export type Measurement = Omit<Entry, "voided" | "date"> & { date: string; id: string; recordedAt: string };
export type StoredMeasurement = Omit<Entry, "voided"> & { id: string; recordedAt: string; cancelled?: boolean };
export type ApiSample = { id: string; observedAt: string; value: number; unit: string;
  numerator?: number | null; denominator?: number | null; snapshotKey?: string | null };
export type Stop = { projectId: string; recordedAt: string };
export type Data = {
  rules: Version<MeasurementRule>[];
  projects: ProjectVersion[];
  entries: StoredMeasurement[];
  occurrences?: Measurement[];
  operations?: Map<string, (Version<ProjectOperations> & { id: string })[]>;
  samples: ApiSample[];
  stops: Stop[];
};

export type ProjectOperations = {
  status: "planned" | "operating" | "paused" | "ended" | "needs_confirmation";
  adoption: "unknown" | "unused" | "partial" | "in_use";
  startDate: string | null;
  endDate: string | null;
  pauses: ContributionScheduleInput["pauses"];
  lastOperationCheck: string | null;
  lastUseCheck: string | null;
  evidence: string;
  evidenceUrl: string | null;
  reviewAfterDays: number;
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
  const source = choice(v.source, ["projects", "api", "manual", "throughput"]);
  const input = choice(v.input, ["events", "samples", "counter", "ratio"]);
  const aggregation = choice(v.aggregation, ["sum", "last", "average", "ratio"]);
  const period = choice(v.period, ["daily", "weekly", "monthly", "quarterly", "fixed", "all_time"]);
  const progressBasis = choice(v.progressBasis ?? "baseline", ["baseline", "target"]);
  const compatibleAggregation = input === "ratio" ? aggregation === "ratio" :
    input === "samples" ? aggregation === "last" || aggregation === "average" : aggregation === "sum";
  if (((source === "projects" || source === "throughput") && input !== "events") ||
      (source === "api" && input === "events") || !compatibleAggregation) {
    throw new PerformanceError("incompatible_performance_aggregation");
  }
  timezone = calendarInput({ timezone: v.timezone ?? timezone, holidays: [] }).timezone;
  const direction = choice(v.direction, ["increase", "decrease"]);
  const baseline = amount(v.baseline), target = amount(v.target);
  if (direction === "increase" ? target <= baseline : target >= baseline) throw new PerformanceError("invalid_performance_target");
  const start = period === "fixed" ? dateOnly(v.start) : null, end = period === "fixed" ? dateOnly(v.end) : null;
  if (start && end) validateRange(start, end);
  if (progressBasis === "target" && (target <= 0 || baseline < 0)) throw new PerformanceError("invalid_performance_target");
  const ratioScale = input === "ratio" ? amount(v.ratioScale ?? (v.unit === "%" ? 100 : 1)) : undefined;
  if (ratioScale !== undefined && ratioScale <= 0) throw new PerformanceError("invalid_performance_value");
  return { source, input, aggregation, period, start, end, baseline, target, direction, unit: textValue(v.unit, 24, true), timezone,
    progressBasis, ...(ratioScale !== undefined ? { ratioScale } : {}),
    ...(input === "ratio" && source === "api" ? { numeratorPath: textValue(v.numeratorPath, 200),
      denominatorPath: textValue(v.denominatorPath, 200), snapshotKeyPath: textValue(v.snapshotKeyPath, 200) } : {}) };
}
export function evidenceUrl(value: unknown) {
  if (value == null || value === "") return null;
  const source = textValue(value, 2000);
  let url: URL;
  try { url = new URL(source); } catch { throw new PerformanceError("invalid_evidence_url"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new PerformanceError("invalid_evidence_url");
  return url.href;
}
export function formulaInput(raw: unknown): Formula {
  const v = record(raw);
  const kind = choice(v.kind, ["fixed", "product", "difference"]);
  if (kind === "fixed") return { kind, amount: amount(v.amount), isEstimate: bool(v.isEstimate, false) };
  const q = record(v.quantity);
  const quantity = { value: amount(q.value), unit: textValue(q.unit, 24), isEstimate: bool(q.isEstimate, false) };
  if (quantity.value < 0) throw new PerformanceError("invalid_performance_value");
  const factorIsEstimate = bool(v.factorIsEstimate, false);
  const formula = kind === "product"
    ? { kind, quantity, perUnit: amount(v.perUnit), factorIsEstimate } as const
    : { kind, quantity, before: amount(v.before), after: amount(v.after), factorIsEstimate } as const;
  formulaValue(formula);
  return formula;
}
export function formulaValue(formula: Formula) {
  if (formula.kind === "fixed") return { value: formula.amount, isEstimate: formula.isEstimate };
  const factor = formula.kind === "product" ? formula.perUnit : formula.before - formula.after;
  return { value: amount(formula.quantity.value * factor), isEstimate: formula.quantity.isEstimate || formula.factorIsEstimate };
}
export function operationsInput(raw: unknown, today: string): ProjectOperations {
  const v = record(raw);
  const startDate = v.startDate ? dateOnly(v.startDate) : null, endDate = v.endDate ? dateOnly(v.endDate) : null;
  if (startDate && endDate) validateRange(startDate, endDate);
  const { pauses } = scheduleInput({ mode: "daily", amount: 0, startDate: startDate ?? today, pauses: v.pauses });
  const lastOperationCheck = v.lastOperationCheck ? dateOnly(v.lastOperationCheck) : null;
  const lastUseCheck = v.lastUseCheck ? dateOnly(v.lastUseCheck) : null;
  if ((lastOperationCheck && lastOperationCheck > today) || (lastUseCheck && lastUseCheck > today)) throw new PerformanceError("future_performance_date");
  const reviewAfterDays = v.reviewAfterDays ?? 30;
  if (typeof reviewAfterDays !== "number" || !Number.isInteger(reviewAfterDays) || reviewAfterDays < 1 || reviewAfterDays > 366) {
    throw new PerformanceError("invalid_performance_input");
  }
  return { status: choice(v.status, ["planned", "operating", "paused", "ended", "needs_confirmation"]),
    adoption: choice(v.adoption, ["unknown", "unused", "partial", "in_use"]),
    startDate, endDate, pauses, lastOperationCheck, lastUseCheck, reviewAfterDays,
    evidence: textValue(v.evidence ?? "", 1000, true), evidenceUrl: evidenceUrl(v.evidenceUrl) };
}
export function activeOperations(value: ProjectOperations, date: string) {
  return (value.status === "operating" || value.status === "ended" && value.endDate !== null) &&
    (!value.startDate || date >= value.startDate) && (!value.endDate || date <= value.endDate) &&
    !value.pauses.some(pause => date >= pause.startDate && (!pause.endDate || date <= pause.endDate));
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
  const mode = choice(v.mode, ["once", "business_days", "daily", "weekly", "monthly", "actual"]);
  const formula = v.formula != null ? formulaInput(v.formula) : undefined;
  const result = formula ? formulaValue(formula) : { value: mode === "actual" ? 0 : amount(v.amount), isEstimate: bool(v.isEstimate, true) };
  if (v.unit != null && v.unit !== unit) throw new PerformanceError("performance_unit_mismatch");
  if (mode === "actual" && formula) throw new PerformanceError("actual_quantity_required");
  const schedule = scheduleInput({ ...v, mode: mode === "monthly" || mode === "actual" ? "daily" : mode, amount: Math.abs(result.value) });
  return { ...schedule, mode, amount: result.value, operating: bool(v.operating, true), isEstimate: result.isEstimate,
    basis: textValue(v.basis, 1000), calendar, title, unit, closePeriod: bool(v.closePeriod, true),
    ...(formula ? { formula } : {}), ...(v.effectKey ? { effectKey: textValue(v.effectKey, 128) } : {}),
    ...(v.evidenceUrl ? { evidenceUrl: evidenceUrl(v.evidenceUrl) } : {}) };
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
    case "daily": return { start: date, end: date };
    case "quarterly": {
      const month = Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3;
      return { start: date.slice(0, 4) + "-" + String(month + 1).padStart(2, "0") + "-01",
        end: monthEnd(date.slice(0, 4) + "-" + String(month + 3).padStart(2, "0") + "-01") };
    }
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
  if (value === null) return null;
  const progress = rule.progressBasis === "target"
    ? rule.direction === "increase" ? value / rule.target : value <= rule.target ? 1 : rule.target / value
    : (value - rule.baseline) / (rule.target - rule.baseline);
  return Math.max(0, Math.min(100, Math.round(100 * progress)));
}
function endForGrain(date: string, grain: Grain) {
  return grain === "day" ? date : grain === "week" ? shiftDate(weekStart(date), 6) : monthEnd(date);
}
function series(rule: MeasurementRule) {
  return [rule.source, rule.input, rule.unit, rule.timezone, rule.ratioScale].join("\u0000");
}

export function scheduledOccurrences(data: Data, asOf: string, now: Date) {
  const rows: Measurement[] = [];
  const byProject = new Map<string, ProjectVersion[]>();
  for (const p of chronological(data.projects)) {
    const versions = byProject.get(p.projectId) ?? [];
    versions.push(p);
    byProject.set(p.projectId, versions);
  }
  for (const [id, versions] of byProject) {
    const operations = data.operations?.get(id) ?? [];
    for (const [index, version] of versions.entries()) {
      const rule = version.value;
      const next = versions[index + 1]?.effectiveDate;
      let end = next ? minDate(asOf, shiftDate(next, -1)) : asOf;
      const stop = data.stops.find(s => s.projectId === id && s.recordedAt > version.recordedAt);
      if (stop) end = minDate(end, shiftDate(localDate(new Date(stop.recordedAt), rule.calendar.timezone), -1));
      const start = maxDate(version.effectiveDate, rule.startDate);
      if (start > end) continue;
      const inherited = rule.earnedDates?.filter(date => date >= start && date <= end) ?? [];
      let dates: string[] = [];
      if (rule.mode !== "actual" && !(rule.mode === "once" && rule.startDate < start)) {
        let scheduledStart = rule.earnedThrough ? maxDate(start, shiftDate(rule.earnedThrough, 1)) : start;
        const baseEnd = minDate(end, rule.endDate ?? end);
        if (rule.mode === "monthly") {
          scheduledStart = monthEnd(scheduledStart);
        } else if (rule.mode === "weekly") {
          const anchor = rule.closePeriod ? shiftDate(rule.startDate, 6) : rule.startDate;
          scheduledStart = maxDate(scheduledStart, anchor);
          scheduledStart = shiftDate(scheduledStart, (7 - dayGap(anchor, scheduledStart) % 7) % 7);
        }
        if (scheduledStart <= baseEnd && (rule.mode !== "once" || scheduledStart === rule.startDate)) {
          const datesForPeriod = scheduleCredits({
            ...rule, amount: Math.abs(rule.amount), mode: rule.mode === "monthly" ? "daily" : rule.mode,
            startDate: scheduledStart, endDate: baseEnd,
          }, rule.calendar, now).dates;
          dates = rule.mode === "monthly" ? datesForPeriod.filter(date => date === monthEnd(date)) : datesForPeriod;
        }
      }
      for (const date of new Set([...inherited, ...dates])) {
        const measured = ruleAt(data.rules, date)?.value;
        if (measured?.source !== "projects" || measured.unit !== rule.unit) continue;
        const operation = ruleAt(operations, date)?.value;
        if (operation ? !activeOperations(operation, date) : !rule.operating && !inherited.includes(date)) continue;
        const periodStart = rule.closePeriod && rule.mode === "weekly" ? shiftDate(date, -6)
          : rule.mode === "monthly" ? date.slice(0, 7) + "-01" : date;
        // A recurring occurrence belongs to the closing date. Avoid claiming a
        // whole cycle across an effective-date boundary or a still-open cycle.
        if (periodStart < start) continue;
        rows.push({ id: id + "/" + date, date, value: rule.amount, isEstimate: rule.isEstimate,
          basis: rule.basis, projectId: id, title: rule.title, unit: rule.unit, input: "events",
          source: "projects", recordedAt: version.recordedAt,
          effectKey: rule.effectKey ?? "project:" + id,
          ...(rule.formula ? { formula: rule.formula } : {}), ...(rule.evidenceUrl ? { evidenceUrl: rule.evidenceUrl } : {}),
          ...(periodStart !== date ? { periodStart, periodEnd: date } : {}) });
      }
    }
  }
  return rows;
}

function materialize(data: Data, rules: Version<MeasurementRule>[], asOf: string, now: Date) {
  const entries = data.entries.flatMap(row => row.date && row.date <= asOf && !row.cancelled ? [{ ...row, date: row.date }] : []);
  const overrides = new Set(entries.filter(row => row.projectId && !row.sourceKey).map(row => row.projectId + "/" + row.date));
  const scheduled = (data.occurrences ?? scheduledOccurrences(data, asOf, now))
    .filter(row => row.date <= asOf && !overrides.has(row.id));
  const rows: Measurement[] = [...scheduled, ...entries];
  const apiZones = [...new Set(rules.filter(r => r.value.source === "api").map(r => r.value.timezone))];
  const snapshots = new Map<string, Measurement>();
  const countedSnapshots = new Map<string, string>();
  for (const timezone of apiZones) {
    for (const sample of data.samples) {
      const date = localDate(new Date(sample.observedAt), timezone);
      const rule = ruleAt(rules, date)?.value;
      if (!rule || rule.source !== "api" || rule.timezone !== timezone || rule.unit !== sample.unit || date > asOf) continue;
      const reading: Measurement = { id: sample.id, date, value: sample.value, isEstimate: false, basis: "",
        projectId: null, title: null, unit: sample.unit, input: rule.input,
        source: "api", recordedAt: sample.observedAt };
      if (rule.input === "ratio") {
        if (sample.numerator == null || sample.denominator == null || !sample.snapshotKey) continue;
        const key = JSON.stringify([timezone, sample.unit, sample.snapshotKey]);
        const occurrence = countedSnapshots.get(key) ?? date;
        countedSnapshots.set(key, occurrence);
        snapshots.set(key, { ...reading, date: occurrence, numerator: sample.numerator, denominator: sample.denominator });
      } else if (rule.input === "samples") snapshots.set(date, reading);
      else rows.push(reading);
    }
  }
  const effects = new Map<string, Measurement>();
  const accepted: Measurement[] = [];
  for (const row of [...rows, ...snapshots.values()]) {
    if (!row.effectKey) {
      accepted.push(row);
      continue;
    }
    const key = JSON.stringify([row.effectKey, row.source, row.unit, row.date, row.periodEnd ?? row.date]);
    const existing = effects.get(key);
    const quality = (candidate: Measurement) => !candidate.isEstimate ? 3 :
      candidate.sourceKey && candidate.formula && candidate.formula.kind !== "fixed" && !candidate.formula.quantity.isEstimate ? 2
        : candidate.sourceKey ? 1 : 0;
    if (!existing || quality(row) > quality(existing) ||
        (quality(row) === quality(existing) && row.recordedAt > existing.recordedAt)) effects.set(key, row);
  }
  return [...accepted, ...effects.values()].sort((a, b) => a.date.localeCompare(b.date) || a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
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
  if (rule.aggregation === "ratio") {
    const numerator = records.reduce((total, row) => total + (row.numerator ?? 0), 0);
    const denominator = records.reduce((total, row) => total + (row.denominator ?? 0), 0);
    return { value: denominator ? (rule.ratioScale ?? 1) * numerator / denominator : null,
      records, hasEstimates: records.some(row => row.isEstimate), counterGaps: 0, numerator, denominator };
  }
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
      let period = evaluationRange(rule, start, first);
      if (["monthly", "quarterly", "weekly"].includes(rule.period) && end > period.end) {
        end = period.end;
      }
      period = evaluationRange(rule, end, first);
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
  const lifetime = run(effective, options.asOf, first, options.asOf);
  return { asOf: options.asOf, grain: options.grain, includeEstimates: options.includeEstimates,
    rule: effective, evaluation, range, current: { ...detail(current), progress: metricProgress(current.value, effective.value) },
    selected: { ...detail(selected), rule: selectedRule ?? null }, lifetime: detail(lifetime),
    points, records: selected.records };
}
export type PerformanceResult = NonNullable<ReturnType<typeof aggregatePerformance>>;
