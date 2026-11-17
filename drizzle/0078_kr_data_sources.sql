ALTER TABLE `kr_project_metrics` ADD `active` integer DEFAULT true NOT NULL;

--> statement-breakpoint
DROP TRIGGER project_contribution_insert;
--> statement-breakpoint
CREATE TRIGGER project_contribution_insert AFTER INSERT ON project_contributions BEGIN
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
END;

--> statement-breakpoint
DROP TRIGGER project_contribution_update;
--> statement-breakpoint
CREATE TRIGGER project_contribution_update AFTER UPDATE OF actual_value, applied, enabled, kr_item_id ON project_contributions BEGIN
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND kr_item_id=OLD.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND id=OLD.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
END;

--> statement-breakpoint
DROP TRIGGER project_contribution_delete;
--> statement-breakpoint
CREATE TRIGGER project_contribution_delete AFTER DELETE ON project_contributions BEGIN
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND kr_item_id=OLD.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND id=OLD.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id AND active=1);
END;

--> statement-breakpoint
DROP TRIGGER project_contribution_complete;
--> statement-breakpoint
CREATE TRIGGER project_contribution_complete AFTER UPDATE OF status ON items
WHEN NEW.kind='project' AND NEW.status IN ('done','development_done') AND OLD.status NOT IN ('done','development_done') AND NEW.archived_at IS NULL
BEGIN
  UPDATE project_contributions SET applied=1,actual_value=coalesce(actual_value,default_value),version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE owner_id=NEW.owner_id AND project_id=NEW.id AND enabled=1 AND applied=0 AND EXISTS(SELECT 1 FROM kr_project_metrics m WHERE m.owner_id=project_contributions.owner_id AND m.kr_item_id=project_contributions.kr_item_id AND m.active=1);
END;

--> statement-breakpoint
DROP TRIGGER project_metric_target_guard_insert;
--> statement-breakpoint
CREATE TRIGGER project_metric_target_guard_insert BEFORE INSERT ON kr_project_metrics
WHEN NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.kr_item_id AND owner_id=NEW.owner_id AND kind='key_result')
 OR (NEW.active=1 AND EXISTS(SELECT 1 FROM kr_data_connections WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id AND active=1))
BEGIN SELECT RAISE(ABORT,'Project metric target or API connection constraint'); END;

--> statement-breakpoint
DROP TRIGGER project_metric_target_guard_update;
--> statement-breakpoint
CREATE TRIGGER project_metric_target_guard_update BEFORE UPDATE OF owner_id, kr_item_id, active ON kr_project_metrics
WHEN NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.kr_item_id AND owner_id=NEW.owner_id AND kind='key_result')
 OR (NEW.active=1 AND EXISTS(SELECT 1 FROM kr_data_connections WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id AND active=1))
BEGIN SELECT RAISE(ABORT,'Project metric target or API connection constraint'); END;

--> statement-breakpoint
DROP TRIGGER project_metric_api_guard_insert;
--> statement-breakpoint
CREATE TRIGGER project_metric_api_guard_insert BEFORE INSERT ON kr_data_connections
WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id AND active=1)
BEGIN SELECT RAISE(ABORT,'API connection conflicts with Project contribution metric constraint'); END;

--> statement-breakpoint
DROP TRIGGER project_metric_api_guard_update;
--> statement-breakpoint
CREATE TRIGGER project_metric_api_guard_update BEFORE UPDATE OF owner_id, kr_item_id, active ON kr_data_connections
WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id AND active=1)
BEGIN SELECT RAISE(ABORT,'API connection conflicts with Project contribution metric constraint'); END;

--> statement-breakpoint
DROP TRIGGER project_metric_progress;
--> statement-breakpoint
CREATE TRIGGER project_metric_progress AFTER UPDATE OF progress ON items
WHEN NEW.kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.id AND active=1) AND NEW.progress != (SELECT (SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id) FROM items WHERE id=NEW.id)
BEGIN UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id) WHERE id=NEW.id AND owner_id=NEW.owner_id; END;

--> statement-breakpoint
CREATE TRIGGER project_metric_value_insert AFTER INSERT ON kr_project_metrics WHEN NEW.active=1 BEGIN
UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id);
END;

--> statement-breakpoint
CREATE TRIGGER project_metric_value_update AFTER UPDATE OF starting_value, target_value, active ON kr_project_metrics WHEN NEW.active=1 BEGIN
UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id);
END;
