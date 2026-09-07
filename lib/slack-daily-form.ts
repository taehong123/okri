import type { DailyWork } from "@/lib/daily-work";
import type { Translator } from "@/lib/server-language";

const names = { project: "Project", task: "Task", routine: "Routine" };
const identityTranslator: Translator = (key) => key;

export type DailyChecklist = {
  date: string; memberName: string; work: DailyWork[]; selectedYesterday: string[]; yesterdayCompleted?: DailyWork[];
  choices: Record<string, "today" | "done" | "delete" | "exclude">;
  todayNote: string; yesterdayNote: string; blockersNote: string;
  noPlannedTasks: boolean; skipReason: string | null; skipNote: string; page: number;
  taskFocused?: boolean;
  taskTargets?: Array<{ key: string; title: string; hasTasks?: boolean }>;
  taskEntry?: { parentKey: string; title: string; requestId: string; creating?: boolean };
  createdTaskKey?: string;
};
export const DAILY_CHECKLIST_PAGE_SIZE = 20;

// Slack preserves inputs by block/action ID; inserting a Task must not shift another Task's choice.
export function dailyChoiceBlockId(input: DailyChecklist, entry: DailyWork, index: number) {
  return `daily_choice_${input.taskFocused ? entry.key : index}`;
}
export function dailyNoPlannedActionId(input: DailyChecklist) {
  return input.taskFocused ? `value_${input.work.length}` : "value";
}

export function dailyWorkGroup(work: DailyWork) {
  if (work.kind === "project") return { key: `project:${work.id}`, title: work.title };
  if (work.kind === "routine") return { key: `routine:${work.id}`, title: work.title };
  return { key: work.parentId ? `${work.parentKind}:${work.parentId}` : "general", title: work.parentId ? work.parentTitle : "General" };
}

export function orderDailyChecklist(work: DailyWork[]) {
  const groups = new Map<string, DailyWork[]>();
  for (const entry of work) {
    const key = dailyWorkGroup(entry).key;
    const rows = groups.get(key) ?? [];
    rows.push(entry); groups.set(key, rows);
  }
  return [...groups.values()].flatMap((rows) => rows.sort((a, b) => Number(b.kind !== "task") - Number(a.kind !== "task")));
}

