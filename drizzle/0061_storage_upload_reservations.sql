CREATE TABLE `storage_upload_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`byte_size` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "storage_upload_reservations_positive_size" CHECK("storage_upload_reservations"."byte_size" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_storage_upload_reservations_workspace_expiry` ON `storage_upload_reservations` (`workspace_id`,`expires_at`);