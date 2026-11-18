import {expect,test,type Page} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {installApiMocks,json} from "./api-mocks";
import {installKrDataMocks} from "./kr-data-mocks";
import {scheduleCredits,scheduleInput} from "../../lib/project-metric-schedule-model";
import type {ProjectScheduleState} from "../../lib/project-metric-schedules";
const at=new Date("2026-11-18T06:00:00Z");
async function mocks(page:Page,{viewer=false,long=false,canEdit=true}={}) {
  await page.clock.setFixedTime(at);await installApiMocks(page,{workspaceRole:viewer?"viewer":"owner"});
  const kr=await installKrDataMocks(page,{configured:true,viewer,long});kr.state().metric!.unit="시간";
  let calendar={timezone:"Asia/Seoul",holidays:[] as string[],version:0};
  let schedule:ProjectScheduleState["schedule"]=null,revision=1,fail=false;
  const writes:Record<string,unknown>[]=[];
  const state=():ProjectScheduleState=>({project:{id:"project-1",title:kr.state().projects[0].title},keyResult:{id:"kr-1",title:kr.state().keyResult.title,unit:"시간",projectMode:true},calendar,schedule,revision:String(revision)});
  await page.route("**/api/**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==="/api/project-contribution-schedules") {
      if(request.method()==="PUT") {
        const input=request.postDataJSON();writes.push(input);if(fail){fail=false;return json(route,{code:"save_failed"},503);}
        const parsed=scheduleInput(input),credits=scheduleCredits(parsed,calendar,at);revision++;
        schedule={...parsed,id:"schedule",version:revision,active:true,suspendedAt:null,isEstimate:true,accruedValue:credits.accruedValue,monthValue:credits.monthValue,creditedDays:credits.dates.length,throughDate:credits.throughDate,recentCredits:credits.dates.map(date=>({date,amount:parsed.amount,isEstimate:true}))};
        kr.state().metric!.currentValue=28+credits.accruedValue;kr.state().keyResult.progress=Math.round(28+credits.accruedValue);
        kr.state().projects[0].schedule={mode:parsed.mode,amount:parsed.amount,accruedValue:credits.accruedValue};
      }
      return json(route,state());
    }
    if(path==="/api/metric-calendar") {
      if(request.method()==="PUT") {if(!canEdit)return json(route,{code:"forbidden"},403);const body=request.postDataJSON();writes.push(body);calendar={timezone:body.timezone,holidays:body.holidays,version:calendar.version+1};revision++;}
      return json(route,{calendar,canEdit});
    }
    return route.fallback();
  });
  return {writes,state,fail:()=>{fail=true;}};
}
async function open(page:Page) {
  await page.goto("/?view=data");await page.locator(".kr-data-card").filter({has:page.locator(".type-key_result")}).getByRole("button",{name:"KR 데이터 설정",exact:true}).click();
  const parent=page.getByRole("dialog",{name:"KR 데이터 설정",exact:true});await parent.getByRole("button",{name:"KR 기여 방식",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"KR 기여 방식",exact:true});await expect(dialog.getByLabel("기여 방식",{exact:true})).toBeVisible();return {dialog,parent};
}
test("Data configures daily savings with pauses, estimates and explicit save without a checkbox",async({page})=>{
  const mock=await mocks(page),{dialog,parent}=await open(page);
  expect(mock.writes).toHaveLength(0);await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
  await dialog.getByLabel("하루 기여량 (시간)",{exact:true}).fill("0.5");await dialog.getByLabel("운영 시작일",{exact:true}).fill("2026-11-13");
  await dialog.getByRole("button",{name:"일시중지 기간 추가"}).click();await dialog.getByLabel("중지 시작일",{exact:true}).fill("2026-11-14");await dialog.getByLabel("중지 종료일 (선택)",{exact:true}).fill("2026-11-15");
  await expect(dialog.locator(".schedule-totals")).toContainText("1.5 시간");
  await dialog.getByRole("button",{name:"기여 방식 저장",exact:true}).click();await expect(dialog).not.toBeVisible();
  expect(mock.state().schedule?.accruedValue).toBe(1.5);expect(mock.writes[0]).toMatchObject({projectId:"project-1",mode:"daily",amount:0.5,startDate:"2026-11-13",pauses:[{startDate:"2026-11-14",endDate:"2026-11-15"}]});
  await expect(parent.locator(".kr-source-project")).toContainText("매일 · 추정 1.5 시간");
});
test("business-day calendar saves without losing the draft and failed contribution writes preserve entered values",async({page})=>{
  const mock=await mocks(page),{dialog}=await open(page);
  await dialog.getByLabel("기여 방식",{exact:true}).selectOption("business_days");await dialog.getByLabel("하루 기여량 (시간)",{exact:true}).fill("2");await dialog.getByLabel("운영 시작일",{exact:true}).fill("2026-11-13");
  await dialog.locator(".schedule-calendar summary").click();await dialog.getByLabel("휴일 날짜",{exact:true}).fill("2026-11-16");
  await dialog.getByRole("button",{name:"워크스페이스 달력 저장",exact:true}).click();await expect(dialog.getByRole("status")).toContainText("달력을 저장했습니다.");
  await expect(dialog.getByLabel("하루 기여량 (시간)",{exact:true})).toHaveValue("2");await expect(dialog.locator(".schedule-totals")).toContainText("4 시간");
  mock.fail();await dialog.getByRole("button",{name:"기여 방식 저장",exact:true}).click();await expect(dialog.getByRole("alert")).toBeVisible();await expect(dialog.getByLabel("운영 시작일",{exact:true})).toHaveValue("2026-11-13");
  await dialog.getByRole("button",{name:"기여 방식 저장",exact:true}).click();await expect(dialog).not.toBeVisible();expect(mock.state().schedule?.accruedValue).toBe(4);
});
test("one-off dates and nested keyboard close preserve the KR settings; Viewer cannot change settings",async({page})=>{
  await mocks(page,{canEdit:false});const {dialog,parent}=await open(page);
  await page.keyboard.press("Escape");await expect(dialog).not.toBeVisible();await expect(parent).toBeVisible();await expect(parent.getByRole("button",{name:"KR 기여 방식",exact:true})).toBeFocused();
  await parent.getByRole("button",{name:"KR 기여 방식",exact:true}).click();
  await dialog.getByLabel("기여 방식",{exact:true}).selectOption("once");await expect(dialog.getByLabel("운영 종료일 (선택)")).toHaveCount(0);
  await dialog.getByLabel("회당 기여량 (시간)",{exact:true}).fill("1");await dialog.getByLabel("반영일",{exact:true}).fill("2026-11-18");await expect(dialog.locator(".schedule-totals")).toContainText("1 시간");
  await dialog.locator(".schedule-calendar summary").click();await expect(dialog.getByLabel("휴일 날짜",{exact:true})).toBeDisabled();
  await dialog.getByRole("button",{name:"기여 방식 저장",exact:true}).click();await expect(dialog).not.toBeVisible();
});
test("Viewer data settings remain read-only",async({page})=>{
  const mock=await mocks(page,{viewer:true});await page.goto("/?view=data");await expect(page.getByRole("button",{name:"KR 데이터 설정",exact:true})).toBeDisabled();expect(mock.writes).toHaveLength(0);
});
test("schedule drawer retains real fonts, contrast and long titles at narrow, wide and larger text sizes",async({page},info)=>{
  test.skip(info.project.name!=="desktop-chromium");test.setTimeout(150_000);
  await mocks(page,{long:true});const {dialog}=await open(page);await dialog.getByRole("button",{name:"일시중지 기간 추가"}).click();
  for(const width of [320,390,768,1440,1920,2560,3840]) {
    await page.setViewportSize({width,height:1000});
    for(const size of ["100%","200%"]){await page.evaluate(value=>{document.documentElement.style.fontSize=value;},size);const box=await dialog.locator(".contribution-schedule-panel").evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));expect(box.scroll,`${width}/${size}`).toBeLessThanOrEqual(box.width+1);}
    await page.evaluate(()=>{document.documentElement.style.fontSize="100%";});if([320,1440].includes(width))await page.screenshot({path:info.outputPath(`schedule-${width}.png`)});
  }
  await page.setViewportSize({width:1440,height:1000});
  for(const theme of ["white","beige","gray","dark","neon","cyberpunk"]) {
    await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);
    const audit=await new AxeBuilder({page:page as never}).include(".contribution-schedule-panel").withRules(["color-contrast","label","button-name"]).analyze();expect(audit.violations,theme).toEqual([]);
  }
  await page.evaluate(()=>document.fonts.ready);
  const cdp=await page.context().newCDPSession(page);await cdp.send("DOM.enable");await cdp.send("CSS.enable");const {root}=await cdp.send("DOM.getDocument");
  for(const selector of [".contribution-schedule-panel h2",".schedule-totals dd"]) {const {nodeId}=await cdp.send("DOM.querySelector",{nodeId:root.nodeId,selector});const {fonts}=await cdp.send("CSS.getPlatformFontsForNode",{nodeId});expect(fonts.length).toBeGreaterThan(0);expect(fonts.every(font=>font.isCustomFont&&/Pretendard/.test(font.familyName))).toBe(true);}
  await cdp.detach();
});
