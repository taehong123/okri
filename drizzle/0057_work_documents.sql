ALTER TABLE `routines` ADD `document_content` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `routines` ADD `document_plain_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `routines` ADD `document_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `routines` ADD `document_updated_at` text;