import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {compileLanguageModule as compile} from './helpers/language-fixture.mjs';
const read=p=>readFile(new URL(`../${p}`,import.meta.url),'utf8');
const source=await read('lib/ticket-intake-queue.ts'),migration=await read('drizzle/0074_ticket_intake_coverage.sql'),policy=compile(await read('lib/ticket-policy.ts'));
function fixture(t,options={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("PRAGMA foreign_keys=ON;CREATE TABLE workspaces(id TEXT PRIMARY KEY);INSERT INTO workspaces VALUES('w1'),('w2');CREATE TABLE ticket_automation_settings(owner_id TEXT,team_id TEXT,config_json TEXT,enabled INTEGER);CREATE TABLE ticket_automation_audit(id TEXT,owner_id TEXT,actor_user_id TEXT,action TEXT,details_json TEXT,created_at TEXT);");db.exec(migration.slice(migration.indexOf('CREATE TABLE ticket_intake_messages')));
  const config={channels:[{id:'C1',name:'customer-one',enabled:true,autoApprove:'manual'}],destination:'CMGMT'};db.prepare('INSERT INTO ticket_automation_settings VALUES(?,?,?,1)').run('w1','T1',JSON.stringify(config));
  const statement=(sql,args=[])=>({bind:(...v)=>statement(sql,v),first:async()=>db.prepare(sql).get(...args)||null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:{changes:Number(db.prepare(sql).run(...args).changes)}})});
  let failure=options.failure,modelCalls=0;const slackCalls=[],events=[];
  const connection={ownerId:'w1',teamId:'T1',botUserId:'UBOT'};
  const api=async(_token,method,body)=>{slackCalls.push({method,body});if(options.slack)return options.slack(method,body);return {ok:true,messages:[]};};
  const service=compile(source,{'cloudflare:workers':{env:{DB:{prepare:statement}}},'@/lib/pace-data':{getSlackConnection:async owner=>owner==='w1'?connection:null,canManageTeam:a=>a.role==='owner'},'@/lib/slack-daily':{slackApi:api,slackTokenForConnection:async()=>'mock'},'@/lib/ticket-automation':{analyzeTicketEvent:async(_c,e)=>{modelCalls++;events.push(e);if(options.delay)await new Promise(resolve=>setTimeout(resolve,20));if(failure)throw Error('provider offline');return {state:options.noWork?'no_work':'analyzed',requestIds:[],reason:options.noWork?'감사 인사이며 새 요청이 없습니다.':undefined};}},'@/lib/ticket-policy':policy});
  const event={channel:'C1',ts:'100.000001',user:'UCUSTOMER',text:'견적서 화면이 새하얘졌어요'};
  return {db,config,service,event,connection,slackCalls,events,get modelCalls(){return modelCalls;},setFailure:v=>{failure=v;}};
}
test('a durable receipt exists before analysis, duplicate webhook/history copies converge, and only one lease runs',async t=>{
  const f=fixture(t),id=await f.service.captureTicketMessage(f.connection,f.event);assert.equal(f.modelCalls,0);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages').get().state,'pending');
  await f.service.captureTicketMessage(f.connection,{...f.event,recovery:true,threadTs:f.event.ts});assert.equal(f.db.prepare('SELECT count(*) n FROM ticket_intake_messages').get().n,1);
  await Promise.all([f.service.processTicketReceipt(id),f.service.processTicketReceipt(id)]);assert.equal(f.modelCalls,1);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages').get().state,'analyzed');
});
test('model failure and an abandoned processing lease remain visible and are retried',async t=>{
  const f=fixture(t,{failure:true}),id=await f.service.captureTicketMessage(f.connection,f.event);await f.service.processTicketReceipt(id);let r=f.db.prepare('SELECT * FROM ticket_intake_messages').get();assert.equal(r.state,'retry');assert.equal(r.last_error,'analysis_retry_required');assert.equal(r.attempts,1);
  f.setFailure(false);f.db.exec("UPDATE ticket_intake_messages SET next_attempt_at='2000',state='processing',lease_until='2000'");await f.service.processTicketReceipt(id);r=f.db.prepare('SELECT * FROM ticket_intake_messages').get();assert.equal(r.state,'analyzed');assert.equal(r.attempts,2);
});
test('edits preserve separate versions, redact secrets/contact details, and untrusted relay messages remain auditable',async t=>{
  const f=fixture(t);await f.service.captureTicketMessage(f.connection,f.event);await f.service.captureTicketMessage(f.connection,{...f.event,text:'다른 문제 01012345678 API_KEY=sk-proj-abcdefghijklmnop123456789'});assert.equal(f.db.prepare('SELECT count(*) n FROM ticket_intake_messages').get().n,2);const saved=f.db.prepare('SELECT event_json FROM ticket_intake_messages ORDER BY rowid DESC').get().event_json;assert.doesNotMatch(saved,/01012345678|sk-proj/);assert.equal(JSON.parse(saved).securityBlocked,true);
  assert.equal(await f.service.captureTicketMessage(f.connection,{...f.event,ts:'200.000',user:'UBAD',isRelay:true}),null);assert.equal(f.db.prepare("SELECT state FROM ticket_intake_messages WHERE message_ts='200.000'").get().state,'ignored');assert.equal(f.modelCalls,0);
});
test('history and old-thread pagination resume without losing roots or replies and mark restored work as manual',async t=>{
  const f=fixture(t,{slack:async(method,body)=>method==='conversations.history'?body.cursor?{ok:true,messages:[{ts:'50.000',user:'U2',text:'오래된 고객 요청'}],response_metadata:{next_cursor:''}}:{ok:true,messages:[{ts:'100.000',user:'U1',text:'처음 요청',reply_count:1,latest_reply:'101.000'}],has_more:true,response_metadata:{next_cursor:'older'}}:{ok:true,messages:[{ts:'100.000',user:'U1',text:'처음 요청'},{ts:'101.000',user:'U1',text:'다른 문제도 있습니다.'}],response_metadata:{next_cursor:''}}});
  await f.service.reconcileTicketIntake();assert.equal(f.db.prepare('SELECT cursor FROM ticket_intake_scans').get().cursor,'older');assert.equal(f.db.prepare('SELECT count(*) n FROM ticket_intake_messages').get().n,2);
  await f.service.reconcileTicketIntake();const scan=f.db.prepare('SELECT * FROM ticket_intake_scans').get();assert.equal(scan.completed_passes,1);assert.equal(scan.cursor,'');assert.equal(f.db.prepare('SELECT count(*) n FROM ticket_intake_messages').get().n,3);assert.ok(f.db.prepare('SELECT event_json FROM ticket_intake_messages').all().every(r=>JSON.parse(r.event_json).recovery));
  const status=await f.service.ticketIntakeStatus('w1');assert.equal(status.channels[0].pending_threads,0);assert.equal(status.total,3);
});
test('permission/rate failures do not advance a history cursor or masquerade as a complete pass',async t=>{
  const f=fixture(t,{slack:async()=>{throw Error('missing_scope');}});await f.service.reconcileTicketIntake();const s=f.db.prepare('SELECT * FROM ticket_intake_scans').get();assert.equal(s.completed_passes,0);assert.equal(s.cursor,'');assert.equal(s.last_error,'history_retry_required');
});
test('excluded messages keep their reason; manual review is scoped and never bypasses relay authorization',async t=>{
  const f=fixture(t,{noWork:true}),id=await f.service.captureTicketMessage(f.connection,f.event);await f.service.processTicketReceipt(id);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages').get().state,'no_work');
  await assert.rejects(f.service.requestTicketReconciliation({ownerId:'w1',userId:'u1',role:'member',apiToken:false},id));
  await f.service.requestTicketReconciliation({ownerId:'w2',userId:'u2',role:'owner',apiToken:false},id);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages').get().state,'no_work');
  await f.service.requestTicketReconciliation({ownerId:'w1',userId:'u1',role:'owner',apiToken:false},id);assert.equal(JSON.parse(f.db.prepare('SELECT event_json FROM ticket_intake_messages').get().event_json).forceReview,true);
});
test('messages in the same source thread serialize their analyses so later work sees earlier tickets',async t=>{
  const f=fixture(t,{delay:true}),first=await f.service.captureTicketMessage(f.connection,f.event),second=await f.service.captureTicketMessage(f.connection,{...f.event,ts:'101.000001',threadTs:f.event.ts,text:'추가로 다른 기능도 필요합니다.'});await Promise.all([f.service.processTicketReceipt(first),f.service.processTicketReceipt(second)]);assert.equal(f.modelCalls,1);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages WHERE id=?').get(second).state,'pending');f.db.prepare("UPDATE ticket_intake_messages SET next_attempt_at='2000' WHERE id=?").run(second);await f.service.processTicketReceipt(second);assert.equal(f.modelCalls,2);assert.equal(f.db.prepare('SELECT analysis_lease_id FROM ticket_intake_threads').get().analysis_lease_id,null);
});
