import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { guideCopy } from "../../lib/guide-copy";
import { THEMES } from "../../lib/themes";
import { installApiMocks, json } from "./api-mocks";

async function guest(page: Page) {
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    return json(route, { error: "unauthenticated" }, 401);
  });
  return { writes, errors };
}
async function layout(page: Page) {
  const issues = await page.evaluate(() => {
    const overflow = [...document.querySelectorAll<HTMLElement>(".guide-node, .guide-intro, .guide-roles, .guide-header, .guide-glossary, .guide-conversation button")]
      .filter((node) => node.getBoundingClientRect().width && node.scrollWidth > node.clientWidth + 1).map((node) => node.className);
    if (document.documentElement.scrollWidth > innerWidth + 1) overflow.push("page");
    return overflow;
  });
  expect(issues).toEqual([]);
}

test("public tree explains every level, roles, collapse, keyboard and sharing", async ({ page }) => {
  const state = await guest(page);
  await page.goto("/guide?lang=ko");
  await expect(page.locator(".okr-guide")).toHaveAttribute("lang", "ko");
  await expect(page.locator(".guide-node:visible")).toHaveCount(17);
  await expect(page.locator(".guide-roles")).toContainText("끝까지 책임지는 사람");
  await page.getByRole("button", { name: guideCopy.ko.collapse, exact: true }).click();
  await expect(page.locator(".guide-node:visible")).toHaveCount(1);
  const rootToggle = page.locator(".guide-node").first().getByRole("button");
  await rootToggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".guide-node:visible")).toHaveCount(3);
  await page.getByRole("button", { name: guideCopy.ko.expand, exact: true }).click();
  await expect(page.locator(".guide-node:visible")).toHaveCount(17);
  await page.locator(".guide-glossary summary").click();
  await expect(page.locator(".guide-glossary")).toContainText(guideCopy.ko.structureNote);
  await expect(page.locator(".guide-glossary a")).toHaveAttribute("href", "https://www.whatmatters.com/faqs/outputs-vs-outcome-okr");
  await layout(page);
  expect((await new AxeBuilder({ page: page as never }).include(".okr-guide").analyze()).violations).toEqual([]);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("blocked"); } }, configurable: true }));
  await page.getByRole("button", { name: guideCopy.ko.share }).click();
  await expect(page.locator(".guide-share-fallback input")).toHaveValue("https://okri.ai/guide?lang=ko");
  await expect(page.locator(".guide-share-fallback input")).toBeFocused();
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("five languages, six themes, text zoom and sharp native example content", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await guest(page);
  await page.goto("/guide?lang=en");
  for (const [language, copy] of Object.entries(guideCopy)) {
    await page.locator(".guide-header select").selectOption(language);
    await expect(page.locator(".okr-guide")).toHaveAttribute("lang", language);
    await expect(page.locator("#guide-title")).toHaveText(copy.title);
    await expect(page.locator("#guide-title-task-7")).toHaveText(copy.tasks[7]);
    if (language !== "ko") expect((await page.locator(".guide-intro, .guide-map, .guide-roles, .guide-glossary, .guide-footer").allInnerTexts()).join("\n")).not.toMatch(/[가-힣]/);
    for (const { mode } of THEMES) {
      await page.evaluate((theme) => document.documentElement.dataset.theme = theme, mode);
      await layout(page);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await layout(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    if (testInfo.project.name === "desktop-chromium") {
      await page.setViewportSize({ width: 3840, height: 2160 });
      await layout(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await layout(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  }
  await page.locator(".guide-header select").selectOption("en");
  await page.reload();
  await expect(page.locator(".okr-guide")).toHaveAttribute("lang", "en");
  expect(await page.locator(".guide-map img").count()).toBe(0);
  for (const { mode } of THEMES) {
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, mode);
    expect((await new AxeBuilder({ page: page as never }).include(".okr-guide").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "white"; });
  await page.screenshot({ path: testInfo.outputPath("guide-viewport.png") });
  await page.screenshot({ path: testInfo.outputPath("guide.png"), fullPage: true });
  await page.locator(".guide-map").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("guide-tree-viewport.png") });
  if (testInfo.project.name === "desktop-chromium") {
    await page.setViewportSize({ width: 3840, height: 2160 });
    await layout(page);
    await page.screenshot({ path: testInfo.outputPath("guide-4k.png"), fullPage: true });
    await page.locator(".guide-header select").selectOption("ko");
    await page.evaluate(() => document.fonts.ready);
    const client = await page.context().newCDPSession(page);
    await client.send("DOM.enable"); await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument");
    for (const selector of ["#guide-title", ".guide-type", ".guide-metric dd"]) {
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.every((font) => font.isCustomFont && /Pretendard/i.test(font.familyName))).toBe(true);
    }
    await client.detach();
  }
});

test("goal handoff preserves a current draft, needs an explicit add and never auto-sends", async ({ page }) => {
  await installApiMocks(page, { preserveStorage: true });
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/")) mutations.push(new URL(request.url()).pathname);
  });
  await page.goto("/?guide=1");
  await expect(page.locator("#assistant-message")).toBeVisible();
  const storedDraft = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/assistant-drafts" && response.request().method() === "PUT");
  await page.locator("#assistant-message").fill("기존에 작성한 메시지");
  await storedDraft;
  await page.goto("/guide?lang=ko");
  await page.locator("#guide-goal").fill("처음 방문한 고객의 활성화를 높이고 싶어요.");
  await page.getByRole("button", { name: guideCopy.ko.start }).click();
  await expect(page).toHaveURL(/\/\?guide=1$/);
  await expect(page.locator(".guide-draft")).toBeVisible();
  await expect(page.locator(".guide-draft button.secondary")).toBeEnabled();
  await expect(page.locator("#assistant-message")).toHaveValue("기존에 작성한 메시지");
  await page.getByRole("button", { name: guideCopy.ko.addMessage }).click();
  await expect(page.locator("#assistant-message")).toHaveValue("기존에 작성한 메시지\n\n처음 방문한 고객의 활성화를 높이고 싶어요.");
  await expect(page.locator("#assistant-message")).toBeFocused();
  await expect(page.locator(".guide-draft")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("guide")).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem("okri.guide-draft"))).toBeNull();
  expect(mutations.filter((path) => !["/api/assistant-drafts", "/api/account/marketing-consent"].includes(path))).toEqual([]);
});

