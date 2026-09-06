import { env } from "cloudflare:workers";
import { decryptSlackSecret, type SlackRuntimeEnv } from "@/lib/slack-oauth";
import { postSlackMessage, SlackMessageError } from "@/lib/slack-automation";

type BotKind = "management" | "automation" | "daily_publication" | "daily_manual" | "daily_digest";
type Payload = { channel: string; text: string; blocks?: unknown[]; test?: boolean; streamKey?: string };
type Row = {
  id: string; owner_id: string; bot_kind: BotKind; subject_id: string; event_key: string;
  connection_key: string; policy: string; payload: string; status: string; attempts: number;
  retry_at: string; expires_at: string; message_ts: string | null; last_error: string; created_at: string; updated_at: string;
};
type Connection = { id: string; team_id: string; connected_at: string; encrypted_bot_token: string };
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;

export async function queueDailyDigest(db: D1Database, input: {
  ownerId: string; channel: string; date: string; memberIds: string[]; pages: Array<{ text: string; blocks: unknown[] }>; expiresAt: string;
}, now: Date) {
  const connection = await readConnection(db, input.ownerId);
  const policy = await readPolicy(db, input.ownerId, "daily_digest", input.channel, false);
  if (!connection || !policy) throw new Error("데일리 요약 공유 설정을 확인해 주세요.");
  if (!("members" in policy) || JSON.stringify([...input.memberIds].sort()) !== JSON.stringify(policy.members) || policy.date !== input.date) {
    throw new Error("데일리 요약 공유 설정을 확인해 주세요.");
  }
  const stamp = now.toISOString();
  // Persist every page together so an interrupted worker cannot lose later pages.
  const pages = input.pages.map((page, index) => ({ page, index }));
  await db.batch([...pages.slice(1), pages[0]].filter(Boolean).map(({ page, index }) => db.prepare(`INSERT INTO slack_bot_deliveries
    (id, owner_id, bot_kind, subject_id, event_key, connection_key, policy, payload, status, attempts, retry_at, expires_at, last_error, created_at, updated_at)
    SELECT ?, ?, 'daily_digest', ?, ?, ?, ?, ?, 'pending', 0, ?, ?, '', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM slack_bot_deliveries WHERE owner_id = ? AND bot_kind = 'daily_digest' AND event_key = ?)
    ON CONFLICT(owner_id, bot_kind, event_key) DO NOTHING`).bind(crypto.randomUUID(), input.ownerId, input.channel,
      `${input.date}/${input.channel}/${index}`, connectionKey(connection), JSON.stringify(policy), JSON.stringify({ channel: input.channel, ...page }),
      stamp, input.expiresAt, stamp, stamp, input.ownerId, `${input.date}/${input.channel}/0`)));
}

// Persist first, claim atomically, and never guess whether an unacknowledged POST succeeded.
export async function deliverSlackBotMessage(db: D1Database, input: {
  ownerId: string; botKind: BotKind; subjectId: string; eventKey: string; payload: Payload; expiresAt: string;
}, now = new Date()) {
  const existing = await db.prepare("SELECT * FROM slack_bot_deliveries WHERE owner_id = ? AND bot_kind = ? AND event_key = ?")
    .bind(input.ownerId, input.botKind, input.eventKey).first<Row>();
  if (existing) {
    // A confirmed rejection may be retried after an administrator fixes the
    // connection/settings. Never revive a sent or ambiguous request this way.
    if (input.botKind === "management" && ["failed", "cancelled"].includes(existing.status)) {
      const connection = await readConnection(db, input.ownerId);
      const policy = await readPolicy(db, input.ownerId, input.botKind, input.subjectId, Boolean(input.payload.test));
      if (connection && policy && policy.channel === input.payload.channel &&
          (connectionKey(connection) !== existing.connection_key || JSON.stringify(policy) !== existing.policy)) {
        await db.prepare(`UPDATE slack_bot_deliveries SET status = 'pending', attempts = 0, connection_key = ?, policy = ?,
          payload = ?, expires_at = ?, retry_at = ?, last_error = '', updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?`)
          .bind(connectionKey(connection), JSON.stringify(policy), JSON.stringify(input.payload), input.expiresAt, now.toISOString(), now.toISOString(), existing.id, existing.status, existing.updated_at).run();
      }
    }
    return processDelivery(db, existing.id, now);
  }
  const connection = await readConnection(db, input.ownerId);
  if (!connection) throw new Error("워크스페이스 Slack 연결이 필요합니다.");
  const policy = await readPolicy(db, input.ownerId, input.botKind, input.subjectId, Boolean(input.payload.test));
  if (!policy || policy.channel !== input.payload.channel) throw new Error("봇이 중지되었거나 발송 대상이 변경되었습니다.");
  const id = crypto.randomUUID(), stamp = now.toISOString();
  await db.prepare(`INSERT INTO slack_bot_deliveries
    (id, owner_id, bot_kind, subject_id, event_key, connection_key, policy, payload, status, attempts, retry_at, expires_at, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, '', ?, ?)
    ON CONFLICT(owner_id, bot_kind, event_key) DO NOTHING`)
    .bind(id, input.ownerId, input.botKind, input.subjectId, input.eventKey, connectionKey(connection), JSON.stringify(policy), JSON.stringify(input.payload), stamp, input.expiresAt, stamp, stamp).run();
  const row = await db.prepare("SELECT id FROM slack_bot_deliveries WHERE owner_id = ? AND bot_kind = ? AND event_key = ?")
    .bind(input.ownerId, input.botKind, input.eventKey).first<{ id: string }>();
  return processDelivery(db, row!.id, now);
}

