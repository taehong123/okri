CREATE TABLE `notification_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`platform` text NOT NULL,
	`app_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`encrypted_token` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`environment` text DEFAULT 'production' NOT NULL,
	`disabled_at` text,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_devices_token_hash` ON `notification_devices` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `notification_devices_user_active` ON `notification_devices` (`user_id`,`disabled_at`);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`assignment_push` integer DEFAULT true NOT NULL,
	`morning_brief_push` integer DEFAULT true NOT NULL,
	`digest_hour` integer DEFAULT 9 NOT NULL,
	`timezone` text DEFAULT 'Asia/Seoul' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "notification_preferences_digest_hour" CHECK(`digest_hour` BETWEEN 0 AND 23)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_workspace_user` ON `notification_preferences` (`workspace_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `notification_preferences_digest` ON `notification_preferences` (`morning_brief_push`,`digest_hour`);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`member_id` text REFERENCES `workspace_members`(`id`) ON DELETE SET NULL,
	`item_id` text REFERENCES `items`(`id`) ON DELETE SET NULL,
	`kind` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`dedupe_key` text NOT NULL,
	`read_at` text,
	`push_after` text,
	`push_sent_at` text,
	`push_attempts` integer DEFAULT 0 NOT NULL,
	`push_last_error_code` text,
	`created_at` text NOT NULL,
	CONSTRAINT "notifications_payload_json" CHECK(json_valid(`payload_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_user_dedupe` ON `notifications` (`user_id`,`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `notifications_workspace_user_created` ON `notifications` (`workspace_id`,`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `notifications_push_pending` ON `notifications` (`push_sent_at`,`push_after`,`push_attempts`);
