import { readMetricCalendar } from "./project-metric-schedules";
import { dateOnly, localDate, ScheduleError, shiftDate } from "./project-metric-schedule-model";
import { operationHistory } from "./project-operations";
import { activeOperations, aggregatePerformance, amount, bool, choice, evaluationRange, evidenceUrl, formulaInput, formulaValue,
  PerformanceError, projectRuleInput, record, ruleAt, scheduledOccurrences,
  ruleInput, textValue, validateRange, type ApiSample, type Data, type Entry, type Grain, type Measurement, type MeasurementRule, type ProjectRule, type Version } from "./kr-performance-model";

type Actor = { ownerId: string; userId: string; role: string; oauthScopes?: string };
type ChangeKind = "rule" | "project" | "entry";
type Stored = {
  revision: number; kind: ChangeKind; subject_id: string; effective_date: string; recorded_at: string;
  actor_id: string; reason: string; value_json: string; request_json: string; receipt_json: string; request_id: string;
};
type RuleValue = { rule: MeasurementRule; adopted?: { projectId: string; value: ProjectRule }[] };
type Context = { id: string; title: string };
function activeTimezone(data: Data, fallback: string, now: Date, asOf?: unknown) {
  const effective = data.rules.findLast(rule => rule.effectiveDate <= (typeof asOf === "string" ? asOf : localDate(now, rule.value.timezone)));
  return effective?.value.timezone ?? data.rules[0]?.value.timezone ?? fallback;
}
const header = { "Cache-Control": "private, no-store" };
const asVersion = <T>(row: Stored, value: T): Version<T> => ({
  revision: row.revision, effectiveDate: row.effective_date, recordedAt: row.recorded_at, value,
});
const timeline = <T extends { effectiveDate: string; revision: number }>(rows: T[]) =>
  rows.slice().sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.revision - b.revision);

export function performanceFailure(error: unknown) {
  return error instanceof PerformanceError || error instanceof ScheduleError
    ? { code: error.code, status: error.status }
    : { code: error instanceof SyntaxError ? "invalid_performance_input" : "performance_unavailable",
      status: error instanceof SyntaxError ? 400 : 500 };
}
export function performanceResponse(data: unknown, status = 200) { return Response.json(data, { status, headers: header }); }

export function requireWriter(actor: Actor) {
  if (actor.role === "viewer" || (actor.oauthScopes !== undefined && !actor.oauthScopes.split(/\s+/).includes("okri:write"))) {
    throw new PerformanceError("write_access_required", 403);
  }
}

async function keyResult(db: D1Database, owner: string, id: string): Promise<Context> {
  const result = await db.prepare("SELECT id,title FROM items WHERE owner_id=? AND id=? AND kind='key_result' AND archived_at IS NULL")
    .bind(owner, id).first<Context>();
  if (!result) throw new PerformanceError("key_result_not_found", 404);
  return result;
}
export async function currentProjectKr(db: D1Database, owner: string, projectId: string) {
  const project = await db.prepare(`SELECT p.id,p.title,i.parent_id AS keyResultId FROM items p
    JOIN items i ON p.owner_id=i.owner_id AND p.parent_id=i.id AND i.kind='initiative' AND i.archived_at IS NULL
    JOIN items k ON i.owner_id=k.owner_id AND i.parent_id=k.id AND k.kind='key_result' AND k.archived_at IS NULL
    WHERE p.owner_id=? AND p.id=? AND p.kind='project' AND p.archived_at IS NULL`).bind(owner, projectId)
    .first<Context & { keyResultId: string }>();
  if (!project) throw new PerformanceError("project_not_linked_to_kr", 404);
  return project;
}

async function changesFor(db: D1Database, owner: string, id: string) {
  return (await db.prepare("SELECT * FROM kr_performance_changes WHERE owner_id=? AND kr_item_id=? ORDER BY revision")
    .bind(owner, id).all<Stored>()).results;
}
export async function hasPerformanceRule(db: D1Database, owner: string, id: string) {
  return Boolean(await db.prepare("SELECT 1 FROM kr_performance_changes WHERE owner_id=? AND kr_item_id=? AND kind='rule' LIMIT 1")
    .bind(owner, id).first());
}

export async function hasEffectivePerformanceRule(db: D1Database, owner: string, id: string, now: Date) {
  const rows = await db.prepare(`SELECT effective_date,value_json FROM kr_performance_changes
    WHERE owner_id=? AND kr_item_id=? AND kind='rule' ORDER BY effective_date DESC,revision DESC`)
    .bind(owner, id).all<Pick<Stored, "effective_date" | "value_json">>();
  return rows.results.some(row => row.effective_date <= localDate(now, (JSON.parse(row.value_json) as RuleValue).rule.timezone));
}

export async function readProjectPeriodContribution(db: D1Database, owner: string, krId: string, projectId: string) {
  if (!await hasPerformanceRule(db, owner, krId)) return null;
  const state = await readKrPerformance(db, owner, krId, { grain: "month" });
  const result = state.performance;
  if (!result) return null;
  const version = ruleAt(state.configuration.projects.filter(project => project.projectId === projectId), state.asOf);
  const operations = ruleAt((await operationHistory(db, owner, [projectId])).get(projectId) ?? [], state.asOf);
  const contribution = result.current.projectBreakdown.find(project => project.projectId === projectId);
  return { start: result.evaluation.start, end: result.evaluation.end, unit: result.rule.value.unit,
    value: contribution?.value ?? 0, isEstimate: Boolean(contribution?.hasEstimates),
    operating: operations ? activeOperations(operations.value, state.asOf) : version?.value.operating ?? null };
}

