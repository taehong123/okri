CREATE TABLE `store_review_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`state` text NOT NULL DEFAULT '',
	`delivery_status` text NOT NULL DEFAULT 'received',
	`attempts` integer NOT NULL DEFAULT 1,
	`received_at` text NOT NULL,
	`occurred_at` text NOT NULL,
	`delivered_at` text,
	`last_error` text NOT NULL DEFAULT '',
	CONSTRAINT "store_review_feedback_source" CHECK("store_review_feedback"."source" IN ('apple', 'google_play')),
	CONSTRAINT "store_review_feedback_delivery" CHECK("store_review_feedback"."delivery_status" IN ('received', 'delivered', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_store_review_feedback_source_event` ON `store_review_feedback` (`source`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `idx_store_review_feedback_delivery` ON `store_review_feedback` (`delivery_status`,`received_at`);
