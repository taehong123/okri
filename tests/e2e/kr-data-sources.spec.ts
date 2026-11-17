import {expect,test} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {installApiMocks} from "./api-mocks";
import {installKrDataMocks} from "./kr-data-mocks";
const krCard=(page:import("@playwright/test").Page)=>page.locator(".kr-data-card").filter({has:page.getByRole("heading",{name:"활성 사용자 20% 증가",exact:true})});
test("KR source settings in Data save numeric basis and Project defaults; Project API stays independent",async({page})=>{
  await installApiMocks(page);const mock=await installKrDataMocks(page);await page.goto("/?view=data");
  await krCard(page).getByRole("button",{name:"KR 데이터 설정"}).click();
  const dialog=page.getByRole("dialog",{name:"KR 데이터 설정",exact:true});
  await expect(dialog.getByRole("radio",{name:/Project 성과 합산/})).toBeChecked();
  await dialog.getByLabel("시작값",{exact:true}).fill("50");await dialog.getByLabel("목표값",{exact:true}).fill("200");await dialog.getByLabel("단위",{exact:true}).fill("명");
  await dialog.getByLabel("모바일 사용성 개선 기본 기여량",{exact:true}).fill("15.5");
  mock.fail();await dialog.getByRole("button",{name:"설정 저장",exact:true}).click();
  await expect(dialog.getByRole("alert")).toBeVisible();await expect(dialog.getByLabel("모바일 사용성 개선 기본 기여량",{exact:true})).toHaveValue("15.5");
  await dialog.getByRole("button",{name:"설정 저장",exact:true}).click();await expect(dialog).not.toBeVisible();
  expect(mock.state().projects[0].defaultValue).toBe(15.5);await expect(krCard(page)).toContainText("50명");
  await krCard(page).getByRole("button",{name:"KR 데이터 설정"}).click();await dialog.getByRole("radio",{name:/API 연동/}).check();
  await dialog.getByLabel("데이터 소스 이름",{exact:true}).fill("사용자 API");await dialog.getByLabel("API URL",{exact:true}).fill("https://metrics.example.com/users");
  await dialog.getByRole("button",{name:"설정 저장",exact:true}).click();await expect(dialog).not.toBeVisible();await expect(krCard(page)).toContainText("사용자 API");
  await krCard(page).getByRole("button",{name:"설정",exact:true}).click();await dialog.getByRole("radio",{name:/Project 성과 합산/}).check();
  await expect(dialog.getByLabel("모바일 사용성 개선 기본 기여량",{exact:true})).toHaveValue("15.5");
  await dialog.getByRole("button",{name:"설정 저장",exact:true}).click();await expect(dialog).not.toBeVisible();
  const projectCard=page.locator(".kr-data-card").filter({has:page.getByRole("heading",{name:"모바일 사용성 개선",exact:true})});
  await projectCard.getByRole("button",{name:"이 Project에 API 연결"}).click();
  const api=page.getByRole("dialog",{name:"API 연결",exact:true});
  await api.getByLabel("데이터 소스 이름").fill("품질 API");await api.getByLabel("API URL").fill("https://metrics.example.com/quality");await api.getByLabel("목표값").fill("100");await api.getByRole("button",{name:"연결 저장"}).click();await expect(api).not.toBeVisible();
  await expect(projectCard).toContainText("품질 API");await expect(krCard(page)).toContainText("Project 성과 합산");
});
test("main KR chart shows dated measurements and an accessible raw history; first-time KR shows no invented past",async({page})=>{
  await installApiMocks(page);await installKrDataMocks(page,{configured:true});await page.goto("/?view=okr");
  const graph=page.getByRole("region",{name:"KR 지표 그래프"});
  await expect(graph).toContainText("28 건");await expect(graph.locator(".kr-history-point")).toHaveCount(3);
  await expect(graph.locator(".kr-history-line")).toHaveCount(1);await graph.getByLabel("지표 조회 기간").selectOption("90");
  await expect(graph.locator(".kr-history-point")).toHaveCount(3);
  await graph.getByText("측정 기록 보기",{exact:false}).click();await expect(graph.getByRole("table")).toBeVisible();
  await expect(graph.getByRole("table")).toContainText("25 건");
  await graph.getByRole("button",{name:"데이터 설정"}).click();await expect(page.getByRole("heading",{name:"데이터",exact:true})).toBeVisible();
});
test("an unmeasured KR has an honest empty state and Viewer settings stay read-only",async({page})=>{
  await installApiMocks(page,{workspaceRole:"viewer"});await installKrDataMocks(page,{viewer:true});await page.goto("/?view=okr");
  await expect(page.locator(".kr-history-empty")).toContainText("첫 측정부터");
  await expect(page.locator(".kr-history-point")).toHaveCount(0);
  await page.goto("/?view=data");await expect(krCard(page).getByRole("button",{name:"KR 데이터 설정"})).toBeDisabled();
});
test("historical lines stop at a measurement source change",async({page})=>{
  await installApiMocks(page);const mock=await installKrDataMocks(page,{configured:true});
  const base=mock.observations[0];
  mock.observations.push(
    {...base,id:"api-mode",source:"api",eventKind:"settings",currentValue:null,observedAt:new Date(Date.now()-3*86_400_000).toISOString()},
    {...base,id:"api-1",source:"api",eventKind:"synced",currentValue:30,observedAt:new Date(Date.now()-2*86_400_000).toISOString()},
    {...base,id:"api-2",source:"api",eventKind:"synced",currentValue:35,observedAt:new Date(Date.now()-86_400_000).toISOString()});
  await page.goto("/?view=okr");
  await expect(page.locator(".kr-history-point")).toHaveCount(5);
  await expect(page.locator(".kr-history-line")).toHaveCount(2);
});
test("KR source form and graph preserve fonts, keyboard, contrast and long-title layouts from 320px to 4K",async({page},info)=>{
  test.skip(info.project.name!=="desktop-chromium");test.setTimeout(180_000);
  await installApiMocks(page);await installKrDataMocks(page,{configured:true,long:true});await page.goto("/?view=okr");
  const graph=page.locator(".kr-metric-graph");await expect(graph.locator(".kr-history-point")).toHaveCount(3);
  for(const width of [320,390,768,1440,1920,2560,3840]){await page.setViewportSize({width,height:1000});for(const size of ["100%","200%"]){await page.evaluate(size=>{document.documentElement.style.fontSize=size;},size);const box=await graph.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));expect(box.scroll).toBeLessThanOrEqual(box.client+1);}await page.evaluate(()=>{document.documentElement.style.fontSize="100%";});}
  for(const theme of ["white","beige","gray","dark","neon","cyberpunk"]){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);expect((await new AxeBuilder({page:page as never}).include(".kr-metric-graph").withRules(["color-contrast"]).analyze()).violations,theme).toEqual([]);}
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.documentElement.dataset.theme="white";});await page.screenshot({path:info.outputPath("kr-history-desktop.png")});
  const cdp=await page.context().newCDPSession(page);await cdp.send("DOM.enable");await cdp.send("CSS.enable");const doc=await cdp.send("DOM.getDocument");for(const selector of [".kr-metric-graph h2",".kr-metric-title h3",".kr-metric-caption b"]){const {nodeId}=await cdp.send("DOM.querySelector",{nodeId:doc.root.nodeId,selector});const {fonts}=await cdp.send("CSS.getPlatformFontsForNode",{nodeId});expect(fonts.length).toBeGreaterThan(0);expect(fonts.every(f=>f.isCustomFont&&/Pretendard/.test(f.familyName))).toBe(true);}await cdp.detach();
  await graph.getByRole("button",{name:"데이터 설정"}).click();await page.locator(".kr-data-card").first().getByRole("button",{name:"KR 데이터 설정"}).click();
  const panel=page.locator(".kr-source-panel");await expect(panel.getByRole("radio",{name:/Project 성과 합산/})).toBeChecked();
  for(const width of [320,390,768,1440,3840]){await page.setViewportSize({width,height:1000});for(const size of ["100%","200%"]){await page.evaluate(size=>{document.documentElement.style.fontSize=size;},size);const box=await panel.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));expect(box.scroll).toBeLessThanOrEqual(box.client+1);}await page.evaluate(()=>{document.documentElement.style.fontSize="100%";});}
  for(const theme of ["white","beige","gray","dark","neon","cyberpunk"]){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);expect((await new AxeBuilder({page:page as never}).include(".kr-source-panel").withRules(["color-contrast"]).analyze()).violations,theme).toEqual([]);}
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{document.documentElement.dataset.theme="white";});await page.screenshot({path:info.outputPath("kr-source-mobile.png")});await page.keyboard.press("Escape");await expect(panel).not.toBeVisible();
});
