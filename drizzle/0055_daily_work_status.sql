ALTER TABLE `daily_scrums` ADD `work_status` text DEFAULT 'office' NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_submissions` ADD `work_status` text DEFAULT 'office' NOT NULL;--> statement-breakpoint
ALTER TABLE `slack_daily_settings` ADD `work_statuses` text DEFAULT '["office","remote","skip"]' NOT NULL;
