CREATE TABLE `android_test_daily_reports` (
	`report_date` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`summary_json` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	`last_error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_android_test_daily_reports_status` ON `android_test_daily_reports` (`status`,`report_date`);
--> statement-breakpoint
CREATE TABLE `android_test_signups` (
	`id` text PRIMARY KEY NOT NULL,
	`email_normalized` text NOT NULL,
	`encrypted_phone` text NOT NULL,
	`phone_last_four` text NOT NULL,
	`access_token_hash` text NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	`consent_version` text NOT NULL,
	`consent_accepted_at` text NOT NULL,
	`first_applied_at` text NOT NULL,
	`last_applied_at` text NOT NULL,
	`invited_at` text,
	`opted_in_at` text,
	`eligible_at` text,
	`rewarded_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_android_test_signups_email` ON `android_test_signups` (`email_normalized`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_android_test_signups_access_token` ON `android_test_signups` (`access_token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_android_test_signups_status` ON `android_test_signups` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `android_test_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`signup_id` text NOT NULL,
	`message` text NOT NULL,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`slack_message_ts` text,
	`created_at` text NOT NULL,
	`delivered_at` text,
	`last_error` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`signup_id`) REFERENCES `android_test_signups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_android_test_feedback_signup` ON `android_test_feedback` (`signup_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_android_test_feedback_delivery` ON `android_test_feedback` (`delivery_status`,`created_at`);
