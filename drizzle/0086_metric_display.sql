CREATE TABLE `kr_metric_display_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kr_item_id` text NOT NULL,
	`mode` text NOT NULL,
	`increment` real,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kr_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "kr_metric_display_id" CHECK("kr_metric_display_settings"."id" = "kr_metric_display_settings"."kr_item_id"),
	CONSTRAINT "kr_metric_display_revision" CHECK("kr_metric_display_settings"."revision" > 0),
	CONSTRAINT "kr_metric_display_mode" CHECK(("kr_metric_display_settings"."mode" in ('default','exact') and "kr_metric_display_settings"."increment" is null) or
    ("kr_metric_display_settings"."mode" = 'increment' and "kr_metric_display_settings"."increment" is not null and "kr_metric_display_settings"."increment" between 0.000001 and 1000000000000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kr_metric_display_item` ON `kr_metric_display_settings` (`kr_item_id`);--> statement-breakpoint
CREATE INDEX `idx_kr_metric_display_owner` ON `kr_metric_display_settings` (`owner_id`);
--> statement-breakpoint
CREATE TRIGGER kr_metric_display_target_insert BEFORE INSERT ON kr_metric_display_settings
WHEN NOT EXISTS (SELECT 1 FROM items WHERE id=NEW.kr_item_id AND owner_id=NEW.owner_id AND kind='key_result')
BEGIN
  SELECT RAISE(ABORT,'metric display target constraint');
END;
--> statement-breakpoint
CREATE TRIGGER kr_metric_display_target_update BEFORE UPDATE OF owner_id,kr_item_id ON kr_metric_display_settings
WHEN NOT EXISTS (SELECT 1 FROM items WHERE id=NEW.kr_item_id AND owner_id=NEW.owner_id AND kind='key_result')
BEGIN
  SELECT RAISE(ABORT,'metric display target constraint');
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_metric_display_settings_insert AFTER INSERT ON kr_metric_display_settings
BEGIN
  UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_metric_display_settings_update AFTER UPDATE ON kr_metric_display_settings
BEGIN
  UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=NEW.owner_id;
END;
--> statement-breakpoint
CREATE TRIGGER backup_revision_kr_metric_display_settings_delete AFTER DELETE ON kr_metric_display_settings
BEGIN
  UPDATE workspace_backup_state SET revision=revision+1 WHERE owner_id=OLD.owner_id;
END;