async function compileData(db: D1Database, owner: string, id: string, ledger: Stored[]): Promise<Data> {
  const rules: Data["rules"] = [], projects: Data["projects"] = [];
  const entries = new Map<string, Data["entries"][number]>();
  for (const row of ledger) {
    if (row.kind === "rule") {
      const value = JSON.parse(row.value_json) as RuleValue;
      rules.push(asVersion(row, value.rule));
      for (const item of value.adopted ?? []) projects.push({ projectId: item.projectId, ...asVersion(row, item.value) });
    } else if (row.kind === "project") {
      projects.push({ projectId: row.subject_id, ...asVersion(row, JSON.parse(row.value_json) as ProjectRule) });
    } else {
      const value = JSON.parse(row.value_json) as Entry;
      if (value.voided && !value.sourceKey) entries.delete(row.subject_id);
      else entries.set(row.subject_id, { ...value, id: row.subject_id, recordedAt: row.recorded_at, cancelled: value.voided });
    }
  }
  const samples = rules.some(rule => rule.value.source === "api")
    ? (await db.prepare(`SELECT id,observed_at AS observedAt,current_value AS value,unit,numerator,denominator,snapshot_key AS snapshotKey FROM kr_metric_observations
        WHERE owner_id=? AND kr_item_id=? AND source='api' AND event_kind='synced' AND current_value IS NOT NULL
        AND observed_at >= ? ORDER BY observed_at,id LIMIT 50001`)
      .bind(owner, id, shiftDate(timeline(rules)[0].effectiveDate, -2)).all<ApiSample>()).results
    : [];
  if (samples.length > 50000) throw new PerformanceError("performance_sample_limit", 422);
  const stops = projects.length ? (await db.prepare(`SELECT project_id AS projectId, recorded_at AS recordedAt
      FROM kr_performance_stops WHERE owner_id=? AND kr_item_id=? ORDER BY recorded_at,id`)
    .bind(owner, id).all<Data["stops"][number]>()).results : [];
  const operations = await operationHistory(db, owner, [...new Set(projects.map(p => p.projectId))]);
  return { rules: timeline(rules), projects: timeline(projects), entries: [...entries.values()], samples, stops, operations };
}

const dateOptions = (raw: Record<string, unknown>, timezone: string, now: Date) => {
  const asOf = raw.asOf ? dateOnly(raw.asOf) : localDate(now, timezone);
  if (asOf > localDate(now, timezone)) throw new PerformanceError("future_performance_date");
  validateRange(asOf, asOf);
  const range = raw.start != null || raw.end != null ? { start: dateOnly(raw.start), end: dateOnly(raw.end) } : undefined;
  if (range) validateRange(range.start, range.end);
  const grain = choice(raw.grain ?? "day", ["day", "week", "month"] satisfies Grain[]);
  return { asOf, range, grain, includeEstimates: bool(raw.includeEstimates, true) };
};

export async function readKrPerformance(db: D1Database, owner: string, id: string, raw: Record<string, unknown> = {}, now = new Date()) {
  const [kr, ledger, calendar] = await Promise.all([keyResult(db, owner, id), changesFor(db, owner, id), readMetricCalendar(db, owner)]);
  const data = await compileData(db, owner, id, ledger);
  const timezone = activeTimezone(data, calendar.timezone, now, raw.asOf);
  const options = dateOptions(raw, timezone, now);
  if (data.projects.length) {
    const state = await rollupState(db, owner, id);
    if (state || data.rules[0]?.value.progressBasis !== undefined) data.occurrences = await postedOccurrences(db, owner, id);
  }
  if (raw.recent === true && !options.range) options.range = { start: shiftDate(options.asOf, -29), end: options.asOf };
  const performance = aggregatePerformance(data, options, now);
  return { keyResult: kr, revision: ledger.at(-1)?.revision ?? 0, timezone, asOf: options.asOf,
    configuration: { rules: data.rules, projects: data.projects.map(({ value: { earnedDates, ...value }, ...project }) => ({ ...project, value })) },
    performance };
}
export type KrPerformanceState = Awaited<ReturnType<typeof readKrPerformance>>;

export async function readPerformanceChanges(db: D1Database, owner: string, id: string, fromRevision = 0, limit = 50) {
  await keyResult(db, owner, id);
  if (!Number.isSafeInteger(fromRevision) || fromRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new PerformanceError("invalid_performance_page");
  }
  const r = await db.prepare(`SELECT revision,kind,subject_id,effective_date,recorded_at,actor_id,reason,receipt_json
    FROM kr_performance_changes WHERE owner_id=? AND kr_item_id=? AND revision>? ORDER BY revision LIMIT ?`)
    .bind(owner, id, fromRevision, limit + 1).all<Stored>();
  const items = r.results.slice(0, limit).map(row => ({
    revision: row.revision, kind: row.kind, subjectId: row.subject_id, effectiveDate: row.effective_date,
    recordedAt: row.recorded_at, actorId: row.actor_id, reason: row.reason, ...JSON.parse(row.receipt_json),
  }));
  return { changes: items, nextRevision: r.results.length > limit ? items.at(-1)!.revision as number : null };
}

