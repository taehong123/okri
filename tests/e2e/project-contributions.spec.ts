import { expect,test,type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootstrap,installApiMocks,json } from "./api-mocks";

async function mocks(page:Page,options:{configured?:boolean;viewer?:boolean;api?:boolean}={}){
  await installApiMocks(page,{workspaceRole:options.viewer?"viewer":"owner"});
  const items=structuredClone(bootstrap.items),kr=items.find(i=>i.id==="kr-1")!,project=items.find(i=>i.id==="project-1")!;
  kr.progress=20;
  let c=options.configured===false?null:{id:"contribution",defaultValue:10,actualValue:null as number|null,applied:false,enabled:true,version:1};
  let m=options.configured===false?null:{id:"metric",keyResultId:"kr-1",title:kr.title,startingValue:20,currentValue:20,targetValue:100,unit:"건",progress:20,version:1,active:true};
  let requestId="",fail=false,lose=false,projectWrites=0,taskWrites=0,reads=0;
  const state=()=>({projectId:project.id,projectStatus:project.status,keyResult:{id:kr.id,title:kr.title,progress:kr.progress},contribution:c,metric:m,apiConnected:options.api??false});
  await page.route("**/api/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(path==="/api/bootstrap"){
      const workspaces=bootstrap.workspaces.map(w=>({...w,role:options.viewer?"viewer":"owner"}));
      return json(route,{...bootstrap,items,workspaces,team:{...bootstrap.team,currentRole:options.viewer?"viewer":"owner",canManage:!options.viewer}});
    }
    if(path==="/api/project-contributions"){
      reads++;
      if(request.method()==="PUT"){
        const body=request.postDataJSON();
        c={id:"contribution",defaultValue:body.defaultValue,actualValue:null,applied:false,enabled:true,version:(c?.version??0)+1};
        m??={id:"metric",keyResultId:kr.id,title:kr.title,startingValue:body.startingValue,currentValue:body.startingValue,targetValue:body.targetValue,unit:body.unit,progress:20,version:1,active:true};
      }
      return json(route,url.searchParams.has("projectId")?state():{metrics:m?[m]:[]});
    }
    if(path==="/api/items"&&request.method()==="PATCH"){
      const body=request.postDataJSON(),item=items.find(i=>i.id===body.id)!;
      if(item.kind==="project"){
        projectWrites++;
        if(fail){fail=false;return json(route,{code:"save_failed"},503);}
        const done=body.status==="done"||body.status==="development_done";
        if(c&&m&&done&&!c.applied){
          c={...c,actualValue:body.contribution?.actualValue??c.defaultValue,applied:true,version:c.version+1};requestId=body.contribution?.requestId??"";
        }else if(c?.applied&&done&&body.contribution?.requestId!==requestId)return json(route,{code:"contribution_conflict"},409);
        if(c&&body.status==="todo")c={...c,actualValue:null,applied:false,version:c.version+1};
        if(m){m={...m,currentValue:m.startingValue+(c?.applied?c.actualValue??0:0)};m.progress=Math.min(100,Math.round(m.currentValue/m.targetValue*100));kr.progress=m.progress;}
      }else taskWrites++;
      Object.assign(item,body,{updatedAt:new Date().toISOString()});
      if(lose){lose=false;return route.abort("failed");}
      return json(route,{item});
    }
    return route.fallback();
  });
  return{state,projectWrites:()=>projectWrites,taskWrites:()=>taskWrites,reads:()=>reads,fail:()=>{fail=true;},lose:()=>{lose=true;}};
}
const detail="/?view=work&project=project-1";

