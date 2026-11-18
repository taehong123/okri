import type { KrObservation } from "@/lib/kr-metric-history";
const definition = (p: KrObservation) => JSON.stringify([p.source, p.unit, p.baselineValue, p.targetValue, Boolean(p.isEstimate)]);
const day = (iso: string) => { const d = new Date(iso); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
export function krTrendSegments(observations: KrObservation[], unit: string, daily = false) {
  const segments: KrObservation[][] = [];
  let previous: KrObservation | undefined;
  for (const p of observations) {
    if (p.currentValue === null || p.unit !== unit) { previous = undefined; continue; }
    if (!previous || definition(previous) !== definition(p) || p.eventKind === "settings") segments.push([]);
    const segment = segments.at(-1)!;
    if (daily && segment.length && day(segment.at(-1)!.observedAt) === day(p.observedAt)) segment[segment.length - 1] = p;
    else segment.push(p);
    previous = p;
  }
  return segments;
}
export function latestKrTrendSegment(observations: KrObservation[], unit: string, source?: string | null, target?: number | null) {
  const latest = observations.at(-1);
  if (!latest || latest.currentValue === null || latest.unit !== unit
    || source !== undefined && source !== latest.source
    || target != null && target !== latest.targetValue) return [];
  return krTrendSegments(observations, unit).at(-1) ?? [];
}
export type KrSignal = "reached" | "improving" | "steady" | "declining" | "insufficient" | "error";
export function krTrendSignal(points: KrObservation[], error = false): KrSignal {
  if (error) return "error";
  const first = points[0], last = points.at(-1);
  if (!last || last.currentValue === null) return "insufficient";
  const span = last.targetValue - last.baselineValue;
  if (!Number.isFinite(span) || span === 0) return "insufficient";
  const progress = (last.currentValue - last.baselineValue) / span;
  if (progress >= 1) return "reached";
  if (points.length < 2 || !first || first.currentValue === null) return "insufficient";
  const change = (last.currentValue - first.currentValue) / span;
  return Math.abs(change) < 1e-9 ? "steady" : change > 0 ? "improving" : "declining";
}