async function adoptSchedules(db: D1Database, owner: string, id: string, rule: MeasurementRule) {
  const calendar = await readMetricCalendar(db, owner);
  type Legacy = { projectId: string; title: string; mode: string; amount: number; startDate: string; endDate: string | null;
    pauses: string; dates: string; through: string; active: number; munit: string };
  const result = await db.prepare(`SELECT s.project_id AS projectId,coalesce(p.title,s.project_id) AS title,s.mode,s.amount,
    s.start_date AS startDate,s.end_date AS endDate,s.pauses_json AS pauses,s.credit_dates_json AS dates,s.through_date AS through,
    s.active,m.unit AS munit FROM project_metric_schedules s LEFT JOIN items p ON p.id=s.project_id AND p.owner_id=s.owner_id
    JOIN kr_project_metrics m ON m.owner_id=s.owner_id AND m.kr_item_id=s.kr_item_id
    WHERE s.owner_id=? AND s.kr_item_id=? ORDER BY s.project_id`).bind(owner, id).all<Legacy>();
  if (result.results.some(row => row.munit !== rule.unit)) throw new PerformanceError("legacy_schedule_unit_mismatch", 409);
  return result.results.map(row => ({ projectId: row.projectId,
    value: { ...projectRuleInput({ ...row, operating: Boolean(row.active), isEstimate: true, pauses: JSON.parse(row.pauses),
      basis: "Existing Project contribution schedule" }, calendar, row.title, rule.unit),
      earnedDates: JSON.parse(row.dates) as string[], earnedThrough: row.through } }));
}

function sanitize(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const { earnedDates, ...visible } = value as Record<string, unknown>;
  return visible;
}

function sameRequest(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (!first || !second || typeof first !== "object" || typeof second !== "object" || Array.isArray(first) !== Array.isArray(second)) return false;
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length &&
    keys.every(key => Object.hasOwn(second, key) && sameRequest((first as Record<string, unknown>)[key], (second as Record<string, unknown>)[key]));
}

