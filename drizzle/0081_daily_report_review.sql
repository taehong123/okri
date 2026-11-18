CREATE TABLE daily_report_policies (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 approver_member_id TEXT NOT NULL,
 config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json)='object'),
 version INTEGER NOT NULL DEFAULT 1, last_error TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(json_extract(config_json,'$.enabled')=enabled AND json_extract(config_json,'$.approverMemberId')=approver_member_id)
);
--> statement-breakpoint
CREATE TABLE daily_report_drafts (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 report_date TEXT NOT NULL, revision INTEGER NOT NULL,
 policy_version INTEGER NOT NULL, source_hash TEXT NOT NULL,
 pages_json TEXT NOT NULL CHECK(json_valid(pages_json) AND json_type(pages_json)='array'),
 channels_json TEXT NOT NULL CHECK(json_valid(channels_json) AND json_type(channels_json)='array'),
 approver_member_id TEXT NOT NULL, connection_key TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','review_queued','awaiting_approval','approved','publishing','sent','rejected','superseded','uncertain')),
 dm_channel_id TEXT, review_root_ts TEXT, review_action_ts TEXT,
 approved_by_slack_user_id TEXT, approved_at TEXT, feedback TEXT NOT NULL DEFAULT '',
 created_by_user_id TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '',
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(owner_id,report_date,revision)
);
--> statement-breakpoint
CREATE INDEX idx_daily_report_drafts_owner_date ON daily_report_drafts(owner_id,report_date,revision);
--> statement-breakpoint
CREATE TABLE daily_report_threads (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 report_date TEXT NOT NULL, channel_id TEXT NOT NULL, connection_key TEXT NOT NULL,
 root_message_ts TEXT NOT NULL, latest_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(owner_id,report_date,channel_id)
);
--> statement-breakpoint
CREATE TABLE daily_report_guards (id TEXT PRIMARY KEY NOT NULL, valid INTEGER NOT NULL CHECK(valid=1));
--> statement-breakpoint
CREATE TRIGGER daily_report_approved_snapshot_immutable BEFORE UPDATE OF pages_json,channels_json,source_hash,policy_version,revision,approver_member_id,connection_key ON daily_report_drafts
WHEN OLD.approved_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'approved daily report snapshot is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER daily_report_approval_identity_guard BEFORE UPDATE OF status ON daily_report_drafts
WHEN NEW.status IN ('approved','publishing') AND (NEW.approved_at IS NULL OR NOT EXISTS(
 SELECT 1 FROM workspace_members m JOIN slack_member_links l ON l.owner_id=m.workspace_id AND l.member_id=m.id
 JOIN slack_connections c ON c.owner_id=l.owner_id AND c.team_id=l.team_id
 WHERE m.workspace_id=NEW.owner_id AND m.id=NEW.approver_member_id AND m.status='active' AND l.slack_user_id=NEW.approved_by_slack_user_id
 AND NEW.connection_key=json_array(c.id,c.team_id,c.connected_at)))
BEGIN SELECT RAISE(ABORT,'daily report approval identity required'); END;
--> statement-breakpoint
CREATE TRIGGER daily_report_policy_approver_insert BEFORE INSERT ON daily_report_policies
WHEN NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=NEW.owner_id AND m.id=NEW.approver_member_id AND m.status='active')
BEGIN SELECT RAISE(ABORT,'daily report approver constraint'); END;
--> statement-breakpoint
CREATE TRIGGER daily_report_policy_approver_update BEFORE UPDATE OF owner_id,approver_member_id ON daily_report_policies
WHEN NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=NEW.owner_id AND m.id=NEW.approver_member_id AND m.status='active')
BEGIN SELECT RAISE(ABORT,'daily report approver constraint'); END;
--> statement-breakpoint
CREATE TRIGGER daily_report_policy_changed AFTER UPDATE ON daily_report_policies WHEN OLD.version!=NEW.version OR OLD.enabled!=NEW.enabled BEGIN
 UPDATE daily_report_drafts SET status='superseded',last_error='report_policy_changed',updated_at=NEW.updated_at
 WHERE owner_id=NEW.owner_id AND status IN ('draft','review_queued','awaiting_approval','approved');
 UPDATE slack_bot_deliveries SET status='cancelled',last_error='report_policy_changed',updated_at=NEW.updated_at
 WHERE owner_id=NEW.owner_id AND bot_kind IN ('daily_report_review','daily_report_publication') AND status IN ('pending','retry','preparing');
END;
--> statement-breakpoint
CREATE TRIGGER daily_report_legacy_delivery_guard BEFORE UPDATE OF status ON slack_bot_deliveries
WHEN NEW.status='sending' AND NEW.bot_kind IN ('daily_publication','daily_digest') AND EXISTS(SELECT 1 FROM daily_report_policies WHERE owner_id=NEW.owner_id)
BEGIN SELECT RAISE(ABORT,'daily report approval required'); END;
--> statement-breakpoint
CREATE TRIGGER daily_report_publication_guard BEFORE UPDATE OF status ON slack_bot_deliveries
WHEN NEW.status='sending' AND NEW.bot_kind='daily_report_publication' AND NOT EXISTS(
 SELECT 1 FROM daily_report_drafts d JOIN daily_report_policies p ON p.owner_id=d.owner_id
 JOIN workspace_members m ON m.workspace_id=d.owner_id AND m.id=d.approver_member_id AND m.status='active'
 WHERE d.owner_id=NEW.owner_id AND d.id=NEW.subject_id AND d.status IN ('approved','publishing','sent')
 AND d.approved_at IS NOT NULL AND d.approved_by_slack_user_id IS NOT NULL AND d.policy_version=p.version AND p.enabled=1
 AND EXISTS(SELECT 1 FROM json_each(d.channels_json) c WHERE json_extract(c.value,'$.id')=json_extract(NEW.payload,'$.channel'))
 AND json_extract(NEW.payload,'$.text')=json_extract(d.pages_json,'$['||json_extract(NEW.payload,'$.pageIndex')||']'))
BEGIN SELECT RAISE(ABORT,'daily report is not approved'); END;