test("dismissal and explicit work navigation leave existing work untouched", async ({ page }) => {
  await installApiMocks(page);
  await page.addInitScript(() => sessionStorage.setItem("okri.guide-draft", JSON.stringify({ text: "A private goal", savedAt: Date.now() })));
  await page.goto("/?guide=1&view=my_work");
  await expect(page.locator(".guide-draft")).toHaveCount(0);
  await expect(page.locator(".my-work-view")).toBeVisible();
  await page.goto("/?guide=1");
  await expect(page.locator(".guide-draft")).toBeVisible();
  await page.getByRole("button", { name: guideCopy.ko.dismiss }).click();
  await expect(page.locator(".guide-draft")).toHaveCount(0);
  await expect(page.locator("#assistant-message")).toHaveValue("");
  expect(await page.evaluate(() => sessionStorage.getItem("okri.guide-draft"))).toBeNull();
});

test("guest goal survives sign-in return path, while blocked storage retains input", async ({ page }) => {
  const state = await guest(page);
  await page.goto("/guide?lang=en");
  await page.locator("#guide-goal").fill("Keep this goal private.");
  await page.getByRole("button", { name: guideCopy.en.start }).click();
  await expect(page.locator(".landing-login-button")).toBeVisible();
  await page.route("**/api/auth/google?**", (route) => json(route, { mocked: true }));
  await page.locator(".landing-login-button").click();
  await expect(page).toHaveURL(/\/api\/auth\/google\?/);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/?guide=1");
  expect(await page.evaluate(() => sessionStorage.getItem("okri.guide-draft"))).toContain("Keep this goal private.");
  await page.goto("/guide?lang=en");
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("blocked"); }; });
  await page.locator("#guide-goal").fill("Keep my text.");
  await page.getByRole("button", { name: guideCopy.en.start }).click();
  await expect(page.getByRole("alert")).toHaveText(guideCopy.en.storageError);
  await expect(page.locator("#guide-goal")).toHaveValue("Keep my text.");
  expect(new URL(page.url()).pathname).toBe("/guide");
  expect(state.writes).toEqual([]);
});
