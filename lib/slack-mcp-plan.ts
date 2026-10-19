import type { SlackMcpStoredToolTurn } from "./slack-mcp-continuity";

export type SlackWorkPlanItem = {
  key: string;
  kind: "project" | "task" | "routine" | "ticket";
  title: string;
  parentTitle?: string;
  dependsOn?: string;
  dueDate?: string;
  existingId?: string;
  record?: { id: string; title: string; parentId?: string | null; routineId?: string | null; dueDate?: string | null };
  reviewId?: string;
};

export function workName(value: string) { return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function updateWorkPlan(previous: SlackWorkPlanItem[], value: unknown): SlackWorkPlanItem[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new Error("Provide 1–30 requested work items.");
  const next = new Map(previous.map((item) => [item.key, item]));
  for (const raw of value) {
    const item = object(raw);
    if (typeof item.key !== "string" || !/^[a-z0-9_-]{1,60}$/i.test(item.key)
      || typeof item.title !== "string" || !item.title.trim() || item.title.length > 500
      || !["project", "task", "routine", "ticket"].includes(String(item.kind))) throw new Error("Each item needs a stable key, kind and concrete title.");
    const old = next.get(item.key);
    const sameItem = old && old.kind === item.kind && workName(old.title) === workName(item.title);
    const unchanged = sameItem
      && (old.dependsOn || "") === (item.depends_on || "") && (old.parentTitle || "") === (item.parent_title || "");
    next.set(item.key, {
      key: item.key, kind: item.kind as SlackWorkPlanItem["kind"], title: item.title.trim(),
      ...(typeof item.parent_title === "string" ? { parentTitle: item.parent_title.slice(0, 500) } : {}),
      ...(typeof item.depends_on === "string" && item.depends_on ? { dependsOn: item.depends_on } : {}),
      ...(typeof item.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.due_date) ? { dueDate: item.due_date } : {}),
      ...(typeof item.existing_id === "string" && item.existing_id.length <= 128 ? { existingId: item.existing_id } : sameItem && old?.existingId ? { existingId: old.existingId } : {}),
      ...((unchanged || sameItem && item.kind === "task") && old?.record && (!item.existing_id || item.existing_id === old.record.id) ? { record: old.record } : {}),
      ...(unchanged && old?.reviewId ? { reviewId: old.reviewId } : {}),
    });
  }
  const items = [...next.values()];
  if (items.length > 30 || items.some((item) => item.dependsOn && (!next.has(item.dependsOn) || item.dependsOn === item.key))) {
    throw new Error("Every dependency must name another item in the same plan (maximum 30 items).");
  }
  for (const item of items) {
    if (item.kind !== "task" && item.dependsOn) throw new Error("Only a Task uses depends_on. A Project's Initiative is a manage_project recommendation, never a fabricated Ticket or extra work item.");
    if (item.kind === "task" && item.parentTitle && !item.dependsOn) throw new Error("A Task with parent_title must include depends_on pointing to its Project/Ticket/Routine plan key. Existing placement alone does not satisfy a requested move.");
    if (item.dependsOn && !["project", "ticket", "routine"].includes(next.get(item.dependsOn)?.kind || "")) throw new Error("A Task dependency must be its Project, Ticket or Routine container, not another Task.");
  }
  for (const item of items) {
    const seen = new Set([item.key]);
    let parent = item.dependsOn;
    while (parent) {
      if (seen.has(parent)) throw new Error("Plan dependencies cannot contain a cycle.");
      seen.add(parent); parent = next.get(parent)?.dependsOn;
    }
  }
  return items;
}

export function toolSucceeded(turn: SlackMcpStoredToolTurn) {
  const result = object(turn.result), data = object(result.structuredContent);
  return result.isError !== true && object(data.placement).status !== "selection_required";
}

