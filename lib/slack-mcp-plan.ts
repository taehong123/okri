import type { SlackMcpStoredToolTurn } from "./slack-mcp-continuity";

export type SlackWorkPlanItem = {
  key: string;
  kind: "project" | "task" | "routine" | "ticket";
  title: string;
  parentTitle?: string;
  dependsOn?: string;
  dueDate?: string;
  record?: { id: string; title: string; parentId?: string | null; routineId?: string | null };
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
    const unchanged = old && old.kind === item.kind && workName(old.title) === workName(item.title)
      && (old.dependsOn || "") === (item.depends_on || "") && (old.parentTitle || "") === (item.parent_title || "");
    next.set(item.key, {
      key: item.key, kind: item.kind as SlackWorkPlanItem["kind"], title: item.title.trim(),
      ...(typeof item.parent_title === "string" ? { parentTitle: item.parent_title.slice(0, 500) } : {}),
      ...(typeof item.depends_on === "string" && item.depends_on ? { dependsOn: item.depends_on } : {}),
      ...(typeof item.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.due_date) ? { dueDate: item.due_date } : {}),
      ...(unchanged && old?.record ? { record: old.record } : {}),
      ...(unchanged && old?.reviewId ? { reviewId: old.reviewId } : {}),
    });
  }
  const items = [...next.values()];
  if (items.length > 30 || items.some((item) => item.dependsOn && (!next.has(item.dependsOn) || item.dependsOn === item.key))) {
    throw new Error("Every dependency must name another item in the same plan (maximum 30 items).");
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
      // Read results may resolve an explicitly named existing container, but are never writes.
      for (const raw of records) {
        const saved = object(raw);
        if (typeof saved.id !== "string" || typeof saved.title !== "string" || saved.archivedAt
          || saved.status === "archived" || saved.active === false || (saved.kind && saved.kind !== item.kind)) continue;
        if (workName(saved.title) !== workName(item.title)) continue;
        if (item.kind === "task" && turn.name === "list_items") continue;
        const parent = item.dependsOn ? plan.find((entry) => entry.key === item.dependsOn) : null;
        if (item.kind === "task" && parent && (!parent.record || (parent.kind === "routine" ? saved.routineId : saved.parentId) !== parent.record.id)) continue;
        next.record = { id: saved.id, title: saved.title,
          parentId: typeof saved.parentId === "string" ? saved.parentId : null,
          routineId: typeof saved.routineId === "string" ? saved.routineId : null };
        delete next.reviewId;
      }
    }
    return next;
  });
}

export function workPlanStatus(item: SlackWorkPlanItem) { return item.record ? "saved" : item.reviewId ? "awaiting_approval" : "pending"; }

export function taskPlanGuard(plan: SlackWorkPlanItem[], name: string, args: Record<string, unknown>, planKey?: string) {
  if (!(name === "create_tasks" || name === "capture_item" || (name === "create_item" && args.kind === "task"))) return null;
  const titles = name === "create_tasks" && Array.isArray(args.titles) ? args.titles : [args.title];
  const requested = plan.filter((item) => item.kind === "task" && (titles.length > 1 || !planKey || item.key === planKey)
    && titles.some((title) => typeof title === "string" && workName(title) === workName(item.title)));
  const parents = new Set(requested.map((item) => item.dependsOn || item.parentTitle).filter(Boolean));
  if (parents.size > 1) return "These Tasks have different requested containers. Partition by parent and call create_tasks separately for each group.";
  for (const item of requested) {
    if (item.record) return "This requested Task already has a successful saved receipt. Reuse that record; do not create it again.";
    if (item.dueDate && args.due_date !== item.dueDate) return "Preserve this Task's explicitly requested deadline from the plan.";
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
    const status = item.record ? "저장 확인" : item.reviewId ? "생성 승인 대기" : "미처리";
    lines.push(`• ${item.title.replace(/[<>&*]/g, "")} · ${status}${item.parentTitle ? ` · ${item.parentTitle.replace(/[<>&*]/g, "")}` : ""}`);
  }
  return lines.join("\n");
}
