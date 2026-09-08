import { env, waitUntil } from "cloudflare:workers";
import { memberMessageLanguage, readLanguagePreferences, workspaceMessageLanguage } from "./language-preferences";
import { serverTranslator, type Translator } from "./server-language";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  slackDailyChannels,
  slackDailyPreferences,
  slackDailySettings,
  slackMemberLinks,
  workspaceMembers,
  type SlackConnection,
} from "@/db/schema";
import { currentDailyMember, dailySkipReasonLabel, getDailyDashboard, normalizeDailySkipReason, type DailySubmissionValue } from "@/lib/daily-bot";
import { dailyWorkStatusLabel, normalizeDailyWorkStatus, parseDailyWorkStatuses, validateDailyWorkStatuses } from "@/lib/daily-work-status";
import { dailyWorkSnapshots, listDailyWork } from "@/lib/daily-work";
import { dailyWorkContainerLabel, dailyWorkOption } from "@/lib/slack-daily-form";
import { createDailyChecklist } from "@/lib/slack-daily-checklist";
import { attachSlackMember, readSlackMemberMatches, synchronizeSlackMembers } from "@/lib/slack-member-matching";
import { ensureWorkspace, getSlackConnection, getSlackConnectionByTeam, type RequestAuthorization } from "@/lib/pace-data";
import { decryptSlackSecret, slackDailyScopes, type SlackRuntimeEnv } from "@/lib/slack-oauth";
import { dailyDeliveryHealth } from "@/lib/slack-daily-status";

export { dailyMemberBySlack } from "@/lib/daily-bot";

type SlackApiResult = { ok?: boolean; error?: string; response_metadata?: { next_cursor?: string; messages?: string[] } } & Record<string, unknown>;
type SlackUser = {
  id: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: { email?: string; display_name?: string; real_name?: string };
};

export type SlackDailyChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  isShared: boolean;
  isExternal: boolean;
};
export const DAILY_REMINDER_BLOCK_PREFIX = "okri_daily_reminder:";
const DAILY_REMINDER_TEXT = "[데일리 봇] 오늘의 데일리를 작성해 주세요.";
const REMINDER_LEASE_MS = 120_000;
const REMINDER_RETRY_MS = 5 * 60_000;
const REMINDER_VERIFY_MS = 6 * 60 * 60_000;

class SlackRequestError extends Error {
  constructor(public code: string | undefined, method: string, details: string[] = []) {
    super(`${slackApiError(code, method)}${details.length ? ` ${details.join(" · ").slice(0, 500)}` : ""}`);
  }
}

export async function slackTokenForConnection(connection: Pick<SlackConnection, "encryptedBotToken">) {
  return decryptSlackSecret(connection.encryptedBotToken, (env as SlackRuntimeEnv).SLACK_TOKEN_ENCRYPTION_KEY!);
}

export async function slackApi<T extends SlackApiResult>(token: string, method: string, body: Record<string, unknown> = {}, signal?: AbortSignal) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const result = await response.json() as T;
  if (!response.ok || !result.ok) throw new SlackRequestError(result.error, method, result.response_metadata?.messages);
  return result;
}

export async function syncSlackDailyInstallation(ownerId: string) {
  await ensureWorkspace(ownerId);
  const connection = await getSlackConnection(ownerId);
  if (!connection) {
    await upsertSlackDailySettings(ownerId, { installStatus: "not_connected", lastError: "" });
    return { linked: 0, unmatched: 0, status: "not_connected" };
  }
  const missingScopes = slackDailyScopes.filter((scope) => !scopeSet(connection.scope).has(scope));
  if (missingScopes.length) {
    await upsertSlackDailySettings(ownerId, {
      installStatus: "needs_reauthorization",
      requiredScopes: missingScopes.join(","),
      lastError: `추가 Slack 권한이 필요합니다: ${missingScopes.join(", ")}`,
    });
    return { linked: 0, unmatched: 0, status: "needs_reauthorization", missingScopes };
  }
  const token = await slackTokenForConnection(connection);
  const users = await listAllSlackUsers(token);
  const matchResult = await synchronizeSlackMembers(env.DB, ownerId, connection.teamId, users);
  const now = new Date().toISOString();
  const currentSettings = await ensureDailySettingsRow(ownerId, connection);
  await upsertSlackDailySettings(ownerId, {
    enabled: currentSettings.onboardingCompletedAt ? currentSettings.enabled : false,
    installStatus: "connected", requiredScopes: "", lastSyncedAt: now, lastError: "",
  });
  await reconcileDailyReminders(ownerId);
  return { ...matchResult, status: "connected" };
}

export async function manageSlackMemberConnections(authorization: RequestAuthorization, action?: { type: "sync" } | { type: "link"; memberId: string; slackUserId: string }) {
  const connection = await getSlackConnection(authorization.ownerId);
  if (!connection) throw new Error("Slack을 먼저 연결해 주세요.");
  const users = await listAllSlackUsers(await slackTokenForConnection(connection));
  if (action?.type === "sync") await synchronizeSlackMembers(env.DB, authorization.ownerId, connection.teamId, users);
  if (action?.type === "link") {
    const user = users.find((entry) => entry.id === action.slackUserId);
    if (!user) throw new Error("이 Slack 워크스페이스의 활성 사용자를 선택해 주세요.");
    await attachSlackMember(env.DB, authorization.ownerId, connection.teamId, action.memberId, user, "admin");
  }
  const plan = await readSlackMemberMatches(env.DB, authorization.ownerId, connection.teamId, users);
  const labels: Record<string, string> = { connected: "연결됨", email_missing: "OKRI 이메일이 없습니다.",
    email_not_found: "같은 이메일의 Slack 계정을 찾지 못했습니다. 이메일이 다르거나 Slack 이메일이 공개되지 않았을 수 있습니다.",
    email_ambiguous: "같은 이메일이 여러 계정에 등록돼 자동 연결을 보류했습니다.",
    already_linked: "해당 Slack 계정이 다른 멤버에게 연결돼 있습니다.",
    email_match_pending: "이메일이 일치하지만 아직 연결되지 않았습니다.",
    slack_account_inactive: "연결됐던 Slack 계정이 비활성화됐거나 이 워크스페이스에서 확인되지 않습니다." };
  return { members: plan.members.map((member) => { const match = plan.matches.find((entry) => entry.memberId === member.id)!;
    return { memberId: member.id, displayName: member.display_name, email: member.email, reason: match.reason, message: labels[match.reason] }; }),
    availableUsers: users.filter((user) => !plan.links.some((link) => link.team_id === connection.teamId && link.slack_user_id === user.id))
      .map((user) => ({ id: user.id, displayName: user.profile?.display_name || user.profile?.real_name || "Slack 사용자", email: user.profile?.email || "" })) };
}

export async function createSlackMemberLinkUrl(ownerId: string, teamId: string, slackUserId: string, request: Request) {
  const connection = await getSlackConnection(ownerId);
  if (!connection || connection.teamId !== teamId) throw new Error("Slack 연결을 찾을 수 없습니다.");
  const token = await slackTokenForConnection(connection);
  const profile = await slackApi<SlackApiResult & { user?: SlackUser }>(token, "users.info", { user: slackUserId });
  const rawToken = randomHex(32);
  const tokenHash = await sha256(rawToken);
  const now = new Date();
  await env.DB.prepare(`INSERT INTO slack_link_tokens
    (token_hash, owner_id, team_id, slack_user_id, slack_email, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(tokenHash, ownerId, teamId, slackUserId, profile.user?.profile?.email ?? "", now.toISOString(), new Date(now.getTime() + 15 * 60_000).toISOString()).run();
  const runtime = env as unknown as { OKRI_APP_URL?: string; OKRPTR_APP_URL?: string };
  const appBase = runtime.OKRI_APP_URL || runtime.OKRPTR_APP_URL
    ? String(runtime.OKRI_APP_URL || runtime.OKRPTR_APP_URL).replace(/\/$/, "")
    : new URL(request.url).origin;
  return `${appBase}/?view=scrum&slack_link=${encodeURIComponent(rawToken)}`;
}

export async function consumeSlackMemberLink(authorization: RequestAuthorization, rawToken: string) {
  const tokenHash = await sha256(rawToken);
  const row = await env.DB.prepare(`SELECT * FROM slack_link_tokens
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? LIMIT 1`)
    .bind(tokenHash, new Date().toISOString()).first<Record<string, string>>();
  if (!row || row.owner_id !== authorization.ownerId) throw new Error("Slack 연결 링크가 만료되었거나 올바르지 않습니다.");
  const member = await currentMemberForSlackPreference(authorization);
  const connection = await getSlackConnection(authorization.ownerId);
  if (!connection || connection.teamId !== row.team_id) throw new Error("Slack 워크스페이스 연결이 변경되었습니다.");
  const token = await slackTokenForConnection(connection);
  const profile = await slackApi<SlackApiResult & { user?: SlackUser }>(token, "users.info", { user: row.slack_user_id });
  if (!profile.user || profile.user.deleted || profile.user.is_bot) throw new Error("연결할 수 없는 Slack 사용자입니다.");
  const now = new Date().toISOString();
  const linkId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO slack_member_links
      (id, owner_id, member_id, team_id, slack_user_id, slack_email, slack_display_name, matched_by, created_at, updated_at)
      SELECT ?, member.workspace_id, member.id, token.team_id, token.slack_user_id, ?, ?, 'manual', ?, ?
      FROM slack_link_tokens token JOIN workspace_members member ON member.workspace_id = token.owner_id
      JOIN slack_connections connection ON connection.owner_id = token.owner_id AND connection.team_id = token.team_id
      WHERE token.token_hash = ? AND token.used_at IS NULL AND token.expires_at > ?
        AND member.id = ? AND member.workspace_id = ? AND member.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM slack_member_links link WHERE
          (link.owner_id = member.workspace_id AND link.member_id = member.id)
          OR (link.team_id = token.team_id AND link.slack_user_id = token.slack_user_id))`)
      .bind(linkId, profile.user.profile?.email ?? row.slack_email ?? "",
        profile.user.profile?.display_name || profile.user.profile?.real_name || member.displayName,
        now, now, tokenHash, now, member.id, authorization.ownerId),
    env.DB.prepare(`UPDATE slack_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL
      AND EXISTS (SELECT 1 FROM slack_member_links WHERE id = ? AND owner_id = ? AND member_id = ?)`)
      .bind(now, tokenHash, linkId, authorization.ownerId, member.id),
  ]);
  if (results[0].meta.changes !== 1) throw new Error("이미 연결된 계정이거나 만료된 링크입니다. 기존 연결은 변경하지 않았습니다.");
  await scheduleMemberReminder(authorization.ownerId, member.id, { force: true });
  return { linked: true, memberId: member.id, slackUserId: row.slack_user_id };
}

