import { expect, test, type Page } from '@playwright/test';
import { installApiMocks, json } from './api-mocks';

const views = ['my_work', 'okr', 'work', 'inbox', 'routines', 'data', 'scrum', 'recommendations', 'reviews', 'trash', 'integrations', 'billing'];
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const smallFields = await page.evaluate(() => {
    const baseline = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=color]):not([type=button]):not([type=submit]), select, textarea')]
      .filter(el => el.getClientRects().length && parseFloat(getComputedStyle(el).fontSize) < baseline - .01)
      .map(el => el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.className || el.tagName);
  });
  expect(smallFields, 'Editable values use the body text size').toEqual([]);
}

for (const width of [320, 390, 768, 1440, 1920, 2560, 3840]) {
  test(`readability ${width}: existing screens, font roles and safe targets`, async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-chromium', 'Viewport matrix is sequential in one browser project.');
    test.setTimeout(180_000);
    page.setDefaultTimeout(8_000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : width >= 2560 ? 1440 : 1000 });
    await installApiMocks(page, { teamWorkspace: true, slackState: 'connected', withRoutine: true });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const scale = 1;
    for (const view of views) {
      await page.goto(`/?view=${view}`);
      await expect(page.locator('.workspace')).toBeVisible();
      await expect(page.locator('.page-header h1')).toBeVisible();
      await fits(page);
      expect(await page.locator('body').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(16 * scale);
      expect(await page.locator('.page-header h1').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(24 * scale);
      const navLabel = page.locator('.nav-item span:visible').first();
      expect(await navLabel.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(14 * scale);
      if (view === 'my_work') {
        const title = page.locator('.my-work-item b').first();
        await expect(title).toBeVisible();
        expect(await title.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(16 * scale);
        await title.evaluate(el => { el.textContent = '고객 경험을 개선하기 위한 긴 한글 업무 제목과 담당자 확인 작업 '.repeat(4); });
        expect(await title.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      }
      if (view === 'work') {
        await page.getByRole('tab', { name: '테이블', exact: true }).click();
        // No custom properties must still produce all seven existing columns.
        expect(await page.locator('.task-table-row').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(7);
        await page.getByRole('tab', { name: '카드', exact: true }).click();
        await page.getByRole('button', { name: '선택', exact: true }).click();
        const selection = page.locator('.project-card .delete-select').first();
        await expect(selection).toBeVisible();
        const box = await selection.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(await selection.locator('span').evaluate(el => el.getBoundingClientRect().width)).toBe(18);
        await selection.click();
        await expect(selection.locator('input')).toBeChecked();
        await selection.click();
      }
      if ([390, 1440, 3840].includes(width) && ['my_work', 'okr', 'work', 'inbox'].includes(view)) {
        await page.screenshot({ path: info.outputPath(`${width}-${view}.png`), fullPage: false });
      }
    }
    for (const tab of ['general', 'members', 'groups', 'projects', 'summary', 'integrations', 'danger', 'scheduled']) {
      await page.goto(`/?view=work&settings=workspace&tab=${tab}`);
      await expect(page.getByRole('dialog', { name: '워크스페이스 설정' })).toBeVisible();
      await fits(page);
      const close = page.getByRole('button', { name: '워크스페이스 설정 닫기', exact: true });
      await close.click();
      await expect(page.getByRole('dialog', { name: '워크스페이스 설정' })).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get('view')).toBe('work');
    }
    expect(errors).toEqual([]);
  });
}

test('structure is preserved; focus, zoom and workspace menu stay usable', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-chromium');
  await installApiMocks(page, { teamWorkspace: true });
  await page.goto('/?view=work');
  await expect(page.locator('.desktop-navigation .nav-item span')).toHaveText(['AI 대화', '내 업무', 'OKR', '간트', 'Task', 'Project', 'Routine', 'Ticket', '데이터', '데일리', '추천', '리뷰', '휴지통']);
  await expect(page.locator('.page-create-actions > button')).toHaveText(['AI 대화로 추가', '직접 추가']);
  await page.getByRole('tab', { name: '카드', exact: true }).click();
  await page.getByRole('button', { name: '선택', exact: true }).click();
  await expect(page.locator('.project-card .delete-select')).toBeVisible();
  await page.locator('.workspace-switcher').click();
  await expect(page.locator('.workspace-menu')).toBeVisible();
  expect(await page.locator('.workspace-menu').evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + 20, r.top + 20));
  })).toBe(true);
  await page.locator('.workspace-switcher').click();
  // Larger user text preference, without CSS zoom/transform.
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await fits(page);
  const create = page.getByRole('button', { name: '직접 추가', exact: true });
  await create.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await fits(page);
  await page.keyboard.press('Escape');
  await expect(create).toBeFocused();
  await page.goto('/?view=okr');
  await page.getByRole('button', { name: '파일 수정', exact: true }).click();
  await expect(page.locator('.okr-file-editor')).toBeVisible();
  expect(await page.locator('.okr-file-editor').evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(44 * 16);
  expect(await page.locator('.okr-file-editor').evaluate(el => {
    const frame = el.getBoundingClientRect();
    return [...el.querySelectorAll('input, select, textarea, button')].filter(control => {
      const box = control.getBoundingClientRect();
      return box.width > 0 && (box.left < frame.left - 1 || box.right > frame.right + 1);
    }).map(control => control.getAttribute('aria-label') || control.textContent);
  })).toEqual([]);
  await fits(page);
});

for (const width of [390, 1440, 3840]) {
  test(`readability states ${width}: loading, failure, empty and read-only`, async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-chromium');
    await page.setViewportSize({ width, height: 1000 });
    await installApiMocks(page, { teamWorkspace: true, workspaceRole: 'viewer' });
    let fail = true;
    await page.route('**/api/item-trash', async route => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await json(route, fail ? { error: 'test unavailable' } : { items: [], initiativeOptions: [] }, fail ? 503 : 200);
    });
    await page.goto('/?view=trash');
    await expect(page.getByText('휴지통을 불러오는 중입니다', { exact: true })).toBeVisible();
    await fits(page);
    await expect(page.getByText('휴지통을 불러오지 못했습니다', { exact: true })).toBeVisible();
    await fits(page);
    fail = false;
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByText('휴지통이 비어 있습니다', { exact: true })).toBeVisible();
    await page.goto('/?view=okr');
    await expect(page.locator('.okr-file-read-surface')).toBeVisible();
    await expect(page.getByRole('button', { name: '파일 수정', exact: true })).toHaveCount(0);
    const kr = page.locator('button.okr-tree-kr-row').first();
    await kr.focus();
    await page.keyboard.press('Enter');
    await expect(kr).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(kr).toHaveAttribute('aria-expanded', 'false');
    await fits(page);
  });
}
