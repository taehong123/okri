import { env, waitUntil } from "cloudflare:workers";
import { getSlackConnection, dispatchSlackAutomationEvent, type RequestAuthorization } from "./pace-data";
import { memberCanWrite } from "./billing";
import { slackApi, slackTokenForConnection } from "./slack-daily";
import type { Translator } from "./server-language";
import { choicesFor, editableManagementProperties, initialManagementValues, managementEditorView, ManagementFieldError, parseManagementValues,
  type ManagementDraft, type ManagementSnapshot, type ManagementState } from "./slack-management-editor";

type Actor = { authorization: RequestAuthorization; memberId: string; teamId: string; slackUserId: string };
type Operation = { request_id: string; target_id: string; status: string; result_json: string; created_at: string };
type Saved = { draft: ManagementDraft; savedAt?: string; values?: ReturnType<typeof parseManagementValues>; statusChanged?: boolean };

// This canonical, scoped snapshot is both the edit baseline and the batch guard.
// Include property definitions and memberships: a rename, removed option, revoked
// assignee, archive or another edit must not be overwritten by a stale Slack form.
export const managementSnapshotSql = `WITH scope AS (SELECT ? AS ownerId, ? AS itemId)
  SELECT json_object(
    'parentProjectId', (SELECT p.id FROM items i JOIN items p ON p.id=i.parent_id AND p.owner_id=i.owner_id, scope s
      WHERE i.owner_id=s.ownerId AND i.id=s.itemId AND p.kind='project' AND p.archived_at IS NULL AND p.status!='archived'),
    'item', json((SELECT json_object('id', i.id, 'kind', i.kind, 'title', i.title, 'parent_id', i.parent_id,
      'status', i.status, 'priority', i.priority, 'progress', i.progress, 'due_date', i.due_date,
      'archived_at', i.archived_at, 'updated_at', i.updated_at) FROM items i, scope s
      WHERE i.owner_id=s.ownerId AND i.id=s.itemId AND i.kind IN ('project','task') AND i.archived_at IS NULL AND i.status!='archived')),
    'assignments', json((SELECT json_group_array(json_object('id',id,'role',role,'member_id',member_id,'updated_at',updated_at))
      FROM (SELECT a.* FROM item_assignments a, scope s WHERE a.owner_id=s.ownerId AND a.item_id=s.itemId ORDER BY a.id))),
    'members', json((SELECT json_group_array(json_object('id',id,'display_name',display_name,'role',role,'status',status,'user_id',user_id,'updated_at',updated_at))
      FROM (SELECT m.* FROM workspace_members m, scope s WHERE m.workspace_id=s.ownerId ORDER BY m.id))),
    'definitions', json((SELECT json_group_array(json_object('id',id,'name',name,'type',type,'options',options,'system_key',system_key,'active',active,'updated_at',updated_at))
      FROM (SELECT p.* FROM property_definitions p, scope s WHERE p.owner_id=s.ownerId ORDER BY p.sort_order,p.id))),
    'values', json((SELECT json_group_array(json_object('property_id',property_id,'value',value,'updated_at',updated_at))
      FROM (SELECT v.* FROM item_property_values v, scope s WHERE v.owner_id=s.ownerId AND v.item_id=s.itemId ORDER BY v.property_id)))
  ) AS snapshot`;

const actorGuardSql = `SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
  JOIN slack_member_links l ON l.owner_id=m.workspace_id AND l.member_id=m.id
  JOIN slack_connections c ON c.owner_id=l.owner_id AND c.team_id=l.team_id
  WHERE m.workspace_id=? AND m.id=? AND m.status='active' AND m.role IN ('owner','admin','member')
    AND l.team_id=? AND l.slack_user_id=? AND w.scheduled_deletion_at IS NULL`;