export async function writePerformance(db: D1Database, actor: Actor, id: string, raw: unknown, now = new Date()) {
  requireWriter(actor);
  const input = record(raw), kind = choice(input.kind, ["rule", "project", "entry"]);
  const requestId = textValue(input.requestId, 128), reason = textValue(input.reason ?? "", 1000, true);
  const effectiveDate = dateOnly(input.effectiveDate);
  validateRange(effectiveDate, effectiveDate);
  const expectedRevision = input.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new PerformanceError("performance_revision_required");
  }
  await keyResult(db, actor.ownerId, id);
  const ledger = await changesFor(db, actor.ownerId, id);
  const request = { ...input, expectedRevision: null };
  const existing = ledger.find(row => row.request_id === requestId);
  if (existing) {
    if (!sameRequest(JSON.parse(existing.request_json), request)) throw new PerformanceError("performance_request_id_reused", 409);
    return JSON.parse(existing.receipt_json);
  }
  if ((ledger.at(-1)?.revision ?? 0) !== expectedRevision) throw new PerformanceError("performance_revision_conflict", 409);
  const oldData = await compileData(db, actor.ownerId, id, ledger);
  const calendar = await readMetricCalendar(db, actor.ownerId);
  const timezone = activeTimezone(oldData, calendar.timezone, now);
  const today = localDate(now, timezone);
  if (effectiveDate < today && !reason) throw new PerformanceError("performance_correction_reason_required");
  if (kind === "entry" && effectiveDate > today) throw new PerformanceError("future_performance_date");
  let value: RuleValue | ProjectRule | Entry, before: unknown = null, subject = "", priorDate: string | undefined;
  let appliesUntil: string | null = null, linkedProject: string | null = null;
  const effectiveRule = ruleAt(oldData.rules, effectiveDate)?.value;
  if (kind === "rule") {
    const rule = ruleInput(input.value, timezone);
    before = effectiveRule ?? null;
    if (rule.source === "api") {
      const connection = await db.prepare("SELECT active,unit FROM kr_data_connections WHERE owner_id=? AND kr_item_id=?")
        .bind(actor.ownerId, id).first<{ active: number; unit: string }>();
      const projectMeasurement = await db.prepare("SELECT active FROM kr_project_metrics WHERE owner_id=? AND kr_item_id=? AND active=1")
        .bind(actor.ownerId, id).first();
      if (!connection || connection.unit !== rule.unit || projectMeasurement) throw new PerformanceError("matching_api_source_required", 409);
    }
    value = { rule, ...(!oldData.rules.some(row => row.value.source === "projects") && rule.source === "projects"
      ? { adopted: await adoptSchedules(db, actor.ownerId, id, rule) } : {}) };
    const next = oldData.rules.find(row => row.effectiveDate > effectiveDate);
    appliesUntil = next ? shiftDate(next.effectiveDate, -1) : null;
  } else if (kind === "project") {
    if (!effectiveRule || effectiveRule.source !== "projects") throw new PerformanceError("project_performance_rule_required", 409);
    subject = textValue(input.subjectId, 128);
    const project = await currentProjectKr(db, actor.ownerId, subject);
    if (project.keyResultId !== id) throw new PerformanceError("project_not_linked_to_kr", 404);
    linkedProject = subject;
    const versions = oldData.projects.filter(row => row.projectId === subject);
    before = ruleAt(versions, effectiveDate)?.value ?? null;
    value = projectRuleInput(input.value, calendar, project.title, effectiveRule.unit);
    const next = versions.find(row => row.effectiveDate > effectiveDate);
    appliesUntil = next ? shiftDate(next.effectiveDate, -1) : null;
  } else {
    if (!effectiveRule || effectiveRule.source === "api" && !record(input.value).sourceKey) {
      throw new PerformanceError("manual_performance_rule_required", 409);
    }
    const entry = record(input.value);
    const sourceKey = entry.sourceKey == null ? undefined : textValue(entry.sourceKey, 180);
    const undated = entry.undated === true;
    const projectId = entry.projectId != null ? textValue(entry.projectId, 128) : null;
    if (effectiveRule.source === "projects" && !projectId) throw new PerformanceError("project_id_required");
    if (entry.unit != null && entry.unit !== effectiveRule.unit) throw new PerformanceError("performance_unit_mismatch");
    subject = sourceKey ? "source:" + sourceKey : projectId ? projectId + "/" + effectiveDate : textValue(input.subjectId, 128);
    const previous = oldData.entries.find(row => row.id === subject);
    priorDate = previous?.date ?? undefined;
    before = previous ?? null;
    const voided = bool(entry.voided, false);
    if (voided && (!previous || previous.cancelled)) throw new PerformanceError("performance_entry_not_found", 404);
    if (sourceKey && previous && input.operation !== "correct" && input.operation !== "cancel") {
      throw new PerformanceError("metric_source_key_exists", 409);
    }
    if ((previous || voided) && !reason) throw new PerformanceError("performance_correction_reason_required");
    if (sourceKey && !previous && (input.operation === "correct" || input.operation === "cancel")) {
      throw new PerformanceError("performance_entry_not_found", 404);
    }
    let title = previous?.projectId === projectId ? previous?.title ?? null : null;
    let effectKey = entry.effectKey ? textValue(entry.effectKey, 128) : previous?.effectKey;
    if (projectId && (!previous || previous.projectId !== projectId)) {
      const occurrence = undated ? undefined : scheduledOccurrences(oldData, effectiveDate, now).find(row => row.projectId === projectId && row.date === effectiveDate);
      if (occurrence) {
        before ??= occurrence;
        title = occurrence.title;
        effectKey ??= occurrence.effectKey;
      } else {
        const project = await currentProjectKr(db, actor.ownerId, projectId);
        if (project.keyResultId !== id) throw new PerformanceError("project_not_linked_to_kr", 404);
        title = project.title;
        linkedProject = projectId;
      }
    }
    if (voided && previous) {
      const { id: entryId, recordedAt, cancelled, ...prior } = previous;
      value = { ...prior, voided: true };
    } else {
      const formula = entry.formula != null ? formulaInput(entry.formula) : undefined;
      if (effectiveRule.source === "throughput" && (!formula || formula.kind === "fixed")) throw new PerformanceError("actual_quantity_required");
      if (projectId && effectiveRule.source === "projects") {
        const version = ruleAt(oldData.projects.filter(rule => rule.projectId === projectId), effectiveDate);
        if (version?.value.mode === "actual" && (!formula || formula.kind === "fixed")) throw new PerformanceError("actual_quantity_required");
        effectKey ??= version?.value.effectKey;
      }
      const periodEnd = entry.periodEnd == null ? null : dateOnly(entry.periodEnd);
      const periodStart = entry.periodStart == null ? null : dateOnly(entry.periodStart);
      if (periodEnd && (undated || periodEnd !== effectiveDate) || periodStart && (undated || periodStart > effectiveDate)) {
        throw new PerformanceError("invalid_performance_range");
      }
      const numerator = effectiveRule.input === "ratio" ? amount(entry.numerator) : undefined;
      const denominator = effectiveRule.input === "ratio" ? amount(entry.denominator) : undefined;
      if (denominator !== undefined && denominator < 0) throw new PerformanceError("invalid_performance_value");
      const result = formula ? formulaValue(formula) : { value: denominator !== undefined
        ? denominator > 0 ? (effectiveRule.ratioScale ?? 1) * numerator! / denominator : 0
        : amount(entry.value), isEstimate: bool(entry.isEstimate, false) };
      value = { date: undated ? null : effectiveDate, value: result.value, basis: textValue(entry.basis, 1000),
        isEstimate: result.isEstimate, unit: effectiveRule.unit, input: effectiveRule.input, source: effectiveRule.source,
        projectId, title, voided, evidenceUrl: evidenceUrl(entry.evidenceUrl),
        ...(sourceKey ? { sourceKey } : {}), ...(effectKey ? { effectKey } : {}), ...(formula ? { formula } : {}),
        ...(periodEnd ? { periodEnd } : {}), ...(periodStart ? { periodStart } : {}),
        ...(denominator !== undefined ? { numerator, denominator } : {}) };
    }
    if (effectiveRule.input === "counter" && value.value < 0) throw new PerformanceError("invalid_performance_value");
    appliesUntil = effectiveRule.input === "counter" ? null : [effectiveDate, priorDate ?? effectiveDate].sort().at(-1)!;
  }
  const revision = expectedRevision + 1, at = now.toISOString();
  const serial = JSON.stringify(value);
  const row: Stored = { revision, kind, subject_id: subject, effective_date: effectiveDate, recorded_at: at,
    actor_id: actor.userId, reason, value_json: serial, receipt_json: "{}", request_json: JSON.stringify(request), request_id: requestId };
  const newData = await compileData(db, actor.ownerId, id, [...ledger, row]);
  const currentFor = (data: Data) => {
    const active = ruleAt(data.rules, today);
    if (!active) return null;
    const first = data.rules[0].effectiveDate;
    const range = evaluationRange(active.value, today, first);
    return aggregatePerformance(data, { asOf: today, range, grain: "month", includeEstimates: true }, now)?.current ?? null;
  };
  const from = [effectiveDate, priorDate ?? effectiveDate].sort()[0];
  const periods = kind === "entry" && !(value as Entry).date && !priorDate ? [] : affectedPeriods(newData, from, appliesUntil, today);
  const receipt = { keyResultId: id, revision, kind, subjectId: subject, effectiveDate, recordedAt: at, reason,
    before: sanitize(before), after: sanitize(kind === "rule" ? (value as RuleValue).rule : value),
    affected: { from, through: appliesUntil, periods }, currentBefore: currentFor(oldData), currentAfter: currentFor(newData) };
  const write = await db.prepare(`INSERT INTO kr_performance_changes
    (id,owner_id,kr_item_id,revision,request_id,kind,subject_id,effective_date,recorded_at,actor_id,reason,request_json,value_json,receipt_json)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE coalesce((SELECT max(revision) FROM kr_performance_changes WHERE owner_id=? AND kr_item_id=?),0)=?
      AND EXISTS(SELECT 1 FROM items k WHERE k.owner_id=? AND k.id=? AND k.kind='key_result' AND k.archived_at IS NULL)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM items p JOIN items i ON p.owner_id=i.owner_id AND p.parent_id=i.id
        WHERE p.owner_id=? AND p.id=? AND p.kind='project' AND p.archived_at IS NULL AND i.kind='initiative' AND i.archived_at IS NULL AND i.parent_id=?))`)
    .bind(crypto.randomUUID(), actor.ownerId, id, revision, requestId, kind, subject, effectiveDate, at, actor.userId, reason,
      row.request_json, serial, JSON.stringify(receipt), actor.ownerId, id, expectedRevision, actor.ownerId, id,
      linkedProject, actor.ownerId, linkedProject, id).run();
  if (!write.meta.changes) {
    const competing = (await changesFor(db, actor.ownerId, id)).find(change => change.request_id === requestId);
    if (competing && sameRequest(JSON.parse(competing.request_json), request)) return JSON.parse(competing.receipt_json);
    throw new PerformanceError("performance_revision_conflict", 409);
  }
  return receipt;
}