export async function getSlackDailySettings(authorization: RequestAuthorization) {
  await ensureWorkspace(authorization.ownerId);
  const connection = await getSlackConnection(authorization.ownerId);
  const settings = await ensureDailySettingsRow(authorization.ownerId, connection);
  const [channels, members, failedPublications] = await Promise.all([
    getDb().select().from(slackDailyChannels).where(eq(slackDailyChannels.ownerId, authorization.ownerId)),
    env.DB.prepare(`SELECT member.id, member.display_name, member.email, member.role,
        link.slack_user_id, link.slack_email, link.slack_display_name, link.matched_by,
        preference.member_id AS preference_member_id, preference.enabled, preference.reminder_time, preference.timezone,
        reminder.status AS reminder_status, reminder.post_at, reminder.last_error AS reminder_error
      FROM workspace_members AS member
      LEFT JOIN slack_member_links AS link ON link.owner_id = member.workspace_id AND link.member_id = member.id
      LEFT JOIN slack_daily_preferences AS preference ON preference.owner_id = member.workspace_id AND preference.member_id = member.id
      LEFT JOIN slack_daily_reminders AS reminder ON reminder.owner_id = member.workspace_id AND reminder.member_id = member.id
      WHERE member.workspace_id = ? AND member.status = 'active'
      ORDER BY member.created_at`).bind(authorization.ownerId).all<Record<string, string | number | null>>(),
    env.DB.prepare(`SELECT publication.id, publication.submission_id, publication.channel_id, publication.error,
        publication.attempts, publication.updated_at, COALESCE(member.display_name, submission.member_name) AS member_name, submission.scrum_date
      FROM slack_daily_publications AS publication
      INNER JOIN daily_submissions AS submission ON submission.id = publication.submission_id
      LEFT JOIN workspace_members AS member ON member.workspace_id = submission.owner_id AND member.id = submission.member_id
      WHERE publication.owner_id = ? AND publication.status = 'failed'
      ORDER BY publication.updated_at DESC LIMIT 50`).bind(authorization.ownerId).all<Record<string, string | number | null>>(),
  ]);
  const serializedMembers = members.results.map((row) => ({
    memberId: String(row.id), displayName: String(row.display_name || row.email || "멤버"), email: String(row.email || ""), role: String(row.role),
    linked: Boolean(row.slack_user_id), slackUserId: row.slack_user_id ? String(row.slack_user_id) : null,
    slackDisplayName: row.slack_display_name ? String(row.slack_display_name) : null, matchedBy: row.matched_by ? String(row.matched_by) : null,
    preference: { enabled: row.enabled === null ? true : Boolean(row.enabled), configured: Boolean(row.preference_member_id), reminderTime: row.reminder_time ? String(row.reminder_time) : null, timezone: row.timezone ? String(row.timezone) : null },
    reminder: row.reminder_status ? { status: String(row.reminder_status), postAt: Number(row.post_at), error: String(row.reminder_error || "") } : null,
  }));
  return {
    connected: Boolean(connection),
    teamName: connection?.teamName ?? null,
    scopes: connection?.scope ?? "",
    needsReauthorization: settings.installStatus === "needs_reauthorization",
    setupComplete: Boolean(settings.onboardingCompletedAt),
    settings: serializeSettings(settings),
    delivery: dailyDeliveryHealth(settings, serializedMembers),
    channels: channels.map(serializeStoredChannel),
    members: serializedMembers,
    failedPublications: failedPublications.results.map((row) => ({
      id: String(row.id), submissionId: String(row.submission_id), channelId: String(row.channel_id), error: String(row.error || ""),
      attempts: Number(row.attempts), updatedAt: String(row.updated_at), memberName: String(row.member_name), date: String(row.scrum_date),
    })),
  };
}

export async function updateSlackDailySettings(ownerId: string, input: {
  enabled?: boolean; weekdays?: number[]; reminderTime?: string; timezone?: string; channelIds?: string[];
  summaryEnabled?: boolean; summaryTime?: string; workStatuses?: string[];
}) {
  const connection = await getSlackConnection(ownerId);
  if (!connection) throw new Error("Slack을 먼저 연결해 주세요.");
  const current = await ensureDailySettingsRow(ownerId, connection);
  const weekdays = input.weekdays === undefined ? parseWeekdays(current.weekdays) : normalizeWeekdays(input.weekdays);
  const reminderTime = input.reminderTime === undefined ? current.reminderTime : normalizeReminderTime(input.reminderTime);
  const timezone = input.timezone === undefined ? current.timezone : normalizeTimezone(input.timezone);
  const workStatuses = input.workStatuses === undefined ? parseDailyWorkStatuses(current.workStatuses) : validateDailyWorkStatuses(input.workStatuses);
  await upsertSlackDailySettings(ownerId, {
    enabled: input.enabled ?? current.enabled,
    weekdays: JSON.stringify(weekdays), reminderTime, timezone,
    summaryEnabled: input.summaryEnabled ?? current.summaryEnabled,
    summaryTime: input.summaryTime === undefined ? current.summaryTime : normalizeReminderTime(input.summaryTime),
    workStatuses: JSON.stringify(workStatuses),
  });
  if (input.channelIds) {
    const selected = await prepareSlackDailyChannels(ownerId, input.channelIds);
    await storeSlackDailyChannels(ownerId, selected);
  }
  await reconcileDailyReminders(ownerId, { force: true });
  return getSlackDailySettings({ ownerId, userId: "system", email: null, displayName: "System", role: "owner", apiToken: true });
}

