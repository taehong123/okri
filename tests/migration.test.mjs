import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("backup trigger migrations use LF and uppercase BEGIN for remote D1", async () => {
  const migration = await readFile(new URL("../drizzle/0036_workspace_backups.sql", import.meta.url), "utf8");
  const attributes = await readFile(new URL("../.gitattributes", import.meta.url), "utf8");
  assert.match(attributes, /^drizzle\/\*\.sql text eol=lf$/m);
  assert.ok(!migration.includes("\r"), "D1's remote splitter rejects CRLF trigger bodies");
  const triggers = migration.split("--> statement-breakpoint").filter((statement) => /CREATE TRIGGER/i.test(statement));
  assert.ok(triggers.length > 0);
  for (const trigger of triggers) assert.match(trigger, /\nBEGIN\n[\s\S]+;\nEND;/);
});

test("daily yesterday selection migration keeps JSON valid and submission requests idempotent", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE daily_scrums (id TEXT PRIMARY KEY);
    CREATE TABLE daily_submissions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, member_id TEXT);`);
  const migration = await readFile(new URL("../drizzle/0047_daily_yesterday_selection.sql", import.meta.url), "utf8");
  assert.ok(!migration.includes("\r"));
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec("INSERT INTO daily_scrums (id) VALUES ('draft'); INSERT INTO daily_submissions (id,owner_id,member_id,request_id) VALUES ('one','w','m','request')");
  assert.equal(db.prepare("SELECT yesterday_work_selection_json value FROM daily_scrums").get().value, "[]");
  assert.equal(db.prepare("SELECT yesterday_work_snapshot_json value FROM daily_submissions").get().value, "[]");
  assert.throws(() => db.exec("UPDATE daily_scrums SET yesterday_work_selection_json='{}'"), /CHECK constraint failed/);
  assert.throws(() => db.exec("INSERT INTO daily_submissions (id,owner_id,member_id,request_id) VALUES ('two','w','m','request')"), /UNIQUE constraint failed/);
  db.close();
});

test("daily work status migration is LF-only and preserves existing reports and settings", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE daily_scrums (id TEXT PRIMARY KEY, today_note TEXT);
    CREATE TABLE daily_submissions (id TEXT PRIMARY KEY, today_note TEXT);
    CREATE TABLE slack_daily_settings (owner_id TEXT PRIMARY KEY, reminder_time TEXT);
    INSERT INTO daily_scrums (id,today_note) VALUES ('draft','keep draft');
    INSERT INTO daily_submissions (id,today_note) VALUES ('submission','keep submission');
    INSERT INTO slack_daily_settings (owner_id,reminder_time) VALUES ('workspace','09:00');`);
  const migration = await readFile(new URL("../drizzle/0055_daily_work_status.sql", import.meta.url), "utf8");
  assert.ok(!migration.includes("\r"));
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  const draft = db.prepare("SELECT today_note,work_status FROM daily_scrums").get();
  const submission = db.prepare("SELECT today_note,work_status FROM daily_submissions").get();
  const settings = db.prepare("SELECT reminder_time,work_statuses FROM slack_daily_settings").get();
  assert.equal(draft.today_note, "keep draft");
  assert.equal(draft.work_status, "office");
  assert.equal(submission.today_note, "keep submission");
  assert.equal(submission.work_status, "office");
  assert.equal(settings.reminder_time, "09:00");
  assert.equal(settings.work_statuses, '["office","remote","skip"]');
  db.close();
});

test("Slack daily checklist repair migration is idempotent and restores its guarded table", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE workspace_members (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
    );
    INSERT INTO workspaces (id) VALUES ('workspace');
    INSERT INTO workspace_members (id, workspace_id) VALUES ('member', 'workspace');
  `);
  const migration = await readFile(new URL("../drizzle/0053_slack_daily_checklist_repair.sql", import.meta.url), "utf8");
  assert.ok(!migration.includes("\r"));
  const sql = migration.replaceAll("--> statement-breakpoint", "");
  db.exec(sql);
  db.exec(sql);
  db.exec(`INSERT INTO slack_daily_checklists
    (id, owner_id, member_id, payload_json, expires_at)
    VALUES ('checklist', 'workspace', 'member', '{}', '2099-01-01T00:00:00.000Z')`);
  assert.equal(db.prepare("SELECT revision FROM slack_daily_checklists WHERE id = 'checklist'").get().revision, 0);
  assert.throws(() => db.exec(`INSERT INTO slack_daily_checklists
    (id, owner_id, member_id, payload_json, expires_at)
    VALUES ('invalid', 'workspace', 'member', 'not-json', '2099-01-01T00:00:00.000Z')`), /CHECK constraint failed/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_slack_daily_checklists_expiry'").get().name,
    "idx_slack_daily_checklists_expiry");
  db.close();
});

test("runtime schema sentinel detects a missing Slack daily checklist table", async () => {
  const source = await readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8");
  const ensureSchema = source.slice(source.indexOf("async function ensureSchema"), source.indexOf("async function ensureAssistantDraftSchema"));
  assert.ok(ensureSchema.indexOf("CREATE TABLE IF NOT EXISTS slack_daily_checklists") < ensureSchema.indexOf("if (await schemaIsCurrent(d1))"));
  const sentinel = source.slice(source.indexOf("async function schemaIsCurrent"), source.indexOf("async function addColumnIfMissing"));
  assert.match(sentinel, /slack_daily_checklist\.revision/);
  assert.match(sentinel, /LEFT JOIN slack_daily_checklists AS slack_daily_checklist ON 1 = 0/);
});

test("Slack work command migration is LF-only, idempotent by request, and disables legacy Task status rules", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE slack_automations (
      id TEXT PRIMARY KEY, trigger_type TEXT NOT NULL, trigger_status TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO workspaces (id) VALUES ('workspace');
    INSERT INTO slack_automations (id, trigger_type, trigger_status) VALUES
      ('legacy', 'task_status_changed', 'blocked'),
      ('legacy-all', 'task_status_changed', ''),
      ('complete', 'task_status_changed', 'done'),
      ('created', 'task_created', '');
  `);
  const migration = await readFile(new URL("../drizzle/0048_slack_work_commands.sql", import.meta.url), "utf8");
  assert.ok(!migration.includes("\r"));
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`INSERT INTO slack_work_command_operations
    (request_id, owner_id, team_id, slack_user_id, command) VALUES ('request', 'workspace', 'team', 'user', 'task_complete')`);
  assert.throws(() => db.exec(`INSERT INTO slack_work_command_operations
    (request_id, owner_id, team_id, slack_user_id, command) VALUES ('request', 'workspace', 'team', 'user', 'task_complete')`), /UNIQUE constraint failed/);
  assert.deepEqual(db.prepare("SELECT id, active FROM slack_automations ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "complete", active: 1 }, { id: "created", active: 1 }, { id: "legacy", active: 0 }, { id: "legacy-all", active: 0 },
  ]);
  db.close();
});

