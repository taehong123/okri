import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { importPKCS8, SignJWT } from "jose";
import { getDb } from "@/db";
import {
  itemAssignments,
  items,
  notificationDevices,
  notificationPreferences,
  notifications,
  users,
  workspaceMembers,
  workspaces,
} from "@/db/schema";
import { decryptPrivateValue, encryptPrivateValue } from "@/lib/secret-crypto";

export type NotificationKind = "assignment" | "morning_brief";
export type PushPlatform = "android" | "ios";
type Language = "ko" | "en" | "ja" | "zh" | "es";

export type NotificationRuntime = {
  DB: D1Database;
  PUSH_TOKEN_ENCRYPTION_KEY?: string;
  OKRI_FCM_SERVICE_ACCOUNT_JSON?: string;
  OKRI_APNS_KEY_ID?: string;
  OKRI_APNS_TEAM_ID?: string;
  OKRI_APNS_PRIVATE_KEY?: string;
  OKRI_APNS_TOPIC?: string;
};

type AssignmentItem = { id: string; kind: string; title: string };
type NotificationPayload = {
  itemTitle?: string;
  itemKind?: string;
  role?: string;
  overdueCount?: number;
  dueTodayCount?: number;
  openCount?: number;
};

type NotificationPreferenceValues = {
  assignmentPush: boolean;
  morningBriefPush: boolean;
  digestHour: number;
  timezone: string;
};

const DEFAULT_PREFERENCES: NotificationPreferenceValues = {
  assignmentPush: true,
  morningBriefPush: true,
  digestHour: 9,
  timezone: "Asia/Seoul",
};

function runtime() {
  return env as typeof env & NotificationRuntime;
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function language(value: string | null | undefined): Language {
  const base = value?.toLowerCase().split(/[-_]/)[0];
  return base === "ko" || base === "ja" || base === "zh" || base === "es" ? base : "en";
}

function safePayload(value: string): NotificationPayload {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function notificationCopy(kind: string, payload: NotificationPayload, locale: Language) {
  if (kind === "morning_brief") {
    const counts = {
      ko: `지연 ${payload.overdueCount ?? 0} · 오늘 마감 ${payload.dueTodayCount ?? 0} · 진행 중 ${payload.openCount ?? 0}`,
      en: `${payload.overdueCount ?? 0} overdue · ${payload.dueTodayCount ?? 0} due today · ${payload.openCount ?? 0} open`,
      ja: `期限超過 ${payload.overdueCount ?? 0}・本日締切 ${payload.dueTodayCount ?? 0}・進行中 ${payload.openCount ?? 0}`,
      zh: `逾期 ${payload.overdueCount ?? 0} · 今日到期 ${payload.dueTodayCount ?? 0} · 进行中 ${payload.openCount ?? 0}`,
      es: `${payload.overdueCount ?? 0} atrasadas · ${payload.dueTodayCount ?? 0} vencen hoy · ${payload.openCount ?? 0} abiertas`,
    }[locale];
    return {
      title: { ko: "오늘의 업무를 확인하세요", en: "Review today's work", ja: "今日の業務を確認しましょう", zh: "查看今天的工作", es: "Revisa el trabajo de hoy" }[locale],
      body: counts,
    };
  }
  const label = payload.itemKind === "project" ? "Project" : "Task";
  return {
    title: {
      ko: `새 ${label}가 배정되었습니다`,
      en: `A new ${label} was assigned to you`,
      ja: `新しい${label}が割り当てられました`,
      zh: `你被分配了新的 ${label}`,
      es: `Se te asignó un nuevo ${label}`,
    }[locale],
    body: payload.itemTitle || label,
  };
}

export async function enqueueAssignmentNotifications(input: {
  workspaceId: string;
  item: AssignmentItem;
  role: string;
  memberIds: string[];
  actorUserId?: string | null;
  eventId?: string;
}) {
  if (!input.memberIds.length) return;
  const members = await getDb().select({ id: workspaceMembers.id, userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, input.workspaceId),
      eq(workspaceMembers.status, "active"),
      inArray(workspaceMembers.id, input.memberIds),
    ));
  const now = new Date().toISOString();
  const eventId = input.eventId ?? crypto.randomUUID();
  const rows = members.flatMap(member => member.userId && member.userId !== input.actorUserId ? [{
    id: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    userId: member.userId,
    memberId: member.id,
    itemId: input.item.id,
    kind: "assignment" as const,
    payloadJson: JSON.stringify({ itemTitle: input.item.title, itemKind: input.item.kind, role: input.role }),
    dedupeKey: `assignment:${input.item.id}:${input.role}:${member.id}:${eventId}`,
    pushAfter: now,
    createdAt: now,
  }] : []);
  if (rows.length) await getDb().insert(notifications).values(rows).onConflictDoNothing();
}

export async function listNotifications(workspaceId: string, userId: string, requestedLanguage?: string | null) {
  const rows = await getDb().select().from(notifications).where(and(
    eq(notifications.workspaceId, workspaceId),
    eq(notifications.userId, userId),
  )).orderBy(desc(notifications.createdAt)).limit(100);
  const locale = language(requestedLanguage);
  return {
    unreadCount: rows.filter(row => !row.readAt).length,
    notifications: rows.map(row => ({
      id: row.id,
      kind: row.kind,
      itemId: row.itemId,
      ...notificationCopy(row.kind, safePayload(row.payloadJson), locale),
      readAt: row.readAt,
      createdAt: row.createdAt,
    })),
  };
}

export async function markNotificationsRead(workspaceId: string, userId: string, input: { id?: string; all?: boolean }) {
  if (!input.all && !input.id) throw new Error("Choose a notification or mark all as read");
  const conditions = [eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId), isNull(notifications.readAt)];
  if (!input.all && input.id) conditions.push(eq(notifications.id, input.id));
  await getDb().update(notifications).set({ readAt: new Date().toISOString() }).where(and(...conditions));
  return { ok: true };
}

