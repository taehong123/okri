import test from "node:test";import assert from "node:assert/strict";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";import {Client} from "@modelcontextprotocol/sdk/client/index.js";import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {fixture,compile,read,model,reports,now,channel} from "./helpers/daily-report-fixture.mjs";
const source=await read("lib/mcp-daily-reports.ts"),configSource=await read("lib/daily-report-config.ts");
async function mcp(t,auth={ownerId:"w",userId:"u",role:"owner"}) {
 const f=fixture(t);t.mock.timers.enable({apis:["Date"],now:now.getTime()});let requests=0,discoveries=0;
 const adapter={reportChannels:async()=>{discoveries++;return [channel];},requestReportReview:async(_db,owner,id,revision,_now,defer)=>{assert.equal(owner,"w");assert.equal(defer,true);requests++;return {...await reports.getReportDraft(f.db,owner,id),revision,status:"review_queued"};}};
 const config=compile(configSource,{"./daily-report-model":model,"./daily-report":reports,"./daily-report-slack":adapter});
 const api=compile(source,{"./daily-report":reports,"./daily-report-config":config,"./daily-report-slack":adapter,"./slack-daily":{listSlackChannels:async()=>{discoveries++;return [channel];}}});
 const server=new McpServer({name:"daily-report-test",version:"1"});api.registerDailyReportTools(server,f.db,auth);const client=new Client({name:"consumer",version:"1"});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 return {...f,client,config,requests:()=>requests,discoveries:()=>discoveries,call:async(name,args={})=>client.callTool({name,arguments:args})};
}
test("SDK tools keep readers side-effect free and persist conversational instructions with exact caller identity",async t=>{
 const f=await mcp(t),tools=(await f.client.listTools()).tools;assert.equal(tools.length,5);assert.deepEqual(tools.filter(t=>t.annotations.readOnlyHint).map(t=>t.name).sort(),["get_daily_report_context","get_daily_report_preferences"]);
 const before=f.sql.prepare("SELECT total_changes() n").get().n;
 const preferences=(await f.call("get_daily_report_preferences")).structuredContent;assert.equal(preferences.currentMemberId,"m1");assert.equal(preferences.policy.reportTime,"12:00");
 await f.call("get_daily_report_context");assert.equal(f.sql.prepare("SELECT total_changes() n").get().n,before);assert.equal(f.discoveries(),0);assert.equal(f.requests(),0);
 const saved=await f.call("set_daily_report_preferences",{expected_version:0,enabled:true,approver_member_id:"me",trigger:"at_time",instructions:"프로젝트별로 짧게 쓰고 막힌 일을 끝에 적어줘"});assert.equal(saved.isError,undefined);assert.equal(saved.structuredContent.policy.approverMemberId,"m1");
 const context=(await f.call("get_daily_report_context")).structuredContent;assert.match(context.instructions,/프로젝트별/);assert.equal(context.facts.groups[0].title,"Project A");
 const draft=await f.call("save_daily_report_draft",{report_date:context.facts.date,source_hash:context.facts.sourceHash,policy_version:context.preferences.policy.version,pages:["*Project A*\n• Task one · Member\n\n막힌 일 없음"]});assert.equal(draft.structuredContent.status,"draft");assert.equal(f.requests(),0);
 const queued=await f.call("request_daily_report_approval",{draft_id:draft.structuredContent.id,revision:1});assert.equal(queued.structuredContent.status,"review_queued");assert.equal(f.requests(),1);assert.equal(tools.some(t=>/approve_daily|publish_daily/.test(t.name)),false);
});
for(const [role,scopes]of [["member",undefined],["viewer",undefined],["admin","okri:read"]])test(`${role}/${scopes??"session"} cannot write report settings or request approval`,async t=>{
 const f=await mcp(t,{ownerId:"w",userId:"u",role,oauthScopes:scopes});assert.equal((await f.call("set_daily_report_preferences",{expected_version:0,enabled:true})).isError,true);assert.equal((await f.call("request_daily_report_approval",{draft_id:"unknown",revision:1})).isError,true);assert.equal(f.requests(),0);assert.equal(f.sql.prepare("SELECT count(*) n FROM daily_report_policies").get().n,0);
});
test("HTTP preferences enforce admin access before reads or writes and reject read-only OAuth writes",async t=>{
 const f=await mcp(t);let auth={ownerId:"w",userId:"u",role:"member"},ensured=0;
 const route=compile(await read("app/api/daily-reports/preferences/route.ts"),{"cloudflare:workers":{env:{DB:f.db}},"@/lib/pace-data":{authorizeRequest:async()=>auth,ensureWorkspace:async()=>{ensured++;}},"@/lib/daily-report":reports,"@/lib/daily-report-config":f.config,"@/lib/slack-daily":{listSlackChannels:async()=>[channel]}});
 assert.equal((await route.GET(new Request("https://okri.test/api/daily-reports/preferences"))).status,403);assert.equal(ensured,0);
 auth={...auth,role:"admin",oauthScopes:"okri:read"};assert.equal((await route.PUT(new Request("https://okri.test/api/daily-reports/preferences",{method:"PUT",body:JSON.stringify({version:0})}))).status,403);assert.equal(ensured,0);
 const before=f.sql.prepare("SELECT total_changes() n").get().n;const response=await route.GET(new Request("https://okri.test/api/daily-reports/preferences"));assert.equal(response.status,200);assert.match(response.headers.get("Cache-Control"),/no-store/);assert.equal(f.sql.prepare("SELECT total_changes() n").get().n,before);
});