test("preserves the historical registration migration for legacy database compatibility", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email_normalized TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users (id, email_normalized, display_name) VALUES ('legacy-user', 'legacy@example.com', 'Legacy');
  `);
  const migration = await readFile(new URL("../drizzle/0032_account_registration.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const legacy = db.prepare("SELECT verification_provider, completed_at, marketing_data_consent, electronic_marketing_consent FROM account_registrations WHERE user_id = 'legacy-user'").get();
  assert.equal(legacy.verification_provider, "legacy");
  assert.ok(legacy.completed_at);
  assert.equal(legacy.marketing_data_consent, 0);
  assert.equal(legacy.electronic_marketing_consent, 0);

  db.exec("INSERT INTO users (id, email_normalized, display_name) VALUES ('new-user', 'new@example.com', 'New')");
  assert.equal(db.prepare("SELECT count(*) AS count FROM account_registrations WHERE user_id = 'new-user'").get().count, 0);

  db.exec(`INSERT INTO account_registrations
    (user_id, encrypted_phone, phone_hash, phone_last_four, verification_provider, phone_verified_at,
     required_privacy_consent_at, age_14_confirmed_at, completed_at)
    VALUES ('new-user', 'encrypted', 'hash', '1234', 'twilio_verify', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  db.exec(`INSERT INTO account_consent_events
    (id, user_id, consent_type, granted, policy_version, source)
    VALUES ('event', 'new-user', 'electronic_marketing', 0, '2026-09-01', 'signup')`);
  db.exec("DELETE FROM users WHERE id = 'new-user'");
  assert.equal(db.prepare("SELECT count(*) AS count FROM account_registrations WHERE user_id = 'new-user'").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM account_consent_events WHERE user_id = 'new-user'").get().count, 0);
  db.close();
});

test("stores one assistant draft per workspace, user, and flow", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
  `);
  const migration = await readFile(new URL("../drizzle/0031_assistant_drafts.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`INSERT INTO assistant_drafts (id, owner_id, user_id, draft_key, payload_json)
    VALUES ('draft', 'workspace', 'user', 'workspace:project', '{"message":"first"}');`);
  assert.throws(() => db.exec(`INSERT INTO assistant_drafts (id, owner_id, user_id, draft_key, payload_json)
    VALUES ('duplicate', 'workspace', 'user', 'workspace:project', '{}');`), /UNIQUE constraint failed/);
  db.exec("DELETE FROM workspaces WHERE id = 'workspace'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assistant_drafts").get().count, 0);
  db.close();
});

test("stores one workspace management bot schedule with safe defaults", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
  `);
  const migration = await readFile(new URL("../drizzle/0033_workspace_management_bot.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec("INSERT INTO workspace_management_bot_settings (owner_id) VALUES ('workspace')");

  const settings = db.prepare(`SELECT enabled, weekdays, report_time, timezone, signals, last_sent_date
    FROM workspace_management_bot_settings WHERE owner_id = 'workspace'`).get();
  assert.deepEqual({ ...settings }, {
    enabled: 0,
    weekdays: "[1,2,3,4,5]",
    report_time: "09:00",
    timezone: "Asia/Seoul",
    signals: '["missing_due_date","missing_owner","overdue","completed_yesterday","due_today"]',
    last_sent_date: null,
  });
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_management_bot_due'").get().name, "idx_workspace_management_bot_due");
  db.exec("DELETE FROM workspaces WHERE id = 'workspace'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_management_bot_settings").get().count, 0);
  db.close();
});

test("migrates Action rows into checklists and Project-linked Tasks", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE items (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium', cadence TEXT NOT NULL DEFAULT 'weekly',
      progress INTEGER NOT NULL DEFAULT 0, due_date TEXT, source TEXT NOT NULL DEFAULT 'web',
      source_ref TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE checklist_items (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO items (id, owner_id, kind, title, status)
      VALUES ('ini', 'owner', 'initiative', 'Initiative', 'in_progress');
    INSERT INTO items (id, owner_id, parent_id, kind, title, status)
      VALUES ('task', 'owner', 'ini', 'task', 'Task', 'in_progress');
    INSERT INTO items (id, owner_id, parent_id, kind, title, status)
      VALUES ('action', 'owner', 'task', 'action', 'Checklist', 'done');
    INSERT INTO items (id, owner_id, kind, title, status)
      VALUES ('orphan', 'owner', 'action', 'Orphan', 'todo');
  `);

  const migration = await readFile(new URL("../drizzle/0003_migrate_execution_hierarchy.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const rows = db.prepare("SELECT id, parent_id, kind, status FROM items ORDER BY id").all();
  const checklist = db.prepare("SELECT task_id, title, completed FROM checklist_items").all();
  assert.equal(rows.some((row) => row.kind === "action"), false);
  assert.equal(rows.filter((row) => row.kind === "project").length, 1);
  assert.equal(rows.find((row) => row.id === "task")?.parent_id, "legacy-project-ini");
  assert.deepEqual({ ...rows.find((row) => row.id === "orphan") }, {
    id: "orphan",
    parent_id: null,
    kind: "task",
    status: "inbox",
  });
  assert.deepEqual(checklist.map((row) => ({ ...row })), [{ task_id: "task", title: "Checklist", completed: 1 }]);
  db.close();
});

test("creates relational workspaces and team memberships", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const migration = await readFile(new URL("../drizzle/0005_wet_roland_deschain.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
    INSERT INTO workspace_members (id, workspace_id, user_id, email, display_name, role, status)
      VALUES ('owner-member', 'workspace', 'owner', 'owner@example.com', 'Owner', 'owner', 'active');
    INSERT INTO workspace_members (id, workspace_id, email, display_name, role, status)
      VALUES ('invite', 'workspace', 'viewer@example.com', 'Viewer', 'viewer', 'invited');
  `);

  const rows = db.prepare("SELECT role, status FROM workspace_members ORDER BY role").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { role: "owner", status: "active" },
    { role: "viewer", status: "invited" },
  ]);
  db.exec("DELETE FROM workspaces WHERE id = 'workspace'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_members").get().count, 0);
  db.close();
});

test("creates workspace-scoped Slack automations with deduplicated delivery history", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL
    );
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
    INSERT INTO items (id, owner_id, kind, title) VALUES ('task', 'workspace', 'task', 'Ship Slack automation');
  `);

  const migration = await readFile(new URL("../drizzle/0020_slack_automations.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO slack_automations (
      id, owner_id, created_by_user_id, name, trigger_type, channel_id, message_template
    ) VALUES (
      'automation', 'workspace', 'owner', 'New task alert', 'task_created', 'C0123456789', '*{{title}}*'
    );
    INSERT INTO slack_automation_deliveries (
      id, owner_id, automation_id, item_id, event_key, trigger_type, channel_id, message, status
    ) VALUES (
      'delivery', 'workspace', 'automation', 'task', 'event-1', 'task_created', 'C0123456789', '*Ship Slack automation*', 'sent'
    );
  `);

  assert.deepEqual({ ...db.prepare("SELECT trigger_type, active, last_delivery_status FROM slack_automations WHERE id = 'automation'").get() }, {
    trigger_type: "task_created",
    active: 1,
    last_delivery_status: "never",
  });
  assert.throws(() => db.exec(`
    INSERT INTO slack_automation_deliveries (
      id, owner_id, automation_id, event_key, trigger_type, channel_id, message
    ) VALUES ('duplicate', 'workspace', 'automation', 'event-1', 'task_created', 'C0123456789', 'duplicate');
  `), /UNIQUE constraint failed/);
  db.exec("DELETE FROM workspaces WHERE id = 'workspace'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slack_automations").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slack_automation_deliveries").get().count, 0);
  db.close();
});

