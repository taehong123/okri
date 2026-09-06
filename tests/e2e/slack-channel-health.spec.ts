import { expect, test } from "@playwright/test";
import { installApiMocks } from "./api-mocks";

test("Slack channel selectors refresh on focus and label every supported channel kind", async ({ page }) => {
  await installApiMocks(page, { slackState: "setup_required", slackSetupComplete: false, teamWorkspace: true });
  let channelRevision = 1;
  let channelReads = 0;
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.startsWith("/api/slack/")) writes.push(`${request.method()} ${path}`);
  });
  await page.route("**/api/slack/channels**", (route) => {
    channelReads += 1;
    const channels = channelRevision === 1
      ? [
        { id: "C-public", name: "announcements", isPrivate: false, isMember: false, isShared: false, isExternal: false },
        { id: "G-private", name: "leadership", isPrivate: true, isMember: true, isShared: false, isExternal: false },
      ]
      : [
        { id: "C-connect", name: "partner", isPrivate: false, isMember: true, isShared: true, isExternal: true },
        { id: "C-org", name: "company", isPrivate: false, isMember: true, isShared: true, isExternal: false },
      ];
    return route.fulfill({ json: { channels, observedAt: "2026-09-04T00:00:00.000Z" } });
  });

  await page.goto("/?settings=workspace&tab=integrations&bot=daily&slack=setup_required");
  await expect(page.getByText("#announcements", { exact: true })).toBeVisible();
  await expect(page.getByText("공개 · 선택 시 참여", { exact: true })).toBeVisible();
  await expect(page.getByText("비공개 · 봇 참여 중", { exact: true })).toBeVisible();
  await expect(page.locator(".slack-channel-sync").getByRole("button", { name: "새로고침", exact: true })).toBeVisible();

  channelRevision = 2;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("#partner", { exact: true })).toBeVisible();
  await expect(page.getByText("Slack Connect · 봇 참여 중", { exact: true })).toBeVisible();
  await expect(page.getByText("조직 공유 · 봇 참여 중", { exact: true })).toBeVisible();
  expect(channelReads).toBeGreaterThanOrEqual(2);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test("management failure stays visible outside advanced settings without sending a message", async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  const writes: string[] = [];
  await page.route("**/api/workspace-management-bot**", (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().method());
    return route.fulfill({ json: { slackConnected: true, channels: [{ id: "C-ops", name: "operations", isPrivate: false, isMember: true }], settings: {
      enabled: true, weekdays: [1, 2, 3, 4, 5], reportTime: "09:00", timezone: "Asia/Seoul", channelId: "C-ops", channelName: "operations",
      signals: ["missing_owner"], lastSentDate: null, lastSentAt: null, updatedAt: "2026-09-03T01:00:00Z",
      lastError: "Slack 전송 결과를 확인하지 못했습니다. 중복 방지를 위해 자동 재발송하지 않습니다.",
    } } });
  });
  await page.goto("/?view=work&settings=workspace&tab=integrations&bot=management");
  await expect(page.getByRole("alert").filter({ hasText: "관리 봇 전송 확인이 필요합니다" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("중복 발송을 막기 위해 재발송을 보류했습니다.");
  await expect(page.locator(".workspace-management-pane .bot-advanced-settings")).not.toHaveAttribute("open");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(writes).toEqual([]);
});

test("automation exposes failed and pending delivery and Viewer cannot send or modify", async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true, workspaceRole: "viewer" });
  await page.route("**/api/slack/automations", (route) => route.fulfill({ json: {
    automations: ["failed", "pending"].map((state, index) => ({ id: `rule-${index}`, name: index ? "대기 중인 자동화" : "실패한 자동화",
      triggerType: "task_created", triggerStatus: "", channelId: "C-ops", messageTemplate: "업무 알림", active: true,
      lastTriggeredAt: "2026-09-03T01:00:00Z", lastDeliveryStatus: state, lastError: index ? "" : "missing_scope: chat:write; request_id=internal-id",
      createdAt: "2026-09-03T01:00:00Z", updatedAt: "2026-09-03T01:00:00Z" })), deliveries: [], canManage: false,
  } }));
  await page.goto("/?view=work&settings=workspace&tab=integrations&bot=automation");
  await expect(page.getByText(/Slack 연결 권한을 갱신해 주세요/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("missing_scope");
  await expect(page.locator("body")).not.toContainText("request_id");
  await expect(page.getByText("발송 처리 중", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "테스트 보내기", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "직접 규칙 만들기", exact: true })).toHaveCount(0);
});
