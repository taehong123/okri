import { expect, test } from "@playwright/test";
import { installLandingProductFixture } from "./landing-product-fixture";

test("document workspace keeps neutral navigation, aligned work and a single unblurred overlay", async ({ page }, info) => {
  await installLandingProductFixture(page);
  await page.goto("/?view=my_work");
  await expect(page.locator(".my-work-item").first()).toBeVisible();
  await expect(page.locator(".page-header p")).toHaveCount(0);
  await expect(page.getByText("명시적으로 담당된 항목만 표시합니다.")).toHaveCount(0);
  const pageColor = await page.locator(".app-shell").evaluate(el => getComputedStyle(el).backgroundColor);
  expect(await page.locator(".sidebar").evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(pageColor);
  if (info.project.name === "desktop-chromium") {
    await expect(page.locator(".desktop-navigation .nav-item").first()).toHaveCSS("font-size", "15px");
    const positions = await page.locator(".my-work-item").evaluateAll(rows => rows.map(row => {
      const priority = row.querySelector(".my-work-priority")!.getBoundingClientRect();
      const due = row.querySelector(".my-work-due")!.getBoundingClientRect();
      return [priority.left, due.right];
    }));
    for (const position of positions) expect(position).toEqual(positions[0]);
  }
  await page.screenshot({ path: info.outputPath("document-workspace.png"), fullPage: true });
  await page.locator(".my-work-item").first().click();
  const panel = page.locator(".task-detail-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".document-title")).toHaveCSS("font-size", "28px");
  await expect(panel.locator(":scope > header")).toHaveCSS("background-color", pageColor);
  const overlay = page.locator("dialog[open]");
  await expect(overlay).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(overlay).toHaveCSS("backdrop-filter", "none");
  await expect(panel.locator(".checklist-section")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const titleBox = (await panel.locator(".document-title").boundingBox())!;
  const actionsBox = (await panel.locator(".task-detail-actions").boundingBox())!;
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(titleBox.y);
  await expect(panel.locator(".bn-editor")).toBeVisible();
  await expect(panel.locator(".project-editor-loading")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("document-task.png") });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".my-work-item").first()).toBeFocused();
});

test("Task title, parent and close action stay separate with enlarged text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await installLandingProductFixture(page);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?view=my_work");
    await page.locator(".my-work-item").first().click();
    const panel = page.locator(".task-detail-panel");
    await expect(panel.locator(".bn-editor")).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
      document.querySelector(".task-detail-panel .document-title")!.textContent = "고객 경험을 검토하고 제품의 첫 사용 흐름을 개선하기";
    });
    const layout = await panel.evaluate(node => {
      const header = node.querySelector(":scope > header")!;
      const title = header.querySelector(".document-title")!.getBoundingClientRect();
      const actions = header.querySelector(".task-detail-actions")!.getBoundingClientRect();
      const parent = header.querySelector(".detail-parent-link")!.getBoundingClientRect();
      const parentOverlapsActions = parent.left < actions.right && parent.right > actions.left && parent.top < actions.bottom && parent.bottom > actions.top;
      return { overflow: node.scrollWidth - node.clientWidth, overlap: actions.bottom > title.top || parent.bottom > title.top || parentOverlapsActions, outside: actions.right > innerWidth };
    });
    expect(layout, String(width)).toEqual({ overflow: 0, overlap: false, outside: false });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  }
});
