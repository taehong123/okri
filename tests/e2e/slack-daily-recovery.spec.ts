import { expect, test } from "@playwright/test";
import { installApiMocks } from "./api-mocks";
import AxeBuilder from "@axe-core/playwright";

test("daily settings save explicitly, cancel restores values, and saving never sends a test", async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  const writes: Record<string, unknown>[] = [];
  let fail = true;
  const admin = {
    connected: true, teamName: "팀 Slack", setupComplete: true, needsReauthorization: false,
    settings: { enabled: true, weekdays: [1, 2, 3, 4, 5], reminderTime: "09:00", timezone: "Asia/Seoul", installStatus: "connected", onboardingCompletedAt: "2026-09-02", lastError: "" },
    delivery: { status: "ready", targetCount: 1, scheduledCount: 1, pendingCount: 0, failedCount: 0 }, channels: [], failedPublications: [],
    members: [{ memberId: "member-1", displayName: "멤버", linked: true, preference: { enabled: true }, reminder: { status: "scheduled", postAt: Math.floor(Date.now() / 1000) + 86400, error: "" } }],
  };
  await page.route("**/api/slack/daily/settings", (route) => { expect(route.request().method()).toBe("GET"); return route.fulfill({ json: admin }); });
  await page.route("**/api/slack/onboarding", async (route) => {
    const payload = route.request().postDataJSON(); writes.push(payload);
    if (fail) return route.fulfill({ status: 500, json: { error: "mock failure" } });
    admin.settings.reminderTime = payload.reminderTime;
    return route.fulfill({ json: { admin, schedules: [{ status: "scheduled" }], tests: { dm: { status: "skipped" }, channels: [] } } });
  });
  await page.goto("/?settings=workspace&tab=integrations&bot=daily");
  await page.locator(".slack-connected-title").getByRole("button", { name: "설정", exact: true }).click();
  const panel = page.locator(".slack-onboarding-card");
  const input = panel.getByLabel("Slack 데일리 발송 시간", { exact: true });
  await input.fill("10:15");
  await expect(panel.getByRole("status")).toHaveText("저장하지 않은 변경사항");
  expect(writes).toEqual([]);
  await panel.getByRole("button", { name: "취소", exact: true }).click();
  await page.locator(".slack-connected-title").getByRole("button", { name: "설정", exact: true }).click();
  await expect(input).toHaveValue("09:00");
  await expect(panel.getByRole("button", { name: "변경사항 저장", exact: true })).toBeDisabled();
  await input.fill("10:15");
  await panel.getByRole("button", { name: "변경사항 저장", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(input).toHaveValue("10:15");
  fail = false;
  await panel.getByRole("button", { name: "변경사항 저장", exact: true }).click();
  await expect(page.locator(".slack-connected-title")).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ reminderTime: "10:15", memberIds: ["member-1"], channelIds: [] });
  expect(writes[1]).not.toHaveProperty("sendTests", true);
  await page.locator(".slack-connected-title").getByRole("button", { name: "설정", exact: true }).click();
  await expect(input).toHaveValue("10:15");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("daily-save.png") });
});

