ALTER TABLE `slack_daily_settings` ADD `summary_enabled` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `slack_daily_settings` ADD `summary_time` text DEFAULT '12:00' NOT NULL;
