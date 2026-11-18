import {test,expect} from "@playwright/test";
import {installApiMocks} from "./api-mocks";
import AxeBuilder from "@axe-core/playwright";
const token="wl_00000000-0000-4000-8000-000000000001."+"a".repeat(64);
for(const expired of [false,true])test(`shared invite shows the workspace/role and requires an explicit join (${expired?"expired":"valid"})`,async({page})=>{
 await installApiMocks(page,{teamWorkspace:true});const writes:unknown[]=[];
 await page.route("**/api/workspace-invite-links/preview?*",route=>route.fulfill({json:{invitation:{workspace:{id:"new-workspace",name:"함께 진행하는 팀 워크스페이스"},role:"member",inviterName:"팀장",emailHint:"",kind:"workspace_link",status:expired?"expired":"pending",expiresAt:"2026-12-18T06:00:00Z"}}}));
 await page.route("**/api/workspace-invite-links/accept",async route=>{writes.push(route.request().postDataJSON());return route.fulfill({json:{accepted:true,workspaceId:"new-workspace",workspaceName:"함께 진행하는 팀 워크스페이스"}});});
 await page.goto("/#invite="+encodeURIComponent(token));const dialog=page.getByRole("dialog",{name:"워크스페이스 초대",exact:true});await expect(dialog).toBeVisible();await expect(dialog).toContainText("함께 진행하는 팀 워크스페이스");await expect(dialog).not.toContainText("초대 계정");expect(writes).toHaveLength(0);
 if(expired){await expect(dialog.getByRole("button",{name:"이 워크스페이스에 가입",exact:true})).toHaveCount(0);await expect(dialog).toContainText("만료");}
 else{await expect(dialog).toContainText("로그인한 계정으로");await dialog.getByRole("button",{name:"이 워크스페이스에 가입",exact:true}).click();await expect(dialog).not.toBeVisible();expect(writes).toEqual([{token}]);}
});
test("legacy email invitations keep their account-matching instruction and separate endpoints",async({page})=>{
 await installApiMocks(page,{teamWorkspace:true});await page.goto("/#invite="+"b".repeat(64));const dialog=page.getByRole("dialog",{name:"워크스페이스 초대",exact:true});await expect(dialog).toBeVisible();await expect(dialog).toContainText("초대 계정");await expect(dialog).toContainText("같은 Google 계정");
});
test("shared invite retains mobile wrapping, text zoom, themes and rendered fonts",async({page},info)=>{
 test.skip(info.project.name!=="desktop-chromium");test.setTimeout(90000);await installApiMocks(page,{teamWorkspace:true});
 await page.route("**/api/workspace-invite-links/preview?*",route=>route.fulfill({json:{invitation:{workspace:{id:"new-workspace",name:"긴 이름을 가진 팀 워크스페이스 MIXSOON AX 2026"},role:"member",inviterName:"팀장",emailHint:"",kind:"workspace_link",status:"pending",expiresAt:"2026-12-18T06:00:00Z"}}}));await page.goto("/#invite="+encodeURIComponent(token));const panel=page.locator(".invitation-dialog");await expect(panel).toBeVisible();
 for(const width of [320,390,768,1440,3840]){await page.setViewportSize({width,height:1000});for(const size of ["100%","200%"]){await page.evaluate(size=>document.documentElement.style.fontSize=size,size);const bounds=await panel.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));expect(bounds.scroll,`${width}/${size}`).toBeLessThanOrEqual(bounds.width+1);}await page.evaluate(()=>document.documentElement.style.fontSize="100%");}
 for(const theme of ["white","beige","gray","dark","neon","cyberpunk"]){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);const result=await new AxeBuilder({page:page as never}).include(".invitation-dialog").withRules(["color-contrast","button-name"]).analyze();expect(result.violations,theme).toEqual([]);}
 await panel.getByRole("button",{name:"이 워크스페이스에 가입",exact:true}).focus();await expect(panel.getByRole("button",{name:"이 워크스페이스에 가입",exact:true})).toBeFocused();await page.evaluate(()=>document.fonts.ready);const cdp=await page.context().newCDPSession(page);await cdp.send("DOM.enable");await cdp.send("CSS.enable");const {root}=await cdp.send("DOM.getDocument");const {nodeId}=await cdp.send("DOM.querySelector",{nodeId:root.nodeId,selector:".invitation-dialog h2"});const {fonts}=await cdp.send("CSS.getPlatformFontsForNode",{nodeId});expect(fonts.length).toBeGreaterThan(0);expect(fonts.every((f:{familyName:string})=>/Pretendard/.test(f.familyName))).toBe(true);await cdp.detach();await panel.screenshot({path:info.outputPath("invite-link.png")});
});
