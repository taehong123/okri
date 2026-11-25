import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compile, fixture, read } from "./helpers/daily-report-fixture.mjs";

const schedule = compile(await read("lib/project-metric-schedule-model.ts"));
const legacy = compile(await read("lib/project-metric-schedules.ts"), { "./project-metric-schedule-model": schedule });
const model = compile(await read("lib/kr-performance-model.ts"), { "./project-metric-schedule-model": schedule });
const ops = compile(await read("lib/project-operations.ts"), { "./kr-performance-model": model, "./project-metric-schedule-model": schedule });
const service = compile(await read("lib/kr-performance.ts"), {
  "./project-metric-schedule-model": schedule, "./project-metric-schedules": legacy, "./kr-performance-model": model, "./project-operations": ops,
});
const formatter = compile(await read("lib/kr-metric-display-format.ts"));
const display = compile(await read("lib/kr-metric-display.ts"), { "./kr-performance-model": model, "./kr-metric-display-format": formatter });
const sources = compile(await read("lib/kr-data-sources.ts"), { "./kr-performance": service, "./kr-metric-display": display,
  "./project-contributions": {}, "./kr-data-sync": {} });
const comparison = compile(await read("lib/metric-comparisons.ts"), { "./project-metric-schedule-model": schedule,
  "./kr-performance-model": model, "./kr-performance": service, "./kr-metric-display": display, "./kr-metric-display-format": formatter,
  "./project-metric-schedules": legacy });
const mcp = compile(await read("lib/mcp-kr-performance.ts"), { "./kr-performance": service, "./project-operations": ops,
  "./project-metric-schedules": legacy, "./kr-metric-display": display, "./kr-metric-display-format": formatter, "./kr-data-sources": sources, "./metric-comparisons": comparison });
const oldTools = compile(await read("lib/mcp-contribution-schedules.ts"), { "./project-metric-schedules": legacy, "./kr-data-sources": {} });
const route = await read("app/api/kr-performance/route.ts");
const migration = await read("drizzle/0084_kr_performance.sql");
const ledgerMigration = await read("drizzle/0085_metric_ledger.sql");
const displayMigration = await read("drizzle/0086_metric_display.sql");
const actor = { ownerId: "w", userId: "u", role: "owner" };
const at = day => new Date(day + "T12:00:00.000Z");
const krRule = { source: "projects", input: "events", aggregation: "sum", period: "monthly",
  baseline: 0, target: 100, direction: "increase", unit: "시간" };
const projectRule = { mode: "daily", amount: 2, startDate: "2026-11-28", endDate: null, pauses: [],
  operating: true, isEstimate: true, basis: "Observed daily volume × time estimate" };
const change = (kind, value, effectiveDate, expectedRevision, extra = {}) => ({
  kind, value, effectiveDate, expectedRevision, requestId: "request-" + (expectedRevision + 1), reason: "", ...extra,
});
function dataFixture(t) {
  const f = fixture(t);
  f.sql.exec(migration);
  f.sql.exec(ledgerMigration);
  f.sql.exec(displayMigration);
  return { ...f, write: (input, day) => service.writePerformance(f.db, actor, "kr", input, at(day)),
    state: async (day, opts = {}) => {
      await service.runDueMetricRollups(f.db, at(day));
      return service.readKrPerformance(f.db, "w", "kr", opts, at(day));
    },
  };
}

test("closed days accumulate through Project completion, monthly reset preserves the prior month", async t => {
  const f = dataFixture(t);
  await f.write(change("rule", krRule, "2026-11-28", 0), "2026-11-28");
  await f.write(change("project", projectRule, "2026-11-28", 1, { subjectId: "p" }), "2026-11-28");
  f.sql.exec("UPDATE items SET status='done' WHERE id='p'");
  const read = await f.state("2026-12-04", { start: "2026-11-01", end: "2026-12-04", grain: "week" });
  const { current, selected, points, records } = read.performance;
  assert.equal(current.value, 6);
  assert.equal(current.projectBreakdown[0].value, 6);
  assert.equal(selected.value, 12);
  assert.equal(selected.projectBreakdown[0].value, 12);
  assert.equal(new Set(records.map(row => row.id)).size, 6);
  assert.deepEqual(points.map(p => [p.end, p.periodValue, p.cumulativeValue]), [
    ["2026-11-29", 4, 4], ["2026-11-30", 6, 6], ["2026-12-04", 6, 12],
  ]);
  const november = (await f.state("2026-12-04", { start: "2026-11-01", end: "2026-11-30", grain: "month" })).performance;
  assert.equal(november.selected.value, 6);
  assert.equal(november.points.at(-1).periodValue, 6);
  assert.equal((await f.state("2026-12-04", { includeEstimates: false })).performance.current.value, 0);
});

