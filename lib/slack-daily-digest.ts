import { queueDailyDigest, runDueSlackBotDeliveries } from "./slack-bot-delivery";
import { workspaceMessageLanguage } from "./language-preferences";
import { serverTranslator, type Translator } from "./server-language";

type Member = { id: string; name: string };
type Work = { id: string; kind: string; completedToday?: boolean; parentId?: string | null; parentKind?: string };
type Submission = { id: string; member_id: string; work_snapshot_json: string; yesterday_work_snapshot_json: string; skip_reason: string | null };
type Item = { id: string; kind: string; title: string; parent_id: string | null; routine_id: string | null };
type Snapshot = { submission_id: string; task_id: string | null; id: string; parent_id: string | null; parent_kind: string };
type Settings = { owner_id: string; weekdays: string; timezone: string; summary_time: string };
export type DailyDigest = {
  date: string; members: Array<Member & { shared: boolean; skipped: boolean; completed: number; planned: number }>;
  groups: Array<{ id: string; title: string; completed: number; planned: number }>;
  completed: number; planned: number;
};

export function digestClock(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (key: string) => parts.find((part) => part.type === key)!.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, time: `${get("hour")}:${get("minute")}`, weekday: new Date(`${date}T00:00:00Z`).getUTCDay() };
}

export function parseDigestSettings(input: Record<string, unknown>) {
  if (input.summaryEnabled !== undefined && typeof input.summaryEnabled !== "boolean") throw new Error("요약 공유 설정을 확인해 주세요.");
  if (input.summaryTime !== undefined && (typeof input.summaryTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.summaryTime))) throw new Error("요약 공유 시간을 확인해 주세요.");
  return { summaryEnabled: input.summaryEnabled as boolean | undefined, summaryTime: input.summaryTime as string | undefined };
}

export async function loadDailyDigest(db: D1Database, ownerId: string, date: string): Promise<DailyDigest> {
  const members = await db.prepare(`SELECT m.id, COALESCE(NULLIF(TRIM(m.display_name), ''), m.email) AS name
    FROM workspace_members m JOIN slack_member_links l ON l.owner_id = m.workspace_id AND l.member_id = m.id
    JOIN slack_connections c ON c.owner_id = l.owner_id AND c.team_id = l.team_id
    LEFT JOIN slack_daily_preferences p ON p.owner_id = m.workspace_id AND p.member_id = m.id
    WHERE m.workspace_id = ? AND m.status = 'active' AND COALESCE(p.enabled, 1) = 1 ORDER BY m.display_name, m.id`)
    .bind(ownerId).all<Member>();
  const [submissions, items, snapshots] = await Promise.all([
    db.prepare(`SELECT s.id, s.member_id, s.work_snapshot_json, s.yesterday_work_snapshot_json, s.skip_reason
      FROM daily_submissions s WHERE s.owner_id = ? AND s.scrum_date = ? AND NOT EXISTS
      (SELECT 1 FROM daily_submissions newer WHERE newer.owner_id = s.owner_id AND newer.member_id = s.member_id
        AND newer.scrum_date = s.scrum_date AND newer.version > s.version)`)
      .bind(ownerId, date).all<Submission>(),
    db.prepare("SELECT id, kind, title, parent_id, routine_id FROM items WHERE owner_id = ?").bind(ownerId).all<Item>(),
    db.prepare(`SELECT task.* FROM daily_task_snapshots task JOIN daily_submissions s ON s.id = task.submission_id
      WHERE s.owner_id = ? AND s.scrum_date = ? AND NOT EXISTS (SELECT 1 FROM daily_submissions newer
        WHERE newer.owner_id = s.owner_id AND newer.member_id = s.member_id AND newer.scrum_date = s.scrum_date AND newer.version > s.version)`)
      .bind(ownerId, date).all<Snapshot>(),
  ]);
  return aggregateDailyDigest(date, members.results, submissions.results, items.results, snapshots.results);
}

function workList(json: string): Work[] {
  const value: unknown = JSON.parse(json || "[]");
  if (!Array.isArray(value)) throw new Error("데일리 업무 기록을 확인해 주세요.");
  return value.filter((work): work is Work => Boolean(work && typeof work.id === "string" && work.kind === "task"));
}

