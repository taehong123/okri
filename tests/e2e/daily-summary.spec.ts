import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootstrap, installApiMocks } from "./api-mocks";

test("daily summaries merge completed work in five languages with keyboard access and responsive text", async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  await installApiMocks(page, { teamWorkspace: true });
  let language = "ko";
  let completionOnly = false;
  let theme = "white";
  const doneTitle = "완료한 고객 인터뷰를 정리하고 다음 단계에 필요한 긴 결과 문서를 검토한 업무 123";
  const makeWork = (id: string, title: string, completedToday = false) => ({ id, key: `task:${id}`, kind: "task", title, parentTitle: "고객 경험 개선 Project", status: completedToday ? "done" : "todo", completedToday });
  const writes: string[] = [];
  await page.addInitScript(() => localStorage.setItem("okri.theme", "white"));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    if (path === "/api/bootstrap") return route.fulfill({ json: { ...bootstrap, user: { ...bootstrap.user, preferences: { language, resolvedLanguage: language, revision: 1 } } } });
    if (path === "/api/daily-scrum") {
      expect(route.request().method()).toBe("GET");
      const date = "2026-09-05";
      const submission = { id: "submission", memberId: "member-1", memberName: "테스트 사용자", memberEmail: "owner@example.test", date, version: 1, yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: completionOnly, source: "slack", submittedAt: date + "T01:00:00Z", tasks: [], yesterdayWork: [makeWork("previous", "어제 마친 업무")], work: [makeWork("task-1", doneTitle, true), ...(completionOnly ? [] : [makeWork("planned", "앞으로 할 업무")])] };
      return route.fulfill({ json: { date, member: { id: "member-1", displayName: "테스트 사용자", role: "owner" }, draft: { id: "draft", date, yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: true, selectedTaskIds: [], selectedWorkIds: [], selectedYesterdayWorkIds: [] }, candidates: { work: [], yesterdayWork: [], tasks: [], groups: [] }, createTargets: { projects: [], routines: [], allowGeneral: false }, latestSubmission: submission, team: [{ memberId: "member-1", displayName: "테스트 사용자", status: "submitted", slackConnected: true, submission }], legacyWorkspaceNote: null } });
    }
    return route.fallback();
  });
  const labels = {
    ko: ["완료한 일", "오늘 할 일"],
    en: ["Completed work", "Today’s tasks"],
    ja: ["完了した仕事", "今日のタスク"],
    zh: ["已完成的工作", "今日任务"],
    es: ["Trabajo completado", "Tareas de hoy"],
  };
  for (const [id, headings] of Object.entries(labels)) {
    language = id;
    await page.goto("/?view=scrum");
    const summary = page.locator(".daily-submission-summary");
    await expect(summary).toBeVisible();
    const lists = summary.getByRole("list");
    await expect(lists).toHaveCount(2);
    for (let i = 0; i < headings.length; i++) await expect(lists.nth(i)).toHaveAccessibleName(headings[i]);
    await expect(lists.nth(0)).toContainText("어제 마친 업무");
    await expect(lists.nth(0)).toContainText(doneTitle);
    await expect(lists.nth(1)).toContainText("앞으로 할 업무");
    await expect(lists.nth(1)).not.toContainText(doneTitle);
    const completed = lists.nth(0).getByRole("button", { name: doneTitle });
    expect(await completed.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect(completed).toHaveCSS("white-space", "normal");
    await completed.focus();
    await expect(completed).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(lists.nth(1).getByRole("button")).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`daily-summary-${id}.png`), fullPage: true });
  }
  if (testInfo.project.name === "desktop-chromium") {
    language = "ko";
    completionOnly = true;
    for (theme of ["white", "dark"]) {
      await page.addInitScript((value) => localStorage.setItem("okri.theme", value), theme);
      await page.setViewportSize({ width: theme === "white" ? 1920 : 768, height: 1000 });
      await page.goto("/?view=scrum");
      const summary = page.locator(".daily-submission-summary");
      await expect(summary.getByRole("list", { name: "오늘 할 일", exact: true })).toHaveText("오늘 예정 없음");
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect((await new AxeBuilder({ page: page as never }).include(".daily-submission-summary").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
      const client = await context.newCDPSession(page);
      await client.send("DOM.enable"); await client.send("CSS.enable");
      const doc = await client.send("DOM.getDocument");
      const node = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: '.daily-submission-summary ul[aria-label="완료한 일"] button' });
      const fonts = await client.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
      expect(fonts.fonts.some((font) => font.glyphCount > 0 && /Pretendard/.test(font.familyName))).toBeTruthy();
      await client.detach();
      await page.screenshot({ path: testInfo.outputPath(`daily-summary-${theme}-zoom.png`), fullPage: true });
    }
  }
  expect(writes.filter((path) => path !== "/api/account/marketing-consent")).toEqual([]);
});
