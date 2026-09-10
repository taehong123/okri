CREATE TABLE `document_image_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`byte_size` integer NOT NULL,
	`object_key` text NOT NULL,
	`created_by_user_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "document_image_assets_target_kind" CHECK("document_image_assets"."target_kind" IN ('project', 'task', 'routine')),
	CONSTRAINT "document_image_assets_positive_size" CHECK("document_image_assets"."byte_size" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_document_image_assets_object_key` ON `document_image_assets` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_document_image_assets_workspace_created` ON `document_image_assets` (`workspace_id`,`created_at`);