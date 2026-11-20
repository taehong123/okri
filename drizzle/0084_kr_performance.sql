CREATE TABLE kr_performance_changes (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kr_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('rule','project','entry')),
  subject_id TEXT NOT NULL DEFAULT '',
  effective_date TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
--> statement-breakpoint
CREATE INDEX idx_kr_performance_owner_kind ON kr_performance_changes(owner_id,kind,kr_item_id);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_kr_performance_revision ON kr_performance_changes(owner_id,kr_item_id,revision);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_kr_performance_request ON kr_performance_changes(owner_id,kr_item_id,request_id);
--> statement-breakpoint
CREATE TABLE kr_performance_stops (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kr_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_kr_performance_stops_owner_kr ON kr_performance_stops(owner_id,kr_item_id,recorded_at);
--> statement-breakpoint
CREATE TRIGGER kr_performance_project_stop AFTER UPDATE OF parent_id,archived_at ON items
WHEN OLD.kind='project' AND OLD.archived_at IS NULL AND (NEW.parent_id IS NOT OLD.parent_id OR NEW.archived_at IS NOT NULL)
BEGIN
  INSERT INTO kr_performance_stops(id,owner_id,kr_item_id,project_id,recorded_at)
  SELECT lower(hex(randomblob(16))),OLD.owner_id,i.parent_id,OLD.id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM items i WHERE i.owner_id=OLD.owner_id AND i.id=OLD.parent_id AND i.kind='initiative'
  AND EXISTS(SELECT 1 FROM kr_performance_changes c WHERE c.owner_id=OLD.owner_id AND c.kr_item_id=i.parent_id AND c.kind='rule');
END;
--> statement-breakpoint
CREATE TRIGGER kr_performance_initiative_stop AFTER UPDATE OF parent_id,archived_at ON items
WHEN OLD.kind='initiative' AND OLD.archived_at IS NULL AND (NEW.parent_id IS NOT OLD.parent_id OR NEW.archived_at IS NOT NULL)
BEGIN
  INSERT INTO kr_performance_stops(id,owner_id,kr_item_id,project_id,recorded_at)
  SELECT lower(hex(randomblob(16))),OLD.owner_id,OLD.parent_id,p.id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM items p WHERE p.owner_id=OLD.owner_id AND p.parent_id=OLD.id AND p.kind='project' AND p.archived_at IS NULL
  AND EXISTS(SELECT 1 FROM kr_performance_changes c WHERE c.owner_id=OLD.owner_id AND c.kr_item_id=OLD.parent_id AND c.kind='rule');
END;
--> statement-breakpoint
CREATE TRIGGER kr_performance_kr_stop AFTER UPDATE OF archived_at ON items
WHEN OLD.kind='key_result' AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
  INSERT INTO kr_performance_stops(id,owner_id,kr_item_id,project_id,recorded_at)
  SELECT lower(hex(randomblob(16))),OLD.owner_id,OLD.id,p.id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM items p JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id
  WHERE p.owner_id=OLD.owner_id AND p.kind='project' AND p.archived_at IS NULL AND i.parent_id=OLD.id AND i.kind='initiative'
  AND EXISTS(SELECT 1 FROM kr_performance_changes c WHERE c.owner_id=OLD.owner_id AND c.kr_item_id=OLD.id AND c.kind='rule');
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_performance_changes_insert AFTER INSERT ON kr_performance_changes
BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_performance_changes_update AFTER UPDATE ON kr_performance_changes
BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_performance_changes_delete AFTER DELETE ON kr_performance_changes
BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=OLD.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_performance_stops_insert AFTER INSERT ON kr_performance_stops
BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_performance_stops_update AFTER UPDATE ON kr_performance_stops
BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_performance_stops_delete AFTER DELETE ON kr_performance_stops
BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=OLD.owner_id; END;
