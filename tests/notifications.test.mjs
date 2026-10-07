import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");

test("notification storage is workspace scoped, deduplicated, encrypted and retryable", async () => {
  const migration = await read("drizzle/0071_notifications.sql");
  assert.match(migration, /REFERENCES `workspaces`\(`id`\) ON DELETE CASCADE/);
  assert.match(migration, /notification_devices_token_hash/);
  assert.match(migration, /notifications_user_dedupe/);
  assert.match(migration, /push_attempts/);
  assert.match(migration, /CHECK\(json_valid\(`payload_json`\)\)/);
  assert.ok(!migration.includes("\r"));
  const service = await read("lib/notifications.ts");
  assert.match(service, /encryptPrivateValue\(input\.token/);
  assert.match(service, /decryptPrivateValue\(device\.encryptedToken/);
  assert.doesNotMatch(service, /console\.(?:log|error)\([^\n]*(?:token|payloadJson)/i);
});

test("all assignment entry points share durable notification creation without blocking push delivery", async () => {
  const pace = await read("lib/pace-data.ts");
  assert.match(pace, /export async function replaceItemAssignmentRole/);
  assert.match(pace, /await enqueueAssignmentNotifications/);
  assert.match(pace, /assignment_notification_enqueue_failed/);
  assert.match(await read("worker/index.ts"), /runPendingNotificationPushes/);
  assert.match(await read("lib/scheduled-jobs.ts"), /\["notifications", runNotificationJobs/);
});

test("native notification API is additive and guarded by the v1 adapter", async () => {
  for (const endpoint of ["notifications", "notifications/preferences", "notifications/devices"]) {
    assert.match(await read(`app/api/mobile/v1/${endpoint}/route.ts`), /mobileV1\(/);
  }
  const contract = await read("lib/mobile/v1-contract.ts");
  assert.match(contract, /GET notifications/);
  assert.match(contract, /POST notifications\/devices/);
  assert.match(contract, /assignmentPush/);
});
