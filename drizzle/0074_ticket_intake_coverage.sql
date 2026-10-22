CREATE TABLE ticket_automation_requests_next (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  source_user TEXT NOT NULL,
  source_event_ts TEXT NOT NULL DEFAULT '',
  issue_key TEXT NOT NULL DEFAULT 'legacy',
  category TEXT NOT NULL DEFAULT 'improvement' CHECK(category IN ('bug_fix','improvement','feature','guidance')),
  analysis_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(analysis_json)),
  requester_slack_user TEXT NOT NULL DEFAULT '',
  requester_name TEXT NOT NULL DEFAULT '',
  source_digest TEXT NOT NULL,
  source_text TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent','high','medium','low')),
  product_id TEXT REFERENCES ticket_development_products(id) ON DELETE SET NULL,
  repository_id TEXT NOT NULL DEFAULT '',
  dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dependencies_json)),
  coordination_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(coordination_json)),
  release_commit TEXT NOT NULL DEFAULT '',
  release_confirmed_by TEXT,
  risk TEXT NOT NULL CHECK(risk IN ('blocked','review','low')),
  reasons_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(reasons_json)),
  state TEXT NOT NULL DEFAULT 'recommended' CHECK(state IN ('recommended','created','queued','running','waiting_answer','security_review','review','publishing','published','blocked','failed','dismissed')),
  member_id TEXT REFERENCES workspace_members(id) ON DELETE SET NULL,
  port_id TEXT REFERENCES ticket_execution_ports(id) ON DELETE SET NULL,
  ticket_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES local_agent_jobs(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  approved_at TEXT,
  notice TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  report_bucket TEXT,
  security_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(security_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id,source_channel,source_ts,source_event_ts,issue_key)
);
--> statement-breakpoint
INSERT INTO ticket_automation_requests_next(id,owner_id,team_id,source_channel,source_ts,source_user,requester_slack_user,requester_name,source_digest,source_text,title,description,priority,product_id,repository_id,dependencies_json,coordination_json,release_commit,release_confirmed_by,risk,reasons_json,state,member_id,port_id,ticket_id,task_id,job_id,revision,approved_by,approved_at,notice,question,answer,report_bucket,security_json,created_at,updated_at) SELECT id,owner_id,team_id,source_channel,source_ts,source_user,requester_slack_user,requester_name,source_digest,source_text,title,description,priority,product_id,repository_id,dependencies_json,coordination_json,release_commit,release_confirmed_by,risk,reasons_json,state,member_id,port_id,ticket_id,task_id,job_id,revision,approved_by,approved_at,notice,question,answer,report_bucket,security_json,created_at,updated_at FROM ticket_automation_requests;
--> statement-breakpoint
CREATE TABLE ticket_automation_outbox_next (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES ticket_automation_requests_next(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain','cancelled')),
  message_ts TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO ticket_automation_outbox_next SELECT * FROM ticket_automation_outbox;
--> statement-breakpoint
DROP TABLE ticket_automation_outbox;
--> statement-breakpoint
DROP TABLE ticket_automation_requests;
--> statement-breakpoint
ALTER TABLE ticket_automation_requests_next RENAME TO ticket_automation_requests;
--> statement-breakpoint
ALTER TABLE ticket_automation_outbox_next RENAME TO ticket_automation_outbox;
--> statement-breakpoint
ALTER TABLE ticket_automation_outbox ADD COLUMN reconcile_next_at TEXT;
--> statement-breakpoint
CREATE INDEX ticket_automation_state ON ticket_automation_requests(owner_id,state,updated_at);
--> statement-breakpoint
CREATE INDEX ticket_automation_job ON ticket_automation_requests(job_id) WHERE job_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX ticket_automation_port ON ticket_automation_requests(owner_id,port_id,state);
--> statement-breakpoint
CREATE INDEX ticket_automation_repository ON ticket_automation_requests(owner_id,product_id,repository_id,state,priority,created_at);
--> statement-breakpoint
CREATE INDEX ticket_outbox_pending ON ticket_automation_outbox(state,created_at);
--> statement-breakpoint
CREATE TABLE ticket_intake_messages (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_ts TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','retry','review','analyzed','no_work','existing','ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until TEXT,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  request_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(request_ids_json)),
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id,channel_id,message_ts,digest)
);
--> statement-breakpoint
CREATE INDEX ticket_intake_pending ON ticket_intake_messages(state,next_attempt_at,received_at);
--> statement-breakpoint
CREATE TABLE ticket_intake_scans (
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  completed_passes INTEGER NOT NULL DEFAULT 0,
  messages_seen INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_completed_at TEXT,
  next_scan_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(owner_id,channel_id)
);
--> statement-breakpoint
CREATE TABLE ticket_intake_threads (
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  root_ts TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  latest_reply TEXT NOT NULL DEFAULT '',
  scanned_reply TEXT NOT NULL DEFAULT '',
  analysis_lease_id TEXT,
  analysis_lease_until TEXT,
  next_scan_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(owner_id,channel_id,root_ts)
);
