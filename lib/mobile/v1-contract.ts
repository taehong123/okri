import { z } from "zod";

// This is the installed-client wire contract, not the web view model.
// Preserve required fields and meanings; introduce v2 for incompatible changes.
const id = z.string().min(1);
const nullableId = id.nullable();
const date = z.iso.date();
const kinds = z.enum(["objective", "key_result", "initiative", "project", "task"]);
const statuses = z.enum(["backlog", "todo", "policy_discussion", "in_progress", "developing", "development_done", "done", "blocked", "archived"]);
const priorities = z.enum(["low", "medium", "high", "urgent"]);
const member = z.object({ id, userId: nullableId, displayName: z.string(), email: z.string(), status: z.string(), role: z.string() });
export const itemV1 = z.object({
  id, kind: kinds, title: z.string(), description: z.string(),
  parentId: nullableId, routineId: nullableId, cycleId: nullableId,
  status: statuses, priority: priorities, progress: z.number(), dueDate: date.nullable(),
  archivedAt: z.string().nullable(), createdByUserId: nullableId,
  assignments: z.array(z.object({ memberId: id, displayName: z.string(), role: z.string() })),
});
export const routineV1 = z.object({
  id, title: z.string(), description: z.string(),
  cadence: z.enum(["daily", "weekly", "monthly"]), active: z.boolean(), completed: z.boolean(),
  systemKey: z.string().nullable(), assigneeMemberId: nullableId,
});
const work = z.object({
  id, key: id, kind: z.enum(["project", "task", "routine"]), title: z.string(), status: z.string(),
  dueDate: date.nullable(), parentId: nullableId.optional(), parentKind: z.string().optional(),
  parentTitle: z.string(), completedYesterday: z.boolean().optional(),
});
const draftFields = {
  yesterdayNote: z.string(), todayNote: z.string(), blockersNote: z.string(),
  selectedTaskIds: z.array(id), selectedWorkIds: z.array(id), selectedYesterdayWorkIds: z.array(id),
  noPlannedTasks: z.boolean(), skipReason: z.enum(["workload", "vacation", "personal", "other"]).nullable(), skipNote: z.string(),
};
export const bootstrapV1 = z.object({
  user: z.object({ id, email: z.string(), displayName: z.string(), preferences: z.object({ language: z.string().optional(), resolvedLanguage: z.string().optional() }).optional() }),
  items: z.array(itemV1), routines: z.array(routineV1),
  workspaces: z.array(z.object({ id, name: z.string(), current: z.boolean().optional(), role: z.string(), scheduledDeletionAt: z.string().nullable().optional() })),
  team: z.object({ workspace: z.object({ id, name: z.string() }).optional(), members: z.array(member), currentRole: z.string(), canManage: z.boolean() }),
  cycles: z.array(z.object({ id, name: z.string(), status: z.string() })),
});
export const dailyV1 = z.object({
  date, member: member.pick({ id: true, displayName: true, email: true, role: true }), draft: z.object(draftFields),
  candidates: z.object({ work: z.array(work), yesterdayWork: z.array(work) }),
  createTargets: z.object({ projects: z.array(z.object({ id, title: z.string() })), routines: z.array(z.object({ id, title: z.string() })), allowGeneral: z.boolean() }),
  latestSubmission: z.object({ id, submittedAt: z.string() }).nullable(),
});
const itemFields = {
  title: z.string().trim().min(1).max(300), description: z.string().max(10000),
  status: statuses, priority: priorities, dueDate: date.nullable(), parentId: nullableId,
  routineId: nullableId, cycleId: nullableId, driMemberId: nullableId, assigneeMemberId: nullableId,
  source: z.literal("web"),
};
const routineFields = { title: itemFields.title, description: itemFields.description, cadence: z.enum(["daily", "weekly", "monthly"]), assigneeMemberId: nullableId };
export const requestsV1 = {
  "POST items": z.object(itemFields).partial().extend({ title: itemFields.title, kind: kinds }).strict(),
  "PATCH items": z.object(itemFields).partial().extend({ id }).strict(),
  "POST routines": z.object(routineFields).partial().extend({ title: itemFields.title }).strict(),
  "PATCH routines": z.object(routineFields).partial().extend({ id }).strict(),
  "PUT routine-completions": z.object({ routineId: id, date, completed: z.boolean() }).strict(),
  "PUT daily-scrum": z.object({ ...draftFields, date }).strict(),
  "POST daily-scrum/submit": z.object({ date, requestId: id.max(200) }).strict(),
  "POST daily-scrum/tasks": z.object({ date, title: itemFields.title, parentKind: z.enum(["project", "routine", "general"]), parentId: nullableId, requestId: id.max(200) }).strict(),
  "PATCH workspaces": z.object({ workspaceId: id }).strict(),
};
// Commands whose response is not consumed return a stable acknowledgement.
export const responsesV1: Record<string, z.ZodType> = {
  "GET bootstrap": bootstrapV1,
  "GET daily-scrum": dailyV1,
  "POST items": z.object({ item: itemV1 }),
  "PATCH items": z.object({ item: itemV1 }),
  "POST routines": z.object({ routine: routineV1 }),
  "PATCH routines": z.object({ routine: routineV1 }),
  "POST daily-scrum/tasks": z.object({ task: z.object({ id }) }),
  "PATCH workspaces": z.object({ currentWorkspaceId: id }),
};
export const acknowledgementsV1 = new Set(["POST items", "PATCH items", "POST routines", "PATCH routines", "PUT daily-scrum", "POST daily-scrum/submit", "PUT routine-completions"]);
export const readsV1 = new Set(["GET bootstrap", "GET daily-scrum"]);
