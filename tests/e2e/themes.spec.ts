import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Locator } from "@playwright/test";
import { THEMES, themeCss, THEME_STORAGE_KEY } from "../../lib/themes";
import { installApiMocks, json } from "./api-mocks";

const styles = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

async function readable(page: Page, context: string) {
  const results = await new AxeBuilder({ page: page as never }).withRules(["color-contrast"]).analyze();
  const failures = results.violations.flatMap((violation) => violation.nodes.map((node) => ({ target: node.target, html: node.html, reason: node.failureSummary })));
  expect(failures, context).toEqual([]);
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

async function openThemeSettings(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.getByRole("button", { name: "더보기", exact: true }).click();
    await page.locator(".mobile-account-entry").click();
  } else await page.locator(".sidebar .profile-row").click();
  await expect(page.getByRole("dialog", { name: "내 설정" })).toBeVisible();
}

async function contrastOf(locator: Locator) {
  return locator.evaluate((element) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const foreground = parse(getComputedStyle(element).color);
    let current: Element | null = element;
    let background: number[] = [];
    while (current) {
      background = parse(getComputedStyle(current).backgroundColor);
      if (background.length === 3 || background[3] === 1) break;
      current = current.parentElement;
    }
    const luminance = (rgb: number[]) => {
      const c = rgb.slice(0, 3).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
    };
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
}

for (const theme of THEMES) {
  test(`theme matrix ${theme.mode}: screens, dialogs, persistence and native scheme`, async ({ page, isMobile }, testInfo) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installApiMocks(page, { teamWorkspace: true, slackState: "connected" });
    await page.addInitScript(({ key, mode }) => localStorage.setItem(key, mode), { key: THEME_STORAGE_KEY, mode: theme.mode });
    for (const view of ["okr", "work", "inbox", "routines", "my_work", "scrum", "integrations", "billing", "data", "recommendations"]) {
      await page.goto(`/?view=${view}`);
      await expect(page.locator(".workspace")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.mode);
      expect(await page.locator("html").evaluate((root) => getComputedStyle(root).colorScheme)).toBe(theme.colorScheme);
      await noOverflow(page);
      await readable(page, `${theme.mode}/${view}`);
      if (view === "okr") {
        const kr = page.locator("button.okr-tree-kr-row").first();
        if (await kr.count()) {
          await kr.click();
          await readable(page, `${theme.mode}/expanded OKR`);
          await noOverflow(page);
          await kr.click();
        }
        await page.screenshot({ path: testInfo.outputPath(`${theme.mode}-okr.png`), fullPage: false });
      }
      if (view === "inbox") {
        await page.getByRole("button", { name: "직접 추가", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await readable(page, `${theme.mode}/Task create`);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "AI 대화로 추가", exact: true }).click();
        await expect(page.locator(".chat-input textarea").first()).toBeVisible();
        await page.locator(".chat-input textarea").first().fill("이번 주 안내문 작성");
        await readable(page, `${theme.mode}/AI conversation`);
        await noOverflow(page);
      }
      if (view === "work" || view === "routines") {
        await page.getByRole("button", { name: "직접 추가", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await readable(page, `${theme.mode}/${view} create dialog`);
        await noOverflow(page);
        await page.keyboard.press("Escape");
      }
    }
    await page.goto("/?settings=workspace&tab=members");
    await expect(page.getByRole("dialog", { name: "워크스페이스 설정" })).toBeVisible();
    await readable(page, `${theme.mode}/workspace settings`);
    await page.keyboard.press("Escape");
    await openThemeSettings(page, isMobile);
    await expect(page.locator(".theme-picker button")).toHaveCount(6);
    const selected = page.locator('.theme-picker button[aria-pressed="true"]');
    await expect(selected).toContainText(theme.label);
    for (const box of await page.locator(".theme-picker button").evaluateAll((buttons) => buttons.map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })))) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await readable(page, `${theme.mode}/theme settings`);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${theme.mode}-settings.png`), fullPage: false });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "내 설정" })).toHaveCount(0);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.mode);
    // A distinct document URL models arrival from an external invitation link.
    await page.goto(`/?theme-qa=invitation#invite=${"a".repeat(64)}`);
    await expect(page.getByRole("dialog", { name: "워크스페이스 초대" })).toBeVisible();
    await readable(page, `${theme.mode}/invitation`);
    await page.route("**/api/auth/session", (route) => json(route, { user: null }, 401));
    await page.route("**/api/bootstrap?**", (route) => json(route, { error: "unauthenticated" }, 401));
    await page.goto("/");
    await expect(page.locator(".landing-shell")).toBeVisible();
    await readable(page, `${theme.mode}/login`);
    expect(errors, "No runtime errors across theme screens").toEqual([]);
  });

  test(`theme controls ${theme.mode}: primary, secondary, danger, focus, disabled and busy`, async ({ page }) => {
    await page.setContent(`<html data-theme="${theme.mode}"><body><main style="padding:40px;display:grid;gap:30px"><button class="primary-action">저장</button><button class="secondary">취소</button><div class="overlay-confirm"><footer><button class="danger">삭제</button></footer></div><div class="chat-input" style="position:relative;height:80px"><button class="chat-send-button">보내기</button></div></main></body></html>`);
    await page.addStyleTag({ content: `${themeCss}\n${styles}` });
    for (const name of ["저장", "취소", "삭제", "보내기"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect.poll(() => contrastOf(button)).toBeGreaterThanOrEqual(4.5);
      await button.hover();
      await expect.poll(() => contrastOf(button)).toBeGreaterThanOrEqual(4.5);
      await page.mouse.down();
      await expect.poll(() => contrastOf(button)).toBeGreaterThanOrEqual(4.5);
      await page.mouse.up();
      await button.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
      await button.evaluate((element) => { element.setAttribute("disabled", ""); element.setAttribute("aria-busy", "true"); });
      await expect.poll(() => contrastOf(button)).toBeGreaterThanOrEqual(3);
      expect(await button.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      // Sample every animation frame, not only the settled colors. Background and
      // foreground must never interpolate through an unreadable enabled state.
      const frames = await button.evaluate(async (element) => {
        element.removeAttribute("disabled");
        element.removeAttribute("aria-busy");
        const frames: Array<{ color: string; background: string; transition: string }> = [];
        for (let i = 0; i < 15; i++) {
          await new Promise(requestAnimationFrame);
          const style = getComputedStyle(element);
          frames.push({ color: style.color, background: style.backgroundColor, transition: style.transitionProperty });
        }
        return frames;
      });
      expect(new Set(frames.map(({ color, background }) => `${color}/${background}`)).size).toBe(1);
      for (const frame of frames) expect(frame.transition).not.toMatch(/(^|,\s*)(all|color|background-color|opacity)(,|$)/);
      expect(await contrastOf(button)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test(`theme editor ${theme.mode}: picker, saved preference, editor and menus`, async ({ page, isMobile }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installApiMocks(page, { preserveStorage: true });
    await page.goto("/?view=work");
    await expect(page.locator(".workspace")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "white");
    await openThemeSettings(page, isMobile);
    const choice = page.locator(".theme-picker button").filter({ hasText: theme.label });
    await choice.focus();
    await page.keyboard.press("Enter");
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.mode);
    expect(await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)).toBe(theme.mode);
    await page.keyboard.press("Escape");
    await page.goto("/?view=work&project=project-1");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.mode);
    const editor = page.locator(".project-block-editor .bn-editor");
    await expect(editor).toBeVisible();
    await expect(page.locator(".project-block-editor .bn-container")).toHaveAttribute("data-color-scheme", theme.colorScheme);
    expect(await editor.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(await page.locator("html").evaluate((root) => {
      const probe = document.createElement("i");
      probe.style.backgroundColor = getComputedStyle(root).getPropertyValue("--bg-page");
      root.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }));
    expect(await contrastOf(editor)).toBeGreaterThanOrEqual(4.5);
    await page.locator(".project-document-section").getByRole("button", { name: "변경", exact: true }).click();
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.click();
    await page.keyboard.type("/");
    await expect(page.getByRole("listbox")).toBeVisible();
    expect(await page.getByRole("listbox").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(await page.locator("html").evaluate((root) => {
      const probe = document.createElement("i");
      probe.style.backgroundColor = getComputedStyle(root).getPropertyValue("--bg-raised");
      root.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }));
    await readable(page, `${theme.mode}/editor slash menu`);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${theme.mode}-editor.png`) });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    expect(errors, "No editor runtime errors").toEqual([]);
  });

  test(`theme administration ${theme.mode}: expanded setup, disabled members and danger zone`, async ({ page }) => {
    test.setTimeout(90_000);
    await installApiMocks(page, { teamWorkspace: true, slackState: "setup_required", slackSetupComplete: false });
    await page.addInitScript(({ key, mode }) => localStorage.setItem(key, mode), { key: THEME_STORAGE_KEY, mode: theme.mode });
    await page.goto("/?settings=workspace&tab=integrations&bot=daily");
    await expect(page.getByRole("heading", { name: "데일리 설정" })).toBeVisible();
    // Unmatched member labels must stay readable as well as the disabled input.
    await page.locator(".slack-onboarding-members label").first().evaluate((element) => {
      element.classList.add("disabled");
      element.querySelector("input")!.disabled = true;
    });
    await readable(page, `${theme.mode}/daily onboarding`);
    await page.getByRole("button", { name: /^관리 봇/ }).click();
    await expect(page.locator(".management-bot-config")).toBeVisible();
    await page.locator(".management-bot-config summary").click();
    await readable(page, `${theme.mode}/management settings`);
    await page.getByRole("button", { name: "위험 구역", exact: true }).click();
    await readable(page, `${theme.mode}/danger settings`);
    await noOverflow(page);
  });
}