test("personal daily preferences stay local until saved", async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  const writes: unknown[] = [];
  let preference = { linked: true, enabled: true, reminderTime: "09:00", timezone: "Asia/Seoul" };
  await page.route("**/api/slack/daily/preferences", (route) => {
    if (route.request().method() === "PATCH") { const data = route.request().postDataJSON(); writes.push(data); preference = { ...preference, ...data }; }
    return route.fulfill({ json: preference });
  });
  await page.goto("/?view=integrations");
  const panel = page.locator(".slack-personal-preference");
  await expect(panel).toBeVisible();
  await panel.locator('input[type="time"]').fill("11:20");
  expect(writes).toEqual([]);
  await panel.getByRole("button", { name: "취소", exact: true }).click();
  await expect(panel.locator('input[type="time"]')).toHaveValue("09:00");
  await panel.locator('input[type="time"]').fill("11:20");
  await panel.getByRole("button", { name: "변경사항 저장", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("저장됨");
  expect(writes).toEqual([{ enabled: true, reminderTime: "11:20", timezone: "Asia/Seoul" }]);
});

for (const repairFails of [false, true]) {
test(`failed reservation remains visible until repair succeeds (${repairFails ? "failure" : "success"})`, async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  const writes: unknown[] = [];
  let repaired = false;
  const settings = { enabled: true, weekdays: [1, 2, 3, 4, 5], reminderTime: "09:00", timezone: "Asia/Seoul", installStatus: "connected", onboardingCompletedAt: "2026-09-02T00:00:00Z", lastSyncedAt: "2026-09-02T00:00:00Z", lastError: "Slack chat.scheduleMessage 요청에 실패했습니다 (invalid_blocks)." };
  await page.route("**/api/slack/daily/settings", async (route) => {
    if (route.request().method() === "PATCH") {
      writes.push(route.request().postDataJSON());
      if (repairFails) return route.fulfill({ status: 500, json: { error: "D1_ERROR: reservation lookup failed at worker.js:100" } });
      repaired = true;
    }
    return route.fulfill({ json: {
      connected: true, teamName: "팀 Slack", setupComplete: true, needsReauthorization: false,
      settings: { ...settings, lastError: repaired ? "" : settings.lastError },
      delivery: { status: repaired ? "ready" : "failed", targetCount: 1, scheduledCount: repaired ? 1 : 0, pendingCount: 0, failedCount: repaired ? 0 : 1 },
      channels: [], failedPublications: [],
      members: [{ memberId: "member-1", displayName: "긴 한글 이름의 테스트 구성원", email: "owner@example.com", linked: true, slackDisplayName: "멤버", preference: { enabled: true, reminderTime: null, timezone: null }, reminder: repaired ? { status: "scheduled", postAt: Math.floor(Date.now() / 1000) + 86_400, error: "" } : null }],
    } });
  });
  await page.goto("/?view=work&settings=workspace&tab=integrations&bot=daily");
  await expect(page.getByRole("alert").filter({ hasText: "데일리 발송 예약에 문제가 있습니다" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("다음 발송 예약을 확인하지 못했습니다.");
  await expect(page.locator("body")).not.toContainText("invalid_blocks");
  await expect(page.locator("body")).not.toContainText("chat.scheduleMessage");
  await expect(page.locator(".slack-connected-title")).toContainText("예약 실패");
  await expect(page.locator(".slack-connected-title")).not.toContainText("사용 중");
  await expect(page.getByRole("button", { name: "예약 복구", exact: true })).toBeEnabled();
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, font: getComputedStyle(document.querySelector(".slack-connected-title b")!).fontFamily }));
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.font).toMatch(/Pretendard/);
  await page.getByRole("button", { name: "예약 복구", exact: true }).focus();
  await page.keyboard.press("Enter");
  if (repairFails) {
    await expect(page.getByText("예약을 복구하지 못했습니다.", { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("D1_ERROR");
    await expect(page.locator(".slack-connected-title")).toContainText("예약 실패");
    await expect(page.getByRole("button", { name: "예약 복구", exact: true })).toBeEnabled();
    expect(writes).toEqual([{ action: "repair" }]);
    return;
  }
  await expect(page.locator(".slack-connected-title")).toContainText("사용 중");
  await expect(page.getByText("데일리 발송 예약에 문제가 있습니다")).toHaveCount(0);
  expect(writes).toEqual([{ action: "repair" }]);
});
}

test("an unlinked member never selected for daily delivery does not create a false failure", async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  await page.route("**/api/slack/daily/settings", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: {
      connected: true, teamName: "팀 Slack", setupComplete: true, needsReauthorization: false,
      settings: { enabled: true, weekdays: [1, 2, 3, 4, 5], reminderTime: "09:00", timezone: "Asia/Seoul", installStatus: "connected", onboardingCompletedAt: "2026-09-02T00:00:00Z", lastError: "" },
      channels: [], failedPublications: [],
      members: [
        { memberId: "member-1", displayName: "예약 대상", linked: true, preference: { enabled: true, configured: true }, reminder: { status: "scheduled", postAt: Math.floor(Date.now() / 1000) + 86_400, error: "" } },
        { memberId: "member-2", displayName: "미연결 구성원", linked: false, preference: { enabled: true, configured: false }, reminder: null },
      ],
    } });
  });
  await page.goto("/?view=work&settings=workspace&tab=integrations&bot=daily");
  await expect(page.locator(".slack-connected-title")).toContainText("사용 중");
  await expect(page.getByText("데일리 발송 예약에 문제가 있습니다")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "예약 복구", exact: true })).toHaveCount(0);
});

test("failed disconnect keeps the installation visible and allows retry", async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  let calls = 0;
  await page.route("**/api/slack/disconnect", async (route) => {
    calls += 1;
    expect(route.request().method()).toBe("POST");
    return route.fulfill({ status: 409, json: { error: "reservation cancellation pending" } });
  });
  await page.goto("/?view=work&settings=workspace&tab=integrations&bot=daily");
  await page.getByText("Slack 연결 관리", { exact: true }).click();
  const button = page.getByRole("button", { name: "Slack 연결 해제", exact: true });
  await button.click();
  await expect(page.getByText("Slack 연결을 해제하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(page.getByRole("button", { name: "Slack 연결", exact: true })).toHaveCount(0);
  expect(calls).toBe(1);
});

test("viewer cannot invoke reservation repair", async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", workspaceRole: "viewer", teamWorkspace: true });
  await page.goto("/?view=work&settings=workspace&tab=integrations&bot=daily");
  await expect(page.getByRole("dialog", { name: "워크스페이스 설정" })).toBeVisible();
  await expect(page.getByRole("button", { name: "예약 복구", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "지금 보내기", exact: true })).toHaveCount(0);
});

test("wide light/dark settings retain real fonts, contrast and 200% text", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "one sequential wide-screen check");
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  await page.setViewportSize({ width: 3840, height: 2160 });
  for (const theme of ["white", "dark"]) {
    await page.addInitScript((value) => localStorage.setItem("okri.theme", value), theme);
    await page.goto("/?view=work&settings=workspace&tab=integrations&bot=daily");
    await expect(page.locator(".slack-connected-title")).toBeVisible();
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.evaluate(() => document.fonts.ready);
    const client = await context.newCDPSession(page);
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const documentNode = await client.send("DOM.getDocument");
    const node = await client.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: ".slack-connected-title b" });
    const fonts = await client.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
    expect(fonts.fonts.some((font) => font.glyphCount > 0 && /Pretendard/.test(font.familyName))).toBeTruthy();
    await client.detach();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const result = await new AxeBuilder({ page: page as never }).include(".slack-one-button-flow").withRules(["color-contrast"]).analyze();
    expect(result.violations).toEqual([]);
  }
});
