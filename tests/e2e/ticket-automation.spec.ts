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
  await page.getByRole('button',{name:/고객 요청 3/}).click();for(const label of ['고객사','요청자','요구사항','분류'])await expect(page.locator('.ticket-request-summary')).toContainText(label);await page.getByText('고객 원문 대화',{exact:true}).click();await expect(page.locator('.ticket-original-text').first()).toContainText('고객 원문 그대로');
  await page.getByRole('button',{name:'목록으로',exact:true}).click();await page.getByRole('combobox',{name:'티켓 분류',exact:true}).selectOption('all');await page.getByRole('button',{name:'티켓 더 불러오기',exact:true}).click();await expect(page.getByRole('button',{name:/마지막 페이지의 요청/})).toBeVisible();
  await page.getByText('설정·운영',{exact:true}).click();await page.getByRole('button',{name:'수집 점검',exact:true}).click();await expect(page.getByRole('cell',{name:'이전 대화 대조 중',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'4',exact:true})).toBeVisible();await expect(page.getByRole('status').filter({hasText:'수집은 계속되며 AI 분석은 한도 초기화까지 대기합니다.'})).toBeVisible();await page.getByText(/customer-example · 재시도 대기/).click();await expect(page.getByText('오늘의 AI 분석 횟수 한도에 도달했습니다.',{exact:true})).toBeVisible();await expect(page.getByText(/자동 재시도 예정/)).toBeVisible();await expect(page.getByText('원문은 저장되어 있습니다.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'요청으로 다시 검토',exact:true}).click();expect(writes.some(p=>p.operation==='reconcile'&&p.id==='receipt-1')).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);const axe=await new AxeBuilder({page:page as never}).include('.ticket-automation').analyze();expect(axe.violations).toEqual([]);await page.screenshot({path:info.outputPath('ticket-intake-coverage.png'),fullPage:true});
});

