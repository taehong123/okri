import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestAuthorization } from "./pace-data";
import { currentProjectKr, performanceFailure, readKrPerformance, readPerformanceChanges, writePerformance } from "./kr-performance";

const id = z.string().trim().min(1).max(128);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = { start: date.optional(), end: date.optional(), as_of: date.optional(),
  grain: z.enum(["day", "week", "month"]).optional(), include_estimates: z.boolean().optional() };
const versioned = { expected_revision: z.number().int().nonnegative(), request_id: id,
  effective_date: date, reason: z.string().max(1000).optional() };
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
    description: "Set KR units, baseline, target, increase/decrease direction, evaluation period and aggregation. Projects use dated events/sum. API uses snapshots (last/average) or cumulative counter changes (sum); the API connection unit must match. Manual supports dated inputs. Monthly/weekly periods reset by calendar; fixed uses start/end. " + descriptions,
    inputSchema: { key_result_id: id, ...versioned, rule: z.object({
      source: z.enum(["projects", "api", "manual"]), input: z.enum(["events", "samples", "counter"]),
      aggregation: z.enum(["sum", "last", "average"]), period: z.enum(["monthly", "weekly", "fixed", "all_time"]),
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
    description: "Set an effective-dated one-off or recurring Project contribution to its Project-sourced KR. Set amount, cadence, operating start/end, optional pauses and a calendar snapshot. Operating status is independent of completion. Record basis and isEstimate. Omitted calendar captures the current workspace calendar. " + descriptions,
    inputSchema: { project_id: id, ...versioned, rule: z.object({
      mode: z.enum(["once", "business_days", "daily", "weekly"]), amount: z.number(), startDate: date,
      endDate: date.nullable().optional(), pauses: z.array(z.object({ startDate: date, endDate: date.nullable() })).max(50).optional(),
      operating: z.boolean(), isEstimate: z.boolean(), basis: z.string().min(1).max(1000),
      calendar: z.object({ timezone: z.string(), holidays: z.array(date).max(2000),
        weekendDays: z.array(z.number().int().min(0).max(6)).max(7).optional() }).nullable().optional(),
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
}