function actorArgs(actor: Actor) { return [actor.authorization.ownerId, actor.memberId, actor.teamId, actor.slackUserId]; }
async function assertWriter(actor: Actor) {
  const { authorization: auth } = actor;
  if (auth.role === "viewer" || !await env.DB.prepare(actorGuardSql).bind(...actorArgs(actor)).first()
    || !await memberCanWrite(auth.ownerId, auth.userId, auth.role)) throw new Error("이 업무를 수정할 권한이 없습니다.");
}
export async function readManagementSnapshot(db: D1Database, ownerId: string, itemId: string) {
  const row = await db.prepare(managementSnapshotSql).bind(ownerId, itemId).first<{ snapshot: string }>();
  if (!row || !JSON.parse(row.snapshot).item) throw new Error("업무가 삭제되었거나 접근할 수 없습니다.");
  return row.snapshot;
}
async function operation(actor: Actor, requestId: string) {
  if (!/^mg:[a-f0-9-]{36}$/.test(requestId)) throw new Error("입력창이 만료되었습니다. 다시 열어 주세요.");
  const row = await env.DB.prepare(`SELECT * FROM slack_work_command_operations
    WHERE request_id=? AND owner_id=? AND team_id=? AND slack_user_id=? AND command='management_edit'`)
    .bind(requestId, actor.authorization.ownerId, actor.teamId, actor.slackUserId).first<Operation>();
  if (!row || (row.status !== "succeeded" && Date.now() - Date.parse(row.created_at) > 15 * 60_000)) throw new Error("입력창이 만료되었습니다. 다시 열어 주세요.");
  if ((JSON.parse(row.result_json) as Saved).draft?.memberId !== actor.memberId) throw new Error("이 업무를 수정할 권한이 없습니다.");
  return row;
}
function appUrl() { const runtime = env as typeof env & { OKRI_APP_URL?: string; OKRPTR_APP_URL?: string }; return (runtime.OKRI_APP_URL || runtime.OKRPTR_APP_URL || "https://okrptr.com").replace(/\/$/, ""); }
export function managementStatusView(message: string, t: Translator) {
  return { type: "modal", title: { type: "plain_text", text: t("정보 입력·수정") }, close: { type: "plain_text", text: t("닫기") }, blocks: [{ type: "section", text: { type: "plain_text", text: message } }] };
}
async function tokenFor(actor: Actor) {
  const connection = await getSlackConnection(actor.authorization.ownerId);
  if (!connection || connection.teamId !== actor.teamId) throw new Error("Slack 연결이 변경되었습니다.");
  return slackTokenForConnection(connection);
}

export async function openManagementEditor(actor: Actor, triggerId: string, itemId: string, source: { channel: string; ts: string }, t: Translator, mode?: { push?: boolean; replaceViewId?: string }) {
  const token = await tokenFor(actor);
  // Consume Slack's short-lived trigger before fetching the full editor context.
  const opened = await slackApi<{ ok: boolean; view?: { id: string; hash: string } }>(token, mode?.replaceViewId ? "views.update" : mode?.push ? "views.push" : "views.open",
    { ...(mode?.replaceViewId ? { view_id: mode.replaceViewId } : { trigger_id: triggerId }), view: managementStatusView(t("정보를 불러오는 중입니다."), t) });
  if (!opened.view) return;
  waitUntil((async () => {
    try {
      await assertWriter(actor);
      if (!itemId || itemId.length > 128) throw new Error("업무가 삭제되었거나 접근할 수 없습니다.");
      const snapshot = await readManagementSnapshot(env.DB, actor.authorization.ownerId, itemId);
      const parsed: ManagementSnapshot = JSON.parse(snapshot);
      const propertyIds = editableManagementProperties(parsed).map((p) => p.id);
      const requestId = `mg:${crypto.randomUUID()}`, now = new Date().toISOString();
      const draft: ManagementDraft = { snapshot, channel: source.channel, ts: source.ts, memberId: actor.memberId, propertyIds };
      await env.DB.prepare(`INSERT INTO slack_work_command_operations
        (request_id,owner_id,team_id,slack_user_id,command,target_id,status,result_json,created_at,updated_at)
        VALUES (?,?,?,?,'management_edit',?,'draft',?,?,?)`)
        .bind(requestId, actor.authorization.ownerId, actor.teamId, actor.slackUserId, itemId, JSON.stringify({ draft }), now, now).run();
      await slackApi(token, "views.update", { view_id: opened.view!.id, hash: opened.view!.hash,
        view: managementEditorView(parsed, requestId, propertyIds, t, { appUrl: appUrl() }) });
    } catch (error) {
      await slackApi(token, "views.update", { view_id: opened.view!.id, view: managementStatusView(friendlyError(error, t), t) });
    }
  })().catch((error) => console.error("management_editor_open_failed", error)));
}

