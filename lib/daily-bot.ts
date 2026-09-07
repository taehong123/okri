import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { items, routines, workspaceMembers, type WorkspaceMember } from "@/db/schema";
import { dailyWorkSnapshots, listDailyWork, listDailyYesterdayWork, parseDailyWorkKeys, validateDailyWork, validateDailyYesterdayWork, type DailyWork } from "@/lib/daily-work";
import {
  createItem,
  dispatchSlackAutomationEvent,
  ensureWorkspace,
  replaceItemAssignmentRole,
  type RequestAuthorization,
} from "@/lib/pace-data";

export const MAX_DAILY_TASKS = 50;
const completedStatuses = new Set(["done", "development_done", "archived"]);
export const DAILY_SKIP_REASONS = ["workload", "vacation", "personal", "other"] as const;
export type DailySkipReason = typeof DAILY_SKIP_REASONS[number];
const dailySkipReasonLabels: Record<DailySkipReason, string> = {
  workload: "본업 과중",
  vacation: "휴가",
  personal: "개인 일정",
  other: "기타",
};

export type DailyTaskCandidate = {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  parentKind: "project" | "routine" | "general";
  parentId: string | null;
  parentTitle: string;
};

export type DailyTaskSnapshotValue = {
  id: string;
  taskId: string | null;
  taskTitle: string;
  parentKind: string;
  parentId: string | null;
  parentTitle: string;
  status: string;
  isNew: boolean;
  sortOrder: number;
};

export type DailySubmissionValue = {
  work?: DailyWork[];
  yesterdayWork?: DailyWork[];
  newlyCompletedCount?: number;
  id: string;
  memberId: string | null;
  memberName: string;
  memberEmail: string;
  date: string;
  version: number;
  yesterdayNote: string;
  todayNote: string;
  blockersNote: string;
  noPlannedTasks: boolean;
  skipReason: DailySkipReason | null;
  skipNote: string;
  source: string;
  submittedAt: string;
  tasks: DailyTaskSnapshotValue[];
};

type DraftRow = {
  work_selection_json?: string;
  yesterday_work_selection_json?: string;
  id: string;
  member_id: string | null;
  scrum_date: string;
  yesterday_note: string;
  today_note: string;
  blockers_note: string;
  no_planned_tasks: number;
  skip_reason: string | null;
  skip_note: string;
  source: string;
  updated_at: string;
};

type CandidateRow = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  parent_kind: "project" | "routine" | "general";
  parent_id: string | null;
  parent_title: string;
};

type SubmissionRow = {
  work_snapshot_json?: string;
  yesterday_work_snapshot_json?: string;
  request_id?: string | null;
  id: string;
  member_id: string | null;
  member_name: string;
  member_email: string;
  scrum_date: string;
  version: number;
  yesterday_note: string;
  today_note: string;
  blockers_note: string;
  no_planned_tasks: number;
  skip_reason: string | null;
  skip_note: string;
  source: string;
  submitted_at: string;
};

type SnapshotRow = {
  id: string;
  submission_id: string;
  task_id: string | null;
  task_title: string;
  parent_kind: string;
  parent_id: string | null;
  parent_title: string;
  status: string;
  is_new: number;
  sort_order: number;
};

export async function currentDailyMember(authorization: RequestAuthorization) {
  await ensureWorkspace(authorization.ownerId);
  const [member] = await getDb().select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, authorization.ownerId),
    eq(workspaceMembers.userId, authorization.userId),
    eq(workspaceMembers.status, "active"),
  )).limit(1);
  if (member) return member;
  if (authorization.apiToken) {
    const [owner] = await getDb().select().from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, authorization.ownerId),
      eq(workspaceMembers.role, "owner"),
      eq(workspaceMembers.status, "active"),
    )).limit(1);
    if (owner) return owner;
  }
  throw new Error("현재 워크스페이스 멤버를 확인할 수 없습니다.");
}