export function reconcileWorkPlan(plan: SlackWorkPlanItem[], turns: SlackMcpStoredToolTurn[]) {
  return plan.map((item) => {
    const next = { ...item };
    for (const turn of turns) {
      if (!toolSucceeded(turn)) continue;
      const data = object(object(turn.result).structuredContent), review = object(data.review);
      if (turn.name === "manage_project" && item.kind === "project" && workName(String(review.title || turn.arguments.title || "")) === workName(item.title)) {
        if (review.state === "awaiting_user_confirmation" && typeof review.id === "string") next.reviewId = review.id;
        if (review.state === "created" && typeof review.projectId === "string") {
          next.record = { id: review.projectId, title: String(review.title || item.title) };
          delete next.reviewId;
        }
      }
      const records = [...(Array.isArray(data.items) ? data.items : []), ...(Array.isArray(data.routines) ? data.routines : []),
        ...(data.item ? [data.item] : []), ...(data.routine ? [data.routine] : [])];
      // A read can prove an existing record, including a Task under the wrong parent.
      // Its presence is not proof that the requested placement/deadline is satisfied.
      for (const raw of records) {
        const saved = object(raw);
        if (typeof saved.id !== "string" || typeof saved.title !== "string" || saved.archivedAt
          || saved.status === "archived" || saved.active === false || (saved.kind && saved.kind !== item.kind)) continue;
        if (!saved.kind && item.kind !== "routine") continue;
        if (item.existingId ? saved.id !== item.existingId : workName(saved.title) !== workName(item.title)) continue;
        const parent = item.dependsOn ? plan.find((entry) => entry.key === item.dependsOn) : null;
        const sameTitle = records.filter((candidate) => workName(String(object(candidate).title || "")) === workName(item.title));
        if (!item.existingId && item.kind === "task" && sameTitle.length > 1
          && (!parent?.record || (parent.kind === "routine" ? saved.routineId : saved.parentId) !== parent.record.id)) continue;
        if (!item.existingId && next.record && saved.id !== next.record.id) continue;
        next.record = { id: saved.id, title: saved.title,
          parentId: typeof saved.parentId === "string" ? saved.parentId : null,
          routineId: typeof saved.routineId === "string" ? saved.routineId : null,
          ...(Object.hasOwn(saved, "dueDate") ? { dueDate: typeof saved.dueDate === "string" ? saved.dueDate : null } : {}) };
        delete next.reviewId;
      }
    }
    return next;
  });
}

export function workPlanStatus(item: SlackWorkPlanItem, plan: SlackWorkPlanItem[] = []) {
  if (!item.record) return item.reviewId ? "awaiting_approval" : "pending";
  if (item.kind === "task") {
    if (item.parentTitle && !item.dependsOn) return "needs_placement";
    const parent = item.dependsOn ? plan.find((entry) => entry.key === item.dependsOn) : null;
    if (item.dependsOn && (!parent?.record || (parent.kind === "routine" ? item.record.routineId : item.record.parentId) !== parent.record.id)) return "needs_placement";
    if (item.dueDate && item.record.dueDate !== undefined && item.record.dueDate !== item.dueDate) return "needs_update";
  }
  return "saved";
}

export function taskPlanGuard(plan: SlackWorkPlanItem[], name: string, args: Record<string, unknown>, planKey?: string) {
  const linking = name === "link_item";
  if (!(linking || name === "create_tasks" || name === "capture_item" || (name === "create_item" && args.kind === "task"))) return null;
  const titles = name === "create_tasks" && Array.isArray(args.titles) ? args.titles : [args.title];
  const requested = plan.filter((item) => item.kind === "task" && (titles.length > 1 || !planKey || item.key === planKey)
    && (linking ? item.record?.id === args.id : titles.some((title) => typeof title === "string" && workName(title) === workName(item.title))));
  if (!linking && plan.length && (!requested.length || titles.some((title) => !requested.some((item) => typeof title === "string" && workName(title) === workName(item.title))))) {
    return "Add each explicitly requested Task and its intended parent to plan_work before creating it. Use the planned titles; do not bypass dependencies with a different title.";
  }
  const parents = new Set(requested.map((item) => item.dependsOn || item.parentTitle).filter(Boolean));
  if (parents.size > 1) return "These Tasks have different requested containers. Partition by parent and call create_tasks separately for each group.";
  for (const item of requested) {
    if (item.record && !linking) return "This requested Task already has a successful saved receipt. Reuse that record; do not create it again. After its intended parent is saved, use link_item to correct placement and update_item for other requested fields.";
    if (item.existingId && !item.record) return "Read and verify the selected existing Task before continuing. A missing/unverified existing_id is not permission to create a replacement.";
    if (!linking && item.dueDate && args.due_date !== item.dueDate) return "Preserve this Task's explicitly requested deadline from the plan.";
    if (item.parentTitle && !item.dependsOn) return "Resolve the named parent in plan_work with a depends_on key before writing. Never substitute a different parent or General.";
    if (!item.dependsOn) continue;
    const parent = plan.find((entry) => entry.key === item.dependsOn);
    if (!parent?.record) return "The requested parent is not saved yet. Prepare its Project review and wait for approval; never use another Project or General.";
    const actualParent = parent.kind === "routine" ? args.routine_id : args.parent_id;
    if (actualParent !== parent.record.id) return "Use the saved ID of this Task's requested parent from the plan, not a similarly named or first candidate.";
  }
  return null;
}

export function workPlanSummary(plan: SlackWorkPlanItem[]) {
  if (!plan.length) return "";
  const lines = ["*요청별 처리 현황*"];
  for (const item of plan) {
    const status = ({ saved: "저장 확인", awaiting_approval: "생성 승인 대기", pending: "미처리", needs_placement: "기존 업무 · 소속 수정 필요", needs_update: "기존 업무 · 기한 수정 필요" })[workPlanStatus(item, plan)];
    lines.push(`• ${item.title.replace(/[<>&*]/g, "")} · ${status}${item.parentTitle ? ` · ${item.parentTitle.replace(/[<>&*]/g, "")}` : ""}`);
  }
  return lines.join("\n");
}