export function dailyChecklistForm(input: DailyChecklist, metadata: string, t: Translator = identityTranslator, error = "") {
  const pages = Math.max(1, Math.ceil(input.work.length / DAILY_CHECKLIST_PAGE_SIZE));
  const blocks: Record<string, unknown>[] = [
    { type: "section", text: { type: "plain_text", text: `${input.memberName} · ${input.date}\n${t("완료와 삭제는 제출할 때 반영됩니다. 삭제한 Task는 업무 목록에서 사라지며 휴지통에서 복구할 수 있습니다.")}` } },
    { type: "context", elements: [{ type: "plain_text", text: t("{page} / {pages} · 전체 {count}개", { page: input.page + 1, pages, count: input.work.length }) }] },
  ];
  const pageWork = input.work.slice(input.page * DAILY_CHECKLIST_PAGE_SIZE, (input.page + 1) * DAILY_CHECKLIST_PAGE_SIZE);
  const editingOnPage = input.taskEntry && pageWork.some((entry) => dailyWorkGroup(entry).key === input.taskEntry!.parentKey);
  if (error && !editingOnPage) blocks.push({ type: "section", text: { type: "plain_text", text: error } });
  let lastGroup = "";
  pageWork.forEach((entry, offset) => {
    const group = dailyWorkGroup(entry);
    if (group.key !== lastGroup) {
      const target = input.taskTargets?.find((target) => target.key === group.key);
      const emptyContainer = input.taskFocused && (entry.kind === "project" || entry.kind === "routine")
        && !input.work.some((task) => task.kind === "task" && task.parentKind === entry.kind && task.parentId === entry.id);
      const addButton = target && !input.taskEntry ? { type: "button", action_id: "daily_checklist_add_task", text: { type: "plain_text", text: t("Task 추가") }, value: target.key } : null;
      const containerKind = group.key.startsWith("project:") ? "project" : group.key.startsWith("routine:") ? "routine" : null;
      const groupTitle = containerKind ? `${t(names[containerKind])} · ${group.title}` : group.key === "general" ? t("General") : group.title;
      blocks.push({ type: "section", text: { type: "plain_text", text: groupTitle.slice(0, 2900) },
        ...(!emptyContainer && addButton ? { accessory: addButton } : {}) });
      lastGroup = group.key;
      if (emptyContainer) {
        blocks.push({ type: "context", elements: [{ type: "plain_text", text: t(target?.hasTasks === false ? "아직 Task가 없습니다." : "내게 할당된 미완료 Task가 없습니다.") }] });
        if (addButton) blocks.push({ type: "actions", block_id: `daily_add_${group.key}`, elements: [addButton] });
      }
      if (input.taskEntry?.parentKey === group.key) {
        if (input.taskEntry.creating) {
          blocks.push({ type: "section", text: { type: "plain_text", text: t("처리 중") } });
        } else {
          blocks.push({ type: "input", block_id: "daily_new_task", optional: true, label: { type: "plain_text", text: t("새 Task 제목") },
            element: { type: "plain_text_input", action_id: "title", max_length: 240, focus_on_load: true,
              ...(input.taskEntry.title ? { initial_value: input.taskEntry.title } : {}) } });
          blocks.push({ type: "actions", elements: [
            { type: "button", action_id: "daily_checklist_create_task", text: { type: "plain_text", text: t("추가하고 오늘 할 일에 선택") }, style: "primary", value: group.key },
            { type: "button", action_id: "daily_checklist_cancel_task", text: { type: "plain_text", text: t("취소") }, value: group.key },
          ] });
        }
        if (error) blocks.push({ type: "section", text: { type: "plain_text", text: error } });
      }
    }
    if (input.taskFocused && entry.kind !== "task") return;
    if (entry.title.length > 180) blocks.push({ type: "section", text: { type: "plain_text", text: entry.title.slice(0, 2900) } });
    const options = [["today", "오늘 할 일"], ["done", "완료"], ...(entry.kind === "task" ? [["delete", "삭제"]] : [])]
      .map(([value, text]) => ({ text: { type: "plain_text", text: t(text) }, value }));
    const initial = options.filter((option) => option.value === input.choices[entry.key]);
    const due = entry.dueDate ? `${entry.dueDate}${entry.dueDate < input.date ? ` · ${t("기한 초과")}` : ""}` : "";
    blocks.push({ type: "input", block_id: dailyChoiceBlockId(input, entry, input.page * DAILY_CHECKLIST_PAGE_SIZE + offset), optional: true,
      label: { type: "plain_text", text: entry.title.slice(0, 180) || t(names[entry.kind]) },
      hint: { type: "plain_text", text: `${t(names[entry.kind])}${due ? ` · ${due}` : ""}` },
      element: { type: "checkboxes", action_id: "choice", options, ...(initial.length ? { initial_options: initial } : {}) } });
    if (entry.key === input.createdTaskKey) blocks.push({ type: "context", elements: [{ type: "plain_text", text: t("Task를 추가하고 오늘 할 일에 선택했습니다.") }] });
  });
  if (!input.work.length) blocks.push({ type: "section", text: { type: "plain_text", text: t("현재 배정된 미완료 업무가 없습니다.") } });
  if (input.yesterdayCompleted?.length) blocks.push({ type: "section", text: { type: "plain_text", text: `${t("완료한 일")}\n${input.yesterdayCompleted.slice(0, 20).map((entry) => `• ${entry.title}`).join("\n")}`.slice(0, 2900) } });
  const none = { text: { type: "plain_text", text: t("오늘 예정 없음") }, value: "yes" };
  blocks.push({ type: "input", block_id: "no_planned", optional: true, label: { type: "plain_text", text: t("오늘 예정") },
    element: { type: "checkboxes", action_id: dailyNoPlannedActionId(input), options: [none], ...(input.noPlannedTasks ? { initial_options: [none] } : {}) } });
  for (const [blockId, label, value] of [["yesterday_note", "완료 메모", input.yesterdayNote], ["today_note", "오늘 메모", input.todayNote], ["blockers_note", "도움이 필요한 일", input.blockersNote]]) {
    blocks.push({ type: "input", block_id: blockId, optional: true, label: { type: "plain_text", text: t(label) },
      element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000, ...(value ? { initial_value: value } : {}) } });
  }
  const skipOptions = [["none", "스킵하지 않음"], ["workload", "본업 과중"], ["vacation", "휴가"], ["personal", "개인 일정"], ["other", "기타"]]
    .map(([value, label]) => ({ text: { type: "plain_text", text: t(label) }, value }));
  blocks.push({ type: "input", block_id: "skip_reason", optional: true, label: { type: "plain_text", text: t("데일리 스킵") },
    element: { type: "static_select", action_id: "value", options: skipOptions, initial_option: skipOptions.find((option) => option.value === (input.skipReason || "none")) } });
  blocks.push({ type: "input", block_id: "skip_note", optional: true, label: { type: "plain_text", text: t("스킵 상세 사유") },
    element: { type: "plain_text_input", action_id: "value", max_length: 500, ...(input.skipNote ? { initial_value: input.skipNote } : {}) } });
  if (input.page > 0) blocks.push({ type: "actions", elements: [{ type: "button", action_id: "daily_checklist_previous", text: { type: "plain_text", text: t("이전") }, value: "previous" }] });
  return { type: "modal", callback_id: "daily_checklist_submit", private_metadata: metadata,
    title: { type: "plain_text", text: t("데일리") }, submit: { type: "plain_text", text: t(input.page + 1 < pages ? "다음" : "제출") },
    close: { type: "plain_text", text: t("취소") }, blocks };
}

