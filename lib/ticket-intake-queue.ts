import {env} from 'cloudflare:workers';
import {getSlackConnection,type RequestAuthorization,canManageTeam} from '@/lib/pace-data';
import {slackApi,slackTokenForConnection} from '@/lib/slack-daily';
import {analyzeTicketEvent,type TicketIntakeEvent,type TicketAutomationConfig} from '@/lib/ticket-automation';
import {redactTicketText,assessTicketText} from '@/lib/ticket-policy';
const now=()=>new Date().toISOString();
const run=(sql:string,...args:unknown[])=>env.DB.prepare(sql).bind(...args).run();
const one=<T>(sql:string,...args:unknown[])=>env.DB.prepare(sql).bind(...args).first<T>();
const rows=async<T>(sql:string,...args:unknown[])=>(await env.DB.prepare(sql).bind(...args).all<T>()).results||[];
type Connection={ownerId:string;teamId:string;botUserId:string};
type Receipt={id:string;owner_id:string;event_json:string;attempts:number;channel_id:string;message_ts:string;root_ts:string};
type Settings={owner_id:string;team_id:string;config_json:string;enabled:number};
type SlackMessage={ts?:string;thread_ts?:string;user?:string;text?:string;bot_id?:string;subtype?:string;files?:unknown[];attachments?:unknown[];reply_count?:number;latest_reply?:string};
type Scan={owner_id:string;channel_id:string;cursor:string;root_ts?:string;latest_reply?:string};
const safe=(value:string)=>redactTicketText(value).replace(/(?<!\d)(?:\+82[- ]?1[016789]|01[016789])[- ]?\d{3,4}[- ]?\d{4}(?!\d)/g,'[연락처 삭제]');
async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}

/** One persisted operational notice per workspace/reason/day. An ambiguous Slack POST is never resent. */
async function notifyAnalysisPaused(owner:string,code:string,retryAt:string){
  if(!['ai_daily_limit_reached','ai_budget_exceeded'].includes(code))return;
  const setting=await one<Settings>('SELECT * FROM ticket_automation_settings WHERE owner_id=?',owner);
  if(!setting?.enabled)return;
  const c=JSON.parse(setting.config_json) as TicketAutomationConfig,connection=await getSlackConnection(owner);
  if(!c.notificationsAuthorized||!c.destination||!connection||connection.teamId!==setting.team_id)return;
  const id=await hash(`analysis-paused:${owner}:${code}:${now().slice(0,10)}`),time=now();
  const waiting=await rows<{channel_id:string;root_ts:string}>("SELECT DISTINCT channel_id,root_ts FROM ticket_intake_messages WHERE owner_id=? AND state IN ('retry','pending','processing') ORDER BY root_ts DESC LIMIT 5",owner);
  const reason=code==='ai_daily_limit_reached'?'오늘의 AI 분석 횟수 한도에 도달했습니다.':'AI 금액 예산 한도에 도달했습니다.';
  const text=`티켓 추천 분석 일시 중지\n${reason} 새 고객 메시지 수집은 계속되며 원문은 저장됩니다.\n자동 재개 예정: <!date^${Math.floor(Date.parse(retryAt)/1000)}^{date_short_pretty} {time}|${retryAt}>\n관리자는 OKRI의 수집 점검에서 대기 내용을 확인할 수 있습니다. 승인된 한도를 늘린 경우 분석 재시도를 눌러 주세요.${waiting.length?'\n\n분석 대기 원문\n'+waiting.map(r=>`• <https://slack.com/archives/${r.channel_id}/p${r.root_ts.replace('.','')}|고객 원문>`).join('\n'):''}`;
  const claimed=await run("INSERT OR IGNORE INTO ticket_automation_audit(id,owner_id,actor_user_id,action,details_json,created_at) VALUES(?,?,?,'analysis_paused_notice',?,?)",id,owner,'system',JSON.stringify({code,retryAt,state:'sending',destination:c.destination}),time);
  if(!claimed.meta.changes)return;
  try{
    const posted=await slackApi<{ts?:string}>(await slackTokenForConnection(connection),'chat.postMessage',{channel:c.destination,text,unfurl_links:false,unfurl_media:false,client_msg_id:`${id.slice(0,8)}-${id.slice(8,12)}-4${id.slice(13,16)}-a${id.slice(17,20)}-${id.slice(20,32)}`});
    await run('UPDATE ticket_automation_audit SET details_json=? WHERE id=? AND owner_id=?',JSON.stringify({code,retryAt,state:'sent',destination:c.destination,messageTs:posted.ts}),id,owner);
  }catch{
    await run('UPDATE ticket_automation_audit SET details_json=? WHERE id=? AND owner_id=?',JSON.stringify({code,retryAt,state:'unconfirmed',destination:c.destination}),id,owner);
  }
}

