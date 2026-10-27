import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {compileLanguageModule as compile} from './helpers/language-fixture.mjs';
const read=p=>readFile(new URL(`../${p}`,import.meta.url),'utf8');
const source=await read('lib/ticket-intake-queue.ts'),migration=await read('drizzle/0074_ticket_intake_coverage.sql'),policy=compile(await read('lib/ticket-policy.ts'));
const problemMigration=await read('drizzle/0075_ticket_problem_followups.sql');
function fixture(t,options={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("PRAGMA foreign_keys=ON;CREATE TABLE workspaces(id TEXT PRIMARY KEY);INSERT INTO workspaces VALUES('w1'),('w2');CREATE TABLE ticket_automation_settings(owner_id TEXT,team_id TEXT,config_json TEXT,enabled INTEGER);CREATE TABLE ticket_automation_audit(id TEXT PRIMARY KEY,owner_id TEXT,actor_user_id TEXT,action TEXT,details_json TEXT,created_at TEXT);");db.exec(migration.slice(migration.indexOf('CREATE TABLE ticket_intake_messages')));db.exec(problemMigration);
  const config={channels:[{id:'C1',name:'customer-one',enabled:true,autoApprove:'manual'}],destination:'CMGMT'};db.prepare('INSERT INTO ticket_automation_settings VALUES(?,?,?,1)').run('w1','T1',JSON.stringify(config));
  db.exec("CREATE TABLE ticket_automation_requests(id TEXT PRIMARY KEY,owner_id TEXT,state TEXT,member_id TEXT DEFAULT 'm1');CREATE TABLE local_agent_jobs(id TEXT PRIMARY KEY);");
  const statement=(sql,args=[])=>({bind:(...v)=>statement(sql,v),first:async()=>db.prepare(sql).get(...args)||null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:{changes:Number(db.prepare(sql).run(...args).changes)}})});
  let failure=options.failure,modelCalls=0;const slackCalls=[],events=[],operatorReplies=[];
  const connection={ownerId:'w1',teamId:'T1',botUserId:'UBOT'};
  const api=async(_token,method,body)=>{slackCalls.push({method,body});if(options.slack)return options.slack(method,body);return {ok:true,messages:[]};};
  const service=compile(source,{'cloudflare:workers':{env:{DB:{prepare:statement}}},'@/lib/pace-data':{getSlackConnection:async owner=>owner==='w1'?connection:null,canManageTeam:a=>a.role==='owner'},'@/lib/slack-daily':{slackApi:api,slackTokenForConnection:async()=>'mock',dailyMemberBySlack:async(_team,user)=>['U1','U2'].includes(user)?{memberId:user==='U1'?'m1':'m2',authorization:{ownerId:'w1',role:'owner'}}:null},'@/lib/ticket-automation':{handleTicketThreadReply:async(_team,event)=>{if(failure)throw Error('port temporarily unavailable');if(options.delay)await new Promise(resolve=>setTimeout(resolve,20));operatorReplies.push(event);return true;},deliverTicketOutbox:async()=>{},analyzeTicketEvent:async(_c,e)=>{modelCalls++;events.push(e);if(options.delay)await new Promise(resolve=>setTimeout(resolve,20));if(failure)throw Object.assign(Error('provider offline'),typeof failure==='object'?failure:{});return {state:options.noWork?'no_work':'analyzed',requestIds:[],reason:options.noWork?'감사 인사이며 새 요청이 없습니다.':undefined};}},'@/lib/ticket-policy':policy});
  const event={channel:'C1',ts:'100.000001',user:'UCUSTOMER',text:'견적서 화면이 새하얘졌어요'};
  service.operatorReplyFixture=operatorReplies;
  return {db,config,service,event,connection,slackCalls,events,operatorReplies,get modelCalls(){return modelCalls;},setFailure:v=>{failure=v;}};
}
test('a durable receipt exists before analysis, duplicate webhook/history copies converge, and only one lease runs',async t=>{
  const f=fixture(t),id=await f.service.captureTicketMessage(f.connection,f.event);assert.equal(f.modelCalls,0);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages').get().state,'pending');
  await f.service.captureTicketMessage(f.connection,{...f.event,recovery:true,threadTs:f.event.ts});assert.equal(f.db.prepare('SELECT count(*) n FROM ticket_intake_messages').get().n,1);
  await Promise.all([f.service.processTicketReceipt(id),f.service.processTicketReceipt(id)]);assert.equal(f.modelCalls,1);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages').get().state,'analyzed');
});
test('future-only activation excludes the past, batches short cross-thread messages, and filters history reads',async t=>{
  const f=fixture(t);f.config.intakeStartAt=new Date(Date.now()-60000).toISOString();f.db.prepare('UPDATE ticket_automation_settings SET config_json=?').run(JSON.stringify(f.config));
  assert.equal(await f.service.captureTicketMessage(f.connection,f.event),null);
  const ts=String(Date.now()/1000),first=await f.service.captureTicketMessage(f.connection,{...f.event,ts}),second=await f.service.captureTicketMessage(f.connection,{...f.event,ts:String(Number(ts)+0.0001),text:'같은 문제의 구체적인 상품명입니다.'});
  await f.service.processTicketReceipt(first);assert.equal(f.modelCalls,0,'burst debounce must finish first');
  f.db.exec("UPDATE ticket_intake_messages SET next_attempt_at='2000'");await f.service.processTicketReceipt(first);assert.equal(f.modelCalls,1);assert.equal(f.events[0].batchEvents.length,2);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages WHERE id=?').get(second).state,'analyzed');
  await f.service.reconcileTicketIntake();assert.equal(f.slackCalls.find(c=>c.method==='conversations.history').body.oldest,String(Date.parse(f.config.intakeStartAt)/1000));
});
test('explicit single import is admin-only, channel-scoped and does not reset future-only settings',async t=>{
  const f=fixture(t),a={ownerId:'w1',userId:'u1',role:'owner',apiToken:false};
  await assert.rejects(f.service.importTicketSource({...a,role:'member'},'https://app.slack.com/archives/C1/p1792641620306119'));
  const id=await f.service.importTicketSource(a,'https://app.slack.com/archives/C1/p1792641620306119');const row=f.db.prepare('SELECT event_json FROM ticket_intake_messages WHERE id=?').get(id);assert.equal(JSON.parse(row.event_json).operatorImport,true);
  await assert.rejects(f.service.importTicketSource(a,'https://app.slack.com/archives/COTHER/p1792641620306119'));assert.equal(f.db.prepare('SELECT count(*) n FROM ticket_intake_messages').get().n,1);
});
test('downtime recovery discovers new replies on old unknown roots without importing old messages',async t=>{
  const recent=String(Date.now()/1000-10),f=fixture(t,{slack:async(method,body)=>method==='conversations.history'?(body.oldest?{ok:true,messages:[]}:{ok:true,messages:[{ts:'100.000001',user:'U1',text:'Do not reanalyze the past',reply_count:1,latest_reply:recent}]}):{ok:true,messages:[{ts:'100.000001',user:'U1',text:'Do not import this root'},{ts:recent,user:'U1',text:'새로운 증상이 발생했습니다.'}]}});
  f.config.intakeStartAt=new Date(Date.now()-60000).toISOString();f.db.prepare('UPDATE ticket_automation_settings SET config_json=?').run(JSON.stringify(f.config));
  await f.service.reconcileTicketIntake();const receipts=f.db.prepare('SELECT * FROM ticket_intake_messages').all();assert.equal(receipts.length,1);assert.equal(receipts[0].message_ts,recent);assert.equal(receipts[0].root_ts,'100.000001');assert.equal(f.modelCalls,0);
  assert.ok(f.slackCalls.find(c=>c.method==='conversations.replies').body.oldest);await f.service.reconcileTicketIntake();assert.equal(f.db.prepare('SELECT count(*) n FROM ticket_intake_messages').get().n,1);
});
test('model failure and an abandoned processing lease remain visible and are retried',async t=>{
  const f=fixture(t,{failure:true}),id=await f.service.captureTicketMessage(f.connection,f.event);await f.service.processTicketReceipt(id);let r=f.db.prepare('SELECT * FROM ticket_intake_messages').get();assert.equal(r.state,'retry');assert.equal(r.last_error,'analysis_retry_required');assert.equal(r.attempts,1);
  f.setFailure(false);f.db.exec("UPDATE ticket_intake_messages SET next_attempt_at='2000',state='processing',lease_until='2000'");await f.service.processTicketReceipt(id);r=f.db.prepare('SELECT * FROM ticket_intake_messages').get();assert.equal(r.state,'analyzed');assert.equal(r.attempts,2);
});