test("adds a 30-day workspace deletion grace period", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const [workspaceMigration, deletionMigration] = await Promise.all([
    readFile(new URL("../drizzle/0005_wet_roland_deschain.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0021_workspace_deletion_grace.sql", import.meta.url), "utf8"),
  ]);
  db.exec(workspaceMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec("INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner')");
  db.exec(deletionMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    UPDATE workspaces
    SET deletion_requested_at = '2026-08-25T00:00:00.000Z',
        scheduled_deletion_at = '2026-09-24T00:00:00.000Z',
        deletion_requested_by_user_id = 'owner'
    WHERE id = 'workspace'
  `);

  assert.deepEqual({ ...db.prepare("SELECT deletion_requested_at, scheduled_deletion_at, deletion_requested_by_user_id FROM workspaces WHERE id = 'workspace'").get() }, {
    deletion_requested_at: "2026-08-25T00:00:00.000Z",
    scheduled_deletion_at: "2026-09-24T00:00:00.000Z",
    deletion_requested_by_user_id: "owner",
  });
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspaces_scheduled_deletion'").get().name, "idx_workspaces_scheduled_deletion");
  db.exec("UPDATE workspaces SET deletion_requested_at = NULL, scheduled_deletion_at = NULL, deletion_requested_by_user_id = NULL WHERE id = 'workspace'");
  assert.equal(db.prepare("SELECT scheduled_deletion_at FROM workspaces WHERE id = 'workspace'").get().scheduled_deletion_at, null);
  db.close();
});

test("adds optional workspace avatar metadata without changing existing workspaces", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('team', 'AllVibe', 'owner');
  `);
  const migration = await readFile(new URL("../drizzle/0023_workspace_avatars.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  const workspace = db.prepare("SELECT name, avatar_key, avatar_updated_at FROM workspaces WHERE id = 'team'").get();
  assert.deepEqual({ ...workspace }, { name: "AllVibe", avatar_key: null, avatar_updated_at: null });
  db.exec("UPDATE workspaces SET avatar_key = 'workspace-avatars/team/avatar.webp', avatar_updated_at = '2026-08-29T00:00:00.000Z' WHERE id = 'team'");
  assert.equal(db.prepare("SELECT avatar_key FROM workspaces WHERE id = 'team'").get().avatar_key, "workspace-avatars/team/avatar.webp");
  db.close();
});

test("records item creators and only backfills unambiguous personal workspaces", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL
    );
    INSERT INTO workspaces (id, name, owner_user_id) VALUES
      ('personal-user', 'Personal', 'personal-user'),
      ('team-workspace', 'Team', 'team-owner');
    INSERT INTO items (id, owner_id, kind, title) VALUES
      ('personal-project', 'personal-user', 'project', 'Personal Project'),
      ('team-project', 'team-workspace', 'project', 'Team Project');
  `);
  const migration = await readFile(new URL("../drizzle/0024_item_delete_ownership.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  assert.equal(db.prepare("SELECT created_by_user_id FROM items WHERE id = 'personal-project'").get().created_by_user_id, "personal-user");
  assert.equal(db.prepare("SELECT created_by_user_id FROM items WHERE id = 'team-project'").get().created_by_user_id, null);
  db.exec("UPDATE items SET created_by_user_id = 'team-member' WHERE id = 'team-project'");
  assert.equal(db.prepare("SELECT created_by_user_id FROM items WHERE id = 'team-project'").get().created_by_user_id, "team-member");
  db.close();
});

test("creates one General per workspace and migrates parentless Tasks and personal assignments", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL
    );
    CREATE TABLE workspace_members (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT, email TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE routines (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', trigger_point TEXT NOT NULL DEFAULT '',
      action_place TEXT NOT NULL DEFAULT '', action_steps TEXT NOT NULL DEFAULT '',
      cadence TEXT NOT NULL DEFAULT 'daily', active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      cycle_id TEXT, parent_id TEXT, routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
      cadence TEXT NOT NULL DEFAULT 'weekly', progress INTEGER NOT NULL DEFAULT 0,
      due_date TEXT, source TEXT NOT NULL DEFAULT 'web', source_ref TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0, archived_at TEXT, archived_from_status TEXT,
      archive_root_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE item_assignments (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
      role TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id, item_id, member_id, role)
    );
    CREATE TABLE slack_automations (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, trigger_status TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO workspaces (id, name, owner_user_id) VALUES
      ('personal', 'Personal', 'personal'), ('team', 'Team', 'owner-user');
    INSERT INTO workspace_members (id, workspace_id, user_id, display_name, status) VALUES
      ('personal-member', 'personal', 'personal', '개인 사용자', 'active'),
      ('team-owner', 'team', 'owner-user', '팀 소유자', 'active'),
      ('team-member', 'team', 'teammate', '팀 멤버', 'active');
    INSERT INTO routines (id, owner_id, title) VALUES
      ('personal-routine', 'personal', 'Daily review'), ('team-routine', 'team', 'Team review');
    INSERT INTO items (id, owner_id, kind, title, status, due_date, source) VALUES
      ('personal-project', 'personal', 'project', 'Personal Project', 'todo', '2026-09-01', 'web'),
      ('personal-inbox', 'personal', 'task', 'Legacy Inbox', 'inbox', '2026-09-02', 'slack'),
      ('team-orphan', 'team', 'task', 'Team General Task', 'todo', '2026-09-03', 'mcp');
  `);

  const migration = await readFile(new URL("../drizzle/0021_mixed_maginty.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM routines WHERE system_key = 'general'").get().count, 2);
  assert.deepEqual({ ...db.prepare("SELECT title, status, due_date, source, routine_id, cycle_id FROM items WHERE id = 'personal-inbox'").get() }, {
    title: "Legacy Inbox",
    status: "todo",
    due_date: "2026-09-02",
    source: "slack",
    routine_id: "general-personal",
    cycle_id: null,
  });
  assert.equal(db.prepare("SELECT routine_id FROM items WHERE id = 'team-orphan'").get().routine_id, "general-team");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM item_assignments WHERE owner_id = 'personal'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM item_assignments WHERE owner_id = 'team'").get().count, 0);
  assert.equal(db.prepare("SELECT assignee_member_id FROM routines WHERE id = 'personal-routine'").get().assignee_member_id, "personal-member");
  assert.equal(db.prepare("SELECT assignee_member_id FROM routines WHERE id = 'team-routine'").get().assignee_member_id, null);
  assert.throws(() => db.exec("INSERT INTO routines (id, owner_id, system_key, title) VALUES ('duplicate', 'personal', 'general', 'Duplicate')"), /UNIQUE constraint failed/);
  db.close();
});

test("archives Projects with Tasks and preserves structured assignments and hidden properties", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspace_members (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE property_definitions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium', cadence TEXT NOT NULL DEFAULT 'weekly',
      progress INTEGER NOT NULL DEFAULT 0, due_date TEXT, source TEXT NOT NULL DEFAULT 'web',
      source_ref TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE item_property_values (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      property_id TEXT NOT NULL REFERENCES property_definitions(id) ON DELETE CASCADE,
      value TEXT NOT NULL DEFAULT 'null', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO workspace_members (id, workspace_id, display_name) VALUES
      ('lead', 'workspace', '김태홍'), ('worker', 'workspace', '이실무'), ('second', 'workspace', '박지원');
    INSERT INTO property_definitions (id, owner_id, name, type) VALUES
      ('risk', 'workspace', '리스크', 'text');
    INSERT INTO items (id, owner_id, kind, title, status) VALUES
      ('project', 'workspace', 'project', '출시 프로젝트', 'in_progress'),
      ('other-project', 'workspace', 'project', '다른 프로젝트', 'backlog');
    INSERT INTO items (id, owner_id, parent_id, kind, title, status) VALUES
      ('task-a', 'workspace', 'project', 'task', '설계', 'blocked'),
      ('task-b', 'workspace', 'project', 'task', '개발', 'done');
    INSERT INTO item_property_values (id, owner_id, item_id, property_id, value) VALUES
      ('risk-value', 'workspace', 'project', 'risk', '"높음"');
  `);

  const migration = await readFile(new URL("../drizzle/0019_magenta_shooting_star.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO item_assignments (id, owner_id, item_id, member_id, role) VALUES
      ('dri', 'workspace', 'project', 'lead', 'project_dri'),
      ('worker-a', 'workspace', 'project', 'worker', 'project_worker'),
      ('worker-b', 'workspace', 'project', 'second', 'project_worker'),
      ('assignee', 'workspace', 'task-a', 'worker', 'task_assignee');
    INSERT INTO project_hidden_properties (id, owner_id, project_id, property_id)
      VALUES ('hidden', 'workspace', 'project', 'risk');
  `);

  assert.throws(() => db.exec(`INSERT INTO item_assignments (id, owner_id, item_id, member_id, role)
    VALUES ('second-dri', 'workspace', 'project', 'second', 'project_dri')`));
  assert.throws(() => db.exec(`INSERT INTO item_assignments (id, owner_id, item_id, member_id, role)
    VALUES ('second-assignee', 'workspace', 'task-a', 'second', 'task_assignee')`));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM item_assignments WHERE item_id = 'project' AND role = 'project_worker'").get().count, 2);
  assert.equal(db.prepare("SELECT value FROM item_property_values WHERE id = 'risk-value'").get().value, '"높음"');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM project_hidden_properties WHERE project_id = 'other-project'").get().count, 0);

  db.prepare(`UPDATE items
    SET archived_from_status = status, status = 'archived', archived_at = ?, archive_root_id = ?, updated_at = ?
    WHERE owner_id = ? AND archived_at IS NULL AND (id = ? OR (parent_id = ? AND kind = 'task'))`)
    .run("2026-08-24T00:00:00.000Z", "project", "2026-08-24T00:00:00.000Z", "workspace", "project", "project");
  assert.deepEqual(db.prepare("SELECT id, status FROM items WHERE archived_at IS NULL ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "other-project", status: "backlog" },
  ]);

  db.prepare(`UPDATE items
    SET status = CASE WHEN archived_from_status IS NULL OR archived_from_status = 'archived'
      THEN CASE kind WHEN 'project' THEN 'backlog' ELSE 'todo' END ELSE archived_from_status END,
      archived_at = NULL, archived_from_status = NULL, archive_root_id = NULL, updated_at = ?
    WHERE owner_id = ? AND (id = ? OR archive_root_id = ?)`)
    .run("2026-08-24T01:00:00.000Z", "workspace", "project", "project");
  assert.deepEqual(db.prepare("SELECT id, status FROM items WHERE id IN ('project', 'task-a', 'task-b') ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "project", status: "in_progress" },
    { id: "task-a", status: "blocked" },
    { id: "task-b", status: "done" },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM item_assignments").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM project_hidden_properties").get().count, 1);

  db.prepare(`UPDATE items
    SET archived_from_status = status, status = 'archived', archived_at = ?, archive_root_id = ?, updated_at = ?
    WHERE owner_id = ? AND archived_at IS NULL AND (id = ? OR (parent_id = ? AND kind = 'task'))`)
    .run("2026-08-24T02:00:00.000Z", "project", "2026-08-24T02:00:00.000Z", "workspace", "project", "project");
  db.exec("DELETE FROM items WHERE owner_id = 'workspace' AND (id = 'project' OR archive_root_id = 'project')");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM items WHERE id IN ('project', 'task-a', 'task-b')").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM item_assignments").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM item_property_values").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM project_hidden_properties").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM items WHERE id = 'other-project'").get().count, 1);
  db.close();
});

