import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { bootstrap, installApiMocks, json } from './api-mocks';

const definitions = [
  ['parent_id', '상위 Initiative', 'text'], ['priority', '우선순위', 'select'],
  ['status', '상태', 'select'], ['cadence', '주기', 'select'],
  ['due_date', '기한', 'date'], ['project_dri', 'DRI', 'member'],
  ['project_workers', '하위 업무자', 'members'],
].map(([systemKey, name, type], sortOrder) => ({ id: systemKey, systemKey, name, type, sortOrder, active: true, options: [], defaultValue: null, valueCount: 1 }));
const properties = [...definitions, ...[
  ['budget', '예산 Budget 2026', 'number'], ['risk', '위험도', 'select'],
  ['approved', '검토 완료', 'checkbox'], ['reviewer', '검토자', 'member'],
].map(([id, name, type], index) => ({ id, name, type, systemKey: null, sortOrder: index + 10, active: true, options: type === 'select' ? ['낮음', '높음'] : [], defaultValue: null, valueCount: 1 }))];

async function fixture(page: Page, viewer = false) {
  await installApiMocks(page, { workspaceRole: viewer ? 'viewer' : 'owner', withRoutine: true });
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  let project = structuredClone(bootstrap.items.find(item => item.id === 'project-1')!);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/bootstrap') return json(route, {
      ...bootstrap, properties,
      propertyValues: { 'project-1': { budget: 1200.5, risk: '높음', approved: true, reviewer: 'member-1' } },
      hiddenByProject: viewer ? { 'project-1': ['risk'] } : {},
      workspaces: bootstrap.workspaces.map(workspace => ({ ...workspace, role: viewer ? 'viewer' : 'owner' })),
      team: { ...bootstrap.team, currentRole: viewer ? 'viewer' : 'owner', canManage: !viewer, members: bootstrap.team.members.map(member => ({ ...member, role: viewer ? 'viewer' : 'owner' })) },
    });
    if (path === '/api/properties') return json(route, { properties });
    if (request.method() !== 'GET') {
      const data = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, data });
      if (path === '/api/items' && request.method() === 'PATCH') {
        project = { ...project, ...data };
        return json(route, { item: project });
      }
      if (path === '/api/property-values' || path === '/api/project-property-visibility') return json(route, { ok: true });
    }
    return route.fallback();
  });
  return writes;
}

async function fieldStyle(field: Locator) {
  return field.evaluate(el => {
    const style = getComputedStyle(el);
    return { font: style.fontFamily, size: style.fontSize, height: style.minHeight, padding: style.padding,
      border: style.borderColor, radius: style.borderRadius, background: style.backgroundColor };
  });
}

async function editorFits(page: Page, panel: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const layout = await panel.evaluate(el => {
    const frame = el.getBoundingClientRect();
    return { overflow: el.scrollWidth - el.clientWidth, outside: [...el.querySelectorAll('*')].filter(child => {
      if (child.closest('.project-task-table, .bn-container')) return false;
      const rect = child.getBoundingClientRect();
      return rect.width > 0 && (rect.left < frame.left - 1 || rect.right > frame.right + 1);
    }).map(child => ({ tag: child.tagName, class: child.className, width: child.getBoundingClientRect().width })) };
  });
  expect(layout.overflow, JSON.stringify(layout.outside)).toBeLessThanOrEqual(1);
  const overlaps = await panel.locator('.project-system-property, .project-property-field-row').evaluateAll(rows => rows.flatMap(row => {
    const action = row.querySelector(':scope > .icon-button');
    const field = row.querySelector(':scope > label, :scope > .member-mention-field');
    if (!action || !field) return [];
    const a = action.getBoundingClientRect(), f = field.getBoundingClientRect();
    return a.left - f.right < 7.9 ? [action.getAttribute('aria-label')] : [];
  }));
  expect(overlaps, 'Hide controls must be outside editable values').toEqual([]);
}

