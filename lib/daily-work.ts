export type DailyWorkKind = "project" | "task" | "routine";
export type DailyWork = {
  id: string; key: string; kind: DailyWorkKind; title: string; status: string;
  priority: string; dueDate: string | null; parentTitle: string;
  parentId?: string | null; parentKind?: string; completedToday?: boolean;
  completedYesterday?: boolean;
  willCompleteOnSubmit?: boolean;
};

export function parseDailyWorkKeys(raw: unknown, context: "today" | "yesterday" = "today"): string[] {
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string" || !/^(project|task|routine):[^:]{1,150}$/.test(key))) {
    throw new Error(context === "yesterday" ? "완료한 일 선택을 다시 확인해 주세요." : "오늘 할 업무 선택을 다시 확인해 주세요.");
  }
  const keys = [...new Set(value as string[])];
  if (keys.length > 50) throw new Error(context === "yesterday" ? "완료한 일은 최대 50개까지 선택할 수 있습니다." : "오늘 할 업무는 최대 50개까지 선택할 수 있습니다.");
  return keys;
}

export async function listDailyWork(db: D1Database, ownerId: string, memberId: string, date: string): Promise<DailyWork[]> {
  const rows = await db.prepare(`SELECT * FROM (SELECT DISTINCT item.id, item.kind, item.title, item.status, item.priority,
      item.due_date AS dueDate, COALESCE(parent.title, routine.title, 'General') AS parentTitle,
      COALESCE(parent.id, routine.id) AS parentId,
      CASE WHEN parent.id IS NOT NULL THEN parent.kind WHEN routine.id IS NOT NULL THEN 'routine' ELSE 'general' END AS parentKind
    FROM items item JOIN item_assignments a ON a.item_id = item.id AND a.owner_id = item.owner_id
    LEFT JOIN items parent ON parent.id = item.parent_id AND parent.owner_id = item.owner_id
    LEFT JOIN routines routine ON routine.id = item.routine_id AND routine.owner_id = item.owner_id
    WHERE item.owner_id = ? AND a.member_id = ? AND item.archived_at IS NULL
      AND item.status NOT IN ('done','development_done','archived')
      AND ((item.kind = 'task' AND a.role = 'task_assignee')
        OR (item.kind = 'project' AND a.role IN ('project_dri','project_worker')))
    UNION ALL
    SELECT r.id, 'routine', r.title, 'todo', 'medium', NULL, 'Routine', NULL, 'routine'
    FROM routines r WHERE r.owner_id = ? AND r.assignee_member_id = ? AND r.active = 1 AND r.system_key IS NULL
      AND NOT EXISTS (SELECT 1 FROM routine_completions c WHERE c.routine_id = r.id AND c.owner_id = r.owner_id AND c.completion_date = ?))
    ORDER BY dueDate IS NULL, dueDate, title`).bind(ownerId, memberId, ownerId, memberId, date).all<Omit<DailyWork, "key">>();
  return rows.results.map((work) => ({ ...work, key: `${work.kind}:${work.id}` }));
}

export async function validateDailyWork(db: D1Database, ownerId: string, memberId: string, date: string, keys: string[]) {
  const requested = parseDailyWorkKeys(keys);
  if (!requested.length) return [];
  const available = new Map((await listDailyWork(db, ownerId, memberId, date)).map((work) => [work.key, work]));
  const selected = requested.map((key) => available.get(key));
  if (selected.some((work) => !work)) throw new Error("업무의 할당 또는 완료 상태가 변경됐습니다. 내 업무를 다시 확인해 주세요.");
  return selected as DailyWork[];
}