export async function getSlackDailyPreference(authorization: RequestAuthorization) {
  const member = await currentMemberForSlackPreference(authorization);
  const [settings, preference, link] = await Promise.all([
    ensureDailySettingsRow(authorization.ownerId, await getSlackConnection(authorization.ownerId)),
    getDb().select().from(slackDailyPreferences).where(and(
      eq(slackDailyPreferences.ownerId, authorization.ownerId), eq(slackDailyPreferences.memberId, member.id),
    )).limit(1).then((rows) => rows[0] ?? null),
    getDb().select().from(slackMemberLinks).where(and(
      eq(slackMemberLinks.ownerId, authorization.ownerId), eq(slackMemberLinks.memberId, member.id),
    )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  return {
    memberId: member.id,
    linked: Boolean(link),
    enabled: preference?.enabled ?? true,
    reminderTime: preference?.reminderTime ?? settings.reminderTime,
    timezone: preference?.timezone ?? settings.timezone,
    usesWorkspaceTime: !preference?.reminderTime,
    usesWorkspaceTimezone: !preference?.timezone,
    workStatuses: parseDailyWorkStatuses(settings.workStatuses),
  };
}

export async function updateSlackDailyPreference(authorization: RequestAuthorization, input: {
  enabled?: boolean; reminderTime?: string | null; timezone?: string | null;
}) {
  const member = await currentMemberForSlackPreference(authorization);
  const [current] = await getDb().select().from(slackDailyPreferences).where(and(
    eq(slackDailyPreferences.ownerId, authorization.ownerId), eq(slackDailyPreferences.memberId, member.id),
  )).limit(1);
  const values = {
    enabled: input.enabled ?? current?.enabled ?? true,
    reminderTime: input.reminderTime === null ? null : input.reminderTime === undefined ? current?.reminderTime ?? null : normalizeReminderTime(input.reminderTime),
    timezone: input.timezone === null ? null : input.timezone === undefined ? current?.timezone ?? null : normalizeTimezone(input.timezone),
    updatedAt: new Date().toISOString(),
  };
  await getDb().insert(slackDailyPreferences).values({ id: current?.id ?? crypto.randomUUID(), ownerId: authorization.ownerId, memberId: member.id, ...values })
    .onConflictDoUpdate({ target: [slackDailyPreferences.ownerId, slackDailyPreferences.memberId], set: values });
  await scheduleMemberReminder(authorization.ownerId, member.id, { force: true });
  return getSlackDailyPreference(authorization);
}

export async function listSlackChannels(ownerId: string, options: { includeJoinablePublic?: boolean } = {}) {
  const connection = await getSlackConnection(ownerId);
  if (!connection) return [];
  const token = await slackTokenForConnection(connection);
  const channels: SlackDailyChannel[] = [];
  let cursor = "";
  do {
    const result = await slackApi<SlackApiResult & { channels?: Array<{
      id?: string;
      name?: string;
      is_private?: boolean;
      is_member?: boolean;
      is_archived?: boolean;
      is_shared?: boolean;
      is_ext_shared?: boolean;
      is_ext_ws_shared?: boolean;
      is_org_shared?: boolean;
      is_pending_ext_shared?: boolean;
    }> }>(token, "conversations.list", {
      types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor: cursor || undefined,
    });
    for (const channel of result.channels ?? []) {
      const isPrivate = Boolean(channel.is_private);
      const isMember = Boolean(channel.is_member);
      const isExternal = Boolean(channel.is_ext_shared || channel.is_ext_ws_shared || channel.is_pending_ext_shared);
      const isShared = Boolean(channel.is_shared || channel.is_org_shared || isExternal);
      const canSelect = isMember || Boolean(options.includeJoinablePublic && !isPrivate && !isShared);
      if (channel.id && channel.name && !channel.is_archived && canSelect) {
        channels.push({ id: channel.id, name: channel.name, isPrivate, isMember, isShared, isExternal });
      }
    }
    cursor = result.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return channels.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function canAutoJoinSlackChannel(channel: SlackDailyChannel) {
  return !channel.isPrivate && !channel.isShared && !channel.isMember;
}

export async function sendDailyReminderNow(ownerId: string, memberId: string) {
  return deliverDailyReminder(ownerId, memberId, false);
}

export async function testDailyDm(ownerId: string, memberId: string) {
  return deliverDailyReminder(ownerId, memberId, true);
}

async function deliverDailyReminder(ownerId: string, memberId: string, test: boolean) {
  const t = await serverTranslator(await memberMessageLanguage(env.DB, ownerId, memberId));
  const [connection, link, member] = await Promise.all([
    getSlackConnection(ownerId),
    getDb().select().from(slackMemberLinks).where(and(eq(slackMemberLinks.ownerId, ownerId), eq(slackMemberLinks.memberId, memberId))).limit(1).then((rows) => rows[0] ?? null),
    getDb().select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, ownerId), eq(workspaceMembers.id, memberId), eq(workspaceMembers.status, "active"),
    )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!connection || !link || !member) throw new Error("활성 워크스페이스 멤버의 Slack 연결이 필요합니다.");
  const token = await slackTokenForConnection(connection);
  const dmChannelId = await ensureDmChannel(token, link.slackUserId, link.dmChannelId);
  await slackApi(token, "chat.postMessage", {
    channel: dmChannelId,
    text: `[${t("데일리 봇")}] ${test ? `${t("테스트")} · ` : ""}${t("오늘의 데일리를 작성해 주세요.")}`,
    blocks: dailyReminderBlocks(`${DAILY_REMINDER_BLOCK_PREFIX}${test ? "test" : "manual"}:${crypto.randomUUID()}`, t),
  });
  if (dmChannelId !== link.dmChannelId) await getDb().update(slackMemberLinks).set({ dmChannelId, updatedAt: new Date().toISOString() }).where(eq(slackMemberLinks.id, link.id));
  return { sent: true, memberId, dmChannelId };
}

export async function testDailyChannel(ownerId: string, channelId: string) {
  const t = await serverTranslator(await workspaceMessageLanguage(env.DB, ownerId));
  const [connection, channel] = await Promise.all([
    getSlackConnection(ownerId),
    getDb().select().from(slackDailyChannels).where(and(
      eq(slackDailyChannels.ownerId, ownerId), eq(slackDailyChannels.channelId, channelId),
    )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!connection || !channel) throw new Error("선택된 Slack 공유 채널을 찾을 수 없습니다.");
  const token = await slackTokenForConnection(connection);
  await slackApi(token, "chat.postMessage", {
    channel: channelId,
    text: `[${t("데일리 봇")}] ${t("Slack 연결 테스트입니다. 데일리 공유가 이 채널에 전송됩니다.")}`,
  });
}

export async function configureSlackDailyOnboarding(authorization: RequestAuthorization, input: {
  weekdays: number[]; reminderTime: string; timezone: string; memberIds: string[]; channelIds: string[]; sendTests?: boolean;
  summaryEnabled?: boolean; summaryTime?: string; workStatuses?: string[];
}) {
  const connection = await getSlackConnection(authorization.ownerId);
  if (!connection) throw new Error("Slack을 먼저 연결해 주세요.");
  const missingScopes = slackDailyScopes.filter((scope) => !scopeSet(connection.scope).has(scope));
  if (missingScopes.length) throw new Error(`Slack 권한 업데이트가 필요합니다: ${missingScopes.join(", ")}`);

  const weekdays = normalizeWeekdays(input.weekdays);
  const reminderTime = normalizeReminderTime(input.reminderTime);
  const timezone = normalizeTimezone(input.timezone);
  const currentSettings = await ensureDailySettingsRow(authorization.ownerId, connection);
  const workStatuses = input.workStatuses === undefined ? parseDailyWorkStatuses(currentSettings.workStatuses) : validateDailyWorkStatuses(input.workStatuses);
  const memberIds = [...new Set(input.memberIds)];
  if (!memberIds.length) throw new Error("알림을 받을 멤버를 한 명 이상 선택해 주세요.");

  const [members, links] = await Promise.all([
    getDb().select().from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, authorization.ownerId), eq(workspaceMembers.status, "active"),
    )),
    getDb().select().from(slackMemberLinks).where(eq(slackMemberLinks.ownerId, authorization.ownerId)),
  ]);
  const activeMemberIds = new Set(members.map((member) => member.id));
  const linkByMemberId = new Map(links.map((link) => [link.memberId, link]));
  if (memberIds.some((memberId) => !activeMemberIds.has(memberId) || !linkByMemberId.has(memberId))) {
    throw new Error("Slack에 자동 연결된 활성 멤버만 선택할 수 있습니다.");
  }

  const selectedChannels = await prepareSlackDailyChannels(authorization.ownerId, input.channelIds);
  const summaryTime = input.summaryTime === undefined ? currentSettings.summaryTime : normalizeReminderTime(input.summaryTime);
  const now = new Date().toISOString();
  await upsertSlackDailySettings(authorization.ownerId, {
    enabled: true,
    weekdays: JSON.stringify(weekdays),
    reminderTime,
    timezone,
    onboardingCompletedAt: now,
    summaryEnabled: input.summaryEnabled ?? currentSettings.summaryEnabled,
    summaryTime,
    workStatuses: JSON.stringify(workStatuses),
    installStatus: "connected",
    requiredScopes: "",
    lastError: "",
  });
  await storeSlackDailyChannels(authorization.ownerId, selectedChannels);

  const selectedMemberIds = new Set(memberIds);
  for (const member of members) {
    await getDb().insert(slackDailyPreferences).values({
      id: crypto.randomUUID(), ownerId: authorization.ownerId, memberId: member.id,
      enabled: selectedMemberIds.has(member.id), reminderTime: null, timezone: null, updatedAt: now,
    }).onConflictDoUpdate({
      target: [slackDailyPreferences.ownerId, slackDailyPreferences.memberId],
      set: { enabled: selectedMemberIds.has(member.id), updatedAt: now },
    });
  }

  const scheduleResults: Array<{ memberId: string; status: "scheduled" | "failed"; postAt: number | null; error?: string }> = [];
  for (const link of links) {
    try {
      await scheduleMemberReminder(authorization.ownerId, link.memberId, { force: true });
      if (selectedMemberIds.has(link.memberId)) {
        const reminder = await env.DB.prepare("SELECT post_at, status FROM slack_daily_reminders WHERE owner_id = ? AND member_id = ? LIMIT 1")
          .bind(authorization.ownerId, link.memberId).first<{ post_at: number; status: string }>();
        if (reminder?.status !== "scheduled" || reminder.post_at <= Date.now() / 1000) throw new Error("다음 Slack 알림 예약을 확인하지 못했습니다.");
        scheduleResults.push({ memberId: link.memberId, status: "scheduled", postAt: reminder.post_at });
      }
    } catch (error) {
      if (selectedMemberIds.has(link.memberId)) {
        scheduleResults.push({ memberId: link.memberId, status: "failed", postAt: null, error: error instanceof Error ? error.message : "Slack 알림 예약 실패" });
      }
    }
  }

  const installerMember = members.find((member) => member.userId === authorization.userId);
  const dmTest: { status: "sent" | "skipped" | "failed"; memberId: string | null; error?: string } = {
    status: "skipped", memberId: installerMember?.id ?? null,
  };
  if (input.sendTests && installerMember && selectedMemberIds.has(installerMember.id) && linkByMemberId.has(installerMember.id)) {
    try { await testDailyDm(authorization.ownerId, installerMember.id); dmTest.status = "sent"; }
    catch (error) { dmTest.status = "failed"; dmTest.error = error instanceof Error ? error.message : "테스트 DM 전송 실패"; }
  }

  const channelTests = [] as Array<{ channelId: string; channelName: string; status: "sent" | "failed"; error?: string }>;
  for (const channel of input.sendTests ? selectedChannels : []) {
    try {
      await testDailyChannel(authorization.ownerId, channel.id);
      channelTests.push({ channelId: channel.id, channelName: channel.name, status: "sent" });
    } catch (error) {
      channelTests.push({ channelId: channel.id, channelName: channel.name, status: "failed", error: error instanceof Error ? error.message : "테스트 채널 전송 실패" });
    }
  }

  const setupErrors = [
    ...scheduleResults.filter((entry) => entry.status === "failed").map((entry) => entry.error || "Slack 알림 예약 실패"),
    ...(dmTest.status === "failed" ? [dmTest.error || "테스트 DM 전송 실패"] : []),
    ...channelTests.filter((entry) => entry.status === "failed").map((entry) => entry.error || "테스트 채널 전송 실패"),
  ];
  await upsertSlackDailySettings(authorization.ownerId, { lastError: setupErrors.join(" · ") });

  return {
    setupComplete: scheduleResults.length === memberIds.length && scheduleResults.every((entry) => entry.status === "scheduled"),
    admin: await getSlackDailySettings(authorization),
    tests: { dm: dmTest, channels: channelTests },
    schedules: scheduleResults,
  };
}

export async function disconnectSlackDaily(ownerId: string, connection: SlackConnection) {
  // Pause first. An in-flight reservation rechecks this state and cancels itself.
  await ensureDailySettingsRow(ownerId, connection);
  const paused = await env.DB.prepare(`UPDATE slack_daily_settings SET enabled = 0, updated_at = ? WHERE owner_id = ?
    AND EXISTS (SELECT 1 FROM slack_connections WHERE owner_id = ? AND id = ?)`)
    .bind(new Date().toISOString(), ownerId, ownerId, connection.id).run();
  if (!paused.meta.changes) throw new Error("Slack 연결이 변경되었습니다. 현재 연결을 확인해 주세요.");
  const reminders = await env.DB.prepare("SELECT * FROM slack_daily_reminders WHERE owner_id = ?")
    .bind(ownerId).all<Record<string, string | number>>();
  for (const reminder of reminders.results) {
    const result = await scheduleMemberReminder(ownerId, String(reminder.member_id), { force: true, connection });
    if (result === "busy") throw new Error("진행 중인 Slack 예약을 정리하고 있습니다. 잠시 후 연결 해제를 다시 시도해 주세요.");
  }
  const cleanupGuard = `EXISTS (SELECT 1 FROM slack_daily_settings s JOIN slack_connections c ON c.owner_id = s.owner_id
      WHERE s.owner_id = ? AND s.enabled = 0 AND c.id = ?)
    AND NOT EXISTS (SELECT 1 FROM slack_daily_reminders WHERE owner_id = ?)`;
  // The batch must not erase a newly enabled setup or an unobserved in-flight receipt.
  const finalized = await env.DB.batch([
    env.DB.prepare(`UPDATE slack_daily_settings SET install_status = 'not_connected', required_scopes = '',
      onboarding_completed_at = NULL, last_error = '', updated_at = ? WHERE owner_id = ? AND ${cleanupGuard}`)
      .bind(new Date().toISOString(), ownerId, ownerId, connection.id, ownerId),
    env.DB.prepare(`DELETE FROM slack_member_links WHERE owner_id = ? AND ${cleanupGuard}`).bind(ownerId, ownerId, connection.id, ownerId),
    env.DB.prepare(`DELETE FROM slack_daily_channels WHERE owner_id = ? AND ${cleanupGuard}`).bind(ownerId, ownerId, connection.id, ownerId),
  ]);
  if (!finalized[0].meta.changes) throw new Error("Slack 설정이나 예약이 변경되었습니다. 현재 상태를 확인한 뒤 연결 해제를 다시 시도해 주세요.");
}

export async function reconcileDailyReminders(ownerId: string, options: ReminderOptions = {}) {
  const links = await env.DB.prepare(`SELECT member_id AS memberId FROM slack_member_links WHERE owner_id = ?
    UNION SELECT member_id AS memberId FROM slack_daily_reminders WHERE owner_id = ?`).bind(ownerId, ownerId).all<{ memberId: string }>();
  const failures: string[] = [];
  for (const link of links.results) {
    try { await scheduleMemberReminder(ownerId, link.memberId, options); } catch (error) {
      failures.push(error instanceof Error ? error.message : "Slack 알림 예약 실패");
    }
  }
  await upsertSlackDailySettings(ownerId, { lastError: [...new Set(failures)].join(" · ") });
  return { checked: links.results.length, failed: failures.length };
}

export async function refreshUserReminderLanguages(userId: string) {
  const memberships = await env.DB.prepare(`SELECT m.workspace_id, m.id FROM workspace_members m
    JOIN slack_daily_reminders r ON r.owner_id = m.workspace_id AND r.member_id = m.id
    WHERE m.user_id = ? AND m.status = 'active'`).bind(userId).all<{ workspace_id: string; id: string }>();
  for (const member of memberships.results) {
    try { await scheduleMemberReminder(member.workspace_id, member.id, { verify: true }); }
    catch (error) { console.error("reminder_language_reconcile_failed", error instanceof Error ? error.message : "Unknown failure"); }
  }
}

// Repair missing/failed/overdue reservations independently of a user's settings visit.
// Slack owns the actual delivery time; this only maintains the next reservation.
export async function repairSlackDailyReminders(ownerId: string) {
  const now = Date.now();
  const due = await env.DB.prepare(`WITH targets AS (
      SELECT owner_id, member_id FROM slack_member_links WHERE owner_id = ?
      UNION SELECT owner_id, member_id FROM slack_daily_reminders WHERE owner_id = ?
    ) SELECT t.member_id FROM targets t
    JOIN slack_daily_settings s ON s.owner_id = t.owner_id
    LEFT JOIN slack_member_links l ON l.owner_id = t.owner_id AND l.member_id = t.member_id
    LEFT JOIN workspace_members m ON m.workspace_id = t.owner_id AND m.id = t.member_id AND m.status = 'active'
    LEFT JOIN slack_daily_preferences p ON p.owner_id = t.owner_id AND p.member_id = t.member_id
    LEFT JOIN slack_daily_reminders r ON r.owner_id = t.owner_id AND r.member_id = t.member_id
    WHERE (r.id IS NULL AND s.enabled = 1 AND s.install_status = 'connected' AND s.onboarding_completed_at IS NOT NULL
        AND COALESCE(p.enabled, 1) = 1 AND m.id IS NOT NULL AND l.id IS NOT NULL)
      OR (r.id IS NOT NULL AND r.updated_at < ? AND (
        r.status != 'scheduled' OR r.post_at < ? OR r.updated_at < ? OR s.enabled = 0
        OR COALESCE(p.enabled, 1) = 0 OR m.id IS NULL OR l.id IS NULL OR s.install_status != 'connected'
        OR l.slack_user_id != r.slack_user_id))
    ORDER BY COALESCE(r.updated_at, ''), t.member_id LIMIT 20`)
    .bind(ownerId, ownerId, new Date(now - REMINDER_RETRY_MS).toISOString(), Math.floor(now / 1000) - 60,
      new Date(now - REMINDER_VERIFY_MS).toISOString()).all<{ member_id: string }>();
  const signal = AbortSignal.timeout(20_000);
  let checked = 0, failed = 0;
  const failures: string[] = [];
  for (const row of due.results) {
    if (signal.aborted) break;
    try { await scheduleMemberReminder(ownerId, row.member_id, { verify: true, signal }); }
    catch (error) {
      failed += 1;
      failures.push(error instanceof Error ? error.message : "Slack 알림 예약 실패");
    }
    checked += 1;
  }
  if (checked) {
    const errors = await env.DB.prepare("SELECT DISTINCT last_error FROM slack_daily_reminders WHERE owner_id = ? AND status = 'failed' AND last_error != '' LIMIT 10")
      .bind(ownerId).all<{ last_error: string }>();
    await upsertSlackDailySettings(ownerId, { lastError: [...new Set([...failures, ...errors.results.map((row) => row.last_error)])].join(" · ") });
  }
  return { checked, failed };
}

export async function runDueSlackDailyReminders() {
  const rows = await env.DB.prepare(`SELECT s.owner_id FROM slack_daily_settings s
    JOIN workspaces w ON w.id = s.owner_id AND w.scheduled_deletion_at IS NULL
    WHERE (s.enabled = 1 AND s.install_status = 'connected' AND s.onboarding_completed_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM slack_daily_reminders r WHERE r.owner_id = s.owner_id)
    ORDER BY s.updated_at, s.owner_id LIMIT 20`).all<{ owner_id: string }>();
  for (const row of rows.results) {
    try { await repairSlackDailyReminders(row.owner_id); }
    catch (error) { console.error("slack_daily_repair_failed", row.owner_id, error instanceof Error ? error.message : "Unknown failure"); }
    // Rotate bounded maintenance fairly, even when this workspace needs no repair.
    try {
      await env.DB.prepare("UPDATE slack_daily_settings SET updated_at = ? WHERE owner_id = ?")
        .bind(new Date().toISOString(), row.owner_id).run();
    } catch (error) { console.error("slack_daily_rotation_failed", row.owner_id, error instanceof Error ? error.message : "Unknown failure"); }
  }
}

type ReminderOptions = { force?: boolean; verify?: boolean; signal?: AbortSignal; connection?: SlackConnection };

// This predicate fences the external write against current tenant, recipient and settings state.
const ACTIVE_REMINDER_SQL = `EXISTS (SELECT 1 FROM slack_daily_settings s
  JOIN workspaces w ON w.id = s.owner_id AND w.scheduled_deletion_at IS NULL
  JOIN slack_connections c ON c.owner_id = s.owner_id
  JOIN workspace_members m ON m.workspace_id = s.owner_id AND m.id = ? AND m.status = 'active'
  LEFT JOIN users u ON u.id = m.user_id
  JOIN slack_member_links l ON l.owner_id = s.owner_id AND l.member_id = m.id
  LEFT JOIN slack_daily_preferences p ON p.owner_id = s.owner_id AND p.member_id = m.id
  WHERE s.owner_id = ? AND c.id = ? AND c.team_id = l.team_id AND l.slack_user_id = ?
    AND s.enabled = 1 AND s.install_status = 'connected' AND s.onboarding_completed_at IS NOT NULL
    AND COALESCE(p.enabled, 1) = 1 AND COALESCE(p.reminder_time, s.reminder_time) = ?
    AND COALESCE(p.timezone, s.timezone) = ? AND s.weekdays = ?
    AND COALESCE(CASE WHEN u.language_preference = 'auto' THEN u.resolved_language ELSE u.language_preference END, w.message_language) = ?)`;

export async function scheduleMemberReminder(ownerId: string, memberId: string, options: ReminderOptions = {}) {
  const language = await memberMessageLanguage(env.DB, ownerId, memberId);
  const t = await serverTranslator(language);
  const messageText = `[${t("데일리 봇")}] ${t("오늘의 데일리를 작성해 주세요.")}`;
  const connection = options.connection ?? await getSlackConnection(ownerId);
  const [settings, preference, link, existing, member] = await Promise.all([
    ensureDailySettingsRow(ownerId, connection),
    getDb().select().from(slackDailyPreferences).where(and(eq(slackDailyPreferences.ownerId, ownerId), eq(slackDailyPreferences.memberId, memberId))).limit(1).then((rows) => rows[0] ?? null),
    getDb().select().from(slackMemberLinks).where(and(eq(slackMemberLinks.ownerId, ownerId), eq(slackMemberLinks.memberId, memberId))).limit(1).then((rows) => rows[0] ?? null),
    env.DB.prepare("SELECT * FROM slack_daily_reminders WHERE owner_id = ? AND member_id = ? LIMIT 1").bind(ownerId, memberId).first<Record<string, string | number>>(),
    env.DB.prepare("SELECT id FROM workspace_members WHERE workspace_id = ? AND id = ? AND status = 'active'").bind(ownerId, memberId).first(),
  ]);
  if (!connection) return "unavailable";
  const enabled = Boolean(member && link && link.teamId === connection.teamId && settings.enabled
    && settings.onboardingCompletedAt && (preference?.enabled ?? true) && settings.installStatus === "connected");
  if (!enabled && !existing) return "canceled";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const leaseCutoff = new Date(Date.now() - REMINDER_LEASE_MS).toISOString();
  if (existing?.status === "scheduling" && String(existing.updated_at) >= leaseCutoff) return "busy";
  const time = preference?.reminderTime ?? settings.reminderTime;
  const timezone = preference?.timezone ?? settings.timezone;
  const previousPostAt = Number(existing?.post_at || 0);
  const previousParts = enabled && previousPostAt > nowSeconds && previousPostAt <= nowSeconds + 60 ? zonedParts(new Date(previousPostAt * 1000), timezone) : null;
  const imminent = previousParts && `${String(previousParts.hour).padStart(2, "0")}:${String(previousParts.minute).padStart(2, "0")}` === time
    && parseWeekdays(settings.weekdays).includes(new Date(Date.UTC(previousParts.year, previousParts.month - 1, previousParts.day)).getUTCDay());
  const postAt = enabled ? imminent ? previousPostAt : nextReminderEpoch(time, timezone, parseWeekdays(settings.weekdays)) : Number(existing!.post_at);
  const languageChanged = Boolean(existing && (String(existing.message_language ?? "ko") !== language || String(existing.message_text ?? DAILY_REMINDER_TEXT) !== messageText));
  // Slack locks near-delivery cancellation; keep that receipt and change the next one.
  if (enabled && languageChanged && existing?.status === "scheduled" && imminent) return "scheduled";
  if (enabled && existing?.status === "scheduled" && Number(existing.post_at) === postAt && postAt > nowSeconds + 60
    && existing.slack_user_id === link!.slackUserId && existing.bot_user_id === connection.botUserId && !languageChanged && !options.force && !options.verify) return "scheduled";
  const blockId = existing && Number(existing.post_at) === postAt && existing.slack_user_id === link?.slackUserId
    ? String(existing.block_id) : `${DAILY_REMINDER_BLOCK_PREFIX}${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const claim = await env.DB.prepare(`INSERT INTO slack_daily_reminders
    (id, owner_id, member_id, slack_user_id, dm_channel_id, scheduled_message_id, post_at, block_id, bot_user_id, status, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'scheduling', '', ?, ?)
    ON CONFLICT(owner_id, member_id) DO UPDATE SET status = 'scheduling', updated_at = excluded.updated_at
    WHERE slack_daily_reminders.updated_at = ?
      AND (slack_daily_reminders.status != 'scheduling' OR slack_daily_reminders.updated_at < ?)`)
    .bind(existing?.id ?? crypto.randomUUID(), ownerId, memberId, link?.slackUserId ?? existing!.slack_user_id,
      link?.dmChannelId || existing?.dm_channel_id || "", postAt, blockId, connection.botUserId, now, now, existing?.updated_at ?? "", leaseCutoff).run();
  if (!claim.meta.changes) return "busy";
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  const removeClaim = () => env.DB.prepare("DELETE FROM slack_daily_reminders WHERE owner_id = ? AND member_id = ? AND updated_at = ?")
    .bind(ownerId, memberId, now).run();
  try {
    const token = await slackTokenForConnection(connection);
    if (!enabled) {
      await cancelScheduledReminder(token, existing!, signal);
      await removeClaim();
      return "canceled";
    }
    const guardArgs = [memberId, ownerId, connection.id, link!.slackUserId, time, timezone, settings.weekdays, language];
    const dmChannelId = await ensureDmChannel(token, link!.slackUserId, link!.dmChannelId, signal);
    // Reuse Slack's receipt after a lost response; do not schedule a duplicate.
    const receipts = await reminderReceipts(token, dmChannelId, postAt, signal);
    const priorText = String(existing?.message_text ?? DAILY_REMINDER_TEXT);
    const knownReceipt = receipts.find((entry) => entry.id === existing?.scheduled_message_id);
    const matchingReceipts = receipts.filter((entry) => entry.text === priorText || entry.text === messageText);
    if (!knownReceipt && matchingReceipts.length > 1) throw new Error("Slack 예약 결과를 하나로 확인할 수 없습니다. 중복 방지를 위해 기존 예약을 보존합니다.");
    let scheduledId: string | undefined = knownReceipt?.id ?? matchingReceipts[0]?.id;
    let canceledPrevious = false;
    if (languageChanged && scheduledId) {
      await cancelScheduledReminder(token, { ...existing!, dm_channel_id: dmChannelId, post_at: postAt, scheduled_message_id: scheduledId }, signal);
      canceledPrevious = existing?.dm_channel_id === dmChannelId && Number(existing?.post_at) === postAt
        && (!existing?.scheduled_message_id || existing.scheduled_message_id === scheduledId);
      scheduledId = undefined;
    }
    if (existing && !canceledPrevious && (existing.dm_channel_id !== dmChannelId || Number(existing.post_at) !== postAt
      || (existing.scheduled_message_id && String(existing.scheduled_message_id) !== scheduledId))) await cancelScheduledReminder(token, existing, signal);
    const reservation = { post_at: postAt, block_id: blockId, dm_channel_id: dmChannelId, scheduled_message_id: scheduledId ?? "", message_text: messageText };
    const prepared = await env.DB.prepare(`UPDATE slack_daily_reminders SET post_at = ?, block_id = ?, dm_channel_id = ?, scheduled_message_id = ?, message_language = ?, message_text = ?
      WHERE owner_id = ? AND member_id = ? AND updated_at = ? AND ${ACTIVE_REMINDER_SQL}`)
      .bind(postAt, blockId, dmChannelId, scheduledId ?? "", language, messageText, ownerId, memberId, now, ...guardArgs).run();
    if (!prepared.meta.changes) {
      if (scheduledId) await cancelScheduledReminder(token, reservation, signal);
      await removeClaim();
      return "changed";
    }
    if (!scheduledId) {
      const result = await slackApi<SlackApiResult & { scheduled_message_id?: string }>(token, "chat.scheduleMessage", {
        channel: dmChannelId, post_at: postAt, text: messageText, blocks: dailyReminderBlocks(blockId, t),
      }, signal);
      scheduledId = result.scheduled_message_id;
      if (!scheduledId) throw new Error("Slack 예약 메시지 ID를 받지 못했습니다.");
    }
    reservation.scheduled_message_id = scheduledId;
    // Keep the receipt durable even when the user changed settings while Slack replied.
    await env.DB.prepare("UPDATE slack_daily_reminders SET scheduled_message_id = ? WHERE owner_id = ? AND member_id = ? AND updated_at = ?")
      .bind(scheduledId, ownerId, memberId, now).run();
    const completed = await env.DB.prepare(`UPDATE slack_daily_reminders SET slack_user_id = ?, bot_user_id = ?,
      status = 'scheduled', last_error = '', updated_at = ? WHERE owner_id = ? AND member_id = ? AND updated_at = ? AND ${ACTIVE_REMINDER_SQL}`)
      .bind(link!.slackUserId, connection.botUserId, new Date().toISOString(), ownerId, memberId, now, ...guardArgs).run();
    if (!completed.meta.changes) {
      await cancelScheduledReminder(token, reservation, signal);
      await removeClaim();
      return "changed";
    }
    if (dmChannelId !== link!.dmChannelId) await getDb().update(slackMemberLinks).set({ dmChannelId, updatedAt: now }).where(eq(slackMemberLinks.id, link!.id));
    return "scheduled";
  } catch (error) {
    await env.DB.prepare("UPDATE slack_daily_reminders SET status = 'failed', last_error = ?, updated_at = ? WHERE owner_id = ? AND member_id = ? AND updated_at = ?")
      .bind(error instanceof Error ? error.message : "Slack 알림 예약 실패", new Date().toISOString(), ownerId, memberId, now).run();
    throw error;
  }
}

export async function handleDeliveredDailyReminder(input: { teamId: string; channelId: string; botId: string; blockIds: string[] }) {
  const connection = await getSlackConnectionByTeam(input.teamId);
  if (!connection || connection.botUserId !== input.botId) return false;
  const reminder = await env.DB.prepare(`SELECT * FROM slack_daily_reminders
    WHERE owner_id = ? AND dm_channel_id = ? AND bot_user_id = ? AND status = 'scheduled' LIMIT 1`)
    .bind(connection.ownerId, input.channelId, input.botId).first<Record<string, string | number>>();
  if (!reminder || !input.blockIds.includes(String(reminder.block_id))) return false;
  await env.DB.prepare("UPDATE slack_daily_reminders SET status = 'delivered', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), reminder.id).run();
  await scheduleMemberReminder(connection.ownerId, String(reminder.member_id), { force: true });
  return true;
}

export async function publishDailySubmission(ownerId: string, submissionId: string) {
  const connection = await getSlackConnection(ownerId);
  if (!connection) return;
  const submission = await loadSubmission(submissionId, ownerId);
  if (!submission) return;
  const publications = await env.DB.prepare(`SELECT * FROM slack_daily_publications
    WHERE owner_id = ? AND submission_id = ? AND status IN ('pending', 'failed') ORDER BY channel_id`)
    .bind(ownerId, submissionId).all<Record<string, string | number | null>>();
  const t = await serverTranslator(await workspaceMessageLanguage(env.DB, ownerId));
  for (const publication of publications.results) {
    const now = new Date().toISOString();
    try {
      const message = dailyCard(submission, t);
      const receipt = await env.DB.prepare("SELECT id FROM slack_bot_deliveries WHERE owner_id = ? AND bot_kind = 'daily_publication' AND event_key = ?")
        .bind(ownerId, publication.id).first();
      if (!receipt && Number(publication.attempts) > 0 && !publication.slack_message_ts) {
        throw new Error("이전 데일리 공유 결과를 확인할 수 없습니다. 중복 방지를 위해 자동 재게시하지 않습니다.");
      }
      const { deliverSlackBotMessage } = await import("@/lib/slack-bot-delivery");
      await deliverSlackBotMessage(env.DB, {
        ownerId, botKind: "daily_publication", subjectId: String(publication.id), eventKey: String(publication.id),
        payload: { channel: String(publication.channel_id), ...message,
          streamKey: JSON.stringify([submission.memberId, submission.date, publication.channel_id]) },
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      });
    } catch (error) {
      await env.DB.prepare(`UPDATE slack_daily_publications SET status = 'failed', error = ?, updated_at = ? WHERE owner_id = ? AND id = ?`)
        .bind(error instanceof Error ? error.message : "Slack 채널 전송 실패", now, ownerId, publication.id).run();
    }
  }
  const { runDueDailyDigests } = await import("@/lib/slack-daily-digest");
  await runDueDailyDigests(env.DB, new Date(), ownerId);
}

export async function retryDailyPublication(ownerId: string, publicationId: string) {
  const row = await env.DB.prepare("SELECT submission_id FROM slack_daily_publications WHERE id = ? AND owner_id = ? LIMIT 1")
    .bind(publicationId, ownerId).first<{ submission_id: string }>();
  if (!row) throw new Error("게시 기록을 찾을 수 없습니다.");
  await publishDailySubmission(ownerId, row.submission_id);
  const result = await env.DB.prepare("SELECT status, error FROM slack_daily_publications WHERE owner_id = ? AND id = ?")
    .bind(ownerId, publicationId).first<{ status: string; error: string }>();
  if (result?.status === "failed") throw new Error(result.error || "데일리 공유 결과 확인이 필요합니다.");
}

export async function republishLatestDailySubmission(ownerId: string, memberId: string, requestId: string) {
  const normalizedRequestId = requestId.trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(normalizedRequestId)) throw new Error("재공유 요청을 확인할 수 없습니다.");
  const latest = await env.DB.prepare(`SELECT submission.id
    FROM daily_submissions submission
    INNER JOIN workspace_members member ON member.workspace_id = submission.owner_id
      AND member.id = submission.member_id AND member.status = 'active'
    WHERE submission.owner_id = ? AND submission.member_id = ?
    ORDER BY submission.scrum_date DESC, submission.version DESC, submission.submitted_at DESC LIMIT 1`)
    .bind(ownerId, memberId).first<{ id: string }>();
  if (!latest) throw new Error("공유할 최신 데일리 제출을 찾을 수 없습니다.");
  const submission = await loadSubmission(latest.id, ownerId);
  if (!submission) throw new Error("공유할 최신 데일리 제출을 찾을 수 없습니다.");
  const channels = await env.DB.prepare("SELECT channel_id FROM slack_daily_channels WHERE owner_id = ? ORDER BY channel_id")
    .bind(ownerId).all<{ channel_id: string }>();
  if (!channels.results.length) throw new Error("데일리 공유 채널을 먼저 선택해 주세요.");

  const { deliverSlackBotMessage } = await import("@/lib/slack-bot-delivery");
  const t = await serverTranslator(await workspaceMessageLanguage(env.DB, ownerId));
  const message = dailyCard(submission, t);
  for (const channel of channels.results) {
    const createdId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO slack_daily_publications
      (id, owner_id, member_id, submission_id, scrum_date, channel_id, status, error, attempts, updated_at)
      SELECT ?, submission.owner_id, submission.member_id, submission.id, submission.scrum_date, ?, 'pending', '', 0, ?
      FROM daily_submissions submission
      INNER JOIN slack_daily_channels configured ON configured.owner_id = submission.owner_id AND configured.channel_id = ?
      WHERE submission.owner_id = ? AND submission.id = ?
      ON CONFLICT(submission_id, channel_id) DO NOTHING`)
      .bind(createdId, channel.channel_id, now, channel.channel_id, ownerId, submission.id).run();
    const publication = await env.DB.prepare(`SELECT id FROM slack_daily_publications
      WHERE owner_id = ? AND submission_id = ? AND channel_id = ? LIMIT 1`)
      .bind(ownerId, submission.id, channel.channel_id).first<{ id: string }>();
    if (!publication) throw new Error("데일리 공유 기록을 만들지 못했습니다.");
    const receipt = await deliverSlackBotMessage(env.DB, {
      ownerId, botKind: "daily_publication", subjectId: publication.id,
      eventKey: `republish:${publication.id}:${normalizedRequestId}`,
      payload: { channel: channel.channel_id, ...message,
        streamKey: JSON.stringify([submission.memberId, submission.date, channel.channel_id]) },
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    });
    if (receipt.status !== "sent") throw new Error(receipt.last_error || "최신 데일리를 Slack 채널에 공유하지 못했습니다.");
    await env.DB.prepare(`UPDATE slack_daily_publications SET status = 'superseded', error = '', updated_at = ?
      WHERE owner_id = ? AND member_id = ? AND scrum_date = ? AND channel_id = ? AND id != ? AND status = 'failed'`)
      .bind(new Date().toISOString(), ownerId, submission.memberId, submission.date, channel.channel_id, publication.id).run();
  }
  const { runDueDailyDigests } = await import("@/lib/slack-daily-digest");
  await runDueDailyDigests(env.DB, new Date(), ownerId);
  return { memberId: submission.memberId, submissionId: submission.id, date: submission.date, version: submission.version, channels: channels.results.length };
}

export function dailyReminderBlocks(blockId: string, t: Translator = (key) => key) {
  return [
    { type: "context", elements: [{ type: "mrkdwn", text: `*${t("데일리 봇")}*` }] },
    { type: "section", block_id: `${blockId}:body`, text: { type: "mrkdwn", text: `*${t("오늘 할 Task를 선택해 주세요.")}*\n${t("근무 상태를 고르고 Project별 Task를 선택합니다.")}` } },
    { type: "actions", block_id: blockId, elements: [{ type: "button", action_id: "daily_open", text: { type: "plain_text", text: t("Task 선택") }, style: "primary", value: "daily" }] },
  ];
}

export async function openDailyModal(triggerId: string, authorization: RequestAuthorization) {
  const t = await serverTranslator((await readLanguagePreferences(env.DB, authorization.userId)).resolvedLanguage);
  const connection = await getSlackConnection(authorization.ownerId);
  if (!connection) throw new Error("Slack 연결을 찾을 수 없습니다.");
  const token = await slackTokenForConnection(connection);
  const opened = await slackApi<SlackApiResult & { view?: { id: string; hash?: string } }>(token, "views.open", {
    trigger_id: triggerId, view: { type: "modal", title: { type: "plain_text", text: t("오늘 할 업무") },
      close: { type: "plain_text", text: t("닫기") }, blocks: [{ type: "section", text: { type: "plain_text", text: t("내게 배정된 업무를 불러오고 있습니다.") } }] },
  });
  const viewId = opened.view?.id;
  if (!viewId) throw new Error("데일리 창을 열지 못했습니다.");
  // A trigger expires quickly; load the private workload only after opening the modal.
  waitUntil((async () => {
    try {
      const preference = await getSlackDailyPreference(authorization);
      const dashboard = await getDailyDashboard(authorization, todayInTimezone(preference.timezone));
      const view = await createDailyChecklist(authorization.ownerId, dashboard.member.id, {
         ...dashboard.draft, date: dashboard.date, work: dashboard.candidates.work, memberName: dashboard.member.displayName,
         taskFocused: true,
         workStatusOptions: preference.workStatuses,
        taskTargets: [...dashboard.createTargets.projects.map((project) => ({ key: `project:${project.id}`, title: project.title, hasTasks: project.hasTasks })),
          ...dashboard.createTargets.routines.map((routine) => ({ key: `routine:${routine.id}`, title: routine.title, hasTasks: routine.hasTasks }))],
        choices: Object.fromEntries(dashboard.draft.selectedWorkIds.filter((key) => key.startsWith("task:")).map((key) => [key, "today" as const])),
        selectedYesterday: dashboard.candidates.yesterdayWork.filter((entry) => entry.kind === "task" && entry.completedYesterday).slice(0, 50).map((entry) => entry.key),
        yesterdayCompleted: dashboard.candidates.yesterdayWork.filter((entry) => entry.kind === "task" && entry.completedYesterday), page: 0,
      }, t);
      await slackApi(token, "views.update", { view_id: viewId, hash: opened.view?.hash, view });
    } catch {
      await slackApi(token, "views.update", { view_id: viewId, view: { type: "modal",
        title: { type: "plain_text", text: t("오늘 할 업무") }, close: { type: "plain_text", text: t("닫기") },
        blocks: [{ type: "section", text: { type: "plain_text", text: t("업무를 불러오지 못했습니다. 잠시 후 데일리를 다시 열어 주세요. 제출된 내용은 없습니다.") } }] } }).catch(() => undefined);
    }
  })());
}

export async function updateDailyChecklistView(ownerId: string, viewId: string, hash: string | undefined, view: Record<string, unknown>) {
  const connection = await getSlackConnection(ownerId);
  if (!connection) throw new Error("Slack 연결을 찾을 수 없습니다.");
  await slackApi(await slackTokenForConnection(connection), "views.update", { view_id: viewId, hash, view });
}

export async function externalTaskOptions(authorization: RequestAuthorization, query: string, workMode: boolean | "today" | "yesterday" = false, date?: string) {
  const [preference, t] = await Promise.all([
    getSlackDailyPreference(authorization),
    serverTranslator((await readLanguagePreferences(env.DB, authorization.userId)).resolvedLanguage),
  ]);
  const day = date || todayInTimezone(preference.timezone);
  const normalized = query.trim().toLocaleLowerCase();
  if (workMode === "today" || workMode === "yesterday") {
    const dashboard = await getDailyDashboard(authorization, day);
    const work = (workMode === "yesterday" ? dashboard.candidates.yesterdayWork : dashboard.candidates.work).filter((entry) => entry.kind === "task");
    return work.filter((entry) => !normalized || `${entry.title} ${entry.parentTitle}`.toLocaleLowerCase().includes(normalized))
      .slice(0, 100).map((entry) => dailyWorkOption(entry, t, workMode));
  }
  if (workMode === true) {
    const member = await currentDailyMember(authorization);
    const work = (await listDailyWork(env.DB, authorization.ownerId, member.id, day)).filter((entry) => entry.kind === "task");
    return work.slice(60).filter((entry) => !normalized || `${entry.title} ${entry.parentTitle}`.toLocaleLowerCase().includes(normalized)).slice(0, 100).map((entry) => dailyWorkOption(entry, t));
  }
  const dashboard = await getDailyDashboard(authorization, day);
  return dashboard.candidates.tasks.filter((task) => !normalized || `${task.title} ${task.parentTitle}`.toLocaleLowerCase().includes(normalized)).slice(0, 100).map(taskOption);
}

function taskOption(task: { id: string; title: string; parentTitle: string }) {
  return { text: { type: "plain_text", text: `${task.title} · ${task.parentTitle}`.slice(0, 75) }, value: task.id };
}
async function listAllSlackUsers(token: string) {
  const users: SlackUser[] = [];
  let cursor = "";
  do {
    const result = await slackApi<SlackApiResult & { members?: SlackUser[] }>(token, "users.list", { limit: 200, cursor: cursor || undefined });
    users.push(...(result.members ?? []).filter((user) => user.id && user.id !== "USLACKBOT" && !user.is_bot && !user.is_app_user && !user.deleted));
    cursor = result.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return users;
}

async function ensureDailySettingsRow(ownerId: string, connection: SlackConnection | null) {
  let [settings] = await getDb().select().from(slackDailySettings).where(eq(slackDailySettings.ownerId, ownerId)).limit(1);
  if (!settings) {
    const missingScopes = connection ? slackDailyScopes.filter((scope) => !scopeSet(connection.scope).has(scope)) : slackDailyScopes;
    [settings] = await getDb().insert(slackDailySettings).values({
      ownerId,
      installStatus: !connection ? "not_connected" : missingScopes.length ? "needs_reauthorization" : "connected",
      enabled: false,
      requiredScopes: missingScopes.join(","),
    }).returning();
  }
  return settings;
}

async function upsertSlackDailySettings(ownerId: string, values: Partial<typeof slackDailySettings.$inferInsert>) {
  const now = new Date().toISOString();
  await getDb().insert(slackDailySettings).values({ ownerId, updatedAt: now, ...values })
    .onConflictDoUpdate({ target: slackDailySettings.ownerId, set: { ...values, updatedAt: now } });
}

async function currentMemberForSlackPreference(authorization: RequestAuthorization) {
  await ensureWorkspace(authorization.ownerId);
  const [member] = await getDb().select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, authorization.ownerId), eq(workspaceMembers.userId, authorization.userId), eq(workspaceMembers.status, "active"),
  )).limit(1);
  if (!member) throw new Error("현재 멤버를 찾을 수 없습니다.");
  return member;
}

