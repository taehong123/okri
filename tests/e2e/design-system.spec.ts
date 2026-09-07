import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { THEMES, THEME_STORAGE_KEY } from "../../lib/themes";
import { installApiMocks } from "./api-mocks";

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;

for (const theme of THEMES) {
  test(`aligned hierarchy and progress follow ${theme.mode}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await installApiMocks(page, { teamWorkspace: true });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: THEME_STORAGE_KEY, value: theme.mode });
    await page.goto("/?view=okr");
    await expect(page.locator(".okr-file-read-surface")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.locator("button.okr-tree-kr-row").first().click();
    const initiative = page.locator("button.okr-tree-initiative-row").first();
    if (await initiative.count()) await initiative.click();
    const project = page.locator("button.okr-tree-project-main").first();
    if (await project.count()) await project.click();

    const colors = await page.evaluate(() => {
      const color = (selector: string, property: "color" | "borderLeftColor") => getComputedStyle(document.querySelector(selector)!)[property];
      return {
        badge: color(".type-key_result", "color"), rail: color(".okr-file-read-kr", "borderLeftColor"),
        initiativeBadge: color(".type-initiative", "color"), initiativeRail: color(".okr-file-read-initiative", "borderLeftColor"),
        progress: color(".okr-tree-progress", "color"),
      };
    });
    expect(colors.badge).toBe(rgb(theme.tokens["kr-badge-text"]));
    expect(colors.rail).toBe(colors.badge);
    expect(colors.initiativeBadge).toBe(rgb(theme.tokens["initiative-badge-text"]));
    expect(colors.initiativeRail).toBe(colors.initiativeBadge);
    expect(colors.progress).toBe(colors.badge);
    const inspectAlignment = () => page.evaluate(() => {
      const left = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().left;
      const frame = document.querySelector(".page-body")!.getBoundingClientRect();
      return {
        title: left(".page-header h1"), objective: left(".okr-file-read-objective"),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        escaped: [...document.querySelectorAll(".okr-tree-row, .okr-tree-task")].filter((row) => {
          const box = row.getBoundingClientRect();
          return box.left < frame.left || box.right > frame.right;
        }).length,
        collisions: [...document.querySelectorAll(".okr-tree-row")].filter((row) => {
          const title = row.querySelector(".okr-tree-copy")!.getBoundingClientRect();
          return [...row.querySelectorAll(".okr-tree-count, .okr-tree-progress")].some((meta) => {
            const box = meta.getBoundingClientRect();
            return box.left < title.right - 1 && box.right > title.left + 1 && box.top < title.bottom - 1 && box.bottom > title.top + 1;
          });
        }).length,
      };
    });
    const alignment = await inspectAlignment();
    expect(alignment.title).toBeCloseTo(alignment.objective);
    expect(alignment.overflow).toBe(false);
    expect(alignment.escaped).toBe(0);
    expect(alignment.collisions).toBe(0);
    const axe = await new AxeBuilder({ page: page as never }).withRules(["color-contrast"]).analyze();
    expect(axe.violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${theme.mode}-hierarchy.png`), fullPage: true });
    await page.locator(".okr-tree-copy strong").evaluateAll((titles) => {
      for (const title of titles) title.textContent = "고객 경험 개선을 위한 긴 업무 제목과 담당 범위 확인 ".repeat(4);
    });
    await page.locator(".okr-file-read-objective h3").evaluate((title) => { title.textContent = "고객 경험 개선을 위한 긴 목표 제목 OKR 2026 ".repeat(4); });
    const longTitles = await inspectAlignment();
    expect(longTitles.overflow).toBe(false);
    expect(longTitles.escaped).toBe(0);
    expect(longTitles.collisions).toBe(0);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    const objectiveLayout = await page.locator(".okr-file-read-objective").evaluate((row) => {
      const title = row.querySelector("h3")!.getBoundingClientRect();
      const edit = row.querySelector("button")!.getBoundingClientRect();
      return { overlap: title.right > edit.left, overflow: row.scrollWidth > row.clientWidth, target: Math.min(edit.width, edit.height) };
    });
    expect(objectiveLayout.overlap).toBe(false);
    expect(objectiveLayout.overflow).toBe(false);
    expect(objectiveLayout.target).toBeGreaterThanOrEqual(44);

    await page.goto("/?view=work");
    await page.getByRole("tab", { name: "카드", exact: true }).click();
    const bar = page.locator(".project-card-progress i").first();
    await expect(bar).toBeAttached();
    expect(await bar.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(rgb(theme.tokens["progress-fill"]));
  });
}

test("Korean and Latin glyphs render from local subsets without viewport font scaling", async ({ page, context }) => {
  const fonts = new Set<string>();
  page.on("request", (request) => { if (request.resourceType() === "font") fonts.add(request.url()); });
  await installApiMocks(page, { teamWorkspace: true });
  await page.goto("/?view=okr");
  const heading = page.locator(".okr-file-read-objective h3");
  await expect(heading).toBeVisible();
  await heading.evaluate((element) => { element.textContent = "고객 경험 개선 OKR 2026"; });
  await page.evaluate(() => document.fonts.ready);
  const client = await context.newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument");
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".okr-file-read-objective h3" });
  const rendered = await client.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(rendered.fonts.length).toBeGreaterThan(0);
  for (const font of rendered.fonts) {
    expect(font.isCustomFont).toBe(true);
    expect(font.familyName).toContain("Pretendard");
  }
  expect(fonts.size).toBeGreaterThan(0);
  expect(fonts.size).toBeLessThan(92);
  for (const font of fonts) expect(new URL(font).origin).toBe(new URL(page.url()).origin);
  for (const width of [320, 390, 768, 1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator("body").evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
    expect(await page.locator(".page-body").evaluate((element) => getComputedStyle(element).paddingLeft)).toBe(width <= 980 ? "16px" : "32px");
    expect(await heading.evaluate((element) => getComputedStyle(element).letterSpacing)).toBe("normal");
  }
  await client.detach();
});