async function preferenceRecord(workspaceId: string, userId: string) {
  const [row] = await getDb().select().from(notificationPreferences).where(and(
    eq(notificationPreferences.workspaceId, workspaceId),
    eq(notificationPreferences.userId, userId),
  )).limit(1);
  return row;
}

export async function getNotificationPreferences(workspaceId: string, userId: string) {
  const row = await preferenceRecord(workspaceId, userId);
  const [device] = await getDb().select({ count: sql<number>`count(*)` }).from(notificationDevices).where(and(
    eq(notificationDevices.userId, userId),
    isNull(notificationDevices.disabledAt),
  ));
  return {
    assignmentPush: row?.assignmentPush ?? DEFAULT_PREFERENCES.assignmentPush,
    morningBriefPush: row?.morningBriefPush ?? DEFAULT_PREFERENCES.morningBriefPush,
    digestHour: row?.digestHour ?? DEFAULT_PREFERENCES.digestHour,
    timezone: row?.timezone ?? DEFAULT_PREFERENCES.timezone,
    registeredDeviceCount: Number(device?.count ?? 0),
  };
}

export async function saveNotificationPreferences(workspaceId: string, userId: string, patch: Partial<NotificationPreferenceValues>) {
  const current = await preferenceRecord(workspaceId, userId);
  const next = {
    assignmentPush: patch.assignmentPush ?? current?.assignmentPush ?? DEFAULT_PREFERENCES.assignmentPush,
    morningBriefPush: patch.morningBriefPush ?? current?.morningBriefPush ?? DEFAULT_PREFERENCES.morningBriefPush,
    digestHour: patch.digestHour ?? current?.digestHour ?? DEFAULT_PREFERENCES.digestHour,
    timezone: patch.timezone ?? current?.timezone ?? DEFAULT_PREFERENCES.timezone,
  };
  if (!Number.isInteger(next.digestHour) || next.digestHour < 0 || next.digestHour > 23) throw new Error("Digest hour must be between 0 and 23");
  try { new Intl.DateTimeFormat("en", { timeZone: next.timezone }).format(); }
  catch { throw new Error("Unsupported timezone"); }
  const now = new Date().toISOString();
  await getDb().insert(notificationPreferences).values({
    id: current?.id ?? crypto.randomUUID(), workspaceId, userId, ...next,
    createdAt: current?.createdAt ?? now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [notificationPreferences.workspaceId, notificationPreferences.userId],
    set: { ...next, updatedAt: now },
  });
  return getNotificationPreferences(workspaceId, userId);
}

export async function registerNotificationDevice(input: {
  workspaceId: string;
  userId: string;
  token: string;
  platform: PushPlatform;
  appId: string;
  locale: string;
  environment: "production" | "development";
}) {
  const secret = runtime().PUSH_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("Push registration is not configured");
  const expectedAppId = input.platform === "android" ? "ai.okri.mobile" : "ai.okri.app";
  if (input.appId !== expectedAppId || input.token.length < 16 || input.token.length > 8192) throw new Error("Invalid push registration");
  const now = new Date().toISOString();
  const tokenHash = await sha256(`${input.platform}:${input.appId}:${input.token}`);
  await getDb().insert(notificationDevices).values({
    id: crypto.randomUUID(), userId: input.userId, platform: input.platform, appId: input.appId,
    tokenHash, encryptedToken: await encryptPrivateValue(input.token, secret), locale: language(input.locale),
    environment: input.environment, disabledAt: null, lastSeenAt: now, createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: notificationDevices.tokenHash,
    set: { userId: input.userId, locale: language(input.locale), environment: input.environment, disabledAt: null, lastSeenAt: now, updatedAt: now },
  });
  await saveNotificationPreferences(input.workspaceId, input.userId, {});
  return { registered: true };
}