export function aggregateDailyDigest(date: string, members: Member[], submissions: Submission[], items: Item[], snapshots: Snapshot[]): DailyDigest {
  const byId = new Map(items.map((item) => [item.id, item]));
  const byMember = new Map(submissions.map((submission) => [submission.member_id, submission]));
  const groups = new Map<string, { id: string; title: string; completed: Set<string>; planned: Set<string> }>();
  const totals = { completed: new Set<string>(), planned: new Set<string>() };
  const bucket = (work: Work) => {
    const task = byId.get(work.id);
    if (task?.routine_id || (!task && work.parentKind === "routine")) return { id: "routines", title: "Routines" };
    const project = byId.get(task?.parent_id ?? work.parentId ?? "");
    const initiative = project?.kind === "project" ? byId.get(project.parent_id ?? "") : undefined;
    const kr = initiative?.kind === "initiative" ? byId.get(initiative.parent_id ?? "") : undefined;
    return kr?.kind === "key_result" ? { id: kr.id, title: kr.title } : { id: "unlinked", title: "KR 미연결" };
  };
  const rows = members.map((member) => {
    const submission = byMember.get(member.id);
    const completed = new Map<string, Work>(), planned = new Map<string, Work>();
    if (submission) {
      for (const work of workList(submission.yesterday_work_snapshot_json)) completed.set(work.id, work);
      for (const work of workList(submission.work_snapshot_json)) (work.completedToday ? completed : planned).set(work.id, work);
      for (const task of snapshots.filter((task) => task.submission_id === submission.id)) {
        const id = task.task_id ?? `deleted:${task.id}`;
        if (!planned.has(id)) planned.set(id, { id, kind: "task", parentId: task.parent_id, parentKind: task.parent_kind });
      }
      for (const id of completed.keys()) planned.delete(id);
    }
    for (const [kind, workMap] of [["completed", completed], ["planned", planned]] as const) {
      for (const work of workMap.values()) {
        const value = bucket(work);
        const group = groups.get(value.id) ?? { ...value, completed: new Set<string>(), planned: new Set<string>() };
        group[kind].add(work.id); totals[kind].add(work.id); groups.set(value.id, group);
      }
    }
    return { ...member, shared: Boolean(submission), skipped: Boolean(submission?.skip_reason), completed: completed.size, planned: planned.size };
  });
  if (!groups.has("routines")) groups.set("routines", { id: "routines", title: "Routines", completed: new Set(), planned: new Set() });
  return { date, members: rows, groups: [...groups.values()].sort((a, b) => {
    const rank = (id: string) => id === "routines" ? 1 : id === "unlinked" ? 2 : 0;
    return rank(a.id) - rank(b.id) || a.title.localeCompare(b.title);
  }).map((group) => ({ ...group, completed: group.completed.size, planned: group.planned.size })), completed: totals.completed.size, planned: totals.planned.size };
}

