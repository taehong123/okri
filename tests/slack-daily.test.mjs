import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { preferences, serverLanguage } from "./helpers/language-fixture.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const source = await read("../lib/slack-daily.ts");
function compile(source, dependencies = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output)((name) => {
    if (!(name in dependencies)) throw new Error(`Unmocked import ${name}`);
    return dependencies[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}
const status = compile(await read("../lib/slack-daily-status.ts"));
const display = compile(await read("../lib/slack-display.ts"));
const workStatus = compile(await read("../lib/daily-work-status.ts"));

test("Slack customer messages never echo raw errors or diagnostic payloads", () => {
  for (const error of ["Slack chat.scheduleMessage failed: invalid_blocks", "D1_ERROR SELECT * FROM secrets", "Error: socket timeout\n at worker.js:123", '<script>alert("token")</script>', null]) {
    assert.equal(display.slackErrorMessage(error, "예약을 복구하지 못했습니다."), "예약을 복구하지 못했습니다.");
  }
  assert.match(display.slackErrorMessage(new Error("missing_scope chat:write")), /연결 권한을 갱신/);
  assert.match(display.slackErrorMessage("not_in_channel C-internal"), /채널에 봇을 초대/);
  assert.match(display.slackErrorMessage("ratelimited"), /잠시 후/);
  assert.match(display.slackErrorMessage("전송 결과를 확인하지 못했습니다. receipt-id=123"), /재발송을 보류/);
  assert.equal(display.slackErrorMessage("관리 리포트를 받을 Slack 채널을 선택해 주세요."), "메시지를 받을 Slack 채널을 선택해 주세요.");
  assert.equal(display.slackReminderLabel("scheduled"), "예약됨");
  assert.equal(display.slackReminderLabel("scheduling"), "예약 중");
  assert.equal(display.slackReminderLabel("internal-state"), "예약 확인 필요");
});
const dataSource = ts.createSourceFile("pace-data.ts", await read("../lib/pace-data.ts"), ts.ScriptTarget.Latest, true);
const deleteConnectionSource = dataSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "deleteSlackConnection").getFullText(dataSource);
const snake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]));

