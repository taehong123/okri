import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installApiMocks } from "./api-mocks";

test("Project item names are regular across views without changing hierarchy or navigation", async ({ page }) => {
  await installApiMocks(page, { teamWorkspace: true });
  await page.goto("/?view=work");
  for (const [mode, selector] of [["카드", ".project-card-open"], ["테이블", ".name-cell"], ["보드", ".board-item"]]) {
    await page.getByRole("tab", { name: mode, exact: true }).click();
    const title = page.locator(`${selector} .project-item-title`).first();
    await expect(title).toBeVisible();
    await expect(title).toHaveCSS("font-weight", "400");
    await expect(title).toHaveCSS("font-size", "16px");
    await expect(page.getByRole("tab", { name: mode, exact: true })).toHaveAttribute("aria-selected", "true");
  }
  await page.goto("/?view=my_work");
  const project = page.locator(".my-work-item").filter({ has: page.locator(".project-item-title") }).first();
  await expect(project.locator(".project-item-title")).toHaveCSS("font-weight", "400");
  await expect(page.locator(".my-work-section > header b").first()).toHaveCSS("font-weight", "600");
  await expect(page.locator(".my-work-item b:not(.project-item-title)").first()).toHaveCSS("font-weight", "600");
  await project.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".project-title-input")).toHaveValue("모바일 사용성 개선");
  await expect(page.locator(".project-title-input")).toHaveCSS("font-weight", "650");
  await page.goto("/?view=okr");
  await page.locator("button.okr-tree-kr-row").first().click();
  await page.locator("button.okr-tree-initiative-row").first().click();
  await expect(page.locator(".okr-tree-project-main .project-item-title").first()).toHaveCSS("font-weight", "400");
  await expect(page.locator(".okr-tree-kr-row strong").first()).toHaveCSS("font-weight", "400");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test("Project text retains font, contrast and user scaling in light and dark at 4K", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "one sequential wide-screen check");
  await installApiMocks(page, { teamWorkspace: true });
  await page.setViewportSize({ width: 3840, height: 2160 });
  for (const theme of ["white", "dark"]) {
    await page.addInitScript((value) => localStorage.setItem("okri.theme", value), theme);
    await page.goto("/?view=my_work");
    const title = page.locator(".my-work-item .project-item-title").first();
    await expect(title).toHaveCSS("font-size", "16px");
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expect(title).toHaveCSS("font-weight", "400");
    await expect(title).toHaveCSS("font-size", "32px");
    await page.evaluate(() => document.fonts.ready);
    const client = await context.newCDPSession(page);
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const documentNode = await client.send("DOM.getDocument");
    const node = await client.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: ".my-work-item .project-item-title" });
    const fonts = await client.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
    expect(fonts.fonts.some((font) => font.glyphCount > 0 && /Pretendard/.test(font.familyName))).toBeTruthy();
    await client.detach();
    const result = await new AxeBuilder({ page: page as never }).include(".my-work-view").withRules(["color-contrast"]).analyze();
    expect(result.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`project-weight-${theme}.png`) });
  }
});