export async function disableNotificationDevice(userId: string, token: string, platform: PushPlatform, appId: string) {
  const tokenHash = await sha256(`${platform}:${appId}:${token}`);
  await getDb().update(notificationDevices).set({ disabledAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(and(
    eq(notificationDevices.userId, userId),
    eq(notificationDevices.tokenHash, tokenHash),
  ));
  return { registered: false };
}

function localDateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, hour: Number(value("hour")) };
}

export async function enqueueMorningBriefs(db: D1Database, scheduledAt = new Date()) {
  const orm = drizzle(db, { schema: { notificationPreferences, workspaceMembers, itemAssignments, items, notifications, workspaces } });
  const preferences = await orm.select().from(notificationPreferences).innerJoin(workspaces, eq(workspaces.id, notificationPreferences.workspaceId)).where(and(
    eq(notificationPreferences.morningBriefPush, true),
    isNull(workspaces.scheduledDeletionAt),
  )).orderBy(asc(notificationPreferences.workspaceId));
  for (const { notification_preferences: preference } of preferences) {
    let local;
    try { local = localDateParts(scheduledAt, preference.timezone); } catch { continue; }
    if (local.hour !== preference.digestHour) continue;
    const [member] = await orm.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, preference.workspaceId),
      eq(workspaceMembers.userId, preference.userId),
      eq(workspaceMembers.status, "active"),
    )).limit(1);
    if (!member) continue;
    const assigned = await orm.select({ dueDate: items.dueDate }).from(itemAssignments)
      .innerJoin(items, eq(items.id, itemAssignments.itemId))
      .where(and(
        eq(itemAssignments.ownerId, preference.workspaceId),
        eq(itemAssignments.memberId, member.id),
        isNull(items.archivedAt),
        sql`${items.status} NOT IN ('done', 'development_done', 'archived')`,
      ));
    if (!assigned.length) continue;
    const payload = {
      overdueCount: assigned.filter(item => item.dueDate && item.dueDate < local.date).length,
      dueTodayCount: assigned.filter(item => item.dueDate === local.date).length,
      openCount: assigned.length,
    };
    const now = scheduledAt.toISOString();
    await orm.insert(notifications).values({
      id: crypto.randomUUID(), workspaceId: preference.workspaceId, userId: preference.userId,
      kind: "morning_brief", payloadJson: JSON.stringify(payload), dedupeKey: `morning:${preference.workspaceId}:${local.date}`,
      pushAfter: now, createdAt: now,
    }).onConflictDoNothing();
  }
}

type PushMessage = { title: string; body: string; data: Record<string, string> };
type PushResult = { sent: boolean; invalid?: boolean; code?: string };

let fcmAccess: { token: string; expiresAt: number; projectId: string } | null = null;
async function fcmAccessToken(serviceAccountJson: string) {
  const account = JSON.parse(serviceAccountJson) as { client_email?: string; private_key?: string; project_id?: string };
  if (!account.client_email || !account.private_key || !account.project_id) throw new Error("invalid_fcm_credentials");
  if (fcmAccess && fcmAccess.projectId === account.project_id && fcmAccess.expiresAt > Date.now() + 60_000) return fcmAccess;
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(account.client_email)
    .setAudience("https://oauth2.googleapis.com/token").setIssuedAt().setExpirationTime("1h")
    .sign(await importPKCS8(account.private_key, "RS256"));
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const result = await response.json() as { access_token?: string; expires_in?: number };
  if (!response.ok || !result.access_token) throw new Error("fcm_auth_failed");
  fcmAccess = { token: result.access_token, projectId: account.project_id, expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000 };
  return fcmAccess;
}

async function sendFcm(serviceAccountJson: string, token: string, message: PushMessage): Promise<PushResult> {
  const access = await fcmAccessToken(serviceAccountJson);
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(access.projectId)}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, notification: { title: message.title, body: message.body }, data: message.data, android: { priority: "high", notification: { channel_id: "work-updates" } } } }),
  });
  if (response.ok) return { sent: true };
  const text = await response.text();
  const invalid = response.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(text);
  return { sent: false, invalid, code: invalid ? "unregistered" : `fcm_${response.status}` };
}