function harness(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY, scheduled_deletion_at TEXT, message_language TEXT DEFAULT 'ko');
    CREATE TABLE users(id TEXT PRIMARY KEY, language_preference TEXT DEFAULT 'ko', resolved_language TEXT DEFAULT 'ko', language_revision INTEGER DEFAULT 0);
    CREATE TABLE slack_connections(id TEXT PRIMARY KEY, owner_id TEXT, team_id TEXT, bot_user_id TEXT, encrypted_bot_token TEXT);
    CREATE TABLE workspace_members(id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT, user_id TEXT);
    CREATE TABLE slack_daily_settings(owner_id TEXT PRIMARY KEY, enabled INTEGER, weekdays TEXT, reminder_time TEXT, timezone TEXT, install_status TEXT, onboarding_completed_at TEXT, last_error TEXT, updated_at TEXT, required_scopes TEXT, work_statuses TEXT DEFAULT '["office","remote","skip"]');
    CREATE TABLE slack_daily_preferences(owner_id TEXT, member_id TEXT, enabled INTEGER, reminder_time TEXT, timezone TEXT);
    CREATE TABLE slack_member_links(id TEXT PRIMARY KEY, owner_id TEXT, member_id TEXT, slack_user_id TEXT, dm_channel_id TEXT, team_id TEXT);
    CREATE TABLE slack_daily_channels(id TEXT PRIMARY KEY, owner_id TEXT);
    CREATE TABLE slack_daily_reminders(id TEXT PRIMARY KEY, owner_id TEXT, member_id TEXT, slack_user_id TEXT, dm_channel_id TEXT, scheduled_message_id TEXT, post_at INTEGER, block_id TEXT, bot_user_id TEXT, status TEXT, last_error TEXT, created_at TEXT, updated_at TEXT, UNIQUE(owner_id,member_id));
    INSERT INTO users(id) VALUES('user');
    INSERT INTO workspaces(id,scheduled_deletion_at) VALUES('workspace',NULL);
    INSERT INTO workspace_members VALUES('member','workspace','active','user');
    INSERT INTO slack_connections VALUES('connection','workspace','T-team','U-bot','workspace');
    INSERT INTO slack_daily_settings VALUES('workspace',1,'[0,1,2,3,4,5,6]','09:00','Asia/Seoul','connected','2026-09-02T00:00:00Z','old error','2026-09-02T00:00:00Z','','["office","remote","skip"]');
    INSERT INTO slack_member_links VALUES('link','workspace','member','U-member','D-member','T-team');
    INSERT INTO slack_daily_preferences VALUES('workspace','member',1,NULL,NULL);`);
  db.exec(`ALTER TABLE slack_daily_reminders ADD message_language TEXT DEFAULT 'ko' NOT NULL;
    ALTER TABLE slack_daily_reminders ADD message_text TEXT DEFAULT '[데일리 봇] 오늘의 데일리를 작성해 주세요.' NOT NULL;`);
  const raw = { async batch(statements) {
    db.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }, prepare(sql) {
    let args = [];
    const prepared = db.prepare(sql);
    return { bind(...values) { args = values; return this; },
      async first() { return prepared.get(...args) ?? null; },
      async all() { return { results: prepared.all(...args) }; },
      async run() { const result = prepared.run(...args); return { meta: { changes: Number(result.changes) } }; },
    };
  } };
  const schema = Object.fromEntries(["slackDailySettings", "slackDailyPreferences", "slackMemberLinks", "workspaceMembers", "slackDailyChannels"].map((name) => [name, new Proxy({ table: snake(name) }, { get: (target, key) => key === "table" ? target.table : key })]));
  const orm = {
    select() {
      let table, predicate = () => true;
      const rows = () => db.prepare(`SELECT * FROM ${table}`).all().map(camel).filter(predicate);
      return { from(target) { table = target.table; return this; }, where(value) { predicate = value; return this; }, async limit(n) { return rows().slice(0, n); }, then(resolve, reject) { return Promise.resolve(rows()).then(resolve, reject); } };
    },
    insert(target) { return { values(value) { return { async onConflictDoUpdate({ set }) {
      const columns = Object.keys(set); db.prepare(`UPDATE ${target.table} SET ${columns.map((key) => `${snake(key)}=?`).join(",")} WHERE owner_id=?`).run(...columns.map((key) => typeof set[key] === "boolean" ? Number(set[key]) : set[key]), value.ownerId);
    } }; } }; },
    update(target) { return { set(value) { return { async where(predicate) {
      for (const row of db.prepare(`SELECT * FROM ${target.table}`).all().map(camel).filter(predicate)) {
        // This harness only needs the DM cache field from link updates.
        if (target.table === "slack_member_links") db.prepare("UPDATE slack_member_links SET dm_channel_id=? WHERE id=?").run(value.dmChannelId, row.id);
      }
    } }; } }; },
  };
  const connectionFor = (column, value) => {
    const row = db.prepare(`SELECT c.* FROM slack_connections c JOIN workspaces w ON w.id=c.owner_id AND w.scheduled_deletion_at IS NULL WHERE c.${column}=?`).get(value);
    return row ? camel(row) : null;
  };
  const api = compile(source, {
    "./language-preferences": preferences, "./server-language": serverLanguage,
    "cloudflare:workers": { env: { DB: raw, SLACK_TOKEN_ENCRYPTION_KEY: "mock" } },
    "drizzle-orm": { eq: (key, value) => (row) => row[key] === value, and: (...conditions) => (row) => conditions.every((condition) => condition(row)) },
    "@/db": { getDb: () => orm }, "@/db/schema": schema, "@/lib/daily-bot": {},
    "@/lib/pace-data": { getSlackConnection: async (owner) => connectionFor("owner_id", owner), getSlackConnectionByTeam: async (team) => connectionFor("team_id", team), ensureWorkspace: async () => {} },
    "@/lib/slack-oauth": { decryptSlackSecret: async (owner) => `mock-token-${owner}`, slackScopes: [] },
    "@/lib/slack-daily-status": status,
    "@/lib/daily-work-status": workStatus,
    "@/lib/daily-work": {}, "@/lib/slack-daily-form": {}, "@/lib/slack-member-matching": {}, "@/lib/slack-daily-checklist": {},
  });
  const calls = [], pending = [];
  const behavior = { rejectSchedule: false, loseResponse: false, rejectCancellation: false, lockedCancellation: false, rejectTeam: "", onSchedule: null, paginate: false, channelPages: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith("https://slack.com/api/"), "only mocked Slack requests are allowed");
    const method = url.split("/").at(-1), body = JSON.parse(options.body);
    const owner = options.headers.Authorization.replace("Bearer mock-token-", "");
    assert.ok(["workspace", "other"].includes(owner), "each Slack call uses its own workspace token");
    calls.push({ method, body, owner });
    if (method === "conversations.list") {
      const page = body.cursor ? 1 : 0;
      const result = behavior.channelPages[page] ?? { channels: [], nextCursor: "" };
      return Response.json({ ok: true, channels: result.channels, response_metadata: { next_cursor: result.nextCursor || "" } });
    }
    if (method === "chat.scheduledMessages.list") {
      assert.equal(body.latest, undefined, "expired reservations must not use rejected Slack timestamp bounds");
      assert.equal(body.oldest, undefined);
      if (behavior.paginate && !body.cursor) return Response.json({ ok: true, scheduled_messages: [], response_metadata: { next_cursor: "next" } });
      return Response.json({ ok: true, scheduled_messages: pending.filter((entry) => entry.owner === owner && entry.channel_id === body.channel) });
    }
    if (method === "chat.scheduleMessage") {
      const ids = body.blocks.flatMap((block) => block.block_id ? [block.block_id] : []);
      assert.equal(new Set(ids).size, ids.length, "Slack block IDs must be unique");
      if (behavior.rejectSchedule || behavior.rejectTeam === owner) return Response.json({ ok: false, error: "invalid_blocks", response_metadata: { messages: ["duplicate block_id"] } });
      if (behavior.onSchedule) await behavior.onSchedule({ owner, body });
      const id = `Q-${calls.length}`;
      pending.push({ id, channel_id: body.channel, post_at: body.post_at, text: body.text, owner });
      if (behavior.loseResponse) { behavior.loseResponse = false; throw new Error("response lost"); }
      return Response.json({ ok: true, scheduled_message_id: id });
    }
    if (method === "chat.deleteScheduledMessage") {
      if (behavior.rejectCancellation) return Response.json({ ok: false, error: "ratelimited" });
      if (behavior.lockedCancellation) return Response.json({ ok: false, error: "invalid_scheduled_message_id" });
      const index = pending.findIndex((entry) => entry.owner === owner && entry.id === body.scheduled_message_id && entry.channel_id === body.channel);
      if (index >= 0) pending.splice(index, 1);
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected mock API ${method}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; db.close(); });
  const reminder = () => db.prepare("SELECT * FROM slack_daily_reminders WHERE owner_id='workspace' AND member_id='member'").get();
  const addOther = () => db.exec(`INSERT INTO workspaces(id,scheduled_deletion_at) VALUES('other',NULL);
    INSERT INTO slack_connections VALUES('connection-other','other','T-other','U-other-bot','other');
    INSERT INTO workspace_members(id,workspace_id,status) VALUES('member-other','other','active');
    INSERT INTO slack_daily_settings VALUES('other',1,'[0,1,2,3,4,5,6]','09:00','America/New_York','connected','2026-09-02T00:00:00Z','','2026-09-02T00:00:00Z','','["office","remote","skip"]');
    INSERT INTO slack_member_links VALUES('link-other','other','member-other','U-other','D-other','T-other');
    INSERT INTO slack_daily_preferences VALUES('other','member-other',1,NULL,NULL);`);
  return { api, db, calls, pending, behavior, reminder, addOther, connectionFor, raw };
}

test("scheduled, manual and test reminders have unique block IDs and keep the delivery marker", (t) => {
  const { api } = harness(t);
  for (const marker of ["okri_daily_reminder:uuid", "okri_daily_reminder:manual:uuid", "okri_daily_reminder:test:uuid"]) {
    const blocks = api.dailyReminderBlocks(marker);
    const ids = blocks.flatMap((block) => block.block_id ? [block.block_id] : []);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(blocks.find((block) => block.type === "actions").block_id, marker);
  }
});

test("channel discovery classifies public, private, organization-shared and Slack Connect destinations", async (t) => {
  const { api, behavior, calls } = harness(t);
  behavior.channelPages = [
    {
      channels: [
        { id: "C-public", name: "announcements", is_private: false, is_member: false },
        { id: "G-private", name: "leadership", is_private: true, is_member: true },
        { id: "C-connect", name: "partner", is_private: false, is_member: true, is_shared: true, is_ext_shared: true },
        { id: "C-connect-away", name: "vendor", is_private: false, is_member: false, is_shared: true, is_ext_shared: true },
      ],
      nextCursor: "next",
    },
    {
      channels: [
        { id: "C-org", name: "company", is_private: false, is_member: true, is_shared: true, is_org_shared: true },
        { id: "G-hidden", name: "hidden", is_private: true, is_member: false },
        { id: "C-archived", name: "old", is_private: false, is_member: true, is_archived: true },
      ],
      nextCursor: "",
    },
  ];

  const channels = await api.listSlackChannels("workspace", { includeJoinablePublic: true });
  assert.deepEqual(channels, [
    { id: "C-public", name: "announcements", isPrivate: false, isMember: false, isShared: false, isExternal: false },
    { id: "C-org", name: "company", isPrivate: false, isMember: true, isShared: true, isExternal: false },
    { id: "G-private", name: "leadership", isPrivate: true, isMember: true, isShared: false, isExternal: false },
    { id: "C-connect", name: "partner", isPrivate: false, isMember: true, isShared: true, isExternal: true },
  ]);
  assert.equal(calls.filter((call) => call.method === "conversations.list").length, 2);
  assert.equal(calls.find((call) => call.method === "conversations.list").body.types, "public_channel,private_channel");
  assert.equal(api.canAutoJoinSlackChannel(channels[0]), true);
  assert.equal(api.canAutoJoinSlackChannel(channels[1]), false);
  assert.equal(api.canAutoJoinSlackChannel(channels[2]), false);
  assert.equal(api.canAutoJoinSlackChannel(channels[3]), false);
});

test("failed/missing/overdue/partial reservations never appear as ready", () => {
  const settings = { enabled: true, onboardingCompletedAt: "configured", installStatus: "connected" };
  const member = { linked: true, preference: { enabled: true }, reminder: null };
  for (const reminder of [null, { status: "failed", postAt: 2000, error: "failure" }, { status: "scheduled", postAt: 999, error: "" }]) {
    assert.equal(status.dailyDeliveryHealth(settings, [{ ...member, reminder }], 1_000_000).status, "failed");
  }
  const ready = { ...member, reminder: { status: "scheduled", postAt: 2000, error: "" } };
  assert.equal(status.dailyDeliveryHealth(settings, [ready], 1_000_000).status, "ready");
  assert.equal(status.dailyDeliveryHealth(settings, [ready, member], 1_000_000).failedCount, 1);
  assert.equal(status.dailyDeliveryHealth({ ...settings, enabled: false }, [member]).status, "paused");
  assert.equal(status.dailyDeliveryHealth(settings, []).status, "failed");
});

test("health excludes never-selected unlinked members but retains selected or lost recipients", () => {
  const settings = { enabled: true, onboardingCompletedAt: "configured", installStatus: "connected" };
  const ready = { linked: true, preference: { enabled: true, configured: true }, reminder: { status: "scheduled", postAt: 2000, error: "" } };
  const unlinked = { linked: false, preference: { enabled: true, configured: false }, reminder: null };
  assert.deepEqual(status.dailyDeliveryHealth(settings, [ready, unlinked], 1_000_000), {
    status: "ready", targetCount: 1, scheduledCount: 1, pendingCount: 0, failedCount: 0,
  });
  for (const lost of [
    { ...unlinked, preference: { enabled: true, configured: true } },
    { ...unlinked, reminder: ready.reminder },
  ]) assert.equal(status.dailyDeliveryHealth(settings, [ready, lost], 1_000_000).failedCount, 1);
});

test("settings API uses actual recipient preferences, without adding an unlinked member to failures", async (t) => {
  const { api, db } = harness(t);
  db.exec(`ALTER TABLE workspace_members ADD COLUMN display_name TEXT;
    ALTER TABLE workspace_members ADD COLUMN email TEXT;
    ALTER TABLE workspace_members ADD COLUMN role TEXT;
    ALTER TABLE workspace_members ADD COLUMN created_at TEXT;
    ALTER TABLE slack_member_links ADD COLUMN slack_email TEXT;
    ALTER TABLE slack_member_links ADD COLUMN slack_display_name TEXT;
    ALTER TABLE slack_member_links ADD COLUMN matched_by TEXT;
    CREATE TABLE daily_submissions(id TEXT, owner_id TEXT, member_id TEXT, member_name TEXT, scrum_date TEXT);
    CREATE TABLE slack_daily_publications(id TEXT, owner_id TEXT, submission_id TEXT, channel_id TEXT, error TEXT, attempts INTEGER, updated_at TEXT, status TEXT);
    INSERT INTO workspace_members(id,workspace_id,status) VALUES('unlinked','workspace','active');`);
  await api.scheduleMemberReminder("workspace", "member");
  const result = await api.getSlackDailySettings({ ownerId: "workspace" });
  assert.equal(result.members.length, 2);
  assert.equal(result.members.find((member) => member.memberId === "unlinked").preference.configured, false);
  assert.equal(result.delivery.targetCount, 1);
  assert.equal(result.delivery.failedCount, 0);
  assert.equal(result.delivery.status, "ready");
});

test("concurrent repair creates exactly one confirmed future reservation", async (t) => {
  const { api, calls, reminder } = harness(t);
  await Promise.all([api.scheduleMemberReminder("workspace", "member"), api.scheduleMemberReminder("workspace", "member")]);
  assert.equal(calls.filter((call) => call.method === "chat.scheduleMessage").length, 1);
  assert.equal(reminder().status, "scheduled");
  assert.ok(reminder().post_at > Date.now() / 1000);
  await api.scheduleMemberReminder("workspace", "member");
  assert.equal(calls.filter((call) => call.method === "chat.scheduleMessage").length, 1);
});

test("Slack rejection is durable and successful repair clears the failure", async (t) => {
  const { api, behavior, reminder, db } = harness(t);
  behavior.rejectSchedule = true;
  assert.equal((await api.reconcileDailyReminders("workspace")).failed, 1);
  assert.equal(reminder().status, "failed");
  assert.match(reminder().last_error, /invalid_blocks.*duplicate block_id/);
  behavior.rejectSchedule = false;
  await api.reconcileDailyReminders("workspace");
  assert.equal(reminder().status, "scheduled");
  assert.equal(db.prepare("SELECT last_error FROM slack_daily_settings").get().last_error, "");
});

test("a lost Slack response recovers its existing receipt without duplicate delivery", async (t) => {
  const { api, behavior, calls, pending, reminder } = harness(t);
  behavior.loseResponse = true;
  await assert.rejects(api.scheduleMemberReminder("workspace", "member"), /response lost/);
  assert.equal(reminder().status, "failed");
  await api.scheduleMemberReminder("workspace", "member");
  assert.equal(pending.length, 1, "recovery must not cancel the receipt it just adopted");
  assert.equal(reminder().scheduled_message_id, pending[0].id);
  assert.equal(calls.filter((call) => call.method === "chat.scheduleMessage").length, 1);
});

test("transient cancellation failure does not forget or replace the existing reservation", async (t) => {
  const { api, behavior, db, calls, reminder } = harness(t);
  await api.scheduleMemberReminder("workspace", "member");
  const id = reminder().scheduled_message_id;
  db.prepare("UPDATE slack_daily_settings SET reminder_time='11:15'").run();
  behavior.rejectCancellation = true;
  await assert.rejects(api.scheduleMemberReminder("workspace", "member", { force: true }), /ratelimited/);
  assert.equal(reminder().scheduled_message_id, id);
  assert.equal(calls.filter((call) => call.method === "chat.scheduleMessage").length, 1);
});

test("automatic repair respects disabled recipients, workspace boundaries and retries after cooldown", async (t) => {
  const { api, behavior, db, calls, reminder } = harness(t);
  db.prepare("UPDATE slack_daily_preferences SET enabled=0").run();
  await api.repairSlackDailyReminders("workspace");
  assert.equal(calls.length, 0);
  db.prepare("UPDATE slack_daily_preferences SET enabled=1").run();
  await api.repairSlackDailyReminders("other-workspace");
  assert.equal(calls.length, 0);
  behavior.rejectSchedule = true;
  await api.repairSlackDailyReminders("workspace");
  const count = calls.length;
  await api.repairSlackDailyReminders("workspace");
  assert.equal(calls.length, count);
  db.prepare("UPDATE slack_daily_reminders SET updated_at='2026-01-01T00:00:00.000Z'").run();
  behavior.rejectSchedule = false;
  await api.runDueSlackDailyReminders();
  assert.equal(reminder().status, "scheduled");
});

test("delivered reminder schedules the following day and ignores unrelated events", async (t) => {
  const { api, calls, reminder, pending } = harness(t);
  await api.scheduleMemberReminder("workspace", "member");
  const marker = reminder().block_id;
  const previousPostAt = reminder().post_at;
  t.mock.timers.enable({ apis: ["Date"], now: previousPostAt * 1000 + 1000 });
  pending.splice(0);
  assert.equal(await api.handleDeliveredDailyReminder({ teamId: "T-team", channelId: "D-member", botId: "wrong", blockIds: [marker] }), false);
  assert.equal(await api.handleDeliveredDailyReminder({ teamId: "T-team", channelId: "D-member", botId: "U-bot", blockIds: [marker] }), true);
  assert.equal(reminder().status, "scheduled");
  assert.equal(reminder().post_at, previousPostAt + 86_400);
  assert.equal(calls.filter((call) => call.method === "chat.scheduleMessage").length, 2);
  assert.ok(calls.every((call) => call.method !== "chat.postMessage"));
});

test("recovery is off the bootstrap critical path and independently registered in maintenance", async () => {
  assert.match(await read("../app/api/bootstrap/route.ts"), /waitUntil\(import\("@\/lib\/slack-daily"\)/);
  assert.match(await read("../worker/index.ts"), /ctx.waitUntil\(import\("@\/lib\/slack-daily"\)/);
  const route = await read("../app/api/slack/daily/settings/route.ts");
  assert.ok(route.indexOf("if (!canManageTeam(authorization))") < route.indexOf('payload.action === "repair"'));
  assert.match(source, /setupComplete: scheduleResults.length === memberIds.length/);
});

test("two real workspace fixtures retain separate tokens, recipients, timezones and failure recovery", async (t) => {
  const { api, db, calls, behavior, pending, addOther } = harness(t);
  addOther();
  behavior.rejectTeam = "workspace";
  await api.runDueSlackDailyReminders();
  const rows = db.prepare("SELECT * FROM slack_daily_reminders ORDER BY owner_id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.owner_id === "workspace").status, "failed");
  assert.equal(rows.find((r) => r.owner_id === "other").status, "scheduled");
  assert.equal(pending.length, 1);
  for (const call of calls) assert.equal(call.body.channel, call.owner === "workspace" ? "D-member" : "D-other");
  const otherReceipt = { ...pending[0] };
  behavior.rejectTeam = "";
  db.exec("UPDATE slack_daily_reminders SET updated_at='2026-01-01T00:00:00Z' WHERE owner_id='workspace'");
  await api.repairSlackDailyReminders("workspace");
  assert.deepEqual(pending.find((r) => r.owner === "other"), otherReceipt);
  assert.equal(pending.length, 2);
  assert.notEqual(pending[0].post_at, pending[1].post_at);
});

test("a new recipient cannot bypass another recipient's failure cooldown", async (t) => {
  const { api, db, calls, behavior } = harness(t);
  behavior.rejectSchedule = true;
  await api.repairSlackDailyReminders("workspace");
  db.exec(`INSERT INTO workspace_members(id,workspace_id,status) VALUES('new-member','workspace','active');
    INSERT INTO slack_member_links VALUES('new-link','workspace','new-member','U-new','D-new','T-team')`);
  const before = calls.length;
  behavior.rejectSchedule = false;
  await api.repairSlackDailyReminders("workspace");
  assert.ok(calls.slice(before).every((call) => call.body.channel === "D-new"));
  assert.equal(db.prepare("SELECT status FROM slack_daily_reminders WHERE member_id='member'").get().status, "failed");
});

for (const change of ["pause", "opt-out", "removed-member", "unlinked", "remapped", "reinstalled", "time-change"]) {
  test(`in-flight schedule is fenced and canceled after ${change}`, async (t) => {
    const { api, db, behavior, pending, reminder } = harness(t);
    behavior.onSchedule = async () => {
      const sql = {
        pause: "UPDATE slack_daily_settings SET enabled=0",
        "opt-out": "UPDATE slack_daily_preferences SET enabled=0",
        "removed-member": "UPDATE workspace_members SET status='removed'",
        unlinked: "DELETE FROM slack_member_links",
        remapped: "UPDATE slack_member_links SET slack_user_id='U-replaced'",
        reinstalled: "UPDATE slack_connections SET id='new-connection'",
        "time-change": "UPDATE slack_daily_settings SET reminder_time='12:34'",
      }[change];
      db.exec(sql);
      assert.equal(await api.scheduleMemberReminder("workspace", "member", { force: true }), "busy");
    };
    assert.equal(await api.scheduleMemberReminder("workspace", "member"), "changed");
    assert.equal(pending.length, 0);
    assert.equal(reminder(), undefined);
  });
}

test("missing links and disabled members cancel known or response-lost receipts rather than abandon them", async (t) => {
  const { api, db, pending, reminder, behavior } = harness(t);
  behavior.loseResponse = true;
  await assert.rejects(api.scheduleMemberReminder("workspace", "member"), /response lost/);
  db.exec("DELETE FROM slack_member_links");
  await api.reconcileDailyReminders("workspace");
  assert.equal(pending.length, 0);
  assert.equal(reminder(), undefined);
});

test("disconnect retains failed receipts on cancellation failure and cleans all states on retry", async (t) => {
  const { api, db, pending, reminder, behavior, connectionFor } = harness(t);
  await api.scheduleMemberReminder("workspace", "member");
  const receipt = reminder().scheduled_message_id;
  db.exec("UPDATE slack_daily_reminders SET status='failed'");
  behavior.rejectCancellation = true;
  await assert.rejects(api.disconnectSlackDaily("workspace", connectionFor("owner_id", "workspace")), /ratelimited/);
  assert.equal(reminder().scheduled_message_id, receipt);
  assert.equal(db.prepare("SELECT enabled FROM slack_daily_settings").get().enabled, 0);
  behavior.rejectCancellation = false;
  await api.disconnectSlackDaily("workspace", connectionFor("owner_id", "workspace"));
  assert.equal(pending.length, 0);
  assert.equal(reminder(), undefined);
  assert.equal(db.prepare("SELECT install_status FROM slack_daily_settings").get().install_status, "not_connected");
});

test("disconnect refuses to discard a reservation while its request is in flight", async (t) => {
  const { api, behavior, pending, connectionFor } = harness(t);
  behavior.onSchedule = () => assert.rejects(api.disconnectSlackDaily("workspace", connectionFor("owner_id", "workspace")), /진행 중/);
  await api.scheduleMemberReminder("workspace", "member");
  assert.equal(pending.length, 0);
});

test("Slack's final-minute cancellation lock is not mistaken for an absent reservation", async (t) => {
  const { api, db, pending, reminder, behavior, calls } = harness(t);
  await api.scheduleMemberReminder("workspace", "member");
  const receipt = reminder().scheduled_message_id;
  behavior.lockedCancellation = true;
  db.exec("UPDATE slack_daily_settings SET reminder_time='11:15'");
  await assert.rejects(api.scheduleMemberReminder("workspace", "member", { force: true }), /발송 직전/);
  assert.equal(pending[0].id, receipt);
  assert.equal(reminder().scheduled_message_id, receipt);
  assert.equal(calls.filter((c) => c.method === "chat.scheduleMessage").length, 1);
});

test("verification detects a deleted remote reservation and paginated receipt recovery never duplicates", async (t) => {
  const { api, db, pending, calls, behavior, reminder } = harness(t);
  await api.scheduleMemberReminder("workspace", "member");
  pending.splice(0);
  db.exec("UPDATE slack_daily_reminders SET updated_at='2026-01-01T00:00:00Z'");
  await api.repairSlackDailyReminders("workspace");
  assert.equal(pending.length, 1);
  assert.equal(calls.filter((c) => c.method === "chat.scheduleMessage").length, 2);
  behavior.paginate = true;
  await api.scheduleMemberReminder("workspace", "member", { verify: true });
  assert.equal(reminder().scheduled_message_id, pending[0].id);
  assert.equal(calls.filter((c) => c.method === "chat.scheduleMessage").length, 2);
});

test("signed delivery events cannot advance a different workspace or recipient", async (t) => {
  const { api, db, pending, addOther, calls } = harness(t);
  addOther();
  await api.runDueSlackDailyReminders();
  const other = db.prepare("SELECT * FROM slack_daily_reminders WHERE owner_id='other'").get();
  const before = calls.length;
  assert.equal(await api.handleDeliveredDailyReminder({ teamId: "T-team", channelId: "D-other", botId: "U-other-bot", blockIds: [other.block_id] }), false);
  assert.equal(calls.length, before);
  t.mock.timers.enable({ apis: ["Date"], now: other.post_at * 1000 + 1000 });
  pending.splice(pending.findIndex((p) => p.owner === "other"), 1);
  assert.equal(await api.handleDeliveredDailyReminder({ teamId: "T-other", channelId: "D-other", botId: "U-other-bot", blockIds: [other.block_id] }), true);
  assert.ok(calls.slice(before).every((call) => call.owner === "other"));
});

test("weekday and timezone scheduling crosses midnight, weekends and daylight-saving changes", (t) => {
  const { api } = harness(t);
  const cases = [
    ["Asia/Seoul", "2026-09-04T01:00:00Z", "2026-09-07T00:00:00Z"],
    ["America/New_York", "2026-03-06T15:00:00Z", "2026-03-09T13:00:00Z"],
    ["America/New_York", "2026-10-30T14:00:00Z", "2026-11-02T14:00:00Z"],
  ];
  for (const [timezone, now, expected] of cases) assert.equal(api.nextReminderEpoch("09:00", timezone, [1,2,3,4,5], new Date(now)), Date.parse(expected) / 1000);
});

test("verification preserves an unchanged reservation during the final minute", async (t) => {
  const { api, pending, reminder, calls, behavior } = harness(t);
  await api.scheduleMemberReminder("workspace", "member");
  const original = { ...reminder() };
  t.mock.timers.enable({ apis: ["Date"], now: original.post_at * 1000 - 30_000 });
  behavior.lockedCancellation = true;
  await api.scheduleMemberReminder("workspace", "member", { verify: true });
  assert.equal(reminder().post_at, original.post_at);
  assert.equal(reminder().scheduled_message_id, original.scheduled_message_id);
  assert.equal(pending.length, 1);
  assert.ok(!calls.some((c) => c.method === "chat.deleteScheduledMessage"));
});

test("language change cancels a confirmed old reservation before replacing it without changing its time", async (t) => {
  const { api, db, calls, pending, reminder } = harness(t);
  await api.scheduleMemberReminder("workspace", "member");
  const original = { ...reminder() };
  db.exec("UPDATE users SET language_preference='en', resolved_language='en'");
  await api.scheduleMemberReminder("workspace", "member");
  assert.equal(pending.length, 1);
  assert.equal(reminder().post_at, original.post_at);
  assert.equal(reminder().message_language, "en");
  assert.notEqual(reminder().scheduled_message_id, original.scheduled_message_id);
  assert.match(pending[0].text, /Daily/);
  assert.equal(calls.filter((call) => call.method === "chat.deleteScheduledMessage").length, 1);
});

test("language change with lost response recovers stored non-Korean body exactly once", async (t) => {
  const { api, db, behavior, pending, calls } = harness(t);
  db.exec("UPDATE users SET language_preference='ja', resolved_language='ja'");
  behavior.loseResponse = true;
  await assert.rejects(api.scheduleMemberReminder("workspace", "member"), /response lost/);
  db.exec("UPDATE users SET language_preference='es', resolved_language='es'");
  await api.scheduleMemberReminder("workspace", "member");
  assert.equal(pending.length, 1);
  assert.equal(calls.filter((call) => call.method === "chat.scheduleMessage").length, 2);
  assert.equal(calls.filter((call) => call.method === "chat.deleteScheduledMessage").length, 1);
});

test("language cancellation failure and final-minute change preserve the existing receipt", async (t) => {
  const { api, db, behavior, pending, reminder, calls } = harness(t);
  await api.scheduleMemberReminder("workspace", "member");
  const original = { ...reminder() };
  db.exec("UPDATE users SET language_preference='en', resolved_language='en'");
  behavior.rejectCancellation = true;
  await assert.rejects(api.scheduleMemberReminder("workspace", "member"), /ratelimited/);
  assert.equal(reminder().scheduled_message_id, original.scheduled_message_id);
  assert.equal(reminder().message_text, original.message_text);
  assert.equal(pending.length, 1);
  behavior.rejectCancellation = false;
  db.exec("UPDATE slack_daily_reminders SET status='scheduled'");
  t.mock.timers.enable({ apis: ["Date"], now: original.post_at * 1000 - 30_000 });
  const count = calls.length;
  await api.scheduleMemberReminder("workspace", "member", { verify: true });
  assert.equal(calls.length, count);
  assert.equal(reminder().scheduled_message_id, original.scheduled_message_id);
});

test("unknown ambiguous receipts are preserved instead of guessed during language recovery", async (t) => {
  const { api, db, behavior, pending, calls } = harness(t);
  behavior.loseResponse = true;
  await assert.rejects(api.scheduleMemberReminder("workspace", "member"), /response lost/);
  pending.push({ ...pending[0], id: "ambiguous" });
  db.exec("UPDATE users SET language_preference='zh', resolved_language='zh'");
  await assert.rejects(api.scheduleMemberReminder("workspace", "member"), /하나로 확인/);
  assert.equal(pending.length, 2);
  assert.equal(calls.filter((call) => call.method === "chat.scheduleMessage").length, 1);
  assert.equal(calls.filter((call) => call.method === "chat.deleteScheduledMessage").length, 0);
});

test("a confirmed absent receipt allows replacement after invalid_scheduled_message_id", async (t) => {
  const { api, pending, db, behavior, reminder } = harness(t);
  await api.scheduleMemberReminder("workspace", "member");
  pending.splice(0);
  behavior.lockedCancellation = true;
  db.exec("UPDATE slack_daily_settings SET reminder_time='11:15'");
  await api.scheduleMemberReminder("workspace", "member", { force: true });
  assert.equal(pending.length, 1);
  assert.equal(reminder().scheduled_message_id, pending[0].id);
});

test("invalid legacy timezone stays visible without blocking another workspace", async (t) => {
  const { api, db, addOther, pending } = harness(t);
  addOther();
  db.exec("UPDATE slack_daily_settings SET timezone='invalid/timezone' WHERE owner_id='workspace'");
  await api.runDueSlackDailyReminders();
  assert.match(db.prepare("SELECT last_error FROM slack_daily_settings WHERE owner_id='workspace'").get().last_error, /time zone/i);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].owner, "other");
});

test("bounded maintenance rotates beyond the first twenty workspaces", async (t) => {
  const { api, db, addOther, calls, pending } = harness(t);
  addOther();
  for (let i = 0; i < 25; i++) {
    db.prepare("INSERT INTO workspaces(id,scheduled_deletion_at) VALUES(?,NULL)").run(`idle-${i}`);
    db.prepare(`INSERT INTO slack_daily_settings(owner_id,enabled,weekdays,reminder_time,timezone,install_status,onboarding_completed_at,last_error,updated_at)
      VALUES(?,1,'[1,2,3,4,5]','09:00','Asia/Seoul','connected','configured','','2000-01-01T00:00:00Z')`).run(`idle-${i}`);
  }
  await api.runDueSlackDailyReminders();
  assert.equal(calls.length, 0);
  await api.runDueSlackDailyReminders();
  assert.equal(pending.length, 2);
});

test("automatic repair stops the recipient queue when its shared time budget expires", async (t) => {
  const { api, db, calls, behavior } = harness(t);
  db.exec(`INSERT INTO workspace_members(id,workspace_id,status) VALUES('new-member','workspace','active');
    INSERT INTO slack_member_links VALUES('new-link','workspace','new-member','U-new','D-new','T-team')`);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms) => ms === 20_000 ? controller.signal : timeout(ms));
  behavior.onSchedule = () => controller.abort();
  assert.equal((await api.repairSlackDailyReminders("workspace")).checked, 1);
  assert.ok(calls.every((c) => c.body.channel === "D-member"));
});

for (const scenario of ["reenabled", "replaced", "new-claim"]) {
  test(`disconnect finalization preserves concurrent ${scenario} state`, async (t) => {
    const { api, db, connectionFor, raw } = harness(t);
    const connection = connectionFor("owner_id", "workspace");
    const batch = raw.batch;
    raw.batch = async (statements) => {
      if (scenario === "reenabled") db.exec("UPDATE slack_daily_settings SET enabled=1");
      if (scenario === "replaced") db.exec("UPDATE slack_connections SET id='replacement'");
      if (scenario === "new-claim") db.exec(`INSERT INTO slack_daily_reminders(id,owner_id,member_id,status,updated_at)
        VALUES('new','workspace','member','scheduling','2026-09-03T00:00:00Z')`);
      return batch(statements);
    };
    await assert.rejects(api.disconnectSlackDaily("workspace", connection), /설정이나 예약이 변경/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM slack_member_links").get().n, 1);
    assert.equal(db.prepare("SELECT install_status FROM slack_daily_settings").get().install_status, "connected");
    if (scenario === "new-claim") assert.equal(db.prepare("SELECT id FROM slack_daily_reminders").get().id, "new");
  });
}

test("a stale disconnect cannot pause a replacement installation", async (t) => {
  const { api, db, connectionFor } = harness(t);
  const previous = connectionFor("owner_id", "workspace");
  db.exec("UPDATE slack_connections SET id='replacement'");
  await assert.rejects(api.disconnectSlackDaily("workspace", previous), /연결이 변경/);
  assert.equal(db.prepare("SELECT enabled FROM slack_daily_settings").get().enabled, 1);
});

for (const scenario of ["enabled", "pending", "replacement", "clear", "legacy"]) {
  test(`credential deletion checks actual SQLite state (${scenario})`, async (t) => {
    const { db, raw, connectionFor, addOther } = harness(t);
    addOther();
    if (scenario !== "enabled") db.exec("UPDATE slack_daily_settings SET enabled=0 WHERE owner_id='workspace'");
    if (scenario === "pending") db.exec(`INSERT INTO slack_daily_reminders(id,owner_id,member_id,status) VALUES('pending','workspace','member','scheduling')`);
    const data = compile(`import { env } from 'cloudflare:workers'; import { ensureSchema, getSlackConnection } from 'fixture'; ${deleteConnectionSource}`, {
      "cloudflare:workers": { env: { DB: raw } },
      fixture: { ensureSchema: async () => {}, getSlackConnection: async (owner) => {
        const connection = connectionFor("owner_id", owner);
        if (scenario === "replacement") db.exec("UPDATE slack_connections SET id='replacement' WHERE owner_id='workspace'");
        return connection;
      } },
    });
    const action = data.deleteSlackConnection("workspace", scenario === "legacy" ? undefined : "connection");
    if (["clear", "legacy"].includes(scenario)) {
      await action;
      assert.equal(connectionFor("owner_id", "workspace"), null);
    } else {
      await assert.rejects(action, /연결이 변경/);
      assert.ok(connectionFor("owner_id", "workspace"));
    }
    assert.equal(connectionFor("owner_id", "other").id, "connection-other");
  });
}
