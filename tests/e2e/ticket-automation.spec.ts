import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installApiMocks, json } from "./api-mocks";

test('four categories, original evidence and paginated intake coverage remain visible with mocked writes',async({page},info)=>{
  await installApiMocks(page);const writes:Record<string,unknown>[]=[];
  const categories=['bug_fix','improvement','feature','guidance'];
  const requests=categories.map((category,i)=>({id:`categorized-${i}`,category,source_channel:'C1',source_ts:'123.000',source_text:'고객 원문 그대로\n견적서 화면에서 다음 단계로 진행할 수 없습니다. '.repeat(8),title:`고객 요청 ${i}`,description:'고객의 문제\n다음 단계로 진행할 수 없습니다.\n\n해결 제안\n기대 동작을 확인하고 필요한 범위를 수정합니다.\n\n이렇게 진행할까요?',analysis_json:JSON.stringify({model:'gpt-6.1-sol'}),priority:'medium',state:'recommended',risk:'review',member_id:null,port_id:null,revision:1,dependencies_json:'[]',notice:'',question:'',answer:''}));
  const intake={offset:0,total:101,hasMore:true,counts:[{state:'retry',count:1},{state:'no_work',count:100}],channels:[{channel_id:'C1',cursor:'older',completed_passes:0,messages_seen:100,last_checked_at:'2026-10-22T02:00:00Z',last_completed_at:null,last_error:'',pending_threads:4}],messages:[{id:'receipt-1',channel_id:'C1',message_ts:'123.000',state:'retry',attempts:2,last_error:'ai_daily_limit_reached',next_attempt_at:'2026-10-23T00:00:00Z',received_at:'2026-10-22T02:00:00Z',text:'원문은 저장되어 있습니다.'}]};
  const data={intake,settings:{enabled:true,destination:'CMGMT',prefix:'customer-',channels:[{id:'C1',name:'customer-example',enabled:true,autoApprove:'manual'}],notificationsAuthorized:true,defaultModel:'gpt-6.1-sol'},requests,requestPage:{total:204,offset:0,hasMore:true},products:[],ports:[],devices:[],members:[],canManage:true,userId:'user-1'};
  await page.route('**/api/ticket-automation*',async route=>{const url=new URL(route.request().url());if(route.request().method()==='POST')writes.push(route.request().postDataJSON());if(url.searchParams.has('intakeOffset'))return json(route,{intake:{...intake,offset:100,total:101,hasMore:false,messages:[]}});if(url.searchParams.has('offset'))return json(route,{...data,requests:[{...requests[0],id:'last-page',title:'마지막 페이지의 요청'}],requestPage:{total:204,offset:200,hasMore:false}});return json(route,data);});
  await page.goto('/?view=tickets&ticketAutomation=1');
  await page.getByRole('combobox',{name:'티켓 분류',exact:true}).selectOption('guidance');await expect(page.getByRole('button',{name:/고객 요청 3/})).toBeVisible();await expect(page.getByRole('button',{name:/고객 요청 0/})).toHaveCount(0);
  await page.getByRole('button',{name:/고객 요청 3/}).click();await expect(page.getByText('단순 안내 · 추천 모델: gpt-6.1-sol',{exact:true})).toBeVisible();await page.getByText('고객 원문 대화',{exact:true}).click();await expect(page.locator('.ticket-original-text').first()).toContainText('고객 원문 그대로');
  await page.getByRole('combobox',{name:'티켓 분류',exact:true}).selectOption('all');await page.getByRole('button',{name:'티켓 더 불러오기',exact:true}).click();await expect(page.getByRole('button',{name:/마지막 페이지의 요청/})).toBeVisible();
  await page.getByRole('button',{name:'수집 점검',exact:true}).click();await expect(page.getByRole('cell',{name:'이전 대화 대조 중',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'4',exact:true})).toBeVisible();await expect(page.getByRole('status').filter({hasText:'수집은 계속되며 AI 분석은 한도 초기화까지 대기합니다.'})).toBeVisible();await page.getByText(/customer-example · 재시도 대기/).click();await expect(page.getByText('오늘의 AI 분석 횟수 한도에 도달했습니다.',{exact:true})).toBeVisible();await expect(page.getByText(/자동 재시도 예정/)).toBeVisible();await expect(page.getByText('원문은 저장되어 있습니다.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'요청으로 다시 검토',exact:true}).click();expect(writes.some(p=>p.operation==='reconcile'&&p.id==='receipt-1')).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);const axe=await new AxeBuilder({page:page as never}).include('.ticket-automation').analyze();expect(axe.violations).toEqual([]);await page.screenshot({path:info.outputPath('ticket-intake-coverage.png'),fullPage:true});
});

test("bulk personal slots, assignment defaults and reviewed ticket creation use mocked writes", async ({ page },info) => {
  await installApiMocks(page);
  const writes: Record<string, unknown>[] = [];
  const member = { id: "member-1", user_id: "user-1", display_name: "테스트 담당자" };
  const request = { id:"req-1",owner_id:"workspace-1",team_id:"T1",source_channel:"C1",source_ts:"123.000",source_user:"U1",source_digest:"digest",source_text:"고객 요청",title:"긴 제목 고객의 버튼 문구와 정렬을 개선해 주세요 ".repeat(4),description:"버튼 문구 오타를 확인합니다.",risk:"low",reasons_json:"[]",state:"recommended",member_id:"member-1",port_id:null,ticket_id:null,task_id:null,job_id:null,revision:1,notice:"",question:"",answer:"",created_at:"2026-10-22",updated_at:"2026-10-22" };
  const product={id:'product-1',name:'Example',revision:1,specification:'Approved product specification',setup_instructions:'Use the official runtime.',repositories_json:JSON.stringify([{id:'repo-1',name:'Web',remote:'https://github.com/example/web',installRoots:['.','frontend']}])};
  const data = { products:[product],settings:{enabled:true,destination:"CMGMT",prefix:"customer-",channels:[{id:"C1",name:"customer-example",enabled:true,autoApprove:"manual",memberId:member.id,portId:"",productId:product.id,repositoryId:'repo-1'}],notificationsAuthorized:false,defaultModel:""},requests:[request],ports:[] as Record<string,unknown>[],members:[member],devices:[],canManage:true,userId:"user-1" };
  await page.route("**/api/ticket-automation", async route => {
    if(route.request().method()==="POST") {
      const p=route.request().postDataJSON(); writes.push(p);
      if(p.operation==="ports") for(let i=1;i<=p.count;i++)data.ports.push({id:`port-${i}`,member_id:member.id,name:`${p.prefix} ${String(i).padStart(2,"0")} 포트`,device_id:null,enabled:1,last_seen_at:null,model:"",models_json:"[]",channel_ids_json:JSON.stringify([p.channelId]),computer_label:p.computerLabel,product_id:p.productId,repository_id:p.repositoryId});
      if(p.operation==="request"&&p.action==="create"){request.state="created";request.revision++;}
      if(p.operation==="pair")return json(route,{code:"ABCD-EFGH",expiresAt:"2026-10-22T10:00:00Z",name:"테스트 01 포트",product,repository:JSON.parse(product.repositories_json)[0]});
    }
    return json(route,data);
  });
  await page.goto("/?view=tickets&ticketAutomation=1");
  const panel=page.getByRole("region",{name:"티켓 자동화",exact:true});
  await expect(panel.getByRole("button",{name:/긴 제목 고객/})).toBeVisible();
  await panel.getByRole("button",{name:/긴 제목 고객/}).click();
  await expect(panel.getByRole("combobox",{name:"실행 포트",exact:true})).toHaveValue("");
  await panel.getByRole("button",{name:"티켓 생성",exact:true}).click();
  await expect(panel.getByRole("button",{name:"개발 승인",exact:true})).toBeVisible();
  expect(writes.filter(p=>p.action==="create")).toHaveLength(1);
  await panel.getByRole("button",{name:"실행 포트",exact:true}).click();
  await panel.getByLabel("이름 앞부분").fill("태홍"); await panel.getByLabel("개수",{exact:true}).fill("10");
  await panel.getByLabel('PC 이름',{exact:true}).fill('Office PC');
  await panel.getByRole('combobox',{name:'고객 프로젝트',exact:true}).selectOption('C1');
  await panel.getByRole("button",{name:"포트 만들기"}).click();
  await expect(panel.getByText("태홍 10 포트",{exact:true})).toBeVisible();
  await panel.getByRole("button",{name:"연결 문구 만들기"}).first().click();
  await expect(panel.getByLabel("Codex에 붙여넣을 연결 문구")).toHaveValue(/ABCD-EFGH/);
  await expect(panel.getByLabel("Codex에 붙여넣을 연결 문구")).toHaveValue(/Approved product specification/);
  expect(writes.find(p=>p.operation==='ports')).toMatchObject({computerLabel:'Office PC',productId:'product-1',repositoryId:'repo-1',count:10});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const axe=await new AxeBuilder({page:page as never}).include(".ticket-automation").analyze(); expect(axe.violations).toEqual([]);
  await page.screenshot({path:info.outputPath('ticket-slots.png'),fullPage:true});
});

test('product setup captures specification, environment and multiple repositories with mocked writes',async({page},info)=>{
  await installApiMocks(page);const writes:Record<string,unknown>[]=[];
  await page.route('**/api/ticket-automation',async route=>{if(route.request().method()==='POST')writes.push(route.request().postDataJSON());return json(route,{products:[],settings:{enabled:false,channels:[],destination:'',notificationsAuthorized:false},requests:[],ports:[],members:[],devices:[],canManage:true,userId:'user-1'});});
  await page.goto('/?view=tickets&ticketAutomation=1');await page.getByRole('button',{name:'제품·저장소',exact:true}).click();
  await page.getByLabel('제품명',{exact:true}).fill('Example Product');await page.getByLabel('기본 명세',{exact:true}).fill('Review customer requests against the documented workflows.');await page.getByLabel('개발 환경 준비 지침').fill('Install the official runtime and preserve existing changes.');
  await page.getByLabel('저장소 이름',{exact:true}).fill('Web');await page.getByLabel('저장소 HTTPS 주소').fill('https://github.com/example/web.git');await page.getByLabel('의존성 준비 경로').fill('.,frontend');
  await page.getByRole('button',{name:'저장소 추가',exact:true}).click();await page.getByLabel('저장소 이름',{exact:true}).nth(1).fill('Service');await page.getByLabel('저장소 HTTPS 주소').nth(1).fill('https://github.com/example/service.git');await page.getByRole('button',{name:'제품 설정 저장',exact:true}).click();
  await expect.poll(()=>writes.length).toBe(1);expect(writes[0]).toMatchObject({operation:'product',name:'Example Product',repositories:[{name:'Web',installRoots:['.','frontend']},{name:'Service'}]});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);const axe=await new AxeBuilder({page:page as never}).include('.ticket-automation').analyze();expect(axe.violations).toEqual([]);await page.screenshot({path:info.outputPath('ticket-product-setup.png'),fullPage:true});
});

test('final security warning requires acknowledgement and a reason, supports keyboard use and renders the shared font',async({page,context},info)=>{
  await installApiMocks(page);
  const writes:Record<string,unknown>[]=[];
  const member={id:'m1',user_id:'user-1',display_name:'담당자'};
  const r={id:'r1',owner_id:'w1',source_channel:'C1',source_ts:'123.000',source_user:'U1',requester_slack_user:'U1',requester_name:'고객 담당자',title:'고객 요청 Ticket 2026 민감 기능 변경 범위 검토',description:'승인된 변경 범위를 확인합니다.',state:'security_review',risk:'review',member_id:'m1',revision:4,security_json:JSON.stringify({verdict:'warning',codes:['sensitive_change']}),notice:'',answer:''};
  const data={settings:{enabled:true,channels:[],destination:'C2',notificationsAuthorized:false},requests:[r],ports:[],members:[member],devices:[],canManage:true,userId:'user-1'};
  await page.route('**/api/ticket-automation',async route=>{
    if(route.request().method()==='POST'){const p=route.request().postDataJSON();writes.push(p);if(p.action==='force'){r.state='queued';r.revision++;}}
    return json(route,data);
  });
  await page.goto('/?view=tickets&ticketAutomation=1');
  const row=page.getByRole('button',{name:/고객 요청 Ticket 2026/});await row.click();
  const force=page.getByRole('button',{name:'사유를 남기고 강제 진행'});await expect(force).toBeDisabled();
  await page.getByLabel('경고 확인 사유').fill('담당자가 제한된 변경 범위를 확인했습니다.');await expect(force).toBeDisabled();
  await page.getByRole('checkbox',{name:'경고 내용과 요청 범위를 확인했습니다.'}).focus();await page.keyboard.press('Space');await expect(force).toBeEnabled();
  await page.evaluate(()=>document.fonts.ready);
  const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const doc=await cdp.send('DOM.getDocument');const node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.ticket-request-row strong'});const{fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId});expect(fonts.filter(f=>f.glyphCount>0).every(f=>f.isCustomFont&&/Pretendard/.test(f.familyName))).toBe(true);await cdp.detach();
  for(const width of [320,390,768,1440,1920,2560,3840]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);}
  await page.screenshot({path:info.outputPath('ticket-security-warning.png'),fullPage:true});
  const axe=await new AxeBuilder({page:page as never}).include('.ticket-automation').analyze();expect(axe.violations).toEqual([]);
  await force.focus();await page.keyboard.press('Enter');await expect(row).toContainText('실행 대기');expect(writes.find(p=>p.action==='force')).toMatchObject({acknowledged:true,reason:'담당자가 제한된 변경 범위를 확인했습니다.'});
});

test("automation remains readable in dark mode and at 200% text zoom",async({page})=>{
  await installApiMocks(page);
  await page.addInitScript(()=>localStorage.setItem("okri.theme","dark"));
  await page.route("**/api/ticket-automation",route=>json(route,{settings:{enabled:false,destination:"",prefix:"customer-",channels:[],notificationsAuthorized:false},requests:[],ports:[],members:[{id:"m1",user_id:"user-1",display_name:"사용자"}],devices:[],canManage:true,userId:"user-1"}));
  await page.goto("/?view=tickets&ticketAutomation=1");
  await page.getByRole("button",{name:"실행 포트",exact:true}).click();
  await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
  await expect(page.getByLabel("개수",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const axe=await new AxeBuilder({page:page as never}).include(".ticket-automation").analyze(); expect(axe.violations).toEqual([]);
});