test("bulk personal slots, assignment defaults and reviewed ticket creation use mocked writes", async ({ page },info) => {
  await installApiMocks(page);
  const writes: Record<string, unknown>[] = [];
  const member = { id: "member-1", user_id: "user-1", display_name: "테스트 담당자" };
  const request = { id:"req-1",category:'improvement',product_id:'product-1',repository_id:'repo-1',owner_id:"workspace-1",team_id:"T1",source_channel:"C1",source_ts:"123.000",source_user:"U1",source_digest:"digest",source_text:"고객 요청",title:"긴 제목 고객의 버튼 문구와 정렬을 개선해 주세요 ".repeat(4),description:"버튼 문구 오타를 확인합니다.",risk:"low",reasons_json:"[]",state:"recommended",member_id:null,port_id:null,ticket_id:null,task_id:null,job_id:null,revision:1,notice:"",question:"",answer:"",created_at:"2026-10-22",updated_at:"2026-10-22" };
  const product={id:'product-1',name:'Example',revision:1,specification:'Approved product specification',setup_instructions:'Use the official runtime.',repositories_json:JSON.stringify([{id:'repo-1',name:'Web',remote:'https://github.com/example/web',installRoots:['.','frontend']}])};
  const data = { products:[product],settings:{enabled:true,destination:"CMGMT",prefix:"customer-",channels:[{id:"C1",name:"customer-example",enabled:true,autoApprove:"manual",memberId:member.id,portId:"",productId:product.id,repositoryId:'repo-1'}],notificationsAuthorized:false,defaultModel:""},requests:[request],ports:[] as Record<string,unknown>[],members:[member],devices:[],canManage:true,userId:"user-1" };
  await page.route("**/api/ticket-automation", async route => {
    if(route.request().method()==="POST") {
      const p=route.request().postDataJSON(); writes.push(p);
      if(p.operation==="ports") for(let i=1;i<=p.count;i++)data.ports.push({id:`port-${i}`,member_id:member.id,name:`${p.prefix} ${String(i).padStart(2,"0")} 포트`,device_id:null,enabled:1,last_seen_at:null,model:"",models_json:"[]",channel_ids_json:JSON.stringify([p.channelId]),computer_label:p.computerLabel,product_id:p.productId,repository_id:p.repositoryId});
      if(p.operation==="request"&&p.action==="start"){Object.assign(request,{state:'queued',member_id:member.id,port_id:'active-port'});data.ports.push({id:'active-port',member_id:member.id,name:'담당 02 포트',computer_label:'담당 PC',model:'gpt-6.1-sol',product_id:product.id,repository_id:'repo-1',device_id:'device-1',online:true,enabled:1,channel_ids_json:JSON.stringify(['C1'])} as never);request.revision++;}
      if(p.operation==="pair")return json(route,{code:"ABCD-EFGH",expiresAt:"2026-10-22T10:00:00Z",name:"테스트 01 포트",product,repository:JSON.parse(product.repositories_json)[0]});
    }
    return json(route,data);
  });
  await page.goto("/?view=tickets&ticketAutomation=1");
  const panel=page.getByRole("region",{name:"티켓 자동화",exact:true});
  await expect(panel.getByRole("button",{name:/긴 제목 고객/})).toBeVisible();
  await panel.getByRole("button",{name:/긴 제목 고객/}).click();
  await panel.getByText("담당자·포트 변경",{exact:true}).click();await expect(panel.getByRole("combobox",{name:"실행 포트",exact:true})).toHaveValue("");
  await expect(panel.getByRole('combobox',{name:'담당자',exact:true})).toHaveValue(member.id);
  await page.screenshot({path:info.outputPath('ticket-compact-start.png'),fullPage:true});
  await panel.getByRole("button",{name:"개발 승인",exact:true}).click();
  expect(writes.filter(p=>p.operation==='request')).toEqual([expect.objectContaining({action:'start',memberId:member.id,portId:''})]);await expect(panel.getByRole('region',{name:'요청 검토',exact:true}).getByRole('status')).toContainText('시작 준비 중');
  expect(writes.filter(p=>p.action==="start")).toHaveLength(1);await expect(panel.getByRole('definition').filter({hasText:'담당 02 포트'})).toBeVisible();await expect(panel.getByText('담당 PC',{exact:true})).toBeVisible();
  await panel.getByText("설정·운영",{exact:true}).click();await panel.getByRole("button",{name:"실행 포트",exact:true}).click();
  await panel.getByLabel("이름 앞부분").fill("태홍"); await panel.getByLabel("개수",{exact:true}).fill("10");
  await panel.getByRole('combobox',{name:'PC 이름',exact:true}).fill('Office PC');
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
  await page.goto('/?view=tickets&ticketAutomation=1');await page.getByText('설정·운영',{exact:true}).click();await page.getByRole('button',{name:'제품·저장소',exact:true}).click();
  await page.getByLabel('제품명',{exact:true}).fill('Example Product');await page.getByLabel('기본 명세',{exact:true}).fill('Review customer requests against the documented workflows.');await page.getByLabel('개발 환경 준비 지침').fill('Install the official runtime and preserve existing changes.');
  await page.getByLabel('저장소 이름',{exact:true}).fill('Web');await page.getByLabel('저장소 HTTPS 주소').fill('https://github.com/example/web.git');await page.getByLabel('의존성 준비 경로').fill('.,frontend');
  await page.getByRole('button',{name:'저장소 추가',exact:true}).click();await page.getByLabel('저장소 이름',{exact:true}).nth(1).fill('Service');await page.getByLabel('저장소 HTTPS 주소').nth(1).fill('https://github.com/example/service.git');await page.getByRole('button',{name:'제품 설정 저장',exact:true}).click();
  await expect.poll(()=>writes.length).toBe(1);expect(writes[0]).toMatchObject({operation:'product',name:'Example Product',repositories:[{name:'Web',installRoots:['.','frontend']},{name:'Service'}]});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);const axe=await new AxeBuilder({page:page as never}).include('.ticket-automation').analyze();expect(axe.violations).toEqual([]);await page.screenshot({path:info.outputPath('ticket-product-setup.png'),fullPage:true});
});

