CREATE TABLE `kr_metric_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kr_item_id` text NOT NULL,
	`source` text NOT NULL,
	`event_kind` text NOT NULL,
	`current_value` real,
	`baseline_value` real DEFAULT 0 NOT NULL,
	`target_value` real NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kr_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "kr_metric_observation_source" CHECK("kr_metric_observations"."source" IN ('api','projects'))
);
--> statement-breakpoint
CREATE INDEX `idx_kr_metric_observations_owner_kr_time` ON `kr_metric_observations` (`owner_id`,`kr_item_id`,`observed_at`);

--> statement-breakpoint
CREATE TRIGGER kr_history_metric_insert AFTER INSERT ON kr_project_metrics WHEN (NEW.active=1) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','settings',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND (1);
END;

--> statement-breakpoint
CREATE TRIGGER kr_history_metric_update AFTER UPDATE OF starting_value,target_value,unit,active ON kr_project_metrics WHEN (NEW.active=1) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','settings',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND (1);
END;

--> statement-breakpoint
CREATE TRIGGER kr_history_contribution_insert AFTER INSERT ON project_contributions WHEN (NEW.applied=1) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','completed',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND (1);
END;

--> statement-breakpoint
CREATE TRIGGER kr_history_contribution_delete AFTER DELETE ON project_contributions WHEN (OLD.applied=1) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','adjusted',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=OLD.owner_id AND m.kr_item_id=OLD.kr_item_id AND m.active=1 AND (1);
END;

--> statement-breakpoint
CREATE TRIGGER kr_history_contribution_update AFTER UPDATE OF actual_value,applied,kr_item_id ON project_contributions WHEN (OLD.applied!=NEW.applied OR (OLD.applied=1 AND (OLD.actual_value IS NOT NEW.actual_value OR OLD.kr_item_id IS NOT NEW.kr_item_id))) AND NOT EXISTS(SELECT 1 FROM workspace_backup_guards) BEGIN
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','adjusted',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=OLD.owner_id AND m.kr_item_id=OLD.kr_item_id AND m.active=1 AND (OLD.applied=1 AND (NEW.applied=0 OR OLD.kr_item_id IS NOT NEW.kr_item_id));
INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) SELECT lower(hex(randomblob(16))),m.owner_id,m.kr_item_id,'projects','completed',
 m.starting_value+coalesce((SELECT sum(actual_value) FROM project_contributions c WHERE c.owner_id=m.owner_id AND c.kr_item_id=m.kr_item_id AND c.applied=1),0),
 0,m.target_value,m.unit,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM kr_project_metrics m
 WHERE m.owner_id=NEW.owner_id AND m.kr_item_id=NEW.kr_item_id AND m.active=1 AND (NEW.applied=1);
END;

--> statement-breakpoint
CREATE TRIGGER kr_history_target_guard BEFORE INSERT ON kr_metric_observations WHEN NOT EXISTS(SELECT 1 FROM items WHERE id=NEW.kr_item_id AND owner_id=NEW.owner_id AND kind='key_result') BEGIN SELECT RAISE(ABORT,'KR observation target constraint'); END;

--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_metric_observations_insert AFTER INSERT ON kr_metric_observations BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;

--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_metric_observations_update AFTER UPDATE ON kr_metric_observations BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id; END;

--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_metric_observations_delete AFTER DELETE ON kr_metric_observations BEGIN UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=OLD.owner_id; END;
