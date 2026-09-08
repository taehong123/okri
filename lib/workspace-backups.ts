// Explicit columns keep credentials and future, unrelated tables out of snapshots.
export const BACKUP_COLUMNS: Record<string, string[]> = Object.fromEntries(Object.entries({
  okr_cycles: "id,owner_id,name,department,version,start_date,end_date,status,created_at,updated_at",
  routine_property_definitions: "id,owner_id,name,type,options,default_value,active,sort_order,created_at,updated_at",
  routines: "id,owner_id,system_key,assignee_member_id,title,description,trigger_point,action_place,action_steps,properties_json,cadence,active,sort_order,created_at,updated_at",
  items: "id,owner_id,cycle_id,parent_id,routine_id,kind,title,description,status,priority,cadence,progress,due_date,source,source_ref,created_by_user_id,sort_order,archived_at,archived_from_status,archive_root_id,created_at,updated_at",
  property_definitions: "id,owner_id,name,type,options,default_value,system_key,active,sort_order,created_at,updated_at",
  project_templates: "id,owner_id,name,description,content,plain_text,created_by_user_id,created_at,updated_at",
  project_documents: "id,owner_id,project_id,content,plain_text,version,updated_by_user_id,created_at,updated_at",
  item_property_values: "id,owner_id,item_id,property_id,value,legacy_value,updated_at",
  project_hidden_properties: "id,owner_id,project_id,property_id,created_at",
  item_assignments: "id,owner_id,item_id,member_id,role,created_at,updated_at",
  checklist_items: "id,owner_id,task_id,title,completed,sort_order,created_at,updated_at",
  routine_completions: "id,owner_id,routine_id,completion_date,note,created_at",
  daily_scrums: "id,owner_id,member_id,scrum_date,yesterday_note,today_note,blockers_note,no_planned_tasks,work_status,skip_reason,skip_note,source,created_at,updated_at,work_selection_json,yesterday_work_selection_json",
  daily_scrum_task_selections: "id,owner_id,daily_scrum_id,member_id,task_id,created_at",
  daily_submissions: "id,owner_id,member_id,member_name,member_email,scrum_date,version,yesterday_note,today_note,blockers_note,no_planned_tasks,work_status,skip_reason,skip_note,source,submitted_at,work_snapshot_json,yesterday_work_snapshot_json,request_id",
  daily_task_snapshots: "id,owner_id,submission_id,task_id,task_title,parent_kind,parent_id,parent_title,status,is_new,sort_order",
}).map(([name, columns]) => [name, columns.split(",")]));

export const BACKUP_TABLES = Object.keys(BACKUP_COLUMNS);
export const BACKUP_RETENTION_DAYS = 30;
const MAX_ROWS = 50_000;
const MAX_BYTES = 8 * 1024 * 1024;
const DAY_MS = 86_400_000;
type Row = Record<string, string | number | null>;
type Tables = Record<string, Row[]>;
export type BackupReason = "daily" | "manual" | "before_cleanup" | "before_okr_delete" | "before_restore";
export type BackupSummary = { cycles: number; objectives: number; keyResults: number; initiatives: number; projects: number; tasks: number; routines: number; documents: number; dailyReports: number };
type Snapshot = { version: 1; workspaceId: string; capturedAt: string; revision: number; tables: Tables };
type Context = { DB: D1Database; WORKSPACE_AVATARS: R2Bucket };
type RecordRow = { id: string; owner_id: string; object_key: string; checksum: string; schema_version: number; reason: BackupReason; byte_size: number; summary: string; created_at: string; expires_at: string };

export class BackupError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

