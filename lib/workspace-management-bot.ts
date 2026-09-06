import { env } from "cloudflare:workers";
import { getSlackConnection } from "@/lib/pace-data";
import { canAutoJoinSlackChannel, listSlackChannels, slackApi, slackTokenForConnection, type SlackDailyChannel } from "@/lib/slack-daily";
import { deliverSlackBotMessage } from "@/lib/slack-bot-delivery";
import { managementReportBlocks, slackText, type ManagementAssignee } from "./slack-management-report";

export const managementBotSignalIds = [
  "missing_due_date",
  "missing_owner",
  "overdue",
  "completed_yesterday",
  "due_today",
] as const;

export type ManagementBotSignal = (typeof managementBotSignalIds)[number];
export type ManagementBotItem = {
  id: string;
  kind: "project" | "task";
  title: string;
  status: string;
  dueDate: string | null;
  isOverdue: boolean;
  parentProject: ManagementBotProject | null;
};
export type ManagementBotProject = {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  isOverdue: boolean;
};
export type ManagementBotProjectGroup = {
  project: ManagementBotProject | null;
  projectMatchesSignal: boolean;
  tasks: ManagementBotItem[];
};
export type ManagementBotGroup = {
  signal: ManagementBotSignal;
  count: number;
  items: ManagementBotItem[];
  projects: ManagementBotProjectGroup[];
};
export type ManagementBotSettings = {
  enabled: boolean;
  weekdays: number[];
  reportTime: string;
  timezone: string;
  channelId: string;
  channelName: string;
  signals: ManagementBotSignal[];
  lastSentDate: string | null;
  lastSentAt: string | null;
  lastError: string;
  updatedAt: string | null;
};

type RuntimeEnv = {
  DB: D1Database;
  OKRI_APP_URL?: string;
  OKRPTR_APP_URL?: string;
};

type ItemRow = Record<string, string | number | null>;

const completedStatuses = new Set(["done", "development_done"]);
const inactiveStatuses = new Set([...completedStatuses, "archived"]);
const defaultSignals = [...managementBotSignalIds];

export async function getWorkspaceManagementBot(ownerId: string, options: { includeChannels?: boolean; includeSnapshot?: boolean; date?: string; snapshotSignals?: ManagementBotSignal[] } = {}) {
  const settings = await readSettings(ownerId);
  const snapshot = options.includeSnapshot === false
    ? undefined
    : await collectWorkspaceManagementSnapshot(ownerId, options.date, settings.timezone, options.snapshotSignals ?? settings.signals);
  const connection = await getSlackConnection(ownerId);
  const channels = options.includeChannels && connection
    ? await listSlackChannels(ownerId, { includeJoinablePublic: true })
    : [];
  return { settings, ...(snapshot ? { snapshot } : {}), slackConnected: Boolean(connection), channels };
}

export async function updateWorkspaceManagementBot(ownerId: string, input: Partial<{
  enabled: boolean;
  weekdays: number[];
  reportTime: string;
  timezone: string;
  channelId: string;
  signals: ManagementBotSignal[];
}>, options: { includeChannels?: boolean; includeSnapshot?: boolean } = { includeChannels: true, includeSnapshot: true }) {
  const current = await readSettings(ownerId);
  const enabled = input.enabled ?? current.enabled;
  const weekdays = input.weekdays === undefined ? current.weekdays : normalizeWeekdays(input.weekdays);
  const reportTime = input.reportTime === undefined ? current.reportTime : normalizeReportTime(input.reportTime);
  const timezone = input.timezone === undefined ? current.timezone : normalizeTimezone(input.timezone);
  const signals = input.signals === undefined ? current.signals : normalizeSignals(input.signals);
  const channelId = input.channelId === undefined ? current.channelId : input.channelId.trim();
  let channelName = current.channelName;
  if (channelId !== current.channelId || (enabled && !channelName)) {
    const channel = channelId ? await prepareSlackChannel(ownerId, channelId) : null;
    channelName = channel?.name ?? "";
  }
  if (enabled && !channelId) throw new Error("관리 리포트를 받을 Slack 채널을 선택해 주세요.");
  if (enabled && !(await getSlackConnection(ownerId))) throw new Error("워크스페이스 Slack을 먼저 연결해 주세요.");
  const now = new Date().toISOString();
  await (env as RuntimeEnv).DB.prepare(`INSERT INTO workspace_management_bot_settings
    (owner_id, enabled, weekdays, report_time, timezone, channel_id, channel_name, signals, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)
    ON CONFLICT(owner_id) DO UPDATE SET enabled = excluded.enabled, weekdays = excluded.weekdays,
      report_time = excluded.report_time, timezone = excluded.timezone, channel_id = excluded.channel_id,
      channel_name = excluded.channel_name, signals = excluded.signals, last_error = '', updated_at = excluded.updated_at`)
    .bind(ownerId, enabled ? 1 : 0, JSON.stringify(weekdays), reportTime, timezone, channelId, channelName, JSON.stringify(signals), now).run();
  return getWorkspaceManagementBot(ownerId, options);
}

