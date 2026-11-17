import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootstrap, installApiMocks, json } from "./api-mocks";

async function mocks(page: Page, options: { viewer?: boolean; api?: boolean } = {}) {
  await installApiMocks(page, { workspaceRole: options.viewer ? "viewer" : "owner" });
  const items = structuredClone(bootstrap.items);
  let goal: { projectId: string; targetCount: number; completedCount: number; progress: number; version: number } | null = null;
  let writes = 0, fail = false;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/items" && request.method() === "PATCH") {
      const body = request.postDataJSON();
      const item = items.find(row => row.id === body.id)!;
      Object.assign(item, body, { updatedAt: new Date().toISOString() });
      return json(route, { item });
    }
    if (path !== "/api/project-task-goals") return route.fallback();
    if (request.method() === "PUT") {
      writes++;
      if (fail) { fail = false; return json(route, { code: "goal_save_failed" }, 503); }
      const body = request.postDataJSON();
      const count = items.filter(row => row.kind === "task" && row.parentId === "project-1" && row.status === "done").length;
      goal = body.enabled ? { projectId: body.projectId, targetCount: body.targetCount, completedCount: count, progress: Math.min(100, Math.round(count / body.targetCount * 100)), version: (goal?.version ?? 0) + 1 } : null;
    }
    return json(route, { goal, apiConnected: options.api ?? false, progress: goal?.progress ?? 40 });
  });
  return { writes: () => writes, fail: () => { fail = true; } };
}

test("completion goal saves with a button and follows Task completion and undo", async ({ page }) => {
  const mock = await mocks(page);
  await page.goto("/?view=work&project=project-1");
  const progress = page.locator(".project-progress-section");
  await progress.getByRole("button", { name: "완료 쌓기 설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "진행 방식", exact: true });
  expect(mock.writes()).toBe(0);
  await dialog.getByLabel("목표 Task 수", { exact: true }).fill("10");
  await dialog.getByRole("button", { name: "저장", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(progress.locator(".project-progress-value strong")).toHaveText("0%");
  const complete = page.locator(".project-task-completion");
  await complete.click();
  await expect(progress.locator(".project-progress-value strong")).toHaveText("10%");
  await expect(progress).toContainText("1 / 10개 완료");
  await complete.click();
  await expect(progress.locator(".project-progress-value strong")).toHaveText("0%");
  expect(mock.writes()).toBe(1);
});

test("failed saves preserve target and recover on retry; leaving the mode keeps current progress", async ({ page }) => {
  const mock = await mocks(page);
  await page.goto("/?view=work&project=project-1");
  await page.getByRole("button", { name: "완료 쌓기 설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "진행 방식", exact: true });
  await dialog.getByLabel("목표 Task 수", { exact: true }).fill("8");
  mock.fail();
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(dialog.getByLabel("목표 Task 수", { exact: true })).toHaveValue("8");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "진행 방식 변경", exact: true }).click();
  await dialog.getByRole("combobox", { name: "진행 방식", exact: true }).selectOption("manual");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".completion-goal")).toContainText("직접 조절");
});

test("Viewer reads the progress mode and API-connected Projects cannot enable a second source", async ({ page }) => {
  await mocks(page, { viewer: true });
  await page.goto("/?view=work&project=project-1");
  await expect(page.locator(".completion-goal")).toContainText("직접 조절");
  await expect(page.getByRole("button", { name: "완료 쌓기 설정", exact: true })).toHaveCount(0);
});

test("API-connected Projects explain how to change the progress source", async ({ page }) => {
  await mocks(page, { api: true });
  await page.goto("/?view=work&project=project-1");
  await expect(page.getByRole("button", { name: "완료 쌓기 설정", exact: true })).toBeDisabled();
  await expect(page.locator(".completion-goal")).toContainText("API 연결을 먼저 해제");
});

test("completion goal fits all widths, text zoom, themes and keyboard with real Pretendard glyphs", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(150_000);
  await mocks(page);
  await page.goto("/?view=work&project=project-1");
  await page.getByRole("button", { name: "완료 쌓기 설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "진행 방식", exact: true });
  const panel = page.locator(".completion-goal-dialog");
  for (const width of [320,390,768,1440,1920,2560,3840]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const size of ["100%","200%"]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
      const box = await panel.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
      await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeVisible();
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.screenshot({ path: info.outputPath(`completion-goal-${width}.png`) });
  }
  for (const theme of ["white","beige","gray","dark","neon","cyberpunk"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; },theme);
    expect((await new AxeBuilder({ page: page as never }).include(".completion-goal-dialog").withRules(["color-contrast"]).analyze()).violations,theme).toEqual([]);
  }
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const doc = await cdp.send("DOM.getDocument");
  for (const selector of [".completion-goal-dialog h2", ".completion-goal-dialog p"]) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every(font => font.isCustomFont && /Pretendard/.test(font.familyName))).toBe(true);
  }
  await cdp.detach();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