export async function getDailyDashboard(authorization: RequestAuthorization, rawDate: string) {
  const date = normalizeDailyDate(rawDate);
  const member = await currentDailyMember(authorization);
  const d1 = env.DB;
  const timezone = await dailyTimezone(d1, authorization.ownerId, member.id);
  const [draft, selectedRows, candidates, projectTargets, routineTargets, teamRows, legacy, work, yesterdayWork] = await Promise.all([
    d1.prepare(`SELECT id, member_id, scrum_date, yesterday_note, today_note, blockers_note,
        no_planned_tasks, skip_reason, skip_note, source, updated_at, work_selection_json, yesterday_work_selection_json
      FROM daily_scrums WHERE owner_id = ? AND member_id = ? AND scrum_date = ? LIMIT 1`)
      .bind(authorization.ownerId, member.id, date).first<DraftRow>(),
    d1.prepare(`SELECT selection.task_id AS id
      FROM daily_scrum_task_selections AS selection
      INNER JOIN daily_scrums AS draft ON draft.id = selection.daily_scrum_id
      WHERE selection.owner_id = ? AND selection.member_id = ? AND draft.scrum_date = ?`)
      .bind(authorization.ownerId, member.id, date).all<{ id: string }>(),
    listAssignedTaskCandidates(authorization.ownerId, member.id),
    listDailyProjectTargets(authorization.ownerId, member.id),
    listRoutineTargets(authorization.ownerId, member.id),
    d1.prepare(`SELECT member.id, member.display_name, member.email, member.role,
        draft.id AS draft_id, link.id AS slack_link_id,
        submission.id AS submission_id, submission.member_name, submission.member_email,
        submission.scrum_date, submission.version, submission.yesterday_note, submission.today_note,
        submission.blockers_note, submission.no_planned_tasks, submission.skip_reason, submission.skip_note,
        submission.source, submission.submitted_at, submission.work_snapshot_json, submission.yesterday_work_snapshot_json
      FROM workspace_members AS member
      LEFT JOIN daily_scrums AS draft
        ON draft.owner_id = member.workspace_id AND draft.member_id = member.id AND draft.scrum_date = ?
      LEFT JOIN slack_member_links AS link
        ON link.owner_id = member.workspace_id AND link.member_id = member.id
      LEFT JOIN daily_submissions AS submission ON submission.id = (
        SELECT latest.id FROM daily_submissions AS latest
        WHERE latest.owner_id = member.workspace_id AND latest.member_id = member.id AND latest.scrum_date = ?
        ORDER BY latest.version DESC LIMIT 1
      )
      WHERE member.workspace_id = ? AND member.status = 'active'
      ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, member.created_at`)
      .bind(date, date, authorization.ownerId).all<Record<string, string | number | null>>(),
    d1.prepare(`SELECT id, member_id, scrum_date, yesterday_note, today_note, blockers_note,
        no_planned_tasks, skip_reason, skip_note, source, updated_at
      FROM daily_scrums WHERE owner_id = ? AND member_id IS NULL AND scrum_date = ? LIMIT 1`)
      .bind(authorization.ownerId, date).first<DraftRow>(),
    listDailyWork(d1, authorization.ownerId, member.id, date),
    listDailyYesterdayWork(d1, authorization.ownerId, member.id, date, timezone),
  ]);

  const submissionIds = teamRows.results.flatMap((row) => typeof row.submission_id === "string" ? [row.submission_id] : []);
  const snapshots = await snapshotsForSubmissions(submissionIds);
  const snapshotsBySubmission = new Map<string, SnapshotRow[]>();
  for (const snapshot of snapshots) {
    const values = snapshotsBySubmission.get(snapshot.submission_id) ?? [];
    values.push(snapshot);
    snapshotsBySubmission.set(snapshot.submission_id, values);
  }
  const team = teamRows.results.map((row) => {
    const submission = row.submission_id ? serializeSubmission(row as unknown as SubmissionRow, snapshotsBySubmission.get(String(row.submission_id)) ?? []) : null;
    return {
      memberId: String(row.id),
      displayName: String(row.display_name || row.email || "멤버"),
      email: String(row.email || ""),
      role: String(row.role || "member"),
      status: submission ? submission.skipReason ? "skipped" : "submitted" : row.draft_id ? "writing" : "missing",
      slackConnected: Boolean(row.slack_link_id),
      submission,
    };
  });
  const currentSubmission = team.find((entry) => entry.memberId === member.id)?.submission ?? null;

  return {
    date,
    member: serializeMember(member),
    draft: {
      id: draft?.id ?? null,
      date,
      yesterdayNote: draft?.yesterday_note ?? "",
      todayNote: draft?.today_note ?? "",
      blockersNote: draft?.blockers_note ?? "",
      noPlannedTasks: Boolean(draft?.no_planned_tasks),
      skipReason: normalizeDailySkipReason(draft?.skip_reason),
      skipNote: draft?.skip_note ?? "",
      selectedTaskIds: selectedRows.results.map((row) => row.id),
      selectedWorkIds: [...selectedRows.results.map((row) => `task:${row.id}`), ...parseDailyWorkKeys(draft?.work_selection_json || "[]")],
      selectedYesterdayWorkIds: draft
        ? parseDailyWorkKeys(draft.yesterday_work_selection_json || "[]")
        : yesterdayWork.filter((entry) => entry.completedYesterday).slice(0, MAX_DAILY_TASKS).map((entry) => entry.key),
      source: draft?.source ?? "web",
      updatedAt: draft?.updated_at ?? null,
    },
    latestSubmission: currentSubmission,
    candidates: {
      work,
      yesterdayWork,
      tasks: candidates,
      groups: groupCandidates(candidates),
    },
    createTargets: {
      projects: projectTargets,
      routines: routineTargets,
      allowGeneral: projectTargets.length === 0 && routineTargets.length === 0,
    },
    team,
    legacyWorkspaceNote: legacy ? {
      yesterdayNote: legacy.yesterday_note,
      todayNote: legacy.today_note,
      blockersNote: legacy.blockers_note,
      updatedAt: legacy.updated_at,
    } : null,
  };
}

