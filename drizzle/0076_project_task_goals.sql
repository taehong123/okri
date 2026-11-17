CREATE TABLE `project_task_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`target_count` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_task_goal_target" CHECK("project_task_goals"."target_count" BETWEEN 1 AND 1000000 AND typeof("project_task_goals"."target_count") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_task_goals_owner_project` ON `project_task_goals` (`owner_id`,`project_id`);
--> statement-breakpoint
CREATE TRIGGER project_task_goal_insert AFTER INSERT ON project_task_goals BEGIN
  UPDATE items SET progress = min(100, CAST(round(100.0 * (SELECT count(*) FROM items t WHERE t.owner_id = items.owner_id AND t.parent_id = items.id AND t.kind = 'task' AND t.status IN ('done','development_done') AND t.archived_at IS NULL) / (SELECT target_count FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id)) AS INTEGER)), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind = 'project' AND (items.owner_id = NEW.owner_id AND items.id = NEW.project_id) AND EXISTS (SELECT 1 FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id);
END;
--> statement-breakpoint
CREATE TRIGGER project_task_goal_update AFTER UPDATE OF target_count ON project_task_goals BEGIN
  UPDATE items SET progress = min(100, CAST(round(100.0 * (SELECT count(*) FROM items t WHERE t.owner_id = items.owner_id AND t.parent_id = items.id AND t.kind = 'task' AND t.status IN ('done','development_done') AND t.archived_at IS NULL) / (SELECT target_count FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id)) AS INTEGER)), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind = 'project' AND (items.owner_id = NEW.owner_id AND items.id = NEW.project_id) AND EXISTS (SELECT 1 FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id);
END;
--> statement-breakpoint
CREATE TRIGGER project_task_goal_task_insert AFTER INSERT ON items WHEN NEW.kind = 'task' BEGIN
  UPDATE items SET progress = min(100, CAST(round(100.0 * (SELECT count(*) FROM items t WHERE t.owner_id = items.owner_id AND t.parent_id = items.id AND t.kind = 'task' AND t.status IN ('done','development_done') AND t.archived_at IS NULL) / (SELECT target_count FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id)) AS INTEGER)), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind = 'project' AND (items.owner_id = NEW.owner_id AND items.id = NEW.parent_id) AND EXISTS (SELECT 1 FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id);
END;
--> statement-breakpoint
CREATE TRIGGER project_task_goal_task_update AFTER UPDATE OF status, parent_id, owner_id, archived_at, kind ON items WHEN OLD.kind = 'task' OR NEW.kind = 'task' BEGIN
  UPDATE items SET progress = min(100, CAST(round(100.0 * (SELECT count(*) FROM items t WHERE t.owner_id = items.owner_id AND t.parent_id = items.id AND t.kind = 'task' AND t.status IN ('done','development_done') AND t.archived_at IS NULL) / (SELECT target_count FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id)) AS INTEGER)), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind = 'project' AND ((items.owner_id = OLD.owner_id AND items.id = OLD.parent_id) OR (items.owner_id = NEW.owner_id AND items.id = NEW.parent_id)) AND EXISTS (SELECT 1 FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id);
END;
--> statement-breakpoint
CREATE TRIGGER project_task_goal_task_delete AFTER DELETE ON items WHEN OLD.kind = 'task' BEGIN
  UPDATE items SET progress = min(100, CAST(round(100.0 * (SELECT count(*) FROM items t WHERE t.owner_id = items.owner_id AND t.parent_id = items.id AND t.kind = 'task' AND t.status IN ('done','development_done') AND t.archived_at IS NULL) / (SELECT target_count FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id)) AS INTEGER)), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind = 'project' AND (items.owner_id = OLD.owner_id AND items.id = OLD.parent_id) AND EXISTS (SELECT 1 FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id);
END;
--> statement-breakpoint
CREATE TRIGGER project_task_goal_progress AFTER UPDATE OF progress ON items WHEN NEW.kind = 'project' AND EXISTS (SELECT 1 FROM project_task_goals g WHERE g.owner_id = NEW.owner_id AND g.project_id = NEW.id) AND NEW.progress != (SELECT min(100, CAST(round(100.0 * (SELECT count(*) FROM items t WHERE t.owner_id = items.owner_id AND t.parent_id = items.id AND t.kind = 'task' AND t.status IN ('done','development_done') AND t.archived_at IS NULL) / (SELECT target_count FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id)) AS INTEGER)) FROM items WHERE id = NEW.id) BEGIN
  UPDATE items SET progress = min(100, CAST(round(100.0 * (SELECT count(*) FROM items t WHERE t.owner_id = items.owner_id AND t.parent_id = items.id AND t.kind = 'task' AND t.status IN ('done','development_done') AND t.archived_at IS NULL) / (SELECT target_count FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id)) AS INTEGER)), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind = 'project' AND (items.owner_id = NEW.owner_id AND items.id = NEW.id) AND EXISTS (SELECT 1 FROM project_task_goals g WHERE g.owner_id = items.owner_id AND g.project_id = items.id);
END;
--> statement-breakpoint
CREATE TRIGGER project_task_goal_guard_insert BEFORE INSERT ON project_task_goals WHEN NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.project_id AND owner_id = NEW.owner_id AND kind = 'project') OR EXISTS (SELECT 1 FROM kr_data_connections WHERE owner_id = NEW.owner_id AND kr_item_id = NEW.project_id) BEGIN
  SELECT RAISE(ABORT, 'Project completion goal conflicts with target or API connection constraint');
END;
--> statement-breakpoint
CREATE TRIGGER project_task_goal_guard_update BEFORE UPDATE OF owner_id, project_id ON project_task_goals WHEN NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.project_id AND owner_id = NEW.owner_id AND kind = 'project') OR EXISTS (SELECT 1 FROM kr_data_connections WHERE owner_id = NEW.owner_id AND kr_item_id = NEW.project_id) BEGIN
  SELECT RAISE(ABORT, 'Project completion goal conflicts with target or API connection constraint');
END;
--> statement-breakpoint
CREATE TRIGGER project_task_goal_api_guard_insert BEFORE INSERT ON kr_data_connections WHEN EXISTS (SELECT 1 FROM project_task_goals WHERE owner_id = NEW.owner_id AND project_id = NEW.kr_item_id) BEGIN
  SELECT RAISE(ABORT, 'API connection conflicts with Project completion goal constraint');
END;
--> statement-breakpoint
CREATE TRIGGER project_task_goal_api_guard_update BEFORE UPDATE OF owner_id, kr_item_id ON kr_data_connections WHEN EXISTS (SELECT 1 FROM project_task_goals WHERE owner_id = NEW.owner_id AND project_id = NEW.kr_item_id) BEGIN
  SELECT RAISE(ABORT, 'API connection conflicts with Project completion goal constraint');
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_project_task_goals_insert AFTER INSERT ON project_task_goals BEGIN
  UPDATE workspace_backup_state SET revision = revision + 1 WHERE owner_id = NEW.owner_id;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_project_task_goals_update AFTER UPDATE ON project_task_goals BEGIN
  UPDATE workspace_backup_state SET revision = revision + 1 WHERE owner_id = NEW.owner_id;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_project_task_goals_delete AFTER DELETE ON project_task_goals BEGIN
  UPDATE workspace_backup_state SET revision = revision + 1 WHERE owner_id = OLD.owner_id;
END;