test("creates groups with unique handles and cascading memberships", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const [teamMigration, groupMigration] = await Promise.all([
    readFile(new URL("../drizzle/0005_wet_roland_deschain.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0006_rich_spitfire.sql", import.meta.url), "utf8"),
  ]);
  db.exec(teamMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(groupMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
    INSERT INTO workspace_members (id, workspace_id, user_id, display_name, role, status)
      VALUES ('owner-member', 'workspace', 'owner', 'Owner', 'owner', 'active');
    INSERT INTO workspace_members (id, workspace_id, email, display_name, role, status)
      VALUES ('invite', 'workspace', 'pending@example.com', 'Pending', 'member', 'invited');
    INSERT INTO workspace_groups (id, workspace_id, name, handle, color, visibility)
      VALUES ('group', 'workspace', '제품 팀', '제품-팀', 'blue', 'private');
    INSERT INTO workspace_group_members (id, group_id, member_id, role)
      VALUES ('lead', 'group', 'owner-member', 'lead');
    INSERT INTO workspace_group_members (id, group_id, member_id, role)
      VALUES ('pending-member', 'group', 'invite', 'member');
  `);

  assert.throws(() => db.exec("INSERT INTO workspace_groups (id, workspace_id, name, handle) VALUES ('duplicate', 'workspace', 'Duplicate', '제품-팀')"), /UNIQUE/i);
  assert.deepEqual({ ...db.prepare("SELECT visibility, archived FROM workspace_groups WHERE id = 'group'").get() }, { visibility: "private", archived: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_group_members WHERE group_id = 'group'").get().count, 2);

  db.exec("DELETE FROM workspace_members WHERE id = 'invite'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_group_members WHERE group_id = 'group'").get().count, 1);
  db.exec("DELETE FROM workspace_groups WHERE id = 'group'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_group_members").get().count, 0);
  db.close();
});

test("allows one user to join and switch between multiple workspaces", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const [teamMigration, workspaceMigration] = await Promise.all([
    readFile(new URL("../drizzle/0005_wet_roland_deschain.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0007_remarkable_epoch.sql", import.meta.url), "utf8"),
  ]);
  db.exec(teamMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(workspaceMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('user', '개인 워크스페이스', 'user');
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('team', '제품 팀', 'user');
    INSERT INTO workspace_members (id, workspace_id, user_id, display_name, role, status)
      VALUES ('personal-member', 'user', 'user', 'User', 'owner', 'active');
    INSERT INTO workspace_members (id, workspace_id, user_id, display_name, role, status)
      VALUES ('team-member', 'team', 'user', 'User', 'owner', 'active');
    INSERT INTO user_workspace_preferences (user_id, active_workspace_id)
      VALUES ('user', 'team');
  `);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE user_id = 'user'").get().count, 2);
  assert.equal(db.prepare("SELECT active_workspace_id FROM user_workspace_preferences WHERE user_id = 'user'").get().active_workspace_id, "team");
  assert.throws(
    () => db.exec("INSERT INTO workspace_members (id, workspace_id, user_id, display_name, role, status) VALUES ('duplicate', 'team', 'user', 'User', 'member', 'active')"),
    /UNIQUE/i,
  );
  db.close();
});

test("adds routine execution guide fields", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const [routineMigration, guideMigration] = await Promise.all([
    readFile(new URL("../drizzle/0004_good_scarlet_witch.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0008_zippy_dormammu.sql", import.meta.url), "utf8"),
  ]);
  db.exec(routineMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec("INSERT INTO routines (id, owner_id, title, cadence) VALUES ('routine', 'owner', 'Daily planning', 'daily')");
  db.exec(guideMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    UPDATE routines
    SET trigger_point = '오전 9시',
        action_place = 'OKRI 작업 탭',
        action_steps = '인박스를 비우고 오늘 집중할 Task를 고른다'
    WHERE id = 'routine'
  `);

  assert.deepEqual({ ...db.prepare("SELECT trigger_point, action_place, action_steps FROM routines WHERE id = 'routine'").get() }, {
    trigger_point: "오전 9시",
    action_place: "OKRI 작업 탭",
    action_steps: "인박스를 비우고 오늘 집중할 Task를 고른다",
  });
  db.close();
});

test("creates workspace rules that follow workspace ownership", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const [teamMigration, rulesMigration] = await Promise.all([
    readFile(new URL("../drizzle/0005_wet_roland_deschain.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0009_demonic_hitman.sql", import.meta.url), "utf8"),
  ]);
  db.exec(teamMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(rulesMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
    INSERT INTO workspace_rules (
      workspace_id, capture_instruction, structure_instruction, routine_instruction,
      default_priority, default_cadence, review_before_create, configured
    ) VALUES (
      'workspace', '인박스 우선', 'Project가 명확하면 연결', '트리거와 방법을 묻기',
      'high', 'daily', 1, 1
    );
  `);

  assert.deepEqual({ ...db.prepare("SELECT default_priority, default_cadence, configured FROM workspace_rules WHERE workspace_id = 'workspace'").get() }, {
    default_priority: "high",
    default_cadence: "daily",
    configured: 1,
  });
  db.exec("DELETE FROM workspaces WHERE id = 'workspace'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_rules").get().count, 0);
  db.close();
});

test("records AI usage events for cost limits", async () => {
  const db = new DatabaseSync(":memory:");
  const migration = await readFile(new URL("../drizzle/0010_sturdy_firelord.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO ai_usage_events (
      id, owner_id, user_id, model, source, input_chars, input_tokens,
      output_tokens, estimated_cost_won_micros
    ) VALUES (
      'usage-1', 'workspace', 'user', 'gpt-5.6-luna', 'web', 120,
      60, 200, 25000000
    );
  `);

  assert.deepEqual({ ...db.prepare("SELECT COUNT(*) AS count, SUM(estimated_cost_won_micros) AS spent FROM ai_usage_events WHERE owner_id = 'workspace' AND user_id = 'user'").get() }, {
    count: 1,
    spent: 25000000,
  });
  db.close();
});

test("creates Google OAuth and Calendar sync tables", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const [itemsMigration, googleMigration] = await Promise.all([
    readFile(new URL("../drizzle/0000_eminent_mandroid.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0011_little_leo.sql", import.meta.url), "utf8"),
  ]);
  db.exec(itemsMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(googleMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO items (id, owner_id, kind, title, status)
      VALUES ('task', 'workspace', 'task', 'Prepare launch review', 'todo');
    INSERT INTO google_connections (
      id, owner_id, user_id, google_account_id, email, display_name, encrypted_refresh_token, scope
    ) VALUES (
      'connection', 'workspace', 'user', 'google-user', 'user@example.com', 'User', 'encrypted', 'calendar.events'
    );
    INSERT INTO google_oauth_states (state, owner_id, user_id, expires_at)
      VALUES ('state', 'workspace', 'user', '2099-01-01T00:00:00.000Z');
    INSERT INTO google_calendar_events (
      id, owner_id, user_id, item_id, google_event_id, html_link
    ) VALUES (
      'event', 'workspace', 'user', 'task', 'google-event', 'https://calendar.google.com/event'
    );
  `);

  assert.equal(db.prepare("SELECT email FROM google_connections WHERE owner_id = 'workspace'").get().email, "user@example.com");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM google_oauth_states").get().count, 1);
  assert.throws(
    () => db.exec("INSERT INTO google_calendar_events (id, owner_id, user_id, item_id, google_event_id) VALUES ('duplicate', 'workspace', 'user', 'task', 'other')"),
    /UNIQUE/i,
  );
  db.exec("DELETE FROM items WHERE id = 'task'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM google_calendar_events").get().count, 0);
  db.close();
});