export async function saveDailyDraft(
  authorization: RequestAuthorization,
  input: {
    date: string;
    yesterdayNote?: string;
    todayNote?: string;
    blockersNote?: string;
    selectedTaskIds?: string[];
    selectedWorkIds?: string[];
    selectedYesterdayWorkIds?: string[];
    noPlannedTasks?: boolean;
    skipReason?: DailySkipReason | null;
    skipNote?: string;
    source?: "web" | "slack";
  },
  refreshDashboard = true,
) {
  const date = normalizeDailyDate(input.date);
  const member = await currentDailyMember(authorization);
  const workKeys = input.selectedWorkIds === undefined ? undefined : parseDailyWorkKeys(input.selectedWorkIds);
  const yesterdayKeys = input.selectedYesterdayWorkIds === undefined ? undefined : parseDailyWorkKeys(input.selectedYesterdayWorkIds, "yesterday");
  const requestedIds = uniqueIds(workKeys === undefined ? input.selectedTaskIds ?? [] : workKeys.filter((key) => key.startsWith("task:")).map((key) => key.slice(5)));
  if (requestedIds.length > MAX_DAILY_TASKS) throw new Error(`오늘 Task는 최대 ${MAX_DAILY_TASKS}개까지 선택할 수 있습니다.`);
  const skipReason = normalizeDailySkipReason(input.skipReason);
  const noPlannedTasks = skipReason ? false : Boolean(input.noPlannedTasks);
  const skipNote = skipReason ? cleanSkipNote(input.skipNote) : "";
  const selectedTaskIds = skipReason || noPlannedTasks ? [] : requestedIds;
  const previousWork = workKeys === undefined || yesterdayKeys === undefined ? await env.DB.prepare("SELECT work_selection_json, yesterday_work_selection_json FROM daily_scrums WHERE owner_id = ? AND member_id = ? AND scrum_date = ?")
    .bind(authorization.ownerId, member.id, date).first<{ work_selection_json: string; yesterday_work_selection_json: string }>() : null;
  const selectedWorkIds = skipReason || noPlannedTasks ? [] : (workKeys ?? parseDailyWorkKeys(previousWork?.work_selection_json || "[]")).filter((key) => !key.startsWith("task:"));
  const selectedYesterdayWorkIds = skipReason ? [] : (yesterdayKeys ?? parseDailyWorkKeys(previousWork?.yesterday_work_selection_json || "[]", "yesterday"));
  if (selectedWorkIds.length + selectedTaskIds.length > MAX_DAILY_TASKS) throw new Error("오늘 할 업무는 최대 50개까지 선택할 수 있습니다.");
  if (selectedYesterdayWorkIds.length > MAX_DAILY_TASKS) throw new Error("완료한 일은 최대 50개까지 선택할 수 있습니다.");
  const todayKeys = new Set([...selectedWorkIds, ...selectedTaskIds.map((id) => `task:${id}`)]);
  if (selectedYesterdayWorkIds.some((key) => todayKeys.has(key))) throw new Error("같은 업무를 완료한 일과 오늘 할 일에 동시에 선택할 수 없습니다.");
  await validateDailyWork(env.DB, authorization.ownerId, member.id, date, selectedWorkIds);
  await validateDailyYesterdayWork(env.DB, authorization.ownerId, member.id, date, await dailyTimezone(env.DB, authorization.ownerId, member.id), selectedYesterdayWorkIds);
  await assertAssignedTaskIds(authorization.ownerId, member.id, selectedTaskIds);
  const d1 = env.DB;
  const existing = await d1.prepare(`SELECT id FROM daily_scrums
    WHERE owner_id = ? AND member_id = ? AND scrum_date = ? LIMIT 1`)
    .bind(authorization.ownerId, member.id, date).first<{ id: string }>();
  const draftId = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const draftStatement = !existing
    ? d1.prepare(`INSERT INTO daily_scrums
      (id, owner_id, member_id, scrum_date, yesterday_note, today_note, blockers_note, no_planned_tasks, skip_reason, skip_note, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(draftId, authorization.ownerId, member.id, date, cleanNote(input.yesterdayNote), cleanNote(input.todayNote), cleanNote(input.blockersNote), noPlannedTasks ? 1 : 0, skipReason, skipNote, input.source ?? "web", now, now)
    : d1.prepare(`UPDATE daily_scrums SET yesterday_note = ?, today_note = ?, blockers_note = ?,
      no_planned_tasks = ?, skip_reason = ?, skip_note = ?, source = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND member_id = ?`)
      .bind(cleanNote(input.yesterdayNote), cleanNote(input.todayNote), cleanNote(input.blockersNote), noPlannedTasks ? 1 : 0, skipReason, skipNote, input.source ?? "web", now, draftId, authorization.ownerId, member.id);
  await d1.batch([
    draftStatement,
    d1.prepare("UPDATE daily_scrums SET work_selection_json = ? WHERE id = ? AND owner_id = ? AND member_id = ?")
      .bind(JSON.stringify(selectedWorkIds), draftId, authorization.ownerId, member.id),
    d1.prepare("UPDATE daily_scrums SET yesterday_work_selection_json = ? WHERE id = ? AND owner_id = ? AND member_id = ?")
      .bind(JSON.stringify(selectedYesterdayWorkIds), draftId, authorization.ownerId, member.id),
    d1.prepare("DELETE FROM daily_scrum_task_selections WHERE daily_scrum_id = ? AND owner_id = ?").bind(draftId, authorization.ownerId),
    ...selectedTaskIds.map((taskId) => d1.prepare(`INSERT INTO daily_scrum_task_selections
      (id, owner_id, daily_scrum_id, member_id, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), authorization.ownerId, draftId, member.id, taskId, now)),
  ]);
  return refreshDashboard ? getDailyDashboard(authorization, date) : null;
}

export async function createExplicitDailyTask(
  authorization: RequestAuthorization,
  input: { date: string; title: string; parentKind?: "project" | "routine" | "general"; parentId?: string | null; requestId?: string },
) {
  const date = normalizeDailyDate(input.date);
  const title = input.title.trim();
  if (!title) throw new Error("새 Task 제목을 입력해 주세요.");
  if (title.length > 240) throw new Error("Task 제목은 240자 이하로 입력해 주세요.");
  const member = await currentDailyMember(authorization);
  if (authorization.role === "viewer" || member.role === "viewer") throw new Error("읽기 전용 멤버는 Task를 만들 수 없습니다.");
  const sourceRef = `daily:${member.id}:${date}:${normalizeRequestId(input.requestId)}`;
  const parentKind = input.parentKind ?? "general";
  const parentId = input.parentId?.trim() || null;
  const allowed = await validateCreateTarget(authorization.ownerId, member.id, parentKind, parentId);
  const [existing] = await getDb().select().from(items).where(and(
    eq(items.ownerId, authorization.ownerId),
    eq(items.sourceRef, sourceRef),
  )).limit(1);
  if (existing) {
    if (existing.kind !== "task" || existing.archivedAt || completedStatuses.has(existing.status) || existing.createdByUserId !== authorization.userId
      || (allowed.parentKind === "project" && existing.parentId !== allowed.parentId)
      || (allowed.parentKind === "routine" && existing.routineId !== allowed.parentId)) throw new Error("Task 생성 요청을 다시 확인해 주세요.");
    const assignments = await env.DB.prepare("SELECT member_id FROM item_assignments WHERE owner_id = ? AND item_id = ? AND role = 'task_assignee'")
      .bind(authorization.ownerId, existing.id).all<{ member_id: string }>();
    if (assignments.results.some((assignment) => assignment.member_id !== member.id)) throw new Error("Task 생성 요청을 다시 확인해 주세요.");
    if (!assignments.results.length) await replaceItemAssignmentRole(authorization.ownerId, existing.id, "task_assignee", [member.id]);
    await selectTaskInDraft(authorization, member, date, existing.id);
    return existing;
  }

  const created = await createItem(authorization.ownerId, {
    title,
    kind: "task",
    cycleId: allowed.cycleId,
    parentId: allowed.parentKind === "project" ? allowed.parentId : null,
    routineId: allowed.parentKind === "routine" ? allowed.parentId : null,
    status: "todo",
    dueDate: date,
    source: "daily",
    sourceRef,
    createdByUserId: authorization.userId,
  });
  await replaceItemAssignmentRole(authorization.ownerId, created.id, "task_assignee", [member.id]);
  await selectTaskInDraft(authorization, member, date, created.id);
  return created;
}