export function backupDay(now = new Date()) {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function summarizeBackup(tables: Tables): BackupSummary {
  const count = (kind: string) => tables.items.filter((row) => row.kind === kind).length;
  return { cycles: tables.okr_cycles.length, objectives: count("objective"), keyResults: count("key_result"), initiatives: count("initiative"), projects: count("project"), tasks: count("task"), routines: tables.routines.length, documents: tables.project_documents.length, dailyReports: tables.daily_scrums.length + tables.daily_submissions.length };
}

function recordSummary(row: RecordRow) {
  return { id: row.id, reason: row.reason, byteSize: row.byte_size, summary: JSON.parse(row.summary) as BackupSummary, createdAt: row.created_at, expiresAt: row.expires_at };
}

export async function listWorkspaceBackups(ctx: Context, ownerId: string, before?: string) {
  const now = new Date().toISOString();
  const records = await ctx.DB.prepare(`SELECT * FROM workspace_backups WHERE owner_id = ? AND status = 'ready'
    AND expires_at > ? AND (? IS NULL OR created_at < ?) ORDER BY created_at DESC LIMIT 51`)
    .bind(ownerId, now, before ?? null, before ?? null).all<RecordRow>();
  const state = await ctx.DB.prepare("SELECT last_success_at, last_daily_date, last_attempt_at, last_error FROM workspace_backup_state WHERE owner_id = ?").bind(ownerId).first();
  return { backups: records.results.slice(0, 50).map(recordSummary), nextCursor: records.results.length > 50 ? records.results[49].created_at : null, state, retentionDays: BACKUP_RETENTION_DAYS, timezone: "Asia/Seoul" };
}

async function lease(ctx: Context, ownerId: string) {
  if (!ctx.WORKSPACE_AVATARS) throw new BackupError("storage_unavailable", "백업 저장소를 사용할 수 없습니다.", 503);
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  await ctx.DB.prepare("INSERT INTO workspace_backup_state (owner_id) VALUES (?) ON CONFLICT(owner_id) DO NOTHING").bind(ownerId).run();
  const result = await ctx.DB.prepare(`UPDATE workspace_backup_state SET lease_token = ?, lease_until = ?, last_attempt_at = ?
    WHERE owner_id = ? AND (lease_until IS NULL OR lease_until < ?)`)
    .bind(token, new Date(Date.now() + 600_000).toISOString(), now, ownerId, now).run();
  if (!result.meta.changes) throw new BackupError("backup_busy", "다른 백업 또는 복원이 진행 중입니다. 잠시 후 다시 시도해 주세요.");
  return token;
}

async function release(ctx: Context, ownerId: string, token: string, error?: unknown) {
  await ctx.DB.prepare(`UPDATE workspace_backup_state SET lease_token = NULL, lease_until = NULL, last_error = ?
    WHERE owner_id = ? AND lease_token = ?`).bind(error ? (error instanceof BackupError ? error.message : "백업 작업을 완료하지 못했습니다. 다시 시도해 주세요.") : null, ownerId, token).run();
}

async function capture(ctx: Context, ownerId: string): Promise<Snapshot> {
  // D1 batch is a single transaction: every table and revision is from one point in time.
  const results = await ctx.DB.batch<Row>([
    ctx.DB.prepare("SELECT id FROM workspaces WHERE id = ? AND scheduled_deletion_at IS NULL").bind(ownerId),
    ctx.DB.prepare("SELECT revision FROM workspace_backup_state WHERE owner_id = ?").bind(ownerId),
    ...BACKUP_TABLES.map((table) => ctx.DB.prepare(`SELECT ${BACKUP_COLUMNS[table].join(",")} FROM ${table} WHERE owner_id = ? ORDER BY id LIMIT ?`).bind(ownerId, MAX_ROWS + 1)),
  ]);
  if (!results[0].results.length) throw new BackupError("workspace_unavailable", "사용할 수 없는 워크스페이스입니다.", 404);
  const tables = Object.fromEntries(BACKUP_TABLES.map((table, index) => [table, results[index + 2].results]));
  if (Object.values(tables).some((rows) => rows.length > MAX_ROWS)) throw new BackupError("backup_too_large", "백업 용량 한도를 초과했습니다. 관리자에게 문의해 주세요.", 413);
  return { version: 1, workspaceId: ownerId, capturedAt: new Date().toISOString(), revision: Number(results[1].results[0]?.revision ?? 0), tables };
}

async function checksum(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function persist(ctx: Context, snapshot: Snapshot, reason: BackupReason, userId: string | null) {
  const payload = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(payload);
  if (bytes.length > MAX_BYTES) throw new BackupError("backup_too_large", "백업 용량 한도를 초과했습니다. 관리자에게 문의해 주세요.", 413);
  const id = crypto.randomUUID();
  const key = `workspace-backups/v1/${encodeURIComponent(snapshot.workspaceId)}/${id}.json`;
  const hash = await checksum(payload);
  const expiresAt = new Date(Date.parse(snapshot.capturedAt) + BACKUP_RETENTION_DAYS * DAY_MS).toISOString();
  const summary = summarizeBackup(snapshot.tables);
  // Keep pending metadata so interrupted uploads can be found and removed later.
  await ctx.DB.prepare(`INSERT INTO workspace_backups
    (id, owner_id, object_key, reason, status, checksum, byte_size, summary, created_by_user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
    .bind(id, snapshot.workspaceId, key, reason, hash, bytes.length, JSON.stringify(summary), userId, snapshot.capturedAt, expiresAt).run();
  await ctx.WORKSPACE_AVATARS.put(key, bytes, { httpMetadata: { contentType: "application/json" } });
  // A failed read-back must never turn into a restorable backup or permit destructive work.
  const verified = await ctx.WORKSPACE_AVATARS.get(key);
  if (!verified || await checksum(await verified.text()) !== hash) throw new BackupError("backup_verification_failed", "백업 저장 검증에 실패했습니다. 원본 데이터는 변경하지 않았습니다.", 503);
  await ctx.DB.batch([
    ctx.DB.prepare("UPDATE workspace_backups SET status = 'ready' WHERE id = ? AND owner_id = ?").bind(id, snapshot.workspaceId),
    ctx.DB.prepare(`UPDATE workspace_backup_state SET last_success_at = ?, last_error = NULL,
      last_daily_date = CASE WHEN ? = 'daily' THEN ? ELSE last_daily_date END WHERE owner_id = ?`)
      .bind(snapshot.capturedAt, reason, backupDay(new Date(snapshot.capturedAt)), snapshot.workspaceId),
  ]);
  return { id, reason, createdAt: snapshot.capturedAt, expiresAt, summary, byteSize: bytes.length };
}

export async function createWorkspaceBackup(ctx: Context, ownerId: string, reason: BackupReason, userId: string | null = null) {
  const token = await lease(ctx, ownerId);
  try {
    if (reason === "daily") {
      const state = await ctx.DB.prepare("SELECT last_daily_date FROM workspace_backup_state WHERE owner_id = ?").bind(ownerId).first<{ last_daily_date: string | null }>();
      if (state?.last_daily_date === backupDay()) return null;
    }
    if (reason === "manual") {
      const recent = await ctx.DB.prepare("SELECT id FROM workspace_backups WHERE owner_id = ? AND reason = 'manual' AND status = 'ready' AND created_at > ? LIMIT 1")
        .bind(ownerId, new Date(Date.now() - 60_000).toISOString()).first();
      if (recent) throw new BackupError("rate_limited", "수동 백업은 1분에 한 번 만들 수 있습니다.", 429);
    }
    return await persist(ctx, await capture(ctx, ownerId), reason, userId);
  } catch (error) { await release(ctx, ownerId, token, error); throw error; }
  finally { await release(ctx, ownerId, token); }
}

export function validateSnapshot(value: unknown, ownerId: string): Snapshot {
  const data = value as Snapshot;
  if (!data || data.version !== 1 || data.workspaceId !== ownerId || !data.tables || !Number.isSafeInteger(data.revision)) throw new BackupError("invalid_backup", "현재 워크스페이스에서 복원할 수 없는 백업입니다.");
  // Older signed snapshots predate routine custom fields. Preserve restore compatibility.
  if (!("routine_property_definitions" in data.tables)) {
    data.tables.routine_property_definitions = [];
    if (Array.isArray(data.tables.routines)) data.tables.routines = data.tables.routines.map((row) => ({ properties_json: "{}", ...row }));
  }
  if (Array.isArray(data.tables.daily_scrums)) data.tables.daily_scrums = data.tables.daily_scrums.map((row) => ({ work_selection_json: "[]", yesterday_work_selection_json: "[]", work_status: "office", ...row }));
  if (Array.isArray(data.tables.daily_submissions)) data.tables.daily_submissions = data.tables.daily_submissions.map((row) => ({ work_snapshot_json: "[]", yesterday_work_snapshot_json: "[]", request_id: null, work_status: "office", ...row }));
  for (const table of BACKUP_TABLES) {
    const rows = data.tables[table];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new BackupError("invalid_backup", "백업 데이터가 완전하지 않습니다.");
    const ids = new Set();
    for (const row of rows) {
      if (!row || row.owner_id !== ownerId || typeof row.id !== "string" || !row.id || ids.has(row.id)
        || Object.keys(row).some((column) => !BACKUP_COLUMNS[table].includes(column))
        || BACKUP_COLUMNS[table].some((column) => !(column in row))
        || Object.values(row).some((v) => v !== null && typeof v !== "string" && typeof v !== "number")) throw new BackupError("invalid_backup", "백업 데이터 검증에 실패했습니다.");
      ids.add(row.id);
    }
  }
  if (Object.keys(data.tables).some((table) => !BACKUP_TABLES.includes(table))) throw new BackupError("invalid_backup", "지원하지 않는 백업 형식입니다.");
  return data;
}

async function readSnapshot(ctx: Context, ownerId: string, id: string) {
  const record = await ctx.DB.prepare("SELECT * FROM workspace_backups WHERE id = ? AND owner_id = ? AND status = 'ready' AND expires_at > ?")
    .bind(id, ownerId, new Date().toISOString()).first<RecordRow>();
  if (!record) throw new BackupError("backup_not_found", "백업이 없거나 보관 기간이 지났습니다.", 404);
  if (record.schema_version !== 1 || record.byte_size > MAX_BYTES || record.object_key !== `workspace-backups/v1/${encodeURIComponent(ownerId)}/${id}.json`) throw new BackupError("invalid_backup", "지원하지 않는 백업입니다.");
  const object = await ctx.WORKSPACE_AVATARS.get(record.object_key);
  if (!object || object.size > MAX_BYTES) throw new BackupError("backup_unavailable", "백업 파일을 불러올 수 없습니다.", 503);
  const payload = await object.text();
  if (await checksum(payload) !== record.checksum) throw new BackupError("invalid_backup", "백업 무결성 검사에 실패했습니다. 복원을 중단했습니다.");
  return { record, snapshot: validateSnapshot(JSON.parse(payload), ownerId) };
}

export async function previewWorkspaceBackup(ctx: Context, ownerId: string, id: string) {
  const { record, snapshot } = await readSnapshot(ctx, ownerId, id);
  return { ...recordSummary(record), cycles: snapshot.tables.okr_cycles.map((row) => ({ id: row.id, name: row.name, version: row.version, startDate: row.start_date, endDate: row.end_date })), projects: snapshot.tables.items.filter((row) => row.kind === "project").slice(0, 100).map((row) => ({ id: row.id, title: row.title, status: row.status })), current: summarizeBackup((await capture(ctx, ownerId)).tables) };
}

function insertRows(db: D1Database, table: string, columns: string[], rows: Row[], conflict = "") {
  const batches: string[] = [];
  let chunk: Row[] = [];
  let size = 0;
  for (const row of rows) {
    const length = new TextEncoder().encode(JSON.stringify(row)).length;
    if (length > 1_500_000) throw new BackupError("row_too_large", "일부 문서가 복원 용량 한도를 초과했습니다.", 413);
    if (size + length > 256_000 && chunk.length) { batches.push(JSON.stringify(chunk)); chunk = []; size = 0; }
    chunk.push(row); size += length;
  }
  if (chunk.length) batches.push(JSON.stringify(chunk));
  return batches.map((json) => db.prepare(`INSERT INTO ${table} (${columns.join(",")}) SELECT ${columns.map((column) => `json_extract(value, '$.${column}')`).join(",")} FROM json_each(?) WHERE true ${conflict}`).bind(json));
}

// These are live foreign-key mappings, never stored in the historical snapshot.
const LIVE_LINKS = [
  { table: "google_calendar_events", ref: "item_id", target: "items" },
  { table: "kr_data_connections", ref: "kr_item_id", target: "items" },
  { table: "slack_daily_publications", ref: "submission_id", target: "daily_submissions" },
  { table: "slack_automation_deliveries", ref: "item_id", target: "items" },
];

export async function restoreWorkspaceBackup(ctx: Context, ownerId: string, id: string, userId: string) {
  const token = await lease(ctx, ownerId);
  try {
    const { snapshot } = await readSnapshot(ctx, ownerId, id);
    const current = await capture(ctx, ownerId);
    const rollback = await persist(ctx, current, "before_restore", userId);
    const live = await ctx.DB.batch<Row>([
      ctx.DB.prepare("SELECT id, status FROM workspace_members WHERE workspace_id = ?").bind(ownerId),
      ...LIVE_LINKS.map(({ table }) => ctx.DB.prepare(`SELECT * FROM ${table} WHERE owner_id = ?`).bind(ownerId)),
      ctx.DB.prepare("SELECT table_name, row_id, payload FROM workspace_restore_links WHERE owner_id = ? AND expires_at > ?").bind(ownerId, new Date().toISOString()),
      ctx.DB.prepare("SELECT id, user_id FROM google_connections WHERE owner_id = ?").bind(ownerId),
    ]);
    const savedLinks = live[LIVE_LINKS.length + 1].results;
    const googleConnections = new Map(live[LIVE_LINKS.length + 2].results.map((r) => [r.user_id, r.id]));
    const members = new Set(live[0].results.filter((r) => r.status === "active").map((r) => r.id));
    const tables = structuredClone(snapshot.tables);
    let removedAssignments = 0;
    for (const table of ["item_assignments", "daily_scrum_task_selections"]) {
      const prior = tables[table].length;
      tables[table] = tables[table].filter((r) => members.has(r.member_id));
      removedAssignments += prior - tables[table].length;
    }
    // Never resurrect former memberships, even when historical rows reference them.
    tables.daily_scrums = tables.daily_scrums.filter((r) => r.member_id === null || members.has(r.member_id));
    const scrumIds = new Set(tables.daily_scrums.map((r) => r.id));
    tables.daily_scrum_task_selections = tables.daily_scrum_task_selections.filter((r) => scrumIds.has(r.daily_scrum_id));
    for (const row of tables.daily_submissions) if (!members.has(row.member_id)) row.member_id = null;
    for (const row of tables.routines) if (!members.has(row.assignee_member_id)) row.assignee_member_id = null;
    const versions = new Map(current.tables.project_documents.map((r) => [r.project_id, Number(r.version)]));
    for (const row of tables.project_documents) row.version = Math.max(Number(row.version), versions.get(row.project_id) ?? 0) + 1;
    const guardId = crypto.randomUUID();
    // CHECK failure rolls back the whole D1 batch if any business data changed after capture.
    const statements = [ctx.DB.prepare(`INSERT INTO workspace_backup_guards (id, verified) VALUES (?,
      EXISTS(SELECT 1 FROM workspace_backup_state WHERE owner_id = ? AND revision = ? AND lease_token = ? AND lease_until > ?)
      AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active' AND role IN ('owner','admin'))
      AND EXISTS(SELECT 1 FROM workspaces WHERE id = ? AND scheduled_deletion_at IS NULL))`)
      .bind(guardId, ownerId, current.revision, token, new Date().toISOString(), ownerId, userId, ownerId)];
    const detachedUntil = new Date(Date.now() + BACKUP_RETENTION_DAYS * DAY_MS).toISOString();
    for (const [index, link] of LIVE_LINKS.entries()) {
      const validIds = new Set(tables[link.target].map((r) => r.id));
      const detached = live[index + 1].results.filter((r) => r[link.ref] !== null && !validIds.has(r[link.ref])).map((r) => ({
        owner_id: ownerId, table_name: link.table, row_id: r.id,
        payload: JSON.stringify({ row: r, connectionId: link.table === "google_calendar_events" ? googleConnections.get(r.user_id) ?? null : null }), expires_at: detachedUntil,
      }));
      statements.push(...insertRows(ctx.DB, "workspace_restore_links", ["owner_id", "table_name", "row_id", "payload", "expires_at"], detached,
        "ON CONFLICT(owner_id, table_name, row_id) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at"));
    }
    for (const table of [...BACKUP_TABLES].reverse()) statements.push(ctx.DB.prepare(`DELETE FROM ${table} WHERE owner_id = ?`).bind(ownerId));
    for (const table of BACKUP_TABLES) statements.push(...insertRows(ctx.DB, table, BACKUP_COLUMNS[table], tables[table]));
    for (const [index, link] of LIVE_LINKS.entries()) {
      const validIds = new Set(tables[link.target].map((r) => r.id));
      const rowsById = new Map<string | number | null, Row>();
      const discardedIds: Array<string | number | null> = [];
      const liveRows = live[index + 1].results;
      const naturalKey = (row: Row) => link.table === "google_calendar_events" ? `${row.user_id}:${row.item_id}`
        : link.table === "kr_data_connections" ? String(row.kr_item_id)
          : link.table === "slack_daily_publications" ? `${row.submission_id}:${row.channel_id}` : String(row.id);
      const currentKeys = new Set(liveRows.filter((r) => r[link.ref] !== null).map(naturalKey));
      for (const saved of savedLinks.filter((r) => r.table_name === link.table)) {
        const entry = JSON.parse(String(saved.payload)) as { row: Row; connectionId: string | null };
        if (entry.row.owner_id !== ownerId || !validIds.has(entry.row[link.ref])) continue;
        if (currentKeys.has(naturalKey(entry.row))) { discardedIds.push(saved.row_id); continue; }
        if (link.table === "google_calendar_events" && (!entry.connectionId || googleConnections.get(entry.row.user_id) !== entry.connectionId)) { discardedIds.push(saved.row_id); continue; }
        if (link.table === "slack_daily_publications" && !members.has(entry.row.member_id)) entry.row.member_id = null;
        rowsById.set(entry.row.id, entry.row);
      }
      // Live rows win over detached copies; never rewind external messages or sync state.
      for (const row of liveRows) if (validIds.has(row[link.ref])) rowsById.set(row.id, row);
      const rows = [...rowsById.values()];
      if (link.table === "slack_automation_deliveries") {
        for (let offset = 0; offset < rows.length; offset += 100) {
          const chunk = JSON.stringify(rows.slice(offset, offset + 100).map((r) => ({ id: r.id, item_id: r.item_id })));
          statements.push(ctx.DB.prepare(`UPDATE slack_automation_deliveries SET item_id =
            (SELECT json_extract(value, '$.item_id') FROM json_each(?) WHERE json_extract(value, '$.id') = slack_automation_deliveries.id)
            WHERE owner_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`).bind(chunk, ownerId, chunk));
        }
      } else if (rows.length) statements.push(...insertRows(ctx.DB, link.table, Object.keys(rows[0]), rows));
      const attachedIds = JSON.stringify([...rows.map((r) => r.id), ...discardedIds]);
      statements.push(ctx.DB.prepare("DELETE FROM workspace_restore_links WHERE owner_id = ? AND table_name = ? AND row_id IN (SELECT value FROM json_each(?))").bind(ownerId, link.table, attachedIds));
    }
    statements.push(ctx.DB.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload)
      VALUES (?, ?, ?, 'workspace_restored', 'web', ?)`)
      .bind(crypto.randomUUID(), ownerId, ownerId, JSON.stringify({ backupId: id, rollbackBackupId: rollback.id, restoredBy: userId, removedAssignments })));
    statements.push(ctx.DB.prepare("DELETE FROM workspace_backup_guards WHERE id = ?").bind(guardId));
    if (statements.length > 800) throw new BackupError("restore_too_large", "복원할 데이터가 처리 한도를 초과했습니다. 원본은 변경하지 않았습니다.", 413);
    try { await ctx.DB.batch(statements); }
    catch (error) {
      if (String(error).includes("workspace_backup_guard_verified")) throw new BackupError("workspace_changed", "다른 사용자가 데이터를 변경했거나 권한이 바뀌어 복원을 중단했습니다. 미리보기를 확인하고 다시 시도해 주세요.");
      throw error;
    }
    return { restored: true, rollbackBackupId: rollback.id, removedAssignments };
  } catch (error) { await release(ctx, ownerId, token, error); throw error; }
  finally { await release(ctx, ownerId, token); }
}