test("creates Slack bot connection and OAuth state tables", async () => {
  const db = new DatabaseSync(":memory:");
  const [migration, workspaceIsolation] = await Promise.all([
    readFile(new URL("../drizzle/0012_parallel_vindicator.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0029_slack_workspace_isolation.sql", import.meta.url), "utf8"),
  ]);
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(workspaceIsolation.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO slack_connections (
      id, owner_id, user_id, team_id, team_name, bot_user_id, app_id, encrypted_bot_token, scope
    ) VALUES (
      'connection', 'workspace', 'user', 'T123', 'Acme', 'Ubot', 'A123', 'encrypted', 'commands,chat:write'
    );
    INSERT INTO slack_oauth_states (state, owner_id, user_id, return_to, expires_at)
      VALUES ('state', 'workspace', 'user', '/', '2099-01-01T00:00:00.000Z');
  `);

  assert.deepEqual({ ...db.prepare("SELECT team_name, scope FROM slack_connections WHERE team_id = 'T123'").get() }, {
    team_name: "Acme",
    scope: "commands,chat:write",
  });
  assert.equal(db.prepare("SELECT return_to FROM slack_oauth_states WHERE state = 'state'").get().return_to, "/");
  db.exec("INSERT INTO slack_connections (id, owner_id, user_id, team_id, encrypted_bot_token) VALUES ('other-team', 'other', 'other-user', 'T456', 'encrypted-b')");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slack_connections").get().count, 2);
  assert.deepEqual(
    db.prepare("SELECT owner_id, encrypted_bot_token FROM slack_connections ORDER BY team_id").all().map((row) => ({ ...row })),
    [
      { owner_id: "workspace", encrypted_bot_token: "encrypted" },
      { owner_id: "other", encrypted_bot_token: "encrypted-b" },
    ],
  );
  assert.throws(
    () => db.exec("INSERT INTO slack_connections (id, owner_id, user_id, team_id, encrypted_bot_token) VALUES ('duplicate-user', 'workspace', 'user', 'T456', 'encrypted')"),
    /UNIQUE/i,
  );
  assert.throws(
    () => db.exec("INSERT INTO slack_connections (id, owner_id, user_id, team_id, encrypted_bot_token) VALUES ('duplicate-team', 'other', 'other-user', 'T123', 'encrypted')"),
    /UNIQUE/i,
  );
  db.close();
});

test("keeps the latest Slack connection while enforcing one team per OKRI workspace", async () => {
  const db = new DatabaseSync(":memory:");
  const [baseMigration, workspaceIsolation] = await Promise.all([
    readFile(new URL("../drizzle/0012_parallel_vindicator.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0029_slack_workspace_isolation.sql", import.meta.url), "utf8"),
  ]);
  db.exec(baseMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO slack_connections (id, owner_id, user_id, team_id, encrypted_bot_token, updated_at)
      VALUES ('older', 'workspace', 'user-a', 'T-OLD', 'encrypted-old', '2026-08-29T09:00:00.000Z');
    INSERT INTO slack_connections (id, owner_id, user_id, team_id, encrypted_bot_token, updated_at)
      VALUES ('newer', 'workspace', 'user-b', 'T-NEW', 'encrypted-new', '2026-08-30T09:00:00.000Z');
  `);
  db.exec(workspaceIsolation.replaceAll("--> statement-breakpoint", ""));
  assert.deepEqual({ ...db.prepare("SELECT id, team_id FROM slack_connections WHERE owner_id = 'workspace'").get() }, { id: "newer", team_id: "T-NEW" });
  assert.throws(
    () => db.exec("INSERT INTO slack_connections (id, owner_id, user_id, team_id, encrypted_bot_token) VALUES ('duplicate-owner', 'workspace', 'user-c', 'T-OTHER', 'encrypted')"),
    /UNIQUE/i,
  );
  db.close();
});

