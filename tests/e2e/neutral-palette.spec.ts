import { expect, test } from "@playwright/test";
import { installLandingProductFixture } from "./landing-product-fixture";

function neutral(value: string, label: string) {
  const colors = [...value.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g)];
  expect(colors.length, label).toBeGreaterThan(0);
  for (const [, red, green, blue] of colors) expect(new Set([red, green, blue]).size, `${label}: ${value}`).toBe(1);
}

test("White actions, selections and native checkboxes use the ink palette", async ({ page }, info) => {
  await installLandingProductFixture(page);
  await page.goto("/?view=work");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "white");
  const action = page.getByRole("button", { name: "직접 추가", exact: true });
  await expect(action).toBeVisible();
  for (const state of ["default", "hover", "focus", "active"]) {
    if (state === "hover") await action.hover();
    if (state === "focus") await action.focus();
    if (state === "active") await page.mouse.down();
    const colors = await action.evaluate(node => {
      const s = getComputedStyle(node);
      return { text: s.color, background: s.backgroundColor, outline: s.outlineColor };
    });
    for (const [role, value] of Object.entries(colors)) neutral(value, `${state}/${role}`);
    if (state === "active") { await page.mouse.move(0, 0); await page.mouse.up(); }
  }
  await page.screenshot({ path: info.outputPath("neutral-project.png") });
  await page.goto("/?view=my_work");
  const completed = page.getByRole("checkbox", { name: "완료 포함" });
  await completed.check();
  neutral(await completed.evaluate(node => getComputedStyle(node).accentColor), "checked control");
  for (const selector of [".app-shell", ".sidebar", ".my-work-sort button[aria-pressed='true']"]) {
    neutral(await page.locator(selector).evaluate(node => getComputedStyle(node).backgroundColor), selector);
  }
  await page.screenshot({ path: info.outputPath("neutral-my-work.png") });
});

test("Task and settings drawers do not tint the page blue", async ({ page }, info) => {
  await installLandingProductFixture(page);
  for (const [route, selector, name] of [
    ["/?view=my_work&task=task-1", ".task-detail-panel", "task"],
    ["/?settings=workspace&tab=general", ".workspace-settings-panel", "settings"],
  ]) {
    await page.goto(route);
    const panel = page.locator(selector);
    await expect(panel).toBeVisible();
    if (name === "task") await expect(panel.locator(".bn-editor")).toBeVisible();
    const colors = await panel.evaluate(node => {
      const s = getComputedStyle(node);
      return { background: s.backgroundColor, shadow: s.boxShadow, text: s.color };
    });
    for (const [role, value] of Object.entries(colors)) neutral(value, `${name}/${role}`);
    neutral(await page.locator("dialog[open]").evaluate(node => getComputedStyle(node, "::backdrop").backgroundColor), `${name}/backdrop`);
    await page.screenshot({ path: info.outputPath(`neutral-${name}.png`) });
  }
});