export async function runDueSlackBotDeliveries(db: D1Database, now = new Date(), ownerId?: string) {
  const startedAt = Date.now();
  const rows = await db.prepare(`SELECT id FROM slack_bot_deliveries
    WHERE status IN ('pending', 'retry', 'preparing', 'sending') AND retry_at <= ?
      ${ownerId ? "AND owner_id = ?" : ""} ORDER BY retry_at LIMIT 50`)
    .bind(now.toISOString(), ...(ownerId ? [ownerId] : [])).all<{ id: string }>();
  let checked = 0;
  for (const row of rows.results) {
    // Leave room for one bounded 15-second request inside waitUntil's lifetime.
    if (Date.now() - startedAt >= 10_000) break;
    checked += 1;
    try { await processDelivery(db, row.id, now); }
    catch (error) { console.error("slack_bot_delivery_repair_failed", row.id, error instanceof Error ? error.message : "Unknown failure"); }
  }
  return { checked };
}

async function processDelivery(db: D1Database, id: string, now: Date): Promise<Row> {
  let row = (await db.prepare("SELECT * FROM slack_bot_deliveries WHERE id = ?").bind(id).first<Row>())!;
  if (!row) throw new Error("발송 기록을 찾을 수 없습니다.");
  const stamp = now.toISOString();
  if (row.status === "sending" && row.retry_at <= stamp) {
    await db.prepare("UPDATE slack_bot_deliveries SET status = 'uncertain', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND retry_at <= ?")
      .bind("Slack 전송 결과 확인 필요 · 중복 방지를 위해 자동 재발송하지 않습니다.", stamp, id, stamp).run();
    row = (await db.prepare("SELECT * FROM slack_bot_deliveries WHERE id = ?").bind(id).first<Row>())!;
  }
  if (!["pending", "retry", "preparing"].includes(row.status) || row.retry_at > stamp) {
    await mirrorDelivery(db, row);
    return row;
  }
  const claim = await db.prepare(`UPDATE slack_bot_deliveries SET status = 'preparing', attempts = attempts + 1, retry_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'retry', 'preparing') AND retry_at <= ? AND updated_at = ?
      AND NOT EXISTS (SELECT 1 FROM slack_bot_deliveries other WHERE other.owner_id = slack_bot_deliveries.owner_id
        AND other.bot_kind = 'daily_publication' AND other.id != slack_bot_deliveries.id
        AND json_extract(other.payload, '$.streamKey') = json_extract(slack_bot_deliveries.payload, '$.streamKey')
        AND other.status IN ('preparing', 'sending') AND other.retry_at > ?)`)
    .bind(new Date(now.getTime() + LEASE_MS).toISOString(), stamp, id, stamp, row.updated_at, stamp).run();
  if (!claim.meta.changes) return (await db.prepare("SELECT * FROM slack_bot_deliveries WHERE id = ?").bind(id).first<Row>())!;
  let status = "failed", error = "", messageTs: string | null = null, retryAt = stamp;
  let requestStarted = false;
  try {
    const payload = JSON.parse(row.payload) as Payload;
    if (row.expires_at <= stamp) throw new CancelledDelivery("발송 가능 시간이 지나 알림을 취소했습니다.");
    const connection = await validatePolicy(db, row, payload);
    const key = (env as SlackRuntimeEnv).SLACK_TOKEN_ENCRYPTION_KEY;
    if (!key) throw new Error("Slack 암호화 설정이 없습니다.");
    const token = await decryptSlackSecret(connection.encrypted_bot_token, key);
    let previousTimestamp: string | undefined;
    if (row.bot_kind === "daily_publication") {
      const previous = await db.prepare(`SELECT old.slack_message_ts FROM slack_daily_publications old
        JOIN slack_daily_publications current ON current.owner_id = old.owner_id AND current.member_id = old.member_id
          AND current.scrum_date = old.scrum_date AND current.channel_id = old.channel_id
        WHERE current.owner_id = ? AND current.id = ? AND old.slack_message_ts IS NOT NULL ORDER BY old.updated_at DESC LIMIT 1`)
        .bind(row.owner_id, row.subject_id).first<{ slack_message_ts: string }>();
      const receipt = await db.prepare(`SELECT message_ts FROM slack_bot_deliveries WHERE owner_id = ? AND bot_kind = 'daily_publication'
        AND json_extract(payload, '$.streamKey') = ? AND message_ts IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)
        .bind(row.owner_id, payload.streamKey).first<{ message_ts: string }>();
      previousTimestamp = receipt?.message_ts || previous?.slack_message_ts;
      if (!previousTimestamp) {
        const uncertain = await db.prepare(`SELECT id FROM slack_bot_deliveries WHERE owner_id = ? AND bot_kind = 'daily_publication'
          AND id != ? AND json_extract(payload, '$.streamKey') = ? AND status IN ('sending', 'uncertain') LIMIT 1`)
          .bind(row.owner_id, id, payload.streamKey).first();
        if (uncertain) throw new SlackMessageError("이전 데일리 공유의 전송 결과 확인이 필요합니다. 중복 게시를 막기 위해 새 게시를 보류합니다.", "uncertain");
      }
    }
    // Decryption/receipt lookup must not use a stale connection or a stopped rule.
    await validatePolicy(db, row, payload);
    const marked = await db.prepare("UPDATE slack_bot_deliveries SET status = 'sending' WHERE id = ? AND status = 'preparing' AND updated_at = ?")
      .bind(id, stamp).run();
    if (!marked.meta.changes) throw new CancelledDelivery("다른 작업에서 발송 상태를 변경했습니다.");
    requestStarted = true;
    const receipt = await postSlackMessage(token, payload.channel, payload.text, { blocks: payload.blocks, clientMsgId: id, messageTs: previousTimestamp });
    status = "sent"; messageTs = receipt.timestamp;
  } catch (failure) {
    error = (failure instanceof Error ? failure.message : "Slack 전송 실패").slice(0, 500);
    if (failure instanceof CancelledDelivery) status = "cancelled";
    else if (failure instanceof SlackMessageError) {
      status = failure.outcome === "uncertain" ? "uncertain" : "failed";
      if (failure.outcome === "rejected" && failure.retryAfterSeconds > 0 && row.attempts + 1 < MAX_ATTEMPTS) {
        status = "retry";
        retryAt = new Date(now.getTime() + Math.max(60, failure.retryAfterSeconds) * 1000).toISOString();
      } else if (failure.retryAfterSeconds > 0) {
        error = "Slack 요청 제한이 계속되어 5회 시도 후 중단했습니다. 연결 상태 확인이 필요합니다.";
      }
    } else if (requestStarted) status = "uncertain";
    else if (row.attempts + 1 < MAX_ATTEMPTS) {
      status = "retry"; retryAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    }
  }
  await db.prepare(`UPDATE slack_bot_deliveries SET status = ?, retry_at = ?, message_ts = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND status IN ('preparing', 'sending') AND updated_at = ?`)
    .bind(status, retryAt, messageTs, error, new Date().toISOString(), id, stamp).run();
  row = (await db.prepare("SELECT * FROM slack_bot_deliveries WHERE id = ?").bind(id).first<Row>())!;
  await mirrorDelivery(db, row);
  return row;
}

class CancelledDelivery extends Error {}
function connectionKey(value: Connection) { return JSON.stringify([value.id, value.team_id, value.connected_at]); }

async function readConnection(db: D1Database, ownerId: string) {
  return db.prepare(`SELECT c.id, c.team_id, c.connected_at, c.encrypted_bot_token FROM slack_connections c
    JOIN workspaces w ON w.id = c.owner_id AND w.scheduled_deletion_at IS NULL WHERE c.owner_id = ? LIMIT 1`)
    .bind(ownerId).first<Connection>();
}

async function readPolicy(db: D1Database, ownerId: string, kind: BotKind, subjectId: string, test: boolean) {
  if (kind === "daily_digest") {
    const settings = await db.prepare(`SELECT s.summary_time, s.timezone, s.weekdays, c.channel_id
      FROM slack_daily_settings s JOIN slack_daily_channels c ON c.owner_id = s.owner_id
      WHERE s.owner_id = ? AND c.channel_id = ? AND s.enabled = 1 AND s.summary_enabled = 1
        AND s.onboarding_completed_at IS NOT NULL AND s.install_status = 'connected'`).bind(ownerId, subjectId).first<Record<string, string>>();
    if (!settings) return null;
    const members = await db.prepare(`SELECT m.id FROM workspace_members m
      JOIN slack_member_links l ON l.owner_id = m.workspace_id AND l.member_id = m.id
      JOIN slack_connections c ON c.owner_id = l.owner_id AND c.team_id = l.team_id
      LEFT JOIN slack_daily_preferences p ON p.owner_id = m.workspace_id AND p.member_id = m.id
      WHERE m.workspace_id = ? AND m.status = 'active' AND COALESCE(p.enabled, 1) = 1 ORDER BY m.id`).bind(ownerId).all<{ id: string }>();
    if (!members.results.length) return null;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return { channel: settings.channel_id, settings, members: members.results.map((member) => member.id), date };
  }
  if (kind === "daily_manual") {
    const [runId, memberId] = subjectId.split("/");
    if (!runId || !memberId) return null;
    const recipient = await db.prepare(`SELECT l.dm_channel_id, l.slack_user_id, m.id AS member_id, r.id AS run_id, r.expires_at
      FROM slack_daily_manual_runs r JOIN json_each(r.targets_json) target
      JOIN workspace_members m ON m.workspace_id = r.owner_id AND m.id = json_extract(target.value, '$.memberId') AND m.status = 'active'
      JOIN slack_member_links l ON l.owner_id = r.owner_id AND l.member_id = m.id AND l.slack_user_id = json_extract(target.value, '$.slackUserId')
      JOIN slack_connections c ON c.owner_id = l.owner_id AND c.team_id = l.team_id
      JOIN workspace_members actor ON actor.workspace_id = r.owner_id AND actor.user_id = r.created_by_user_id
        AND actor.status = 'active' AND actor.role IN ('owner','admin')
      WHERE r.owner_id = ? AND r.id = ? AND m.id = ? AND r.expires_at > ?`)
      .bind(ownerId, runId, memberId, new Date().toISOString()).first<Record<string, string>>();
    return recipient?.dm_channel_id ? { channel: recipient.dm_channel_id, settings: recipient } : null;
  }
  if (kind === "daily_publication") {
    const publication = await db.prepare(`SELECT p.channel_id, s.id, s.version, s.member_id FROM slack_daily_publications p
      JOIN daily_submissions s ON s.id = p.submission_id AND s.owner_id = p.owner_id
      JOIN slack_daily_channels c ON c.owner_id = p.owner_id AND c.channel_id = p.channel_id
      JOIN workspace_members m ON m.workspace_id = p.owner_id AND m.id = s.member_id AND m.status = 'active'
      WHERE p.owner_id = ? AND p.id = ? AND NOT EXISTS (SELECT 1 FROM daily_submissions newer
        WHERE newer.owner_id = s.owner_id AND newer.member_id = s.member_id AND newer.scrum_date = s.scrum_date AND newer.version > s.version)`)
      .bind(ownerId, subjectId).first<Record<string, string | number>>();
    return publication ? { channel: String(publication.channel_id), settings: publication } : null;
  }
  if (kind === "management") {
    const settings = await db.prepare("SELECT enabled, channel_id, weekdays, report_time, timezone, signals FROM workspace_management_bot_settings WHERE owner_id = ?")
      .bind(ownerId).first<Record<string, string | number>>();
    return settings && (settings.enabled || test) ? { channel: String(settings.channel_id), settings } : null;
  }
  const rule = await db.prepare(`SELECT a.active, a.channel_id, a.trigger_type, a.trigger_status, a.message_template,
      a.id AS automation_id, i.id AS item_id, i.archived_at
    FROM slack_automation_deliveries d JOIN slack_automations a ON a.id = d.automation_id AND a.owner_id = d.owner_id
    LEFT JOIN items i ON i.id = d.item_id AND i.owner_id = d.owner_id
    WHERE d.owner_id = ? AND d.id = ?`)
    .bind(ownerId, subjectId).first<Record<string, string | number | null>>();
  if (!rule || (!rule.active && !test)) return null;
  if (!test && rule.trigger_type === "task_changed") {
    const change = await db.prepare("SELECT id FROM slack_task_changes WHERE owner_id = ? AND id = ? AND automation_id = ? AND channel_id = ?")
      .bind(ownerId, subjectId, rule.automation_id, rule.channel_id).first();
    if (!change) return null;
  } else if (!test && (!rule.item_id || rule.archived_at)) return null;
  const settings = { active: rule.active, channel_id: rule.channel_id, trigger_type: rule.trigger_type, trigger_status: rule.trigger_status, message_template: rule.message_template };
  return { channel: String(rule.channel_id), settings };
}

async function validatePolicy(db: D1Database, row: Row, payload: Payload) {
  const connection = await readConnection(db, row.owner_id);
  const policy = await readPolicy(db, row.owner_id, row.bot_kind, row.subject_id, Boolean(payload.test));
  if (!connection || connectionKey(connection) !== row.connection_key || !policy || JSON.stringify(policy) !== row.policy) {
    throw new CancelledDelivery("연결·봇 설정·업무 상태가 변경되어 이전 알림을 취소했습니다.");
  }
  return connection;
}

async function mirrorDelivery(db: D1Database, row: Row) {
  const payload = JSON.parse(row.payload) as Payload;
  const pending = ["pending", "preparing", "sending", "retry"].includes(row.status);
  if (row.bot_kind === "daily_publication") {
    await db.prepare(`UPDATE slack_daily_publications SET status = ?, error = ?, slack_message_ts = COALESCE(?, slack_message_ts),
      attempts = ?, updated_at = ? WHERE owner_id = ? AND id = ?`)
      .bind(row.status === "sent" ? "sent" : pending ? "pending" : "failed", row.last_error, row.message_ts, row.attempts, row.updated_at, row.owner_id, row.subject_id).run();
  } else if (row.bot_kind === "automation") {
    const status = row.status === "sent" ? "sent" : pending ? "pending" : "failed";
    await db.prepare("UPDATE slack_automation_deliveries SET status = ?, error = ?, sent_at = ? WHERE owner_id = ? AND id = ?")
      .bind(status, row.last_error, row.message_ts ? row.updated_at : null, row.owner_id, row.subject_id).run();
    await db.prepare(`UPDATE slack_automations SET last_triggered_at = ?, last_delivery_status = ?, last_error = ?
      WHERE owner_id = ? AND id = (SELECT automation_id FROM slack_automation_deliveries WHERE owner_id = ? AND id = ?)
        AND COALESCE(last_triggered_at, '') <= ?`)
      .bind(row.created_at, status, row.last_error, row.owner_id, row.owner_id, row.subject_id, row.created_at).run();
  } else if (row.bot_kind === "management" && !payload.test) {
    if (row.status === "sent") {
      await db.prepare(`UPDATE workspace_management_bot_settings SET last_sent_date = ?, last_sent_at = ?, last_error = ''
        WHERE owner_id = ? AND COALESCE(last_sent_date, '') <= ?`)
        .bind(row.subject_id, row.updated_at, row.owner_id, row.subject_id).run();
    } else {
      await db.prepare("UPDATE workspace_management_bot_settings SET last_error = ? WHERE owner_id = ? AND COALESCE(last_sent_date, '') < ?")
        .bind(row.last_error || (pending ? "리포트 발송 처리 중입니다." : "리포트 전송 확인이 필요합니다."), row.owner_id, row.subject_id).run();
    }
  }
}
