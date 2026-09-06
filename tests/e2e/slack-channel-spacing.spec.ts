import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import { installApiMocks } from "./api-mocks";

async function expectRefreshSpacing(row: Locator) {
  await expect(row).toBeVisible();
  const geometry = await row.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const button = element.querySelector("button")!;
    const action = button.getBoundingClientRect();
    const text = element.querySelector("span")!.getBoundingClientRect();
    return {
      top: action.top - bounds.top,
      bottom: bounds.bottom - action.bottom,
      left: action.left - bounds.left,
      right: bounds.right - action.right,
      overlaps: text.left < action.right && text.right > action.left && text.top < action.bottom && text.bottom > action.top,
      clipped: button.scrollWidth > button.clientWidth + 1,
    };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(12);
  expect(geometry.bottom).toBeGreaterThanOrEqual(12);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeGreaterThanOrEqual(-1);
  expect(geometry.overlaps).toBe(false);
  expect(geometry.clipped).toBe(false);
}

for (const bot of ["daily", "management", "automation"]) {
  test(`${bot} channel refresh stays clear of borders at normal and enlarged text`, async ({ page }, info) => {
    await installApiMocks(page, { slackState: bot === "daily" ? "setup_required" : "connected", slackSetupComplete: bot !== "daily", teamWorkspace: true });
    const writes: string[] = [];
    let channelReads = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "GET" && path === "/api/slack/channels") channelReads += 1;
      if (request.method() !== "GET" && (path.startsWith("/api/slack/") || path === "/api/workspace-management-bot")) writes.push(path);
    });
    await page.goto(`/?settings=workspace&tab=integrations&bot=${bot}${bot === "daily" ? "&slack=setup_required" : ""}`);
    const row = page.locator(".slack-channel-sync:visible");
    await expect(row.locator("button")).toBeEnabled();
    await expectRefreshSpacing(row);
    if (bot === "management") {
      expect(await row.evaluate((element) => element.querySelector("button")!.getBoundingClientRect().top - element.previousElementSibling!.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(12);
    }
    await row.screenshot({ path: info.outputPath(`${bot}-refresh.png`) });
    if (info.project.name === "desktop-chromium") await page.screenshot({ path: info.outputPath(`${bot}-settings.png`) });
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expectRefreshSpacing(row);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await row.locator("button").scrollIntoViewIfNeeded();
    const target = await row.locator("button").evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      return { x, y, reachable: button.contains(document.elementFromPoint(x, y)) };
    });
    expect(target.reachable).toBe(true);
    const readsBefore = channelReads;
    await page.mouse.click(target.x, target.y);
    await expect.poll(() => channelReads).toBeGreaterThan(readsBefore);
    await expect(row.locator("button")).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`${bot}-refresh-large-text.png`) });
    expect(writes).toEqual([]);
  });
}

test("keyboard refresh shows busy and retry states without moving or writing data", async ({ page }) => {
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && (path.startsWith("/api/slack/") || path === "/api/workspace-management-bot")) writes.push(path);
  });
  await page.goto("/?settings=workspace&tab=integrations&bot=management");
  const row = page.locator(".slack-channel-sync:visible");
  const button = row.locator("button");
  await expect(button).toBeEnabled();
  const readyWidth = (await button.boundingBox())!.width;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/slack/channels**", async (route) => {
    await pending;
    await route.fulfill({ status: 503, json: { error: "temporary channel lookup failure" } });
  });
  await button.focus();
  await expect(button).toBeFocused();
  expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-busy", "true");
  expect((await button.boundingBox())!.width).toBe(readyWidth);
  await expectRefreshSpacing(row);
  release();
  await expect(row).toHaveClass(/error/);
  await expect(button).toBeEnabled();
  await expectRefreshSpacing(row);
  await page.route("**/api/slack/channels**", (route) => route.fulfill({ json: { channels: [{ id: "C123", name: "updated", isPrivate: false, isMember: true }] } }));
  await button.click();
  await expect(row).not.toHaveClass(/error/);
  await expect(button).toHaveAttribute("aria-busy", "false");
  expect(writes).toEqual([]);
});

test("wide light and dark refresh controls retain contrast and the actual shared font", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop-chromium", "one sequential wide-screen check");
  await installApiMocks(page, { slackState: "connected", teamWorkspace: true });
  await page.setViewportSize({ width: 3840, height: 2160 });
  for (const theme of ["white", "dark"]) {
    await page.addInitScript((value) => localStorage.setItem("okri.theme", value), theme);
    await page.goto("/?settings=workspace&tab=integrations&bot=management");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const row = page.locator(".slack-channel-sync:visible");
    await expect(row.locator("button")).toBeEnabled();
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expectRefreshSpacing(row);
    const result = await new AxeBuilder({ page: page as never }).include(".slack-channel-sync").withRules(["color-contrast"]).analyze();
    expect(result.violations).toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    const client = await context.newCDPSession(page);
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const documentNode = await client.send("DOM.getDocument");
    const { nodeId } = await client.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: ".slack-channel-sync > span" });
    const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.some((font) => font.glyphCount > 0 && /Pretendard/.test(font.familyName))).toBe(true);
    await client.detach();
    await row.screenshot({ path: info.outputPath(`refresh-${theme}-wide.png`) });
  }
});