test('daily limits persist the exact reset, keep capture active and notify only the authorized workspace once',async t=>{
  const f=fixture(t,{failure:{code:'ai_daily_limit_reached'}});Object.assign(f.config,{notificationsAuthorized:true,intakeStartAt:new Date(Date.now()-60000).toISOString()});f.db.prepare('UPDATE ticket_automation_settings SET config_json=?').run(JSON.stringify(f.config));
  const id=await f.service.captureTicketMessage(f.connection,{...f.event,ts:String(Date.now()/1000)});f.db.exec("UPDATE ticket_intake_messages SET next_attempt_at='2000'");
  await Promise.all([f.service.processTicketReceipt(id),f.service.processTicketReceipt(id)]);
  let row=f.db.prepare('SELECT * FROM ticket_intake_messages').get();assert.equal(row.last_error,'ai_daily_limit_reached');assert.equal(row.next_attempt_at,new Date(new Date().setUTCHours(24,0,0,0)).toISOString());
  const posts=f.slackCalls.filter(c=>c.method==='chat.postMessage');assert.equal(posts.length,1);assert.equal(posts[0].body.channel,'CMGMT');assert.match(posts[0].body.text,/새 고객 메시지 수집은 계속/);assert.doesNotMatch(posts[0].body.text,/견적서/);
  await f.service.processTicketReceipt(id);assert.equal(f.modelCalls,1,'waiting for reset must not call the model');
  const second=await f.service.captureTicketMessage(f.connection,{...f.event,ts:String(Date.now()/1000+1)});assert.ok(second);f.db.exec("UPDATE ticket_intake_messages SET next_attempt_at='2000'");await f.service.processTicketReceipt(second);assert.equal(f.slackCalls.filter(c=>c.method==='chat.postMessage').length,1);
  row=(await f.service.ticketIntakeStatus('w1')).messages[0];assert.equal(row.last_error,'ai_daily_limit_reached');assert.ok(row.next_attempt_at);
});

