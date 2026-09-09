import { expect, test } from "@playwright/test";
import { installLandingProductFixture } from "./landing-product-fixture";

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await installLandingProductFixture(page);
});

test("KR reads like the landing example while keeping its real progress and keyboard tree", async ({ page }, info) => {
  test.setTimeout(90_000);
  for (const width of [320, 390, 1440, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?view=okr");
    const kr = page.locator("button.okr-tree-kr-row").first();
    await expect(kr).toBeVisible();
    await expect(kr.locator(".okr-tree-progress")).toHaveText("40%");
    await expect(kr.locator(".okr-tree-count b")).toHaveText("1");
    await expect(kr.locator(".type-icon")).toHaveCount(0);
    await expect(kr.locator(".okr-tree-copy strong")).toHaveCSS("font-size", "16px");
    await expect(kr.locator(".okr-tree-copy strong")).toHaveCSS("font-weight", "400");
    await expect(kr.locator(".okr-tree-copy small")).toHaveCSS("font-size", "14px");
    await expect(kr.locator(".okr-tree-progress")).toHaveCSS("font-size", "18px");
    const positions = await kr.evaluate((node) => {
      const title = node.querySelector(".okr-tree-copy")!.getBoundingClientRect();
      const metrics = node.querySelector(".okr-tree-metrics")!.getBoundingClientRect();
      return { aligned: Math.abs(title.left - metrics.left) < 1, separated: metrics.top > title.bottom, width: node.getBoundingClientRect().width };
    });
    expect(positions.aligned).toBe(true);
    expect(positions.separated).toBe(true);
    expect(positions.width).toBeLessThanOrEqual(704);
    await kr.focus();
    await page.keyboard.press("Enter");
    await expect(kr).toHaveAttribute("aria-expanded", "true");
    const initiative = page.locator("button.okr-tree-initiative-row").first();
    await initiative.focus();
    await page.keyboard.press("Enter");
    const project = page.locator("button.okr-tree-project-main").first();
    await project.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".okr-tree-task")).toHaveCount(2);
    await page.locator(".page-header h1").click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath(`okr-${width}.png`), fullPage: true });
    for (const scale of [100, 200]) {
      await page.evaluate((value) => document.documentElement.style.fontSize = `${value}%`, scale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect(await page.locator(".okr-tree-copy").evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent)), `${width}px / ${scale}% text`).toEqual([]);
    }
    await page.locator(".okr-tree-open-detail").click();
    await expect(page.locator(".project-title-input")).toHaveValue("온보딩 흐름 개선");
  }
});

test("project table, cards, detail and data share unframed aligned surfaces", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.route("**/api/data-connections", (route) => route.request().method() === "GET" ? route.fulfill({ json: { connections: [{
    id: "connection-kr-1", itemId: "kr-1", targetKind: "key_result", name: "온보딩 분석", endpointUrl: "https://example.com/metrics",
    valuePath: "activation", baselineValue: 30, targetValue: 45, unit: "%", cadence: "daily", active: true,
    lastValue: 36, lastSyncStatus: "success", lastError: "", lastSyncedAt: "2026-09-03T00:00:00.000Z", nextSyncAt: null,
  }] } }) : route.fallback());
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?view=work");
    await page.getByRole("tab", { name: "테이블", exact: true }).click();
    const cells = page.locator(".task-table-row > *");
    expect(await cells.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).borderRightWidth === "0px"))).toBe(true);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath(`project-table-${width}.png`), fullPage: true });
    await page.getByRole("tab", { name: "카드", exact: true }).click();
    await expect(page.locator(".project-card").first()).toHaveCSS("border-left-width", "0px");
    await page.screenshot({ path: info.outputPath(`project-cards-${width}.png`), fullPage: true });
    await page.locator(".project-card-open").first().click();
    await expect(page.locator(".project-title-input")).toHaveValue("온보딩 흐름 개선");
    const context = page.locator(".project-context-column .project-detail-form");
    expect(await context.evaluate((node) => parseFloat(getComputedStyle(node).paddingInlineStart))).toBeGreaterThanOrEqual(16);
    await expect(context).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath(`project-detail-${width}.png`), fullPage: true });
    await page.goto("/?view=data");
    const data = page.locator(".kr-data-card.connected").first();
    await expect(data).toBeVisible();
    await expect(data).toHaveCSS("border-top-width", "0px");
    await expect(data.locator(".kr-data-progress > b")).toHaveCSS("font-size", "18px");
    await expect(data.locator("dd").first()).toHaveCSS("font-size", "14px");
    await page.screenshot({ path: info.outputPath(`data-${width}.png`), fullPage: true });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(await data.locator("h2, dd").evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent))).toEqual([]);
  }
});
