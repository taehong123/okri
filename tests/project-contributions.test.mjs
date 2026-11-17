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
function fixture(t,upgrade=true){
  const sql=new DatabaseSync(":memory:");t.after(()=>sql.close());
  sql.exec(`PRAGMA foreign_keys=ON;PRAGMA recursive_triggers=ON;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY);
    CREATE TABLE items(id TEXT PRIMARY KEY,owner_id TEXT,parent_id TEXT,kind TEXT,title TEXT DEFAULT '',status TEXT NOT NULL,progress INTEGER DEFAULT 0,archived_at TEXT,updated_at TEXT);
    CREATE TABLE kr_data_connections(id TEXT PRIMARY KEY,owner_id TEXT,kr_item_id TEXT);
    CREATE TABLE workspace_backup_state(owner_id TEXT PRIMARY KEY,revision INTEGER DEFAULT 0);
    INSERT INTO workspaces VALUES('w'),('other');
    INSERT INTO workspace_backup_state VALUES('w',0),('other',0);
    INSERT INTO items(id,owner_id,parent_id,kind,status,progress) VALUES
      ('kr','w',NULL,'key_result','in_progress',20),('kr2','w',NULL,'key_result','todo',0),
      ('i','w','kr','initiative','todo',0),('i2','w','kr2','initiative','todo',0),
      ('p','w','i','project','todo',35),('q','w','i','project','todo',0),
      ('foreign','other',NULL,'project','todo',0),('t','w','p','task','todo',0);`);
  sql.exec(old);if(upgrade)sql.exec(migration);
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
  f.sql.exec("INSERT INTO kr_data_connections VALUES('api','w','kr')");
  await assert.rejects(f.save(10),{code:"metric_api_connected"});
  f.sql.exec("DELETE FROM kr_data_connections");
  const state=await f.save(10),c=state.contribution;
  assert.throws(()=>f.sql.exec("INSERT INTO kr_data_connections VALUES('api','w','kr')"),/constraint/);
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