test('one warning approval shows processing and automatically advances to development with mocked writes',async({page,context},info)=>{
  test.setTimeout(60_000);await installApiMocks(page);
  const writes:Record<string,unknown>[]=[],member={id:'m1',user_id:'user-1',display_name:'박담당'};
  const r={id:'r1',category:'improvement',owner_id:'w1',source_channel:'C1',source_ts:'123.000',source_user:'U1',requester_slack_user:'U1',requester_name:'김고객',title:'주문접수 이후 매출 집계 기준 변경',description:'승인된 변경 범위를 확인합니다.',state:'security_review',risk:'review',member_id:'m1',revision:4,security_json:JSON.stringify({verdict:'warning',codes:['dependency_network','destructive']}),notice:'',answer:''};
  const data={settings:{enabled:true,channels:[{id:'C1',name:'고객-예시회사'}],destination:'C2',notificationsAuthorized:false},requests:[r],ports:[],members:[member],devices:[],canManage:true,userId:'user-1'};
  let releaseApproval!:()=>void,queuedReads=0;
  const approval=new Promise<void>(resolve=>{releaseApproval=resolve;});
  await page.route('**/api/ticket-automation*',async route=>{
    if(route.request().method()==='POST'){const p=route.request().postDataJSON();writes.push(p);await approval;if(p.action==='approve_warning'){r.state='queued';r.revision++;}}
    else if(r.state==='queued'&&++queuedReads>1){r.state='running';r.security_json=JSON.stringify({verdict:'warning',codes:['sensitive_change'],allow:true});}
    return json(route,data);
  });
  await page.goto('/?view=tickets&ticketAutomation=1');await page.getByRole('button',{name:/주문접수 이후 매출 집계/}).click();
  const detail=page.getByRole('region',{name:'요청 검토',exact:true}),approve=detail.getByRole('button',{name:'개발 시작',exact:true});
  await expect(approve).toBeEnabled();await expect(detail.getByRole('textbox',{name:'경고 확인 사유'})).toHaveCount(0);await expect(detail.getByRole('checkbox')).toHaveCount(0);await expect(detail.locator('button.primary-action')).toHaveCount(1);
  await page.evaluate(()=>document.fonts.ready);
  const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');const doc=await cdp.send('DOM.getDocument');const node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.ticket-workflow strong'});const{fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId});expect(fonts.filter(f=>f.glyphCount>0).every(f=>f.isCustomFont&&/Pretendard/.test(f.familyName))).toBe(true);await cdp.detach();
  for(const width of [320,390,768,1440,1920,2560,3840]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);}
  await page.setViewportSize({width:390,height:900});await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);await page.evaluate(()=>{document.documentElement.style.fontSize='';});
  await page.setViewportSize({width:info.project.name==='desktop-chromium'?1440:390,height:900});await page.screenshot({path:info.outputPath('ticket-clean-approval.png'),fullPage:true});
  const axe=await new AxeBuilder({page:page as never}).include('.ticket-automation').analyze();expect(axe.violations).toEqual([]);
  await approve.focus();await page.keyboard.press('Enter');await expect(detail.getByRole('status')).toContainText('처리 중…');await expect(approve).toBeDisabled();expect(writes).toEqual([expect.objectContaining({action:'approve_warning'})]);
  releaseApproval();await expect(detail.getByRole('status')).toContainText('시작 준비 중');await expect(detail.getByRole('button',{name:'개발 시작',exact:true})).toHaveCount(0);
  await expect(detail.getByRole('status')).toContainText('개발 중',{timeout:15_000});await expect(detail.getByRole('status')).toContainText('회신');expect(writes).toHaveLength(1);await page.screenshot({path:info.outputPath('ticket-development-progress.png'),fullPage:true});
});

test('guidance replies from the draft without ticket creation or port selection',async({page},info)=>{
  await installApiMocks(page);const writes:Record<string,unknown>[]=[];
  const r={id:'guide-1',category:'guidance',source_channel:'C1',source_ts:'123.000',source_text:'택배사 선택은 어디서 하나요?',title:'기본 택배사 설정 방법 안내',description:'고객의 문제\n택배사 설정 위치 문의\n\n안내 초안\n설정 화면에서 기본 택배사를 선택해 주세요.\n\n완료 확인 기준\n설정 확인',state:'recommended',risk:'review',member_id:null,port_id:null,requester_slack_user:'UCUSTOMER',requester_name:'김고객',revision:1,notice:'',dependencies_json:'[]'};
  const data={settings:{enabled:true,channels:[{id:'C1',name:'고객-초록청년',enabled:true}],notificationsAuthorized:true},requests:[r],ports:[],members:[],devices:[],products:[],canManage:true,userId:'user-1'};
  await page.route('**/api/ticket-automation*',async route=>{if(route.request().method()==='POST'){writes.push(route.request().postDataJSON());r.state='publishing';r.revision++;}return json(route,data);});
  await page.goto('/?view=tickets&ticketAutomation=1');await page.getByRole('button',{name:/기본 택배사 설정 방법 안내/}).click();const detail=page.getByRole('region',{name:'요청 검토',exact:true});await expect(detail.getByRole('combobox',{name:'실행 포트',exact:true})).toHaveCount(0);await expect(detail.getByRole('button',{name:'개발 승인',exact:true})).toHaveCount(0);await expect(detail.getByRole('textbox',{name:'회신 내용',exact:true})).toHaveValue('설정 화면에서 기본 택배사를 선택해 주세요.');await detail.getByRole('textbox',{name:'회신 내용',exact:true}).fill('설정 화면에서 기본 택배사를 선택하고 저장해 주세요.');await page.screenshot({path:info.outputPath('ticket-direct-reply.png'),fullPage:true});await detail.getByRole('button',{name:'승인하고 보내기',exact:true}).click();expect(writes).toEqual([expect.objectContaining({action:'reply',requesterSlackUser:'UCUSTOMER',notice:'설정 화면에서 기본 택배사를 선택하고 저장해 주세요.'})]);await expect(detail.getByRole('status')).toContainText('회신 전송 중');await expect(detail.getByRole('list',{name:'티켓 진행 단계'})).not.toContainText('개발');
});