test("operating pause and resume, pinned calendars and prospective changes preserve earned contributions", async t => {
  const f = dataFixture(t);
  await f.write(change("rule", krRule, "2026-11-23", 0), "2026-11-23");
  const schedule = { ...projectRule, startDate: "2026-11-23", mode: "business_days",
    calendar: { timezone: "Asia/Seoul", weekendDays: [5, 6], holidays: ["2026-11-24"] } };
  await f.write(change("project", schedule, "2026-11-23", 1, { subjectId: "p" }), "2026-11-23");
  await f.write(change("project", { ...schedule, operating: false }, "2026-11-26", 2, { subjectId: "p" }), "2026-11-26");
  await f.write(change("project", { ...schedule, amount: 3, pauses: [{ startDate: "2026-11-30", endDate: "2026-11-30" }] },
    "2026-11-29", 3, { subjectId: "p" }), "2026-11-29");
  const receipt = await f.write(change("rule", { ...krRule, target: 80 }, "2026-12-01", 4), "2026-12-01");
  assert.equal(receipt.before.target, 100);
  assert.equal(receipt.after.target, 80);
  assert.deepEqual(receipt.affected.periods, [{ start: "2026-12-01", end: "2026-12-31" }]);
  const read = (await f.state("2026-12-03", { start: "2026-11-23", end: "2026-12-03", grain: "month" })).performance;
  assert.deepEqual(read.records.map(r => [r.date, r.value]), [
    ["2026-11-23", 2], ["2026-11-25", 2], ["2026-11-29", 3], ["2026-12-01", 3], ["2026-12-02", 3],
  ]);
  assert.deepEqual(read.points.map(p => [p.target, p.periodValue]), [[100, 7], [80, 6]]);
  assert.equal(read.current.value, 6);
});

test("past corrections, audit, concurrent writes and exact retries stay consistent", async t => {
  const f = dataFixture(t);
  await f.write(change("rule", krRule, "2026-11-28", 0), "2026-11-28");
  await f.write(change("project", projectRule, "2026-11-28", 1, { subjectId: "p" }), "2026-11-28");
  const value = { projectId: "p", value: 5, basis: "Five confirmed hours", isEstimate: false };
  const entry = change("entry", value, "2026-11-29", 2);
  await assert.rejects(f.write(entry, "2026-12-03"), { code: "performance_correction_reason_required" });
  const corrected = { ...entry, reason: "November time sheet reconciled" };
  const [first, retry] = await Promise.all([f.write(corrected, "2026-12-03"), f.write(corrected, "2026-12-03")]);
  assert.deepEqual(first, retry);
  assert.deepEqual(first.affected.periods, [{ start: "2026-11-01", end: "2026-11-30" }]);
  assert.equal(first.before.value, 2);
  assert.equal(first.before.isEstimate, true);
  assert.equal(first.after.value, 5);
  assert.equal(first.recordedAt, "2026-12-03T12:00:00.000Z");
  await assert.rejects(f.write({ ...corrected, value: { ...value, value: 6 } }, "2026-12-04"), { code: "performance_request_id_reused" });
  await assert.rejects(f.write({ ...corrected, requestId: "stale" }, "2026-12-04"), { code: "performance_revision_conflict" });
  const range = { start: "2026-11-01", end: "2026-11-30" };
  assert.equal((await f.state("2026-12-03", range)).performance.selected.value, 9);
  assert.equal((await f.state("2026-12-03", { ...range, includeEstimates: false })).performance.selected.value, 5);
  await f.write(change("entry", { ...value, voided: true }, "2026-11-29", 3, { reason: "Duplicate source sheet" }), "2026-12-04");
  assert.equal((await f.state("2026-12-04", range)).performance.selected.value, 6);
  const changes = await service.readPerformanceChanges(f.db, "w", "kr", 2, 1);
  assert.equal(changes.nextRevision, 3);
  assert.equal(changes.changes[0].reason, corrected.reason);
  assert.equal(changes.changes[0].after.date, "2026-11-29");
  await assert.rejects(service.readKrPerformance(f.db, "other", "kr"), { code: "key_result_not_found" });
  for (const role of [{ role: "viewer" }, { oauthScopes: "okri:read" }]) {
    await assert.rejects(service.writePerformance(f.db, { ...actor, ...role }, "kr", corrected, at("2026-12-04")), { code: "write_access_required" });
  }
});

