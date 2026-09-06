import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installApiMocks } from "./api-mocks";

for (const theme of ["beige", "dark"]) {
  test(`daily summary defaults, explicit save, keyboard and layout (${theme})`, async ({ page }) => {
    await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
    await page.addInitScript((theme) => localStorage.setItem("okri.theme", theme), theme);
    const writes: Record<string, unknown>[] = [];
    const admin = {
      connected: true, setupComplete: true, needsReauthorization: false, teamName: "팀 Slack",
      settings: { enabled: true, weekdays: [1, 2, 3, 4, 5], reminderTime: "09:00", summaryEnabled: true, summaryTime: "12:00", timezone: "Asia/Seoul", installStatus: "connected", onboardingCompletedAt: "2026-09-01", lastError: "" },
      delivery: { status: "ready", targetCount: 1, scheduledCount: 1, pendingCount: 0, failedCount: 0 },
      channels: [{ id: "C-team", name: "daily", isPrivate: false }], failedPublications: [],
      members: [{ memberId: "member-1", displayName: "긴 이름을 가진 팀 구성원", linked: true, preference: { enabled: true }, reminder: { status: "scheduled", postAt: Math.floor(Date.now() / 1000) + 86400, error: "" } }],
    };
    await page.route("**/api/slack/daily/settings", (route) => { expect(route.request().method()).toBe("GET"); return route.fulfill({ json: admin }); });
    await page.route("**/api/slack/onboarding", async (route) => {
      const body = route.request().postDataJSON(); writes.push(body);
      Object.assign(admin.settings, { summaryEnabled: body.summaryEnabled, summaryTime: body.summaryTime });
      return route.fulfill({ json: { admin, schedules: [], tests: { dm: { status: "skipped" }, channels: [] } } });
    });
    await page.goto("/?settings=workspace&tab=integrations&bot=daily");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator(".daily-digest-summary")).toContainText("늦어도 12:00");
    await page.locator(".slack-connected-title").getByRole("button", { name: "설정", exact: true }).click();
    const panel = page.locator(".slack-onboarding-card");
    const toggle = panel.getByRole("checkbox", { name: "팀원·KR별 Task 요약 공유" });
    const time = panel.getByLabel("요약 공유 마감 시간", { exact: true });
    await expect(toggle).toBeChecked(); await expect(time).toHaveValue("12:00");
    await toggle.focus(); await page.keyboard.press("Space");
    await expect(time).toHaveCount(0); expect(writes).toHaveLength(0);
    await panel.getByRole("button", { name: "변경사항 저장", exact: true }).click();
    await expect(page.locator(".daily-digest-summary")).toContainText("꺼짐");
    expect(writes[0]).toMatchObject({ summaryEnabled: false, summaryTime: "12:00" });
    await page.locator(".slack-connected-title").getByRole("button", { name: "설정", exact: true }).click();
    await toggle.check(); await time.fill("13:30");
    await panel.getByRole("button", { name: "변경사항 저장", exact: true }).click();
    await expect(page.locator(".daily-digest-summary")).toContainText("늦어도 13:30");
    await page.reload();
    await expect(page.locator(".daily-digest-summary")).toContainText("늦어도 13:30");
    await page.locator(".slack-connected-title").getByRole("button", { name: "설정", exact: true }).click();
    expect(await page.locator(".daily-digest-toggle").evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Pretendard");
    const audit = await new AxeBuilder({ page: page as never }).include(".daily-digest-settings").analyze();
    expect(audit.violations).toEqual([]);
    await page.locator(".daily-digest-settings").screenshot({ path: test.info().outputPath(`daily-digest-${theme}.png`) });
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const bounds = await page.locator(".daily-digest-settings").evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(bounds.scrollWidth - bounds.width).toBeLessThanOrEqual(1);
    await page.locator(".daily-digest-settings").screenshot({ path: test.info().outputPath(`daily-digest-${theme}-zoom.png`) });
  });
}