test("creates revocable workspace-scoped integration tokens", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const [workspaceMigration, tokenMigration, tokenUsageMigration] = await Promise.all([
    readFile(new URL("../drizzle/0005_wet_roland_deschain.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0016_windy_flatman.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0017_equal_doctor_octopus.sql", import.meta.url), "utf8"),
  ]);
  db.exec(workspaceMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(tokenMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(tokenUsageMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
    INSERT INTO integration_tokens (id, workspace_id, user_id, name, token_hash, token_prefix)
      VALUES ('token', 'workspace', 'owner', 'Codex conversation', 'hash', 'okri_123...');
  `);

  assert.deepEqual({ ...db.prepare("SELECT workspace_id, user_id, last_used_at, revoked_at FROM integration_tokens WHERE id = 'token'").get() }, {
    workspace_id: "workspace",
    user_id: "owner",
    last_used_at: null,
    revoked_at: null,
  });
  assert.throws(
    () => db.exec("INSERT INTO integration_tokens (id, workspace_id, user_id, token_hash, token_prefix) VALUES ('duplicate', 'workspace', 'owner', 'hash', 'okri_456...')"),
    /UNIQUE/i,
  );
  db.exec("UPDATE integration_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'token'");
  assert.notEqual(db.prepare("SELECT revoked_at FROM integration_tokens WHERE id = 'token'").get().revoked_at, null);
  db.exec("DELETE FROM workspaces WHERE id = 'workspace'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM integration_tokens").get().count, 0);
  db.close();
});

test("creates ChatGPT OAuth DCR clients and single-use PKCE authorization codes", async () => {
  const db = new DatabaseSync(":memory:");
  const migration = await readFile(new URL("../drizzle/0027_mcp_oauth.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO mcp_oauth_clients (client_id, redirect_uris, client_name)
      VALUES ('client', '["https://chatgpt.com/connector_platform_oauth_redirect"]', 'ChatGPT');
    INSERT INTO mcp_oauth_codes (
      code_hash, authorization_json, client_id, redirect_uri, code_challenge,
      resource, scope, expires_at
    ) VALUES (
      'hash', '{"ownerId":"workspace","userId":"owner","role":"owner"}', 'client',
      'https://chatgpt.com/connector_platform_oauth_redirect', 'challenge',
      'https://okri.ai/api/mcp', 'okri:read okri:write', '2099-01-01T00:00:00.000Z'
    );
  `);

  assert.deepEqual({ ...db.prepare("SELECT client_id, client_name FROM mcp_oauth_clients").get() }, {
    client_id: "client",
    client_name: "ChatGPT",
  });
  assert.deepEqual({ ...db.prepare("SELECT client_id, used_at FROM mcp_oauth_codes").get() }, {
    client_id: "client",
    used_at: null,
  });
  db.exec("UPDATE mcp_oauth_codes SET used_at = CURRENT_TIMESTAMP WHERE code_hash = 'hash' AND used_at IS NULL");
  assert.notEqual(db.prepare("SELECT used_at FROM mcp_oauth_codes WHERE code_hash = 'hash'").get().used_at, null);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mcp_oauth_codes_expires'").get().name, "idx_mcp_oauth_codes_expires");
  db.close();
});

test("creates OKR cycles and links OKR items to a cycle", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const [itemsMigration, workspaceMigration, cycleMigration] = await Promise.all([
    readFile(new URL("../drizzle/0000_eminent_mandroid.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_wet_roland_deschain.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0013_calm_james_howlett.sql", import.meta.url), "utf8"),
  ]);
  db.exec(itemsMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(workspaceMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(cycleMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
    INSERT INTO okr_cycles (id, owner_id, name, version, start_date, end_date, status)
      VALUES ('cycle', 'workspace', '2026 Q3 OKR v1', 1, '2026-07-01', '2026-09-30', 'active');
    INSERT INTO items (id, owner_id, cycle_id, kind, title, status)
      VALUES ('objective', 'workspace', 'cycle', 'objective', 'Grow retention', 'in_progress');
    INSERT INTO items (id, owner_id, kind, title, status)
      VALUES ('project', 'workspace', 'project', 'Billing policy rollout', 'policy_discussion');
  `);

  assert.deepEqual({ ...db.prepare("SELECT version, status FROM okr_cycles WHERE owner_id = 'workspace'").get() }, {
    version: 1,
    status: "active",
  });
  assert.equal(db.prepare("SELECT cycle_id FROM items WHERE id = 'objective'").get().cycle_id, "cycle");
  assert.equal(db.prepare("SELECT cycle_id FROM items WHERE id = 'project'").get().cycle_id, null);
  db.exec("DELETE FROM okr_cycles WHERE id = 'cycle'");
  assert.equal(db.prepare("SELECT cycle_id FROM items WHERE id = 'objective'").get().cycle_id, null);
  db.close();
});

test("cleanup removes execution data while preserving workspace groups", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const migrations = await Promise.all([
    "0000_eminent_mandroid.sql",
    "0001_groovy_annihilus.sql",
    "0002_charming_prodigy.sql",
    "0004_good_scarlet_witch.sql",
    "0005_wet_roland_deschain.sql",
    "0006_rich_spitfire.sql",
    "0007_remarkable_epoch.sql",
    "0008_zippy_dormammu.sql",
    "0009_demonic_hitman.sql",
    "0010_sturdy_firelord.sql",
    "0011_little_leo.sql",
    "0012_parallel_vindicator.sql",
    "0013_calm_james_howlett.sql",
    "0014_clean_starlord.sql",
  ].map((file) => readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")));
  for (const migration of migrations) {
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  }

  db.exec(`
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
    INSERT INTO workspace_members (id, workspace_id, user_id, display_name, role, status)
      VALUES ('owner-member', 'workspace', 'owner', 'Owner', 'owner', 'active');
    INSERT INTO workspace_groups (id, workspace_id, name, handle, color, visibility)
      VALUES ('group', 'workspace', 'Product', 'product', 'blue', 'open');
    INSERT INTO workspace_group_members (id, group_id, member_id, role)
      VALUES ('group-member', 'group', 'owner-member', 'lead');
    INSERT INTO property_definitions (id, owner_id, name, type)
      VALUES ('property', 'workspace', 'Owner', 'text');
    INSERT INTO okr_cycles (id, owner_id, name, version, start_date, end_date, status)
      VALUES ('cycle', 'workspace', '2026 Q3 OKR v1', 1, '2026-07-01', '2026-09-30', 'active');
    INSERT INTO items (id, owner_id, cycle_id, kind, title, status)
      VALUES ('task', 'workspace', 'cycle', 'task', 'Ship cleanup', 'todo');
    INSERT INTO item_property_values (id, owner_id, item_id, property_id, value)
      VALUES ('property-value', 'workspace', 'task', 'property', '"owner"');
    INSERT INTO checklist_items (id, owner_id, task_id, title)
      VALUES ('checklist', 'workspace', 'task', 'Confirm cleanup');
    INSERT INTO activity_log (id, owner_id, item_id, action)
      VALUES ('activity', 'workspace', 'task', 'created');
    INSERT INTO daily_scrums (id, owner_id, scrum_date, today_note)
      VALUES ('scrum', 'workspace', '2026-08-18', 'Cleanup');
    INSERT INTO routines (id, owner_id, title, cadence)
      VALUES ('routine', 'workspace', 'Daily review', 'daily');
    INSERT INTO routine_completions (id, owner_id, routine_id, completion_date)
      VALUES ('routine-completion', 'workspace', 'routine', '2026-08-18');
    INSERT INTO google_connections (id, owner_id, user_id, google_account_id, email, encrypted_refresh_token)
      VALUES ('google', 'workspace', 'owner', 'google-owner', 'owner@example.com', 'encrypted');
    INSERT INTO google_calendar_events (id, owner_id, user_id, item_id, google_event_id)
      VALUES ('event', 'workspace', 'owner', 'task', 'google-event');
    INSERT INTO slack_connections (id, owner_id, user_id, team_id, encrypted_bot_token)
      VALUES ('slack', 'workspace', 'owner', 'T123', 'encrypted');
    INSERT INTO trash_records (
      id, owner_id, category, title, payload, item_count, routine_count, cycle_count, created_by_user_id
    ) VALUES (
      'trash', 'workspace', 'workspace_cleanup', 'OKR cleanup 2026-08-18',
      '{"items":[{"id":"task"}],"routines":[{"id":"routine"}],"okrCycles":[{"id":"cycle"}]}',
      1, 1, 1, 'owner'
    );
  `);

  db.exec(`
    DELETE FROM checklist_items WHERE owner_id = 'workspace';
    DELETE FROM item_property_values WHERE owner_id = 'workspace';
    DELETE FROM google_calendar_events WHERE owner_id = 'workspace';
    DELETE FROM activity_log WHERE owner_id = 'workspace';
    DELETE FROM daily_scrums WHERE owner_id = 'workspace';
    DELETE FROM routine_completions WHERE owner_id = 'workspace';
    DELETE FROM routines WHERE owner_id = 'workspace';
    DELETE FROM items WHERE owner_id = 'workspace';
    DELETE FROM okr_cycles WHERE owner_id = 'workspace';
  `);

  assert.deepEqual({
    workspaces: db.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE id = 'workspace'").get().count,
    members: db.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = 'workspace'").get().count,
    groups: db.prepare("SELECT COUNT(*) AS count FROM workspace_groups WHERE workspace_id = 'workspace'").get().count,
    groupMembers: db.prepare("SELECT COUNT(*) AS count FROM workspace_group_members WHERE group_id = 'group'").get().count,
    properties: db.prepare("SELECT COUNT(*) AS count FROM property_definitions WHERE owner_id = 'workspace'").get().count,
    googleConnections: db.prepare("SELECT COUNT(*) AS count FROM google_connections WHERE owner_id = 'workspace'").get().count,
    slackConnections: db.prepare("SELECT COUNT(*) AS count FROM slack_connections WHERE owner_id = 'workspace'").get().count,
    trashRecords: db.prepare("SELECT COUNT(*) AS count FROM trash_records WHERE owner_id = 'workspace'").get().count,
  }, {
    workspaces: 1,
    members: 1,
    groups: 1,
    groupMembers: 1,
    properties: 1,
    googleConnections: 1,
    slackConnections: 1,
    trashRecords: 1,
  });
  assert.deepEqual({
    items: db.prepare("SELECT COUNT(*) AS count FROM items WHERE owner_id = 'workspace'").get().count,
    cycles: db.prepare("SELECT COUNT(*) AS count FROM okr_cycles WHERE owner_id = 'workspace'").get().count,
    routines: db.prepare("SELECT COUNT(*) AS count FROM routines WHERE owner_id = 'workspace'").get().count,
    scrums: db.prepare("SELECT COUNT(*) AS count FROM daily_scrums WHERE owner_id = 'workspace'").get().count,
  }, {
    items: 0,
    cycles: 0,
    routines: 0,
    scrums: 0,
  });
  db.close();
});

test("adds lossless Project properties, documents, and body templates", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE property_definitions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo'
    );
    CREATE TABLE item_property_values (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      property_id TEXT NOT NULL REFERENCES property_definitions(id) ON DELETE CASCADE,
      value TEXT NOT NULL DEFAULT 'null', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO property_definitions (id, owner_id, name, type)
      VALUES ('timing', 'workspace', 'Timing', 'text');
    INSERT INTO items (id, owner_id, kind, title, description)
      VALUES ('project', 'workspace', 'project', 'Launch', 'Original description');
    INSERT INTO item_property_values (id, owner_id, item_id, property_id, value)
      VALUES ('timing-value', 'workspace', 'project', 'timing', '"Q3"');
  `);

  const migration = await readFile(new URL("../drizzle/0022_project_documents_and_templates.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  assert.deepEqual({ ...db.prepare("SELECT default_value, system_key, active FROM property_definitions WHERE id = 'timing'").get() }, {
    default_value: "null",
    system_key: null,
    active: 1,
  });
  assert.equal(db.prepare("SELECT legacy_value FROM item_property_values WHERE id = 'timing-value'").get().legacy_value, null);

  db.exec(`
    UPDATE property_definitions SET active = 0 WHERE id = 'timing';
    INSERT INTO project_documents (id, owner_id, project_id, content, plain_text, version)
      VALUES ('document', 'workspace', 'project', '[{"type":"paragraph","content":"Original description"}]', 'Original description', 1);
    INSERT INTO project_templates (id, owner_id, name, content, plain_text)
      VALUES ('template', 'workspace', 'Launch brief', '[{"type":"heading","content":"Purpose"}]', 'Purpose');
    DELETE FROM project_templates WHERE id = 'template';
  `);

  assert.equal(db.prepare("SELECT value FROM item_property_values WHERE id = 'timing-value'").get().value, '"Q3"');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM project_documents WHERE project_id = 'project'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM project_templates").get().count, 0);
  assert.throws(() => db.exec(`
    INSERT INTO project_documents (id, owner_id, project_id, content, plain_text)
      VALUES ('duplicate', 'workspace', 'project', '[]', '');
  `), /UNIQUE constraint failed/);
  db.close();
});

test("stores one scheduled API data connection per Key Result or Project", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const [baseMigration, workspaceMigration, cycleMigration, krDataMigration] = await Promise.all([
    readFile(new URL("../drizzle/0000_eminent_mandroid.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_wet_roland_deschain.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0013_calm_james_howlett.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0025_kr_data_connections.sql", import.meta.url), "utf8"),
  ]);
  db.exec(baseMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(workspaceMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(cycleMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
    INSERT INTO okr_cycles (id, owner_id, name, version, start_date, end_date, status)
      VALUES ('cycle', 'workspace', '2026 Q3', 1, '2026-07-01', '2026-09-30', 'active');
    INSERT INTO items (id, owner_id, cycle_id, kind, title, progress)
      VALUES ('objective', 'workspace', 'cycle', 'objective', 'Grow', 60),
             ('kr', 'workspace', 'cycle', 'key_result', 'Revenue', 25),
             ('initiative', 'workspace', 'cycle', 'initiative', 'Pricing', 40),
             ('project', 'workspace', 'cycle', 'project', 'Pricing rollout', 10);
  `);
  db.exec(krDataMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO kr_data_connections
      (id, owner_id, kr_item_id, name, endpoint_url, value_path, baseline_value, target_value, cadence, active, next_sync_at)
      VALUES ('connection', 'workspace', 'kr', 'Revenue API', 'https://api.example.com/revenue', 'data.value', 0, 1000, 'daily', 1, '2026-08-30T00:00:00.000Z');
  `);

  assert.deepEqual({ ...db.prepare("SELECT cadence, active, target_value, last_sync_status FROM kr_data_connections WHERE id = 'connection'").get() }, {
    cadence: "daily",
    active: 1,
    target_value: 1000,
    last_sync_status: "never",
  });
  assert.equal(db.prepare("SELECT progress FROM items WHERE id = 'objective'").get().progress, 0);
  assert.equal(db.prepare("SELECT progress FROM items WHERE id = 'initiative'").get().progress, 0);
  assert.equal(db.prepare("SELECT progress FROM items WHERE id = 'kr'").get().progress, 25);
  db.exec(`
    INSERT INTO kr_data_connections (id, owner_id, kr_item_id, name, endpoint_url, target_value)
      VALUES ('project-connection', 'workspace', 'project', 'Project API', 'https://api.example.com/project', 100);
  `);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM kr_data_connections").get().count, 2);
  assert.throws(() => db.exec(`
    INSERT INTO kr_data_connections (id, owner_id, kr_item_id, name, endpoint_url, target_value)
      VALUES ('duplicate', 'workspace', 'project', 'Other', 'https://api.example.com/other', 2000);
  `), /UNIQUE/i);
  db.exec("DELETE FROM items WHERE id = 'kr'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM kr_data_connections").get().count, 1);
  db.exec("DELETE FROM items WHERE id = 'project'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM kr_data_connections").get().count, 0);
  db.close();
});

test("adds member daily drafts, immutable submissions, and Slack daily delivery state", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
    CREATE TABLE workspace_members (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT, email TEXT, display_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo', source TEXT NOT NULL DEFAULT 'web', source_ref TEXT
    );
    CREATE TABLE daily_scrums (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scrum_date TEXT NOT NULL,
      yesterday_note TEXT NOT NULL DEFAULT '', today_note TEXT NOT NULL DEFAULT '', blockers_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_daily_scrums_owner_date ON daily_scrums(owner_id, scrum_date);
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace', 'Team', 'owner');
    INSERT INTO workspace_members (id, workspace_id, user_id, email, display_name, role)
      VALUES ('member-1', 'workspace', 'owner', 'owner@example.com', 'Owner', 'owner'),
             ('member-2', 'workspace', 'member', 'member@example.com', 'Member', 'member');
    INSERT INTO items (id, owner_id, kind, title) VALUES ('task', 'workspace', 'task', 'Ship daily bot');
    INSERT INTO daily_scrums (id, owner_id, scrum_date, today_note)
      VALUES ('legacy', 'workspace', '2026-08-30', 'Existing workspace note');
  `);
  const [migration, skipMigration] = await Promise.all([
    readFile(new URL("../drizzle/0026_slack_daily_bot.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0028_daily_skip.sql", import.meta.url), "utf8"),
  ]);
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  db.exec(skipMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(`
    INSERT INTO daily_scrums (id, owner_id, member_id, scrum_date, today_note)
      VALUES ('draft-1', 'workspace', 'member-1', '2026-08-30', 'Owner draft'),
             ('draft-2', 'workspace', 'member-2', '2026-08-30', 'Member draft');
    INSERT INTO daily_scrum_task_selections (id, owner_id, daily_scrum_id, member_id, task_id)
      VALUES ('selection', 'workspace', 'draft-1', 'member-1', 'task');
    INSERT INTO daily_submissions
      (id, owner_id, member_id, member_name, scrum_date, version, today_note)
      VALUES ('submission-v1', 'workspace', 'member-1', 'Owner', '2026-08-30', 1, 'First'),
             ('submission-v2', 'workspace', 'member-1', 'Owner', '2026-08-30', 2, 'Second');
    INSERT INTO daily_submissions
      (id, owner_id, member_id, member_name, scrum_date, version, skip_reason, skip_note)
      VALUES ('submission-skip', 'workspace', 'member-2', 'Member', '2026-08-30', 1, 'vacation', 'Annual leave');
    INSERT INTO daily_task_snapshots
      (id, owner_id, submission_id, task_id, task_title, parent_kind, parent_title, status)
      VALUES ('snapshot', 'workspace', 'submission-v2', 'task', 'Ship daily bot', 'general', 'General', 'todo');
    INSERT INTO slack_member_links
      (id, owner_id, member_id, team_id, slack_user_id, slack_email)
      VALUES ('link', 'workspace', 'member-1', 'T123', 'U123', 'owner@example.com');
    INSERT INTO slack_daily_settings (owner_id) VALUES ('workspace');
    INSERT INTO slack_daily_channels (id, owner_id, channel_id, channel_name)
      VALUES ('channel', 'workspace', 'C123', 'daily');
    INSERT INTO slack_daily_reminders
      (id, owner_id, member_id, slack_user_id, dm_channel_id, scheduled_message_id, post_at, block_id)
      VALUES ('reminder', 'workspace', 'member-1', 'U123', 'D123', 'Q123', 1788120000, 'okri_daily_reminder:1');
    INSERT INTO slack_daily_publications
      (id, owner_id, member_id, submission_id, scrum_date, channel_id)
      VALUES ('publication', 'workspace', 'member-1', 'submission-v2', '2026-08-30', 'C123');
  `);

  assert.deepEqual({ ...db.prepare("SELECT member_id, today_note FROM daily_scrums WHERE id = 'legacy'").get() }, {
    member_id: null,
    today_note: "Existing workspace note",
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM daily_scrums WHERE owner_id = 'workspace' AND scrum_date = '2026-08-30'").get().count, 3);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM daily_submissions WHERE member_id = 'member-1'").get().version, 2);
  assert.deepEqual({ ...db.prepare("SELECT skip_reason, skip_note FROM daily_submissions WHERE id = 'submission-skip'").get() }, {
    skip_reason: "vacation",
    skip_note: "Annual leave",
  });
  assert.throws(() => db.exec("INSERT INTO slack_member_links (id, owner_id, member_id, team_id, slack_user_id) VALUES ('duplicate', 'workspace', 'member-2', 'T123', 'U123')"), /UNIQUE/i);
  db.exec("DELETE FROM items WHERE id = 'task'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM daily_scrum_task_selections").get().count, 0);
  assert.deepEqual({ ...db.prepare("SELECT task_title, status FROM daily_task_snapshots WHERE id = 'snapshot'").get() }, {
    task_title: "Ship daily bot",
    status: "todo",
  });
  db.exec("DELETE FROM workspaces WHERE id = 'workspace'");
  for (const table of ["daily_submissions", "slack_member_links", "slack_daily_reminders", "slack_daily_publications"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} should cascade with workspace deletion`);
  }
  db.close();
});

