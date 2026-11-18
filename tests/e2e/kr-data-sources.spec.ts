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

const krRow=(page:import("@playwright/test").Page)=>page.locator(".okr-file-read-kr").first();
const toggle=(page:import("@playwright/test").Page)=>krRow(page).locator(":scope > .okr-tree-kr-row");
async function expandKr(page:import("@playwright/test").Page){
  if(await toggle(page).getAttribute("aria-expanded")!=="true")await toggle(page).click();
}
test("existing OKR rows show only a bare trend when closed and details below their own disclosure",async({page})=>{
  await installApiMocks(page);const mock=await installKrDataMocks(page,{configured:true});let reads=0;
  page.on("request",r=>{if(new URL(r.url()).pathname==="/api/kr-metric-history")reads++;});
  await page.goto("/?view=okr");
  await expect(page.locator(".kr-metric-graph")).toHaveCount(0);
  await expect(page.getByLabel("조회할 KR")).toHaveCount(0);
  await expect(krRow(page).locator(".kr-trend-summary.signal-improving > svg > path")).toHaveCount(1);
  await expect(krRow(page).locator(".kr-trend-summary")).toHaveText("");
  await expect(page.locator(".kr-inline-metric")).toHaveCount(0);
  const order=await page.locator(".okr-file-read-tree").evaluate(el=>(el.firstElementChild as HTMLElement).className);
  expect(order).toContain("okr-file-read-objective");
  const before=reads;await toggle(page).focus();await page.keyboard.press("Enter");
  const graph=krRow(page).locator(".kr-inline-metric");
  await expect(graph).toContainText("28 건");await expect(graph.locator(".kr-history-point")).toHaveCount(3);
  expect(reads).toBe(before);
  const placement=await krRow(page).evaluate(el=>{const row=el.querySelector(".okr-tree-kr-row")!,graph=el.querySelector(".kr-inline-metric")!,initiative=el.querySelector(".okr-tree-initiatives")!;return row.getBoundingClientRect().bottom<=graph.getBoundingClientRect().top&&graph.getBoundingClientRect().bottom<=initiative.getBoundingClientRect().top;});
  expect(placement).toBe(true);
  await graph.getByLabel("지표 조회 기간").selectOption("90");await expect(graph.locator(".kr-history-point")).toHaveCount(3);
  await graph.getByText("측정 기록 보기",{exact:true}).click();await expect(graph.getByRole("table")).toContainText("25 건");
  await toggle(page).focus();await page.keyboard.press("Enter");await expect(graph).toHaveCount(0);
  await expect(krRow(page).locator(".kr-trend-summary")).toBeVisible();expect(mock.writes).toEqual([]);
});
test("each KR owns its trend and signal, including KRs without Initiatives",async({page},info)=>{
  await installApiMocks(page);const mock=await installKrDataMocks(page,{configured:true}),kr=mock.items.find(i=>i.id==="kr-1")!;
  mock.items.push({...kr,id:"kr-2",title:"반복 구매율",progress:20},{...kr,id:"kr-3",title:"신규 전환",progress:0});
  await page.route("**/api/kr-metric-history?**",route=>{
    const id=new URL(route.request().url()).searchParams.get("keyResultId");
    const observations=id==="kr-1"?mock.observations:id==="kr-2"?mock.observations.map((p,i)=>({...p,currentValue:[30,25,20][i]})):[];
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({observations,limited:false})});
  });
  await page.goto("/?view=okr");
  await expect(page.locator(".okr-file-read-kr")).toHaveCount(3);
  await expect(page.locator("#okr-search-kr-1 .signal-improving > svg > path")).toHaveCount(1);
  await expect(page.locator("#okr-search-kr-2 .signal-declining > svg > path")).toHaveCount(1);
  const empty=page.locator("#okr-search-kr-3");await expect(empty.locator(".kr-trend-summary.signal-insufficient")).toBeVisible();
  await expect(empty.locator(".kr-trend-summary path")).toHaveCount(0);
  await page.screenshot({path:info.outputPath("kr-inline-list.png")});
  await empty.locator(":scope > button").click();await expect(empty.locator(".kr-history-empty")).toHaveText("측정 기록이 없습니다.");
});
test("an unmeasured KR stays empty and Viewer can inspect its trend without editing data",async({page})=>{
  await installApiMocks(page,{workspaceRole:"viewer"});const mock=await installKrDataMocks(page,{viewer:true});await page.goto("/?view=okr");
  await expect(krRow(page).locator(".kr-trend-summary.signal-insufficient")).toBeVisible();
  await expandKr(page);await expect(page.locator(".kr-history-empty")).toHaveText("측정 기록이 없습니다.");
  await expect(page.locator(".kr-history-point")).toHaveCount(0);expect(mock.writes).toEqual([]);
  await page.goto("/?view=data");await expect(krCard(page).getByRole("button",{name:"KR 데이터 설정"})).toBeDisabled();
});
test("failed history leaves the OKR hierarchy usable and can be retried without a write",async({page})=>{
  await installApiMocks(page);const mock=await installKrDataMocks(page,{configured:true});let attempts=0;
  await page.route("**/api/kr-metric-history?**",route=>route.fulfill({status:attempts++?200:503,contentType:"application/json",body:JSON.stringify({observations:mock.observations,limited:false})}));
  await page.goto("/?view=okr");await expect(krRow(page).locator(".signal-error")).toBeVisible();await expandKr(page);
  await expect(krRow(page).getByRole("alert")).toContainText("측정 이력을 불러오지 못했습니다.");
  await krRow(page).getByRole("button",{name:"다시 시도",exact:true}).click();
  await expect(krRow(page).locator(".kr-history-point")).toHaveCount(3);expect(mock.writes).toEqual([]);
});
test("historical lines stop at a measurement source change",async({page})=>{
  await installApiMocks(page);const mock=await installKrDataMocks(page,{configured:true}),base=mock.observations[0];
  mock.observations.push({...base,id:"api-mode",source:"api",eventKind:"settings",currentValue:null,observedAt:new Date(Date.now()-3*86_400_000).toISOString()},
    {...base,id:"api-1",source:"api",eventKind:"synced",currentValue:30,observedAt:new Date(Date.now()-2*86_400_000).toISOString()},
    {...base,id:"api-2",source:"api",eventKind:"synced",currentValue:35,observedAt:new Date(Date.now()-86_400_000).toISOString()});
  await page.goto("/?view=okr");await expandKr(page);await expect(krRow(page).locator(".kr-history-point")).toHaveCount(5);
  await expect(krRow(page).locator(".kr-history-line")).toHaveCount(2);
});
test("a bounded history response reports that additional measurements are retained",async({page})=>{
  await installApiMocks(page);const mock=await installKrDataMocks(page,{configured:true});
  await page.route("**/api/kr-metric-history?**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({observations:mock.observations,limited:true})}));
  await page.goto("/?view=okr");await expandKr(page);await expect(krRow(page).getByRole("status")).toContainText("나머지 이력도 보관됩니다.");
});
test("inline KR trends preserve the document, fonts, contrast and long titles from 320px to 4K",async({page},info)=>{
  test.skip(info.project.name!=="desktop-chromium");test.setTimeout(180_000);
  await installApiMocks(page);await installKrDataMocks(page,{configured:true,long:true});await page.goto("/?view=okr");
  const tree=page.locator(".okr-file-read-tree");await expect(tree.locator(".kr-trend-summary.signal-improving")).toBeVisible();
  for(const width of [320,390,768,1440,1920,2560,3840]){
    await page.setViewportSize({width,height:1000});
    for(const size of ["100%","200%"]){await page.evaluate(size=>{document.documentElement.style.fontSize=size;},size);
      const box=await tree.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));expect(box.scroll).toBeLessThanOrEqual(box.client+1);}
    await page.evaluate(()=>{document.documentElement.style.fontSize="100%";});
  }
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:info.outputPath("kr-inline-collapsed-desktop.png")});
  await toggle(page).focus();await page.keyboard.press("Enter");
  const detail=krRow(page).locator(".kr-inline-metric");await expect(detail.locator(".kr-history-point")).toHaveCount(3);
  for(const width of [320,390,768,1440,1920,2560,3840]){
    await page.setViewportSize({width,height:1000});for(const size of ["100%","200%"]){
      await page.evaluate(size=>{document.documentElement.style.fontSize=size;},size);
      const box=await tree.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));expect(box.scroll).toBeLessThanOrEqual(box.client+1);}
    await page.evaluate(()=>{document.documentElement.style.fontSize="100%";});
  }
  for(const theme of ["white","beige","gray","dark","neon","cyberpunk"]){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);expect((await new AxeBuilder({page:page as never}).include(".okr-file-read-tree").withRules(["color-contrast"]).analyze()).violations,theme).toEqual([]);}
  await page.evaluate(()=>document.fonts.ready);
  const cdp=await page.context().newCDPSession(page);await cdp.send("DOM.enable");await cdp.send("CSS.enable");const doc=await cdp.send("DOM.getDocument");
  for(const selector of [".okr-file-read-objective h3",".okr-tree-kr-row .okr-tree-copy strong",".kr-inline-values b"]){const {nodeId}=await cdp.send("DOM.querySelector",{nodeId:doc.root.nodeId,selector});const {fonts}=await cdp.send("CSS.getPlatformFontsForNode",{nodeId});expect(fonts.length).toBeGreaterThan(0);expect(fonts.every(f=>f.isCustomFont&&/Pretendard/.test(f.familyName))).toBe(true);}await cdp.detach();
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>{document.documentElement.dataset.theme="white";});await page.screenshot({path:info.outputPath("kr-inline-expanded-desktop.png")});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:info.outputPath("kr-inline-expanded-mobile.png")});
  await toggle(page).click();await expect(detail).toHaveCount(0);await page.screenshot({path:info.outputPath("kr-inline-collapsed-mobile.png")});
});
