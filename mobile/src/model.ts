import type { Bootstrap, DailyWork, Item } from "./types";

export function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
export function complete(status: string) { return status === "done" || status === "development_done"; }
export function overdue(item: Pick<Item, "status" | "dueDate">, date = today()) {
  return !!item.dueDate && item.dueDate < date && !complete(item.status) && item.status !== "archived";
}
export function activeItems(data: Bootstrap) { return data.items.filter(i => !i.archivedAt && i.status !== "archived"); }
export function myTasks(data: Bootstrap) {
  const member = data.team.members.find(m => m.userId === data.user.id && m.status === "active");
  return activeItems(data).filter(i => i.kind === "task" && !complete(i.status) &&
    i.assignments.some(a => a.role === "task_assignee" && a.memberId === member?.id))
    .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
}
export function workGroups(work: DailyWork[]) {
  const groups = new Map<string, { key: string; title: string; kind: string; parent?: DailyWork; children: DailyWork[] }>();
  for (const row of work) {
    const key = row.kind === "task" ? row.parentId ? row.parentKind + ":" + row.parentId : "general" : row.key;
    const group = groups.get(key) ?? { key, title: row.kind === "task" ? row.parentTitle : row.title, kind: row.kind === "task" ? row.parentKind || "general" : row.kind, children: [] };
    if (row.kind === "task") group.children.push(row); else group.parent = row;
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function dayOffset(date: string, base: string) {
  return Math.round((Date.parse(date + "T12:00:00Z") - Date.parse(base + "T12:00:00Z")) / 86400000);
}
export function plusDays(date: string, count: number) {
  return new Date(Date.parse(date + "T12:00:00Z") + count * 86400000).toISOString().slice(0, 10);
}