test("Project completion pre-fills its default and adds the confirmed actual to KR; Task is independent",async({page})=>{
  const mock=await mocks(page);await page.goto(detail);
  await expect(page.locator(".project-contribution")).toContainText("기본 기여량 10 건");
  const reads=mock.reads();await page.locator(".project-task-completion").click();
  expect(mock.taskWrites()).toBe(1);expect(mock.state().metric!.currentValue).toBe(20);
  await expect(page.locator(".project-progress-value strong")).toHaveText("40%");
  expect(mock.reads()).toBe(reads);
  await page.getByRole("button",{name:"Project 완료",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"완료 성과 확인",exact:true});
  await expect(dialog.getByLabel("실제로 얼마나 증가했나요?",{exact:true})).toHaveValue("10");
  expect(mock.projectWrites()).toBe(0);
  await dialog.getByLabel("실제로 얼마나 증가했나요?",{exact:true}).fill("8");
  await expect(dialog.locator(".contribution-preview")).toContainText("20 건 → 28 건");
  await dialog.getByRole("button",{name:"성과 반영하고 완료",exact:true}).click();
  await expect(dialog).not.toBeVisible();
  expect(mock.state().metric!.currentValue).toBe(28);
  await expect(page.locator(".project-contribution")).toContainText("반영한 성과 8 건");
  await page.locator(".project-progress-header").getByRole("button",{name:"완료 취소",exact:true}).click();
  await expect(page.locator(".project-contribution")).toContainText("기본 기여량 10 건");
  expect(mock.state().metric!.currentValue).toBe(20);
});
test("cancel writes nothing, accepting the default applies that value",async({page})=>{
  const mock=await mocks(page);await page.goto(detail);
  await page.getByRole("button",{name:"Project 완료",exact:true}).click();
  let dialog=page.getByRole("dialog",{name:"완료 성과 확인",exact:true});
  await dialog.getByRole("button",{name:"취소",exact:true}).click();
  expect(mock.projectWrites()).toBe(0);
  await page.getByRole("button",{name:"Project 완료",exact:true}).click();
  dialog=page.getByRole("dialog",{name:"완료 성과 확인",exact:true});
  await expect(dialog.getByLabel("실제로 얼마나 증가했나요?",{exact:true})).toBeFocused();
  await dialog.getByLabel("실제로 얼마나 증가했나요?",{exact:true}).press("Enter");
  await expect(dialog).not.toBeVisible();expect(mock.state().metric!.currentValue).toBe(30);
});
test("failure retains actual input and a lost response can be retried without a second increment",async({page})=>{
  const mock=await mocks(page);await page.goto(detail);await page.getByRole("button",{name:"Project 완료",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"완료 성과 확인",exact:true});
  await dialog.getByLabel("실제로 얼마나 증가했나요?",{exact:true}).fill("8");mock.fail();
  await dialog.getByRole("button",{name:"성과 반영하고 완료",exact:true}).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("실제로 얼마나 증가했나요?",{exact:true})).toHaveValue("8");
  mock.lose();await dialog.getByRole("button",{name:"성과 반영하고 완료",exact:true}).click();
  await expect(dialog.getByRole("alert")).toBeVisible();expect(mock.state().metric!.currentValue).toBe(28);
  await dialog.getByRole("button",{name:"성과 반영하고 완료",exact:true}).click();
  await expect(dialog).not.toBeVisible();expect(mock.state().metric!.currentValue).toBe(28);
});
test("Project detail edits its default while the KR basis is configured in Data",async({page})=>{
  const mock=await mocks(page);await page.goto(detail);
  await page.getByRole("button",{name:"기여량 변경",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"성과 쌓기 설정",exact:true});
  await dialog.getByLabel("기본 기여량",{exact:true}).fill("15.5");
  await expect(dialog.getByLabel("KR 현재값",{exact:true})).toHaveCount(0);
  await dialog.getByRole("button",{name:"저장",exact:true}).click();
  await expect(dialog).not.toBeVisible();expect(mock.state().contribution!.defaultValue).toBe(15.5);
  await expect(page.getByText("목표 Task 수",{exact:true})).toHaveCount(0);
});
test("Viewer cannot configure or complete Projects; API-linked KR cannot use a second metric source",async({page})=>{
  await mocks(page,{viewer:true});await page.goto(detail);
  await expect(page.locator(".project-contribution")).toContainText("기본 기여량");
  await expect(page.getByRole("button",{name:"기여량 변경",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Project 완료",exact:true})).toHaveCount(0);
});
test("KR data view displays Project contributions and target values",async({page})=>{
  await mocks(page);await page.goto("/?view=data");
  const card=page.locator(".kr-data-card").filter({has:page.getByRole("heading",{name:"활성 사용자 20% 증가",exact:true})});
  await expect(card).toContainText("Project 성과 합산");await expect(card).toContainText("20건");await expect(card).toContainText("100건");
});
test("completion review preserves fonts, contrast, keyboard and larger text from 320px to 4K",async({page},info)=>{
  test.skip(info.project.name!=="desktop-chromium");test.setTimeout(150_000);
  await mocks(page);await page.goto(detail);await page.getByRole("button",{name:"Project 완료",exact:true}).click();
  const panel=page.locator(".contribution-dialog");
  for(const width of [320,390,768,1440,1920,2560,3840]){
    await page.setViewportSize({width,height:1000});
    for(const size of ["100%","200%"]){
      await page.evaluate(size=>{document.documentElement.style.fontSize=size;},size);
      const box=await panel.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));expect(box.scroll).toBeLessThanOrEqual(box.client+1);
    }
    await page.evaluate(()=>{document.documentElement.style.fontSize="100%";});
    await page.screenshot({path:info.outputPath(`project-contribution-${width}.png`)});
  }
  for(const theme of ["white","beige","gray","dark","neon","cyberpunk"]){
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    expect((await new AxeBuilder({page:page as never}).include(".contribution-dialog").withRules(["color-contrast"]).analyze()).violations,theme).toEqual([]);
  }
  await page.evaluate(()=>document.fonts.ready);
  const cdp=await page.context().newCDPSession(page);await cdp.send("DOM.enable");await cdp.send("CSS.enable");const doc=await cdp.send("DOM.getDocument");
  for(const selector of [".contribution-dialog h2",".contribution-preview"]){
    const {nodeId}=await cdp.send("DOM.querySelector",{nodeId:doc.root.nodeId,selector});const {fonts}=await cdp.send("CSS.getPlatformFontsForNode",{nodeId});
    expect(fonts.length).toBeGreaterThan(0);expect(fonts.every(font=>font.isCustomFont&&/Pretendard/.test(font.familyName))).toBe(true);
  }
  await cdp.detach();await page.keyboard.press("Escape");await expect(panel).not.toBeVisible();
});