export function dailyWorkOption(work: DailyWork, t: Translator = identityTranslator, mode: "today" | "yesterday" = "today") {
  const detail = mode === "yesterday" && work.willCompleteOnSubmit
    ? `${work.parentTitle} · ${t("제출 시 완료 처리")}`
    : `${work.parentTitle}${work.dueDate ? ` · ${work.dueDate}` : ""}`;
  return { text: { type: "plain_text", text: `${t(names[work.kind])} · ${work.title}`.slice(0, 75) }, value: work.key,
    description: { type: "plain_text", text: detail.slice(0, 75) } };
}

export function dailyWorkBlocks(work: DailyWork[], selected: string[], t: Translator = identityTranslator) {
  const visible = work.slice(0, 60);
  const blocks: Record<string, unknown>[] = [];
  for (const kind of ["project", "task", "routine"] as const) {
    const rows = visible.filter((entry) => entry.kind === kind);
    for (let offset = 0; offset < rows.length; offset += 10) {
      const options = rows.slice(offset, offset + 10).map((entry) => dailyWorkOption(entry, t));
      const initial = options.filter((option) => selected.includes(option.value));
      blocks.push({ type: "input", block_id: `daily_work_${kind}_${offset}`, optional: true,
        label: { type: "plain_text", text: offset ? t("{kind} (계속)", { kind: t(names[kind]) }) : t(names[kind]) },
        element: { type: "checkboxes", action_id: "selected_work", options, ...(initial.length ? { initial_options: initial } : {}) } });
    }
  }
  if (!work.length) blocks.push({ type: "section", text: { type: "plain_text", text: t("현재 배정된 미완료 업무가 없습니다.") } });
  if (work.length > visible.length) {
    const initial = work.slice(visible.length).filter((entry) => selected.includes(entry.key)).map((entry) => dailyWorkOption(entry, t));
    blocks.push({ type: "input", block_id: "daily_work_more", optional: true, label: { type: "plain_text", text: t("나머지 업무 {count}개", { count: work.length - visible.length }) },
      element: { type: "multi_external_select", action_id: "selected_more_work", min_query_length: 0, max_selected_items: 50,
        placeholder: { type: "plain_text", text: t("나머지 내 업무 검색") }, ...(initial.length ? { initial_options: initial } : {}) } });
  }
  return blocks;
}

