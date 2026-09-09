CREATE TABLE `local_agent_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT 'unknown' NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_local_agent_devices_token_hash` ON `local_agent_devices` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_devices_account` ON `local_agent_devices` (`workspace_id`,`user_id`,`revoked_at`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_devices_last_seen` ON `local_agent_devices` (`last_seen_at`);
--> statement-breakpoint
CREATE TABLE `local_agent_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`claimed_at` text,
	`device_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_local_agent_pairings_code_hash` ON `local_agent_pairings` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_pairings_account` ON `local_agent_pairings` (`workspace_id`,`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_pairings_expiry` ON `local_agent_pairings` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `local_agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text,
	`target_kind` text NOT NULL CHECK (`target_kind` IN ('task', 'project')),
	`target_id` text NOT NULL,
	`target_title` text NOT NULL,
	`instruction` text NOT NULL,
	`context_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL CHECK (`status` IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
	`lease_id` text,
	`lease_expires_at` text,
	`progress_text` text,
	`result_text` text,
	`error_text` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `local_agent_devices`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_jobs_account` ON `local_agent_jobs` (`workspace_id`,`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_jobs_device_status` ON `local_agent_jobs` (`device_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_jobs_target` ON `local_agent_jobs` (`workspace_id`,`target_kind`,`target_id`,`created_at`);
