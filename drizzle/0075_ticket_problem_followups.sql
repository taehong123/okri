CREATE TABLE ticket_problem_sources (
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES ticket_automation_requests(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  root_ts TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,request_id,channel_id,root_ts)
);
--> statement-breakpoint
CREATE TABLE ticket_problem_changes (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES ticket_automation_requests(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES local_agent_jobs(id) ON DELETE SET NULL,
  digest TEXT NOT NULL,
  summary TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('clarification','scope_change')),
  state TEXT NOT NULL CHECK(state IN ('pending','applied','needs_review')),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE(owner_id,request_id,digest)
);
--> statement-breakpoint
CREATE INDEX ticket_problem_changes_job ON ticket_problem_changes(job_id,state);
--> statement-breakpoint
CREATE TABLE ticket_intake_channel_leases (
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  lease_id TEXT,
  lease_until TEXT,
  PRIMARY KEY(owner_id,channel_id)
);
--> statement-breakpoint
CREATE TABLE ticket_intake_reply_discovery (
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  next_scan_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(owner_id,channel_id)
);