export async function testWorkspaceManagementBot(ownerId: string) {
  const settings = await readSettings(ownerId);
  if (!settings.channelId) throw new Error("테스트 리포트를 받을 Slack 채널을 선택해 주세요.");
  await prepareSlackChannel(ownerId, settings.channelId);
  const snapshot = await collectWorkspaceManagementSnapshot(ownerId, undefined, settings.timezone, settings.signals);
  const delivery = await sendReport(ownerId, settings, snapshot, true);
  if (delivery.status !== "sent") throw new Error(delivery.last_error || "테스트 리포트 전송 결과를 확인하지 못했습니다.");
  return { sent: true, snapshot };
}

export async function collectWorkspaceManagementSnapshot(ownerId: string, requestedDate?: string, timezone = "Asia/Seoul", signals: ManagementBotSignal[] = defaultSignals) {
  const date = requestedDate ? normalizeDate(requestedDate) : todayInTimezone(timezone);
  const previousDate = addDays(date, -1);
  const db = (env as RuntimeEnv).DB;
  const rows = await db.prepare(`SELECT item.id, item.kind, item.title, item.status, item.due_date, item.parent_id,
      parent_project.id AS parent_project_id, parent_project.title AS parent_project_title,
      parent_project.status AS parent_project_status, parent_project.due_date AS parent_project_due_date,
      MAX(CASE WHEN assignment.role = 'project_dri' THEN 1 ELSE 0 END) AS has_project_dri,
      MAX(CASE WHEN assignment.role = 'task_assignee' THEN 1 ELSE 0 END) AS has_task_assignee
    FROM items AS item
    LEFT JOIN items AS parent_project ON parent_project.owner_id = item.owner_id
      AND parent_project.id = item.parent_id AND parent_project.kind = 'project' AND parent_project.archived_at IS NULL
    LEFT JOIN item_assignments AS assignment ON assignment.owner_id = item.owner_id AND assignment.item_id = item.id
    WHERE item.owner_id = ? AND item.kind IN ('project', 'task') AND item.archived_at IS NULL
    GROUP BY item.id, item.kind, item.title, item.status, item.due_date, item.parent_id,
      parent_project.id, parent_project.title, parent_project.status, parent_project.due_date`)
    .bind(ownerId).all<ItemRow>();
  const allItems = rows.results.map((row) => serializeItemRow(row, date));
  const openRows = rows.results.filter((row) => !inactiveStatuses.has(String(row.status)));
  const [previousStart, previousEnd] = zonedDayRange(previousDate, timezone);
  const activity = await db.prepare(`SELECT item_id, payload FROM activity_log
    WHERE owner_id = ? AND action = 'updated'
      AND json_valid(payload)
      AND ((created_at >= ? AND created_at < ?) OR json_extract(payload, '$.effectiveDate') = ?)`)
    .bind(ownerId, previousStart, previousEnd, previousDate).all<Record<string, string>>();
  const completedYesterdayIds = new Set(activity.results.flatMap((entry) => {
    try {
      const payload = JSON.parse(entry.payload) as { status?: string; effectiveDate?: string };
      return payload.status && completedStatuses.has(payload.status)
        && (!payload.effectiveDate || payload.effectiveDate === previousDate) ? [entry.item_id] : [];
    } catch { return []; }
  }));
  const bySignal: Record<ManagementBotSignal, ManagementBotItem[]> = {
    missing_due_date: openRows.filter((row) => !row.due_date).map((row) => serializeItemRow(row, date)),
    missing_owner: openRows.filter((row) => row.kind === "project" ? !row.has_project_dri : !row.has_task_assignee).map((row) => serializeItemRow(row, date)),
    overdue: openRows.filter((row) => Boolean(row.due_date && String(row.due_date) < date)).map((row) => serializeItemRow(row, date)),
    completed_yesterday: allItems.filter((item) => completedStatuses.has(item.status) && completedYesterdayIds.has(item.id)),
    due_today: openRows.filter((row) => row.due_date === date).map((row) => serializeItemRow(row, date)),
  };
  for (const values of Object.values(bySignal)) values.sort(compareManagementItems);
  return {
    date,
    groups: signals.map((signal) => {
      const items = bySignal[signal].slice(0, 20);
      return { signal, count: bySignal[signal].length, items, projects: groupManagementItems(items) };
    }),
    totalCount: signals.reduce((total, signal) => total + bySignal[signal].length, 0),
  };
}