export async function ensureDmChannel(token: string, slackUserId: string, existing: string, signal?: AbortSignal) {
  if (existing) return existing;
  const result = await slackApi<SlackApiResult & { channel?: { id?: string } }>(token, "conversations.open", { users: slackUserId, return_im: true }, signal);
  if (!result.channel?.id) throw new Error("Slack DM 채널을 열지 못했습니다.");
  return result.channel.id;
}

type ReminderReceipt = { id: string; channel_id: string; post_at: number; text: string };

async function reminderReceipts(token: string, channel: string, postAt: number, signal?: AbortSignal) {
  if (!channel || !postAt) return [];
  const receipts: ReminderReceipt[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page += 1) {
    const result = await slackApi<SlackApiResult & { scheduled_messages?: ReminderReceipt[] }>(token, "chat.scheduledMessages.list", {
      // Query pending receipts without time bounds. Slack can reject bounds for
      // expired reservations; filter the exact delivery timestamp locally instead.
      channel, limit: 100, ...(cursor ? { cursor } : {}),
    }, signal);
    receipts.push(...(result.scheduled_messages ?? []).filter((entry) => entry.channel_id === channel && Number(entry.post_at) === postAt));
    cursor = result.response_metadata?.next_cursor ?? "";
    if (!cursor) return receipts;
  }
  throw new Error("Slack 예약 목록을 모두 확인하지 못했습니다. 중복 방지를 위해 재예약을 보류했습니다.");
}