async function sendApns(settings: NotificationRuntime, token: string, message: PushMessage, environment: string): Promise<PushResult> {
  const keyId = settings.OKRI_APNS_KEY_ID, teamId = settings.OKRI_APNS_TEAM_ID, privateKey = settings.OKRI_APNS_PRIVATE_KEY;
  if (!keyId || !teamId || !privateKey) throw new Error("apns_not_configured");
  const authorization = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: keyId }).setIssuer(teamId).setIssuedAt()
    .sign(await importPKCS8(privateKey.replace(/\\n/g, "\n"), "ES256"));
  const host = environment === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const response = await fetch(`${host}/3/device/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${authorization}`,
      "apns-topic": settings.OKRI_APNS_TOPIC || "ai.okri.app",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ aps: { alert: { title: message.title, body: message.body } }, ...message.data }),
  });
  if (response.ok) return { sent: true };
  const text = await response.text();
  const invalid = response.status === 410 || /BadDeviceToken|Unregistered/i.test(text);
  return { sent: false, invalid, code: invalid ? "unregistered" : `apns_${response.status}` };
}

export async function runPendingNotificationPushes(settings: NotificationRuntime, scheduledAt = new Date()) {
  if (!settings.PUSH_TOKEN_ENCRYPTION_KEY) return { sent: 0, failed: 0, skipped: "token_encryption_not_configured" };
  const orm = drizzle(settings.DB, { schema: { notifications, notificationPreferences, notificationDevices, users } });
  const pending = await orm.select({ notification: notifications, resolvedLanguage: users.resolvedLanguage })
    .from(notifications).innerJoin(users, eq(users.id, notifications.userId))
    .where(and(
      isNull(notifications.pushSentAt),
      or(isNull(notifications.pushAfter), sql`${notifications.pushAfter} <= ${scheduledAt.toISOString()}`),
      lt(notifications.pushAttempts, 5),
      sql`${notifications.createdAt} >= ${new Date(scheduledAt.getTime() - 24 * 60 * 60 * 1000).toISOString()}`,
    )).orderBy(asc(notifications.createdAt)).limit(100);
  let sent = 0, failed = 0;
  for (const row of pending) {
    const [preference] = await orm.select().from(notificationPreferences).where(and(
      eq(notificationPreferences.workspaceId, row.notification.workspaceId),
      eq(notificationPreferences.userId, row.notification.userId),
    )).limit(1);
    const enabled = row.notification.kind === "assignment"
      ? preference?.assignmentPush ?? DEFAULT_PREFERENCES.assignmentPush
      : preference?.morningBriefPush ?? DEFAULT_PREFERENCES.morningBriefPush;
    if (!enabled) {
      await orm.update(notifications).set({ pushSentAt: scheduledAt.toISOString(), pushLastErrorCode: "disabled_by_user" }).where(eq(notifications.id, row.notification.id));
      continue;
    }
    const devices = await orm.select().from(notificationDevices).where(and(
      eq(notificationDevices.userId, row.notification.userId),
      isNull(notificationDevices.disabledAt),
    ));
    if (!devices.length) continue;
    let delivered = false, attempted = false, lastCode = "delivery_failed";
    for (const device of devices) {
      if (device.platform === "android" && !settings.OKRI_FCM_SERVICE_ACCOUNT_JSON) continue;
      if (device.platform === "ios" && (!settings.OKRI_APNS_KEY_ID || !settings.OKRI_APNS_TEAM_ID || !settings.OKRI_APNS_PRIVATE_KEY)) continue;
      attempted = true;
      try {
        const token = await decryptPrivateValue(device.encryptedToken, settings.PUSH_TOKEN_ENCRYPTION_KEY);
        const copy = notificationCopy(row.notification.kind, safePayload(row.notification.payloadJson), language(device.locale || row.resolvedLanguage));
        const message = { title: copy.title, body: copy.body, data: { notificationId: row.notification.id, itemId: row.notification.itemId ?? "" } };
        const result = device.platform === "android"
          ? await sendFcm(settings.OKRI_FCM_SERVICE_ACCOUNT_JSON!, token, message)
          : await sendApns(settings, token, message, device.environment);
        delivered ||= result.sent;
        lastCode = result.code ?? lastCode;
        if (result.invalid) await orm.update(notificationDevices).set({ disabledAt: scheduledAt.toISOString(), updatedAt: scheduledAt.toISOString() }).where(eq(notificationDevices.id, device.id));
      } catch (error) {
        lastCode = error instanceof Error ? error.message.slice(0, 80) : "delivery_failed";
      }
    }
    if (!attempted) continue;
    if (delivered) {
      sent++;
      await orm.update(notifications).set({ pushSentAt: scheduledAt.toISOString(), pushLastErrorCode: null }).where(eq(notifications.id, row.notification.id));
    } else {
      failed++;
      await orm.update(notifications).set({ pushAttempts: sql`${notifications.pushAttempts} + 1`, pushLastErrorCode: lastCode }).where(eq(notifications.id, row.notification.id));
    }
  }
  return { sent, failed };
}

export async function runNotificationJobs(settings: NotificationRuntime, scheduledAt = new Date()) {
  await enqueueMorningBriefs(settings.DB, scheduledAt);
  return runPendingNotificationPushes(settings, scheduledAt);
}