function affectedPeriods(data: Data, start: string, through: string | null, today: string) {
  const dates = new Map<string, { start: string; end: string }>();
  const end = through ?? (start > today ? start : today);
  for (let day = start; day <= end;) {
    const rule = ruleAt(data.rules, day);
    const next = data.rules.find(row => row.effectiveDate > day)?.effectiveDate;
    if (!rule) { if (!next) break; day = next; continue; }
    const period = evaluationRange(rule.value, day, data.rules[0].effectiveDate);
    dates.set(period.start + "/" + period.end, period);
    if (dates.size >= 366 || rule.value.period === "all_time" && !next) break;
    const boundary = period.end < day ? end : period.end;
    day = next && next <= boundary ? next : shiftDate(boundary, 1);
  }
  return [...dates.values()];
}

export async function listPerformanceSummaries(db: D1Database, owner: string, now = new Date(), filter?: string[]) {
  const ids = await db.prepare(`SELECT DISTINCT c.kr_item_id AS id FROM kr_performance_changes c
    JOIN items i ON i.id=c.kr_item_id AND i.owner_id=c.owner_id AND i.archived_at IS NULL
    WHERE c.owner_id=? AND c.kind='rule'`).bind(owner).all<{ id: string }>();
  const requested = filter && new Set(filter);
  return Promise.all(ids.results.filter(({ id }) => !requested || requested.has(id)).map(async ({ id }) => {
    const state = await readKrPerformance(db, owner, id, { grain: "day", recent: true }, now);
    const p = state.performance;
    return p ? { keyResultId: id, performance: true as const, mode: p.rule.value.source,
      currentValue: p.current.value, targetValue: p.rule.value.target, progress: p.current.progress ?? 0,
      unit: p.rule.value.unit, isEstimate: p.current.hasEstimates, trend: p.points } : null;
  }));
}

type RollupState = { generation: string; signature: string; through_date: string; last_success_at: string; last_scheduled_at: string | null };
type Posted = { payload: string; posted_at: string };
const rollupState = (db: D1Database, owner: string, kr: string) => db.prepare(
  "SELECT generation,signature,through_date,last_success_at,last_scheduled_at FROM kr_metric_rollup_state WHERE owner_id=? AND kr_item_id=?")
  .bind(owner, kr).first<RollupState>();
const postedRows = async (db: D1Database, owner: string, kr: string) => (await db.prepare(
  "SELECT payload,posted_at FROM kr_metric_occurrences WHERE owner_id=? AND kr_item_id=? ORDER BY occurred_on,id")
  .bind(owner, kr).all<Posted>()).results;
async function postedOccurrences(db: D1Database, owner: string, kr: string) {
  return (await postedRows(db, owner, kr)).map(row => ({ ...JSON.parse(row.payload) as Measurement, postedAt: row.posted_at }));
}
function rollupOptions(query: Record<string, unknown>, now: Date, data: Data, timezone: string) {
  const options = dateOptions({ ...query, grain: query.grain ?? "month" }, timezone, now);
  const zones = [...new Set([timezone, ...data.projects.map(row => row.value.calendar.timezone)])];
  const days = zones.map(zone => localDate(now, zone)).sort();
  return { options, through: shiftDate(days[0], -1), lastDay: days.at(-1)! };
}

