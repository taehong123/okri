ALTER TABLE `slack_connections` ADD `encrypted_user_token` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `slack_connections` ADD `user_scope` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `slack_connections` ADD `authed_slack_user_id` text DEFAULT '' NOT NULL;