test("counter readings use deltas and segment resets, average applies by occurrence date with decreasing targets", async t => {
  const f = dataFixture(t);
  const rule = { ...krRule, source: "manual", input: "counter" };
  await f.write(change("rule", rule, "2026-10-31", 0), "2026-10-31");
  const values = [["2026-10-31", 100], ["2026-11-01", 110], ["2026-11-03", 110], ["2026-11-04", 2],
    ["2026-11-05", 6], ["2026-12-01", 11]];
  for (const [index, [date, value]] of values.entries()) {
    await f.write(change("entry", { value, basis: "Counter reading" }, date, index + 1, { subjectId: "c" + index }), date);
  }
  const november = (await f.state("2026-12-02", { start: "2026-11-01", end: "2026-11-30" })).performance;
  assert.equal(november.selected.value, 14);
  assert.equal(november.selected.counterGaps, 1);
  assert.equal(november.current.value, 5);
  assert.equal(november.points.at(-1).cumulativeValue, 14);
  const average = { ...rule, input: "samples", aggregation: "average", baseline: 10, target: 4, direction: "decrease" };
  await f.write(change("rule", average, "2026-12-02", 7), "2026-12-02");
  await f.write(change("entry", { value: 8, basis: "Observed" }, "2026-12-02", 8, { subjectId: "a" }), "2026-12-02");
  await f.write(change("entry", { value: 6, basis: "Observed" }, "2026-12-03", 9, { subjectId: "b" }), "2026-12-03");
  const later = (await f.state("2026-12-03", { start: "2026-11-01", end: "2026-11-30" })).performance;
  assert.equal(later.current.value, 7);
  assert.equal(later.current.progress, 50);
  assert.equal(later.selected.value, 14);
});

test("legacy credit dates are adopted only once and one-off rules never repeat", async t => {
  const f = dataFixture(t);
  f.seed("kr_project_metrics", { id: "legacy", owner_id: "w", kr_item_id: "kr", starting_value: 0, target_value: 100, unit: "시간" });
  f.seed("project_metric_schedules", { id: "schedule", owner_id: "w", kr_item_id: "kr", project_id: "p",
    mode: "once", amount: 2, start_date: "2026-11-28", credit_dates_json: '["2026-11-28"]', accrued_value: 2, through_date: "2026-11-30",
    created_at: "2026-11-28T00:00:00Z", updated_at: "2026-11-30T00:00:00Z" });
  await f.write(change("rule", krRule, "2026-11-28", 0, { reason: "Use existing dated observations" }), "2026-12-01");
  await f.write(change("rule", { ...krRule, target: 90 }, "2026-12-01", 1), "2026-12-01");
  const read = (await f.state("2026-12-03", { start: "2026-11-01", end: "2026-12-03" })).performance;
  assert.equal(read.current.value, 0);
  assert.deepEqual(read.records.map(row => [row.date, row.value]), [["2026-11-28", 2]]);
});

test("archiving stops accrual on that date and reopening needs a new version with the original weekly anchor", async t => {
  const f = dataFixture(t);
  await f.write(change("rule", krRule, "2026-11-01", 0), "2026-11-01");
  const weekly = { ...projectRule, mode: "weekly", closePeriod: false, startDate: "2026-11-01" };
  await f.write(change("project", weekly, "2026-11-01", 1, { subjectId: "p" }), "2026-11-01");
  f.sql.exec("UPDATE items SET archived_at='2026-11-12T06:00:00Z' WHERE id='p'");
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM kr_performance_stops").get().n, 1);
  // SQLite uses real time for lifecycle events. Place the stop on the test calendar.
  f.sql.exec("UPDATE kr_performance_stops SET recorded_at='2026-11-12T06:00:00Z'; UPDATE items SET archived_at=NULL WHERE id='p'");
  assert.deepEqual((await f.state("2026-11-21")).performance.records.map(r => r.date), ["2026-11-01", "2026-11-08"]);
  await f.write(change("project", weekly, "2026-11-21", 2, { subjectId: "p" }), "2026-11-21");
  assert.deepEqual((await f.state("2026-11-30")).performance.records.map(r => r.date),
    ["2026-11-01", "2026-11-08", "2026-11-22", "2026-11-29"]);
});

test("saved API polling observations feed the same latest and average model", async t => {
  const f = dataFixture(t);
  f.seed("kr_data_connections", { id: "api", owner_id: "w", kr_item_id: "kr", name: "Latency",
    endpoint_url: "https://example.test/value", unit: "ms", baseline_value: 200, target_value: 120 });
  const rule = { ...krRule, source: "api", input: "samples", aggregation: "last", unit: "ms", baseline: 200, target: 120, direction: "decrease" };
  await f.write(change("rule", rule, "2026-11-29", 0), "2026-11-29");
  for (const [i, value] of [180, 140].entries()) f.seed("kr_metric_observations", {
    id: "api-" + i, owner_id: "w", kr_item_id: "kr", source: "api", event_kind: "synced",
    current_value: value, baseline_value: 200, target_value: 120, unit: "ms", observed_at: "2026-11-" + (29 + i) + "T08:00:00Z",
  });
  assert.equal((await f.state("2026-11-30")).performance.current.value, 140);
  await f.write(change("rule", { ...rule, aggregation: "average" }, "2026-11-30", 1), "2026-11-30");
  assert.equal((await f.state("2026-11-30")).performance.current.value, 160);
  assert.equal((await f.state("2026-12-01")).performance.current.value, null);
  assert.equal((await f.state("2026-12-01", { start: "2026-11-01", end: "2026-11-30" })).performance.selected.value, 160);
});