export async function managementEditorOptions(actor: Actor, requestId: string, field: string, query: string, t: Translator) {
  await assertWriter(actor);
  const row = await operation(actor, requestId);
  const { draft } = JSON.parse(row.result_json) as Saved;
  return { options: choicesFor(JSON.parse(draft.snapshot), field, query.slice(0, 160), t) };
}

export async function managementEditorSource(actor: Actor, requestId: string, itemId: string, parent: boolean) {
  await assertWriter(actor);
  const row = await operation(actor, requestId), { draft } = JSON.parse(row.result_json) as Saved;
  const snapshot: ManagementSnapshot = JSON.parse(draft.snapshot);
  if (itemId !== (parent ? snapshot.parentProjectId : row.target_id)) throw new Error("업무가 삭제되었거나 접근할 수 없습니다.");
  return { channel: draft.channel, ts: draft.ts };
}

// Every write, including the receipt and audit, is gated by one atomic claim.
// A repeated or lost-response submission reuses the same receipt; a failed batch
// leaves the draft intact. Unchanged assignments/properties are never rewritten.
export async function saveManagementEditor(actor: Actor, requestId: string, state: ManagementState) {
  await assertWriter(actor);
  const row = await operation(actor, requestId), stored = JSON.parse(row.result_json) as Saved;
  if (row.status === "succeeded") return { ...stored, targetId: row.target_id, repeated: true };
  const snapshot: ManagementSnapshot = JSON.parse(stored.draft.snapshot), item = snapshot.item!;
  const values = parseManagementValues(snapshot, stored.draft.propertyIds, state), before = initialManagementValues(snapshot);
  const now = new Date().toISOString(), claim = JSON.stringify({ attempt: crypto.randomUUID() });
  const gate = "EXISTS (SELECT 1 FROM slack_work_command_operations WHERE request_id=? AND status='processing' AND result_json=?)";
  const db = env.DB, ownerId = actor.authorization.ownerId;
  const statements = [db.prepare(`UPDATE slack_work_command_operations SET status='processing', result_json=?
    WHERE request_id=? AND status='draft' AND result_json=? AND ? = (${managementSnapshotSql}) AND EXISTS (${actorGuardSql})`)
    .bind(claim, requestId, row.result_json, stored.draft.snapshot, ownerId, item.id, ...actorArgs(actor))];
  const patch: Record<string, unknown> = {};
  if (values.status !== before.status) patch.status = values.status;
  if (values.priority !== before.priority) patch.priority = values.priority;
  if (values.dueDate !== before.dueDate) patch.dueDate = values.dueDate;
  const statusChanged = values.status !== before.status;
  if (Object.keys(patch).length) statements.push(db.prepare(`UPDATE items SET status=?,priority=?,due_date=?,progress=?,updated_at=?
    WHERE owner_id=? AND id=? AND ${gate}`).bind(statusChanged ? values.status : item.status, values.priority, values.dueDate,
      statusChanged ? ["done", "development_done"].includes(values.status) ? 100 : item.kind === "task" ? 0 : item.progress : item.progress,
      now, ownerId, item.id, requestId, claim));
  if (values.assignee !== before.assignee) {
    patch.assignee = values.assignee;
    const role = item.kind === "project" ? "project_dri" : "task_assignee";
    statements.push(db.prepare(`DELETE FROM item_assignments WHERE owner_id=? AND item_id=? AND role=? AND ${gate}`).bind(ownerId, item.id, role, requestId, claim));
    if (values.assignee) statements.push(db.prepare(`INSERT INTO item_assignments(id,owner_id,item_id,member_id,role,created_at,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE ${gate}`).bind(crypto.randomUUID(), ownerId, item.id, values.assignee, role, now, now, requestId, claim));
  }
  const changedProperties: Record<string, unknown> = {};
  for (const id of stored.draft.propertyIds) {
    const next = values.properties[id] ?? null, previous = before.properties[id] ?? null;
    if (JSON.stringify(next) === JSON.stringify(previous)) continue;
    changedProperties[id] = next;
    if (next === null) statements.push(db.prepare(`DELETE FROM item_property_values WHERE owner_id=? AND item_id=? AND property_id=? AND ${gate}`).bind(ownerId, item.id, id, requestId, claim));
    else statements.push(db.prepare(`INSERT INTO item_property_values(id,owner_id,item_id,property_id,value,updated_at)
      SELECT ?,?,?,?,?,? WHERE ${gate} ON CONFLICT(owner_id,item_id,property_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(crypto.randomUUID(), ownerId, item.id, id, JSON.stringify(next), now, requestId, claim));
  }
  if (Object.keys(changedProperties).length) patch.properties = changedProperties;
  if (Object.keys(patch).length) statements.push(db.prepare(`INSERT INTO activity_log(id,owner_id,item_id,action,source,payload,created_at)
    SELECT ?,?,?,'updated','slack',?,? WHERE ${gate}`).bind(crypto.randomUUID(), ownerId, item.id, JSON.stringify({ ...patch, userId: actor.authorization.userId }), now, requestId, claim));
  const result: Saved = { ...stored, savedAt: now, values, statusChanged };
  statements.push(db.prepare(`UPDATE slack_work_command_operations SET status='succeeded',result_json=?,updated_at=? WHERE request_id=? AND ${gate}`)
    .bind(JSON.stringify(result), now, requestId, requestId, claim));
  try { await db.batch(statements); }
  catch (error) {
    const receipt = await operation(actor, requestId).catch(() => null);
    if (receipt?.status === "succeeded") return { ...JSON.parse(receipt.result_json) as Saved, targetId: item.id, repeated: true };
    throw error;
  }
  const receipt = await operation(actor, requestId);
  if (receipt.status !== "succeeded") throw new Error("다른 곳에서 업무나 속성이 변경되었습니다. 최신 정보로 다시 열어 주세요.");
  return { ...JSON.parse(receipt.result_json) as Saved, targetId: item.id, repeated: false };
}

export function finishManagementSubmission(actor: Actor, viewId: string, requestId: string, state: ManagementState, t: Translator) {
  waitUntil((async () => {
    const token = await tokenFor(actor);
    try {
      const saved = await saveManagementEditor(actor, requestId, state);
      const snapshot: ManagementSnapshot = JSON.parse(saved.draft.snapshot), item = snapshot.item!;
      // The existing dispatcher deduplicates by item + persisted update time.
      if (item.kind === "task" && saved.statusChanged && saved.values && saved.savedAt) waitUntil(dispatchSlackAutomationEvent(actor.authorization.ownerId, {
        triggerType: "task_status_changed", fromStatus: item.status, item: { id: item.id, ownerId: actor.authorization.ownerId, kind: "task", title: item.title,
          status: saved.values.status, priority: saved.values.priority, updatedAt: saved.savedAt },
      }));
      waitUntil(import("./slack-task-changes").then(({ runDueTaskChanges }) => runDueTaskChanges(env.DB)));
      await slackApi(token, "views.update", { view_id: viewId, view: managementStatusView(t("업무 정보를 저장했습니다."), t) });
      if (saved.draft.channel && saved.draft.ts) waitUntil(import("./workspace-management-bot").then(({ refreshManagementReport }) =>
        refreshManagementReport(actor.authorization.ownerId, saved.draft.channel, saved.draft.ts)).catch((error) => console.error("management_report_refresh_failed", error)));
    } catch (error) {
      const row = await operation(actor, requestId).catch(() => null);
      const draft = row ? (JSON.parse(row.result_json) as Saved).draft : null;
      const view = draft ? managementEditorView(JSON.parse(draft.snapshot), requestId, draft.propertyIds, t, {
        state, error: friendlyError(error, t), errorField: error instanceof ManagementFieldError ? error.field : undefined, appUrl: appUrl(),
      }) : managementStatusView(friendlyError(error, t), t);
      await slackApi(token, "views.update", { view_id: viewId, view });
    }
  })().catch((error) => console.error("management_editor_submit_failed", error)));
}
function friendlyError(error: unknown, t: Translator) {
  const known = ["이 업무를 수정할 권한이 없습니다.", "입력창이 만료되었습니다. 다시 열어 주세요.", "업무가 삭제되었거나 접근할 수 없습니다.",
    "Slack 연결이 변경되었습니다.", "다른 곳에서 업무나 속성이 변경되었습니다. 최신 정보로 다시 열어 주세요.", "입력값을 확인해 주세요."];
  return t(error instanceof Error && known.includes(error.message) ? error.message : "저장 결과를 확인하지 못했습니다. 입력값을 유지했으니 다시 저장해 주세요.");
}
