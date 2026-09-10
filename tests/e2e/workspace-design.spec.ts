import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { installLandingProductFixture } from "./landing-product-fixture";
import { THEMES } from "../../lib/themes";

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chromium");
  await installLandingProductFixture(page);
});

async function pageFits(page: Page, context: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), context).toBeLessThanOrEqual(1);
  const escaped = await page.locator([
    ".page-header h1", ".page-header p", ".page-header button",
    ".routine-card b", ".routine-card header button", ".my-work-item-title",
    ".home-okr-chat h2", ".home-okr-chat .user-message", ".home-okr-chat .assistant-message",
    ".daily-editor h2", ".daily-new-task input", ".daily-task-option b", ".kr-data-card h2",
  ].join(", ")).evaluateAll((elements) => elements.filter((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1);
  }).map((element) => ({ selector: element.className, text: element.textContent?.slice(0, 80) })));
  expect(escaped, context).toEqual([]);
  const clippedNavigation = await page.locator(".mobile-navigation button, .mobile-navigation button span").evaluateAll((elements) => elements.filter((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > innerWidth + 1 || box.top < 0 || box.bottom > innerHeight + 1 || element.scrollWidth > element.clientWidth + 1);
  }).map((element) => element.textContent));
  expect(clippedNavigation, `${context}/mobile navigation`).toEqual([]);
}

test("home action stays singular and centered across desktop and mobile topbars", async ({ page }, info) => {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?view=work");

    const desktopHome = page.locator(".workspace-brand");
    const mobileHome = page.locator(".workspace-mobile-home");
    const visibleHome = width <= 700 ? mobileHome : desktopHome;
    await expect(visibleHome).toBeVisible();
    await expect(width <= 700 ? desktopHome : mobileHome).toBeHidden();

    const geometry = await visibleHome.evaluate((button) => {
      const icon = button.querySelector("svg");
      if (!icon) throw new Error("Home action icon is missing");
      const buttonBox = button.getBoundingClientRect();
      const iconBox = icon.getBoundingClientRect();
      return {
        xDelta: Math.abs((buttonBox.left + buttonBox.width / 2) - (iconBox.left + iconBox.width / 2)),
        yDelta: Math.abs((buttonBox.top + buttonBox.height / 2) - (iconBox.top + iconBox.height / 2)),
      };
    });
    expect(geometry.xDelta, `${width}px horizontal centering`).toBeLessThanOrEqual(0.5);
    expect(geometry.yDelta, `${width}px vertical centering`).toBeLessThanOrEqual(0.5);
    await page.screenshot({ path: info.outputPath(`home-action-${width}.png`) });
  }
});