test("MCP SDK tools/list exposes new and retained tools, and web and MCP return identical counted results", async t => {
  const f = dataFixture(t);
  const now = at("2026-12-05");
  t.mock.timers.enable({ apis: ["Date"], now });
  const api = compile(route, { "cloudflare:workers": { env: { DB: f.db } }, "@/lib/pace-data": { authorizeRequest: async () => actor },
    "@/lib/kr-performance": service, "@/lib/kr-performance-model": model });
  const server = new McpServer({ name: "OKRI", version: "test" });
  oldTools.registerContributionScheduleTools(server, f.db, actor);
  mcp.registerKrPerformanceTools(server, f.db, actor);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(st);
  await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "set_kr_project_measurement", "get_project_contribution_schedule", "upsert_project_contribution_schedule",
    "get_metric_calendar", "set_metric_calendar", "get_kr_measurement_rule", "set_kr_measurement_rule",
    "get_project_contribution_rule", "set_project_contribution_rule", "record_kr_performance", "get_kr_performance", "list_kr_performance_changes",
    "bulk_upsert_metric_entries", "cancel_metric_entry", "correct_metric_entry", "get_metric_rollup_status", "get_metric_series",
    "get_metric_summary", "list_metric_entries", "list_project_operations", "preview_metric_recalculation",
    "recalculate_metric", "update_project_operations", "get_kr_metric_display", "set_kr_metric_display", "get_metric_comparisons",
  ].sort());
  const saved = await client.callTool({ name: "set_kr_measurement_rule", arguments: {
    key_result_id: "kr", expected_revision: 0, request_id: "web-mcp-rule", effective_date: "2026-12-01", reason: "Initial migration", rule: krRule,
  } });
  assert.equal(saved.structuredContent?.revision, 1, JSON.stringify(saved));
  const recorded = await api.PUT(new Request("http://localhost/api/kr-performance", { method: "PUT",
    body: JSON.stringify({ keyResultId: "kr", ...change("project", { ...projectRule, startDate: "2026-12-01", isEstimate: false },
      "2026-12-01", 1, { subjectId: "p", reason: "Original start date" }) }) }));
  assert.equal(recorded.status, 200, await recorded.clone().text());
  await service.runDueMetricRollups(f.db, now);
  const fromMcp = await client.callTool({ name: "get_kr_performance", arguments: { key_result_id: "kr", grain: "week", include_estimates: false } });
  assert.equal(fromMcp.structuredContent.display.current.value, "8시간");
  const changedDisplay = await client.callTool({ name: "set_kr_metric_display", arguments: {
    key_result_id: "kr", mode: "increment", increment: 5, expected_revision: 0,
  } });
  assert.equal(changedDisplay.structuredContent.currentValue, 8);
  assert.equal(changedDisplay.structuredContent.display.currentValue, "약 10시간");
  const readDisplay = await client.callTool({ name: "get_kr_metric_display", arguments: { key_result_id: "kr" } });
  assert.deepEqual(readDisplay.structuredContent, changedDisplay.structuredContent);
  const series = await client.callTool({ name: "get_metric_series", arguments: { key_result_id: "kr", grain: "week" } });
  assert.equal(series.structuredContent.points.at(-1).periodValue, 8);
  assert.equal(series.structuredContent.display.points.at(-1).periodValue, "약 10시간");
  const fromWeb = await api.GET(new Request("http://localhost/api/kr-performance?keyResultId=kr&grain=week&includeEstimates=false"));
  assert.equal(fromWeb.status, 200);
  const web = (await fromWeb.json()).performance;
  const { recordCount, nextRecordOffset, ...mcpResult } = fromMcp.structuredContent.performance;
  assert.deepEqual(mcpResult, web);
  assert.equal(recordCount, 4);
  assert.equal(web.current.value, 8);
  assert.equal(web.points.at(-1).periodValue, web.current.value);
  assert.equal(web.current.projectBreakdown[0].value, web.current.value);
  const fromComparison = await client.callTool({ name: "get_metric_comparisons", arguments: {
    key_result_id: "kr", as_of: "2026-12-05", current: { start: "2026-12-04", end: "2026-12-04" },
    previous: { start: "2026-12-03", end: "2026-12-03" }, include_estimates: false,
  } });
  const directComparison = await comparison.readMetricComparisons(f.db, "w", "kr", { asOf: "2026-12-05", includeEstimates: false,
    current: { start: "2026-12-04", end: "2026-12-04" }, previous: { start: "2026-12-03", end: "2026-12-03" } }, now);
  assert.deepEqual(fromComparison.structuredContent, directComparison);
  assert.equal(fromComparison.structuredContent.comparisons[0].currentValue, 2);
  const mcpHistory = await client.callTool({ name: "list_kr_performance_changes", arguments: { key_result_id: "kr" } });
  const webHistory = await (await api.GET(new Request("http://localhost/api/kr-performance?keyResultId=kr&view=changes"))).json();
  assert.deepEqual(mcpHistory.structuredContent, webHistory);
});

