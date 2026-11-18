import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {DatabaseSync} from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
const require=createRequire(import.meta.url),read=p=>readFile(new URL(`../${p}`,import.meta.url),"utf8");
function compile(source,dependencies={}) {
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m={exports:{}};
  new Function("require","module","exports",js)(name=>name in dependencies?dependencies[name]:require(name),m,m.exports);return m.exports;
}
const model=compile(await read("lib/project-metric-schedule-model.ts"));
const api=compile(await read("lib/project-metric-schedules.ts"),{"./project-metric-schedule-model":model});
const contributions=compile(await read("lib/project-contributions.ts"));
const sync=compile(await read("lib/kr-data-sync.ts"));
const sources=compile(await read("lib/kr-data-sources.ts"),{"./project-contributions":contributions,"./kr-data-sync":sync});
const mcp=compile(await read("lib/mcp-contribution-schedules.ts"),{"./project-metric-schedules":api,"./kr-data-sources":sources});
const schema=JSON.parse(await read("drizzle/meta/0071_snapshot.json"));
const migrations=await Promise.all(["0076_project_task_goals","0077_project_contributions","0078_kr_data_sources","0079_kr_metric_history","0080_project_metric_schedules"].map(n=>read(`drizzle/${n}.sql`)));
const now=new Date("2026-11-18T06:00:00Z"),base={mode:"daily",amount:2,startDate:"2026-11-13",endDate:null,pauses:[]};
function fixture(t) {
  const sql=new DatabaseSync(":memory:");t.after(()=>sql.close());sql.exec("PRAGMA foreign_keys=ON;PRAGMA recursive_triggers=ON");
  for(const name of ["users","workspaces","items","kr_data_connections","activity_log","workspace_backup_state","workspace_backup_guards"]) {
    const cols=Object.values(schema.tables[name].columns).map(c=>`${c.name} ${c.type}${c.primaryKey?" PRIMARY KEY":""}${c.notNull?" NOT NULL":""}${c.default!==undefined?` DEFAULT ${c.default}`:""}`);sql.exec(`CREATE TABLE ${name} (${cols.join(",")})`);
  }
  sql.exec(`CREATE UNIQUE INDEX connection_item ON kr_data_connections(owner_id,kr_item_id);
    INSERT INTO users(id,email_normalized) VALUES('u','owner@example.com');INSERT INTO workspaces(id,name,owner_user_id) VALUES('w','Workspace','u'),('other','Other','u');
    INSERT INTO workspace_backup_state(owner_id) VALUES('w'),('other');
    INSERT INTO items(id,owner_id,parent_id,kind,title) VALUES('kr','w',NULL,'key_result','Hours saved'),('kr2','w',NULL,'key_result','Second'),('i','w','kr','initiative','Initiative'),('i2','w','kr2','initiative','Second initiative'),('p','w','i','project','Automation'),('q','w','i','project','Another'),('t','w','p','task','Task'),('foreign','other',NULL,'project','Foreign');`);
  for(const migration of migrations)sql.exec(migration);
  sql.exec("INSERT INTO kr_project_metrics(id,owner_id,kr_item_id,starting_value,target_value,unit) VALUES('m','w','kr',20,100,'시간')");
  const prepare=(query,args=[])=>({bind:(...v)=>prepare(query,v),first:async()=>sql.prepare(query).get(...args)??null,all:async()=>({results:sql.prepare(query).all(...args)}),run:async()=>({meta:{changes:Number(sql.prepare(query).run(...args).changes)}})});
  const db={prepare,batch:async statements=>{sql.exec("BEGIN");try{const result=[];for(const s of statements)result.push(await s.run());sql.exec("COMMIT");return result;}catch(error){sql.exec("ROLLBACK");throw error;}}};
  const state=(id="p",at=now)=>api.readProjectSchedule(db,"w",id,at);
  const save=async(input={},id="p",at=now)=>api.saveProjectSchedule(db,"w",id,{...base,...input},(await state(id,at)).revision,at);
  const progress=()=>sql.prepare("SELECT progress FROM items WHERE id='kr'").get().progress;
  return {sql,db,state,save,progress};
}
test("three modes count explicit one-off dates, closed daily dates and business days excluding holidays/pauses",()=>{
  const calendar={timezone:"Asia/Seoul",holidays:["2026-11-16"],version:1};
  assert.deepEqual(model.scheduleCredits(base,calendar,now).dates,["2026-11-13","2026-11-14","2026-11-15","2026-11-16","2026-11-17"]);
  assert.deepEqual(model.scheduleCredits({...base,mode:"business_days"},calendar,now).dates,["2026-11-13","2026-11-17"]);
  assert.equal(model.scheduleCredits({...base,mode:"business_days",pauses:[{startDate:"2026-11-17",endDate:null}]},calendar,now).accruedValue,2);
  assert.equal(model.scheduleCredits({...base,mode:"once",startDate:"2026-11-18"},calendar,now).accruedValue,2);
  assert.equal(model.scheduleCredits({...base,mode:"once",startDate:"2026-11-19"},calendar,now).accruedValue,0);
  assert.deepEqual(model.scheduleCredits({...base,pauses:[{startDate:"2026-11-14",endDate:"2026-11-16"}]},calendar,now).dates,["2026-11-13","2026-11-17"]);
});
test("local calendar dates handle timezones and DST; malformed dates, periods and totals fail",()=>{
  const at=new Date("2026-11-18T00:30:00Z"),input={...base,startDate:"2026-11-17"};
  assert.equal(model.scheduleCredits(input,{timezone:"Asia/Seoul",holidays:[],version:0},at).dates.length,1);
  assert.equal(model.scheduleCredits(input,{timezone:"America/Los_Angeles",holidays:[],version:0},at).dates.length,0);
  assert.equal(model.scheduleCredits({...base,startDate:"2026-10-31",endDate:"2026-11-02"},{timezone:"America/New_York",holidays:[],version:0},now).dates.length,3);
  for(const date of ["2026-02-30","2026-2-01","bad"])assert.throws(()=>model.scheduleInput({...base,startDate:date}));
  assert.throws(()=>model.scheduleInput({...base,endDate:"2026-11-01"}));
  assert.throws(()=>model.calendarInput({timezone:"Unknown/Zone",holidays:[]}));
  assert.throws(()=>model.scheduleCredits({...base,amount:1e12},{timezone:"Asia/Seoul",holidays:[],version:0},now));
});
test("a completed Project accrues without Task work; retries and daily jobs never duplicate dates or observations",async t=>{
  const f=fixture(t);f.sql.exec("UPDATE items SET status='done',progress=100 WHERE id='p'");
  const first=await f.save();assert.equal(first.schedule.accruedValue,10);assert.equal(first.schedule.monthValue,10);assert.equal(first.schedule.isEstimate,true);assert.equal(f.progress(),30);
  const history=f.sql.prepare("SELECT count(*) n FROM kr_metric_observations").get().n;
  const again=await f.save();assert.equal(again.schedule.id,first.schedule.id);assert.equal(f.sql.prepare("SELECT count(*) n FROM kr_metric_observations").get().n,history);
  f.sql.exec("UPDATE items SET status='done' WHERE id='t';UPDATE items SET status='todo' WHERE id='p'");assert.equal(f.progress(),30);
  await api.runDueProjectContributions(f.db,new Date("2026-11-19T06:00:00Z"));assert.equal((await f.state()).schedule.accruedValue,12);assert.equal(f.progress(),32);
  await api.runDueProjectContributions(f.db,new Date("2026-11-19T06:00:00Z"));assert.equal((await f.state()).schedule.creditedDays,6);
  assert.equal(f.sql.prepare("SELECT is_estimate FROM kr_metric_observations ORDER BY rowid DESC LIMIT 1").get().is_estimate,1);
});
test("legacy completion credit is preserved alongside a schedule and new completion cannot add it twice",async t=>{
  const f=fixture(t);const s=await contributions.readContribution(f.db,"w","p");
  await contributions.saveContribution(f.db,"w","p",{defaultValue:10,expectedVersion:0,expectedMetricVersion:s.metric.version});
  f.sql.exec("UPDATE items SET status='done',progress=100 WHERE id='p'");assert.equal(f.progress(),30);
  await f.save();assert.equal(f.progress(),40);assert.equal((await contributions.readContribution(f.db,"w","p")).contribution.enabled,false);
  f.sql.exec("UPDATE items SET status='todo' WHERE id='p';UPDATE items SET status='done' WHERE id='p'");assert.equal(f.progress(),30);
  await assert.rejects(contributions.saveContribution(f.db,"w","p",{defaultValue:10}),{code:"scheduled_contribution_active"});
});
test("period, amount, pauses and holiday edits replace estimated dates; stale revisions cannot overwrite them",async t=>{
  const f=fixture(t);await f.save();const stale=await f.state();
  const edited=await f.save({amount:3,endDate:"2026-11-16",pauses:[{startDate:"2026-11-14",endDate:"2026-11-15"}]});assert.equal(edited.schedule.accruedValue,6);assert.equal(f.progress(),26);
  await assert.rejects(api.saveProjectSchedule(f.db,"w","p",base,stale.revision,now),{code:"contribution_schedule_conflict"});
  await f.save({mode:"business_days"});
  await api.saveMetricCalendar(f.db,"w",{timezone:"Asia/Seoul",holidays:["2026-11-16"]},0,now);
  await api.runDueProjectContributions(f.db,now);assert.equal((await f.state()).schedule.accruedValue,4);
  await assert.rejects(api.saveMetricCalendar(f.db,"w",{timezone:"Asia/Seoul",holidays:[]},0,now),{code:"metric_calendar_conflict"});
});
test("one-off dates run on the specified day; month subtotals do not replace the lifetime total",async t=>{
  const f=fixture(t);await f.save({mode:"once",startDate:"2026-11-19"});assert.equal(f.progress(),20);
  await api.runDueProjectContributions(f.db,new Date("2026-11-19T06:00:00Z"));assert.equal(f.progress(),22);
  await api.runDueProjectContributions(f.db,new Date("2026-11-20T06:00:00Z"));assert.equal(f.progress(),22);
  const state=await f.state("p",new Date("2026-12-01T06:00:00Z"));assert.equal(state.schedule.accruedValue,2);assert.equal(state.schedule.monthValue,0);
});
test("API source isolation, archive suspension and moving a Project retain already earned estimates",async t=>{
  const f=fixture(t);await f.save();
  const state=await sources.readKrSource(f.db,"w","kr");
  await sources.saveKrSource(f.db,"w","u","kr",{revision:state.revision,mode:"api",api:{name:"Usage",endpointUrl:"https://metrics.example.com",valuePath:"",baselineValue:0,targetValue:100,unit:"時間",cadence:"daily",active:true}});
  f.sql.exec("UPDATE items SET progress=70 WHERE id='kr'");await api.runDueProjectContributions(f.db,new Date("2026-11-19T06:00:00Z"));assert.equal(f.progress(),70);
  assert.equal((await f.state()).schedule.accruedValue,12);await assert.rejects(f.save(),{code:"project_metric_source_required"});
  f.sql.exec("UPDATE items SET archived_at='2026-11-19T06:00:00Z' WHERE id='p';UPDATE items SET archived_at=NULL WHERE id='p'");
  await api.runDueProjectContributions(f.db,new Date("2026-11-22T06:00:00Z"));assert.equal((await f.state()).schedule.accruedValue,12);assert.equal((await f.state()).schedule.active,false);
  f.sql.exec("UPDATE items SET parent_id='i2' WHERE id='p'");assert.equal(f.sql.prepare("SELECT accrued_value FROM project_metric_schedules WHERE kr_item_id='kr'").get().accrued_value,12);assert.equal((await f.state()).schedule,null);
});
test("SQLite rejects cross-owner targets, duplicate credited dates and inflated totals",async t=>{
  const f=fixture(t);await f.save();
  assert.throws(()=>f.sql.exec("UPDATE project_metric_schedules SET accrued_value=999"),/schedule dates constraint/);
  assert.throws(()=>f.sql.exec(`UPDATE project_metric_schedules SET credit_dates_json='["2026-11-13","2026-11-13"]',accrued_value=4`),/schedule dates constraint/);
  assert.throws(()=>f.sql.exec("UPDATE project_metric_schedules SET project_id='foreign'"),/schedule target constraint/);
  assert.equal(f.progress(),30);await assert.rejects(api.readProjectSchedule(f.db,"other","p"),{code:"schedule_project_or_kr_not_found"});
});