export async function runDueWorkspaceManagementBots(db: D1Database, now = new Date(), ownerId?: string) {
  const startedAt = Date.now();
  const settingsRows = await db.prepare(`SELECT s.* FROM workspace_management_bot_settings s
    JOIN workspaces w ON w.id = s.owner_id AND w.scheduled_deletion_at IS NULL
    WHERE s.enabled = 1 AND s.channel_id <> '' ${ownerId ? "AND s.owner_id = ?" : ""} ORDER BY s.owner_id`)
    .bind(...(ownerId ? [ownerId] : [])).all<Record<string, string | number | null>>();
  let sent = 0;
  let failed = 0;
  const rows = settingsRows.results;
  const offset = ownerId || !rows.length ? 0 : Math.floor(now.getTime() / (15 * 60_000)) % rows.length;
  for (const row of [...rows.slice(offset), ...rows.slice(0, offset)].slice(0, 20)) {
    if (Date.now() - startedAt >= 10_000) break;
    try {
      const settings = serializeSettings(row);
      const parts = zonedParts(now, settings.timezone);
      const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
      const currentTime = `${pad(parts.hour)}:${pad(parts.minute)}`;
      if (!settings.weekdays.includes(localWeekday(date)) || currentTime < settings.reportTime || settings.lastSentDate === date) continue;
      const snapshot = await collectWorkspaceManagementSnapshot(String(row.owner_id), date, settings.timezone, settings.signals);
      const delivery = await sendReport(String(row.owner_id), settings, snapshot, false, now);
      if (delivery.status === "sent") sent += 1;
      else if (!["pending", "preparing", "sending", "retry"].includes(delivery.status)) failed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "관리 리포트 전송 실패";
      await db.prepare("UPDATE workspace_management_bot_settings SET last_error = ?, updated_at = ? WHERE owner_id = ?")
        .bind(message.slice(0, 500), now.toISOString(), row.owner_id).run();
      failed += 1;
    }
  }
  return { sent, failed };
}

async function readSettings(ownerId: string): Promise<ManagementBotSettings> {
  const row = await (env as RuntimeEnv).DB.prepare("SELECT * FROM workspace_management_bot_settings WHERE owner_id = ? LIMIT 1")
    .bind(ownerId).first<Record<string, string | number | null>>();
  return row ? serializeSettings(row) : {
    enabled: false,
    weekdays: [1, 2, 3, 4, 5],
    reportTime: "09:00",
    timezone: "Asia/Seoul",
    channelId: "",
    channelName: "",
    signals: [...defaultSignals],
    lastSentDate: null,
    lastSentAt: null,
    lastError: "",
    updatedAt: null,
  };
}

async function prepareSlackChannel(ownerId: string, channelId: string): Promise<SlackDailyChannel> {
  const connection = await getSlackConnection(ownerId);
  if (!connection) throw new Error("워크스페이스 Slack을 먼저 연결해 주세요.");
  const available = await listSlackChannels(ownerId, { includeJoinablePublic: true });
  const channel = available.find((entry) => entry.id === channelId);
  if (!channel) throw new Error("공개 채널 또는 봇이 참여한 비공개·공유 채널만 선택할 수 있습니다.");
  if (canAutoJoinSlackChannel(channel)) {
    const token = await slackTokenForConnection(connection);
    await slackApi(token, "conversations.join", { channel: channel.id });
  }
  return { ...channel, isMember: true };
}