test("automation remains readable in dark mode and at 200% text zoom",async({page})=>{
  await installApiMocks(page);
  await page.addInitScript(()=>localStorage.setItem("okri.theme","dark"));
  await page.route("**/api/ticket-automation",route=>json(route,{settings:{enabled:false,destination:"",prefix:"customer-",channels:[],notificationsAuthorized:false},requests:[],ports:[],members:[{id:"m1",user_id:"user-1",display_name:"사용자"}],devices:[],canManage:true,userId:"user-1"}));
  await page.goto("/?view=tickets&ticketAutomation=1");
  await page.getByText("설정·운영",{exact:true}).click();await page.getByRole("button",{name:"실행 포트",exact:true}).click();
  await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
  await expect(page.getByLabel("개수",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const axe=await new AxeBuilder({page:page as never}).include(".ticket-automation").analyze(); expect(axe.violations).toEqual([]);
});

test('an assigned port remains visible in dark mode while an operator reply continues without a second approval',async({page},info)=>{
  await installApiMocks(page);await page.addInitScript(()=>localStorage.setItem('okri.theme','dark'));const writes:Record<string,unknown>[]=[];
  const r={id:'assigned-1',category:'feature',source_channel:'C1',source_ts:'123.000',source_text:'정산 조회 기능 요청',title:'정산 조회 범위 제안',description:'현재 제품의 계산식을 확인합니다.',state:'waiting_answer',risk:'review',member_id:'m1',port_id:'p1',requester_name:'김고객',revision:2,question:'현재 매출 계산식을 유지한 조회 화면을 추천합니다. 이 범위로 진행할까요?',answer:'',security_json:'{}'};
  const data={settings:{enabled:true,defaultModel:'gpt-6.1-sol',channels:[{id:'C1',name:'고객-예시'}]},requests:[r],ports:[{id:'p1',member_id:'m1',name:'담당 02 포트',computer_label:'담당 PC',model:''}],members:[{id:'m1',user_id:'user-1',display_name:'박담당'}],devices:[],products:[],canManage:true,userId:'user-1'};
  await page.route('**/api/ticket-automation*',async route=>{if(route.request().method()==='POST'){writes.push(route.request().postDataJSON());r.state='queued';r.revision++;}return json(route,data);});
  await page.goto('/?view=tickets&ticketAutomation=1');await page.getByRole('button',{name:/정산 조회 범위 제안/}).click();const detail=page.getByRole('region',{name:'요청 검토',exact:true});
  await expect(detail.getByRole('status')).toContainText('담당자 회신 대기');for(const text of ['박담당','담당 PC','담당 02 포트','gpt-6.1-sol'])await expect(detail.locator('.ticket-execution')).toContainText(text);
  for(const width of [390,1440]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);}await page.setViewportSize({width:390,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='200%');expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);await page.evaluate(()=>document.documentElement.style.fontSize='');
  const axe=await new AxeBuilder({page:page as never}).include('.ticket-automation').analyze();expect(axe.violations).toEqual([]);await page.screenshot({path:info.outputPath('ticket-assigned-port-dark.png'),fullPage:true});
  await detail.getByRole('textbox',{name:'담당자 답변',exact:true}).fill('기존 계산식을 유지해 진행해 주세요.');await detail.getByRole('button',{name:'답변하고 계속 진행',exact:true}).click();expect(writes).toEqual([expect.objectContaining({action:'answer_resume'})]);await expect(detail.getByRole('status')).toContainText('시작 준비 중');await expect(detail.locator('.ticket-execution')).toContainText('담당 02 포트');await expect(detail.getByRole('button',{name:'개발 승인',exact:true})).toHaveCount(0);
});