test("working views share document layout and stable typography from 320px to 4K", async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [320, 390, 768, 1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ["my_work", "okr", "work", "inbox", "routines", "scrum", "reviews", "billing", "data", "recommendations"]) {
      await page.goto(`/?view=${view}`);
      await expect(page.locator(".page-header h1")).toBeVisible();
      await pageFits(page, `${width}/${view}`);
      expect(await page.locator(".page-header h1").evaluate((node) => getComputedStyle(node).fontSize)).toBe("24px");
      // OKR deliberately starts at Objective without repeating a page subtitle.
      if (view === "okr") await expect(page.locator(".page-header p")).toHaveCount(0);
      else expect(await page.locator(".page-header p").evaluate((node) => getComputedStyle(node).fontSize)).toBe("16px");
      expect((await page.locator(".page-body").boundingBox())!.width).toBeLessThanOrEqual(1200);
      if (view === "work") {
        expect(await page.locator(".project-workspace").evaluate((node) => {
          const css = getComputedStyle(node);
          return { border: css.borderTopWidth, shadow: css.boxShadow, radius: css.borderRadius };
        })).toEqual({ border: "0px", shadow: "none", radius: "0px" });
      }
      if (width === 390 || width === 1440) await page.screenshot({ path: info.outputPath(`${view}-${width}.png`), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});

test("long titles, 200 percent user text and local Korean Latin numeral fonts stay readable", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const fonts = new Set<string>();
  page.on("request", (request) => { if (request.resourceType() === "font") fonts.add(request.url()); });
  await page.goto("/?view=my_work");
  const title = page.locator(".page-header h1");
  await expect(title).toBeVisible();
  await title.evaluate((node) => { node.textContent = "이번 주의 목표와 성과 OKRI 2026"; });
  await page.evaluate(() => document.fonts.ready);
  const client = await context.newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument");
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".page-header h1" });
  const rendered = await client.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(rendered.fonts.length).toBeGreaterThan(0);
  for (const font of rendered.fonts) {
    expect(font.isCustomFont).toBe(true);
    expect(font.familyName).toContain("Pretendard");
  }
  expect(fonts.size).toBeGreaterThan(0);
  expect(fonts.size).toBeLessThan(92);
  for (const url of fonts) expect(new URL(url).origin).toBe(new URL(page.url()).origin);
  await client.detach();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ["my_work", "work", "routines", "scrum", "data"]) {
      await page.goto(`/?view=${view}`);
      await expect(page.locator(".page-header h1")).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
        const heading = document.querySelector(".page-header h1")!;
        heading.textContent = "고객의 첫 경험부터 팀의 성과까지 연결하는 긴 제목";
        for (const node of document.querySelectorAll(".routine-card b, .my-work-item-title")) node.textContent = "고객의 피드백을 확인하고 다음 제품 개선에 반영하기";
      });
      await pageFits(page, `large text/${width}/${view}`);
      await page.screenshot({ path: info.outputPath(`large-text-${view}-${width}.png`), fullPage: true });
    }
  }
});

test("workspace settings keep headings and keyboard close controls separate at enlarged text", async ({ page }, info) => {
  test.setTimeout(180_000);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const tab of ["general", "members", "groups", "projects", "integrations"]) {
      await page.goto(`/?settings=workspace&tab=${tab}`);
      const dialog = page.getByRole("dialog", { name: "워크스페이스 설정" });
      await expect(dialog).toBeVisible();
      for (const size of [100, 200]) {
        await page.evaluate((percent) => { document.documentElement.style.fontSize = `${percent}%`; }, size);
        const geometry = await dialog.evaluate((element) => {
          const header = element.querySelector(".workspace-settings-header")!.getBoundingClientRect();
          const body = element.querySelector(".workspace-settings-layout")!.getBoundingClientRect();
          const close = element.querySelector(".workspace-settings-header button")!.getBoundingClientRect();
          return { overlap: header.bottom > body.top + 1, closeOutside: close.left < 0 || close.right > innerWidth, overflow: element.scrollWidth > element.clientWidth + 1 };
        });
        expect(geometry, `${width}/${tab}/${size}`).toEqual({ overlap: false, closeOutside: false, overflow: false });
      }
      if (width !== 390) await page.screenshot({ path: info.outputPath(`settings-${tab}-${width}.png`), fullPage: true });
      const close = dialog.getByRole("button", { name: "워크스페이스 설정 닫기" });
      await close.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
    }
  }
});

test("conversation paragraphs use readable themed surfaces without nested frames", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.goto("/?view=work");
  await page.getByRole("button", { name: "AI 대화로 추가", exact: true }).click();
  const chat = page.locator(".home-okr-chat");
  await expect(chat).toBeVisible();
  await expect(chat.locator(".user-message").first()).toBeVisible();
  for (const { mode } of THEMES) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, mode);
    const results = await new AxeBuilder({ page: page as never }).include(".home-okr-chat").withRules(["color-contrast"]).analyze();
    expect(results.violations, mode).toEqual([]);
    expect(await chat.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe("0px");
    expect(await chat.locator(".assistant-message").first().evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  }
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "white"; document.documentElement.style.fontSize = "200%"; });
    await pageFits(page, `conversation/${width}`);
    await page.screenshot({ path: info.outputPath(`conversation-${width}.png`), fullPage: true });
  }
});