async function sendReport(ownerId: string, settings: ManagementBotSettings, snapshot: Awaited<ReturnType<typeof collectWorkspaceManagementSnapshot>>, test: boolean, now = new Date()) {
  const payload = await managementPayload(ownerId, settings, snapshot, test, true);
  return deliverSlackBotMessage((env as RuntimeEnv).DB, {
    ownerId, botKind: "management", subjectId: snapshot.date,
    eventKey: test ? `test:${crypto.randomUUID()}` : snapshot.date,
    expiresAt: new Date(zonedDayRange(snapshot.date, settings.timezone)[1]).toISOString(),
    payload,
  }, now);
}

async function managementPayload(ownerId: string, settings: ManagementBotSettings, snapshot: Awaited<ReturnType<typeof collectWorkspaceManagementSnapshot>>, test: boolean, mentions: boolean) {
  const t = await serverTranslator(await workspaceMessageLanguage((env as RuntimeEnv).DB, ownerId));
  const workspace = await (env as RuntimeEnv).DB.prepare("SELECT name FROM workspaces WHERE id = ? LIMIT 1").bind(ownerId).first<{ name: string }>();
  const rows = await (env as RuntimeEnv).DB.prepare(`SELECT a.item_id, m.display_name, l.slack_user_id
    FROM item_assignments a JOIN workspace_members m ON m.workspace_id=a.owner_id AND m.id=a.member_id AND m.status='active'
    JOIN items i ON i.owner_id=a.owner_id AND i.id=a.item_id AND i.archived_at IS NULL
    LEFT JOIN slack_connections c ON c.owner_id=a.owner_id
    LEFT JOIN slack_member_links l ON l.owner_id=m.workspace_id AND l.member_id=m.id AND l.team_id=c.team_id
    WHERE a.owner_id=? AND ((i.kind='project' AND a.role='project_dri') OR (i.kind='task' AND a.role='task_assignee'))
      AND i.id IN (SELECT value FROM json_each(?)) ORDER BY a.item_id,m.id`)
    .bind(ownerId, JSON.stringify([...new Set(snapshot.groups.flatMap((g) => g.items.map((i) => i.id)))])).all<{ item_id: string; display_name: string; slack_user_id: string | null }>();
  const assignees: Record<string, ManagementAssignee[]> = {};
  for (const row of rows.results) (assignees[row.item_id] ??= []).push({ name: row.display_name, slackId: row.slack_user_id });
  const appUrl = String((env as RuntimeEnv).OKRI_APP_URL || (env as RuntimeEnv).OKRPTR_APP_URL || "https://okri.ai").replace(/\/$/, "");
  return { channel: settings.channelId, test,
    text: `[${t("관리 봇")}] ${t("{workspace} 워크스페이스 관리 리포트 · {date}", { workspace: slackText((workspace?.name || "OKRI").slice(0, 300)), date: snapshot.date })}`,
    blocks: managementReportBlocks({ ...snapshot, appUrl, workspace: workspace?.name || "OKRI", test, assignees, mentions }, t),
  };
}

export async function refreshManagementReport(ownerId: string, channel: string, ts: string) {
  // Only modify our own recorded management message, never an arbitrary thread.
  const receipt = await (env as RuntimeEnv).DB.prepare(`SELECT subject_id FROM slack_bot_deliveries
    WHERE owner_id=? AND bot_kind='management' AND status='sent' AND message_ts=? AND json_extract(payload,'$.channel')=? LIMIT 1`)
    .bind(ownerId, ts, channel).first<{ subject_id: string }>();
  const settings = await readSettings(ownerId), connection = await getSlackConnection(ownerId);
  if (!receipt || !connection || settings.channelId !== channel) return;
  const snapshot = await collectWorkspaceManagementSnapshot(ownerId, receipt.subject_id, settings.timezone, settings.signals);
  const payload = await managementPayload(ownerId, settings, snapshot, false, false);
  await slackApi(await slackTokenForConnection(connection), "chat.update", { channel, ts, text: payload.text, blocks: payload.blocks });
}