test('Project create and edit share fields, preserve values and use separate hide actions', async ({ page }, info) => {
  const duplicateKeys: string[] = [];
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('same key')) duplicateKeys.push(message.text()); });
  const writes = await fixture(page);
  await page.goto('/?view=work');
  await page.getByRole('button', { name: '직접 추가', exact: true }).click();
  const create = page.locator('.create-item-form');
  const createStyle = await fieldStyle(create.getByLabel('예산 Budget 2026'));
  await page.screenshot({ path: info.outputPath('project-create.png') });
  await page.keyboard.press('Escape');
  await page.goto('/?view=work&project=project-1');
  await page.locator('.document-properties').getByRole('button', { name: '변경', exact: true }).click();
  const panel = page.locator('.document-properties-editor');
  const budget = panel.getByLabel('예산 Budget 2026', { exact: true });
  await expect(budget).toHaveValue('1200.5');
  expect(await fieldStyle(budget)).toEqual(createStyle);
  expect(await panel.locator('.member-mention-input input').evaluate(el => getComputedStyle(el).borderWidth)).toBe('0px');
  await editorFits(page, panel);
  if (page.viewportSize()!.width <= 700) {
    expect((await panel.getByLabel('Project 이름').boundingBox())!.width).toBeGreaterThan((await panel.boundingBox())!.width * .8);
  }
  await page.screenshot({ path: info.outputPath('project-edit.png') });
  await budget.fill('2400.75');
  await expect.poll(() => writes.some(write => write.path === '/api/property-values' && write.data.value === 2400.75)).toBe(true);
  await panel.getByRole('button', { name: '예산 Budget 2026 숨기기', exact: true }).click();
  await expect(budget).toHaveCount(0);
  await panel.locator('.hidden-property-list').getByRole('button', { name: '예산 Budget 2026', exact: true }).click();
  await expect(budget).toHaveValue('2400.75');
  await expect(panel.getByLabel('검토 완료', { exact: true })).toBeChecked();
  await expect(panel.getByRole('combobox', { name: '검토자', exact: true })).toHaveValue('member-1');
  expect(writes.filter(write => write.path === '/api/project-property-visibility').map(write => write.data)).toEqual([
    { projectId: 'project-1', propertyId: 'budget', hidden: true },
    { projectId: 'project-1', propertyId: 'budget', hidden: false },
  ]);
  await panel.getByRole('combobox', { name: '상위 Initiative', exact: true }).selectOption('initiative-2');
  await expect.poll(() => writes.some(write => write.path === '/api/items' && write.data.parentId === 'initiative-2')).toBe(true);
  await page.keyboard.press('Escape');
  await page.locator('.project-detail-panel').getByRole('button', { name: '오버레이 동작 점검', exact: true }).click();
  await expect(page.locator('.task-detail-panel')).toBeVisible();
  await page.locator('.task-detail-panel .document-properties').getByRole('button', { name: '변경', exact: true }).click();
  await expect(page.locator('.document-properties-editor').getByRole('combobox', { name: '연결 대상', exact: true })).toHaveValue('project:project-1');
  expect(duplicateKeys).toEqual([]);
});

test('Viewer sees a consistent read-only Project without interactive assignment or hide controls', async ({ page }) => {
  const writes = await fixture(page, true);
  await page.goto('/?view=work&project=project-1');
  const panel = page.locator('.project-detail-panel');
  await expect(panel.getByRole('heading', { name: '모바일 사용성 개선', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '속성', exact: true }).click();
  await expect(panel.locator('.document-property-list')).toContainText('1200.5');
  await expect(panel.locator('.document-property-list')).not.toContainText('위험도');
  await expect(panel.locator('.document-properties-change')).toHaveCount(0);
  await expect(page.locator('.document-properties-editor')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /숨기기$/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Project 휴지통으로 이동' })).toHaveCount(0);
  await editorFits(page, panel);
  expect(writes.filter(write => /^\/api\/(items|item-assignments|property-values|project-)/.test(write.path))).toEqual([]);
});

test('Project progress bot stays conservative and applies only a confirmed suggestion', async ({ page }) => {
  const writes = await fixture(page);
  await page.goto('/?view=work&project=project-1');
  const panel = page.locator('.project-detail-panel');

  await expect(panel.getByRole('heading', { name: '진행 상황' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '진행사항 봇 켜기' })).toHaveCount(0);
  await panel.locator('.document-properties').getByRole('button', { name: '변경', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '진행사항 봇 사용' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: '진행사항 봇 사용' }).check();
  await page.keyboard.press('Escape');
  await expect(panel.getByText('Task 완료율과 Project 진행률이 다릅니다.')).toBeVisible();
  expect(writes.filter(write => write.path === '/api/items' && write.data.progress !== undefined)).toEqual([]);
  const contrast = await new AxeBuilder({ page: page as never }).include('.project-progress-section').withRules(['color-contrast']).analyze();
  expect(contrast.violations).toEqual([]);

  await panel.getByRole('button', { name: '진행률 반영' }).click();
  await expect.poll(() => writes.some(write => write.path === '/api/items' && write.data.progress === 0)).toBe(true);
});

test('Task uses one completion control instead of Project workflow status and progress', async ({ page }, info) => {
  await installApiMocks(page, { withRoutine: true });
  const writes: Record<string, unknown>[] = [];
  let task = structuredClone(bootstrap.items.find(item => item.id === 'task-1')!);
  await page.route('**/api/items', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(patch);
    task = { ...task, ...patch };
    return json(route, { item: task });
  });

  await page.goto('/?view=inbox&task=task-1');
  const panel = page.locator('.task-detail-panel');
  await expect(panel.getByText('Task 문서', { exact: true })).toBeVisible();
  await expect(panel.locator('.work-document-section .bn-editor')).toContainText('Task specification');
  await expect(panel.getByRole('combobox', { name: '상태', exact: true })).toHaveCount(0);
  await expect(panel.locator('input[type="range"]')).toHaveCount(0);
  await panel.getByRole('button', { name: '완료', exact: true }).click();
  await expect(panel.getByRole('button', { name: '완료 취소', exact: true })).toBeVisible();
  expect(writes.at(-1)).toEqual({ id: 'task-1', status: 'done' });
  await panel.getByRole('button', { name: '완료 취소', exact: true }).click();
  expect(writes.at(-1)).toEqual({ id: 'task-1', status: 'todo' });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await expect(panel.getByRole('button', { name: '완료', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('task-completion-mobile.png') });
});

test('My Work icon tracks follow enlarged text without colliding with titles', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-chromium');
  await installApiMocks(page);
  for (const width of [320, 1440, 3840]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/?view=my_work');
    await expect(page.locator('.my-work-item').first()).toBeVisible();
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    expect(await page.locator('.my-work-item').evaluateAll(rows => rows.every(row => {
      const icon = row.querySelector('.type-icon')!.getBoundingClientRect();
      const title = row.querySelector('b')!.getBoundingClientRect();
      return title.left - icon.right >= 8;
    }))).toBe(true);
  }
});

for (const width of [320, 390, 768, 1440, 1920, 2560, 3840]) {
  test(`Project editor ${width}: long titles, aligned fields and larger user text`, async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-chromium');
    await fixture(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/?view=work&project=project-1');
    await page.locator('.document-properties').getByRole('button', { name: '변경', exact: true }).click();
    const panel = page.locator('.document-properties-editor');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Project 이름').fill('고객 경험과 운영 품질을 개선하는 Project 2026 '.repeat(8));
    for (const scale of [100, 200]) {
      await page.addStyleTag({ content: `html { font-size: ${scale}% !important; }` });
      await editorFits(page, panel);
      const title = panel.getByLabel('Project 이름');
      expect(await title.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(2);
      expect((await panel.getByRole('button', { name: '기한 숨기기', exact: true }).boundingBox())!.width).toBeGreaterThanOrEqual(44);
    }
    await page.addStyleTag({ content: 'html { font-size: 100% !important; }' });
    await panel.evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath(`project-edit-${width}.png`) });
  });
}