export async function listDailyYesterdayWork(db: D1Database, ownerId: string, memberId: string, date: string, timezone: string): Promise<DailyWork[]> {
  const previousDate = addDays(date, -1);
  const [previousStart, previousEnd] = zonedDayRange(previousDate, timezone);
  const rows = await db.prepare(`SELECT * FROM (
    SELECT DISTINCT item.id, item.kind, item.title, item.status, item.priority,
      item.due_date AS dueDate, COALESCE(parent.title, routine.title, 'General') AS parentTitle,
      COALESCE(parent.id, routine.id) AS parentId,
      CASE WHEN parent.id IS NOT NULL THEN parent.kind WHEN routine.id IS NOT NULL THEN 'routine' ELSE 'general' END AS parentKind,
      EXISTS (
        SELECT 1 FROM activity_log activity
        WHERE activity.owner_id = item.owner_id AND activity.item_id = item.id AND activity.action = 'updated'
          AND json_valid(activity.payload)
          AND json_extract(activity.payload, '$.status') IN ('done', 'development_done')
          AND (json_extract(activity.payload, '$.effectiveDate') = ?
            OR (json_extract(activity.payload, '$.effectiveDate') IS NULL AND activity.created_at >= ? AND activity.created_at < ?))
      ) AS completedYesterday
    FROM items item JOIN item_assignments a ON a.item_id = item.id AND a.owner_id = item.owner_id
    LEFT JOIN items parent ON parent.id = item.parent_id AND parent.owner_id = item.owner_id
    LEFT JOIN routines routine ON routine.id = item.routine_id AND routine.owner_id = item.owner_id
    WHERE item.owner_id = ? AND a.member_id = ? AND item.archived_at IS NULL
      AND ((item.kind = 'task' AND a.role = 'task_assignee')
        OR (item.kind = 'project' AND a.role IN ('project_dri','project_worker')))
      AND (item.status NOT IN ('done','development_done','archived') OR EXISTS (
        SELECT 1 FROM activity_log activity
        WHERE activity.owner_id = item.owner_id AND activity.item_id = item.id AND activity.action = 'updated'
          AND json_valid(activity.payload)
          AND json_extract(activity.payload, '$.status') IN ('done', 'development_done')
          AND (json_extract(activity.payload, '$.effectiveDate') = ?
            OR (json_extract(activity.payload, '$.effectiveDate') IS NULL AND activity.created_at >= ? AND activity.created_at < ?))
      ))
    UNION ALL
    SELECT r.id, 'routine', r.title,
      CASE WHEN completion.id IS NULL THEN 'todo' ELSE 'done' END, 'medium', NULL, 'Routine', NULL, 'routine',
      CASE WHEN completion.id IS NULL THEN 0 ELSE 1 END
    FROM routines r
    LEFT JOIN routine_completions completion ON completion.owner_id = r.owner_id
      AND completion.routine_id = r.id AND completion.completion_date = ?
    WHERE r.owner_id = ? AND r.assignee_member_id = ? AND r.active = 1 AND r.system_key IS NULL
  ) ORDER BY completedYesterday DESC, dueDate IS NULL, dueDate, title`)
    .bind(previousDate, previousStart, previousEnd, ownerId, memberId,
      previousDate, previousStart, previousEnd, previousDate, ownerId, memberId)
    .all<Omit<DailyWork, "key" | "completedYesterday" | "willCompleteOnSubmit"> & { completedYesterday: number }>();
  return rows.results.map((work) => ({
    ...work,
    completedYesterday: Boolean(work.completedYesterday),
    willCompleteOnSubmit: !work.completedYesterday,
    key: `${work.kind}:${work.id}`,
  }));
}

export async function validateDailyYesterdayWork(db: D1Database, ownerId: string, memberId: string, date: string, timezone: string, keys: string[]) {
  const requested = parseDailyWorkKeys(keys, "yesterday");
  if (!requested.length) return [];
  const available = new Map((await listDailyYesterdayWork(db, ownerId, memberId, date, timezone)).map((work) => [work.key, work]));
  const selected = requested.map((key) => available.get(key));
  if (selected.some((work) => !work)) throw new Error("업무의 담당자·상태 또는 휴지통 여부가 변경됐습니다. 완료한 일을 다시 확인해 주세요.");
  return selected as DailyWork[];
}

export function dailyWorkSnapshots(raw: string | undefined): DailyWork[] {
  const parsed: unknown = JSON.parse(raw || "[]");
  return Array.isArray(parsed) ? parsed as DailyWork[] : [];
}

function addDays(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function zonedDayRange(value: string, timezone: string) {
  const [year, month, day] = value.split("-").map(Number);
  const start = zonedDateTimeToEpoch({ year, month, day, hour: 0, minute: 0 }, timezone);
  const next = addDays(value, 1).split("-").map(Number);
  const end = zonedDateTimeToEpoch({ year: next[0], month: next[1], day: next[2], hour: 0, minute: 0 }, timezone);
  return [new Date(start).toISOString(), new Date(end).toISOString()] as const;
}

function zonedDateTimeToEpoch(parts: { year: number; month: number; day: number; hour: number; minute: number }, timezone: string) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const formatted = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(formatted.find((part) => part.type === type)?.value ?? 0);
    guess += Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
      - Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"));
  }
  return guess;
}