export async function submitDailyDraft(authorization: RequestAuthorization, rawDate: string, source: "web" | "slack" = "web", requestId?: string, completedWorkIds: string[] = [], deletedWorkIds: string[] = []) {
  const date = normalizeDailyDate(rawDate);
  const member = await currentDailyMember(authorization);
  if (authorization.role === "viewer" || member.role === "viewer") throw new Error("읽기 전용 멤버는 데일리를 제출할 수 없습니다.");
  const d1 = env.DB;
  const normalizedRequestId = requestId ? normalizeRequestId(requestId) : null;
  if (normalizedRequestId) {
    const existingSubmission = await d1.prepare("SELECT * FROM daily_submissions WHERE owner_id = ? AND member_id = ? AND request_id = ? LIMIT 1")
      .bind(authorization.ownerId, member.id, normalizedRequestId).first<SubmissionRow>();
    if (existingSubmission) return serializeSubmission(existingSubmission, await snapshotsForSubmissions([existingSubmission.id]));
  }
  const draft = await d1.prepare(`SELECT id, member_id, scrum_date, yesterday_note, today_note, blockers_note,
      no_planned_tasks, skip_reason, skip_note, source, updated_at, work_selection_json, yesterday_work_selection_json FROM daily_scrums
    WHERE owner_id = ? AND member_id = ? AND scrum_date = ? LIMIT 1`)
    .bind(authorization.ownerId, member.id, date).first<DraftRow>();
  if (!draft) throw new Error("먼저 데일리 초안을 저장해 주세요.");
  const completedToday = (await validateDailyWork(d1, authorization.ownerId, member.id, date, completedWorkIds))
    .map((entry) => ({ ...entry, completedToday: true }));
  const deleteKeys = parseDailyWorkKeys(deletedWorkIds);
  if (deleteKeys.some((key) => !key.startsWith("task:"))) throw new Error("데일리에서는 개별 Task만 삭제할 수 있습니다.");
  const deletedTasks = await validateDailyWork(d1, authorization.ownerId, member.id, date, deleteKeys);
  const work = await validateDailyWork(d1, authorization.ownerId, member.id, date, parseDailyWorkKeys(draft.work_selection_json || "[]"));
  const yesterdayWork = await validateDailyYesterdayWork(d1, authorization.ownerId, member.id, date,
    await dailyTimezone(d1, authorization.ownerId, member.id), parseDailyWorkKeys(draft.yesterday_work_selection_json || "[]", "yesterday"));
  const selected = await selectedTaskRows(authorization.ownerId, member.id, draft.id, date);
  const selectionCount = await d1.prepare("SELECT COUNT(*) AS count FROM daily_scrum_task_selections WHERE daily_scrum_id = ?")
    .bind(draft.id).first<{ count: number }>();
  if (selected.length !== Number(selectionCount?.count ?? 0)) {
    throw new Error("선택한 Task의 상태 또는 할당이 변경되었습니다. 초안을 새로고침해 다시 선택해 주세요.");
  }
  const skipReason = normalizeDailySkipReason(draft.skip_reason);
  if (skipReason && completedToday.length + deletedTasks.length) throw new Error("스킵하려면 선택한 업무 상태를 먼저 해제해 주세요.");
  if (skipReason === "other" && !draft.skip_note.trim()) {
    throw new Error("기타 스킵 사유를 입력해 주세요.");
  }
  if (!skipReason && !draft.no_planned_tasks && selected.length + work.length === 0 && !draft.today_note.trim()) {
    throw new Error("오늘 Task를 선택하거나 ‘오늘 예정 없음’을 선택해 주세요.");
  }
  if (selected.length + work.length + completedToday.length + deletedTasks.length > MAX_DAILY_TASKS) throw new Error(`오늘 할 업무는 최대 ${MAX_DAILY_TASKS}개까지 선택할 수 있습니다.`);
  if (yesterdayWork.length > MAX_DAILY_TASKS) throw new Error(`완료한 일은 최대 ${MAX_DAILY_TASKS}개까지 선택할 수 있습니다.`);
  const todayKeys = new Set([...work.map((entry) => entry.key), ...selected.map((entry) => `task:${entry.id}`)]);
  if (yesterdayWork.some((entry) => todayKeys.has(entry.key))) throw new Error("같은 업무를 완료한 일과 오늘 할 일에 동시에 선택할 수 없습니다.");
  if (completedToday.some((entry) => todayKeys.has(entry.key) || yesterdayWork.some((other) => other.key === entry.key))) throw new Error("업무마다 한 가지 상태만 선택해 주세요.");
  if (deletedTasks.some((entry) => todayKeys.has(entry.key) || yesterdayWork.some((other) => other.key === entry.key) || completedToday.some((other) => other.key === entry.key))) throw new Error("업무마다 한 가지 상태만 선택해 주세요.");

  const versionRow = await d1.prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM daily_submissions
    WHERE owner_id = ? AND member_id = ? AND scrum_date = ?`)
    .bind(authorization.ownerId, member.id, date).first<{ version: number }>();
  const submissionId = crypto.randomUUID();
  const version = Number(versionRow?.version ?? 0) + 1;
  const submittedAt = new Date().toISOString();
  const newlyCompleted = [...yesterdayWork.filter((entry) => entry.willCompleteOnSubmit), ...completedToday];
  // Check membership and assignments in the write transaction. JSON keeps 50 selections below D1's bind limit.
  const changedWork = [...completedToday, ...deletedTasks];
  const mutationGuard = changedWork.length ? `EXISTS (SELECT 1 FROM workspace_members m
      WHERE m.id = ? AND m.workspace_id = ? AND m.user_id IS ? AND m.status = 'active' AND m.role <> 'viewer')
    AND NOT EXISTS (SELECT 1 FROM json_each(?) selection WHERE
      (json_extract(selection.value, '$.kind') = 'routine' AND NOT EXISTS (
        SELECT 1 FROM routines r WHERE r.id = json_extract(selection.value, '$.id') AND r.owner_id = ?
          AND r.assignee_member_id = ? AND r.active = 1 AND r.system_key IS NULL
          AND NOT EXISTS (SELECT 1 FROM routine_completions c WHERE c.owner_id = r.owner_id AND c.routine_id = r.id AND c.completion_date = ?)))
      OR (json_extract(selection.value, '$.kind') <> 'routine' AND NOT EXISTS (
        SELECT 1 FROM items i JOIN item_assignments a ON a.owner_id = i.owner_id AND a.item_id = i.id
        WHERE i.id = json_extract(selection.value, '$.id') AND i.kind = json_extract(selection.value, '$.kind')
          AND i.status = json_extract(selection.value, '$.status') AND i.owner_id = ? AND a.member_id = ? AND i.archived_at IS NULL
          AND ((i.kind = 'task' AND a.role = 'task_assignee') OR (i.kind = 'project' AND a.role IN ('project_dri','project_worker'))))))` : "1";
  const mutationGuardArgs = changedWork.length ? [member.id, authorization.ownerId, member.userId,
    JSON.stringify(changedWork.map(({ id, kind, status }) => ({ id, kind, status }))),
    authorization.ownerId, member.id, date, authorization.ownerId, member.id] : [];
  const channels = await d1.prepare("SELECT channel_id FROM slack_daily_channels WHERE owner_id = ? ORDER BY channel_name")
    .bind(authorization.ownerId).all<{ channel_id: string }>();
  await d1.batch([
    d1.prepare(`INSERT INTO daily_submissions
      (id, owner_id, member_id, member_name, member_email, scrum_date, version, yesterday_note, today_note,
       blockers_note, no_planned_tasks, skip_reason, skip_note, source, submitted_at, work_snapshot_json,
       yesterday_work_snapshot_json, request_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${mutationGuard}`)
      .bind(submissionId, authorization.ownerId, member.id, member.displayName || member.email || "멤버", member.email || "", date, version,
        draft.yesterday_note, draft.today_note, draft.blockers_note, draft.no_planned_tasks, skipReason, draft.skip_note, source, submittedAt,
        JSON.stringify([...work, ...completedToday.map((entry) => ({ ...entry, status: "done" }))]), JSON.stringify(yesterdayWork), normalizedRequestId, ...mutationGuardArgs),
    // Match trashItems' recoverable archive fields without deleting the Project, Routine or any sibling Task.
    ...deletedTasks.flatMap((entry) => [
      d1.prepare(`UPDATE items SET archived_from_status = COALESCE(archived_from_status, status),
        status = 'archived', archived_at = ?, updated_at = ?,
        archive_root_id = COALESCE((SELECT p.id FROM items p WHERE p.owner_id = items.owner_id
          AND p.id = items.parent_id AND p.kind = 'project' AND p.archived_at IS NOT NULL), id)
        WHERE owner_id = ? AND id = ? AND kind = 'task' AND archived_at IS NULL
          AND EXISTS (SELECT 1 FROM daily_submissions WHERE id = ?)`)
        .bind(submittedAt, submittedAt, authorization.ownerId, entry.id, submissionId),
      d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
        SELECT ?, owner_id, id, 'item_trashed', 'daily',
          json_object('rootId', archive_root_id, 'kind', 'task', 'origin', 'daily_delete_selection', 'requestId', ?), ?
        FROM items WHERE owner_id = ? AND id = ? AND EXISTS (SELECT 1 FROM daily_submissions WHERE id = ?)`)
        .bind(crypto.randomUUID(), normalizedRequestId, submittedAt, authorization.ownerId, entry.id, submissionId),
    ]),
    ...newlyCompleted.filter((entry) => entry.kind !== "routine").flatMap((entry) => [
      d1.prepare("UPDATE items SET status = 'done', progress = 100, updated_at = ? WHERE owner_id = ? AND id = ? AND archived_at IS NULL AND status NOT IN ('done','development_done','archived') AND EXISTS (SELECT 1 FROM daily_submissions WHERE id = ?)")
        .bind(submittedAt, authorization.ownerId, entry.id, submissionId),
      d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
        SELECT ?, ?, ?, 'updated', 'daily', ?, ? WHERE EXISTS (SELECT 1 FROM daily_submissions WHERE id = ?)`)
        .bind(crypto.randomUUID(), authorization.ownerId, entry.id, JSON.stringify({ status: "done", fromStatus: entry.status, progress: 100, effectiveDate: date, origin: "daily_completed_selection", requestId: normalizedRequestId }), submittedAt, submissionId),
    ]),
    ...newlyCompleted.filter((entry) => entry.kind === "routine").map((entry) => d1.prepare(`INSERT OR IGNORE INTO routine_completions
      (id, owner_id, routine_id, completion_date, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM daily_submissions WHERE id = ?)`)
      .bind(crypto.randomUUID(), authorization.ownerId, entry.id, date, submittedAt, submissionId)),
    ...selected.map((task, index) => d1.prepare(`INSERT INTO daily_task_snapshots
      (id, owner_id, submission_id, task_id, task_title, parent_kind, parent_id, parent_title, status, is_new, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), authorization.ownerId, submissionId, task.id, task.title, task.parent_kind, task.parent_id, task.parent_title,
        task.status, task.is_new, index)),
    ...channels.results.map((channel) => d1.prepare(`INSERT INTO slack_daily_publications
      (id, owner_id, member_id, submission_id, scrum_date, channel_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(crypto.randomUUID(), authorization.ownerId, member.id, submissionId, date, channel.channel_id, submittedAt)),
  ]);
  const snapshots = await snapshotsForSubmissions([submissionId]);
  const submission = await d1.prepare("SELECT * FROM daily_submissions WHERE id = ?").bind(submissionId).first<SubmissionRow>();
  if (!submission) throw new Error("데일리 제출 결과를 확인할 수 없습니다.");
  const serialized = serializeSubmission(submission, snapshots);
  serialized.newlyCompletedCount = newlyCompleted.length;
  for (const entry of newlyCompleted) {
    if (entry.kind !== "task") continue;
    const automationItem = { id: entry.id, ownerId: authorization.ownerId, kind: entry.kind, title: entry.title,
      status: "done", priority: entry.priority, updatedAt: submittedAt } as Parameters<typeof dispatchSlackAutomationEvent>[1]["item"];
    await dispatchSlackAutomationEvent(authorization.ownerId, { triggerType: "task_status_changed", item: automationItem, fromStatus: entry.status }).catch(() => undefined);
  }
  return serialized;
}

export async function dailyMemberBySlack(teamId: string, slackUserId: string) {
  await ensureWorkspaceForSlackTeam(teamId);
  const row = await env.DB.prepare(`SELECT link.owner_id, link.member_id, member.user_id, member.email,
      member.display_name, member.role, member.status
    FROM slack_member_links AS link
    INNER JOIN workspace_members AS member ON member.id = link.member_id AND member.workspace_id = link.owner_id
    INNER JOIN slack_connections connection ON connection.owner_id = link.owner_id AND connection.team_id = link.team_id
    WHERE link.team_id = ? AND link.slack_user_id = ? AND member.status = 'active' LIMIT 1`)
    .bind(teamId, slackUserId).first<Record<string, string>>();
  if (!row) return null;
  return {
    authorization: {
      ownerId: row.owner_id,
      userId: row.user_id || `slack:${slackUserId}`,
      email: row.email || null,
      displayName: row.display_name || row.email || "Slack member",
      role: (row.role || "member") as RequestAuthorization["role"],
      apiToken: false,
    } satisfies RequestAuthorization,
    memberId: row.member_id,
  };
}

async function ensureWorkspaceForSlackTeam(teamId: string) {
  const row = await env.DB.prepare("SELECT owner_id FROM slack_connections WHERE team_id = ? LIMIT 1").bind(teamId).first<{ owner_id: string }>();
  if (row) await ensureWorkspace(row.owner_id);
}

async function listAssignedTaskCandidates(ownerId: string, memberId: string) {
  const rows = await env.DB.prepare(`SELECT task.id, task.title, task.status, task.due_date,
      CASE WHEN project.id IS NOT NULL THEN 'project'
           WHEN routine.system_key = 'general' OR (task.parent_id IS NULL AND routine.id IS NULL) THEN 'general'
           ELSE 'routine' END AS parent_kind,
      CASE WHEN project.id IS NOT NULL THEN project.id
           WHEN routine.system_key = 'general' THEN NULL ELSE routine.id END AS parent_id,
      CASE WHEN project.id IS NOT NULL THEN project.title
           WHEN routine.system_key = 'general' OR routine.id IS NULL THEN 'General' ELSE routine.title END AS parent_title
    FROM item_assignments AS assignment
    INNER JOIN items AS task ON task.id = assignment.item_id AND task.owner_id = assignment.owner_id
    LEFT JOIN items AS project ON project.id = task.parent_id AND project.owner_id = task.owner_id AND project.kind = 'project'
    LEFT JOIN routines AS routine ON routine.id = task.routine_id AND routine.owner_id = task.owner_id
    WHERE assignment.owner_id = ? AND assignment.member_id = ? AND assignment.role = 'task_assignee'
      AND task.kind = 'task' AND task.archived_at IS NULL
      AND task.status NOT IN ('done', 'development_done', 'archived')
    ORDER BY CASE WHEN task.due_date IS NULL THEN 1 ELSE 0 END, task.due_date, task.updated_at DESC, task.title`)
    .bind(ownerId, memberId).all<CandidateRow>();
  return rows.results.map(serializeCandidate);
}

async function listDailyProjectTargets(ownerId: string, memberId: string) {
  const rows = await env.DB.prepare(`SELECT DISTINCT project.id, project.title,
      EXISTS (SELECT 1 FROM items task WHERE task.owner_id = project.owner_id AND task.parent_id = project.id
        AND task.kind = 'task' AND task.archived_at IS NULL) AS has_tasks,
      NOT EXISTS (
        SELECT 1 FROM items AS task WHERE task.owner_id = project.owner_id AND task.parent_id = project.id
          AND task.kind = 'task' AND task.archived_at IS NULL
          AND task.status NOT IN ('done', 'development_done', 'archived')
      ) AS needs_task
    FROM item_assignments AS assignment
    INNER JOIN items AS project ON project.id = assignment.item_id AND project.owner_id = assignment.owner_id
    WHERE assignment.owner_id = ? AND assignment.member_id = ? AND assignment.role IN ('project_dri','project_worker')
      AND project.kind = 'project' AND project.archived_at IS NULL
      AND project.status NOT IN ('done', 'development_done', 'archived')
    ORDER BY project.title`)
    .bind(ownerId, memberId).all<{ id: string; title: string; needs_task: number; has_tasks: number }>();
  return rows.results.map((row) => ({ id: row.id, title: row.title, needsTask: Boolean(row.needs_task), hasTasks: Boolean(row.has_tasks) }));
}

async function listRoutineTargets(ownerId: string, memberId: string) {
  const rows = await env.DB.prepare(`SELECT routine.id, routine.title,
      EXISTS (
        SELECT 1 FROM items AS task
        WHERE task.owner_id = routine.owner_id AND task.routine_id = routine.id
          AND task.kind = 'task' AND task.archived_at IS NULL
      ) AS has_tasks,
      NOT EXISTS (
        SELECT 1 FROM items AS task
        WHERE task.owner_id = routine.owner_id AND task.routine_id = routine.id
          AND task.kind = 'task' AND task.archived_at IS NULL
          AND task.status NOT IN ('done', 'development_done', 'archived')
      ) AS needs_task
    FROM routines AS routine
    WHERE routine.owner_id = ? AND routine.assignee_member_id = ? AND routine.active = 1 AND routine.system_key IS NULL
    ORDER BY routine.sort_order, routine.title`)
    .bind(ownerId, memberId).all<{ id: string; title: string; needs_task: number; has_tasks: number }>();
  return rows.results.map((row) => ({ id: row.id, title: row.title, needsTask: Boolean(row.needs_task), hasTasks: Boolean(row.has_tasks) }));
}

async function validateCreateTarget(ownerId: string, memberId: string, kind: "project" | "routine" | "general", id: string | null) {
  if (kind === "project" && id) {
    const row = await env.DB.prepare(`SELECT project.id, project.cycle_id FROM items AS project
      INNER JOIN item_assignments AS assignment ON assignment.item_id = project.id AND assignment.owner_id = project.owner_id
      WHERE project.owner_id = ? AND project.id = ? AND project.kind = 'project' AND project.archived_at IS NULL
        AND project.status NOT IN ('done','development_done','archived')
        AND assignment.member_id = ? AND assignment.role IN ('project_dri','project_worker') LIMIT 1`)
      .bind(ownerId, id, memberId).first<{ id: string; cycle_id: string | null }>();
    if (row) return { parentKind: "project" as const, parentId: row.id, cycleId: row.cycle_id };
  }
  if (kind === "routine" && id) {
    const [row] = await getDb().select({ id: routines.id }).from(routines).where(and(
      eq(routines.ownerId, ownerId), eq(routines.id, id), eq(routines.assigneeMemberId, memberId), eq(routines.active, true),
    )).limit(1);
    if (row) return { parentKind: "routine" as const, parentId: row.id, cycleId: null };
  }
  if (kind === "general") {
    const [projects, routinesForMember] = await Promise.all([listDailyProjectTargets(ownerId, memberId), listRoutineTargets(ownerId, memberId)]);
    if (projects.length === 0 && routinesForMember.length === 0) return { parentKind: "general" as const, parentId: null, cycleId: null };
    throw new Error("책임 Project 또는 담당 Routine을 선택해 주세요.");
  }
  throw new Error("본인이 담당한 Project 또는 Routine만 선택할 수 있습니다.");
}

async function assertAssignedTaskIds(ownerId: string, memberId: string, taskIds: string[]) {
  if (!taskIds.length) return;
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT task.id FROM item_assignments AS assignment
    INNER JOIN items AS task ON task.id = assignment.item_id AND task.owner_id = assignment.owner_id
    WHERE assignment.owner_id = ? AND assignment.member_id = ? AND assignment.role = 'task_assignee'
      AND task.id IN (${placeholders}) AND task.kind = 'task' AND task.archived_at IS NULL
      AND task.status NOT IN ('done', 'development_done', 'archived')`)
    .bind(ownerId, memberId, ...taskIds).all<{ id: string }>();
  if (rows.results.length !== taskIds.length) throw new Error("본인에게 할당된 미완료 Task만 선택할 수 있습니다.");
}