test("automatic closed business days persist once and the next tick repairs a missing date", async t => {
  const f = dataFixture(t);
  await f.write(change("rule", krRule, "2026-11-23", 0), "2026-11-23");
  await f.write(change("project", { ...projectRule, mode: "business_days", startDate: "2026-11-23" },
    "2026-11-23", 1, { subjectId: "p" }), "2026-11-23");
  f.sql.exec("UPDATE items SET status='done' WHERE id='p'");
  const state = day => service.readKrPerformance(f.db, "w", "kr", {}, at(day));
  assert.equal((await state("2026-11-26")).performance.current.value, 0);
  const preview = await service.previewMetricRollup(f.db, "w", "kr", {}, at("2026-11-26"));
  assert.equal(preview.currentAfter.value, 6);
  await service.runDueMetricRollups(f.db, at("2026-11-26"));
  assert.equal((await state("2026-11-26")).performance.current.value, 6);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM kr_metric_occurrences").get().n, 3);
  await service.runDueMetricRollups(f.db, at("2026-11-26"));
  assert.equal((await state("2026-11-26")).performance.current.value, 6);
  f.sql.exec("DELETE FROM kr_metric_occurrences WHERE occurred_on='2026-11-24'");
  assert.equal((await state("2026-11-26")).performance.current.value, 4);
  await service.runDueMetricRollups(f.db, at("2026-11-26"));
  const status = await service.getMetricRollupStatus(f.db, "w", "kr", undefined, 20, at("2026-11-26"));
  assert.equal(status.accumulatedThrough, "2026-11-25");
  assert.equal(status.missingFrom, null);
  assert.equal(status.lastScheduledAt, at("2026-11-26").toISOString());
  assert.ok(status.runs.some(run => run.recovered === 1));
  assert.equal((await state("2026-11-26")).performance.current.value, 6);
});

test("Project operations pause dated contributions without forcing numeric rules on other Projects", async t => {
  const f = dataFixture(t);
  f.seed("items", { id: "data", owner_id: "w", kind: "project", title: "Dataset", status: "done" });
  await f.write(change("rule", krRule, "2026-11-23", 0), "2026-11-23");
  await f.write(change("project", { ...projectRule, startDate: "2026-11-23", mode: "business_days" }, "2026-11-23", 1,
    { subjectId: "p" }), "2026-11-23");
  const value = { status: "operating", adoption: "partial", startDate: "2026-11-23", lastUseCheck: "2026-11-23",
    lastOperationCheck: "2026-11-23", reviewAfterDays: 2, evidenceUrl: "https://example.com/usage",
    pauses: [{ startDate: "2026-11-24", endDate: "2026-11-24" }] };
  const command = { expectedRevision: 0, effectiveDate: "2026-11-23", requestId: "ops", value };
  const saved = await ops.writeProjectOperations(f.db, actor, "p", command, "Asia/Seoul", at("2026-11-23"));
  assert.deepEqual(await ops.writeProjectOperations(f.db, actor, "p", command, "Asia/Seoul", at("2026-11-25")), saved);
  await ops.writeProjectOperations(f.db, actor, "data", command, "Asia/Seoul", at("2026-11-23"));
  const { items } = await ops.listProjectOperations(f.db, "w", "Asia/Seoul", { projectId: "data" }, at("2026-11-26"));
  assert.equal(items[0].buildStatus, "done");
  assert.equal(items[0].operations.adoption, "partial");
  assert.equal(items[0].useEvidence, "stale");
  assert.equal((await f.state("2026-11-26")).performance.current.value, 4);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM project_operation_versions").get().n, 2);
});

