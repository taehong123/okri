import { env } from "cloudflare:workers";
import { createExplicitDailyTask, currentDailyMember, normalizeDailySkipReason, saveDailyDraft, submitDailyDraft } from "@/lib/daily-bot";
import { DAILY_CHECKLIST_PAGE_SIZE, dailyChecklistForm, dailyChoiceBlockId, dailyNoPlannedActionId, orderDailyChecklist, type DailyChecklist } from "@/lib/slack-daily-form";
import { normalizeDailyWorkStatus, parseDailyWorkStatuses } from "@/lib/daily-work-status";
import type { RequestAuthorization } from "@/lib/pace-data";
import type { Translator } from "@/lib/server-language";

type ModalState = Record<string, Record<string, Record<string, unknown>>>;
type StoredChecklist = { payload_json: string; revision: number };
const metadataFor = (id: string, revision: number) => JSON.stringify({ id, revision });

export async function createDailyChecklist(ownerId: string, memberId: string, input: DailyChecklist, t: Translator) {
  const id = crypto.randomUUID();
  const choices = { ...input.choices };
  const statusOptions = parseDailyWorkStatuses(input.workStatusOptions);
  const requestedStatus = input.skipReason ? "skip" as const : normalizeDailyWorkStatus(input.workStatus);
  if (input.taskFocused) {
    for (const key of Object.keys(choices)) if (!key.startsWith("task:")) delete choices[key];
  }
  const value = { ...input, choices, work: orderDailyChecklist(input.work), page: 0,
    ...(input.taskFocused ? { noPlannedTasks: false, workStatus: statusOptions.includes(requestedStatus) ? requestedStatus : statusOptions[0] } : {}) };
  const now = new Date().toISOString();
  await env.DB.prepare("DELETE FROM slack_daily_checklists WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("INSERT INTO slack_daily_checklists (id, owner_id, member_id, payload_json, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, ownerId, memberId, JSON.stringify(value), new Date(Date.now() + 24 * 60 * 60_000).toISOString()).run();
  return dailyChecklistForm(value, metadataFor(id, 0), t);
}

export function mergeDailyChecklist(input: DailyChecklist, state: ModalState, t: Translator) {
  const next: DailyChecklist = { ...input, choices: { ...input.choices } };
  if (input.taskFocused) {
    for (const key of Object.keys(next.choices)) if (!key.startsWith("task:")) delete next.choices[key];
  }
  const errors: Record<string, string> = {};
  const start = input.page * DAILY_CHECKLIST_PAGE_SIZE;
  input.work.slice(start, start + DAILY_CHECKLIST_PAGE_SIZE).forEach((entry, offset) => {
    if (input.taskFocused && entry.kind !== "task") { delete next.choices[entry.key]; return; }
    const block = dailyChoiceBlockId(input, entry, start + offset);
    const field = state[block]?.choice;
    if (!field) return;
    const choices = field.selected_options ?? [];
    // Old open modals may still send "exclude"; never reinterpret it as deletion.
    if (!Array.isArray(choices) || choices.some((option) => !["today", "done", "delete", "exclude"].includes(option?.value)) || choices.length > 1) {
      errors[block] = t("업무마다 한 가지 상태만 선택해 주세요."); return;
    }
    if (choices.some((option) => option.value === "delete") && entry.kind !== "task") {
      errors[block] = t("데일리에서는 개별 Task만 삭제할 수 있습니다."); return;
    }
    delete next.choices[entry.key];
    if (choices.length) next.choices[entry.key] = choices[0].value;
  });
  if (next.taskEntry && state.daily_new_task?.title) next.taskEntry = { ...next.taskEntry, title: String(state.daily_new_task.title.value ?? "") };
  for (const [block, key] of [["today_note", "todayNote"], ["yesterday_note", "yesterdayNote"], ["blockers_note", "blockersNote"], ["skip_note", "skipNote"]] as const) {
    if (state[block]?.value) next[key] = String(state[block].value.value ?? "");
  }
  const noPlanned = state.no_planned?.[dailyNoPlannedActionId(input)];
  if (input.taskFocused) next.noPlannedTasks = false;
  else if (noPlanned) next.noPlannedTasks = Array.isArray(noPlanned.selected_options) && noPlanned.selected_options.some((option) => option?.value === "yes");
  if (state.skip_reason?.value) {
    const selected = state.skip_reason.value.selected_option as { value?: string } | null;
    next.skipReason = selected?.value === "none" ? null : selected?.value ?? null;
  }
  if (input.taskFocused && state.work_status?.value) {
    const selected = state.work_status.value.selected_option as { value?: string } | null;
    const statuses = parseDailyWorkStatuses(input.workStatusOptions);
    if (!selected?.value || !statuses.includes(selected.value as (typeof statuses)[number])) errors.work_status = t("올바른 근무 상태를 선택해 주세요.");
    else next.workStatus = normalizeDailyWorkStatus(selected.value);
  }
  return { next, errors };
}

export async function editDailyChecklistTask(authorization: RequestAuthorization, metadata: string, state: ModalState,
  action: "add" | "create" | "cancel", parentKey: string, t: Translator) {
  const member = await currentDailyMember(authorization);
  if (authorization.role === "viewer" || member.role === "viewer") throw new Error("읽기 전용 멤버는 Task를 만들 수 없습니다.");
  const parsed = JSON.parse(metadata) as { id: string; revision: number };
  if (!parsed || typeof parsed.id !== "string" || !Number.isSafeInteger(parsed.revision)) throw new Error("데일리를 다시 열어 주세요.");
  const stored = await env.DB.prepare("SELECT payload_json, revision FROM slack_daily_checklists WHERE id = ? AND owner_id = ? AND member_id = ? AND expires_at > ?")
    .bind(parsed.id, authorization.ownerId, member.id, new Date().toISOString()).first<StoredChecklist>();
  if (!stored) throw new Error("데일리를 다시 열어 주세요.");
  const input = JSON.parse(stored.payload_json) as DailyChecklist;
  if (stored.revision !== parsed.revision) return dailyChecklistForm(input, metadataFor(parsed.id, stored.revision), t, t("다른 요청에서 목록이 변경되었습니다. 현재 선택을 확인해 주세요."));
  if (input.taskEntry?.creating) return dailyChecklistForm(input, metadata, t, t("처리 중"));
  const { next, errors } = mergeDailyChecklist(input, state, t);
  // Opening/cancelling the editor must not validate unrelated, unfinished Task choices.
  if (action === "create" && Object.keys(errors).length) return dailyChecklistForm(next, metadata, t, Object.values(errors).join("\n"));
  if (!next.taskFocused || !next.taskTargets?.some((target) => target.key === parentKey)) throw new Error("본인이 담당한 Project 또는 Routine만 선택할 수 있습니다.");
  if (action === "add") next.taskEntry = { parentKey, title: "", requestId: crypto.randomUUID() };
  if (action === "cancel") delete next.taskEntry;
  if (action !== "create") delete next.createdTaskKey;
  if (action === "create") {
    if (!next.taskEntry || next.taskEntry.parentKey !== parentKey) throw new Error("Task 생성 요청을 다시 확인해 주세요.");
    if (!next.taskEntry.title.trim()) return dailyChecklistForm(next, metadata, t, t("새 Task 제목을 입력해 주세요."));
    if (next.workStatus === "skip" || next.skipReason) return dailyChecklistForm(next, metadata, t, t("스킵을 해제하면 Task를 만들 수 있습니다."));
    if (Object.values(next.choices).filter((value) => ["today", "done", "delete"].includes(value)).length >= 50) {
      return dailyChecklistForm(next, metadata, t, t("오늘 할 업무는 최대 50개까지 선택할 수 있습니다."));
    }
    next.taskEntry.creating = true;
  }
  // Claim this revision before creating anything so simultaneous Slack actions cannot create twice.
  const claim = await env.DB.prepare("UPDATE slack_daily_checklists SET payload_json = ?, revision = revision + 1 WHERE id = ? AND owner_id = ? AND member_id = ? AND revision = ?")
    .bind(JSON.stringify(next), parsed.id, authorization.ownerId, member.id, parsed.revision).run();
  if (!claim.meta.changes) throw new Error("다른 요청에서 목록이 변경되었습니다. 현재 선택을 확인해 주세요.");
  const revision = parsed.revision + 1;
  if (action === "create" && next.taskEntry) {
    try {
      const [kind, id] = parentKey.split(":", 2);
      const task = await createExplicitDailyTask(authorization, { date: next.date, title: next.taskEntry.title,
        parentKind: kind === "project" ? "project" : "routine", parentId: id, requestId: next.taskEntry.requestId });
      const target = next.taskTargets!.find((target) => target.key === parentKey)!;
      if (!next.work.some((entry) => entry.key === `task:${task.id}`)) next.work.push({
        id: task.id, key: `task:${task.id}`, kind: "task", title: task.title, status: task.status, priority: task.priority,
        dueDate: task.dueDate, parentId: id, parentKind: kind, parentTitle: target.title,
      });
      next.work = orderDailyChecklist(next.work);
      next.choices[`task:${task.id}`] = "today";
      next.createdTaskKey = `task:${task.id}`;
      next.noPlannedTasks = false;
      next.page = Math.floor(next.work.findIndex((entry) => entry.key === `task:${task.id}`) / DAILY_CHECKLIST_PAGE_SIZE);
      delete next.taskEntry;
      const saved = await env.DB.prepare("UPDATE slack_daily_checklists SET payload_json = ?, revision = revision + 1 WHERE id = ? AND owner_id = ? AND member_id = ? AND revision = ?")
        .bind(JSON.stringify(next), parsed.id, authorization.ownerId, member.id, revision).run();
      if (!saved.meta.changes) throw new Error("다른 요청에서 목록이 변경되었습니다. 현재 선택을 확인해 주세요.");
      return dailyChecklistForm(next, metadataFor(parsed.id, revision + 1), t);
    } catch (error) {
      // Retain the request ID and title so a retry can recover an already-created Task.
      next.taskEntry = { ...input.taskEntry!, title: String(state.daily_new_task?.title?.value ?? input.taskEntry?.title ?? ""), creating: false };
      await env.DB.prepare("UPDATE slack_daily_checklists SET payload_json = ?, revision = revision + 1 WHERE id = ? AND owner_id = ? AND member_id = ? AND revision = ?")
        .bind(JSON.stringify(next), parsed.id, authorization.ownerId, member.id, revision).run();
      throw error;
    }
  }
  return dailyChecklistForm(next, metadataFor(parsed.id, revision), t);
}

export async function handleDailyChecklist(authorization: RequestAuthorization, metadata: string, state: ModalState, previous: boolean, t: Translator): Promise<{
  errors?: Record<string, string>; view?: ReturnType<typeof dailyChecklistForm>; submission?: Awaited<ReturnType<typeof submitDailyDraft>>;
}> {
  if (authorization.role === "viewer") throw new Error("읽기 전용 멤버는 데일리를 제출할 수 없습니다.");
  const member = await currentDailyMember(authorization);
  const parsed = JSON.parse(metadata) as { id: string; revision: number };
  if (!parsed || typeof parsed.id !== "string" || !Number.isSafeInteger(parsed.revision)) throw new Error("데일리를 다시 열어 주세요.");
  const stored = await env.DB.prepare("SELECT payload_json, revision FROM slack_daily_checklists WHERE id = ? AND owner_id = ? AND member_id = ? AND expires_at > ?")
    .bind(parsed.id, authorization.ownerId, member.id, new Date().toISOString()).first<StoredChecklist>();
  if (!stored) throw new Error("데일리를 다시 열어 주세요.");
  const input = JSON.parse(stored.payload_json) as DailyChecklist;
  if (input.taskEntry?.creating) return { view: dailyChecklistForm(input, metadataFor(parsed.id, stored.revision), t, t("처리 중")) };
  if (stored.revision !== parsed.revision) return { view: dailyChecklistForm(input, metadataFor(parsed.id, stored.revision), t, t("다른 요청에서 목록이 변경되었습니다. 현재 선택을 확인해 주세요.")) };
  const { next, errors } = mergeDailyChecklist(input, state, t);
  const problem = (errors: Record<string, string>) => ({ errors, view: dailyChecklistForm(next, metadata, t, [...new Set(Object.values(errors))].join("\n")) });
  if (Object.keys(errors).length) return problem(errors);
  const pages = Math.max(1, Math.ceil(input.work.length / DAILY_CHECKLIST_PAGE_SIZE));
  const selected = (choice: string) => Object.entries(next.choices)
    .filter(([key, value]) => value === choice && (!next.taskFocused || key.startsWith("task:"))).map(([key]) => key);
  const today = selected("today"), done = selected("done"), deleted = selected("delete");
  const validationBlock = next.taskFocused ? "work_status" : "no_planned";
  if (today.length + done.length + deleted.length > 50) return problem({ [validationBlock]: t("오늘 할 업무는 최대 50개까지 선택할 수 있습니다.") });
  if (previous || input.page + 1 < pages) {
    next.page = Math.max(0, Math.min(pages - 1, input.page + (previous ? -1 : 1)));
    const result = await env.DB.prepare("UPDATE slack_daily_checklists SET payload_json = ?, revision = revision + 1 WHERE id = ? AND owner_id = ? AND member_id = ? AND revision = ?")
      .bind(JSON.stringify(next), parsed.id, authorization.ownerId, member.id, parsed.revision).run();
    if (!result.meta.changes) throw new Error("다른 요청에서 목록이 변경되었습니다. 현재 선택을 확인해 주세요.");
    return { view: dailyChecklistForm(next, metadataFor(parsed.id, parsed.revision + 1), t) };
  }
  if (next.taskEntry?.title.trim()) return problem({ daily_new_task: t("작성 중인 Task를 추가하거나 취소해 주세요.") });
  const skipReason = normalizeDailySkipReason(next.skipReason);
  const workStatus = skipReason ? "skip" : normalizeDailyWorkStatus(next.workStatus);
  const skipping = workStatus === "skip";
  if (skipping && (today.length || done.length || deleted.length)) return problem({ [next.taskFocused ? "work_status" : "skip_reason"]: t("스킵하려면 선택한 Task를 먼저 해제해 주세요.") });
  if (next.noPlannedTasks && today.length) return problem({ no_planned: t("오늘 예정 없음과 오늘 할 일을 함께 선택할 수 없습니다.") });
  if (!skipping && next.taskFocused && !today.length && !done.length) return problem({ work_status: t("오늘 진행하거나 완료한 Task를 하나 이상 선택해 주세요.") });
  if (!skipping && !next.taskFocused && !next.noPlannedTasks && !today.length && !done.length && !deleted.length && !next.todayNote.trim()) return problem({ no_planned: t("오늘 할 업무 또는 ‘오늘 예정 없음’을 선택해 주세요.") });
  if (skipReason === "other" && !next.skipNote.trim()) return problem({ skip_note: t("기타 스킵 사유를 입력해 주세요.") });
  // Replays return the durable submission before revalidating already-completed work.
  const receipt = await env.DB.prepare("SELECT id FROM daily_submissions WHERE owner_id = ? AND member_id = ? AND request_id = ?")
    .bind(authorization.ownerId, member.id, parsed.id).first();
  if (!receipt) {
    await saveDailyDraft(authorization, { date: next.date, todayNote: next.todayNote, yesterdayNote: next.yesterdayNote, blockersNote: next.blockersNote,
      selectedWorkIds: today, selectedYesterdayWorkIds: next.selectedYesterday.filter((key) => key.startsWith("task:") && !today.includes(key) && !done.includes(key) && !deleted.includes(key)),
      noPlannedTasks: !next.taskFocused && (next.noPlannedTasks || (!today.length && done.length + deleted.length > 0)), workStatus,
      skipReason, skipNote: next.skipNote, source: "slack" }, false);
  }
  return { submission: await submitDailyDraft(authorization, next.date, "slack", parsed.id, done, deleted) };
}

export async function retryDailyChecklist(authorization: RequestAuthorization, metadata: string, state: ModalState, message: string, t: Translator) {
  const member = await currentDailyMember(authorization);
  const parsed = JSON.parse(metadata) as { id: string };
  const stored = await env.DB.prepare("SELECT payload_json, revision FROM slack_daily_checklists WHERE id = ? AND owner_id = ? AND member_id = ? AND expires_at > ?")
    .bind(parsed.id, authorization.ownerId, member.id, new Date().toISOString()).first<StoredChecklist>();
  if (!stored) return null;
  const input = JSON.parse(stored.payload_json) as DailyChecklist;
  return dailyChecklistForm(mergeDailyChecklist(input, state, t).next, metadataFor(parsed.id, stored.revision), t, message);
}
