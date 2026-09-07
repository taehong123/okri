CREATE TABLE IF NOT EXISTS `slack_daily_checklists` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `member_id` text NOT NULL REFERENCES `workspace_members`(`id`) ON DELETE CASCADE,
  `payload_json` text NOT NULL CHECK (json_valid(`payload_json`)),
  `revision` integer DEFAULT 0 NOT NULL,
  `expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_slack_daily_checklists_expiry` ON `slack_daily_checklists` (`expires_at`);