async function cancelScheduledReminder(token: string, reminder: Record<string, string | number>, signal?: AbortSignal) {
  const channel = String(reminder.dm_channel_id), postAt = Number(reminder.post_at);
  const expectedText = String(reminder.message_text ?? DAILY_REMINDER_TEXT);
  let id = String(reminder.scheduled_message_id || "");
  if (!id) {
    const candidates = (await reminderReceipts(token, channel, postAt, signal)).filter((entry) => entry.text === expectedText);
    if (candidates.length > 1) throw new Error("Slack 예약 결과를 하나로 확인할 수 없습니다. 중복 방지를 위해 기존 예약을 보존합니다.");
    id = candidates[0]?.id ?? "";
  }
  if (!id) return;
  try {
    await slackApi(token, "chat.deleteScheduledMessage", { channel, scheduled_message_id: id }, signal);
  } catch (error) {
    if (!(error instanceof SlackRequestError) || !["invalid_scheduled_message_id", "message_not_found"].includes(error.code ?? "")) throw error;
    // Slack also returns this error during its final 60-second cancellation lock.
    if ((await reminderReceipts(token, channel, postAt, signal)).some((entry) => entry.id === id)) {
      throw new Error("Slack 발송 직전 예약은 취소할 수 없습니다. 기존 예약을 보존하고 재예약을 보류했습니다.");
    }
  }
}