async function rollupPlan(db: D1Database, owner: string, id: string, now: Date, query: Record<string, unknown> = {}) {
  const [ledger, existing, previous, calendar] = await Promise.all([
    changesFor(db, owner, id), postedRows(db, owner, id), rollupState(db, owner, id), readMetricCalendar(db, owner),
  ]);
  const data = await compileData(db, owner, id, ledger);
  const revision = ledger.at(-1)?.revision ?? 0;
  if (!data.rules.length) throw new PerformanceError("measurement_rule_required", 409);
  const timezone = activeTimezone(data, calendar.timezone, now, query.asOf);
  const { options, through, lastDay } = rollupOptions(query, now, data, timezone);
  const fresh = scheduledOccurrences(data, lastDay, now);
  const pastRows = existing.map(row => JSON.parse(row.payload) as Measurement);
  const past = new Map(pastRows.map(row => [row.id, row]));
  const proposed = new Map(fresh.map(row => [row.id, row]));
  const upserts = fresh.filter(row => JSON.stringify(row) !== JSON.stringify(past.get(row.id)));
  const removed = pastRows.filter(row => !proposed.has(row.id));
  const dates = new Map<string, { date: string; before: number; after: number }>();
  for (const [row, key] of [...upserts.map(row => [row, "after"] as const),
    ...pastRows.filter(row => !proposed.has(row.id) || JSON.stringify(row) !== JSON.stringify(proposed.get(row.id))).map(row => [row, "before"] as const)]) {
    const day = dates.get(row.date) ?? { date: row.date, before: 0, after: 0 };
    day[key] += row.value;
    dates.set(row.date, day);
  }
  const recovered = upserts.filter(row => !past.has(row.id) && row.date < through).length;
  const projectIds = JSON.stringify([...new Set(data.projects.map(row => row.projectId))]);
  // These identities let the batch refuse to post a plan computed before a
  // concurrent rule edit, operation update, archive, or another successful run.
  const operations = JSON.stringify([...data.operations?.values() ?? []].flat().map(row => row.id).sort());
  const result = { revision, asOf: options.asOf, through, added: upserts.filter(row => !past.has(row.id)).length,
    corrected: upserts.filter(row => past.has(row.id)).length, removed: removed.length, recovered,
    affectedDates: [...dates.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  return { ...result, data, pastRows, fresh, upserts, removedRows: removed, options, projectIds, operations,
    stopCount: data.stops.length, previous, result };
}

export async function previewMetricRollup(db: D1Database, owner: string, id: string, query: Record<string, unknown> = {}, now = new Date()) {
  await keyResult(db, owner, id);
  const plan = await rollupPlan(db, owner, id, now, query);
  const before = aggregatePerformance({ ...plan.data, occurrences: plan.pastRows }, plan.options, now);
  const after = aggregatePerformance({ ...plan.data, occurrences: plan.fresh }, plan.options, now);
  const days = plan.affectedDates.filter(row => row.date <= plan.options.asOf &&
    (!plan.options.range || row.date >= plan.options.range.start && row.date <= plan.options.range.end));
  return { ...plan.result, affectedDates: days.slice(0, 366), affectedDateCount: days.length,
    currentBefore: before?.current ?? null, currentAfter: after?.current ?? null,
    selectedBefore: before?.selected ?? null, selectedAfter: after?.selected ?? null };
}

async function reconcileMetricRollup(db: D1Database, owner: string, id: string, origin: "schedule" | "manual",
  now: Date, expectedRevision?: number, reason?: string, actorId?: string) {
  const plan = await rollupPlan(db, owner, id, now);
  if (expectedRevision !== undefined && plan.revision !== expectedRevision) throw new PerformanceError("performance_revision_conflict", 409);
  const at = now.toISOString();
  if (plan.previous && plan.previous.last_success_at > at) throw new PerformanceError("stale_rollup", 409);
  const runId = crypto.randomUUID();
  const signature = JSON.stringify([plan.revision, plan.operations, plan.stopCount]);
  const statements = [db.prepare(`INSERT INTO kr_metric_rollup_state
    (kr_item_id,owner_id,generation,signature,through_date,last_success_at,last_scheduled_at)
    SELECT ?,?,?,?,?,?,?
    WHERE coalesce((SELECT max(revision) FROM kr_performance_changes WHERE owner_id=? AND kr_item_id=?),0)=?
      AND (SELECT json_group_array(id) FROM (SELECT id FROM project_operation_versions WHERE owner_id=?
        AND project_id IN (SELECT value FROM json_each(?)) ORDER BY id))=?
      AND (SELECT count(*) FROM kr_performance_stops WHERE owner_id=? AND kr_item_id=?)=?
      AND coalesce((SELECT generation FROM kr_metric_rollup_state WHERE owner_id=? AND kr_item_id=?),'')=?
      AND EXISTS(SELECT 1 FROM items WHERE owner_id=? AND id=? AND kind='key_result' AND archived_at IS NULL)
    ON CONFLICT(kr_item_id) DO UPDATE SET generation=excluded.generation, signature=excluded.signature,
      through_date=excluded.through_date,last_success_at=excluded.last_success_at,
      last_scheduled_at=coalesce(excluded.last_scheduled_at,kr_metric_rollup_state.last_scheduled_at)`)
    .bind(id, owner, runId, signature, plan.through, at, origin === "schedule" ? at : null,
      owner, id, plan.revision, owner, plan.projectIds, plan.operations, owner, id, plan.stopCount,
      owner, id, plan.previous?.generation ?? "", owner, id)];
  const witness = "EXISTS(SELECT 1 FROM kr_metric_rollup_state WHERE owner_id=? AND kr_item_id=? AND generation=?)";
  for (let start = 0; start < plan.upserts.length; start += 50) {
    statements.push(db.prepare(`INSERT INTO kr_metric_occurrences(id,owner_id,kr_item_id,occurred_on,payload,posted_at)
      SELECT ? || '/' || json_extract(value,'$.id'),?,?,json_extract(value,'$.date'),value,? FROM json_each(?)
      WHERE ${witness}
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,posted_at=excluded.posted_at`)
      .bind(id, owner, id, at, JSON.stringify(plan.upserts.slice(start, start + 50)), owner, id, runId));
  }
  for (let start = 0; start < plan.removedRows.length; start += 500) {
    statements.push(db.prepare(`DELETE FROM kr_metric_occurrences WHERE owner_id=? AND kr_item_id=?
      AND id IN (SELECT value FROM json_each(?)) AND ${witness}`)
      .bind(owner, id, JSON.stringify(plan.removedRows.slice(start, start + 500).map(row => id + "/" + row.id)), owner, id, runId));
  }
  const affectedDates = plan.result.affectedDates.slice(0, 366);
  const receipt = { ...plan.result, affectedDates, affectedDateCount: plan.result.affectedDates.length, at, actorId, reason };
  if (affectedDates.length || origin === "manual" || !plan.previous || plan.previous.signature !== signature) {
    statements.push(db.prepare(`INSERT INTO kr_metric_rollup_runs(id,owner_id,kr_item_id,recorded_at,status,origin,result_json)
      SELECT ?,?,?,?,'success',?,? WHERE ${witness}`)
      .bind(runId, owner, id, at, origin, JSON.stringify(receipt), owner, id, runId));
  }
  const results = await db.batch(statements);
  if (!results[0].meta.changes) throw new PerformanceError("performance_revision_conflict", 409);
  return receipt;
}

export async function recalculateMetric(db: D1Database, actor: Actor, id: string, expectedRevision: number, reason: string, now = new Date()) {
  requireWriter(actor);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new PerformanceError("performance_revision_required");
  return reconcileMetricRollup(db, actor.ownerId, id, "manual", now, expectedRevision, textValue(reason, 1000), actor.userId);
}

export async function runDueMetricRollups(db: D1Database, now = new Date()) {
  const targets = (await db.prepare(`SELECT DISTINCT c.owner_id AS owner,c.kr_item_id AS kr FROM kr_performance_changes c
    JOIN items i ON i.owner_id=c.owner_id AND i.id=c.kr_item_id AND i.kind='key_result' AND i.archived_at IS NULL
    WHERE c.kind='rule' ORDER BY c.owner_id,c.kr_item_id`).all<{ owner: string; kr: string }>()).results;
  let failures = 0;
  for (const { owner, kr } of targets) {
    try { await reconcileMetricRollup(db, owner, kr, "schedule", now); }
    catch (error) {
      const { code } = performanceFailure(error);
      if (code === "performance_revision_conflict" || code === "stale_rollup") continue;
      failures++;
      await db.prepare(`INSERT INTO kr_metric_rollup_runs(id,owner_id,kr_item_id,recorded_at,status,origin,result_json)
        VALUES(?,?,?,?,'error','schedule',?)`).bind(crypto.randomUUID(), owner, kr, now.toISOString(), JSON.stringify({ code })).run();
    }
  }
  if (failures) throw new Error(`${failures} KR metric rollup(s) failed`);
}

export async function getMetricRollupStatus(db: D1Database, owner: string, kr: string,
  cursor?: string, limit = 20, now = new Date()) {
  await keyResult(db, owner, kr);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PerformanceError("invalid_performance_page");
  const [state, runs, calendar] = await Promise.all([
    rollupState(db, owner, kr),
    db.prepare(`SELECT id,recorded_at,status,origin,result_json FROM kr_metric_rollup_runs WHERE owner_id=? AND kr_item_id=?
      AND (? IS NULL OR recorded_at || '/' || id < ?) ORDER BY recorded_at DESC,id DESC LIMIT ?`)
      .bind(owner, kr, cursor ?? null, cursor ?? null, limit + 1)
      .all<{ id: string; recorded_at: string; status: string; origin: string; result_json: string }>(),
    readMetricCalendar(db, owner),
  ]);
  const page = runs.results.slice(0, limit), next = page.at(-1);
  const data = await compileData(db, owner, kr, await changesFor(db, owner, kr));
  const { through } = rollupOptions({}, now, data, activeTimezone(data, calendar.timezone, now));
  const missing = state ? shiftDate(state.through_date, 1) : data.rules[0]?.effectiveDate;
  const api = data.rules.some(rule => rule.value.source === "api") ? await db.prepare(`SELECT
    last_synced_at AS lastSuccessAt,next_sync_at AS nextScheduledAt,last_sync_status AS status,last_error AS error
    FROM kr_data_connections WHERE owner_id=? AND kr_item_id=?`).bind(owner, kr).first<{
      lastSuccessAt: string | null; nextScheduledAt: string | null; status: string; error: string;
    }>() : null;
  return { lastSuccessAt: state?.last_success_at ?? null, lastScheduledAt: state?.last_scheduled_at ?? null,
    accumulatedThrough: state?.through_date ?? null, expectedThrough: through,
    missingFrom: missing && missing <= through ? missing : null, api,
    nextScheduledAt: new Date((Math.floor(now.getTime() / 900_000) + 1) * 900_000).toISOString(),
    runs: page.map(row => ({ id: row.id, recordedAt: row.recorded_at, status: row.status, origin: row.origin, ...JSON.parse(row.result_json) })),
    nextCursor: runs.results.length > limit && next ? next.recorded_at + "/" + next.id : null };
}

export async function listMetricEntries(db: D1Database, owner: string, id: string, query: Record<string, unknown> = {}, now = new Date()) {
  const state = await readKrPerformance(db, owner, id, query, now);
  const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 100);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new PerformanceError("invalid_performance_page");
  }
  const data = await compileData(db, owner, id, await changesFor(db, owner, id));
  const performance = state.performance;
  const applied = new Map(performance?.records.map(row => [row.id, row]));
  const generated = await postedOccurrences(db, owner, id);
  const candidates = [...new Map([...data.entries, ...generated, ...applied.values()].map(row => [row.id, row])).values()];
  const items = candidates.filter(row =>
    (!query.projectId || row.projectId === query.projectId) &&
    (row.date ? row.date <= state.asOf && (!query.start || row.date >= String(query.start)) && (!query.end || row.date <= String(query.end))
      : query.includeUndated !== false))
    .map(row => ({ ...row, status: "cancelled" in row && row.cancelled ? "cancelled"
      : row.date === null ? "undated" : applied.has(row.id) ? "applied" : "excluded" }))
    .filter(row => !query.status || row.status === query.status)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id));
  return { revision: state.revision, asOf: state.asOf, count: items.length,
    entries: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
}

