export type Kind = "objective" | "key_result" | "initiative" | "project" | "task";
export type Status = "backlog" | "todo" | "policy_discussion" | "in_progress" | "developing" | "development_done" | "done" | "blocked" | "archived";
export type Priority = "low" | "medium" | "high" | "urgent";
export type Item = {
  id: string; kind: Kind; title: string; description: string;
  parentId: string | null; routineId: string | null; cycleId: string | null;
  status: Status; priority: Priority; progress: number; dueDate: string | null;
  archivedAt: string | null; createdByUserId: string | null;
  assignments: { memberId: string; displayName: string; role: string }[];
};
export type Routine = { id: string; title: string; description: string; cadence: "daily" | "weekly" | "monthly"; active: boolean; completed: boolean; systemKey: string | null; assigneeMemberId: string | null };
export type Member = { id: string; userId: string | null; displayName: string; email: string; status: string; role: string };
export type Bootstrap = {
  user: { id: string; email: string; displayName: string; preferences?: { language?: string; resolvedLanguage?: string } };
  items: Item[]; routines: Routine[];
  workspaces: { id: string; name: string; current?: boolean; role: string; scheduledDeletionAt?: string | null }[];
  team: { workspace?: { id: string; name: string }; members: Member[]; currentRole: string; canManage: boolean };
  cycles: { id: string; name: string; status: string }[];
};
export type DailyWork = { id: string; key: string; kind: "project" | "task" | "routine"; title: string; status: string; dueDate: string | null; parentId?: string | null; parentKind?: string; parentTitle: string; completedYesterday?: boolean };
export type DailyDraft = {
  yesterdayNote: string; todayNote: string; blockersNote: string;
  selectedTaskIds: string[]; selectedWorkIds: string[]; selectedYesterdayWorkIds: string[];
  noPlannedTasks: boolean; skipReason: string | null; skipNote: string;
};
export type Daily = {
  date: string; member: Member; draft: DailyDraft;
  candidates: { work: DailyWork[]; yesterdayWork: DailyWork[] };
  createTargets: { projects: { id: string; title: string }[]; routines: { id: string; title: string }[]; allowGeneral: boolean };
  latestSubmission: { id: string; submittedAt: string } | null;
};
export type Session = { accessToken: string; expiresAt: string; user: { id: string; email: string; displayName: string } };
export type Routes = {
  Main: undefined; Item: { id: string }; Routine: { id: string };
  Editor: { id?: string; kind?: Kind | "routine"; parentId?: string; routineId?: string };
  Gantt: undefined; Okr: undefined; Routines: undefined; Settings: undefined;
};
