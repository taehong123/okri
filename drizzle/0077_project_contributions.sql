-- Retire the mistaken Task-count mode. Historical rows and migration 0076 remain intact.
DROP TRIGGER IF EXISTS project_task_goal_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_task_goal_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_task_goal_task_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_task_goal_task_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_task_goal_task_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_task_goal_progress;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_task_goal_guard_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_task_goal_guard_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_task_goal_api_guard_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_task_goal_api_guard_update;
--> statement-breakpoint
CREATE TABLE `kr_project_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kr_item_id` text NOT NULL,
	`starting_value` real NOT NULL,
	`target_value` real NOT NULL,
	`unit` text DEFAULT '%' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kr_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "kr_project_metric_values" CHECK("kr_project_metrics"."starting_value" BETWEEN 0 AND 1000000000000 AND "kr_project_metrics"."target_value" > 0 AND "kr_project_metrics"."target_value" <= 1000000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kr_project_metrics_owner_kr` ON `kr_project_metrics` (`owner_id`,`kr_item_id`);--> statement-breakpoint
CREATE TABLE `project_contribution_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "project_contribution_guard_valid" CHECK("project_contribution_guards"."valid" = 1)
);
--> statement-breakpoint
CREATE TABLE `project_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kr_item_id` text NOT NULL,
	`default_value` real NOT NULL,
	`actual_value` real,
	`applied` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_request_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kr_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_contribution_values" CHECK("project_contributions"."default_value" BETWEEN 0 AND 1000000000000 AND ("project_contributions"."actual_value" IS NULL OR "project_contributions"."actual_value" BETWEEN 0 AND 1000000000000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_contributions_owner_project` ON `project_contributions` (`owner_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_contributions_owner_kr` ON `project_contributions` (`owner_id`,`kr_item_id`);
--> statement-breakpoint
CREATE TRIGGER project_contribution_insert AFTER INSERT ON project_contributions BEGIN
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id);
END;
--> statement-breakpoint
CREATE TRIGGER project_contribution_update AFTER UPDATE OF actual_value, applied, enabled, kr_item_id ON project_contributions BEGIN
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND kr_item_id=OLD.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND id=OLD.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id);
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=NEW.owner_id AND id=NEW.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id);
END;
--> statement-breakpoint
CREATE TRIGGER project_contribution_delete AFTER DELETE ON project_contributions BEGIN
  UPDATE kr_project_metrics SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND kr_item_id=OLD.kr_item_id;
  UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=OLD.owner_id AND id=OLD.kr_item_id AND kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id);
END;
--> statement-breakpoint
CREATE TRIGGER project_contribution_complete AFTER UPDATE OF status ON items
WHEN NEW.kind='project' AND NEW.status IN ('done','development_done') AND OLD.status NOT IN ('done','development_done') AND NEW.archived_at IS NULL
BEGIN
  UPDATE project_contributions SET applied=1,actual_value=coalesce(actual_value,default_value),version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE owner_id=NEW.owner_id AND project_id=NEW.id AND enabled=1 AND applied=0;
END;
--> statement-breakpoint
CREATE TRIGGER project_contribution_reopen AFTER UPDATE OF status ON items
WHEN NEW.kind='project' AND NEW.status NOT IN ('done','development_done','archived') AND OLD.status IN ('done','development_done') AND NEW.archived_at IS NULL
BEGIN
  UPDATE project_contributions SET applied=0,actual_value=NULL,last_request_id=NULL,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE owner_id=NEW.owner_id AND project_id=NEW.id AND applied=1;
END;
--> statement-breakpoint
CREATE TRIGGER project_contribution_project_moved AFTER UPDATE OF parent_id ON items
WHEN NEW.kind='project' AND OLD.parent_id IS NOT NEW.parent_id BEGIN
  UPDATE project_contributions SET applied=0,actual_value=NULL,last_request_id=NULL,enabled=0,version=version+1
    WHERE owner_id=NEW.owner_id AND project_id=NEW.id AND NOT EXISTS(SELECT 1 FROM items i WHERE i.owner_id=NEW.owner_id AND i.id=NEW.parent_id AND i.kind='initiative' AND i.parent_id=project_contributions.kr_item_id);
