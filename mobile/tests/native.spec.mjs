import { test, expect } from "../../node_modules/@playwright/test/index.mjs";
import { mkdir } from "node:fs/promises";
const screenshots = new URL("../test-results/screenshots/", import.meta.url);
test.beforeEach(async ({ page }) => {
  await page.route("**/*", route => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort();
  });
});
test("native screens render, preserve failed drafts, and submit once", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?lang=en");
  await expect(page.getByText("Categorize signup failures", { exact: true })).toBeVisible();
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: new URL("today-en.png", screenshots).pathname.replace(/^\/([A-Z]:)/, "$1") });
  await page.getByRole("tab", { name: /Daily/i }).click();
  await expect(page.getByText("Operations review", { exact: true }).first()).toBeVisible();
  const add = page.getByRole("button", { name: /Add Task/i }).last();
  await add.click();
  await page.getByRole("textbox", { name: "Task title" }).fill("Verify native daily add");
  await page.evaluate(() => { globalThis.__OKRI_PREVIEW__.failure = 500; });
  await page.getByRole("button", { name: /Add.*today/i }).click();
  await expect(page.getByRole("textbox", { name: "Task title" })).toHaveValue("Verify native daily add");
  await page.getByRole("button", { name: /Add.*today/i }).click();
  await expect(page.getByRole("checkbox", { name: "Verify native daily add", exact: true }).last()).toBeChecked();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByText("Submitted.", { exact: true })).toBeVisible();
  const writes = await page.evaluate(() => globalThis.__OKRI_PREVIEW__.writes);
  assertWrites(writes);
  expect(errors).toEqual([]);
});
function assertWrites(writes) {
  const adds = writes.filter(w => w.path.endsWith("/tasks"));
  expect(adds).toHaveLength(2); expect(adds[0].body.requestId).toBe(adds[1].body.requestId);
  expect(writes.filter(w => w.path.endsWith("/submit"))).toHaveLength(1);
}
test("five languages, six themes and narrow/wide screens fit with the bundled font", async ({ page }) => {
  await mkdir(screenshots, { recursive: true });
  for (const lang of ["ko", "en", "ja", "zh", "es"]) for (const theme of ["white", "beige", "gray", "dark", "neon", "cyberpunk"]) {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(`/?lang=${lang}&theme=${theme}`);
    await expect(page.getByText("OKRI Studio", { exact: true }).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, font: document.fonts.check('16px "Pretendard"'), text: document.body.innerText }));
    expect(result.overflow, lang + theme).toBe(false); expect(result.font).toBe(true);
    if (lang !== "ko") expect(result.text).not.toMatch(/[가-힣]/);
  }
  for (const width of [390, 768, 1440, 1920, 3840]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto("/?lang=en");
    await expect(page.getByText("Categorize signup failures", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
test("native project creation retains parent cycle and task status choices match the API", async ({ page }) => {
  await page.goto("/?lang=en");
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Native project");
  await page.getByRole("combobox").first().selectOption("i");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Native project", { exact: true })).toBeVisible();
  const write = await page.evaluate(() => globalThis.__OKRI_PREVIEW__.writes.find(w => w.path === "/api/items" && w.method === "POST"));
  expect(write.body.parentId).toBe("i"); expect(write.body.cycleId).toBe("cycle");
  await page.getByRole("tab", { name: "My work", exact: true }).click();
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  const status = page.getByRole("combobox", { name: "Status", exact: true });
  expect(await status.locator("option").evaluateAll(options => options.map(o => o.value))).toEqual(["todo", "done"]);
});
test("schedule and OKR tree open with keyboard-accessible controls", async ({ page }) => {
  await page.goto("/?lang=en");
  await page.getByRole("tab", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: /Gantt/i }).click();
  await expect(page.getByText("Today to due date", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.screenshot({ path: new URL("gantt-en.png", screenshots).pathname.replace(/^\/([A-Z]:)/, "$1") });
  await page.goto("/?lang=ko&theme=dark");
  await page.getByRole("tab", { name: "더보기", exact: true }).click();
  await page.getByRole("button", { name: "OKR", exact: true }).click();
  await expect(page.getByText("고객이 제품의 가치를 빠르게 경험하게 한다", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "접기", exact: true }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "펼치기", exact: true })).toBeVisible();
  await page.screenshot({ path: new URL("okr-ko-dark.png", screenshots).pathname.replace(/^\/([A-Z]:)/, "$1") });
});
