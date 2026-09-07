import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootstrap, installApiMocks, json } from "./api-mocks";

async function openGantt(page: Parameters<typeof installApiMocks>[0], mobile: boolean) {
  await installApiMocks(page);
  await page.goto("/?view=work");
  if (mobile) {
    await page.getByRole("button", { name: "더보기", exact: true }).click();
    await page.getByRole("button", { name: "간트", exact: true }).click();
  } else {
    await page.locator(".desktop-navigation").getByRole("button", { name: "간트", exact: true }).click();
  }
  await expect(page).toHaveURL(/view=gantt/);
  await expect(page.getByRole("heading", { name: "간트", exact: true })).toBeVisible();
}

test("Gantt is a real menu view with Project bars and expandable Task milestones", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.startsWith("mobile-");
  await openGantt(page, mobile);

  const schedule = page.getByRole("group", { name: "Project와 Task 일정표" });
  const projectTitle = schedule.locator(".gantt-project-label .gantt-title").filter({ hasText: "모바일 사용성 개선" });
  const taskTitle = schedule.locator(".gantt-task-label .gantt-title").filter({ hasText: "오버레이 동작 점검" });
  await expect(schedule).toBeVisible();
  await expect(projectTitle).toBeVisible();
  await expect(taskTitle).toBeVisible();
  await expect(schedule.locator(".gantt-bar")).toHaveCount(1);
  await expect(schedule.locator(".gantt-milestone")).toHaveCount(1);
  await expect(page.locator(".gantt-project-row")).toHaveClass(/overdue/);

  const expander = schedule.locator(".gantt-project-label .gantt-expand");
  await expect(expander).toHaveAccessibleName(/모바일 사용성 개선 · 접기/);
  await expander.click();
  await expect(expander).toHaveAttribute("aria-expanded", "false");
  await expect(taskTitle).toHaveCount(0);
  await expander.click();
  await expect(taskTitle).toBeVisible();

  await page.getByRole("button", { name: "월간", exact: true }).click();
  await expect(page.getByRole("button", { name: "월간", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "2주", exact: true }).click();
  await expect(page.getByRole("button", { name: "2주", exact: true })).toHaveAttribute("aria-pressed", "true");

  const measurements = await schedule.evaluate((node) => ({
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    localOverflow: node.scrollWidth - node.clientWidth,
    labelPosition: getComputedStyle(node.querySelector(".gantt-label")!).position,
    barHeight: node.querySelector(".gantt-bar")!.getBoundingClientRect().height,
  }));
  expect(measurements.pageOverflow).toBeLessThanOrEqual(1);
  expect(measurements.labelPosition).toBe("sticky");
  if (mobile) {
    expect(measurements.localOverflow).toBeGreaterThan(0);
    expect(measurements.barHeight).toBeGreaterThanOrEqual(44);
  }

  const accessibility = await new AxeBuilder({ page: page as never }).include(".gantt-view").analyze();
  expect(accessibility.violations).toEqual([]);
  if (!mobile) {
    for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
      await page.locator("html").evaluate((node, value) => { node.dataset.theme = value; }, theme);
      const contrast = await new AxeBuilder({ page: page as never }).include(".gantt-view").withRules(["color-contrast"]).analyze();
      expect(contrast.violations, theme).toEqual([]);
    }
    await page.locator("html").evaluate((node) => { node.dataset.theme = "white"; });
    await page.setViewportSize({ width: 3840, height: 1200 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await page.screenshot({ path: testInfo.outputPath("gantt.png"), fullPage: true });
});

test("Gantt remains contained with 200 percent text and opens Project and Task details", async ({ page }, testInfo) => {
  await installApiMocks(page);
  await page.addInitScript(() => { document.documentElement.style.fontSize = "200%"; });
  await page.goto("/?view=gantt");
  const schedule = page.getByRole("group", { name: "Project와 Task 일정표" });
  await expect(schedule).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

  await schedule.locator(".gantt-task-label .gantt-title").filter({ hasText: "오버레이 동작 점검" }).click();
  await expect(page).toHaveURL(/task=task-1/);
  await page.goBack();
  await expect(schedule).toBeVisible();
  await schedule.locator(".gantt-project-label .gantt-title").filter({ hasText: "모바일 사용성 개선" }).click();
  await expect(page).toHaveURL(/project=project-1/);
  await page.screenshot({ path: testInfo.outputPath("gantt-text-zoom.png"), fullPage: true });
});

test("Gantt system labels follow all supported workspace languages", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Run the language matrix once.");
  let language = "ko";
  await installApiMocks(page);
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/bootstrap") return route.fallback();
    return json(route, { ...bootstrap, user: { ...bootstrap.user, preferences: { language, resolvedLanguage: language, revision: 1 } } });
  });
  const copies = {
    ko: { title: "간트", zoom: "2주" },
    en: { title: "Gantt", zoom: "2 weeks" },
    ja: { title: "ガント", zoom: "2週間" },
    zh: { title: "甘特图", zoom: "两周" },
    es: { title: "Gantt", zoom: "2 semanas" },
  } as const;
  for (const [id, copy] of Object.entries(copies)) {
    language = id;
    await page.goto("/?view=gantt");
    await expect(page.getByRole("heading", { name: copy.title, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: copy.zoom, exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", id === "zh" ? "zh-Hans" : id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
});
