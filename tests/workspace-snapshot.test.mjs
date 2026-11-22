import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';
import {drizzle} from 'drizzle-orm/d1';
import * as orm from 'drizzle-orm';
import * as sqliteCore from 'drizzle-orm/sqlite-core';

const read=p=>readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
function load(source,deps={}){
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',compiled)(id=>{if(!(id in deps))throw new Error(`Unmocked dependency ${id}`);return deps[id];},module,module.exports);
  return module.exports;
}
function fixture(){
  const db=new DatabaseSync(':memory:');
  const schema=load(read('db/schema.ts'),{'drizzle-orm':orm,'drizzle-orm/sqlite-core':sqliteCore});
  db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY,owner_id TEXT,cycle_id TEXT,parent_id TEXT,routine_id TEXT,ticket_number INTEGER,ticket_key TEXT,kind TEXT,title TEXT,description TEXT,status TEXT,priority TEXT,cadence TEXT,progress INTEGER,due_date TEXT,source TEXT,source_ref TEXT,created_by_user_id TEXT,archived_at TEXT,archived_from_status TEXT,archive_root_id TEXT,sort_order INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE workspace_members (id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,email TEXT,display_name TEXT,role TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE item_assignments(id TEXT PRIMARY KEY,owner_id TEXT,item_id TEXT,member_id TEXT,role TEXT,created_at TEXT,updated_at TEXT);`);
  const insert=db.prepare('INSERT INTO items(id,owner_id,kind,title,parent_id,cycle_id,sort_order,created_at,status,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insert.run('objective','workspace-1','objective','Original Objective',null,'cycle',0,'2026-01-01','in_progress',null);
  insert.run('kr','workspace-1','key_result','Original KR','objective','cycle',10,'2026-01-01','todo',null);
  insert.run('initiative','workspace-1','initiative','Original Initiative','kr','cycle',20,'2026-01-01','todo',null);
  insert.run('project','workspace-1','project','Original Project','initiative','cycle',30,'2026-01-01','todo',null);
  for(let n=0;n<1200;n++)insert.run(`task-${n}`,'workspace-1',n%2?'task':'ticket',`Recent ${n}`,n%2?'project':null,'cycle',0,'2026-11-22','todo',null);
  insert.run('foreign','workspace-2','objective','Other workspace',null,'cycle-other',0,'2026-11-22','todo',null);
  insert.run('archived','workspace-1','task','Archived Task','project','cycle',0,'2026-11-22','archived','2026-11-22');
  db.exec("INSERT INTO workspace_members VALUES('member-1','workspace-1','user-1','owner@example.com','Owner','owner','active','2026-01-01','2026-01-01'); INSERT INTO item_assignments VALUES('assignment','workspace-1','task-1199','member-1','task_assignee','2026-01-01','2026-01-01')");
  const DB={prepare(query){return {values:[],bind(...v){this.values=v;return this;},async all(){return {results:db.prepare(query).all(...this.values),success:true};},async raw(){return db.prepare(query).all(...this.values).map(Object.values);},async first(){return db.prepare(query).get(...this.values)??null;},async run(){return {success:true,meta:db.prepare(query).run(...this.values)};}};}};
  const source=read('lib/pace-data.ts');
  const queries=source.slice(source.indexOf('export async function listItems('),source.indexOf('export async function getItem('));
  const assignments=source.slice(source.indexOf('export async function getItemAssignmentMap('),source.indexOf('export async function replaceItemAssignmentRole('));
  const api=load(`import {and,asc,desc,eq,isNull,like,or,sql} from 'drizzle-orm';import {items,itemAssignments,workspaceMembers} from '@/db/schema';import {getDb} from '@/db';${queries}\n${assignments}`,{'drizzle-orm':orm,'@/db/schema':schema,'@/db':{getDb:()=>drizzle(DB)}});
  return {db,api};
}

test('workspace snapshots retain old OKR ancestors past 1,200 recent execution rows',async()=>{
  const {db,api}=fixture();
  try{
    const bounded=await api.listItems('workspace-1');
    assert.equal(bounded.length,200);
    assert.ok(!bounded.some(x=>x.id==='objective'));
    const complete=await api.listWorkspaceItems('workspace-1');
    assert.equal(complete.length,1204);
    for(const id of ['objective','kr','initiative','project'])assert.ok(complete.some(x=>x.id===id),id);
    assert.ok(!complete.some(x=>['foreign','archived'].includes(x.id)));
    assert.equal((await api.listWorkspaceItems('workspace-1',{kind:'task',parentId:'project'})).length,600);
    const assignments=await api.getItemAssignmentMap('workspace-1',complete.map(x=>x.id));
    assert.equal(assignments['task-1199'][0].memberId,'member-1');
    assert.deepEqual(await api.getItemAssignmentMap('workspace-2',complete.map(x=>x.id)),{});
  }finally{db.close();}
});

test('item refresh returns the complete authorized workspace and filters stay scoped',async()=>{
  const {db,api}=fixture();
  try{
    const route=load(read('app/api/items/route.ts'),{
      'cloudflare:workers':{env:{}},
      '@/lib/pace-data':{...api,ITEM_CADENCES:['weekly'],ITEM_KINDS:['objective','key_result','initiative','project','task','ticket'],ITEM_PRIORITIES:['medium'],ITEM_STATUSES:['todo','in_progress','archived'],authorizeRequest:async()=>({ownerId:'workspace-1',userId:'user-1'}),ensureWorkspace:async()=>{},getItemCreatorMap:async()=>({}),serializeItem:item=>item},
      '@/lib/billing':{BillingLimitError:class extends Error{}},
      '@/lib/project-review-service':{},'@/lib/work-intake':{}
    });
    const response=await route.GET(new Request('http://localhost/api/items'));
    assert.equal(response.status,200);
    const payload=await response.json();
    assert.equal(payload.items.length,1204);
    assert.ok(payload.items.some(x=>x.id==='objective'));
    const filtered=await route.GET(new Request('http://localhost/api/items?kind=task&parentId=project'));
    assert.equal((await filtered.json()).items.length,600);
  }finally{db.close();}
});