async function loadSubmission(id: string, ownerId: string) {
  const row = await env.DB.prepare(`SELECT submission.*, member.display_name AS current_member_name
    FROM daily_submissions AS submission
    LEFT JOIN workspace_members AS member ON member.workspace_id = submission.owner_id AND member.id = submission.member_id
    WHERE submission.id = ? AND submission.owner_id = ? LIMIT 1`).bind(id, ownerId).first<Record<string, string | number | null>>();
  if (!row) return null;
  const snapshots = await env.DB.prepare("SELECT * FROM daily_task_snapshots WHERE submission_id = ? ORDER BY sort_order").bind(id).all<Record<string, string | number | null>>();
  return {
    id: String(row.id), memberId: row.member_id ? String(row.member_id) : null, memberName: String(row.current_member_name || row.member_name), memberEmail: String(row.member_email),
    date: String(row.scrum_date), version: Number(row.version), yesterdayNote: String(row.yesterday_note), todayNote: String(row.today_note),
    blockersNote: String(row.blockers_note), noPlannedTasks: Boolean(row.no_planned_tasks),
    workStatus: row.skip_reason ? "skip" : normalizeDailyWorkStatus(row.work_status),
    skipReason: normalizeDailySkipReason(row.skip_reason), skipNote: String(row.skip_note || ""),
    source: String(row.source), submittedAt: String(row.submitted_at),
    work: dailyWorkSnapshots(String(row.work_snapshot_json || "[]")),
    yesterdayWork: dailyWorkSnapshots(String(row.yesterday_work_snapshot_json || "[]")),
    tasks: snapshots.results.map((snapshot) => ({ id: String(snapshot.id), taskId: snapshot.task_id ? String(snapshot.task_id) : null,
      taskTitle: String(snapshot.task_title), parentKind: String(snapshot.parent_kind), parentId: snapshot.parent_id ? String(snapshot.parent_id) : null,
      parentTitle: String(snapshot.parent_title), status: String(snapshot.status), isNew: Boolean(snapshot.is_new), sortOrder: Number(snapshot.sort_order) })),
  } satisfies DailySubmissionValue;
}