function escaped(value: string) { return value.replace(/[\r\n]+/g, " ").replace(/[&<>*_`~]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "*": "＊", "_": "＿", "`": "｀", "~": "～" })[c]!); }

// Page by text size and block count. Each page has its own durable, date-scoped receipt.
export function dailyDigestMessages(digest: DailyDigest, t: Translator) {
  const shared = digest.members.filter((member) => member.shared).length;
  const header = `${digest.date} · ${t("데일리 팀 요약")}`;
  const sections: string[] = [t("공유 {shared}/{total}명", { shared, total: digest.members.length })];
  const addLines = (title: string, lines: string[]) => {
    let text = `*${title}*`;
    for (const line of lines) {
      if (text.length + line.length > 2800) { sections.push(text); text = `*${title}*`; }
      text += `\n${line}`;
    }
    sections.push(text);
  };
  const missing = digest.members.filter((member) => !member.shared);
  if (missing.length) addLines(t("미공유 {count}명", { count: missing.length }), missing.map((member) => `*${escaped(member.name.slice(0, 100))} · ${t("미공유")}*`));
  for (const kind of ["completed", "planned"] as const) {
    const title = t(kind === "completed" ? "완료한 일" : "오늘 할 일");
    sections.push(`*${title} · ${t("{count}건", { count: digest[kind] })}*`);
    addLines(t("팀원별"), digest.members.map((member) => `${escaped(member.name.slice(0, 100))}: ${member.shared ? t("{count}건", { count: member[kind] }) + (member.skipped ? ` · ${t("스킵")}` : "") : `*${t("미공유")}*`}`));
    addLines(t("KR별"), digest.groups.map((group) => `${escaped((group.id === "unlinked" ? t("KR 미연결") : group.title).slice(0, 180))}: ${t("{count}건", { count: group[kind] })}`));
  }
  sections.push(t("제출된 Task 기준 · 전체와 KR별 합계는 중복 Task를 한 번만 집계합니다."));
  const pages = [];
  for (let start = 0; start < sections.length; start += 40) {
    const pageSections = sections.slice(start, start + 40);
    pages.push({ text: `${header}\n${sections[0]}\n${pageSections.join("\n\n")}`.slice(0, 39000), blocks: [
      { type: "header", text: { type: "plain_text", text: `${header}${sections.length > 40 ? ` (${start / 40 + 1}/${Math.ceil(sections.length / 40)})` : ""}` } },
      ...pageSections.map((text) => ({ type: "section", text: { type: "mrkdwn", text } })),
    ] });
  }
  return pages;
}

export async function runDueDailyDigests(db: D1Database, now = new Date(), ownerId?: string) {
  const settings = await db.prepare(`SELECT s.owner_id, s.weekdays, s.timezone, s.summary_time FROM slack_daily_settings s
    JOIN workspaces w ON w.id = s.owner_id AND w.scheduled_deletion_at IS NULL
    JOIN slack_connections c ON c.owner_id = s.owner_id
    WHERE s.enabled = 1 AND s.summary_enabled = 1 AND s.onboarding_completed_at IS NOT NULL
      AND s.install_status = 'connected' AND EXISTS (SELECT 1 FROM slack_daily_channels ch WHERE ch.owner_id = s.owner_id)
      ${ownerId ? "AND s.owner_id = ?" : ""}`).bind(...(ownerId ? [ownerId] : [])).all<Settings>();
  let checked = 0;
  for (const setting of settings.results) {
    try {
      const clock = digestClock(now, setting.timezone);
      if (!(JSON.parse(setting.weekdays) as number[]).includes(clock.weekday)) continue;
      const channels = await db.prepare(`SELECT c.channel_id FROM slack_daily_channels c WHERE c.owner_id = ?
        AND NOT EXISTS (SELECT 1 FROM slack_bot_deliveries d WHERE d.owner_id = c.owner_id AND d.bot_kind = 'daily_digest'
          AND d.event_key = ? || '/' || c.channel_id || '/0') ORDER BY c.channel_id`).bind(setting.owner_id, clock.date).all<{ channel_id: string }>();
      if (!channels.results.length) continue;
      if (clock.time < setting.summary_time) {
        const missing = await db.prepare(`SELECT m.id FROM workspace_members m
          JOIN slack_member_links l ON l.owner_id = m.workspace_id AND l.member_id = m.id
          JOIN slack_connections c ON c.owner_id = l.owner_id AND c.team_id = l.team_id
          LEFT JOIN slack_daily_preferences p ON p.owner_id = m.workspace_id AND p.member_id = m.id
          WHERE m.workspace_id = ? AND m.status = 'active' AND COALESCE(p.enabled, 1) = 1
            AND NOT EXISTS (SELECT 1 FROM daily_submissions s WHERE s.owner_id = m.workspace_id AND s.member_id = m.id AND s.scrum_date = ?)
          LIMIT 1`).bind(setting.owner_id, clock.date).first();
        if (missing) continue;
      }
      const digest = await loadDailyDigest(db, setting.owner_id, clock.date);
      if (!digest.members.length || (clock.time < setting.summary_time && digest.members.some((member) => !member.shared))) continue;
      const t = await serverTranslator(await workspaceMessageLanguage(db, setting.owner_id));
      const pages = dailyDigestMessages(digest, t);
      for (const channel of channels.results) {
        await queueDailyDigest(db, { ownerId: setting.owner_id, channel: channel.channel_id, date: clock.date, pages,
          memberIds: digest.members.map((member) => member.id),
          expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString() }, now);
      }
      await runDueSlackBotDeliveries(db, now, setting.owner_id);
      checked++;
    } catch (error) {
      console.error("daily_digest_failed", setting.owner_id, error instanceof Error ? error.message : "Daily summary failed");
    }
  }
  return { checked };
}
