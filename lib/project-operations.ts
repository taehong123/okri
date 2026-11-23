import { dateOnly, localDate, shiftDate } from "./project-metric-schedule-model";
import { operationsInput, PerformanceError, ruleAt, textValue, validateRange,
  type ProjectOperations, type Version } from "./kr-performance-model";

type OperationRow = {
  id: string; project_id: string; revision: number; effective_date: string; recorded_at: string;
  actor_id: string; reason: string; value_json: string; receipt_json: string;
};

export async function operationHistory(db: D1Database, owner: string, ids: string[]) {
  const result = new Map<string, (Version<ProjectOperations> & { id: string })[]>();
  if (!ids.length) return result;
  const rows = (await db.prepare(`SELECT * FROM project_operation_versions WHERE owner_id=?
    AND project_id IN (SELECT value FROM json_each(?)) ORDER BY effective_date, revision`)
    .bind(owner, JSON.stringify(ids)).all<OperationRow>()).results;
  for (const row of rows) {
    const history = result.get(row.project_id) ?? [];
    history.push({ id: row.id, revision: row.revision, effectiveDate: row.effective_date,
      recordedAt: row.recorded_at, value: JSON.parse(row.value_json) as ProjectOperations });
    result.set(row.project_id, history);
  }
  return result;
}

export async function listProjectOperations(db: D1Database, owner: string, timezone: string,
  query: { projectId?: string; asOf?: string; cursor?: string; limit?: number }, now = new Date()) {
  const today = localDate(now, timezone), asOf = query.asOf ? dateOnly(query.asOf) : today;
  validateRange(asOf, asOf);
  if (asOf > today) throw new PerformanceError("future_performance_date");
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PerformanceError("invalid_performance_page");
  const projects = (await db.prepare(`SELECT id,title,status AS buildStatus FROM items
    WHERE owner_id=? AND kind='project' AND archived_at IS NULL AND (? IS NULL OR id=?) AND id>? ORDER BY id LIMIT ?`)
    .bind(owner, query.projectId ?? null, query.projectId ?? null, query.cursor ?? "", limit + 1)
    .all<{ id: string; title: string; buildStatus: string }>()).results;
  const page = projects.slice(0, limit);
  const operations = await operationHistory(db, owner, page.map(row => row.id));
  const items = page.map(project => {
    const versions = operations.get(project.id) ?? [];
    const active = ruleAt(versions, asOf);
    const value = active?.value ?? null;
    const freshness = (date: string | null | undefined) => !date ? "missing" :
      date < shiftDate(asOf, -(value?.reviewAfterDays ?? 30)) ? "stale" : "recent";
    return { ...project, revision: Math.max(0, ...versions.map(v => v.revision)), operations: value,
      effectiveDate: active?.effectiveDate ?? null, operationEvidence: freshness(value?.lastOperationCheck),
      useEvidence: freshness(value?.lastUseCheck), confirmationNeeded: !value || value.status === "needs_confirmation" ||
        freshness(value.lastOperationCheck) !== "recent" || freshness(value.lastUseCheck) !== "recent" };
  });
  return { asOf, items, nextCursor: projects.length > limit ? page.at(-1)!.id : null };
}

export async function writeProjectOperations(db: D1Database, actor: { ownerId: string; userId: string; role: string; oauthScopes?: string },
  project: string, raw: { effectiveDate?: unknown; expectedRevision?: unknown; requestId?: unknown; reason?: unknown; value?: unknown },
  timezone: string, now = new Date()) {
  if (actor.role === "viewer" || actor.oauthScopes !== undefined && !actor.oauthScopes.split(/\s+/).includes("okri:write")) {
    throw new PerformanceError("write_access_required", 403);
  }
  const { ownerId: owner } = actor, today = localDate(now, timezone), effectiveDate = dateOnly(raw.effectiveDate);
  validateRange(effectiveDate, effectiveDate);
  const reason = textValue(raw.reason ?? "", 1000, true), requestId = textValue(raw.requestId, 128);
  const expected = raw.expectedRevision;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) throw new PerformanceError("performance_revision_required");
  const value = operationsInput(raw.value, today);
  const find = () => db.prepare(`SELECT * FROM project_operation_versions WHERE owner_id=? AND project_id=? AND request_id=?`)
    .bind(owner, project, requestId).first<OperationRow>();
  const replay = (row: OperationRow) => {
    if (row.value_json !== JSON.stringify(value) || row.effective_date !== effectiveDate || row.reason !== reason) {
      throw new PerformanceError("performance_request_id_reused", 409);
    }
    return JSON.parse(row.receipt_json);
  };
  const existing = await find();
  if (existing) return replay(existing);
  if (!await db.prepare("SELECT 1 FROM items WHERE owner_id=? AND id=? AND kind='project' AND archived_at IS NULL").bind(owner, project).first()) {
    throw new PerformanceError("project_not_found", 404);
  }
  if (effectiveDate < today && !reason) throw new PerformanceError("performance_correction_reason_required");
  const versions = (await operationHistory(db, owner, [project])).get(project) ?? [];
  const recordedAt = now.toISOString();
  const next = versions.find(v => v.effectiveDate > effectiveDate);
  const receipt = { projectId: project, revision: expected + 1, recordedAt, effectiveDate,
    before: ruleAt(versions, effectiveDate)?.value ?? null, after: value,
    affected: { from: effectiveDate, through: next ? shiftDate(next.effectiveDate, -1) : null } };
  const inserted = await db.prepare(`INSERT INTO project_operation_versions
    (id,owner_id,project_id,revision,request_id,effective_date,recorded_at,actor_id,reason,value_json,receipt_json)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE coalesce((SELECT max(revision) FROM project_operation_versions WHERE owner_id=? AND project_id=?),0)=?
    AND EXISTS(SELECT 1 FROM items WHERE owner_id=? AND id=? AND kind='project' AND archived_at IS NULL)`)
    .bind(crypto.randomUUID(), owner, project, expected + 1, requestId, effectiveDate, recordedAt, actor.userId, reason,
      JSON.stringify(value), JSON.stringify(receipt), owner, project, expected, owner, project).run();
  if (inserted.meta.changes) return receipt;
  const competing = await find();
  if (competing) return replay(competing);
  throw new PerformanceError("performance_revision_conflict", 409);
}