function dailyWorkSelect(work: DailyWork[], selected: string[], mode: "today" | "yesterday", t: Translator) {
  const initial = work.filter((entry) => selected.includes(entry.key)).slice(0, 50).map((entry) => dailyWorkOption(entry, t, mode));
  return { type: "input", block_id: mode === "yesterday" ? "yesterday_work" : "today_work", optional: true,
    label: { type: "plain_text", text: t(mode === "yesterday" ? "완료한 일" : "오늘 할 일") },
    element: { type: "multi_external_select", action_id: mode === "yesterday" ? "selected_yesterday_work" : "selected_today_work",
      min_query_length: 0, max_selected_items: 50,
      placeholder: { type: "plain_text", text: t(mode === "yesterday" ? "완료했거나 완료할 업무 검색" : "오늘 할 업무 검색") },
      ...(initial.length ? { initial_options: initial } : {}) } };
}

export function dailyForm(input: { work: DailyWork[]; yesterdayWork: DailyWork[]; memberName: string; date: string; selected: string[]; selectedYesterday: string[]; yesterdayNote: string; todayNote: string; blockersNote: string; noPlannedTasks: boolean; skipReason: string | null; skipNote: string; metadata: string }, t: Translator = identityTranslator) {
  const skipOptions = [["none", "스킵하지 않음"], ["workload", "본업 과중"], ["vacation", "휴가"], ["personal", "개인 일정"], ["other", "기타"]]
    .map(([value, text]) => ({ text: { type: "plain_text", text: t(text) }, value }));
  const none = { text: { type: "plain_text", text: t("오늘 예정 없음") }, value: "yes" };
  return { type: "modal", callback_id: "daily_submit", private_metadata: input.metadata,
    title: { type: "plain_text", text: t("데일리") }, submit: { type: "plain_text", text: t("선택한 업무 제출") }, close: { type: "plain_text", text: t("취소") }, blocks: [
      { type: "section", text: { type: "plain_text", text: t("{member} · {date}\n완료한 일과 오늘 할 일을 선택하세요.", { member: input.memberName, date: input.date }) } },
      dailyWorkSelect(input.yesterdayWork, input.selectedYesterday, "yesterday", t),
      { type: "input", block_id: "yesterday_note", optional: true, label: { type: "plain_text", text: t("완료 메모") }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000, ...(input.yesterdayNote ? { initial_value: input.yesterdayNote } : {}) } },
      dailyWorkSelect(input.work, input.selected, "today", t),
      { type: "input", block_id: "no_planned", optional: true, label: { type: "plain_text", text: t("오늘 예정") }, element: { type: "checkboxes", action_id: "value", options: [none], ...(input.noPlannedTasks ? { initial_options: [none] } : {}) } },
      { type: "input", block_id: "today_note", optional: true, label: { type: "plain_text", text: t("오늘 메모") }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000, ...(input.todayNote ? { initial_value: input.todayNote } : {}) } },
      { type: "input", block_id: "blockers_note", optional: true, label: { type: "plain_text", text: t("도움이 필요한 일") }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000, ...(input.blockersNote ? { initial_value: input.blockersNote } : {}) } },
      { type: "input", block_id: "skip_reason", optional: true, label: { type: "plain_text", text: t("데일리 스킵") }, element: { type: "static_select", action_id: "value", options: skipOptions, initial_option: skipOptions.find((o) => o.value === (input.skipReason || "none")) } },
      { type: "input", block_id: "skip_note", optional: true, label: { type: "plain_text", text: t("스킵 상세 사유") }, element: { type: "plain_text_input", action_id: "value", max_length: 500, ...(input.skipNote ? { initial_value: input.skipNote } : {}) } },
    ] };
}