test('Project theme contrast, actual font, keyboard and shared Task/Routine/OKR controls', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-chromium');
  test.setTimeout(120_000);
  await fixture(page);
  await page.goto('/?view=work&project=project-1');
  await page.locator('.document-properties').getByRole('button', { name: '변경', exact: true }).click();
  const panel = page.locator('.document-properties-editor');
  await expect(panel).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const doc = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.project-property-field > span' });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every(font => font.isCustomFont && /Pretendard/.test(font.familyName))).toBe(true);
  await cdp.detach();
  for (const theme of ['white', 'beige', 'gray', 'dark', 'neon', 'cyberpunk']) {
    await page.locator('html').evaluate((el, id) => { el.dataset.theme = id; }, theme);
    const result = await new AxeBuilder({ page: page as never }).include('.project-progress-section').include('.project-detail-form').include('.project-custom-properties').withRules(['color-contrast']).analyze();
    expect(result.violations, theme).toEqual([]);
    await page.screenshot({ path: info.outputPath(`project-${theme}.png`) });
  }
  await panel.getByRole('button', { name: '기한 숨기기', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByLabel('기한', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.keyboard.press('Escape');

  await installApiMocks(page, { withRoutine: true });
  await page.goto('/?view=inbox&task=task-1');
  const task = page.locator('.task-detail-panel');
  await expect(task).toBeVisible();
  await expect(task.getByRole('combobox', { name: '상태', exact: true })).toHaveCount(0);
  await expect(task.locator('input[type="range"]')).toHaveCount(0);
  await expect(task.getByRole('button', { name: '완료', exact: true })).toBeVisible();
  await task.locator('.document-properties').getByRole('button', { name: '변경', exact: true }).click();
  const taskStyle = await fieldStyle(page.locator('.document-properties-editor').getByRole('combobox', { name: '우선순위', exact: true }));
  await page.goto('/?view=routines');
  await page.locator('.routine-expand').click();
  await page.locator('.routine-details .document-properties').getByRole('button', { name: '변경', exact: true }).click();
  await expect(page.locator('.routine-guide-grid')).toBeVisible();
  await expect(page.getByText('Routine 문서', { exact: true })).toBeVisible();
  await expect(page.locator('.routine-details .work-document-section .bn-editor')).toContainText('Routine playbook');
  await page.locator('.document-properties-editor > header h2').click();
  const routineStyle = await fieldStyle(page.locator('.routine-guide-grid').getByLabel('트리거 포인트', { exact: true }));
  expect(routineStyle).toEqual(taskStyle);
  await page.screenshot({ path: info.outputPath('routine-edit.png') });
  await page.goto('/?view=okr');
  await page.getByRole('button', { name: '파일 수정', exact: true }).click();
  const okr = page.locator('.okr-file-editor');
  await expect(okr).toBeVisible();
  expect(await fieldStyle(okr.locator('.okr-file-metadata-editor input').first())).toEqual(taskStyle);
  await editorFits(page, okr);
  await page.screenshot({ path: info.outputPath('okr-edit.png') });
});