test("archiving a KR suspends its schedules without erasing already credited dates",async t=>{
  const f=fixture(t);await f.save();f.sql.exec("UPDATE items SET archived_at='2026-11-18' WHERE id='kr';UPDATE items SET archived_at=NULL WHERE id='kr'");
  await api.runDueProjectContributions(f.db,new Date("2026-11-22T06:00:00Z"));const state=await f.state();assert.equal(state.schedule.active,false);assert.equal(state.schedule.accruedValue,10);assert.equal(f.progress(),30);
});
test("HTTP routes enforce auth, write scope, calendar admin and private responses",async t=>{
  const f=fixture(t);let auth={ownerId:"w",role:"owner"};
  const pace={ensureWorkspace:async()=>{},authorizeRequest:async(_r,o)=>auth instanceof Response?auth:auth.role==="viewer"&&!o?.allowViewerWrite?new Response("forbidden",{status:403}):auth};
  const deps={"cloudflare:workers":{env:{DB:f.db}},"@/lib/pace-data":pace,"@/lib/project-metric-schedules":api};
  const routes=compile(await read("app/api/project-contribution-schedules/route.ts"),deps),calendar=compile(await read("app/api/metric-calendar/route.ts"),deps);
  const get=new Request("https://okri.ai/api/project-contribution-schedules?projectId=p");
  auth=new Response("unauthorized",{status:401});assert.equal((await routes.GET(get)).status,401);
  auth={ownerId:"w",role:"viewer"};const response=await routes.GET(get);assert.equal(response.status,200);assert.equal(response.headers.get("Cache-Control"),"private, no-store");
  assert.equal((await routes.PUT(new Request(get,{method:"PUT",body:"{}"}))).status,403);
  auth={ownerId:"w",role:"member"};assert.equal((await calendar.PUT(new Request("https://okri.ai/api/metric-calendar",{method:"PUT",body:"{}"}))).status,403);
});
test("real MCP transport advertises schedule/calendar tools, preserves omitted settings and denies Viewer/OAuth writes",async t=>{
  const f=fixture(t),auth={ownerId:"w",userId:"u",role:"owner",apiToken:true};
  const server=new McpServer({name:"test",version:"1"});mcp.registerContributionScheduleTools(server,f.db,auth);
  const client=new Client({name:"test",version:"1"}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
  const catalog=await client.listTools();assert.equal(catalog.tools.length,5);
  const missing=await client.callTool({name:"set_kr_project_measurement",arguments:{key_result_id:"kr2"}});assert.equal(missing.isError,true);
  const configured=await client.callTool({name:"set_kr_project_measurement",arguments:{key_result_id:"kr2",starting_value:0,target_value:100,unit:"시간"}});assert.notEqual(configured.isError,true);assert.equal(configured.structuredContent.mode,"projects");
  f.sql.exec("INSERT INTO kr_data_connections(id,owner_id,kr_item_id,name,endpoint_url,target_value,active) VALUES('saved-api','w','kr2','Saved','https://metrics.example.com/private?token=secret',100,0)");
  const retained=await client.callTool({name:"set_kr_project_measurement",arguments:{key_result_id:"kr2"}});assert.equal(retained.structuredContent.apiConfigured,true);assert.equal(JSON.stringify(retained).includes("token=secret"),false);
  const saved=await client.callTool({name:"upsert_project_contribution_schedule",arguments:{project_id:"p",mode:"daily",amount:2,start_date:"2026-11-13"}});assert.notEqual(saved.isError,true);assert.equal(saved.structuredContent.schedule.isEstimate,true);
  const changed=await client.callTool({name:"upsert_project_contribution_schedule",arguments:{project_id:"p",amount:3}});assert.equal(changed.structuredContent.schedule.id,saved.structuredContent.schedule.id);assert.equal(changed.structuredContent.schedule.startDate,"2026-11-13");
  for(const actor of [{...auth,role:"viewer"},{...auth,oauthScopes:"okri:read"},{...auth,role:"member"}]) {
    const tools=new Map();mcp.registerContributionScheduleTools({registerTool:(name,_definition,call)=>tools.set(name,call)},f.db,actor);
    assert.equal((await tools.get("set_metric_calendar")({timezone:"Asia/Seoul",holidays:[],expected_version:0})).isError,true);
    if(actor.role!=="member")assert.equal((await tools.get("upsert_project_contribution_schedule")({project_id:"p",amount:3})).isError,true);
    assert.notEqual((await tools.get("get_project_contribution_schedule")({project_id:"p"})).isError,true);
  }
});
