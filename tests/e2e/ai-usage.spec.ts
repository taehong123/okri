import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installApiMocks, json } from "./api-mocks";

const aiResponse = (usedPercent: number) => ({ workspaceId: "workspace-1", userId: "user-1", ai: { usedPercent, remainingPercent: 100 - usedPercent, resetsAt: "2099-01-01T00:00:00.000Z" } });
const emptyPlan = { objectiveTitle: "", keyResults: [], targetInitiatives: [], unassignedInitiatives: [], project: "", tasks: "", taskParent: "", routineTitle: "", routineTrigger: "", routinePlace: "", routineSteps: "", routineCadence: "daily" };

async function openChat(page: Page) {
  await page.goto("/?view=okr");
  await page.getByRole("button", { name: "AI 대화", exact: true }).first().click();
  await expect(page.locator(".chat-ai-usage")).toBeVisible();
}

test("chat usage is cached while typing and refreshed after answers and limit errors", async ({ page }) => {
  await installApiMocks(page);
  let reads = 0;
  let used = 24;
  let limited = false;
  await page.route("**/api/billing/ai-usage", async (route) => { reads++; await json(route, aiResponse(used)); });
  await page.route("**/api/okr-organize", async (route) => {
    used = limited ? 100 : 28;
    await json(route, limited
      ? { code: "ai_budget_exceeded", spentWon: 500, limitWon: 500 }
      : { organized: { plan: emptyPlan, assistantMessage: "요청을 확인했습니다.", questions: [] } }, limited ? 402 : 200);
  });
  await openChat(page);
  const meter = page.locator(".chat-ai-usage");
  await expect(meter).toContainText("24% 사용");
  await expect(meter).toContainText("76% 남음");
  const message = page.getByRole("textbox", { name: "메시지", exact: true });
  await message.fill("진행 상황을 정리해 줘");
  await message.press("End");
  await message.pressSequentially(" 지금");
  expect(reads).toBe(1);
  await message.press("Control+Enter");
  await expect(meter).toContainText("28% 사용");
  expect(reads).toBe(2);
  limited = true;
  await message.fill("다음 할 일을 정리해 줘");
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  await expect(meter).toContainText("100% 사용");
  await expect(meter).toContainText("0% 남음");
  await expect(page.locator(".assistant-message").last()).toContainText("작성 중인 초안은 그대로");
  await expect(page.locator(".assistant-message").last()).not.toContainText("500원");
  expect(reads).toBe(3);
  await expect(meter.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
});

test("usage failure is not zero and keyboard retry recovers; daily limits do not claim monthly exhaustion", async ({ page }) => {
  await installApiMocks(page);
  let failed = true;
  await page.route("**/api/billing/ai-usage", (route) => json(route, failed ? { error: "unavailable" } : aiResponse(24), failed ? 503 : 200));
  await page.route("**/api/okr-organize", (route) => json(route, { code: "ai_daily_limit_reached", usage: { spentWon: 120, budgetWon: 500 } }, 429));
  await openChat(page);
  const meter = page.locator(".chat-ai-usage");
  await expect(meter).toContainText("확인 불가");
  await expect(meter).not.toContainText("0%");
  await expect(meter.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  failed = false;
  const retry = meter.getByRole("button", { name: "사용량 다시 확인" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(meter).toContainText("24% 사용");
  await page.getByRole("textbox", { name: "메시지", exact: true }).fill("다음 계획");
  await page.getByRole("button", { name: "메시지 보내기", exact: true }).click();
  await expect(page.locator(".assistant-message").last()).toContainText("오늘의 AI 요청 횟수");
  await expect(meter).toContainText("24% 사용");
});

test("billing uses percentage for AI and retains actual subscription prices", async ({ page }) => {
  await installApiMocks(page);
  await page.goto("/?view=billing");
  const meter = page.locator(".billing-usage-grid .ai-usage-meter");
  await expect(meter).toContainText("24% 사용");
  await expect(meter).toContainText("76% 남음");
  await expect(meter).not.toContainText("원");
  await expect(page.locator(".billing-plan-grid")).toContainText("2,900원");
  await expect(page.locator(".billing-plan-grid")).toContainText("4,900원");
  await expect(page.locator(".billing-plan-grid")).toContainText("Team보다 2.5배");
  await expect(page.locator(".billing-plan-grid")).not.toContainText("500원 안전한도");
});

test("AI meters use theme tokens, real self-hosted glyphs, wrap long labels and respect larger text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(120_000);
  await installApiMocks(page, { preserveStorage: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?view=okr");
  for (const theme of ["white", "dark"]) {
    await page.evaluate((value) => localStorage.setItem("okri.theme", value), theme);
    await openChat(page);
    const meter = page.locator(".chat-ai-usage .ai-usage-meter");
    await expect(meter).toContainText("24% 사용");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [320, 390, 768, 1440, 1920, 2560, 3840]) {
      await page.setViewportSize({ width, height: 1000 });
      const box = (await meter.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(await meter.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const track = meter.getByRole("progressbar");
      expect(await track.evaluate((el) => {
        const probe = document.createElement("i");
        probe.style.backgroundColor = "var(--progress-fill)";
        el.appendChild(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return getComputedStyle(el.querySelector("i")!).backgroundColor === expected;
      })).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await meter.locator("header > span").evaluate((el) => { el.textContent = "이번 달 우리 워크스페이스 전체 AI 사용량"; });
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    expect(await meter.locator("header > b").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(28);
    expect(await meter.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const results = await new AxeBuilder({ page: page as never }).include(".chat-ai-usage").withRules(["color-contrast", "aria-progressbar-name", "aria-valid-attr-value"]).analyze();
    expect(results.violations).toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    for (const selector of [".chat-ai-usage header > span", ".chat-ai-usage header > b"]) {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.every((font) => font.isCustomFont && /Pretendard/.test(font.familyName))).toBe(true);
    }
    await cdp.detach();
    const fontUrls = await page.evaluate(() => performance.getEntriesByType("resource").map((r) => r.name).filter((name) => /woff2/.test(name)));
    expect(fontUrls.length).toBeGreaterThan(0);
    expect(fontUrls.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
    await page.screenshot({ path: info.outputPath(`ai-usage-${theme}-zoom.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