function dailyCard(submission: DailySubmissionValue, t: Translator = (key, values) => key.replace(/\{(\w+)\}/g, (match, name: string) => values && Object.hasOwn(values, name) ? String(values[name]) : match)) {
  if (submission.workStatus === "skip" && !submission.skipReason) {
    const appUrl = `${String((env as unknown as Record<string, unknown>).OKRI_APP_URL || (env as unknown as Record<string, unknown>).OKRPTR_APP_URL || "https://okri.ai").replace(/\/$/, "")}/?view=scrum`;
    return { text: `[${t("데일리 봇")}] ${t("{member}님의 {date} 데일리", { member: submission.memberName, date: submission.date })} · ${t("스킵")}`, unfurl_links: false, unfurl_media: false, blocks: [
      { type: "header", text: { type: "plain_text", text: `${t("데일리 봇")} · ${submission.memberName} · ${submission.date}`.slice(0, 150) } },
      { type: "section", text: { type: "mrkdwn", text: `*${t("오늘 근무")}*\n${t("스킵")}` } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: t("OKRI에서 보기") }, url: appUrl }] },
    ] };
  }
  if (submission.skipReason) {
    const reason = t(dailySkipReasonLabel(submission.skipReason));
    const detail = submission.skipNote ? `\n${escapeSlack(submission.skipNote)}` : "";
    const appUrl = `${String((env as unknown as Record<string, unknown>).OKRI_APP_URL || (env as unknown as Record<string, unknown>).OKRPTR_APP_URL || "https://okri.ai").replace(/\/$/, "")}/?view=scrum`;
    return { text: `[${t("데일리 봇")}] ${t("{member}님의 {date} 데일리 스킵 · {reason}", { member: submission.memberName, date: submission.date, reason })}`, unfurl_links: false, unfurl_media: false, blocks: [
      { type: "header", text: { type: "plain_text", text: `${t("데일리 봇")} · ${submission.memberName} · ${submission.date}`.slice(0, 150) } },
      { type: "section", text: { type: "mrkdwn", text: `*⏭️ ${t("오늘 데일리 스킵")}*\n*${t("사유")}:* ${reason}${detail}`.slice(0, 2900) } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: t("OKRI에서 보기") }, url: appUrl }] },
    ] };
  }
  type CardWork = { taskTitle: string; parentTitle: string; parentKind?: string; groupKey: string; completedToday: boolean };
  const allWork: CardWork[] = [...submission.tasks.map((task) => ({ ...task, groupKey: `${task.parentKind}:${task.parentId || "general"}`, completedToday: false })), ...(submission.work ?? []).map((work) => ({ taskTitle: work.title, parentTitle: work.kind === "project" || work.kind === "routine" ? work.title : work.parentTitle, parentKind: work.kind === "task" ? work.parentKind : work.kind, groupKey: work.kind === "task" ? `${work.parentKind}:${work.parentId || "general"}` : work.key, isNew: false, completedToday: Boolean(work.completedToday) }))];
  const completedSnapshots = [...new Map([...(submission.yesterdayWork ?? []), ...(submission.work ?? []).filter((work) => work.completedToday)].map((work) => [work.key, work])).values()];
  const completedWork = completedSnapshots.map((work) => ({ taskTitle: work.title, parentTitle: work.kind === "project" || work.kind === "routine" ? work.title : work.parentTitle, parentKind: work.kind === "task" ? work.parentKind : work.kind, groupKey: work.kind === "task" ? `${work.parentKind}:${work.parentId || "general"}` : work.key, isNew: false, completedToday: true }));
  const plannedWork = allWork.filter((work) => !work.completedToday);
  const groupedLines = (work: CardWork[], emptyText = t("오늘 예정 없음")) => {
    const groups = new Map<string, { title: string; lines: string[] }>();
    for (const task of work.slice(0, 20)) {
      const group = groups.get(task.groupKey) ?? { title: dailyWorkContainerLabel(task, t), lines: [] };
      group.lines.push(`• ${escapeSlack(task.taskTitle)}`);
      groups.set(task.groupKey, group);
    }
    const lines = work.length ? [...groups.values()].map((group) => `*${escapeSlack(group.title)}*\n${group.lines.join("\n")}`).join("\n\n") : `• ${emptyText}`;
    return lines + (work.length > 20 ? `\n_${t("외 {count}개", { count: work.length - 20 })}_` : "");
  };
  const blocker = submission.blockersNote ? `\n*${t("블로커")}*\n${escapeSlack(submission.blockersNote)}` : "";
  const note = submission.todayNote ? `\n*${t("오늘 메모")}*\n${escapeSlack(submission.todayNote)}` : "";
  const completedNote = submission.yesterdayNote ? `\n*${t("완료 메모")}*\n${escapeSlack(submission.yesterdayNote)}` : "";
  const appUrl = `${String((env as unknown as Record<string, unknown>).OKRI_APP_URL || (env as unknown as Record<string, unknown>).OKRPTR_APP_URL || "https://okri.ai").replace(/\/$/, "")}/?view=scrum`;
  const text = `[${t("데일리 봇")}] ${t("{member}님의 {date} 데일리", { member: submission.memberName, date: submission.date })}`;
  return { text, unfurl_links: false, unfurl_media: false, blocks: [
    { type: "header", text: { type: "plain_text", text: `${t("데일리 봇")} · ${submission.memberName} · ${submission.date}`.slice(0, 150) } },
    { type: "context", elements: [{ type: "mrkdwn", text: `*${t("오늘 근무")}:* ${t(dailyWorkStatusLabel(submission.workStatus))}` }] },
    { type: "section", text: { type: "mrkdwn", text: `*${t("완료한 일")}*\n${groupedLines(completedWork, t("선택한 업무 없음"))}${completedNote}`.slice(0, 2900) } },
    { type: "section", text: { type: "mrkdwn", text: `*${t("오늘 할 일")}*\n${groupedLines(plannedWork)}${note}${blocker}`.slice(0, 2900) } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: t("OKRI에서 보기") }, url: appUrl }] },
  ] };
}