test("separates Google identities from users and pending invitations from active members", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workspace_members (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT, email TEXT, display_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active', invited_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO workspaces (id, name, owner_user_id) VALUES
      ('personal', 'Personal', 'personal'), ('team', 'AllVibe', 'owner');
  `);
  const migration = await readFile(new URL("../drizzle/0030_identity_and_invitations.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  assert.deepEqual(db.prepare("SELECT id, kind FROM workspaces ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "personal", kind: "personal" },
    { id: "team", kind: "team" },
  ]);
  db.exec(`
    INSERT INTO users (id, email_normalized, display_name) VALUES ('user', 'member@example.com', 'Member');
    INSERT INTO auth_identities (id, user_id, provider, provider_subject, email)
      VALUES ('identity', 'user', 'google', 'google-sub', 'member@example.com');
    INSERT INTO workspace_invitations
      (id, workspace_id, email, display_name, role, token_hash, expires_at, invited_by_user_id)
      VALUES ('invite', 'team', 'new@example.com', 'New', 'member', 'hash', '2026-09-30T00:00:00.000Z', 'owner');
  `);
  assert.throws(() => db.exec("INSERT INTO users (id, email_normalized) VALUES ('duplicate', 'member@example.com')"), /UNIQUE/i);
  assert.throws(() => db.exec(`INSERT INTO auth_identities (id, user_id, provider, provider_subject, email)
    VALUES ('duplicate-identity', 'user', 'google', 'google-sub', 'member@example.com')`), /UNIQUE/i);
  assert.throws(() => db.exec(`INSERT INTO workspace_invitations
    (id, workspace_id, email, role, expires_at, invited_by_user_id)
    VALUES ('duplicate-invite', 'team', 'new@example.com', 'viewer', '2026-09-30T00:00:00.000Z', 'owner')`), /UNIQUE/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_members").get().count, 0);
  db.close();
});

test("adds isolated workspace billing and email consent records while scrubbing phone data", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, email_normalized TEXT NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL);
    CREATE TABLE workspace_members (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE account_registrations (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_phone TEXT NOT NULL DEFAULT '', phone_hash TEXT NOT NULL DEFAULT '',
      phone_last_four TEXT NOT NULL DEFAULT '', verification_provider TEXT NOT NULL DEFAULT '',
      phone_verified_at TEXT
    );
    CREATE TABLE phone_verification_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users (id, email_normalized) VALUES ('owner-a', 'owner-a@example.com'), ('owner-b', 'owner-b@example.com');
    INSERT INTO workspaces (id, name, owner_user_id) VALUES ('workspace-a', 'A', 'owner-a'), ('workspace-b', 'B', 'owner-b');
    INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES ('member-a', 'workspace-a', 'owner-a', 'owner');
    INSERT INTO account_registrations
      (user_id, encrypted_phone, phone_hash, phone_last_four, verification_provider, phone_verified_at)
      VALUES ('owner-a', 'encrypted', 'hash', '1234', 'twilio_verify', CURRENT_TIMESTAMP);
    INSERT INTO phone_verification_requests (id, user_id) VALUES ('request', 'owner-a');
  `);
  const migration = await readFile(new URL("../drizzle/0034_billing_email.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  assert.deepEqual({ ...db.prepare(`SELECT encrypted_phone, phone_hash, phone_last_four, verification_provider, phone_verified_at
    FROM account_registrations WHERE user_id = 'owner-a'`).get() }, {
    encrypted_phone: "", phone_hash: "", phone_last_four: "", verification_provider: "", phone_verified_at: null,
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM phone_verification_requests").get().count, 0);

  db.exec(`
    INSERT INTO email_marketing_consents
      (user_id, marketing_data_consent, advertising_email_consent, policy_version, reaffirm_after)
      VALUES ('owner-a', 1, 0, '2026-09-01', '2028-09-01T00:00:00.000Z');
    INSERT INTO email_marketing_consent_events
      (id, user_id, consent_type, granted, policy_version)
      VALUES ('consent-event', 'owner-a', 'marketing_data', 1, '2026-09-01');
    INSERT INTO workspace_subscriptions (workspace_id, billing_owner_user_id)
      VALUES ('workspace-a', 'owner-a'), ('workspace-b', 'owner-b');
    INSERT INTO billing_trial_claims (id, billing_owner_user_id, payer_hash, workspace_id)
      VALUES ('trial-claim', 'owner-a', 'payer-hash', 'workspace-a');
    INSERT INTO billing_transactions
      (id, workspace_id, order_id, idempotency_key, kind, plan, price_won, status, retained_until)
      VALUES ('transaction', 'workspace-a', 'order', 'idempotency', 'charge', 'team', 11000, 'paid', '2031-09-01T00:00:00.000Z');
    INSERT INTO project_monthly_usage (workspace_id, period_key, created_count)
      VALUES ('workspace-a', '2026-09', 1), ('workspace-b', '2026-09', 2);
    INSERT INTO workspace_editor_selections (workspace_id, member_id)
      VALUES ('workspace-a', 'member-a');
  `);
  assert.deepEqual({ ...db.prepare("SELECT plan, status FROM workspace_subscriptions WHERE workspace_id = 'workspace-a'").get() }, {
    plan: "free", status: "free",
  });
  assert.throws(() => db.exec("INSERT INTO project_monthly_usage (workspace_id, period_key) VALUES ('workspace-a', '2026-09')"), /UNIQUE/i);
  assert.equal(db.prepare("SELECT advertising_email_consent FROM email_marketing_consents WHERE user_id = 'owner-a'").get().advertising_email_consent, 0);

  db.exec("DELETE FROM workspaces WHERE id = 'workspace-a'");
  for (const table of ["workspace_subscriptions", "project_monthly_usage", "workspace_editor_selections"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = 'workspace-a'`).get().count, 0, `${table} should cascade with workspace deletion`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_trial_claims WHERE billing_owner_user_id = 'owner-a'").get().count, 1, "trial claims must survive workspace deletion to prevent repeated trials");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_transactions WHERE workspace_id = 'workspace-a'").get().count, 1, "billing transactions must survive for the five-year retention period");
  db.exec("DELETE FROM users WHERE id = 'owner-a'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM email_marketing_consents").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM email_marketing_consent_events").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_trial_claims WHERE billing_owner_user_id = 'owner-a'").get().count, 1);
  db.close();
});