test("throughput imports replace matching estimates, keep undated data and audit corrections and cancellation", async t => {
  const f = dataFixture(t), now = at("2026-12-02");
  await f.write(change("rule", { ...krRule, source: "throughput", unit: "hour" }, "2026-11-01", 0), "2026-11-01");
  const bulk = (requestId, expectedRevision, entries) => service.bulkUpsertMetricEntries(f.db, actor, "kr", {
    requestId, expectedRevision, entries, reason: "Reconcile usage report",
  }, now);
  const make = (sourceKey, occurredOn, quantity, isEstimate = false) => ({
    sourceKey, occurredOn, unit: "hour", effectKey: "processed-orders", basis: "Usage report",
    formula: { kind: "difference", quantity: { value: quantity, unit: "orders", isEstimate },
      before: 0.75, after: 0.5, factorIsEstimate: true },
  });
  const initial = [make("estimated", "2026-11-25", 4, true), make("measured", "2026-11-25", 8),
    make("undated", null, 100), { ...make("wrong-unit", "2026-11-25", 4), unit: "min" }];
  const imported = await bulk("initial", 1, initial);
  assert.equal(imported.inserted, 3, JSON.stringify(imported));
  assert.equal(imported.failed, 1);
  assert.equal(imported.entries[3].code, "performance_unit_mismatch");
  assert.equal((await bulk("retry", imported.revision, [initial[1]])).duplicate, 1);
  const q = { start: "2026-11-01", end: "2026-11-30", grain: "month" };
  const first = (await service.readKrPerformance(f.db, "w", "kr", q, now)).performance;
  assert.equal(first.selected.value, 2);
  assert.equal(first.current.value, 0);
  assert.equal(first.lifetime.value, 2);
  assert.deepEqual(first.records.map(row => row.sourceKey), ["measured"]);
  const correction = { sourceKey: "measured", operation: "correct", reason: "Adjusted volume",
    requestId: "fix-measured", expectedRevision: imported.revision,
    entry: { formula: make("measured", "2026-11-25", 12).formula } };
  const corrected = await service.reviseMetricEntry(f.db, actor, "kr", correction, now);
  assert.equal(corrected.before.value, 2);
  assert.equal(corrected.after.value, 3);
  assert.deepEqual(await service.reviseMetricEntry(f.db, actor, "kr", correction, now), corrected);
  const cancel = await service.reviseMetricEntry(f.db, actor, "kr", { sourceKey: "measured", operation: "cancel",
    expectedRevision: corrected.revision, requestId: "void", reason: "Source retracted" }, now);
  assert.equal(cancel.after.voided, true);
  const ledger = await service.listMetricEntries(f.db, "w", "kr", q, now);
  assert.deepEqual(ledger.entries.map(row => row.status), ["undated", "applied", "cancelled"]);
  assert.equal((await service.readKrPerformance(f.db, "w", "kr", q, now)).performance.selected.value, 1);
});

test("ratio pools parts, checked snapshot keys deduplicate retries, and quarterly evaluation uses KR timezone", async t => {
  const f = dataFixture(t), now = at("2026-12-02");
  f.seed("kr_data_connections", { id: "api", owner_id: "w", kr_item_id: "kr", name: "Ratio", endpoint_url: "https://example.com/api",
    unit: "%", baseline_value: 0, target_value: 100 });
  await f.write(change("rule", { ...krRule, source: "api", input: "ratio", aggregation: "ratio", period: "quarterly", unit: "%",
    timezone: "America/St_Johns", numeratorPath: "success", denominatorPath: "total", snapshotKeyPath: "date" },
    "2026-11-01", 0), "2026-11-01");
  for (const [id, day, key, numerator, denominator] of [
    ["a", "2026-11-07", "a", 1, 10], ["a-retry", "2026-11-09", "a", 1, 10], ["b", "2026-11-10", "b", 9, 10],
  ]) f.seed("kr_metric_observations", { id, owner_id: "w", kr_item_id: "kr", source: "api", event_kind: "synced",
    current_value: 100 * numerator / denominator, baseline_value: 0, target_value: 100, unit: "%",
    observed_at: day + "T15:00:00.000Z", numerator, denominator, snapshot_key: key });
  const state = await service.readKrPerformance(f.db, "w", "kr", { grain: "month" }, now);
  assert.equal(state.timezone, "America/St_Johns");
  assert.deepEqual(state.performance.evaluation, { start: "2026-10-01", end: "2026-12-31" });
  assert.equal(state.performance.current.value, 50);
  assert.equal(state.performance.current.count, 2);
  assert.equal(state.performance.records[0].date, "2026-11-07");
});

test("MIXSOON progress regression returns the shared 49% instead of cached 8%", async t => {
  const f = dataFixture(t);
  f.sql.exec("UPDATE items SET progress=8 WHERE id='kr'");
  await f.write(change("rule", { ...krRule, source: "manual" }, "2026-11-01", 0), "2026-11-01");
  await f.write(change("entry", { value: 49.066663, basis: "Production mismatch regression" }, "2026-11-22", 1,
    { subjectId: "measurement" }), "2026-11-22");
  const summary = await service.listPerformanceSummaries(f.db, "w", at("2026-11-23"), ["kr"]);
  assert.equal(f.sql.prepare("SELECT progress FROM items WHERE id='kr'").get().progress, 8);
  assert.equal(summary[0].currentValue.toFixed(2), "49.07");
  assert.equal(summary[0].progress, 49);
});

