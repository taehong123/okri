CREATE TABLE ticket_automation_settings (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE ticket_development_products (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  specification TEXT NOT NULL DEFAULT '',
  setup_instructions TEXT NOT NULL DEFAULT '',
  repositories_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(repositories_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id,name)
);
CREATE TABLE ticket_execution_ports (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES local_agent_devices(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  chat_id TEXT,
  pairing_id TEXT REFERENCES local_agent_pairings(id) ON DELETE SET NULL,
  model TEXT NOT NULL DEFAULT '',
  models_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(models_json)),
  channel_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(channel_ids_json)),
  computer_label TEXT NOT NULL DEFAULT '',
  product_id TEXT REFERENCES ticket_development_products(id) ON DELETE SET NULL,
  repository_id TEXT NOT NULL DEFAULT '',
  verified_remote TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  UNIQUE(owner_id,name)
);
CREATE TABLE ticket_automation_requests (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  source_user TEXT NOT NULL,
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
  UNIQUE(owner_id,source_channel,source_ts)
);
CREATE INDEX ticket_automation_state ON ticket_automation_requests(owner_id,state,updated_at);
CREATE INDEX ticket_automation_job ON ticket_automation_requests(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX ticket_automation_port ON ticket_automation_requests(owner_id,port_id,state);
CREATE INDEX ticket_automation_repository ON ticket_automation_requests(owner_id,product_id,repository_id,state,priority,created_at);
CREATE TABLE ticket_automation_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES ticket_automation_requests(id) ON DELETE CASCADE,
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
CREATE INDEX ticket_outbox_pending ON ticket_automation_outbox(state,created_at);
CREATE TABLE ticket_automation_audit (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  revision INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL
);