async function ensureDraftId(ownerId: string, memberId: string, date: string, source = "web") {
  const existing = await env.DB.prepare(`SELECT id FROM daily_scrums WHERE owner_id = ? AND member_id = ? AND scrum_date = ? LIMIT 1`)
    .bind(ownerId, memberId, date).first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO daily_scrums
    (id, owner_id, member_id, scrum_date, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ownerId, memberId, date, source, now, now).run();
  return id;
}

async function selectTaskInDraft(authorization: RequestAuthorization, member: WorkspaceMember, date: string, taskId: string) {
  const draftId = await ensureDraftId(authorization.ownerId, member.id, date);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM daily_scrum_task_selections WHERE daily_scrum_id = ? AND task_id != ?")
    .bind(draftId, taskId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_DAILY_TASKS) throw new Error(`오늘 Task는 최대 ${MAX_DAILY_TASKS}개까지 선택할 수 있습니다.`);
  await env.DB.prepare(`INSERT OR IGNORE INTO daily_scrum_task_selections
    (id, owner_id, daily_scrum_id, member_id, task_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), authorization.ownerId, draftId, member.id, taskId).run();
  await env.DB.prepare("UPDATE daily_scrums SET no_planned_tasks = 0, skip_reason = NULL, skip_note = '', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), draftId).run();
}

async function selectedTaskRows(ownerId: string, memberId: string, draftId: string, date: string) {
  const rows = await env.DB.prepare(`SELECT task.id, task.title, task.status,
      CASE WHEN project.id IS NOT NULL THEN 'project'
           WHEN routine.system_key = 'general' OR routine.id IS NULL THEN 'general' ELSE 'routine' END AS parent_kind,
      CASE WHEN project.id IS NOT NULL THEN project.id
           WHEN routine.system_key = 'general' THEN NULL ELSE routine.id END AS parent_id,
      CASE WHEN project.id IS NOT NULL THEN project.title
           WHEN routine.system_key = 'general' OR routine.id IS NULL THEN 'General' ELSE routine.title END AS parent_title,
      CASE WHEN task.source = 'daily' AND task.source_ref LIKE ? THEN 1 ELSE 0 END AS is_new
    FROM daily_scrum_task_selections AS selection
    INNER JOIN items AS task ON task.id = selection.task_id AND task.owner_id = selection.owner_id
    INNER JOIN item_assignments AS assignment ON assignment.owner_id = task.owner_id AND assignment.item_id = task.id
      AND assignment.member_id = ? AND assignment.role = 'task_assignee'
    LEFT JOIN items AS project ON project.id = task.parent_id AND project.owner_id = task.owner_id
    LEFT JOIN routines AS routine ON routine.id = task.routine_id AND routine.owner_id = task.owner_id
    WHERE selection.owner_id = ? AND selection.daily_scrum_id = ? AND selection.member_id = ?
      AND task.archived_at IS NULL AND task.status NOT IN ('done', 'development_done', 'archived')
    ORDER BY selection.created_at`)
    .bind(`daily:${memberId}:${date}:%`, memberId, ownerId, draftId, memberId).all<{
      id: string; title: string; status: string; parent_kind: string; parent_id: string | null; parent_title: string; is_new: number;
    }>();
  return rows.results;
}

async function snapshotsForSubmissions(submissionIds: string[]) {
  if (!submissionIds.length) return [] as SnapshotRow[];
  const placeholders = submissionIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT * FROM daily_task_snapshots WHERE submission_id IN (${placeholders}) ORDER BY sort_order`)
    .bind(...submissionIds).all<SnapshotRow>();
  return rows.results;
}

