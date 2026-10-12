import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootstrap, installApiMocks } from "./api-mocks";

test("shared calendar events stay separate from Tasks and fit five languages, themes and enlarged text", async ({ page, context }, testInfo) => {
  test.setTimeout(150_000);
  await installApiMocks(page, { teamWorkspace: true });
  let language = "ko";
  const title = "고객사와 신규 서비스 출시 일정과 다음 분기 협업 계획을 함께 검토하는 긴 미팅 123";
  const writes: string[] = [];
  const date = "2026-09-04";
  const calendarEvents = [
    { key: "gcal:" + "a".repeat(64), title, start: date + "T01:00:00Z", end: date + "T02:00:00Z", allDay: false, timezone: "Asia/Seoul" },
    { key: "gcal:" + "b".repeat(64), title: "워크숍", start: date, end: "2026-09-05", allDay: true, timezone: "Asia/Seoul" },
  ];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    if (path === "/api/bootstrap") return route.fulfill({ json: { ...bootstrap, user: { ...bootstrap.user, preferences: { language, resolvedLanguage: language, revision: 1 } } } });
    if (path === "/api/daily-scrum") {
      expect(route.request().method()).toBe("GET");
      const submission = { id: "submission", memberId: "member-1", memberName: "테스트 사용자", memberEmail: "owner@example.test", date, version: 1,
        calendarEvents, mustDoWorkIds: [], yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: true, source: "slack", submittedAt: date + "T03:00:00Z", tasks: [], yesterdayWork: [], work: [] };
      return route.fulfill({ json: { date, member: { id: "member-1", displayName: "테스트 사용자", role: "owner" },
        draft: { id: "draft", date, calendarEvents, yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: true, selectedTaskIds: [], selectedWorkIds: [], selectedYesterdayWorkIds: [] },
        candidates: { work: [], yesterdayWork: [], tasks: [], groups: [] }, createTargets: { projects: [], routines: [], allowGeneral: false }, latestSubmission: submission,
        team: [{ memberId: "member-1", displayName: "테스트 사용자", status: "submitted", slackConnected: true, submission }], legacyWorkspaceNote: null } });
    }
    return route.fallback();
  });
  const labels = { ko: ["오늘 일정", "종일"], en: ["Today's schedule", "All day"], ja: ["今日の予定", "終日"], zh: ["今日日程", "全天"], es: ["Agenda de hoy", "Todo el día"] };
  for (const theme of ["white", "dark"]) {
    await page.addInitScript((value) => localStorage.setItem("okri.theme", value), theme);
    for (const [id, [heading, allDay]] of Object.entries(labels)) {
      language = id;
      await page.goto("/?view=scrum");
      const summary = page.locator(".daily-submission-summary");
      const events = summary.getByRole("list", { name: heading, exact: true });
      await expect(events).toBeVisible(); await expect(events.getByRole("listitem")).toHaveCount(2);
      await expect(events).toContainText("10:00 - 11:00"); await expect(events).toContainText(allDay);
      await expect(events).toContainText(title); await expect(events.getByRole("button")).toHaveCount(0);
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      const eventTitle = events.locator(".daily-calendar-title").first();
      expect(await eventTitle.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await expect(eventTitle).toHaveCSS("font-weight", "400");
      await page.screenshot({ path: testInfo.outputPath(`daily-calendar-${theme}-${id}.png`), fullPage: true });
      const a11y = await new AxeBuilder({ page }).include(".daily-submission-summary").analyze();
      expect(a11y.violations).toEqual([]);
      if (id === "ko") {
        await page.evaluate(() => document.fonts.ready);
        const client = await context.newCDPSession(page);
        await client.send("DOM.enable"); await client.send("CSS.enable");
        const doc = await client.send("DOM.getDocument");
        const node = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: ".daily-calendar-title" });
        const fonts = await client.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
        expect(fonts.fonts.filter((font) => font.glyphCount > 0).every((font) => /Pretendard/.test(font.familyName))).toBeTruthy();
        await client.detach();
      }
      await page.keyboard.press("Escape");
    }
  }
  // The shared fixture also mocks the account-level onboarding notice claim.
  expect(writes.filter((path) => path !== "/api/account/marketing-consent")).toEqual([]);
});
