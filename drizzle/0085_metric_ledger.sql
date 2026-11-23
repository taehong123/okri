CREATE TABLE `kr_metric_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kr_item_id` text NOT NULL,
	`occurred_on` text NOT NULL,
	`payload` text NOT NULL,
	`posted_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kr_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "kr_metric_occurrence_json" CHECK(json_valid("kr_metric_occurrences"."payload"))
);
--> statement-breakpoint
CREATE INDEX `idx_kr_metric_occurrences_date` ON `kr_metric_occurrences` (`owner_id`,`kr_item_id`,`occurred_on`);--> statement-breakpoint
CREATE TABLE `kr_metric_rollup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kr_item_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`result_json` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kr_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "kr_metric_rollup_run_json" CHECK(json_valid("kr_metric_rollup_runs"."result_json"))
);
--> statement-breakpoint
CREATE INDEX `idx_kr_metric_rollup_runs_time` ON `kr_metric_rollup_runs` (`owner_id`,`kr_item_id`,`recorded_at`,`id`);--> statement-breakpoint
CREATE TABLE `kr_metric_rollup_state` (
	`kr_item_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`generation` text NOT NULL,
	`signature` text NOT NULL,
	`through_date` text NOT NULL,
	`last_success_at` text NOT NULL,
	`last_scheduled_at` text,
	FOREIGN KEY (`kr_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_operation_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`request_id` text NOT NULL,
	`effective_date` text NOT NULL,
	`recorded_at` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text NOT NULL,
	`value_json` text NOT NULL,
	`receipt_json` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_operations_revision" CHECK("project_operation_versions"."revision" > 0),
	CONSTRAINT "project_operations_json" CHECK(json_valid("project_operation_versions"."value_json") and json_valid("project_operation_versions"."receipt_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_operations_revision` ON `project_operation_versions` (`owner_id`,`project_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_operations_request` ON `project_operation_versions` (`owner_id`,`project_id`,`request_id`);--> statement-breakpoint
CREATE TRIGGER backup_revision_project_operation_versions_insert AFTER INSERT ON project_operation_versions
BEGIN
  UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_project_operation_versions_update AFTER UPDATE ON project_operation_versions
BEGIN
  UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_project_operation_versions_delete AFTER DELETE ON project_operation_versions
BEGIN
  UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=OLD.owner_id;
END;
--> statement-breakpoint
ALTER TABLE kr_metric_observations ADD COLUMN numerator real;
--> statement-breakpoint
ALTER TABLE kr_metric_observations ADD COLUMN denominator real;
--> statement-breakpoint
ALTER TABLE kr_metric_observations ADD COLUMN snapshot_key text;