function serializeSettings(row: Record<string, string | number | null>): ManagementBotSettings {
  return {
    enabled: Boolean(row.enabled),
    weekdays: parseWeekdays(String(row.weekdays || "")),
    reportTime: normalizeReportTime(String(row.report_time || "09:00")),
    timezone: normalizeTimezone(String(row.timezone || "Asia/Seoul")),
    channelId: String(row.channel_id || ""),
    channelName: String(row.channel_name || ""),
    signals: parseSignals(String(row.signals || "")),
    lastSentDate: row.last_sent_date ? String(row.last_sent_date) : null,
    lastSentAt: row.last_sent_at ? String(row.last_sent_at) : null,
    lastError: String(row.last_error || ""),
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

function serializeItemRow(row: ItemRow, date: string): ManagementBotItem {
  const status = String(row.status);
  const dueDate = row.due_date ? String(row.due_date) : null;
  const parentStatus = row.parent_project_status ? String(row.parent_project_status) : "";
  const parentDueDate = row.parent_project_due_date ? String(row.parent_project_due_date) : null;
  return {
    id: String(row.id),
    kind: row.kind === "project" ? "project" : "task",
    title: String(row.title),
    status,
    dueDate,
    isOverdue: Boolean(dueDate && dueDate < date && !inactiveStatuses.has(status)),
    parentProject: row.parent_project_id ? {
      id: String(row.parent_project_id),
      title: String(row.parent_project_title),
      status: parentStatus,
      dueDate: parentDueDate,
      isOverdue: Boolean(parentDueDate && parentDueDate < date && !inactiveStatuses.has(parentStatus)),
    } : null,
  };
}

function groupManagementItems(items: ManagementBotItem[]): ManagementBotProjectGroup[] {
  const groups = new Map<string, ManagementBotProjectGroup>();
  for (const item of items) {
    const project = item.kind === "project"
      ? { id: item.id, title: item.title, status: item.status, dueDate: item.dueDate, isOverdue: item.isOverdue }
      : item.parentProject;
    const key = project?.id ?? "__unassigned__";
    const group = groups.get(key) ?? { project, projectMatchesSignal: false, tasks: [] };
    if (item.kind === "project") group.projectMatchesSignal = true;
    else group.tasks.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.project?.isOverdue !== right.project?.isOverdue) return left.project?.isOverdue ? -1 : 1;
    const leftDueDate = left.project?.dueDate ?? left.tasks[0]?.dueDate;
    const rightDueDate = right.project?.dueDate ?? right.tasks[0]?.dueDate;
    if (leftDueDate && rightDueDate && leftDueDate !== rightDueDate) return leftDueDate.localeCompare(rightDueDate);
    if (leftDueDate) return -1;
    if (rightDueDate) return 1;
    return (left.project?.title ?? "").localeCompare(right.project?.title ?? "", "ko");
  });
}


function compareManagementItems(left: ManagementBotItem, right: ManagementBotItem) {
  if (left.dueDate && right.dueDate && left.dueDate !== right.dueDate) return left.dueDate.localeCompare(right.dueDate);
  if (left.dueDate) return -1;
  if (right.dueDate) return 1;
  return left.title.localeCompare(right.title, "ko");
}

function normalizeSignals(values: ManagementBotSignal[]) {
  const supported = new Set<ManagementBotSignal>(managementBotSignalIds);
  const signals = [...new Set(values)].filter((value): value is ManagementBotSignal => supported.has(value));
  if (!signals.length) throw new Error("관리 항목을 하나 이상 선택해 주세요.");
  return signals;
}

function parseSignals(value: string) {
  try { return normalizeSignals(JSON.parse(value) as ManagementBotSignal[]); } catch { return [...defaultSignals]; }
}

function normalizeWeekdays(values: number[]) {
  const days = [...new Set(values.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
  if (!days.length) throw new Error("리포트 요일을 하나 이상 선택해 주세요.");
  return days;
}

function parseWeekdays(value: string) {
  try { return normalizeWeekdays(JSON.parse(value) as number[]); } catch { return [1, 2, 3, 4, 5]; }
}

function normalizeReportTime(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("리포트 시간은 HH:mm 형식이어야 합니다.");
  return value;
}

function normalizeTimezone(value: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); } catch { throw new Error("올바른 시간대를 선택해 주세요."); }
  return value;
}

function normalizeDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("올바른 날짜가 필요합니다.");
  return value;
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
    const actual = zonedParts(new Date(guess), timezone);
    guess += Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
  }
  return guess;
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function todayInTimezone(timezone: string) {
  const parts = zonedParts(new Date(), timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function localWeekday(value: string) {
  return new Date(`${value}T00:00:00Z`).getUTCDay();
}

function pad(value: number) { return String(value).padStart(2, "0"); }
import { workspaceMessageLanguage } from "./language-preferences";
import { serverTranslator } from "./server-language";