function serializeSubmission(row: SubmissionRow, snapshots: SnapshotRow[]): DailySubmissionValue {
  const yesterdayWork = dailyWorkSnapshots(row.yesterday_work_snapshot_json);
  return {
    work: dailyWorkSnapshots(row.work_snapshot_json),
    yesterdayWork,
    newlyCompletedCount: yesterdayWork.filter((entry) => entry.willCompleteOnSubmit).length + dailyWorkSnapshots(row.work_snapshot_json).filter((entry) => entry.completedToday).length,
    id: row.id,
    memberId: row.member_id,
    memberName: row.member_name,
    memberEmail: row.member_email,
    date: row.scrum_date,
    version: Number(row.version),
    yesterdayNote: row.yesterday_note,
    todayNote: row.today_note,
    blockersNote: row.blockers_note,
    noPlannedTasks: Boolean(row.no_planned_tasks),
    skipReason: normalizeDailySkipReason(row.skip_reason),
    skipNote: row.skip_note,
    source: row.source,
    submittedAt: row.submitted_at,
    tasks: snapshots.map((snapshot) => ({
      id: snapshot.id,
      taskId: snapshot.task_id,
      taskTitle: snapshot.task_title,
      parentKind: snapshot.parent_kind,
      parentId: snapshot.parent_id,
      parentTitle: snapshot.parent_title,
      status: snapshot.status,
      isNew: Boolean(snapshot.is_new),
      sortOrder: Number(snapshot.sort_order),
    })),
  };
}

