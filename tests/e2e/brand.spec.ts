import { expect, test, type Page } from "@playwright/test";
import { BRAND_SYMBOL_PATH, BRAND_WORDMARK_PATH } from "../../lib/brand-artwork";
import { installApiMocks } from "./api-mocks";
import { approvalFixture } from "./approval-page-fixture";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await page.addInitScript(() => { localStorage.setItem("okri.intro-language", "ko"); });
});

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const logo = page.locator(".landing-brand-home svg, [role='img'][aria-label='OKRI']").first();
  await expect(logo).toBeVisible();
  const bounds = (await logo.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(bounds.width / bounds.height).toBeCloseTo(3.5, 1);
}

test("public surfaces preserve the approved logo, themes, keyboard and user text sizing", async ({ page }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  for (const path of ["/", "/privacy", "/terms"]) {
    await page.goto(path);
    const logo = page.locator(".landing-brand-home svg, [role='img'][aria-label='OKRI']").first();
    await expect(logo).toBeVisible();
    await expect(logo.locator("path").first()).toHaveAttribute("d", BRAND_SYMBOL_PATH);
    await expect(logo.locator("path").last()).toHaveAttribute("d", BRAND_WORDMARK_PATH);
    if (path === "/") {
      await expect(page.getByRole("button", { name: "홈으로 이동", exact: true })).toBeVisible();
      await expect(logo).toHaveAttribute("aria-hidden", "true");
    }
    for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const ink = await logo.locator("rect").evaluate(node => getComputedStyle(node).fill);
      expect(ink).toBe(["dark", "neon", "cyberpunk"].includes(theme) ? "rgb(255, 255, 255)" : "rgb(17, 17, 17)");
    }
    for (const width of [320, 390, 768, 1440, 1920, 2560, 3840]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const zoom of [100, 200]) {
        await page.evaluate(value => { document.documentElement.style.fontSize = `${value}%`; }, zoom);
        await fits(page);
      }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath(`${path.replaceAll("/", "") || "landing"}-mobile-dark.png`), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "white"; });
    await page.screenshot({ path: info.outputPath(`${path.replaceAll("/", "") || "landing"}-desktop.png`), fullPage: true });
    if (path === "/privacy" || path === "/terms") {
      const home = page.getByRole("link", { name: "OKRI", exact: true });
      await home.focus();
      await expect(home).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/$/);
    }
  }
  expect(errors).toEqual([]);
});

test("workspace identity stays distinct and the desktop logo opens OKR home", async ({ page, context }, info) => {
  await installApiMocks(page);
  await page.goto("/?view=my_work");
  await expect(page.locator(".page-header h1")).toHaveText("내 업무");
  const brandHome = page.locator("button.workspace-brand");
  await expect(brandHome).toBeVisible();
  await expect(brandHome).toHaveAttribute("aria-label", "홈으로 이동");
  await expect(brandHome.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".workspace-avatar").first()).toHaveText("테");
  await page.locator(".page-header h1").evaluate(node => { node.textContent = "긴 업무 제목과 성과 OKRI 2026"; });
  await page.evaluate(() => document.fonts.ready);
  const session = await context.newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".page-header h1" });
  const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(fonts.some(font => font.glyphCount > 0)).toBe(true);
  expect(fonts.filter(font => font.glyphCount > 0).every(font => font.isCustomFont && font.familyName.includes("Pretendard"))).toBe(true);
  await session.detach();
  await page.screenshot({ path: info.outputPath("workspace-desktop.png"), fullPage: true });
  for (const width of [320, 390, 1440, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(new URL(page.url()).searchParams.get("view")).toBe("my_work");
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
  await brandHome.click();
  await expect(page).toHaveURL(/\?view=okr$/);
  await expect(page.locator(".page-header h1")).toHaveText("OKR");
  await expect(brandHome).toHaveAttribute("aria-current", "page");
});

test("offline page uses the same cached brand in light and dark", async ({ page }, info) => {
  await page.goto("/offline.html");
  for (const theme of ["white", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const logo = page.locator('header img:visible');
    await expect(logo).toHaveCount(1);
    await expect(logo).toHaveAttribute("src", `/brand/v1/okri-logo${theme === "dark" ? "-reverse" : ""}.svg`);
    expect(await logo.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: info.outputPath(`offline-${theme}.png`), fullPage: true });
  }
});

test("OAuth approval shows the logo without weakening CSP or changing the form", async ({ page }) => {
  await page.route("**/oauth/authorize?brand-test", route => route.fulfill({ status: 200, ...approvalFixture() }));
  await page.goto("/oauth/authorize?brand-test");
  for (const theme of ["white", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await expect(page.getByRole("img", { name: "OKRI" })).toHaveCount(1);
    await expect(page.getByRole("img", { name: "OKRI" })).toBeVisible();
  }
  await expect(page.locator("form")).toHaveAttribute("method", "post");
  await expect(page.locator("form")).toHaveAttribute("action", "/oauth/authorize");
  await expect(page.getByRole("button", { name: "Claude Code 연결 승인" })).toBeVisible();
});
