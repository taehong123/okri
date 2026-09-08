export const DAILY_WORK_STATUSES = ["office", "remote", "skip"] as const;
export type DailyWorkStatus = typeof DAILY_WORK_STATUSES[number];

export const DEFAULT_DAILY_WORK_STATUSES: DailyWorkStatus[] = [...DAILY_WORK_STATUSES];

const labels: Record<DailyWorkStatus, string> = {
  office: "출근",
  remote: "재택",
  skip: "스킵",
};

export function dailyWorkStatusLabel(status: DailyWorkStatus) {
  return labels[status];
}

export function normalizeDailyWorkStatus(value: unknown, fallback: DailyWorkStatus = "office"): DailyWorkStatus {
  return typeof value === "string" && DAILY_WORK_STATUSES.includes(value as DailyWorkStatus)
    ? value as DailyWorkStatus
    : fallback;
}

export function parseDailyWorkStatuses(value: unknown): DailyWorkStatus[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return DEFAULT_DAILY_WORK_STATUSES;
    const statuses = [...new Set(parsed.filter((entry): entry is DailyWorkStatus =>
      typeof entry === "string" && DAILY_WORK_STATUSES.includes(entry as DailyWorkStatus)))];
    return statuses.some((status) => status !== "skip") ? statuses : DEFAULT_DAILY_WORK_STATUSES;
  } catch {
    return DEFAULT_DAILY_WORK_STATUSES;
  }
}

export function validateDailyWorkStatuses(value: unknown): DailyWorkStatus[] {
  if (!Array.isArray(value)) throw new Error("근무 선택지를 확인해 주세요.");
  const statuses = [...new Set(value.filter((entry): entry is DailyWorkStatus =>
    typeof entry === "string" && DAILY_WORK_STATUSES.includes(entry as DailyWorkStatus)))];
  if (statuses.length !== value.length || !statuses.some((status) => status !== "skip")) {
    throw new Error("출근 또는 재택 중 하나 이상을 선택해 주세요.");
  }
  return statuses;
}