async function dailyTimezone(db: D1Database, ownerId: string, memberId: string) {
  const row = await db.prepare(`SELECT COALESCE(preference.timezone, settings.timezone, 'Asia/Seoul') AS timezone
    FROM (SELECT ? AS owner_id) input
    LEFT JOIN slack_daily_settings settings ON settings.owner_id = input.owner_id
    LEFT JOIN slack_daily_preferences preference ON preference.owner_id = input.owner_id AND preference.member_id = ?`)
    .bind(ownerId, memberId).first<{ timezone: string }>();
  const timezone = row?.timezone || "Asia/Seoul";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return timezone; } catch { return "Asia/Seoul"; }
}

function serializeCandidate(row: CandidateRow): DailyTaskCandidate {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    dueDate: row.due_date,
    parentKind: row.parent_kind,
    parentId: row.parent_id,
    parentTitle: row.parent_title,
  };
}

function groupCandidates(tasks: DailyTaskCandidate[]) {
  const groups = new Map<string, { key: string; kind: string; id: string | null; title: string; tasks: DailyTaskCandidate[] }>();
  for (const task of tasks) {
    const key = `${task.parentKind}:${task.parentId ?? "general"}`;
    const group = groups.get(key) ?? { key, kind: task.parentKind, id: task.parentId, title: task.parentTitle, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function serializeMember(member: WorkspaceMember) {
  return { id: member.id, displayName: member.displayName || member.email || "멤버", email: member.email || "", role: member.role };
}

function uniqueIds(values: string[]) {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))];
}

function cleanNote(value: string | undefined) {
  return (value ?? "").trim().slice(0, 4000);
}

function cleanSkipNote(value: string | undefined) {
  return (value ?? "").trim().slice(0, 500);
}

export function normalizeDailySkipReason(value: unknown): DailySkipReason | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && DAILY_SKIP_REASONS.includes(value as DailySkipReason)) return value as DailySkipReason;
  throw new Error("올바른 데일리 스킵 사유를 선택해 주세요.");
}

export function dailySkipReasonLabel(reason: DailySkipReason) {
  return dailySkipReasonLabels[reason];
}

function normalizeRequestId(value: string | undefined) {
  const cleaned = (value ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return cleaned || crypto.randomUUID();
}

export function normalizeDailyDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("올바른 날짜를 입력해 주세요.");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("올바른 날짜를 입력해 주세요.");
  return value;
}

export function isCompletedDailyStatus(status: string) {
  return completedStatuses.has(status);
}
