import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Locator } from "@playwright/test";
import { bootstrap, installApiMocks, json } from "./api-mocks";

async function fixture(page: Page, viewer = false) {
  await installApiMocks(page, { withRoutine: true, workspaceRole: viewer ? "viewer" : "owner" });
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  let project = structuredClone(bootstrap.items.find(item => item.id === "project-1")!);
  await page.route("**/api/**", async route => {
    const request = route.request();
    if (request.method() !== "GET") {
      const path = new URL(request.url()).pathname;
      const data = request.postDataJSON() as Record<string, unknown>;
      if (path !== "/api/account/marketing-consent") writes.push({ path, data });
      if (path === "/api/items" && data.id === "project-1") { project = { ...project, ...data }; return json(route, { item: project }); }
    }
    return route.fallback();
  });
  return writes;
}
async function fits(page: Page, element: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await element.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
}

test("Project reads as a document; only Change opens property controls", async ({ page }, info) => {
  const writes = await fixture(page);
  await page.goto("/?view=work&project=project-1");
  const panel = page.locator(".project-detail-panel");
  const properties = panel.locator(".document-properties");
  await expect(panel.getByRole("heading", { name: "모바일 사용성 개선", exact: true })).toBeVisible();
  await expect(properties.getByRole("button", { name: "속성", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(panel.locator("input:not([type='checkbox']), select, textarea")).toHaveCount(0);
  await expect(panel.getByText("최근 업데이트", { exact: true })).toBeVisible();
  await expect(panel.getByText("진행사항 봇 켜기", { exact: true })).toHaveCount(0);
  await properties.getByRole("button", { name: "속성", exact: true }).click();
  await expect(properties.locator("dl")).toContainText("테스트 사용자");
  await expect(properties.locator("input, select, textarea")).toHaveCount(0);
  expect(writes).toEqual([]);
  await properties.getByRole("button", { name: "변경", exact: true }).focus();
  await page.keyboard.press("Enter");
  const editor = page.locator(".document-properties-editor");
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Project 이름", { exact: true })).toBeFocused();
  await editor.getByLabel("기한", { exact: true }).fill("2026-10-01");
  await expect.poll(() => writes.some(write => write.data.dueDate === "2026-10-01")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(properties.getByRole("button", { name: "변경", exact: true })).toBeFocused();
  await expect(panel).toBeVisible();
  await page.screenshot({ path: info.outputPath("project-document.png") });
});

test("Task properties stay folded and edit in the same dialog", async ({ page }, info) => {
  await fixture(page);
  await page.goto("/?view=inbox&task=task-1");
  const panel = page.locator(".task-detail-panel");
  await expect(panel.getByRole("heading", { name: "오버레이 동작 점검", exact: true })).toBeVisible();
  await expect(panel.locator(".task-detail-fields")).toHaveCount(0);
  await panel.locator(".document-properties").getByRole("button", { name: "변경", exact: true }).click();
  const editor = page.locator(".document-properties-editor");
  await expect(editor.getByRole("combobox", { name: "연결 대상", exact: true })).toHaveValue("project:project-1");
  await expect(editor.getByLabel("Task 이름", { exact: true })).toHaveValue("오버레이 동작 점검");
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await page.screenshot({ path: info.outputPath("task-document.png") });
});

test("Routine opens readable instructions, preserves drafts on cancel, and discards only after confirmation", async ({ page }, info) => {
  const writes = await fixture(page);
  await page.goto("/?view=routines");
  await page.locator(".routine-expand").click();
  const routine = page.locator(".routine-card").filter({ has: page.locator(".routine-expand") });
  await expect(routine.locator(".routine-document-body")).toContainText("고객 피드백 확인");
  await expect(routine.locator(".routine-guide-grid")).toHaveCount(0);
  await routine.getByRole("button", { name: "변경", exact: true }).click();
  const editor = page.locator(".document-properties-editor");
  await editor.getByLabel("트리거 포인트", { exact: true }).fill("월요일 아침");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "계속 작성", exact: true }).click();
  await expect(editor.getByLabel("트리거 포인트", { exact: true })).toHaveValue("월요일 아침");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "변경사항 버리기", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await routine.getByRole("button", { name: "변경", exact: true }).click();
  await expect(editor.getByLabel("트리거 포인트", { exact: true })).toHaveValue("금요일 오후");
  expect(writes).toEqual([]);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath("routine-document.png") });
});

test("document and edit dialog fit narrow, wide and enlarged text layouts", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(180_000);
  await fixture(page);
  for (const width of [320, 390, 768, 1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?view=work&project=project-1");
    const panel = page.locator(".project-detail-panel");
    await expect(panel).toBeVisible();
    for (const size of ["100%", "200%"]) {
      await page.evaluate(size => document.documentElement.style.fontSize = size, size);
      await fits(page, panel);
      await panel.locator(".document-properties").getByRole("button", { name: "변경", exact: true }).click();
      const editor = page.locator(".document-properties-editor");
      await editor.getByLabel("Project 이름", { exact: true }).fill("고객 경험과 운영 품질 개선 Project 2026 ".repeat(8));
      await editor.getByLabel("기한", { exact: true }).focus();
      await fits(page, editor);
      await page.keyboard.press("Escape");
      await fits(page, panel);
    }
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await page.screenshot({ path: info.outputPath(`document-${width}.png`) });
  }
});

test("document palette contrast and Korean/Latin/numeral fonts follow all themes", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  test.setTimeout(120_000);
  await fixture(page);
  await page.goto("/?view=work&project=project-1");
  const panel = page.locator(".project-detail-panel");
  await panel.locator(".document-properties").getByRole("button", { name: "속성", exact: true }).click();
  for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
    await page.locator("html").evaluate((node, theme) => node.dataset.theme = theme, theme);
    expect((await new AxeBuilder({ page: page as never }).include(".project-detail-panel").withRules(["color-contrast"]).analyze()).violations, theme).toEqual([]);
    await panel.locator(".document-properties").getByRole("button", { name: "변경", exact: true }).click();
    expect((await new AxeBuilder({ page: page as never }).include(".document-properties-editor").withRules(["color-contrast"]).analyze()).violations, theme).toEqual([]);
    await page.keyboard.press("Escape");
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  await page.evaluate(() => document.fonts.ready);
  const doc = await cdp.send("DOM.getDocument");
  for (const selector of [".document-title", ".document-property-list dt", ".project-progress-value strong"]) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every(font => font.isCustomFont && /Pretendard/.test(font.familyName))).toBe(true);
  }
  await cdp.detach();
});

test("Viewers read Project, Task and Routine properties without editing controls", async ({ page }) => {
  const writes = await fixture(page, true);
  for (const route of ["/?view=work&project=project-1", "/?view=inbox&task=task-1", "/?view=routines"]) {
    await page.goto(route);
    if (route.includes("routines")) await page.locator(".routine-expand").click();
    const properties = page.locator(".document-properties");
    await expect(properties).toBeVisible();
    await expect(properties.getByRole("button", { name: "변경", exact: true })).toHaveCount(0);
    await properties.getByRole("button", { name: "속성", exact: true }).click();
    await expect(properties.locator("dl")).toBeVisible();
  }
  expect(writes).toEqual([]);
});
