import { expect, test } from '@playwright/test';
import { installApiMocks } from './api-mocks';

test('balanced density preserves body type and does not inflate at wide widths', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-chromium');
  test.setTimeout(90_000);
  await installApiMocks(page, { teamWorkspace: true, slackState: 'connected', withRoutine: true });
  const measurements = [];
  for (const width of [1440, 1920, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/?view=work');
    await expect(page.locator('.page-header h1')).toBeVisible();
    const density = await page.evaluate(() => {
      const height = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height;
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return { body: style('body').fontSize, title: style('.page-header h1').fontSize,
        nav: height('.desktop-navigation .nav-item'), action: height('.page-create-actions button'),
        inset: style('.page-body').paddingTop, headingGap: style('.page-header').marginBottom };
    });
    expect(density).toEqual({ body: '16px', title: '28px', nav: 36, action: 36, inset: '32px', headingGap: '24px' });
    const search = page.getByRole('textbox', { name: 'Project 검색' });
    expect(await search.evaluate((input: HTMLInputElement) => {
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = getComputedStyle(input).font;
      return input.clientWidth >= context.measureText(input.placeholder).width;
    })).toBe(true);
    expect((await page.locator('.date-cell').first().boundingBox())!.width).toBeGreaterThanOrEqual(160);
    measurements.push(density);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  for (const density of measurements) expect(density).toEqual(measurements[0]);
  for (const view of ['my_work', 'okr', 'work']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/?view=${view}`);
    await expect(page.locator('.page-header h1')).toBeVisible();
    if (view === 'okr') {
      await page.locator('button.okr-tree-kr-row').first().click();
      await page.locator('button.okr-tree-initiative-row').first().click();
    }
    await page.screenshot({ path: info.outputPath(`balanced-${view}.png`), fullPage: true });
  }
  await page.goto('/?view=work&settings=workspace&tab=general');
  await expect(page.getByRole('dialog', { name: '워크스페이스 설정' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('balanced-settings.png'), fullPage: true });
});

test('touch layouts keep comfortable targets without shrinking editable text', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-chromium');
  await installApiMocks(page, { teamWorkspace: true });
  await page.goto('/?view=work');
  const add = page.getByRole('button', { name: '직접 추가', exact: true });
  await expect(add).toBeVisible();
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await add.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (const field of await dialog.locator('input:visible:not([type=checkbox]):not([type=radio]), select:visible, textarea:visible').all()) {
    expect(await field.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('selection and completion keep separate hit areas at normal and larger text sizes', async ({ page, isMobile }) => {
  await installApiMocks(page);
  await page.goto('/?view=inbox');
  await page.getByRole('button', { name: '선택', exact: true }).click();
  const row = page.locator('.task-list-row.deletion-selectable').first();
  const selection = row.locator('.delete-select');
  const completion = row.locator('.task-list-check');
  for (const scale of isMobile ? [100] : [100, 200]) {
    await page.addStyleTag({ content: `html { font-size: ${scale}% !important; }` });
    const selectBox = (await selection.boundingBox())!;
    const completeBox = (await completion.boundingBox())!;
    const titleBox = (await row.locator('.task-list-open').boundingBox())!;
    expect(completeBox.x - selectBox.x - selectBox.width).toBeGreaterThanOrEqual(3);
    expect(titleBox.x - completeBox.x - completeBox.width).toBeGreaterThanOrEqual(3);
    await selection.click();
    await expect(selection.locator('input')).toBeChecked();
    await expect(completion).not.toHaveClass(/checked/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await selection.click();
    await expect(selection.locator('input')).not.toBeChecked();
  }
});