async function sourceEntry(db: D1Database, owner: string, id: string, key: string) {
  const stored = await db.prepare(`SELECT * FROM kr_performance_changes WHERE owner_id=? AND kr_item_id=?
    AND kind='entry' AND subject_id=? ORDER BY revision DESC LIMIT 1`).bind(owner, id, "source:" + key).first<Stored>();
  if (!stored) throw new PerformanceError("performance_entry_not_found", 404);
  return { stored, value: JSON.parse(stored.value_json) as Entry };
}

export async function reviseMetricEntry(db: D1Database, actor: Actor, id: string, raw: Record<string, unknown>, now = new Date()) {
  requireWriter(actor);
  const sourceKey = textValue(raw.sourceKey, 180), operation = choice(raw.operation, ["correct", "cancel"]);
  const existing = await db.prepare("SELECT request_json,receipt_json FROM kr_performance_changes WHERE owner_id=? AND kr_item_id=? AND request_id=?")
    .bind(actor.ownerId, id, textValue(raw.requestId, 128)).first<Stored>();
  const { stored, value: old } = await sourceEntry(db, actor.ownerId, id, sourceKey);
  const patch = operation === "correct" ? record(raw.entry) : {};
  const occurredOn = Object.hasOwn(patch, "occurredOn") ? patch.occurredOn : old.date;
  const reason = textValue(raw.reason, 1000);
  if (existing) {
    const saved = JSON.parse(existing.request_json);
    if (saved.operation !== operation || saved.reason !== reason || saved.value.sourceKey !== sourceKey ||
      !Object.keys(patch).every(key => key === "occurredOn"
        ? (saved.value.undated ? null : saved.effectiveDate) === patch[key]
        : sameRequest(saved.value[key], patch[key]))) throw new PerformanceError("performance_request_id_reused", 409);
    return JSON.parse(existing.receipt_json);
  }
  const entry = { ...old, ...patch, sourceKey, undated: occurredOn === null, voided: operation === "cancel" };
  return writePerformance(db, actor, id, { kind: "entry", operation, reason,
    effectiveDate: occurredOn ?? stored.effective_date,
    expectedRevision: raw.expectedRevision, requestId: raw.requestId, value: entry }, now);
}