test('overdue retry messages are analyzed in a bounded batch and paused together without losing receipts',async t=>{
  const f=fixture(t,{failure:{code:'ai_daily_limit_reached'}});f.config.intakeStartAt=new Date(Date.now()-60000).toISOString();f.db.prepare('UPDATE ticket_automation_settings SET config_json=?').run(JSON.stringify(f.config));
  const root=String(Date.now()/1000),ids=[];for(let i=0;i<23;i++)ids.push(await f.service.captureTicketMessage(f.connection,{...f.event,threadTs:root,ts:String(Date.now()/1000+i),text:`Issue ${i}`}));
  f.db.exec("UPDATE ticket_intake_messages SET state='retry',next_attempt_at='2000',received_at='2000'");await f.service.processTicketReceipt(ids[0]);assert.equal(f.events[0].batchEvents.length,20);assert.equal(f.db.prepare("SELECT count(*) n FROM ticket_intake_messages WHERE last_error='ai_daily_limit_reached'").get().n,20);assert.equal(f.slackCalls.filter(c=>c.method==='chat.postMessage').length,0,'no notification authorization');
  f.setFailure(false);f.db.exec("UPDATE ticket_intake_messages SET next_attempt_at='2000'");await f.service.processTicketReceipt(ids[0]);assert.equal(f.db.prepare("SELECT count(*) n FROM ticket_intake_messages WHERE state='analyzed'").get().n,20);assert.equal(f.db.prepare('SELECT count(*) n FROM ticket_intake_messages').get().n,23);
});

test('a scheduler tick selects one representative per channel so siblings remain available to its batch',async t=>{
  const f=fixture(t,{delay:true});f.config.intakeStartAt=new Date(Date.now()-60000).toISOString();f.config.channels.push({...f.config.channels[0],id:'C2'});f.db.prepare('UPDATE ticket_automation_settings SET config_json=?').run(JSON.stringify(f.config));
  const root=String(Date.now()/1000);for(let i=0;i<3;i++)await f.service.captureTicketMessage(f.connection,{...f.event,threadTs:root,ts:String(Number(root)+i)});await f.service.captureTicketMessage(f.connection,{...f.event,channel:'C2',ts:root});f.db.exec("UPDATE ticket_intake_messages SET next_attempt_at='2000'");
  await f.service.runTicketIntake();assert.equal(f.modelCalls,2);assert.equal(f.events.find(e=>e.channel==='C1').batchEvents.length,3);assert.equal(f.db.prepare("SELECT count(*) n FROM ticket_intake_messages WHERE state='analyzed'").get().n,4);
});

