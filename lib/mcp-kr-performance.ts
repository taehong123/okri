import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestAuthorization } from "./pace-data";
import { bulkUpsertMetricEntries, currentProjectKr, getMetricRollupStatus, listMetricEntries, performanceFailure,
  previewMetricRollup, readKrPerformance, readPerformanceChanges, recalculateMetric, reviseMetricEntry, writePerformance } from "./kr-performance";
import { listProjectOperations, writeProjectOperations } from "./project-operations";
import { listCurrentKrMetrics } from "./kr-data-sources";
import { readMetricDisplaySettings, saveMetricDisplaySettings } from "./kr-metric-display";
import { formatMetricValue, METRIC_DISPLAY_MODES, metricDisplayIncrement, type MetricDisplaySettings } from "./kr-metric-display-format";
import type { PerformanceResult } from "./kr-performance-model";
import { readMetricCalendar } from "./project-metric-schedules";

const id = z.string().trim().min(1).max(128);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localeSchema = z.enum(["ko-KR", "en-US", "ja-JP", "zh-CN", "es-ES"]).optional();
const range = { locale: localeSchema, start: date.optional(), end: date.optional(), as_of: date.optional(),
  grain: z.enum(["day", "week", "month"]).optional(), include_estimates: z.boolean().optional() };
const versioned = { expected_revision: z.number().int().nonnegative(), request_id: id,
  effective_date: date, reason: z.string().max(1000).optional() };
const page = { offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() };
const formula = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), amount: z.number(), isEstimate: z.boolean().optional() }),
  z.object({ kind: z.literal("product"), quantity: z.object({ value: z.number(), unit: z.string(), isEstimate: z.boolean().optional() }),
    perUnit: z.number(), factorIsEstimate: z.boolean().optional() }),
  z.object({ kind: z.literal("difference"), quantity: z.object({ value: z.number(), unit: z.string(), isEstimate: z.boolean().optional() }),
    before: z.number(), after: z.number(), factorIsEstimate: z.boolean().optional() }),
]);
const entry = z.object({
  occurredOn: date.nullable(), projectId: id.nullable().optional(), periodStart: date.nullable().optional(),
  periodEnd: date.nullable().optional(), effectKey: id.optional(), unit: z.string().max(24).optional(),
  value: z.number().optional(), numerator: z.number().optional(), denominator: z.number().optional(),
  formula: formula.nullable().optional(), isEstimate: z.boolean().optional(), basis: z.string().min(1).max(1000),
  evidenceUrl: z.string().max(2000).nullable().optional(),
});
const reason = z.string().trim().min(1).max(1000);
const writeVersion = { expected_revision: z.number().int().positive(), request_id: id, reason };
const calendar = z.object({ timezone: z.string(), holidays: z.array(date).max(2000),
  weekendDays: z.array(z.number().int().min(0).max(6)).max(7).optional() });
const pauses = z.array(z.object({ startDate: date, endDate: date.nullable() })).max(50);
const descriptions = "Use the latest revision and a unique request_id per intended edit. Retry the same request_id with identical input. A past effective_date or correction needs a reason. Returns before/after, recording time and affected periods.";
const success = (value: object) => ({
  structuredContent: value as Record<string, unknown>, content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const operation = async (fn: () => Promise<object>) => {
  try { return success(await fn()); }
  catch (error) {
    const { code } = performanceFailure(error);
    return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ code }) }] };
  }
};

function displayPoint(point: PerformanceResult["points"][number], settings: MetricDisplaySettings, locale?: string) {
  return { start: point.start, end: point.end,
    value: formatMetricValue(point.value, point.unit, settings, locale),
    periodValue: formatMetricValue(point.periodValue, point.unit, settings, locale),
    cumulativeValue: formatMetricValue(point.cumulativeValue, point.unit, settings, locale),
    target: formatMetricValue(point.target, point.unit, settings, locale),
  };
}
function displayPerformance(performance: PerformanceResult, settings: MetricDisplaySettings, locale?: string) {
  const unit = performance.rule.value.unit, selectedUnit = performance.selected.rule?.value.unit ?? unit;
  const total = (value: PerformanceResult["current"] | PerformanceResult["selected"] | PerformanceResult["lifetime"], unit: string) => ({
    value: formatMetricValue(value.value, unit, settings, locale),
    projectBreakdown: value.projectBreakdown.map(project => ({
      projectId: project.projectId, value: formatMetricValue(project.value, unit, settings, locale),
      estimatedValue: formatMetricValue(project.estimatedValue, unit, settings, locale),
    })),
  });
  return { settings, effectiveIncrement: metricDisplayIncrement(unit, settings),
    target: formatMetricValue(performance.rule.value.target, unit, settings, locale),
    baseline: formatMetricValue(performance.rule.value.baseline, unit, settings, locale),
    current: total(performance.current, unit), selected: total(performance.selected, selectedUnit),
    lifetime: total(performance.lifetime, unit),
  };
}