test("the same API snapshot received three times remains 1,000", async t => {
  const f = dataFixture(t);
  f.seed("kr_data_connections", { id: "api", owner_id: "w", kr_item_id: "kr", name: "Counter",
    endpoint_url: "https://example.com/api", unit: "items", baseline_value: 0, target_value: 2000 });
  await f.write(change("rule", { ...krRule, source: "api", input: "samples", aggregation: "last", unit: "items", target: 2000 },
    "2026-11-01", 0), "2026-11-01");
  for (const [i, day] of ["2026-11-03", "2026-11-03", "2026-11-04"].entries()) {
    f.seed("kr_metric_observations", { id: "poll-" + i, owner_id: "w", kr_item_id: "kr", source: "api", event_kind: "synced",
      current_value: 1000, baseline_value: 0, target_value: 2000, unit: "items", observed_at: day + "T00:00:0" + i + ".000Z" });
  }
  const { performance } = await f.state("2026-11-04");
  assert.equal(performance.current.value, 1000);
  assert.equal(performance.current.progress, 50);
});

test("hour labels round only in the view and distinguish a small positive value from zero", () => {
  assert.equal(formatter.formatMetricValue(49.688095, "시간"), "약 49.5시간");
  assert.equal(formatter.formatMetricValue(25.838095, "시간"), "약 26시간");
  assert.equal(formatter.formatMetricValue(0.249999, "시간"), "0.5시간 미만");
  assert.equal(formatter.formatMetricValue(0.25, "시간"), "약 0.5시간");
  assert.equal(formatter.formatMetricValue(0, "시간"), "0시간");
  assert.equal(formatter.formatMetricValue(0.13, "hours", undefined, "en-US"), "Less than 0.5 hours");
  assert.equal(formatter.formatMetricValue(49.688095, "건"), "49.688095 건");
  assert.equal(formatter.formatMetricValue(49.688095, "시간", { mode: "exact", increment: null }), "49.688095시간");
  assert.equal(formatter.formatMetricValue(49.688095, "건", { mode: "increment", increment: 10 }), "약 50 건");
  assert.equal(formatter.formatMetricValue(16.025, "시간", { mode: "increment", increment: 0.01 }), "약 16.03시간");
  assert.equal(formatter.formatMetricValue(1e-23, "시간", { mode: "exact", increment: null }), "0.00000000000000000000001시간");
  assert.equal(formatter.formatMetricValue(null, "시간"), null);
});

test("a KR display preference survives reads and accrual without changing the rule or ledger", async t => {
  const f = dataFixture(t);
  await f.write(change("rule", krRule, "2026-11-23", 0), "2026-11-23");
  await f.write(change("project", { ...projectRule, mode: "daily", startDate: "2026-11-23", amount: 0.13 },
    "2026-11-23", 1, { subjectId: "p" }), "2026-11-23");
  const before = await f.state("2026-11-24");
  assert.equal(before.performance.current.value, 0.13);
  assert.equal(formatter.formatMetricValue(before.performance.current.value, "시간"), "0.5시간 미만");
  const input = { expectedRevision: 0, mode: "increment", increment: 0.1 };
  const [first, retry] = await Promise.all([display.saveMetricDisplaySettings(f.db, actor, "kr", input),
    display.saveMetricDisplaySettings(f.db, actor, "kr", input)]);
  assert.deepEqual(first, retry);
  assert.equal(first.revision, 1);
  await assert.rejects(display.saveMetricDisplaySettings(f.db, actor, "kr", { ...input, increment: 0.3 }),
    { code: "metric_display_revision_conflict" });
  await assert.rejects(display.saveMetricDisplaySettings(f.db, actor, "kr", { ...input, increment: 0.0000001 }),
    { code: "invalid_metric_display_increment" });
  await assert.rejects(display.saveMetricDisplaySettings(f.db, { ...actor, oauthScopes: "okri:read" }, "kr", input),
    { code: "write_access_required" });
  await assert.rejects(display.readMetricDisplaySettings(f.db, "other", "kr"), { code: "key_result_not_found" });
  const after = await f.state("2026-11-25");
  assert.equal(after.revision, 2);
  assert.equal(after.performance.current.value, 0.26);
  assert.equal(after.performance.selected.projectBreakdown[0].value, 0.26);
  assert.equal(after.performance.lifetime.value, 0.26);
  assert.deepEqual(after.performance.records.map(row => row.value), [0.13, 0.13]);
  const settings = await display.readMetricDisplaySettings(f.db, "w", "kr");
  assert.equal(formatter.formatMetricValue(after.performance.current.value, "시간", settings), "약 0.3시간");
  assert.equal((await f.state("2026-11-25")).performance.current.value, 0.26);
  const reset = await display.saveMetricDisplaySettings(f.db, actor, "kr", { expectedRevision: 1, mode: "default" });
  assert.equal(reset.revision, 2);
  assert.equal(formatter.formatMetricValue(after.performance.current.value, "시간", reset), "약 0.5시간");
});