test('a budget pause preserves its period and an uncertain Slack notice never blindly resends',async t=>{
  const retryAt=new Date(Date.now()+86400000).toISOString();const f=fixture(t,{failure:{code:'ai_budget_exceeded',retryAt},slack:async()=>{throw Error('timeout after post');}});f.config.notificationsAuthorized=true;f.db.prepare('UPDATE ticket_automation_settings SET config_json=?').run(JSON.stringify(f.config));
  const id=await f.service.captureTicketMessage(f.connection,f.event);await f.service.processTicketReceipt(id);assert.equal(f.db.prepare('SELECT next_attempt_at FROM ticket_intake_messages').get().next_attempt_at,retryAt);assert.equal(JSON.parse(f.db.prepare('SELECT details_json FROM ticket_automation_audit').get().details_json).state,'unconfirmed');
  f.db.exec("UPDATE ticket_intake_messages SET next_attempt_at='2000'");await f.service.processTicketReceipt(id);assert.equal(f.slackCalls.filter(c=>c.method==='chat.postMessage').length,1);
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

test('management replies persist before acknowledgement and message/mention duplicates reach the port once without AI',async t=>{
  const f=fixture(t,{failure:true});f.db.exec("ALTER TABLE ticket_automation_requests ADD COLUMN team_id TEXT DEFAULT 'T1';INSERT INTO ticket_automation_requests(id,owner_id,state) VALUES('request','w1','waiting_answer');CREATE TABLE ticket_automation_outbox(owner_id TEXT,request_id TEXT,channel_id TEXT,message_ts TEXT,kind TEXT,state TEXT);INSERT INTO ticket_automation_outbox VALUES('w1','request','CMGMT','10.000','source','sent');");
  const event={channel:'CMGMT',ts:'11.000',threadTs:'10.000',user:'U1',text:'현재 제품 구현에 맞는 추천 범위를 알려 주세요.'};
  assert.equal(await f.service.captureTicketManagementReply(f.connection,{...event,user:'U2'}),null,'another administrator is not the assigned responder');assert.equal(await f.service.captureTicketManagementReply(f.connection,{...event,user:'UCUSTOMER'}),null);
  const id=await f.service.captureTicketManagementReply(f.connection,event);assert.ok(id);assert.equal(f.operatorReplies.length,0);
  assert.equal(await f.service.captureTicketManagementReply(f.connection,event),id);assert.equal(await f.service.captureTicketManagementReply(f.connection,{...event,channel:'OTHER'}),null);
  await f.service.processTicketReceipt(id);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages WHERE id=?').get(id).state,'retry');
  f.setFailure(false);f.db.exec("UPDATE ticket_intake_messages SET next_attempt_at='2000'");await f.service.processTicketReceipt(id);await f.service.processTicketReceipt(id);
  assert.equal(f.operatorReplies.length,1);assert.equal(f.modelCalls,0);assert.equal(f.db.prepare('SELECT state FROM ticket_intake_messages WHERE id=?').get(id).state,'analyzed');
});

test('different assigned ticket threads do not block each other in the same management channel',async t=>{
 const f=fixture(t,{delay:true});f.db.exec("ALTER TABLE ticket_automation_requests ADD COLUMN team_id TEXT DEFAULT 'T1';INSERT INTO ticket_automation_requests(id,owner_id,state) VALUES('r1','w1','running'),('r2','w1','running');CREATE TABLE ticket_automation_outbox(owner_id TEXT,request_id TEXT,channel_id TEXT,message_ts TEXT,kind TEXT,state TEXT);INSERT INTO ticket_automation_outbox VALUES('w1','r1','CMGMT','10.000','source','sent'),('w1','r2','CMGMT','20.000','source','sent');");
 const ids=[];for(const root of ['10.000','20.000'])ids.push(await f.service.captureTicketManagementReply(f.connection,{channel:'CMGMT',ts:root+'1',threadTs:root,user:'U1',text:'현재 구현에 맞춰 검토해 주세요.'}));
 await Promise.all(ids.map(id=>f.service.processTicketReceipt(id)));assert.equal(f.operatorReplies.length,2);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ticket_intake_messages WHERE state='analyzed'").get().n,2);assert.equal(f.modelCalls,0);
});