export function registerKrPerformanceTools(server: McpServer, db: D1Database, auth: RequestAuthorization) {
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const options = (input: { start?: string; end?: string; as_of?: string; grain?: string; include_estimates?: boolean }) => ({
    start: input.start, end: input.end, asOf: input.as_of, grain: input.grain, includeEstimates: input.include_estimates,
  });
  const readState = (kr: string, asOf?: string) => readKrPerformance(db, auth.ownerId, kr, { grain: "month", asOf });
  const rulePage = <T extends { effectiveDate: string }>(versions: T[], input: {
    start?: string; end?: string; offset?: number; limit?: number;
  }) => {
    const filtered = versions.filter(row => (!input.start || row.effectiveDate >= input.start) && (!input.end || row.effectiveDate <= input.end));
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    return { rules: filtered.slice(offset, offset + limit), ruleCount: filtered.length,
      nextOffset: offset + limit < filtered.length ? offset + limit : null };
  };
  const ruleQuery = { locale: localeSchema, start: date.optional(), end: date.optional(), as_of: date.optional(), ...page };
  const command = (input: z.infer<z.ZodObject<typeof versioned>>, kind: "rule" | "project" | "entry", value: unknown, subjectId?: string) => ({
    kind, value, ...(subjectId ? { subjectId } : {}), expectedRevision: input.expected_revision,
    requestId: input.request_id, effectiveDate: input.effective_date, reason: input.reason ?? "",
  });

  async function krDisplay(id: string, locale?: string) {
    const [settings, metrics] = await Promise.all([
      readMetricDisplaySettings(db, auth.ownerId, id),
      listCurrentKrMetrics(db, auth.ownerId, [id]),
    ]);
    const metric = metrics[0];
    const unit = metric?.unit ?? "";
    const currentValue = metric?.currentValue ?? null, targetValue = metric?.targetValue ?? null;
    return { keyResultId: id, unit, settings, effectiveIncrement: metricDisplayIncrement(unit, settings), currentValue, targetValue,
      display: { currentValue: formatMetricValue(currentValue, unit, settings, locale),
        targetValue: formatMetricValue(targetValue, unit, settings, locale) } };
  }

  server.registerTool("get_kr_metric_display", {
    description: "Read a KR's presentation preference and effective increment. Numeric current/target values are exact; display contains the localized labels. Hour units default to 0.5.",
    inputSchema: { key_result_id: id, locale: localeSchema }, annotations: read,
  }, input => operation(() => krDisplay(input.key_result_id, input.locale)));

  server.registerTool("set_kr_metric_display", {
    description: "Set display-only rounding for one KR. Choose default, exact, or increment. For increment supply a number with up to six decimal places in the KR's existing unit. Read the current revision first.",
    inputSchema: { key_result_id: id, mode: z.enum(METRIC_DISPLAY_MODES), increment: z.number().positive().nullable().optional(),
      expected_revision: z.number().int().nonnegative(), locale: localeSchema }, annotations: { ...write, idempotentHint: true },
  }, input => operation(async () => {
    await saveMetricDisplaySettings(db, auth, input.key_result_id, {
      mode: input.mode, increment: input.increment, expectedRevision: input.expected_revision,
    });
    return krDisplay(input.key_result_id, input.locale);
  }));

  server.registerTool("get_kr_measurement_rule", {
    description: "Read the current workspace KR's measurement rule versions, current evaluation and optimistic revision.",
    inputSchema: { key_result_id: id, ...ruleQuery }, annotations: read,
  }, input => operation(async () => {
    const [state, settings] = await Promise.all([
      readState(input.key_result_id, input.as_of), readMetricDisplaySettings(db, auth.ownerId, input.key_result_id),
    ]);
    return { keyResult: state.keyResult, display: state.performance ? displayPerformance(state.performance, settings, input.locale) : { settings }, revision: state.revision, asOf: state.asOf, timezone: state.timezone,
      ...rulePage(state.configuration.rules, input), current: state.performance?.current ?? null, evaluation: state.performance?.evaluation ?? null };
  }));

  server.registerTool("set_kr_measurement_rule", {
    description: "Version KR source, unit, target direction, baseline, target, progress basis, timezone, evaluation period and aggregation. Projects and throughput use events/sum; throughput entries include volume and factor. API uses latest/average daily snapshots or counter deltas. Manual or API can pool numerator/denominator ratios; API ratios require fields for each part and a stable snapshot key. " + descriptions,
    inputSchema: { key_result_id: id, ...versioned, rule: z.object({
      source: z.enum(["projects", "api", "manual", "throughput"]), input: z.enum(["events", "samples", "counter", "ratio"]),
      aggregation: z.enum(["sum", "last", "average", "ratio"]), period: z.enum(["daily", "weekly", "monthly", "quarterly", "fixed", "all_time"]),
      timezone: z.string().max(100).optional(), progressBasis: z.enum(["baseline", "target"]).optional(), ratioScale: z.number().positive().optional(),
      numeratorPath: z.string().max(200).optional(), denominatorPath: z.string().max(200).optional(), snapshotKeyPath: z.string().max(200).optional(),
      start: date.nullable().optional(), end: date.nullable().optional(), baseline: z.number(), target: z.number(),
      direction: z.enum(["increase", "decrease"]), unit: z.string().max(24),
    }) }, annotations: write,
  }, input => operation(() => writePerformance(db, auth, input.key_result_id, command(input, "rule", input.rule))));

  server.registerTool("get_project_contribution_rule", {
    description: "Read a Project's versioned contribution rule, operating state, paused intervals, calendar, evidence and current KR evaluation contribution.",
    inputSchema: { project_id: id, ...ruleQuery }, annotations: read,
  }, input => operation(async () => {
    const project = await currentProjectKr(db, auth.ownerId, input.project_id);
    const [state, settings] = await Promise.all([
      readState(project.keyResultId, input.as_of), readMetricDisplaySettings(db, auth.ownerId, project.keyResultId),
    ]);
    const contribution = state.performance?.current.projectBreakdown.find(item => item.projectId === project.id) ?? null;
    const unit = state.performance?.rule.value.unit ?? "";
    return { project, display: { settings, value: formatMetricValue(contribution?.value ?? null, unit, settings, input.locale),
      estimatedValue: formatMetricValue(contribution?.estimatedValue ?? null, unit, settings, input.locale) }, revision: state.revision, asOf: state.asOf, evaluation: state.performance?.evaluation ?? null,
      ...rulePage(state.configuration.projects.filter(item => item.projectId === project.id), input),
      contribution };
  }));

  server.registerTool("set_project_contribution_rule", {
    description: "Set a Project's effective-dated contribution, with fixed or formula amounts, optional shared effect key, period, calendar, evidence and separate estimate components. Actual mode requires dated throughput entries. Operating is a fallback when separate Project operations are unset. " + descriptions,
    inputSchema: { project_id: id, ...versioned, rule: z.object({
      mode: z.enum(["once", "business_days", "daily", "weekly", "monthly", "actual"]), amount: z.number().optional(), startDate: date,
      endDate: date.nullable().optional(), pauses: pauses.optional(), operating: z.boolean().optional(), closePeriod: z.boolean().optional(),
      isEstimate: z.boolean().optional(), basis: z.string().min(1).max(1000), unit: z.string().max(24).optional(), effectKey: id.optional(),
      calendar: calendar.nullable().optional(), formula: formula.optional(), evidenceUrl: z.string().max(2000).nullable().optional(),
    }) }, annotations: write,
  }, input => operation(async () => {
    const project = await currentProjectKr(db, auth.ownerId, input.project_id);
    return writePerformance(db, auth, project.keyResultId, command(input, "project", input.rule, project.id));
  }));

  server.registerTool("record_kr_performance", {
    description: "Record a dated manual observation, or replace one Project's calculated contribution for a given date. Use a stable entry_id for manual input. Project adjustments are keyed by Project and date. To reverse a correction, set voided=true and provide a reason. " + descriptions,
    inputSchema: { key_result_id: id, entry_id: id.optional(), ...versioned,
      entry: z.object({ projectId: id.optional(), value: z.number().optional(), isEstimate: z.boolean().optional(),
        basis: z.string().min(1).max(1000), voided: z.boolean().optional() }) }, annotations: write,
  }, input => operation(() => writePerformance(db, auth, input.key_result_id, command(input, "entry", input.entry, input.entry_id))));

  server.registerTool("get_kr_performance", {
    description: "Read the same current evaluation, day/week/month chart buckets, cumulative trend and Project breakdown used by the web. as_of selects the evaluation date. start/end restrict the selected period; they must be supplied together. Set include_estimates=false to omit estimates. Optional project_id filters records, and record_offset/record_limit page detailed occurrences (default 100).",
    inputSchema: { key_result_id: id, ...range, project_id: id.optional(),
      record_offset: z.number().int().nonnegative().optional(), record_limit: z.number().int().min(1).max(500).optional() }, annotations: read,
  }, input => operation(async () => {
    const state = await readKrPerformance(db, auth.ownerId, input.key_result_id, {
      start: input.start, end: input.end, asOf: input.as_of, grain: input.grain, includeEstimates: input.include_estimates,
    });
    const { performance } = state;
    if (!performance) return { keyResult: state.keyResult, revision: state.revision, performance: null };
    const { records, ...summary } = performance;
    const filtered = input.project_id ? records.filter(row => row.projectId === input.project_id) : records;
    const offset = input.record_offset ?? 0, limit = input.record_limit ?? 100;
    const page = filtered.slice(offset, offset + limit);
    const settings = await readMetricDisplaySettings(db, auth.ownerId, input.key_result_id);
    return { keyResult: state.keyResult, revision: state.revision,
      display: { ...displayPerformance(performance, settings, input.locale),
        points: performance.points.map(point => displayPoint(point, settings, input.locale)),
        records: page.map(row => ({ id: row.id, value: formatMetricValue(row.value, row.unit, settings, input.locale) })) },
      performance: { ...summary, records: page, recordCount: filtered.length,
      nextRecordOffset: offset + limit < filtered.length ? offset + limit : null } };
  }));

  server.registerTool("list_kr_performance_changes", {
    description: "Read the versioned configuration and correction audit trail separately from the dated performance series.",
    inputSchema: { key_result_id: id, after_revision: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional(), start: date.optional(), end: date.optional(),
      kind: z.enum(["rule", "project", "entry"]).optional() }, annotations: read,
  }, input => operation(() => readPerformanceChanges(db, auth.ownerId, input.key_result_id, input.after_revision, input.limit,
    { from: input.start, to: input.end, kind: input.kind })));

  server.registerTool("list_project_operations", {
    description: "Read Project build state, operating/adoption state and recency of use evidence. Projects can have operations without a numeric contribution or KR.",
    inputSchema: { project_id: id.optional(), as_of: date.optional(), cursor: id.optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: read,
  }, input => operation(async () => listProjectOperations(db, auth.ownerId, (await readMetricCalendar(db, auth.ownerId)).timezone,
    { projectId: input.project_id, asOf: input.as_of, cursor: input.cursor, limit: input.limit })));

  server.registerTool("update_project_operations", {
    description: "Version a Project's operational status, adoption, date ranges and evidence independently of build completion and KR settings. " + descriptions,
    inputSchema: { project_id: id, ...versioned, operations: z.object({
      status: z.enum(["planned", "operating", "paused", "ended", "needs_confirmation"]),
      adoption: z.enum(["unknown", "unused", "partial", "in_use"]),
      startDate: date.nullable().optional(), endDate: date.nullable().optional(), pauses: pauses.optional(),
      lastOperationCheck: date.nullable().optional(), lastUseCheck: date.nullable().optional(),
      evidence: z.string().max(1000).optional(), evidenceUrl: z.string().max(2000).nullable().optional(),
      reviewAfterDays: z.number().int().min(1).max(366).optional(),
    }) }, annotations: write,
  }, input => operation(async () => writeProjectOperations(db, auth, input.project_id, command(input, "project", input.operations),
    (await readMetricCalendar(db, auth.ownerId)).timezone)));

  server.registerTool("list_metric_entries", {
    description: "Page the workspace KR ledger by date/Project, including unallocated dates and entries excluded, cancelled or applied to the selected measurement.",
    inputSchema: { key_result_id: id, ...range, ...page, project_id: id.optional(), include_undated: z.boolean().optional(),
      status: z.enum(["applied", "excluded", "undated", "cancelled"]).optional() },
    annotations: read,
  }, input => operation(async () => {
    const [result, settings] = await Promise.all([
      listMetricEntries(db, auth.ownerId, input.key_result_id, {
        ...options(input), projectId: input.project_id, includeUndated: input.include_undated,
        offset: input.offset, limit: input.limit, status: input.status,
      }),
      readMetricDisplaySettings(db, auth.ownerId, input.key_result_id),
    ]);
    return { ...result, displaySettings: settings,
      entries: result.entries.map(row => ({ ...row, displayValue: formatMetricValue(row.value, row.unit, settings, input.locale) })) };
  }));

  server.registerTool("bulk_upsert_metric_entries", {
    description: "Import up to 100 records with stable sourceKey and occurredOn (null if genuinely unknown). Use an effectKey to replace same-work estimates without double counting. Only action=correct edits a matching source record. Each result is inserted, duplicate, corrected or failed. Keep entry ordering and request_id unchanged on retry. " + descriptions,
    inputSchema: { key_result_id: id, ...writeVersion, entries: z.array(entry.extend({
      sourceKey: z.string().trim().min(1).max(180), action: z.enum(["insert", "correct"]).optional(),
    })).min(1).max(100) },
    annotations: write,
  }, input => operation(() => bulkUpsertMetricEntries(db, auth, input.key_result_id, {
    requestId: input.request_id, expectedRevision: input.expected_revision, reason: input.reason, entries: input.entries,
  })));

  server.registerTool("correct_metric_entry", {
    description: "Correct an existing source-keyed record with a reason. Preserve its source ID and append audit history. " + descriptions,
    inputSchema: { key_result_id: id, source_key: z.string().trim().min(1).max(180), ...writeVersion, entry: entry.partial() },
    annotations: write,
  }, input => operation(() => reviseMetricEntry(db, auth, input.key_result_id, {
    operation: "correct", sourceKey: input.source_key, requestId: input.request_id,
    expectedRevision: input.expected_revision, reason: input.reason, entry: input.entry,
  })));

  server.registerTool("cancel_metric_entry", {
    description: "Exclude a source-keyed entry from measurements and keep its original value and cancellation reason in the ledger.",
    inputSchema: { key_result_id: id, source_key: z.string().trim().min(1).max(180), ...writeVersion },
    annotations: { ...write, destructiveHint: true, idempotentHint: true },
  }, input => operation(() => reviseMetricEntry(db, auth, input.key_result_id, {
    operation: "cancel", sourceKey: input.source_key, requestId: input.request_id,
    expectedRevision: input.expected_revision, reason: input.reason,
  })));

  server.registerTool("get_metric_summary", {
    description: "Use the web calculation for current, selected and lifetime values, with units, estimate status and Project contribution breakdown.",
    inputSchema: { key_result_id: id, ...range }, annotations: read,
  }, input => operation(async () => {
    const { performance, keyResult, revision } = await readKrPerformance(db, auth.ownerId, input.key_result_id, options(input));
    if (!performance) return { keyResult, revision, summary: null };
    const { records, points, ...summary } = performance;
    const settings = await readMetricDisplaySettings(db, auth.ownerId, input.key_result_id);
    return { keyResult, revision, summary, display: displayPerformance(performance, settings, input.locale) };
  }));

  server.registerTool("get_metric_series", {
    description: "Page the same day/week/month chart used on the OKR page. Each point includes bucket, evaluation-period and cumulative values.",
    inputSchema: { key_result_id: id, ...range, ...page }, annotations: read,
  }, input => operation(async () => {
    const { performance, keyResult, revision } = await readKrPerformance(db, auth.ownerId, input.key_result_id, options(input));
    const points = performance?.points ?? [];
    const offset = input.offset ?? 0, limit = input.limit ?? 100;
    const settings = await readMetricDisplaySettings(db, auth.ownerId, input.key_result_id);
    const selected = points.slice(offset, offset + limit);
    return { keyResult, revision, asOf: performance?.asOf ?? null, count: points.length, points: selected,
      display: { settings, points: selected.map(point => displayPoint(point, settings, input.locale)) },
      nextOffset: offset + limit < points.length ? offset + limit : null };
  }));

  server.registerTool("preview_metric_recalculation", {
    description: "Compare the posted ledger with a projected reconciliation. Returns proposed dates and before/after values without writing.",
    inputSchema: { key_result_id: id, ...range }, annotations: read,
  }, input => operation(() => previewMetricRollup(db, auth.ownerId, input.key_result_id, options(input))));

  server.registerTool("recalculate_metric", {
    description: "Reconcile the Project occurrence ledger through closed dates using the same calculation as the scheduled job. Repeating it does not post the same occurrence twice.",
    inputSchema: { key_result_id: id, expected_revision: z.number().int().positive(), reason }, annotations: { ...write, idempotentHint: true },
  }, input => operation(() => recalculateMetric(db, auth, input.key_result_id, input.expected_revision, input.reason)));

  server.registerTool("get_metric_rollup_status", {
    description: "Inspect last success, last automatic run, closed-through and missing dates, next scheduled tick, errors and recovery history.",
    inputSchema: { key_result_id: id, cursor: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional() }, annotations: read,
  }, input => operation(() => getMetricRollupStatus(db, auth.ownerId, input.key_result_id, input.cursor, input.limit)));

}