test("period comparisons exclude missing data, preserve zero and return exact and formatted deltas", async t => {
  const f=dataFixture(t), now=at("2026-11-24");
  const rule={...krRule,source:"manual"};
  await f.write(change("rule",rule,"2026-10-01",0),"2026-10-01");
  const put=async (date,value,rev)=>f.write(change("entry",{value,basis:"observed"},date,rev,{subjectId:"v"+rev}),date);
  await put("2026-10-23",10,1);
  await put("2026-11-23",0,2);
  await put("2026-11-24",0.13,3);
  const data=await comparison.readMetricComparisons(f.db,"w","kr",{asOf:"2026-11-24"},now);
  const day=data.comparisons.find(c=>c.kind==="dod");
  assert.equal(day.previousValue,0);
  assert.equal(day.currentValue,0.13);
  assert.equal(day.percent,null);
  assert.equal(day.display.change,"+0.5시간 미만");
  assert.equal(data.comparisons.some(c=>c.kind==="yoy"),false);
  const month=data.comparisons.find(c=>c.kind==="mom");
  assert.equal(month.previousValue,10);
  assert.equal(month.currentValue,0.13);
  assert.equal(month.current.end,"2026-11-24");
  assert.equal(month.previous.end,"2026-10-24");
  const custom=await comparison.readMetricComparisons(f.db,"w","kr",{asOf:"2026-11-24",
    current:{start:"2026-11-24",end:"2026-11-24"},previous:{start:"2026-11-23",end:"2026-11-23"}},now);
  assert.equal(custom.comparisons[0].change,0.13);
  assert.equal((await comparison.readMetricComparisons(f.db,"w","kr",{asOf:"2026-11-02"},at("2026-11-02"))).comparisons.length,0);
  const same=await comparison.readMetricComparisons(f.db,"w","kr",{asOf:"2026-11-24"},now);
  assert.deepEqual(data,same);
});

test("monthly comparisons align full months and averages retain their aggregation", async t => {
  const periods=comparison.comparisonPeriods("2024-03-31");
  assert.deepEqual(periods.find(x=>x.kind==="mom").previous,{start:"2024-02-01",end:"2024-02-29"});
  const f=dataFixture(t);
  await f.write(change("rule",{...krRule,source:"manual",input:"samples",aggregation:"average"},"2026-10-01",0),"2026-10-01");
  for (const [date,value,rev] of [["2026-10-05",10,1],["2026-10-06",20,2],["2026-11-05",30,3],["2026-11-06",50,4]]) {
    await f.write(change("entry",{value,basis:"measure"},date,rev,{subjectId:"m"+rev}),date);
  }
  const value=(await comparison.readMetricComparisons(f.db,"w","kr",{asOf:"2026-11-24"},at("2026-11-24"))).comparisons.find(c=>c.kind==="mom");
  assert.equal(value.previousValue,15);assert.equal(value.currentValue,40);
});

test("Project API snapshots retain their own history and comparisons use latest values", async t => {
  const f=dataFixture(t);
  f.seed("kr_data_connections",{id:"project-api",owner_id:"w",kr_item_id:"p",name:"project",endpoint_url:"https://example.test",
    unit:"시간",baseline_value:0,target_value:100});
  for (const [id,day,value] of [["a","2026-11-23",0],["b","2026-11-24",0.5],["c","2026-11-24",0.75]]) {
    f.seed("kr_metric_observations",{id,owner_id:"w",kr_item_id:"p",source:"api",event_kind:"synced",current_value:value,
      baseline_value:0,target_value:100,unit:"시간",observed_at:day+"T03:00:00.000Z"});
  }
  const result=await comparison.readMetricComparisons(f.db,"w","",{projectId:"p",asOf:"2026-11-24"},at("2026-11-24"));
  assert.equal(result.comparisons.find(row=>row.kind==="dod").currentValue,0.75);
  assert.equal(result.comparisons.find(row=>row.kind==="dod").percent,null);
});

test("pooled ratios compare numerator and denominator without averaging percentages", async t => {
  const f=dataFixture(t);
  await f.write(change("rule",{...krRule,source:"manual",input:"ratio",aggregation:"ratio",unit:"%"},"2026-10-01",0),"2026-10-01");
  for(const [date,numerator,denominator,rev] of [["2026-10-05",1,10,1],["2026-10-06",9,10,2],["2026-11-05",1,2,3],["2026-11-06",9,18,4]]) {
    await f.write(change("entry",{numerator,denominator,basis:"ratio"},date,rev,{subjectId:"ratio"+rev}),date);
  }
  const result=(await comparison.readMetricComparisons(f.db,"w","kr",{asOf:"2026-11-24"},at("2026-11-24"))).comparisons.find(c=>c.kind==="mom");
  assert.equal(result.previousValue,50);
  assert.equal(result.currentValue,50);
  assert.equal(result.percent,0);
});
