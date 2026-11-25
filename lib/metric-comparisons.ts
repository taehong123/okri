import { dateOnly, localDate, shiftDate } from "./project-metric-schedule-model";
import { PerformanceError, validateRange } from "./kr-performance-model";
import { readKrPerformance } from "./kr-performance";
import { readMetricCalendar } from "./project-metric-schedules";
import { readMetricDisplaySettings } from "./kr-metric-display";
import { formatMetricValue } from "./kr-metric-display-format";

type Period = { start: string; end: string };
const monthStart = (day: string) => day.slice(0, 7) + "-01";
function monthShift(day: string, delta: number) {
  const [year, month, date] = day.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + delta, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date, last));
  return first.toISOString().slice(0, 10);
}
const beginWeek = (day: string) => shiftDate(day, -(new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7);
function period(start: string, end: string): Period {
  dateOnly(start); dateOnly(end); validateRange(start, end);
  return { start, end };
}
export function comparisonPeriods(asOf: string) {
  const day = period(asOf, asOf), week = period(beginWeek(asOf), asOf), month = period(monthStart(asOf), asOf);
  const pastMonth = monthShift(month.start, -1);
  const previousMonthEnd = shiftDate(month.start, -1);
  const monthEnd = shiftDate(monthShift(month.start, 1), -1);
  const previousEnd = asOf === monthEnd ? previousMonthEnd : monthShift(asOf, -1);
  return [
    { kind: "dod", current: day, previous: period(shiftDate(asOf, -1), shiftDate(asOf, -1)) },
    { kind: "wow", current: week, previous: period(shiftDate(week.start, -7), shiftDate(asOf, -7)) },
    { kind: "mom", current: month, previous: period(pastMonth, previousEnd) },
    { kind: "yoy", current: month, previous: period(monthShift(month.start, -12),
      asOf === monthEnd ? shiftDate(monthShift(month.start, -11), -1) : monthShift(asOf, -12)) },
  ];
}
async function snapshotComparisons(db: D1Database, owner: string, id: string,
  query: { asOf?: string; includeEstimates?: boolean; current?: Period; previous?: Period; locale?: string }, now: Date) {
  const connection = await db.prepare(`SELECT k.kind,CASE WHEN m.active=1 THEN m.unit ELSE a.unit END AS unit,
    CASE WHEN m.active=1 THEN m.starting_value ELSE a.baseline_value END AS baseline,
    CASE WHEN m.active=1 THEN m.target_value ELSE a.target_value END AS target,
    CASE WHEN m.active=1 THEN 'projects' ELSE 'api' END AS source
    FROM items k LEFT JOIN kr_data_connections a ON a.owner_id=k.owner_id AND a.kr_item_id=k.id
    LEFT JOIN kr_project_metrics m ON m.owner_id=k.owner_id AND m.kr_item_id=k.id
    WHERE k.owner_id=? AND k.id=? AND k.kind IN ('project','key_result') AND k.archived_at IS NULL
      AND (m.active=1 OR a.id IS NOT NULL)`).bind(owner, id)
    .first<{ unit: string; baseline: number; target: number; kind: string; source: string }>();
  const { timezone } = await readMetricCalendar(db, owner);
  const today = localDate(now, timezone);
  const asOf = query.asOf ? dateOnly(query.asOf) : today;
  if (asOf > today) throw new PerformanceError("future_performance_date");
  if (!connection) {
    const item = await db.prepare("SELECT 1 FROM items WHERE owner_id=? AND id=? AND archived_at IS NULL AND kind IN ('project','key_result')")
      .bind(owner, id).first();
    if (!item) throw new PerformanceError("item_not_found", 404);
    return { asOf, comparisons: [] };
  }
  const rows = (await db.prepare(`SELECT current_value AS value,unit,observed_at AS observedAt FROM kr_metric_observations
    WHERE owner_id=? AND kr_item_id=? AND source=? AND current_value IS NOT NULL
    ORDER BY observed_at,id LIMIT 50000`).bind(owner, id, connection.source).all<{ value:number; unit:string; observedAt:string }>()).results;
  const ranges = query.current && query.previous
    ? [{kind:"custom", current:period(query.current.start,query.current.end), previous:period(query.previous.start,query.previous.end)}]
    : comparisonPeriods(asOf);
  if (ranges.some(pair => pair.current.end > asOf || pair.previous.end > asOf)) throw new PerformanceError("future_performance_date");
  const settings = connection.kind === "key_result" ? await readMetricDisplaySettings(db, owner, id) : undefined;
  const direction = connection.target >= connection.baseline ? "increase" : "decrease";
  const read = (range:Period) => rows.filter(row => {
    const day = localDate(new Date(row.observedAt), timezone);
    return day >= range.start && day <= range.end && row.unit === connection.unit;
  }).at(-1)?.value ?? null;
  const comparisons = ranges.flatMap(pair => {
    const currentValue = read(pair.current), previousValue = read(pair.previous);
    if (currentValue === null || previousValue === null) return [];
    const change = currentValue - previousValue, percent = previousValue === 0 ? null : 100 * change / Math.abs(previousValue);
    return [{...pair,currentValue,previousValue,change,percent,unit:connection.unit,aggregation:"last",direction,
      favorable: change === 0 ? null : direction === "increase" ? change > 0 : change < 0,
      display:{currentValue:formatMetricValue(currentValue,connection.unit,settings,query.locale),
        previousValue:formatMetricValue(previousValue,connection.unit,settings,query.locale),
        change:(change > 0 ? "+" : change < 0 ? "−" : "") + formatMetricValue(Math.abs(change),connection.unit,settings,query.locale),
        percent:percent === null ? null : (percent > 0 ? "+" : percent < 0 ? "−" : "") +
          new Intl.NumberFormat(query.locale ?? "ko-KR",{maximumFractionDigits:1}).format(Math.abs(percent))+"%"} }];
  });
  return {asOf,comparisons};
}

export async function readMetricComparisons(db: D1Database, owner: string, id: string,
  query: { asOf?: string; projectId?: string; includeEstimates?: boolean; current?: Period; previous?: Period; locale?: string } = {}, now = new Date()) {
  if (query.projectId) {
    if (!id) return snapshotComparisons(db, owner, query.projectId, query, now);
    const linked = await db.prepare(`SELECT 1 FROM items p JOIN items i ON i.owner_id=p.owner_id AND i.id=p.parent_id
      WHERE p.owner_id=? AND p.id=? AND p.kind='project' AND p.archived_at IS NULL AND i.kind='initiative' AND i.parent_id=?`)
      .bind(owner, query.projectId, id).first();
    if (!linked) throw new PerformanceError("project_not_linked_to_kr", 404);
  }
  const initial = await readKrPerformance(db, owner, id, { asOf: query.asOf, grain: "day", includeEstimates: query.includeEstimates }, now);
  if (!initial.performance) return snapshotComparisons(db, owner, query.projectId ?? id, query, now);
  const rule = initial.performance.rule.value;
  const asOf = query.asOf ?? localDate(now, rule.timezone);
  const ranges = query.current && query.previous
    ? [{ kind: "custom", current: period(query.current.start, query.current.end), previous: period(query.previous.start, query.previous.end) }]
    : comparisonPeriods(asOf);
  if (ranges.some(pair => pair.current.end > asOf || pair.previous.end > asOf)) throw new PerformanceError("future_performance_date");
  const settings = await readMetricDisplaySettings(db, owner, id);
  const read = async (range: Period) => {
    const state = await readKrPerformance(db, owner, id, { asOf, start: range.start, end: range.end, grain: "month",
      includeEstimates: query.includeEstimates }, now);
    const result = state.performance;
    if (!result) return null;
    const selected = result.selected;
    const compatible = selected.rule?.value;
    if (!compatible || compatible.unit !== rule.unit || compatible.input !== rule.input ||
      compatible.source !== rule.source || compatible.aggregation !== rule.aggregation || compatible.ratioScale !== rule.ratioScale) return null;
    if (query.projectId) {
      const project = selected.projectBreakdown.find(row => row.projectId === query.projectId);
      return project ? project.value : null;
    }
    return selected.count ? selected.value : null;
  };
  const comparisons = (await Promise.all(ranges.map(async pair => {
    const [currentValue, previousValue] = await Promise.all([read(pair.current), read(pair.previous)]);
    if (currentValue === null || previousValue === null) return null;
    const change = currentValue - previousValue;
    const percent = previousValue === 0 ? null : 100 * change / Math.abs(previousValue);
    return { ...pair, currentValue, previousValue, change, percent, unit: rule.unit, aggregation: rule.aggregation,
      direction: rule.direction, favorable: change === 0 ? null : rule.direction === "increase" ? change > 0 : change < 0,
      display: { currentValue: formatMetricValue(currentValue, rule.unit, settings, query.locale),
        previousValue: formatMetricValue(previousValue, rule.unit, settings, query.locale),
        change: (change > 0 ? "+" : change < 0 ? "−" : "") + formatMetricValue(Math.abs(change), rule.unit, settings, query.locale),
        percent: percent === null ? null : (percent > 0 ? "+" : percent < 0 ? "−" : "") +
          new Intl.NumberFormat(query.locale ?? "ko-KR", { maximumFractionDigits: 1 }).format(Math.abs(percent)) + "%" } };
  }))).filter(item => item !== null);
  return { asOf, comparisons };
}
