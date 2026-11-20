import { readMetricCalendar } from "./project-metric-schedules";
import { dateOnly, localDate, ScheduleError, shiftDate } from "./project-metric-schedule-model";
import { aggregatePerformance, amount, bool, choice, evaluationRange, PerformanceError, projectRuleInput, record, ruleAt,
  ruleInput, textValue, validateRange, type ApiSample, type Data, type Entry, type Grain, type MeasurementRule, type ProjectRule, type Version } from "./kr-performance-model";

type Actor = { ownerId: string; userId: string; role: string; oauthScopes?: string };
type ChangeKind = "rule" | "project" | "entry";
type Stored = {
  revision: number; kind: ChangeKind; subject_id: string; effective_date: string; recorded_at: string;
  actor_id: string; reason: string; value_json: string; request_json: string; receipt_json: string; request_id: string;
};
type RuleValue = { rule: MeasurementRule; adopted?: { projectId: string; value: ProjectRule }[] };
type Context = { id: string; title: string };
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

function requireWriter(actor: Actor) {
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

export async function readProjectPeriodContribution(db: D1Database, owner: string, krId: string, projectId: string) {
  if (!await hasPerformanceRule(db, owner, krId)) return null;
  const state = await readKrPerformance(db, owner, krId, { grain: "month" });
  const result = state.performance;
  if (!result) return null;
  const version = ruleAt(state.configuration.projects.filter(project => project.projectId === projectId), state.asOf);
  const contribution = result.current.projectBreakdown.find(project => project.projectId === projectId);
  return { start: result.evaluation.start, end: result.evaluation.end, unit: result.rule.value.unit,
    value: contribution?.value ?? 0, isEstimate: Boolean(contribution && contribution.estimatedValue !== 0),
    operating: version?.value.operating ?? null };
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
      if (value.voided) entries.delete(row.subject_id);
      else entries.set(row.subject_id, { ...value, id: row.subject_id, recordedAt: row.recorded_at });
    }
  }
  const samples = rules.some(rule => rule.value.source === "api")
    ? (await db.prepare(`SELECT id,observed_at AS observedAt,current_value AS value,unit FROM kr_metric_observations
        WHERE owner_id=? AND kr_item_id=? AND source='api' AND event_kind='synced' AND current_value IS NOT NULL
        AND observed_at >= ? ORDER BY observed_at,id LIMIT 50001`)
      .bind(owner, id, shiftDate(timeline(rules)[0].effectiveDate, -2)).all<ApiSample>()).results
    : [];
  if (samples.length > 50000) throw new PerformanceError("performance_sample_limit", 422);
  const stops = projects.length ? (await db.prepare(`SELECT project_id AS projectId, recorded_at AS recordedAt
      FROM kr_performance_stops WHERE owner_id=? AND kr_item_id=? ORDER BY recorded_at,id`)
    .bind(owner, id).all<Data["stops"][number]>()).results : [];
  return { rules: timeline(rules), projects: timeline(projects), entries: [...entries.values()], samples, stops };
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
  const timezone = data.rules[0]?.value.timezone ?? calendar.timezone;
  const options = dateOptions(raw, timezone, now);
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
  const timezone = oldData.rules[0]?.value.timezone ?? calendar.timezone;
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
    if (!effectiveRule || effectiveRule.source === "api") throw new PerformanceError("manual_performance_rule_required", 409);
    const entry = record(input.value);
    const projectId = effectiveRule.source === "projects" ? textValue(entry.projectId, 128) : null;
    subject = projectId ? projectId + "/" + effectiveDate : textValue(input.subjectId, 128);
    const previous = oldData.entries.find(row => row.id === subject);
    priorDate = previous?.date;
    before = previous ?? null;
    const voided = bool(entry.voided, false);
    if ((previous || voided) && !reason) throw new PerformanceError("performance_correction_reason_required");
    if (voided && !previous) throw new PerformanceError("performance_entry_not_found", 404);
    let title = previous?.title ?? null;
    if (projectId && !previous) {
      const prior = aggregatePerformance(oldData, { asOf: today, range: { start: effectiveDate, end: effectiveDate },
        grain: "day", includeEstimates: true }, now)?.records.find(row => row.projectId === projectId);
      if (prior) {
        before = prior;
        title = prior.title;
      } else {
        const project = await currentProjectKr(db, actor.ownerId, projectId);
        if (project.keyResultId !== id) throw new PerformanceError("project_not_linked_to_kr", 404);
        title = project.title;
        linkedProject = projectId;
      }
    }
    value = { date: effectiveDate, value: voided ? previous!.value : amount(entry.value), basis: textValue(entry.basis, 1000),
      isEstimate: bool(entry.isEstimate, false), unit: effectiveRule.unit, input: effectiveRule.input, source: effectiveRule.source,
      projectId, title, voided };
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
  const periods = affectedPeriods(newData, from, appliesUntil, today);
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

export async function listPerformanceSummaries(db: D1Database, owner: string, now = new Date()) {
  const ids = await db.prepare(`SELECT DISTINCT c.kr_item_id AS id FROM kr_performance_changes c
    JOIN items i ON i.id=c.kr_item_id AND i.owner_id=c.owner_id AND i.archived_at IS NULL
    WHERE c.owner_id=? AND c.kind='rule'`).bind(owner).all<{ id: string }>();
  return Promise.all(ids.results.map(async ({ id }) => {
    const state = await readKrPerformance(db, owner, id, { grain: "day", recent: true }, now);
    const p = state.performance;
    return p ? { keyResultId: id, performance: true as const, mode: p.rule.value.source,
      currentValue: p.current.value, targetValue: p.rule.value.target, progress: p.current.progress ?? 0,
      unit: p.rule.value.unit, isEstimate: p.current.hasEstimates, trend: p.points } : null;
  }));
}
