import {expect,test} from '@playwright/test';
import {bootstrap,installApiMocks,json} from './api-mocks';

test('renamed workspace keeps its OKR hierarchy beyond 200 execution items',async({page})=>{
  await installApiMocks(page,{teamWorkspace:true});
  const data=structuredClone(bootstrap);
  data.workspaces[0].name='Renamed AllHere';
  data.team.workspace.name='Renamed AllHere';
  const task=data.items.find(item=>item.kind==='task')!;
  data.items.push(...Array.from({length:1200},(_,n)=>({...task,id:`recent-task-${n}`,title:`Recent task ${n}`,parentId:'project-1'})));
  await page.route('**/api/bootstrap?*',route=>json(route,data));
  await page.goto('/?view=okr');
  const okrDocument=page.locator('.okr-document');
  await expect(okrDocument).toBeVisible();
  await expect(okrDocument).toContainText('고객 경험 개선');
  await expect(okrDocument).toContainText('활성 사용자 20% 증가');
  await page.reload();
  await expect(page.locator('.okr-document')).toContainText('고객 경험 개선');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
});