/** This write finishes BEFORE Slack receives 200. No AI or remote read is required here. */
export async function captureTicketMessage(connection:Connection,event:TicketIntakeEvent){
  const s=await one<Settings>('SELECT * FROM ticket_automation_settings WHERE owner_id=?',connection.ownerId);
  if(!s?.enabled||s.team_id!==connection.teamId||event.user===connection.botUserId)return null;
  const c=JSON.parse(s.config_json) as TicketAutomationConfig;
  if(c.intakeStartAt&&Number(event.ts)*1000<Date.parse(c.intakeStartAt))return null;
  const rule=c.channels.find(r=>r.id===event.channel&&r.enabled);
  if(!rule)return null;
  const ignoredRelay=event.isRelay&&(!rule.relayUserIds?.includes(event.user)||(rule.relayPrefix&&!event.text.trim().replace(/^\*+/,'').startsWith(rule.relayPrefix)));
  const digest=await hash(JSON.stringify({channel:event.channel,ts:event.ts,root:event.threadTs||event.ts,user:event.user,text:event.text,attachments:Boolean(event.hasAttachments),relay:Boolean(event.isRelay)}));
  const id=await hash(`${connection.ownerId}:${event.channel}:${event.ts}:${digest}`),time=now(),due=new Date(Date.now()+(c.intakeStartAt?20000:0)).toISOString();
  const stored={...event,text:safe(event.text),securityBlocked:assessTicketText(event.text).risk==='blocked'};
  await run(`INSERT OR IGNORE INTO ticket_intake_messages(id,owner_id,team_id,channel_id,root_ts,message_ts,user_id,event_json,digest,next_attempt_at,received_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,id,connection.ownerId,connection.teamId,event.channel,event.threadTs||event.ts,event.ts,event.user,JSON.stringify(stored),digest,due,time,time);
  if(ignoredRelay){await run("UPDATE ticket_intake_messages SET state='ignored',last_error='relay_authorization_required',updated_at=? WHERE id=? AND state='pending'",time,id);return null;}
  await run("UPDATE ticket_intake_messages SET state='pending',next_attempt_at=?,last_error='' WHERE id=? AND state='ignored'",due,id);
  if(event.threadTs)await run(`INSERT INTO ticket_intake_threads(owner_id,channel_id,root_ts,latest_reply,next_scan_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,channel_id,root_ts) DO UPDATE SET latest_reply=MAX(latest_reply,excluded.latest_reply),next_scan_at=MIN(next_scan_at,excluded.next_scan_at)`,connection.ownerId,event.channel,event.threadTs,event.ts,time);
  return id;
}

export async function processTicketReceipt(id:string){
  const lease=crypto.randomUUID(),time=now();
  const claimed=await run(`UPDATE ticket_intake_messages SET state='processing',attempts=attempts+1,lease_id=?,lease_until=?,updated_at=? WHERE id=? AND ((state IN ('pending','retry') AND next_attempt_at<=?) OR (state='processing' AND lease_until<?))`,lease,new Date(Date.now()+120000).toISOString(),time,id,time,time);
  if(!claimed.meta.changes)return;
  const r=await one<Receipt>('SELECT * FROM ticket_intake_messages WHERE id=? AND lease_id=?',id,lease);if(!r)return;
  await run('INSERT OR IGNORE INTO ticket_intake_channel_leases(owner_id,channel_id) VALUES(?,?)',r.owner_id,r.channel_id);
  const channelClaim=await run('UPDATE ticket_intake_channel_leases SET lease_id=?,lease_until=? WHERE owner_id=? AND channel_id=? AND (lease_until IS NULL OR lease_until<?)',lease,new Date(Date.now()+120000).toISOString(),r.owner_id,r.channel_id,time);
  if(!channelClaim.meta.changes){await run("UPDATE ticket_intake_messages SET state='pending',attempts=MAX(0,attempts-1),next_attempt_at=?,lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?",new Date(Date.now()+10000).toISOString(),id,lease);return;}
  await run('INSERT OR IGNORE INTO ticket_intake_threads(owner_id,channel_id,root_ts,latest_reply,scanned_reply,next_scan_at) VALUES(?,?,?,?,?,?)',r.owner_id,r.channel_id,r.root_ts,r.root_ts,r.root_ts,time);
  const threadClaim=await run('UPDATE ticket_intake_threads SET analysis_lease_id=?,analysis_lease_until=? WHERE owner_id=? AND channel_id=? AND root_ts=? AND (analysis_lease_until IS NULL OR analysis_lease_until<?)',lease,new Date(Date.now()+120000).toISOString(),r.owner_id,r.channel_id,r.root_ts,time);
  if(!threadClaim.meta.changes){await run("UPDATE ticket_intake_messages SET state='pending',attempts=MAX(0,attempts-1),next_attempt_at=?,lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?",new Date(Date.now()+10000).toISOString(),id,lease);await run('UPDATE ticket_intake_channel_leases SET lease_id=NULL,lease_until=NULL WHERE owner_id=? AND channel_id=? AND lease_id=?',r.owner_id,r.channel_id,lease);return;}
  let siblings:Receipt[]=[];
  try{
    const connection=await getSlackConnection(r.owner_id);if(!connection)throw new Error('connection_unavailable');
    const setting=await one<Settings>('SELECT * FROM ticket_automation_settings WHERE owner_id=?',r.owner_id),configuration=JSON.parse(setting?.config_json||'{}') as TicketAutomationConfig;
    const event=JSON.parse(r.event_json) as TicketIntakeEvent&{operatorImport?:boolean};
    siblings=configuration.intakeStartAt&&!event.operatorImport?await rows<Receipt>(`SELECT * FROM ticket_intake_messages WHERE owner_id=? AND channel_id=? AND state IN ('pending','retry') AND next_attempt_at<=? AND COALESCE(json_extract(event_json,'$.operatorImport'),0)=0 AND (root_ts=? OR received_at>=?) AND id<>? ORDER BY message_ts LIMIT 19`,r.owner_id,r.channel_id,time,r.root_ts,new Date(Date.now()-120000).toISOString(),id):[];
    // Keep the full source context for detection, but one bounded burst uses one model reservation.
    const outcome=await analyzeTicketEvent(connection,{...event,...(siblings.length&&!event.operatorImport?{batchEvents:[event,...siblings.map(v=>JSON.parse(v.event_json) as TicketIntakeEvent)]}:{})},event.operatorImport===true);
    await run(`UPDATE ticket_intake_messages SET state=?,request_ids_json=?,last_error=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=?`,outcome.state,JSON.stringify(outcome.requestIds),safe(outcome.reason||'').slice(0,500),now(),id,lease);
    if(siblings.length&&outcome.state!=='ignored')await run(`UPDATE ticket_intake_messages SET state=?,request_ids_json=?,last_error=?,updated_at=? WHERE id IN (SELECT value FROM json_each(?)) AND state IN ('pending','retry')`,outcome.state,JSON.stringify(outcome.requestIds),safe(outcome.reason||'').slice(0,500),now(),JSON.stringify(siblings.map(v=>v.id)));
  }catch(error){
    const failure=error as {code?:string;retryAt?:string};
    const code=['ai_daily_limit_reached','ai_budget_exceeded','ai_rate_limited','ai_reservation_limited','ai_provider_rate_limited','analysis_provider_unavailable','analysis_invalid_response','analysis_configuration_required'].includes(failure?.code||'')?failure.code!:'analysis_retry_required';
    const reset=code==='ai_daily_limit_reached'?new Date().setUTCHours(24,0,0,0):Date.parse(failure?.retryAt||'');
    const retry=new Date(reset>Date.now()&&reset<Date.now()+366*86400000?reset:Date.now()+Math.min(3600000,30000*2**Math.min(r.attempts,7))).toISOString();
    await run(`UPDATE ticket_intake_messages SET state='retry',next_attempt_at=?,last_error=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=?`,retry,code,now(),id,lease);
    if(siblings.length)await run(`UPDATE ticket_intake_messages SET state='retry',next_attempt_at=?,last_error=?,updated_at=? WHERE id IN(SELECT value FROM json_each(?)) AND state IN('pending','retry')`,retry,code,now(),JSON.stringify(siblings.map(v=>v.id)));
    await notifyAnalysisPaused(r.owner_id,code,retry).catch(()=>undefined);
  }finally{await run('UPDATE ticket_intake_threads SET analysis_lease_id=NULL,analysis_lease_until=NULL WHERE owner_id=? AND channel_id=? AND root_ts=? AND analysis_lease_id=?',r.owner_id,r.channel_id,r.root_ts,lease);await run('UPDATE ticket_intake_channel_leases SET lease_id=NULL,lease_until=NULL WHERE owner_id=? AND channel_id=? AND lease_id=?',r.owner_id,r.channel_id,lease);}
}

async function captureSlackPage(connection:Connection,channel:string,messages:SlackMessage[],recovery:boolean){
  for(const m of messages){
    if(!m.ts)continue;
    if((m.user||m.bot_id)&&(!m.subtype||['bot_message','file_share','thread_broadcast'].includes(m.subtype))&&(m.text||m.files?.length||m.attachments?.length))await captureTicketMessage(connection,{channel,ts:m.ts,user:m.user||`bot:${m.bot_id}`,text:m.text||'',threadTs:m.thread_ts,hasAttachments:Boolean(m.files?.length||m.attachments?.length),isRelay:Boolean(m.bot_id||m.subtype==='bot_message'),recovery});
    if(m.reply_count)await run(`INSERT INTO ticket_intake_threads(owner_id,channel_id,root_ts,latest_reply,next_scan_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,channel_id,root_ts) DO UPDATE SET latest_reply=MAX(latest_reply,excluded.latest_reply)`,connection.ownerId,channel,m.thread_ts||m.ts,m.latest_reply||m.ts,now());
  }
}

/** Future-only history recovery plus cheap, incremental watches on linked problem threads. */
export async function reconcileTicketIntake(){
  const settings=await rows<Settings>('SELECT * FROM ticket_automation_settings WHERE enabled=1');
  for(const s of settings){
    const c=JSON.parse(s.config_json) as TicketAutomationConfig;
    const enabled=c.channels.filter(ch=>ch.enabled);
    for(const ch of enabled)await run('INSERT OR IGNORE INTO ticket_intake_scans(owner_id,channel_id,next_scan_at) VALUES(?,?,?)',s.owner_id,ch.id,now());
    const connection=await getSlackConnection(s.owner_id);if(!connection||connection.teamId!==s.team_id)continue;
    const token=await slackTokenForConnection(connection),channels=JSON.stringify(enabled.map(ch=>ch.id));
    const watched=await rows<{channel_id:string;root_ts:string}>(`SELECT DISTINCT p.channel_id,p.root_ts FROM ticket_problem_sources p JOIN ticket_automation_requests r ON r.id=p.request_id AND r.owner_id=p.owner_id WHERE p.owner_id=? AND r.state NOT IN ('published','dismissed') AND p.channel_id IN (SELECT value FROM json_each(?))`,s.owner_id,channels);
    for(const watch of watched)await run(`INSERT INTO ticket_intake_threads(owner_id,channel_id,root_ts,next_scan_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,channel_id,root_ts) DO NOTHING`,s.owner_id,watch.channel_id,watch.root_ts,now());
    const scans=await rows<Scan>(`SELECT * FROM ticket_intake_scans WHERE owner_id=? AND channel_id IN (SELECT value FROM json_each(?)) AND next_scan_at<=? ORDER BY COALESCE(last_checked_at,''),channel_id LIMIT 4`,s.owner_id,channels,now());
    for(const scan of scans){
      const time=now(),lock=new Date(Date.now()+180000).toISOString();
      if(!(await run('UPDATE ticket_intake_scans SET next_scan_at=? WHERE owner_id=? AND channel_id=? AND next_scan_at<=?',lock,s.owner_id,scan.channel_id,time)).meta.changes)continue;
      try{
        const page=await slackApi<{ok:boolean;messages?:SlackMessage[];response_metadata?:{next_cursor?:string};has_more?:boolean}>(token,'conversations.history',{channel:scan.channel_id,limit:100,...(c.intakeStartAt?{oldest:String(Date.parse(c.intakeStartAt)/1000)}:{}),...(scan.cursor?{cursor:scan.cursor}:{})});
        const cursor=page.response_metadata?.next_cursor||'';
        if(page.has_more&&!cursor)throw new Error('history_cursor_missing');
        await captureSlackPage(connection,scan.channel_id,page.messages||[],true);
        await run(`UPDATE ticket_intake_scans SET cursor=?,completed_passes=completed_passes+?,messages_seen=messages_seen+?,last_checked_at=?,last_completed_at=CASE WHEN ?='' THEN ? ELSE last_completed_at END,next_scan_at=?,last_error='' WHERE owner_id=? AND channel_id=?`,cursor,cursor?0:1,page.messages?.length||0,time,cursor,time,new Date(Date.now()+(cursor?0:300000)).toISOString(),s.owner_id,scan.channel_id);
      }catch{await run("UPDATE ticket_intake_scans SET last_checked_at=?,last_error='history_retry_required',next_scan_at=? WHERE owner_id=? AND channel_id=?",time,lock,s.owner_id,scan.channel_id);}
    }
    // Metadata discovery closes the downtime gap for NEW replies attached to OLD unknown roots.
    // Old message bodies never become receipts or AI requests. The saved cursor makes this bounded/fair.
    if(c.intakeStartAt){
      for(const ch of enabled)await run('INSERT OR IGNORE INTO ticket_intake_reply_discovery(owner_id,channel_id,next_scan_at) VALUES(?,?,?)',s.owner_id,ch.id,now());
      const discovery=await rows<Scan>('SELECT * FROM ticket_intake_reply_discovery WHERE owner_id=? AND channel_id IN(SELECT value FROM json_each(?)) AND next_scan_at<=? ORDER BY next_scan_at,channel_id LIMIT 2',s.owner_id,channels,now());
      for(const scan of discovery){
        const time=now(),lock=new Date(Date.now()+180000).toISOString();
        if(!(await run('UPDATE ticket_intake_reply_discovery SET next_scan_at=? WHERE owner_id=? AND channel_id=? AND next_scan_at<=?',lock,s.owner_id,scan.channel_id,time)).meta.changes)continue;
        try{
          const page=await slackApi<{ok:boolean;messages?:SlackMessage[];response_metadata?:{next_cursor?:string};has_more?:boolean}>(token,'conversations.history',{channel:scan.channel_id,limit:100,...(scan.cursor?{cursor:scan.cursor}:{})});
          const cursor=page.response_metadata?.next_cursor||'';if(page.has_more&&!cursor)throw new Error('history_cursor_missing');
          for(const m of page.messages||[])if(m.ts&&m.reply_count&&Number(m.latest_reply)*1000>=Date.parse(c.intakeStartAt))await run(`INSERT INTO ticket_intake_threads(owner_id,channel_id,root_ts,latest_reply,next_scan_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,channel_id,root_ts) DO UPDATE SET latest_reply=MAX(latest_reply,excluded.latest_reply)`,s.owner_id,scan.channel_id,m.thread_ts||m.ts,m.latest_reply,now());
          await run("UPDATE ticket_intake_reply_discovery SET cursor=?,next_scan_at=?,last_error='' WHERE owner_id=? AND channel_id=?",cursor,new Date(Date.now()+(cursor?60000:300000)).toISOString(),s.owner_id,scan.channel_id);
        }catch{await run("UPDATE ticket_intake_reply_discovery SET next_scan_at=?,last_error='reply_discovery_retry_required' WHERE owner_id=? AND channel_id=?",lock,s.owner_id,scan.channel_id);}
      }
    }
    const threads=await rows<Scan>(`SELECT * FROM ticket_intake_threads WHERE owner_id=? AND channel_id IN (SELECT value FROM json_each(?)) AND next_scan_at<=? ORDER BY next_scan_at,root_ts LIMIT 4`,s.owner_id,channels,now());
    for(const scan of threads){
      const time=now(),lock=new Date(Date.now()+180000).toISOString();
      if(!(await run('UPDATE ticket_intake_threads SET next_scan_at=? WHERE owner_id=? AND channel_id=? AND root_ts=? AND next_scan_at<=?',lock,s.owner_id,scan.channel_id,scan.root_ts,time)).meta.changes)continue;
      try{
        const page=await slackApi<{ok:boolean;messages?:SlackMessage[];response_metadata?:{next_cursor?:string};has_more?:boolean}>(token,'conversations.replies',{channel:scan.channel_id,ts:scan.root_ts,limit:100,...(c.intakeStartAt?{oldest:String(Math.max(Date.parse(c.intakeStartAt)/1000,Number((scan as Scan&{scanned_reply?:string}).scanned_reply)||0))}:{}),...(scan.cursor?{cursor:scan.cursor}:{})});
        const cursor=page.response_metadata?.next_cursor||'';if(page.has_more&&!cursor)throw new Error('reply_cursor_missing');
        await captureSlackPage(connection,scan.channel_id,(page.messages||[]).map(m=>({...m,thread_ts:scan.root_ts})),true);
        const latest=(page.messages||[]).reduce((v,m)=>Number(m.ts)>Number(v)?m.ts!:v,scan.latest_reply||scan.root_ts!);
        await run(`UPDATE ticket_intake_threads SET cursor=?,scanned_reply=CASE WHEN ?='' THEN ? ELSE scanned_reply END,next_scan_at=?,last_error='' WHERE owner_id=? AND channel_id=? AND root_ts=?`,cursor,cursor,latest,new Date(Date.now()+300000).toISOString(),s.owner_id,scan.channel_id,scan.root_ts);
      }catch{await run("UPDATE ticket_intake_threads SET last_error='replies_retry_required',next_scan_at=? WHERE owner_id=? AND channel_id=? AND root_ts=?",lock,s.owner_id,scan.channel_id,scan.root_ts);}
    }
  }
}
export async function runTicketIntake(){
  await reconcileTicketIntake().catch(()=>undefined);
  const due=await rows<{id:string}>(`SELECT id FROM (SELECT q.id,q.received_at,COALESCE(json_extract(q.event_json,'$.recovery'),0) AS recovery,ROW_NUMBER() OVER(PARTITION BY q.owner_id,q.channel_id ORDER BY COALESCE(json_extract(q.event_json,'$.recovery'),0),q.received_at,q.id) AS channel_rank FROM ticket_intake_messages q JOIN ticket_automation_settings s ON s.owner_id=q.owner_id AND s.enabled=1 WHERE (q.state IN ('pending','retry') AND q.next_attempt_at<=?) OR (q.state='processing' AND q.lease_until<?)) WHERE channel_rank=1 ORDER BY recovery,received_at,id LIMIT 6`,now(),now());
  // Keep live intake responsive without allowing duplicate workers or unbounded model concurrency.
  for(let i=0;i<due.length;i+=2)await Promise.all(due.slice(i,i+2).map(r=>processTicketReceipt(r.id)));
}
export type TicketIntakeStatus={offset:number;total:number;hasMore:boolean;counts:{state:string;count:number}[];channels:{channel_id:string;cursor:string;completed_passes:number;messages_seen:number;last_checked_at:string|null;last_completed_at:string|null;last_error:string;pending_threads:number;thread_errors?:number}[];messages:{id:string;channel_id:string;root_ts:string;message_ts:string;state:string;attempts:number;last_error:string;received_at:string;next_attempt_at?:string;text:string}[]};
export async function ticketIntakeStatus(owner:string,page:{offset?:number;state?:string}={}):Promise<TicketIntakeStatus>{
  const offset=Math.max(0,Math.floor(page.offset||0)),filter=page.state||'';
  const [counts,channels,messages]=await Promise.all([
    rows<{state:string;count:number}>('SELECT state,count(*) AS count FROM ticket_intake_messages WHERE owner_id=? GROUP BY state',owner),
    rows<TicketIntakeStatus['channels'][number]>(`SELECT s.*,(SELECT count(*) FROM ticket_intake_threads t WHERE t.owner_id=s.owner_id AND t.channel_id=s.channel_id AND (t.cursor<>'' OR t.latest_reply>t.scanned_reply)) AS pending_threads,(SELECT count(*) FROM ticket_intake_threads t WHERE t.owner_id=s.owner_id AND t.channel_id=s.channel_id AND t.last_error<>'') AS thread_errors FROM ticket_intake_scans s WHERE s.owner_id=? ORDER BY s.channel_id`,owner),
    rows<TicketIntakeStatus['messages'][number]>(`SELECT id,channel_id,root_ts,message_ts,state,attempts,last_error,received_at,next_attempt_at,json_extract(event_json,'$.text') AS text FROM ticket_intake_messages WHERE owner_id=? AND (?='' OR state=?) ORDER BY CASE WHEN state IN ('pending','retry','processing') THEN 0 ELSE 1 END,received_at DESC,id LIMIT 100 OFFSET ?`,owner,filter,filter,offset),
  ]);
  const discoveryErrors=await rows<{channel_id:string;last_error:string}>("SELECT channel_id,last_error FROM ticket_intake_reply_discovery WHERE owner_id=? AND last_error<>''",owner);
  for(const channel of channels)if(!channel.last_error)channel.last_error=discoveryErrors.find(e=>e.channel_id===channel.channel_id)?.last_error||'';
  const total=counts.filter(v=>!filter||v.state===filter).reduce((n,v)=>n+v.count,0);return {offset,total,hasMore:offset+100<total,counts,channels,messages};
}
export async function requestTicketReconciliation(a:RequestAuthorization,id?:string){
  if(a.apiToken||!canManageTeam(a))throw new Error('workspace_admin_required');
  await run('UPDATE ticket_intake_scans SET next_scan_at=? WHERE owner_id=?',now(),a.ownerId);
  if(id)await run("UPDATE ticket_intake_messages SET state='pending',event_json=json_set(event_json,'$.forceReview',json('true')),next_attempt_at=? WHERE owner_id=? AND id=? AND state<>'processing'",now(),a.ownerId,id);
  else await run("UPDATE ticket_intake_messages SET state='pending',next_attempt_at=? WHERE owner_id=? AND state='retry'",now(),a.ownerId);
  await run('INSERT INTO ticket_automation_audit(id,owner_id,actor_user_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)',crypto.randomUUID(),a.ownerId,a.userId,id?'intake_review_requested':'intake_reconciliation_requested',JSON.stringify({receiptId:id||null}),now());
}
/** Explicit one-source import never moves the future-only cursor or enables backfill. */
export async function importTicketSource(a:RequestAuthorization,url:string){
  if(a.apiToken||!canManageTeam(a))throw new Error('workspace_admin_required');
  const match=url.match(/^https:\/\/(?:[a-z0-9-]+\.)?slack\.com\/archives\/([CG][A-Z0-9]+)\/p([0-9]{16,})(?:\?[^\s]*)?$/i);
  const s=await one<Settings>('SELECT * FROM ticket_automation_settings WHERE owner_id=?',a.ownerId),c=JSON.parse(s?.config_json||'{}') as TicketAutomationConfig;
  if(!match||!s?.enabled||!c.channels.some(ch=>ch.enabled&&ch.id===match[1]))throw new Error('enabled_customer_source_required');
  const ts=`${match[2].slice(0,-6)}.${match[2].slice(-6)}`,id=await hash(`operator_import:${a.ownerId}:${match[1]}:${ts}`),time=now();
  const event={channel:match[1],ts,threadTs:ts,user:'operator',text:'',operatorImport:true,recovery:true,forceReview:true};
  await run(`INSERT OR IGNORE INTO ticket_intake_messages(id,owner_id,team_id,channel_id,root_ts,message_ts,user_id,event_json,digest,next_attempt_at,received_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,id,a.ownerId,s.team_id,match[1],ts,ts,'operator',JSON.stringify(event),id,time,time,time);
  await run('INSERT INTO ticket_automation_audit(id,owner_id,actor_user_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)',crypto.randomUUID(),a.ownerId,a.userId,'single_source_import_requested',JSON.stringify({channel:match[1],rootTs:ts,maxRecommendations:1}),time);
  return id;
}