export async function bulkUpsertMetricEntries(db: D1Database, actor: Actor, id: string, raw: Record<string, unknown>, now = new Date()) {
  requireWriter(actor);
  const expected = raw.expectedRevision, batchId = textValue(raw.requestId, 128);
  const reason = textValue(raw.reason ?? "", 1000, true);
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1) throw new PerformanceError("performance_revision_required");
  if (!Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > 100) throw new PerformanceError("invalid_metric_batch");
  const state = await readKrPerformance(db, actor.ownerId, id, { grain: "month" }, now);
  let revision = expected;
  const counts = { inserted: 0, duplicate: 0, corrected: 0, failed: 0 };
  const entries = [];
  for (const [index, input] of raw.entries.entries()) {
    try {
      const value = record(input), sourceKey = textValue(value.sourceKey, 180);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([batchId, index])));
      const requestId = "import:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const correct = value.action === "correct";
      const receipt = correct
        ? await reviseMetricEntry(db, actor, id, { sourceKey, operation: "correct", reason,
          requestId, expectedRevision: revision, entry: value }, now)
        : await writePerformance(db, actor, id, { kind: "entry", requestId, expectedRevision: revision,
          // Preserve a separate date-less record, while using the rule's
          // effective date to validate its unit and source on repeat imports.
          effectiveDate: value.occurredOn === null ? state.performance?.rule.effectiveDate : dateOnly(value.occurredOn),
          reason, value: { ...value, sourceKey, undated: value.occurredOn === null, voided: false } }, now);
      revision = Math.max(revision, receipt.revision);
      const status = correct ? "corrected" : "inserted";
      counts[status]++;
      entries.push({ index, sourceKey, status, receipt });
    } catch (error) {
      const { code } = performanceFailure(error);
      const status = code === "metric_source_key_exists" ? "duplicate" : "failed";
      counts[status]++;
      entries.push({ index, status, code });
    }
  }
  return { revision: Math.max(revision, state.revision), ...counts, entries };
}
