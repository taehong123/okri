type DailyRevisionDraft = {
  yesterdayNote: string;
  todayNote: string;
  blockersNote: string;
  noPlannedTasks: boolean;
  skipReason: string | null;
  skipNote: string;
  selectedTaskIds: string[];
  selectedWorkIds?: string[];
  selectedYesterdayWorkIds?: string[];
};

type DailyRevisionSubmission = {
  yesterdayNote: string;
  todayNote: string;
  blockersNote: string;
  noPlannedTasks: boolean;
  skipReason: string | null;
  skipNote: string;
  tasks: Array<{ taskId: string | null }>;
  work?: Array<{ key: string; completedToday?: boolean }>;
  yesterdayWork?: Array<{ key: string }>;
};

function normalizedKeys(keys: string[]) {
  return [...new Set(keys)].sort();
}

function normalizedText(value: string) {
  return value.trim();
}

function draftSnapshot(draft: DailyRevisionDraft) {
  const selectedWorkIds = draft.selectedWorkIds
    ?? draft.selectedTaskIds.map((taskId) => `task:${taskId}`);
  return {
    yesterdayNote: normalizedText(draft.yesterdayNote),
    todayNote: normalizedText(draft.todayNote),
    blockersNote: normalizedText(draft.blockersNote),
    noPlannedTasks: draft.noPlannedTasks,
    skipReason: draft.skipReason,
    skipNote: normalizedText(draft.skipNote),
    selectedWorkIds: normalizedKeys(selectedWorkIds),
    selectedYesterdayWorkIds: normalizedKeys(draft.selectedYesterdayWorkIds ?? []),
  };
}

function submissionSnapshot(submission: DailyRevisionSubmission) {
  const selectedTaskIds = submission.tasks.flatMap((task) => task.taskId ? [`task:${task.taskId}`] : []);
  const selectedWorkIds = (submission.work ?? [])
    .filter((work) => !work.completedToday)
    .map((work) => work.key);
  return {
    yesterdayNote: normalizedText(submission.yesterdayNote),
    todayNote: normalizedText(submission.todayNote),
    blockersNote: normalizedText(submission.blockersNote),
    noPlannedTasks: submission.noPlannedTasks,
    skipReason: submission.skipReason,
    skipNote: normalizedText(submission.skipNote),
    selectedWorkIds: normalizedKeys([...selectedTaskIds, ...selectedWorkIds]),
    selectedYesterdayWorkIds: normalizedKeys((submission.yesterdayWork ?? []).map((work) => work.key)),
  };
}

export function dailyRevisionChanged(draft: DailyRevisionDraft, submission: DailyRevisionSubmission | null) {
  if (!submission) return true;
  return JSON.stringify(draftSnapshot(draft)) !== JSON.stringify(submissionSnapshot(submission));
}