function serializeSettings(settings: typeof slackDailySettings.$inferSelect) {
  return { enabled: settings.enabled, weekdays: parseWeekdays(settings.weekdays), reminderTime: settings.reminderTime, timezone: settings.timezone,
    summaryEnabled: settings.summaryEnabled, summaryTime: settings.summaryTime,
    workStatuses: parseDailyWorkStatuses(settings.workStatuses),
    installStatus: settings.installStatus, requiredScopes: settings.requiredScopes ? settings.requiredScopes.split(",").filter(Boolean) : [],
    onboardingCompletedAt: settings.onboardingCompletedAt,
    lastSyncedAt: settings.lastSyncedAt, lastError: settings.lastError, updatedAt: settings.updatedAt };
}

function serializeStoredChannel(channel: typeof slackDailyChannels.$inferSelect) {
  return { id: channel.channelId, name: channel.channelName, isPrivate: channel.isPrivate, isMember: true, isShared: false, isExternal: false };
}

async function prepareSlackDailyChannels(ownerId: string, channelIds: string[]) {
  const uniqueChannelIds = [...new Set(channelIds)];
  if (!uniqueChannelIds.length) return [];
  const connection = await getSlackConnection(ownerId);
  if (!connection) throw new Error("Slack을 먼저 연결해 주세요.");
  const available = await listSlackChannels(ownerId, { includeJoinablePublic: true });
  const byId = new Map(available.map((channel) => [channel.id, channel]));
  const selected = uniqueChannelIds.map((id) => byId.get(id)).filter((channel): channel is SlackDailyChannel => Boolean(channel));
  if (selected.length !== uniqueChannelIds.length) throw new Error("공개 채널 또는 봇이 참여한 비공개·공유 채널만 선택할 수 있습니다.");
  const token = await slackTokenForConnection(connection);
  for (const channel of selected) {
    if (canAutoJoinSlackChannel(channel)) await slackApi(token, "conversations.join", { channel: channel.id });
  }
  return selected.map((channel) => ({ ...channel, isMember: true }));
}

async function storeSlackDailyChannels(ownerId: string, channels: SlackDailyChannel[]) {
  await getDb().delete(slackDailyChannels).where(eq(slackDailyChannels.ownerId, ownerId));
  if (channels.length) await getDb().insert(slackDailyChannels).values(channels.map((channel) => ({
    id: crypto.randomUUID(), ownerId, channelId: channel.id, channelName: channel.name, isPrivate: channel.isPrivate,
  })));
}

function scopeSet(value: string) {
  return new Set(value.split(/[ ,]/).map((scope) => scope.trim()).filter(Boolean));
}

function normalizeWeekdays(values: number[]) {
  const result = [...new Set(values.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
  if (!result.length) throw new Error("알림 요일을 하나 이상 선택해 주세요.");
  return result;
}

function parseWeekdays(value: string) {
  try { return normalizeWeekdays(JSON.parse(value) as number[]); } catch { return [1, 2, 3, 4, 5]; }
}

function normalizeReminderTime(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("알림 시간은 HH:mm 형식이어야 합니다.");
  return value;
}

function normalizeTimezone(value: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); } catch { throw new Error("올바른 시간대를 선택해 주세요."); }
  return value;
}

export function nextReminderEpoch(time: string, timezone: string, weekdays: number[], now = new Date()) {
  const [hour, minute] = normalizeReminderTime(time).split(":").map(Number);
  const localNow = zonedParts(now, timezone);
  const base = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day));
  for (let offset = 0; offset < 15; offset += 1) {
    const day = new Date(base.getTime() + offset * 86_400_000);
    if (!weekdays.includes(day.getUTCDay())) continue;
    const epoch = zonedDateTimeToEpoch({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute }, timezone);
    if (epoch > Math.floor(now.getTime() / 1000) + 60) return epoch;
  }
  throw new Error("다음 Slack 알림 시간을 계산하지 못했습니다.");
}

function zonedDateTimeToEpoch(parts: { year: number; month: number; day: number; hour: number; minute: number }, timezone: string) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = zonedParts(new Date(guess), timezone);
    const wantedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    guess += wantedAsUtc - actualAsUtc;
  }
  return Math.floor(guess / 1000);
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function todayInTimezone(timezone: string) {
  const parts = zonedParts(new Date(), timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function escapeSlack(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function randomHex(byteLength: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function slackApiError(code: string | undefined, method: string) {
  if (code === "missing_scope") return "Slack 권한 업데이트가 필요합니다.";
  if (code === "not_in_channel") return "OKRI 봇을 해당 채널에 먼저 초대해 주세요.";
  if (code === "invalid_auth" || code === "token_revoked") return "Slack 연결이 만료되었습니다. 다시 연결해 주세요.";
  return `Slack ${method} 요청에 실패했습니다${code ? ` (${code})` : ""}.`;
}
