import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestAuthorization } from "./pace-data";
import { bulkUpsertMetricEntries, currentProjectKr, getMetricRollupStatus, listMetricEntries, performanceFailure,
  previewMetricRollup, readKrPerformance, readPerformanceChanges, recalculateMetric, reviseMetricEntry, writePerformance } from "./kr-performance";
import { listProjectOperations, writeProjectOperations } from "./project-operations";
import { readMetricCalendar } from "./project-metric-schedules";

const id = z.string().trim().min(1).max(128);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = { start: date.optional(), end: date.optional(), as_of: date.optional(),
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

export function registerKrPerformanceTools(server: McpServer, db: D1Database, auth: RequestAuthorization) {
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const options = (input: { start?: string; end?: string; as_of?: string; grain?: string; include_estimates?: boolean }) => ({
    start: input.start, end: input.end, asOf: input.as_of, grain: input.grain, includeEstimates: input.include_estimates,
  });
  const readState = (kr: string) => readKrPerformance(db, auth.ownerId, kr, { grain: "month" });
  const command = (input: z.infer<z.ZodObject<typeof versioned>>, kind: "rule" | "project" | "entry", value: unknown, subjectId?: string) => ({
    kind, value, ...(subjectId ? { subjectId } : {}), expectedRevision: input.expected_revision,
    requestId: input.request_id, effectiveDate: input.effective_date, reason: input.reason ?? "",
  });

  server.registerTool("get_kr_measurement_rule", {
    description: "Read the current workspace KR's measurement rule versions, current evaluation and optimistic revision.",
    inputSchema: { key_result_id: id }, annotations: read,
  }, input => operation(async () => {
    const state = await readState(input.key_result_id);
    return { keyResult: state.keyResult, revision: state.revision, asOf: state.asOf, timezone: state.timezone,
      rules: state.configuration.rules, current: state.performance?.current ?? null, evaluation: state.performance?.evaluation ?? null };
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
    inputSchema: { project_id: id }, annotations: read,
  }, input => operation(async () => {
    const project = await currentProjectKr(db, auth.ownerId, input.project_id);
    const state = await readState(project.keyResultId);
    return { project, revision: state.revision, asOf: state.asOf, evaluation: state.performance?.evaluation ?? null,
      rules: state.configuration.projects.filter(item => item.projectId === project.id),
      contribution: state.performance?.current.projectBreakdown.find(item => item.projectId === project.id) ?? null };
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
    return { keyResult: state.keyResult, revision: state.revision, performance: { ...summary,
      records: filtered.slice(offset, offset + limit), recordCount: filtered.length,
      nextRecordOffset: offset + limit < filtered.length ? offset + limit : null } };
  }));

  server.registerTool("list_kr_performance_changes", {
    description: "Read the versioned configuration and correction audit trail separately from the dated performance series.",
    inputSchema: { key_result_id: id, after_revision: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional() }, annotations: read,
  }, input => operation(() => readPerformanceChanges(db, auth.ownerId, input.key_result_id, input.after_revision, input.limit)));

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
  }, input => operation(() => listMetricEntries(db, auth.ownerId, input.key_result_id, {
    ...options(input), projectId: input.project_id, includeUndated: input.include_undated,
    offset: input.offset, limit: input.limit, status: input.status,
  })));

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
    return { keyResult, revision, summary };
  }));

  server.registerTool("get_metric_series", {
    description: "Page the same day/week/month chart used on the OKR page. Each point includes bucket, evaluation-period and cumulative values.",
    inputSchema: { key_result_id: id, ...range, ...page }, annotations: read,
  }, input => operation(async () => {
    const { performance, keyResult, revision } = await readKrPerformance(db, auth.ownerId, input.key_result_id, options(input));
    const points = performance?.points ?? [];
    const offset = input.offset ?? 0, limit = input.limit ?? 100;
    return { keyResult, revision, asOf: performance?.asOf ?? null, count: points.length, points: points.slice(offset, offset + limit),
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
