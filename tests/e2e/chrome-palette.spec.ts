import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installApiMocks } from "./api-mocks";

async function neutral(page: Page, selector: string) {
  const tinted = await page.locator(selector).evaluateAll((elements) => elements.filter((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().height).flatMap((el) => {
    const css = getComputedStyle(el);
    return [css.color, css.backgroundColor, css.borderTopColor, css.borderRightColor].filter((value) => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return channels.length >= 3 && channels[3] !== 0 && (channels[0] !== channels[1] || channels[1] !== channels[2]);
    }).map((color) => ({ className: el.className, color }));
  }));
  expect(tinted, selector).toEqual([]);
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await installApiMocks(page, { teamWorkspace: true, slackState: "connected", withRoutine: true });
});

test("white navigation and menus stay neutral on mobile, desktop and enlarged text", async ({ page }, info) => {
  test.setTimeout(90_000);
  for (const width of [320, 390, 1440, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?view=okr");
    await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    const active = page.locator(width <= 980 ? ".mobile-navigation .nav-item.active" : ".desktop-navigation .nav-item.active");
    await expect(active).toHaveCSS("background-color", "rgb(232, 232, 232)");
    await neutral(page, ".sidebar, .nav-item, .nav-item svg, .workspace-topbar, .workspace-topbar button");
    await active.focus();
    expect(await active.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("solid");
    await page.locator(".page-header h1").click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath(`navigation-${width}.png`) });
    if (width <= 980) {
      await page.getByRole("button", { name: "더보기", exact: true }).click();
      await expect(page.locator(".mobile-menu-sheet")).toBeVisible();
      await neutral(page, ".mobile-menu-sheet, .mobile-menu-sheet .nav-item");
      await page.keyboard.press("Escape");
    } else {
      await page.locator(".workspace-switcher").click();
      await expect(page.locator(".workspace-menu")).toBeVisible();
      await neutral(page, ".workspace-menu, .workspace-menu button, .team-avatar:not(.pending)");
      await page.locator(".workspace-switcher").click();
    }
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await neutral(page, ".sidebar, .nav-item, .workspace-topbar");
  }
});

test("settings, guidance, avatars and conversation share neutral support roles", async ({ page }, info) => {
  test.setTimeout(90_000);
  for (const tab of ["general", "members", "groups", "projects", "integrations"]) {
    await page.goto(`/?settings=workspace&tab=${tab}`);
    await expect(page.getByRole("dialog", { name: "워크스페이스 설정" })).toBeVisible();
    await expect(page.locator(".workspace-settings-nav")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await neutral(page, ".workspace-settings-nav, .workspace-settings-nav button, .settings-hint svg, .team-avatar:not(.pending), .workspace-avatar-option svg, .integration-service-icon, .integration-oauth-flow > div > span, .workspace-daily-bot-heading small");
    const contrast = await new AxeBuilder({ page: page as never }).include(".workspace-settings-panel").withRules(["color-contrast"]).analyze();
    expect(contrast.violations, tab).toEqual([]);
    await page.screenshot({ path: info.outputPath(`settings-${tab}.png`) });
  }
  await page.goto("/?view=work");
  await page.getByRole("button", { name: "AI 대화로 추가", exact: true }).click();
  await expect(page.locator(".chat-input textarea").first()).toBeVisible();
  await neutral(page, ".assistant-stage, .assistant-example, .assistant-example b, .chat-okr-context, .assistant-followups .followup-message, .assistant-target-options button span");
  await page.goto("/?view=billing");
  await expect(page.locator(".billing-plan-card.current")).toBeVisible();
  await neutral(page, ".billing-plan-card > header div span, .billing-usage-grid article > div i");
  await page.goto("/download");
  await expect(page.getByText("브라우저 앱", { exact: true })).toBeVisible();
  await neutral(page, "[class*='topbar'], [class*='format']");
  const contrast = await new AxeBuilder({ page: page as never }).withRules(["color-contrast"]).analyze();
  expect(contrast.violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("download.png") });
});