export async function purgeExpiredBackups(ctx: Context, now = new Date()) {
  await ctx.DB.prepare("DELETE FROM workspace_restore_links WHERE expires_at <= ?").bind(now.toISOString()).run();
  const expired = await ctx.DB.prepare(`SELECT id, object_key FROM workspace_backups WHERE expires_at <= ?
    OR (status = 'pending' AND created_at < ?) OR NOT EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = workspace_backups.owner_id)
    ORDER BY expires_at LIMIT 100`).bind(now.toISOString(), new Date(now.getTime() - DAY_MS).toISOString()).all<{ id: string; object_key: string }>();
  for (const row of expired.results) {
    await ctx.WORKSPACE_AVATARS.delete(row.object_key);
    await ctx.DB.prepare("DELETE FROM workspace_backups WHERE id = ?").bind(row.id).run();
  }
  return expired.results.length;
}

export async function runDueWorkspaceBackups(ctx: Context) {
  if (!ctx.WORKSPACE_AVATARS) throw new BackupError("storage_unavailable", "Backup storage is unavailable", 503);
  await purgeExpiredBackups(ctx);
  const now = new Date();
  const due = await ctx.DB.prepare(`SELECT w.id FROM workspaces w LEFT JOIN workspace_backup_state s ON s.owner_id = w.id
    WHERE w.scheduled_deletion_at IS NULL AND (s.last_daily_date IS NULL OR s.last_daily_date < ?)
      AND (s.lease_until IS NULL OR s.lease_until < ?)
      AND (s.last_error IS NULL OR s.last_attempt_at < ?)
    ORDER BY COALESCE(s.last_daily_date, ''), w.id LIMIT 10`)
    .bind(backupDay(now), now.toISOString(), new Date(now.getTime() - 3_600_000).toISOString()).all<{ id: string }>();
  let completed = 0;
  let failed = 0;
  for (const workspace of due.results) {
    try { if (await createWorkspaceBackup(ctx, workspace.id, "daily")) completed++; }
    catch { failed++; }
  }
  return { completed, failed };
}
