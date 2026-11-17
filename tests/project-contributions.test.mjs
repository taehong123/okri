import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
const source=await readFile(new URL("../lib/project-contributions.ts",import.meta.url),"utf8");
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const contributions={};new Function("exports",js)(contributions);
const old=await readFile(new URL("../drizzle/0076_project_task_goals.sql",import.meta.url),"utf8");
const migration=await readFile(new URL("../drizzle/0077_project_contributions.sql",import.meta.url),"utf8");
const sourceMigration=await readFile(new URL("../drizzle/0078_kr_data_sources.sql",import.meta.url),"utf8");
const historyMigration=await readFile(new URL("../drizzle/0079_kr_metric_history.sql",import.meta.url),"utf8");
const history={};new Function("exports","require",ts.transpileModule(await readFile(new URL("../lib/kr-metric-history.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(history,()=>contributions);
const sync={};new Function("exports",ts.transpileModule(await readFile(new URL("../lib/kr-data-sync.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(sync);
const sources={};new Function("exports","require",ts.transpileModule(await readFile(new URL("../lib/kr-data-sources.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(sources,name=>name.includes("kr-data-sync")?sync:contributions);
function fixture(t,upgrade=true){
  const sql=new DatabaseSync(":memory:");t.after(()=>sql.close());
  sql.exec(`PRAGMA foreign_keys=ON;PRAGMA recursive_triggers=ON;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY);
    CREATE TABLE items(id TEXT PRIMARY KEY,owner_id TEXT,parent_id TEXT,kind TEXT,title TEXT DEFAULT '',status TEXT NOT NULL,progress INTEGER DEFAULT 0,archived_at TEXT,updated_at TEXT);
    CREATE TABLE kr_data_connections(id TEXT PRIMARY KEY,owner_id TEXT,kr_item_id TEXT,name TEXT DEFAULT 'API',endpoint_url TEXT DEFAULT 'https://metrics.example.com',value_path TEXT DEFAULT '',baseline_value REAL DEFAULT 0,target_value REAL DEFAULT 100,unit TEXT DEFAULT '건',cadence TEXT DEFAULT 'daily',active INTEGER DEFAULT 1,next_sync_at TEXT,last_value REAL,last_sync_status TEXT DEFAULT 'never',last_error TEXT DEFAULT '',last_synced_at TEXT,created_by_user_id TEXT,created_at TEXT,updated_at TEXT,UNIQUE(owner_id,kr_item_id));
    CREATE TABLE activity_log(id TEXT PRIMARY KEY,owner_id TEXT,item_id TEXT,action TEXT,source TEXT,payload TEXT,created_at TEXT);
    CREATE TABLE workspace_backup_state(owner_id TEXT PRIMARY KEY,revision INTEGER DEFAULT 0);
    CREATE TABLE workspace_backup_guards(id TEXT PRIMARY KEY,verified INTEGER);
    INSERT INTO workspaces VALUES('w'),('other');
    INSERT INTO workspace_backup_state VALUES('w',0),('other',0);
    INSERT INTO items(id,owner_id,parent_id,kind,status,progress) VALUES
      ('kr','w',NULL,'key_result','in_progress',20),('kr2','w',NULL,'key_result','todo',0),
      ('i','w','kr','initiative','todo',0),('i2','w','kr2','initiative','todo',0),
      ('p','w','i','project','todo',35),('q','w','i','project','todo',0),
      ('foreign','other',NULL,'project','todo',0),('t','w','p','task','todo',0);`);
  sql.exec(old);if(upgrade){sql.exec(migration);sql.exec(sourceMigration);sql.exec(historyMigration);}
  const prepare=(query,args=[])=>({bind:(...v)=>prepare(query,v),first:async()=>sql.prepare(query).get(...args)??null,all:async()=>({results:sql.prepare(query).all(...args)}),run:async()=>({meta:{changes:Number(sql.prepare(query).run(...args).changes)}})});
  const db={prepare,batch:async statements=>{sql.exec("BEGIN");try{const result=[];for(const s of statements)result.push(await s.run());sql.exec("COMMIT");return result;}catch(e){sql.exec("ROLLBACK");throw e;}}};
  const read=async(id="p")=>contributions.readContribution(db,"w",id);
  const save=async(amount=10,id="p",starting=20,target=100)=>{
    const state=await read(id);
    return contributions.saveContribution(db,"w",id,{defaultValue:amount,startingValue:starting,targetValue:target,unit:"건",expectedVersion:state.contribution?.version??0,expectedId:state.contribution?.id,expectedMetricVersion:state.metric?.version??0});
  };
  const complete=async(actual=8,id="p",requestId=crypto.randomUUID())=>{
    const state=await read(id),c=state.contribution;
    const input=contributions.completionInput({actualValue:actual,expectedVersion:c.version,expectedId:c.id,requestId});
    const update={sql:"UPDATE items SET status='done',progress=100 WHERE owner_id=? AND id=?",params:["w",id]};
    await contributions.completeWithContribution(db,"w",id,input,update,"done");return {input,update};
  };
  const progress=id=>sql.prepare("SELECT progress FROM items WHERE id=?").get(id).progress;
  return {sql,db,read,save,complete,progress};
}
test("correction retires Task counting without editing historical migration or deleting settings",async t=>{
  const f=fixture(t,false);
  f.sql.exec("INSERT INTO project_task_goals(id,owner_id,project_id,target_count) VALUES('legacy','w','p',2);UPDATE items SET status='done' WHERE id='t'");
  assert.equal(f.progress("p"),50);
  f.sql.exec(migration);
  f.sql.exec("UPDATE items SET status='todo' WHERE id='t';UPDATE items SET status='done' WHERE id='t'");
  assert.equal(f.progress("p"),50);
  assert.equal(f.sql.prepare("SELECT target_count FROM project_task_goals").get().target_count,2);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'project_task_goal_%'").get().n,0);
  assert.ok(!migration.includes("\r"));
});
test("each Project has a numeric default; Project completion applies default and Task changes do nothing",async t=>{
  const f=fixture(t);await f.save(10);
  assert.equal((await f.read()).metric.currentValue,20);
  f.sql.exec("UPDATE items SET status='done' WHERE id='t'");
  assert.equal(f.progress("p"),35);assert.equal(f.progress("kr"),20);
  f.sql.exec("UPDATE items SET status='done',progress=100 WHERE id='p'");
  const s=await f.read();assert.equal(s.contribution.actualValue,10);assert.equal(s.metric.currentValue,30);
  f.sql.exec("UPDATE items SET status='todo' WHERE id='t';DELETE FROM items WHERE id='t'");
  assert.equal((await f.read()).metric.currentValue,30);
});
test("confirmed actual replaces the default, retries are idempotent and reopening reverses that actual",async t=>{
  const f=fixture(t);await f.save(10);
  const receipt=await f.complete(8);
  assert.equal((await f.read()).metric.currentValue,28);
  assert.equal((await f.read()).contribution.defaultValue,10);
  await contributions.completeWithContribution(f.db,"w","p",receipt.input,receipt.update,"done");
  assert.equal((await f.read()).metric.currentValue,28);
  await assert.rejects(contributions.completeWithContribution(f.db,"w","p",{...receipt.input,actualValue:9},receipt.update,"done"),{code:"contribution_conflict"});
  f.sql.exec("UPDATE items SET status='todo',progress=0 WHERE id='p'");
  assert.equal((await f.read()).metric.currentValue,20);
  assert.equal((await f.read()).contribution.actualValue,null);
  f.sql.exec("UPDATE items SET status='done',progress=100 WHERE id='p'");
  assert.equal((await f.read()).metric.currentValue,30);
});
test("multiple Projects accumulate their amounts and undo above 100% preserves the real value",async t=>{
  const f=fixture(t);await f.save(20,"p",90,100);await f.save(5,"q");
  await f.complete(20);await f.complete(5,"q");
  assert.equal((await f.read()).metric.currentValue,115);assert.equal(f.progress("kr"),100);
  f.sql.exec("UPDATE items SET status='todo' WHERE id='p'");
  assert.equal((await f.read()).metric.currentValue,95);assert.equal(f.progress("kr"),95);
});
test("the actual and Project status commit together; failed writes roll back everything",async t=>{
  const f=fixture(t);const state=await f.save(10),c=state.contribution;
  await assert.rejects(contributions.completeWithContribution(f.db,"w","p",{actualValue:8,expectedId:c.id,expectedVersion:c.version,requestId:crypto.randomUUID()},{sql:"UPDATE missing_table SET status='done'",params:[]},"done"),{code:"contribution_conflict"});
  const s=await f.read();assert.equal(s.projectStatus,"todo");assert.equal(s.contribution.actualValue,null);assert.equal(s.metric.currentValue,20);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM project_contribution_guards").get().n,0);
});
test("scope, numeric validation, API exclusivity and stale review versions are enforced",async t=>{
  const f=fixture(t);
  await assert.rejects(contributions.readContribution(f.db,"w","foreign"),{code:"project_not_found"});
  for(const value of [-1,NaN,Infinity,"8",1e13])assert.throws(()=>contributions.completionInput({actualValue:value,expectedVersion:1,expectedId:"id",requestId:crypto.randomUUID()}),{code:"invalid_contribution"});
  f.sql.exec("INSERT INTO kr_data_connections(id,owner_id,kr_item_id) VALUES('api','w','kr')");
  await assert.rejects(f.save(10),{code:"metric_api_connected"});
  f.sql.exec("DELETE FROM kr_data_connections");
  const state=await f.save(10),c=state.contribution;
  assert.throws(()=>f.sql.exec("INSERT INTO kr_data_connections(id,owner_id,kr_item_id) VALUES('api','w','kr')"),/constraint/);
  await f.save(11);
  await assert.rejects(contributions.completeWithContribution(f.db,"w","p",{actualValue:8,expectedVersion:c.version,expectedId:c.id,requestId:crypto.randomUUID()},{sql:"UPDATE items SET status='done' WHERE id='p'",params:[]},"done"),{code:"contribution_conflict"});
  assert.equal((await f.read()).metric.currentValue,20);
});
test("moving a Project removes its prior credit and disables stale lineage settings",async t=>{
  const f=fixture(t);await f.save(10);await f.complete(8);
  f.sql.exec("UPDATE items SET parent_id='i2' WHERE id='p'");
  assert.equal(f.progress("kr"),20);assert.equal(f.progress("kr2"),0);
  assert.equal((await f.read()).contribution.enabled,false);
});
test("an actual of zero is a valid completion and never substitutes the configured default",async t=>{
  const f=fixture(t);await f.save(10);await f.complete(0);
  assert.equal((await f.read()).contribution.actualValue,0);assert.equal((await f.read()).metric.currentValue,20);
});
test("configuration routes enforce identity, Viewer reads, owner scope and private no-store",async t=>{
  const f=fixture(t);
  let auth={ownerId:"w",role:"owner"};
  const dependencies={
    "cloudflare:workers":{env:{DB:f.db}},
    "@/lib/project-contributions":contributions,
    "@/lib/pace-data":{ensureWorkspace:async()=>{},authorizeRequest:async(_request,options)=>{
      if(auth instanceof Response)return auth;
      if(auth.role==="viewer"&&!options?.allowViewerWrite)return new Response("forbidden",{status:403});
      return auth;
    }},
  };
  const source=await readFile(new URL("../app/api/project-contributions/route.ts",import.meta.url),"utf8");
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const routes={};new Function("require","exports",output)(name=>dependencies[name],routes);
  const get=id=>new Request("https://okri.ai/api/project-contributions"+(id?"?projectId="+id:""));
  const put=body=>new Request("https://okri.ai/api/project-contributions",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  auth=new Response("unauthorized",{status:401});assert.equal((await routes.GET(get("p"))).status,401);
  auth={ownerId:"w",role:"viewer"};const result=await routes.GET(get("p"));assert.equal(result.status,200);assert.equal(result.headers.get("Cache-Control"),"private, no-store");
  assert.equal((await routes.PUT(put({projectId:"p"}))).status,403);
  auth={ownerId:"w",role:"owner"};assert.equal((await routes.GET(get("foreign"))).status,404);
  assert.equal((await routes.PUT(put({projectId:"p",defaultValue:10,startingValue:20,targetValue:100,unit:"건",expectedVersion:0,expectedMetricVersion:0}))).status,200);
  assert.equal((await routes.GET(get())).status,200);
  assert.equal((await routes.PUT(put(null))).status,400);
});

async function sourceInput(f,mode="projects",overrides={}) {
  const s=await sources.readKrSource(f.db,"w","kr");
  return {...s,keyResultId:"kr",mode,startingValue:s.metric?.startingValue??20,targetValue:s.metric?.targetValue??100,unit:s.metric?.unit??"건",
    projects:s.projects.map(p=>({id:p.id,defaultValue:p.defaultValue??(p.id==="p"?10:null)})),
    api:{name:"매출",endpointUrl:"https://metrics.example.com/revenue",valuePath:"value",baselineValue:0,targetValue:100,unit:"건",cadence:"daily",active:true},...overrides};
}
const saveSource=async(f,mode,overrides={})=>sources.saveKrSource(f.db,"w","user","kr",await sourceInput(f,mode,overrides));
test("Data tab configures KR basis and Project defaults together without Task configuration",async t=>{
  const f=fixture(t),s=await saveSource(f,"projects");
  assert.equal(s.mode,"projects");assert.equal(s.projects.find(p=>p.id==="p").defaultValue,10);
  assert.equal(s.projects.find(p=>p.id==="q").defaultValue,null);assert.equal(s.metric.currentValue,20);
  await f.complete(8);assert.equal((await sources.listKrMetricSummaries(f.db,"w"))[0].currentValue,28);
  const after=await saveSource(f,"projects",{projects:[{id:"p",defaultValue:30},{id:"q",defaultValue:0}]});
  assert.equal(after.metric.currentValue,28);assert.equal(after.projects[0].actualValue,8);
  assert.equal((await f.read("q")).contribution.defaultValue,0);
  await saveSource(f,"projects",{projects:[{id:"p",defaultValue:null},{id:"q",defaultValue:null}]});
  assert.equal((await f.read()).metric.currentValue,28,"disabling future credit preserves an applied actual");
});
test("source switching retains both configurations and credits, while Project API remains independent",async t=>{
  const f=fixture(t);await saveSource(f,"projects");await f.complete(8);
  f.sql.exec("INSERT INTO kr_data_connections(id,owner_id,kr_item_id) VALUES('project-api','w','p')");
  const api=await saveSource(f,"api");assert.equal(api.mode,"api");
  assert.equal((await f.read()).contribution.enabled,false);
  f.sql.exec("UPDATE items SET status='done' WHERE id='q'");
  assert.equal(f.progress("kr"),0);assert.equal((await f.read()).metric.currentValue,28);
  const projects=await saveSource(f,"projects");assert.equal(projects.metric.currentValue,28);assert.equal(f.progress("kr"),28);
  assert.equal(f.sql.prepare("SELECT active FROM kr_data_connections WHERE kr_item_id='kr'").get().active,0);
  assert.equal(f.sql.prepare("SELECT active FROM kr_data_connections WHERE id='project-api'").get().active,1);
  assert.equal(projects.api.endpointUrl,"https://metrics.example.com/revenue");
  assert.throws(()=>f.sql.exec("UPDATE kr_data_connections SET active=1 WHERE kr_item_id='kr'"),/constraint/);
});
test("stale source forms and changed Project lineage roll back the entire configuration batch",async t=>{
  const f=fixture(t),input=await sourceInput(f);
  await saveSource(f,"projects");
  await assert.rejects(sources.saveKrSource(f.db,"w","user","kr",input),{code:"contribution_conflict"});
  const next=await sourceInput(f);
  const batch=f.db.batch;
  f.db.batch=async statements=>{f.sql.exec("UPDATE items SET parent_id='i2' WHERE id='q'");return batch(statements);};
  await assert.rejects(sources.saveKrSource(f.db,"w","user","kr",{...next,startingValue:50}),{code:"contribution_conflict"});
  assert.equal((await f.read()).metric.startingValue,20);
  await assert.rejects(sources.readKrSource(f.db,"other","kr"),{code:"key_result_not_found"});
});
test("invalid/foreign Project rows and unsafe API endpoints cannot modify KR settings",async t=>{
  const f=fixture(t);
  for(const overrides of [{projects:[{id:"foreign",defaultValue:1},{id:"q",defaultValue:1}]},{targetValue:0},{startingValue:-1}])
    await assert.rejects(saveSource(f,"projects",overrides),{code:"invalid_contribution"});
  await assert.rejects(saveSource(f,"api",{api:{name:"bad",endpointUrl:"https://127.0.0.1/secret",valuePath:"",baselineValue:0,targetValue:100,unit:"",cadence:"daily",active:true}}),{code:"invalid_data_endpoint"});
  assert.equal(f.sql.prepare("SELECT count(*) n FROM kr_project_metrics").get().n,0);
});
test("history records factual Project completion and undo, with no Task or retry samples",async t=>{
  const f=fixture(t);await saveSource(f,"projects");
  const receipt=await f.complete(8);
  await contributions.completeWithContribution(f.db,"w","p",receipt.input,receipt.update,"done");
  f.sql.exec("UPDATE items SET status='done' WHERE id='t';UPDATE items SET status='todo' WHERE id='p'");
  const values=f.sql.prepare("SELECT current_value FROM kr_metric_observations ORDER BY rowid").all().map(r=>r.current_value);
  assert.deepEqual(values,[20,28,20]);
  assert.equal((await history.readKrHistory(f.db,"w","kr",30)).observations.length,3);
  await assert.rejects(history.readKrHistory(f.db,"other","kr",30),{code:"key_result_not_found"});
  await assert.rejects(history.readKrHistory(f.db,"w","kr",13),{code:"invalid_history_range"});
});
test("each successful API poll records even an unchanged value; failed polls never fabricate samples",async t=>{
  const f=fixture(t);await saveSource(f,"api");
  t.mock.method(globalThis,"fetch",async()=>Response.json({value:50}));
  const id=f.sql.prepare("SELECT id FROM kr_data_connections WHERE kr_item_id='kr'").get().id;
  await sync.syncKrDataConnectionWithDb(f.db,"w",id);await sync.syncKrDataConnectionWithDb(f.db,"w",id);
  const samples=f.sql.prepare("SELECT current_value FROM kr_metric_observations WHERE event_kind='synced'").all();
  assert.deepEqual(samples.map(s=>s.current_value),[50,50]);assert.equal(f.progress("kr"),50);
  globalThis.fetch=async()=>Response.json({error:"unavailable"},{status:503});
  await assert.rejects(sync.syncKrDataConnectionWithDb(f.db,"w",id));
  assert.equal(f.sql.prepare("SELECT count(*) n FROM kr_metric_observations WHERE event_kind='synced'").get().n,2);
});
test("an in-flight API poll cannot overwrite a newly selected Project source or append a false measurement",async t=>{
  const f=fixture(t);await saveSource(f,"api");
  const id=f.sql.prepare("SELECT id FROM kr_data_connections WHERE kr_item_id='kr'").get().id;
  t.mock.method(globalThis,"fetch",async()=>{await saveSource(f,"projects");return Response.json({value:99});});
  await assert.rejects(sync.syncKrDataConnectionWithDb(f.db,"w",id));
  assert.equal(f.progress("kr"),20);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM kr_metric_observations WHERE event_kind='synced'").get().n,0);
  const row=f.sql.prepare("SELECT active,last_sync_status,last_error FROM kr_data_connections WHERE id=?").get(id);
  assert.deepEqual({...row},{active:0,last_sync_status:"never",last_error:""});
  assert.deepEqual(await sync.syncDueKrDataConnectionsWithDb(f.db),{attempted:0,failed:0});
  await assert.rejects(sync.syncKrDataConnectionWithDb(f.db,"w",id),/KR uses Project contributions/);
});
test("KR source and history routes enforce identity, Viewer reads and workspace ownership",async t=>{
  const f=fixture(t);let auth={ownerId:"w",userId:"user",role:"owner"};
  const dependencies={"cloudflare:workers":{env:{DB:f.db}},"@/lib/project-contributions":contributions,"@/lib/kr-data-sources":sources,"@/lib/kr-metric-history":history,
    "@/lib/pace-data":{ensureWorkspace:async()=>{},authorizeRequest:async(_request,options)=>auth instanceof Response?auth:auth.role==="viewer"&&!options?.allowViewerWrite?new Response("forbidden",{status:403}):auth}};
  const routes=[];
  for(const file of ["kr-data-sources","kr-metric-history"]){
    const out=ts.transpileModule(await readFile(new URL("../app/api/"+file+"/route.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const api={};new Function("exports","require",out)(api,name=>dependencies[name]);routes.push(api);
  }
  const request=(name,id="kr")=>new Request("https://okri.ai/api/"+name+"?keyResultId="+id);
  auth=new Response("unauthorized",{status:401});for(const [i,name] of ["kr-data-sources","kr-metric-history"].entries())assert.equal((await routes[i].GET(request(name))).status,401);
  auth={ownerId:"w",userId:"user",role:"viewer"};
  for(const [i,name] of ["kr-data-sources","kr-metric-history"].entries()){const response=await routes[i].GET(request(name));assert.equal(response.status,200);assert.equal(response.headers.get("Cache-Control"),"private, no-store");}
  const put=()=>new Request("https://okri.ai/api/kr-data-sources",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({keyResultId:"kr"})});
  assert.equal((await routes[0].PUT(put())).status,403);
  auth={ownerId:"other",userId:"user",role:"owner"};for(const [i,name] of ["kr-data-sources","kr-metric-history"].entries())assert.equal((await routes[i].GET(request(name))).status,404);
});
test("annual history includes every hourly sample, and higher-volume reads are bounded without deleting records",async t=>{
  const f=fixture(t),now=new Date(),insert=f.sql.prepare("INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at) VALUES(?,'w','kr','api','synced',20,0,100,'건',?)");
  f.sql.exec("BEGIN");
  for(let i=0;i<8760;i++)insert.run("hour-"+i,new Date(now.getTime()-i*3_600_000).toISOString());
  f.sql.exec("COMMIT");
  const annual=await history.readKrHistory(f.db,"w","kr",365,now);
  assert.equal(annual.observations.length,8760);assert.equal(annual.limited,false);
  f.sql.exec("BEGIN");for(let i=0;i<2000;i++)insert.run("manual-"+i,now.toISOString());f.sql.exec("COMMIT");
  const bounded=await history.readKrHistory(f.db,"w","kr",365,now);
  assert.equal(bounded.observations.length,10000);assert.equal(bounded.limited,true);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM kr_metric_observations").get().n,10760);
});
