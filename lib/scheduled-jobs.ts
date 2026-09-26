import { syncDueKrDataConnectionsWithDb } from "@/lib/kr-data-sync";
import { runDueWorkspaceBackups } from "@/lib/workspace-backups";
import { runBillingBatch } from "@/lib/billing";
import { runDueSlackBotDeliveries } from "@/lib/slack-bot-delivery";
import { runDueTaskChanges } from "@/lib/slack-task-changes";
import { runDueDailyManualRuns } from "@/lib/slack-daily-manual";
import { runDueDailyDigests } from "@/lib/slack-daily-digest";
import { runDueWorkspaceManagementBots } from "@/lib/workspace-management-bot";
import { runDueSlackDailyReminders } from "@/lib/slack-daily";
import { runAndroidTestDailyReport } from "@/lib/android-test-feedback";

export type ScheduledRuntime = {
  DB: D1Database;
  WORKSPACE_AVATARS: R2Bucket;
  SLACK_TOKEN_ENCRYPTION_KEY?: string;
  ANDROID_TEST_FEEDBACK_SLACK_TEAM_ID?: string;
  ANDROID_TEST_FEEDBACK_SLACK_CHANNEL_NAME?: string;
  STORE_FEEDBACK_SLACK_TEAM_ID?: string;
};

export type ScheduledJobResult = {
  name: string;
  status: "fulfilled" | "rejected";
  error?: string;
};

/**
 * Runs the same maintenance work as the existing Cloudflare cron trigger.
 * The returned per-job status lets the self-hosted CronJob fail visibly without
 * abandoning unrelated queues when one integration is temporarily unavailable.
 */
export async function runScheduledJobs(runtime: ScheduledRuntime, scheduledAt = new Date()): Promise<ScheduledJobResult[]> {
  const jobs: Array<[string, Promise<unknown>]> = [
    ["slack_bot_deliveries", runDueSlackBotDeliveries(runtime.DB, scheduledAt)],
    ["slack_task_changes", runDueTaskChanges(runtime.DB)],
    ["daily_manual_runs", runDueDailyManualRuns(runtime.DB)],
    ["daily_digests", runDueDailyDigests(runtime.DB, scheduledAt)],
    ["android_test_daily_report", runAndroidTestDailyReport(runtime, scheduledAt)],
  ];

  if (scheduledAt.getUTCMinutes() % 15 === 0) {
    jobs.push(
      ["billing", runBillingBatch()],
      ["kr_data_sync", syncDueKrDataConnectionsWithDb(runtime.DB)],
      ["workspace_management_bots", runDueWorkspaceManagementBots(runtime.DB, scheduledAt)],
      ["workspace_backups", runDueWorkspaceBackups(runtime)],
      ["slack_daily_reminders", runDueSlackDailyReminders()],
    );
  }

  const settled = await Promise.allSettled(jobs.map(([, job]) => job));
  return settled.map((result, index) => result.status === "fulfilled"
    ? { name: jobs[index][0], status: "fulfilled" }
    : { name: jobs[index][0], status: "rejected", error: errorMessage(result.reason) });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown scheduled job failure";
}