END;
--> statement-breakpoint
CREATE TRIGGER project_contribution_initiative_moved AFTER UPDATE OF parent_id ON items
WHEN NEW.kind='initiative' AND OLD.parent_id IS NOT NEW.parent_id BEGIN
  UPDATE project_contributions SET applied=0,actual_value=NULL,last_request_id=NULL,enabled=0,version=version+1
    WHERE owner_id=NEW.owner_id AND kr_item_id IS NOT NEW.parent_id AND project_id IN (SELECT id FROM items WHERE owner_id=NEW.owner_id AND parent_id=NEW.id AND kind='project');
END;
--> statement-breakpoint
CREATE TRIGGER project_contribution_target_guard_insert BEFORE INSERT ON project_contributions
WHEN NEW.enabled=1 AND (NOT EXISTS(SELECT 1 FROM items p JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id JOIN items k ON k.id=i.parent_id AND k.owner_id=p.owner_id
 WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.kind='project' AND i.kind='initiative' AND k.kind='key_result' AND k.id=NEW.kr_item_id)
 OR NOT EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id))
BEGIN SELECT RAISE(ABORT,'Project contribution target constraint'); END;
--> statement-breakpoint
CREATE TRIGGER project_contribution_target_guard_update BEFORE UPDATE OF owner_id, project_id, kr_item_id ON project_contributions
WHEN NEW.enabled=1 AND (NOT EXISTS(SELECT 1 FROM items p JOIN items i ON i.id=p.parent_id AND i.owner_id=p.owner_id JOIN items k ON k.id=i.parent_id AND k.owner_id=p.owner_id
 WHERE p.owner_id=NEW.owner_id AND p.id=NEW.project_id AND p.kind='project' AND i.kind='initiative' AND k.kind='key_result' AND k.id=NEW.kr_item_id)
 OR NOT EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id))
BEGIN SELECT RAISE(ABORT,'Project contribution target constraint'); END;
--> statement-breakpoint
CREATE TRIGGER project_metric_target_guard_insert BEFORE INSERT ON kr_project_metrics
WHEN NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.kr_item_id AND owner_id=NEW.owner_id AND kind='key_result')
 OR EXISTS(SELECT 1 FROM kr_data_connections WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id)
BEGIN SELECT RAISE(ABORT,'Project metric target or API connection constraint'); END;
--> statement-breakpoint
CREATE TRIGGER project_metric_api_guard_insert BEFORE INSERT ON kr_data_connections
WHEN EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id)
BEGIN SELECT RAISE(ABORT,'API connection conflicts with Project contribution metric constraint'); END;
--> statement-breakpoint
CREATE TRIGGER project_metric_target_guard_update BEFORE UPDATE OF owner_id, kr_item_id ON kr_project_metrics
WHEN NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.kr_item_id AND owner_id=NEW.owner_id AND kind='key_result')
 OR EXISTS(SELECT 1 FROM kr_data_connections WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id)
BEGIN SELECT RAISE(ABORT,'Project metric target or API connection constraint'); END;
--> statement-breakpoint
CREATE TRIGGER project_metric_api_guard_update BEFORE UPDATE OF owner_id, kr_item_id ON kr_data_connections
WHEN EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.kr_item_id)
BEGIN SELECT RAISE(ABORT,'API connection conflicts with Project contribution metric constraint'); END;
--> statement-breakpoint
CREATE TRIGGER project_metric_progress AFTER UPDATE OF progress ON items
WHEN NEW.kind='key_result' AND EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=NEW.owner_id AND kr_item_id=NEW.id) AND NEW.progress != (SELECT (SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id) FROM items WHERE id=NEW.id)
BEGIN UPDATE items SET progress=(SELECT min(100,max(0,CAST(round(100.0 * (starting_value + coalesce((SELECT sum(c.actual_value) FROM project_contributions c WHERE c.owner_id=kr_project_metrics.owner_id AND c.kr_item_id=kr_project_metrics.kr_item_id AND c.applied=1),0)) / target_value) AS INTEGER))) FROM kr_project_metrics WHERE owner_id=items.owner_id AND kr_item_id=items.id) WHERE id=NEW.id AND owner_id=NEW.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_project_metrics_insert AFTER INSERT ON kr_project_metrics BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_project_metrics_update AFTER UPDATE ON kr_project_metrics BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_project_metrics_delete AFTER DELETE ON kr_project_metrics BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=OLD.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_project_contributions_insert AFTER INSERT ON project_contributions BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_project_contributions_update AFTER UPDATE ON project_contributions BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_project_contributions_delete AFTER DELETE ON project_contributions BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=OLD.owner_id; END;
