CREATE TABLE `project_images` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`object_key` text NOT NULL,
	`source` text DEFAULT 'slack' NOT NULL,
	`source_ref` text NOT NULL,
	`created_by_user_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_images_object_key` ON `project_images` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_images_source` ON `project_images` (`owner_id`,`project_id`,`source`,`source_ref`);--> statement-breakpoint
CREATE INDEX `idx_project_images_project_created` ON `project_images` (`owner_id`,`project_id`,`created_at`);
