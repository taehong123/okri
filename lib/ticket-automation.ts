import { env } from "cloudflare:workers";
import { canManageTeam, getSlackConnection, type RequestAuthorization } from "@/lib/pace-data";
import { dailyMemberBySlack, listSlackChannels, slackApi, slackTokenForConnection } from "@/lib/slack-daily";
import { createLocalAgentPairing } from "@/lib/local-agent";
import { prepareSlackTicketForm } from "@/lib/slack-ticket-intake";
import { readSlackThread } from "@/lib/slack-work-intake";
import { assessTicketText, canAutoApproveTicket, escapeSlackText, redactTicketText, TICKET_PRIORITIES, ticketPriorityRank, type TicketPriority, type TicketRisk, type TicketState } from "@/lib/ticket-policy";
import {ticketProposalDescription,TICKET_CATEGORIES,TICKET_CATEGORY_LABELS,type TicketCategory,type TicketProposal} from '@/lib/ticket-recommendation';

export type TicketChannelRule = { id: string; name: string; enabled: boolean; autoApprove: "manual" | "low_risk"; memberId: string; portId: string; productId?:string; repositoryId?:string;relayUserIds?:string[];relayPrefix?:string;relayContentStart?:string;relayContentEnd?:string };
export type TicketRepository={id:string;name:string;remote:string;installRoots?:string[]};
export type TicketDevelopmentProduct={id:string;owner_id:string;name:string;specification:string;setup_instructions:string;repositories_json:string;revision:number;updated_at:string};
export type TicketAutomationConfig = { destination: string; prefix: string; channels: TicketChannelRule[]; actorUserId: string; notificationsAuthorized: boolean; defaultModel?: string };
export type TicketAutomationRequest = { source_event_ts:string;issue_key:string;category:TicketCategory;analysis_json:string; id: string; owner_id: string; team_id: string; source_channel: string; source_ts: string; source_user: string; requester_slack_user: string; requester_name: string; source_digest: string; source_text: string; title: string; description: string; risk: TicketRisk; reasons_json: string; state: TicketState; member_id: string | null; port_id: string | null; ticket_id: string | null; task_id: string | null; job_id: string | null; revision: number; notice: string; question: string; answer: string; security_json: string; priority:TicketPriority; product_id:string|null;repository_id:string;dependencies_json:string;coordination_json:string;release_commit:string;release_confirmed_by:string|null; updated_at: string; created_at: string };
type Port = { id: string; owner_id: string; member_id: string; device_id: string | null; name: string; chat_id: string | null; pairing_id:string|null; enabled: number; model: string; models_json: string; channel_ids_json: string; computer_label:string; product_id:string|null;repository_id:string;verified_remote:string };
type Settings = { owner_id: string; team_id: string; enabled: number; config_json: string };
const now = () => new Date().toISOString();
const rows = async <T>(sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<T>()).results ?? [];
const one = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();
async function updateTicketRevision(sql:string,...args:unknown[]) {const result=await run(sql,...args);if(!result.meta.changes)fail("내용이 변경되었습니다. 다시 확인해 주세요.",409);return result;}
const text = (v: unknown, max = 4000) => typeof v === "string" ? v.trim().slice(0, max) : "";
export class TicketAutomationError extends Error { constructor(message: string, public status = 400) { super(message); } }
function fail(message: string, status = 400): never { throw new TicketAutomationError(message, status); }
function config(row: Settings): TicketAutomationConfig { return JSON.parse(row.config_json); }
function admin(a: RequestAuthorization) { if (a.apiToken || !canManageTeam(a)) fail("관리자 계정에서 설정해 주세요.", 403); }
async function audit(owner: string, id: string | null, actor: string, action: string, revision: number | null = null, details: Record<string,unknown> = {}) {
  await run("INSERT INTO ticket_automation_audit(id,owner_id,request_id,actor_user_id,action,revision,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)", crypto.randomUUID(), owner, id, actor, action, revision, JSON.stringify(details), now());
}
async function settings(owner: string) { return one<Settings>("SELECT * FROM ticket_automation_settings WHERE owner_id=?", owner); }
async function productContext(owner:string,id:string|null,repositoryId:string) {
  const product=id?await one<TicketDevelopmentProduct>("SELECT * FROM ticket_development_products WHERE id=? AND owner_id=?",id,owner):null;
  const repository=product?(JSON.parse(product.repositories_json) as TicketRepository[]).find(r=>r.id===repositoryId):null;
  if(!product||!repository)fail("제품 명세와 Git 저장소를 먼저 선택해 주세요.");
  return {product,repository};
}
async function validateDependencies(owner:string,id:string,input:unknown,productId:string|null,repositoryId:string) {
  if(!Array.isArray(input)||input.length>20||input.some(v=>typeof v!=='string'))fail("선행 티켓을 확인해 주세요.");
  const ids=[...new Set(input as string[])];
  if(!ids.length)return ids;
  const valid=await rows<{id:string}>("SELECT id FROM ticket_automation_requests WHERE owner_id=? AND product_id=? AND repository_id=? AND id IN(SELECT value FROM json_each(?)) AND id<>? AND state<>'dismissed'",owner,productId,repositoryId,JSON.stringify(ids),id);
  if(valid.length!==ids.length)fail("같은 제품·저장소의 선행 티켓만 선택할 수 있습니다.");
  const cycle=await one("WITH RECURSIVE chain(id) AS(SELECT value FROM json_each(?) UNION SELECT e.value FROM ticket_automation_requests r JOIN chain c ON c.id=r.id JOIN json_each(r.dependencies_json) e WHERE r.owner_id=?) SELECT id FROM chain WHERE id=? LIMIT 1",JSON.stringify(ids),owner,id);
  if(cycle)fail("선행 티켓이 서로를 기다리는 순환 관계입니다.");return ids;
}
async function unresolvedDependencies(r:TicketAutomationRequest) {
  const ids=JSON.parse(r.dependencies_json||'[]') as string[];
  const confirmed=await rows<{id:string}>("SELECT id FROM ticket_automation_requests WHERE owner_id=? AND id IN(SELECT value FROM json_each(?)) AND release_commit<>''",r.owner_id,JSON.stringify(ids));
  return ids.filter(id=>!confirmed.some(v=>v.id===id));
}
async function repositoryRequests(r:TicketAutomationRequest) {
  if(!r.product_id||!r.repository_id)return [];
  const context=await productContext(r.owner_id,r.product_id,r.repository_id);
  return rows<TicketAutomationRequest>(`SELECT r.* FROM ticket_automation_requests r JOIN ticket_development_products p ON p.id=r.product_id AND p.owner_id=r.owner_id JOIN json_each(p.repositories_json) repo ON json_extract(repo.value,'$.id')=r.repository_id WHERE r.owner_id=? AND r.id<>? AND json_extract(repo.value,'$.remote')=? AND r.state NOT IN ('dismissed','blocked','failed') ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,r.created_at LIMIT 200`,r.owner_id,r.id,context.repository.remote);
}
async function coordinationContext(r:TicketAutomationRequest) {
  return (await repositoryRequests(r)).filter(v=>!v.release_commit).slice(0,12).map(v=>({requestId:v.id,title:v.title.slice(0,100),priority:v.priority,state:v.state,paths:(JSON.parse(v.coordination_json||'{}').paths||[]).slice(0,8),dependsOn:JSON.parse(v.dependencies_json||'[]')}));
}
export async function ticketRuntimeContext(jobId:string) {
  const r=await one<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE job_id=?",jobId);if(!r)return null;
  const dependencies=await rows<{id:string;title:string;release_commit:string}>("SELECT id,title,release_commit FROM ticket_automation_requests WHERE owner_id=? AND id IN(SELECT value FROM json_each(?)) ORDER BY id",r.owner_id,r.dependencies_json);
  return {dependencies,coordination:await coordinationContext(r)};
}
export function canonicalTicketRepository(input:string) {
  let url:URL;try{url=new URL(input);}catch{fail("Git 저장소의 HTTPS 주소를 입력해 주세요.");}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port||!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/.test(url.pathname)||url.pathname.split('/').includes('..'))fail("인증정보 없는 Git 저장소의 HTTPS 주소를 입력해 주세요.");
  return `${url.origin}${url.pathname.replace(/\.git\/?$/,'').replace(/\/$/,'')}`;
}
export async function saveTicketProduct(a:RequestAuthorization,p:Record<string,unknown>) {
  admin(a);const id=text(p.id,80)||crypto.randomUUID(),existing=await one<TicketDevelopmentProduct>("SELECT * FROM ticket_development_products WHERE id=? AND owner_id=?",id,a.ownerId);
  if(p.id&&!existing)fail("제품을 찾을 수 없습니다.",404);
  if(existing&&Number(p.revision)!==existing.revision)fail("제품 명세가 변경되었습니다. 새로고침 후 확인해 주세요.",409);
  const name=text(p.name,100),specification=text(p.specification,16000),setup=text(p.setupInstructions,8000);
  if(!name||!specification)fail("제품명과 기본 명세를 입력해 주세요.");
  if(redactTicketText(specification)!==specification||redactTicketText(setup)!==setup)fail("명세와 환경 설정 지침에 비밀번호·토큰을 넣을 수 없습니다.");
  const input=Array.isArray(p.repositories)?p.repositories as Record<string,unknown>[]:[];
  if(!input.length||input.length>10)fail("제품에 Git 저장소를 1~10개 연결해 주세요.");
  const repositories:TicketRepository[]=input.map(r=>{const installRoots=Array.isArray(r.installRoots)?r.installRoots.map(v=>text(v,160)):['.'];if(!installRoots.length||installRoots.length>10||installRoots.some(v=>!v||(v.startsWith('/')||v.startsWith('\\')||/[:\p{Cc}]/u.test(v))||v.replaceAll('\\','/').split('/').some(p=>p==='..'||/^\.(?:git|env|ssh|codex|aws)$/.test(p))))fail("의존성 경로는 저장소 안의 상대 경로로 지정해 주세요.");return {id:text(r.id,80)||crypto.randomUUID(),name:text(r.name,100)||name,remote:canonicalTicketRepository(text(r.remote,500)),installRoots};});
  if(new Set(repositories.map(r=>r.id)).size!==repositories.length)fail("저장소가 중복되었습니다.");
  const result=existing?await run("UPDATE ticket_development_products SET name=?,specification=?,setup_instructions=?,repositories_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?",name,specification,setup,JSON.stringify(repositories),now(),id,a.ownerId,existing.revision):await run("INSERT INTO ticket_development_products(id,owner_id,name,specification,setup_instructions,repositories_json,updated_at) VALUES(?,?,?,?,?,?,?)",id,a.ownerId,name,specification,setup,JSON.stringify(repositories),now());
  if(!result.meta.changes)fail("동시에 변경되었습니다.",409);
  await audit(a.ownerId,null,a.userId,'product_specification_saved',existing?.revision??1,{productId:id});return getTicketAutomation(a);
}
async function chooseTicketPort(owner: string, member: string | null, preferred: string | null, sourceChannel: string,productId:string|null,repositoryId:string) {
  if (!member||!productId||!repositoryId) return null;
  const context=await productContext(owner,productId,repositoryId);
  const s = await settings(owner), defaultModel = s ? config(s).defaultModel || "" : "";
  const candidates = await rows<Port & { user_id: string }>(`SELECT p.*,m.user_id,
    (SELECT COUNT(*) FROM ticket_automation_requests r WHERE r.port_id=p.id AND r.owner_id=p.owner_id AND r.state IN ('queued','running','waiting_answer')) AS pending
    FROM ticket_execution_ports p JOIN workspace_members m ON m.id=p.member_id AND m.workspace_id=p.owner_id
    JOIN local_agent_devices d ON d.id=p.device_id AND d.workspace_id=p.owner_id AND d.user_id=m.user_id
    WHERE p.owner_id=? AND p.member_id=? AND p.enabled=1 AND m.status='active' AND m.user_id IS NOT NULL
      AND d.revoked_at IS NULL AND d.last_seen_at>? AND (? IS NULL OR p.id=?)
      AND EXISTS(SELECT 1 FROM json_each(p.channel_ids_json) WHERE value=?)
      AND p.product_id=? AND p.repository_id=?
    ORDER BY pending,p.name`, owner, member, new Date(Date.now()-45000).toISOString(), preferred, preferred, sourceChannel,productId,repositoryId);
  return candidates.find(p => p.verified_remote===context.repository.remote&&(!(p.model || defaultModel) || JSON.parse(p.models_json).includes(p.model || defaultModel))) ?? null;
}
export async function recordTicketPortModels(device: { id: string; workspaceId: string; userId: string }, input: unknown,repositoryRemote?:unknown) {
  if (!Array.isArray(input) || input.length > 100) return;
  const models = [...new Set(input.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id)))];
  await run(`UPDATE ticket_execution_ports SET models_json=? WHERE device_id=? AND owner_id=? AND member_id IN(SELECT id FROM workspace_members WHERE workspace_id=? AND user_id=? AND status='active')`, JSON.stringify(models), device.id, device.workspaceId, device.workspaceId, device.userId);
  if(typeof repositoryRemote==='string'){
    const remote=canonicalTicketRepository(repositoryRemote);
    await run(`UPDATE ticket_execution_ports SET verified_remote=? WHERE device_id=? AND owner_id=? AND EXISTS(SELECT 1 FROM ticket_development_products product JOIN json_each(product.repositories_json) repo WHERE product.id=ticket_execution_ports.product_id AND product.owner_id=ticket_execution_ports.owner_id AND json_extract(repo.value,'$.id')=ticket_execution_ports.repository_id AND json_extract(repo.value,'$.remote')=?)`,remote,device.id,device.workspaceId,remote);
  }
}
async function digest(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join(""); }
export function sourceLink(r: Pick<TicketAutomationRequest, "source_channel" | "source_ts">) { return `https://slack.com/archives/${r.source_channel}/p${r.source_ts.replace(".", "")}`; }

export async function getTicketAutomation(a: RequestAuthorization,page:{offset?:number;requestId?:string}={}) {
  const [s, requests, ports, members, devices, deliveries, securityLog, products] = await Promise.all([
    settings(a.ownerId), rows<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE owner_id=? ORDER BY CASE WHEN state IN ('published','dismissed') THEN 1 ELSE 0 END,CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,created_at,id LIMIT 200 OFFSET ?", a.ownerId,Math.max(0,page.offset||0)),
    rows<Port & { display_name: string; last_seen_at: string | null; revoked_at: string | null }>(`SELECT p.*,m.display_name,d.last_seen_at,d.revoked_at FROM ticket_execution_ports p JOIN workspace_members m ON m.id=p.member_id AND m.workspace_id=p.owner_id LEFT JOIN local_agent_devices d ON d.id=p.device_id AND d.workspace_id=p.owner_id WHERE p.owner_id=? ORDER BY p.name`, a.ownerId),
    rows<{ id: string; display_name: string; user_id: string }>("SELECT id,display_name,user_id FROM workspace_members WHERE workspace_id=? AND status='active'", a.ownerId),
    rows<{ id: string; name: string; user_id: string; last_seen_at: string }>("SELECT id,name,user_id,last_seen_at FROM local_agent_devices WHERE workspace_id=? AND user_id=? AND revoked_at IS NULL", a.ownerId, a.userId),
    rows<{ id: string; request_id: string; state: string; last_error: string }>("SELECT id,request_id,state,last_error FROM ticket_automation_outbox WHERE owner_id=? AND state='uncertain' ORDER BY created_at DESC LIMIT 50", a.ownerId),
    rows("SELECT id,request_id,actor_user_id,action,revision,details_json,created_at FROM ticket_automation_audit WHERE owner_id=? ORDER BY created_at DESC LIMIT 100",a.ownerId),
    rows<TicketDevelopmentProduct>("SELECT * FROM ticket_development_products WHERE owner_id=? ORDER BY name",a.ownerId),
  ]);
  const connection=await getSlackConnection(a.ownerId);
  const missingScopes=connection?.scope?.split(',').includes('reactions:write')?[]:['reactions:write'];
  const total=(await one<{count:number}>('SELECT count(*) AS count FROM ticket_automation_requests WHERE owner_id=?',a.ownerId))?.count||0;
  const intake=await (await import('@/lib/ticket-intake-queue')).ticketIntakeStatus(a.ownerId);
  if(page.requestId&&!requests.some(r=>r.id===page.requestId)){const selected=await one<TicketAutomationRequest>('SELECT * FROM ticket_automation_requests WHERE owner_id=? AND id=?',a.ownerId,page.requestId);if(selected)requests.push(selected);}
  return { intake,requestPage:{total,offset:page.offset||0,hasMore:(page.offset||0)+200<total},settings: s ? { enabled: Boolean(s.enabled), ...config(s) } : { enabled: false, destination: "", prefix: "고객-", channels: [], notificationsAuthorized: false }, requests, ports:ports.map(p=>({...p,online:Boolean(!p.revoked_at&&p.last_seen_at&&Date.now()-Date.parse(p.last_seen_at)<45000)})), members, devices, deliveries, securityLog, products, missingScopes, canManage: !a.apiToken && canManageTeam(a), userId: a.userId };
}
export async function saveTicketAutomation(a: RequestAuthorization, payload: Record<string, unknown>) {
  admin(a);
  const connection = await getSlackConnection(a.ownerId);
  if (!connection) fail("Slack을 먼저 연결해 주세요.");
  const available = await listSlackChannels(a.ownerId);
  const destination = text(payload.destination, 80);
  if (!available.some(c => c.id === destination && c.isMember)) fail("공유 채널에 OKRI 앱을 먼저 추가해 주세요.");
  const prefix = text(payload.prefix, 80) || "고객-";
  const inputRules = Array.isArray(payload.channels) ? payload.channels as Record<string, unknown>[] : [];
  if (inputRules.length > 200) fail("연결 채널은 최대 200개입니다.");
  const channels: TicketChannelRule[] = [];
  for (const input of inputRules) {
    const channel = available.find(c => c.id === input.id && c.isMember);
    if (!channel || channel.id === destination) fail("앱이 참여 중인 고객 채널을 선택해 주세요.");
    if (channels.some(c => c.id === channel.id)) fail("같은 채널이 중복되었습니다.");
    const memberId = text(input.memberId, 80), portId = text(input.portId, 80);
    const productId=text(input.productId,80),repositoryId=text(input.repositoryId,80);
    if(productId||repositoryId)await productContext(a.ownerId,productId,repositoryId);
    if (memberId && !await one("SELECT id FROM workspace_members WHERE id=? AND workspace_id=? AND status='active' AND user_id IS NOT NULL", memberId, a.ownerId)) fail("활성 담당자를 선택해 주세요.");
    if (portId && !await one("SELECT id FROM ticket_execution_ports WHERE id=? AND owner_id=? AND member_id=? AND enabled=1", portId, a.ownerId, memberId)) fail("담당자의 활성 포트를 선택해 주세요.");
    const relayUserIds=Array.isArray(input.relayUserIds)?[...new Set(input.relayUserIds.map(v=>text(v,80)).filter(Boolean))]:[];
    if(relayUserIds.length>10||relayUserIds.some(id=>!/^U[A-Z0-9]+$/.test(id)||id===connection.botUserId))fail("중계 앱의 Slack 사용자 ID를 확인해 주세요.");
    for(const id of relayUserIds){const profile=await slackApi<{ok:boolean;user?:{is_bot?:boolean;deleted?:boolean}}>(await slackTokenForConnection(connection),'users.info',{user:id});if(!profile.user?.is_bot||profile.user.deleted)fail("활성 중계 봇만 허용할 수 있습니다.");}
    channels.push({ id: channel.id, name: channel.name, enabled: input.enabled === true, autoApprove: input.autoApprove === "low_risk" ? "low_risk" : "manual", memberId, portId,productId,repositoryId,relayUserIds,relayPrefix:text(input.relayPrefix,100),relayContentStart:text(input.relayContentStart,100),relayContentEnd:text(input.relayContentEnd,100) });
  }
  const defaultModel = text(payload.defaultModel, 128);
  if (defaultModel && !(await rows<{ models_json: string }>("SELECT models_json FROM ticket_execution_ports WHERE owner_id=?", a.ownerId)).some(p => JSON.parse(p.models_json).includes(defaultModel))) fail("연결된 포트가 지원하는 모델을 선택해 주세요.");
  const value: TicketAutomationConfig = { destination, prefix, channels, actorUserId: a.userId, notificationsAuthorized: payload.notificationsAuthorized === true, defaultModel };
  if (payload.enabled === true && !channels.some(c => c.enabled)) fail("연결할 고객 채널을 선택해 주세요.");
  await run(`INSERT INTO ticket_automation_settings(owner_id,team_id,config_json,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET team_id=excluded.team_id,config_json=excluded.config_json,enabled=excluded.enabled,updated_at=excluded.updated_at`, a.ownerId, connection.teamId, JSON.stringify(value), payload.enabled === true ? 1 : 0, now());
  await audit(a.ownerId, null, a.userId, "settings_saved");
  return getTicketAutomation(a);
}
export async function createTicketPorts(a: RequestAuthorization, p: Record<string, unknown>) {
  if (a.apiToken || a.role === "viewer") fail("포트를 만들 권한이 없습니다.", 403);
  const member = await one<{ id: string; user_id: string }>("SELECT id,user_id FROM workspace_members WHERE id=? AND workspace_id=? AND status='active'", text(p.memberId, 80), a.ownerId);
  if (!member || (member.user_id !== a.userId && !canManageTeam(a))) fail("자신 또는 관리 가능한 담당자를 선택해 주세요.", 403);
  const count = Number(p.count), prefix = text(p.prefix, 50);
  const computerLabel=text(p.computerLabel,80),productId=text(p.productId,80),repositoryId=text(p.repositoryId,80);
  if(productId||repositoryId)await productContext(a.ownerId,productId,repositoryId);
  const channelId=text(p.channelId,80),s=await settings(a.ownerId);
  if(channelId&&(!s||!config(s).channels.some(c=>c.enabled&&c.id===channelId)))fail("연결된 고객 채널을 선택해 주세요.");
  if (!prefix || !Number.isInteger(count) || count < 1 || count > 20) fail("이름과 1~20개 사이의 개수를 입력해 주세요.");
  const total = await one<{ n: number }>("SELECT COUNT(*) n FROM ticket_execution_ports WHERE owner_id=?", a.ownerId);
  if ((total?.n ?? 0) + count > 100) fail("워크스페이스 포트는 최대 100개입니다.");
  const existing = await rows<{ name: string }>("SELECT name FROM ticket_execution_ports WHERE owner_id=?", a.ownerId);
  const used = new Set(existing.map(p => p.name));
  const statements: D1PreparedStatement[] = [];
  for (let i = 1; statements.length < count; i++) {
    const name = `${prefix} ${String(i).padStart(2, "0")} 포트`;
    if (used.has(name)) continue;
    statements.push(env.DB.prepare("INSERT INTO ticket_execution_ports(id,owner_id,member_id,name,channel_ids_json,computer_label,product_id,repository_id) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), a.ownerId, member.id, name,JSON.stringify(channelId?[channelId]:[]),computerLabel,productId||null,repositoryId));
  }
  await env.DB.batch(statements);
  await audit(a.ownerId, null, a.userId, "ports_created");
  return getTicketAutomation(a);
}
export async function pairTicketPort(a: RequestAuthorization, p: Record<string, unknown>) {
  const port = await one<Port>(`SELECT p.* FROM ticket_execution_ports p JOIN workspace_members m ON m.id=p.member_id AND m.workspace_id=p.owner_id WHERE p.id=? AND p.owner_id=? AND m.user_id=? AND m.status='active'`, text(p.id, 80), a.ownerId, a.userId);
  if (!port || a.apiToken) fail("본인 포트만 연결할 수 있습니다.", 403);
  if(!JSON.parse(port.channel_ids_json).length)fail("먼저 포트의 고객 프로젝트를 선택해 주세요.");
  const context=await productContext(a.ownerId,port.product_id,port.repository_id);
  if(port.pairing_id)await run("DELETE FROM local_agent_pairings WHERE id=? AND workspace_id=? AND user_id=? AND claimed_at IS NULL",port.pairing_id,a.ownerId,a.userId);
  const pairing = await createLocalAgentPairing(a,{preserveExisting:true});
  await run("UPDATE ticket_execution_ports SET pairing_id=? WHERE id=? AND owner_id=?", pairing.id, port.id, a.ownerId);
  return { ...pairing, name: port.name,computerLabel:port.computer_label,product:context.product,repository:context.repository };
}
export async function pairOwnTicketPorts(a:RequestAuthorization,p:Record<string,unknown>={}) {
  if(a.apiToken||a.role==='viewer')fail("본인 포트만 연결할 수 있습니다.",403);
  const ports=await rows<Port>("SELECT p.* FROM ticket_execution_ports p JOIN workspace_members m ON m.id=p.member_id AND m.workspace_id=p.owner_id WHERE p.owner_id=? AND m.user_id=? AND m.status='active' AND p.device_id IS NULL AND p.enabled=1 AND json_array_length(p.channel_ids_json)>0 AND p.computer_label=? AND p.product_id IS NOT NULL ORDER BY p.name LIMIT 20",a.ownerId,a.userId,text(p.computerLabel,80));
  if(!ports.length)fail("연결 대기 중인 본인 포트가 없습니다.");
  const s=await settings(a.ownerId),slots=[];
  for(const port of ports){const pairing=await pairTicketPort(a,{id:port.id});slots.push({...pairing,channels:s?config(s).channels.filter(c=>JSON.parse(port.channel_ids_json).includes(c.id)).map(c=>c.name):[]});}
  return {slots};
}
export async function finishTicketPortPairing(deviceId: string) {
  await run(`UPDATE ticket_execution_ports SET device_id=? WHERE pairing_id IN (SELECT q.id FROM local_agent_pairings q JOIN local_agent_devices d ON d.id=q.device_id JOIN workspace_members m ON m.workspace_id=q.workspace_id AND m.user_id=q.user_id AND m.status='active' WHERE q.device_id=? AND q.claimed_at IS NOT NULL AND q.workspace_id=ticket_execution_ports.owner_id AND m.id=ticket_execution_ports.member_id)`, deviceId, deviceId);
}
export async function bindTicketPort(a: RequestAuthorization, p: Record<string, unknown>) {
  const port = await one<Port>("SELECT p.* FROM ticket_execution_ports p JOIN workspace_members m ON m.id=p.member_id AND m.workspace_id=p.owner_id WHERE p.id=? AND p.owner_id=? AND m.user_id=? AND m.status='active'", text(p.id, 80), a.ownerId, a.userId);
  if (!port || a.apiToken) fail("본인 포트만 변경할 수 있습니다.", 403);
  const deviceId = text(p.deviceId, 80);
  if (deviceId && !await one("SELECT id FROM local_agent_devices WHERE id=? AND workspace_id=? AND user_id=? AND revoked_at IS NULL", deviceId, a.ownerId, a.userId)) fail("본인의 연결된 컴퓨터를 선택해 주세요.");
  const model = text(p.model, 128);
  if(port.device_id&&deviceId!==port.device_id&&await one("SELECT id FROM local_agent_jobs WHERE device_id=? AND workspace_id=? AND status IN ('queued','running')",port.device_id,a.ownerId))fail("대기·실행 중인 작업을 먼저 정리한 뒤 연결을 해제해 주세요.",409);
  const productId=p.productId===undefined?port.product_id:text(p.productId,80),repositoryId=p.repositoryId===undefined?port.repository_id:text(p.repositoryId,80),computerLabel=p.computerLabel===undefined?port.computer_label:text(p.computerLabel,80);
  if(productId||repositoryId)await productContext(a.ownerId,productId,repositoryId);
  if(port.device_id&&(productId!==port.product_id||repositoryId!==port.repository_id||computerLabel!==port.computer_label))fail("제품·저장소·PC를 변경하려면 포트 연결을 먼저 해제해 주세요.");
  if (model && !JSON.parse(port.models_json).includes(model)) fail("이 포트에서 지원하는 모델을 선택해 주세요.");
  const s = await settings(a.ownerId), channels = p.channelIds === undefined ? JSON.parse(port.channel_ids_json) as string[] : Array.isArray(p.channelIds) ? p.channelIds.filter((id): id is string => typeof id === "string") : [];
  if (channels.length > 200 || channels.some(id => !s || !config(s).channels.some(c=>c.id===id&&c.enabled))) fail("연결된 고객 채널을 선택해 주세요.");
  await run("UPDATE ticket_execution_ports SET device_id=?,enabled=?,model=?,channel_ids_json=?,computer_label=?,product_id=?,repository_id=? WHERE id=? AND owner_id=?", deviceId || null, p.enabled === false ? 0 : 1, model, JSON.stringify(channels),computerLabel,productId||null,repositoryId, port.id, a.ownerId);
  return getTicketAutomation(a);
}
async function readSource(owner: string, channel: string, ts: string, user: string) {
  const connection = await getSlackConnection(owner);
  if (!connection) fail("Slack 연결을 확인해 주세요.");
  const token = await slackTokenForConnection(connection);
  const thread = await readSlackThread(token, { channel, channelType: "channel", user, text: "", ts, threadTs: ts }, undefined, { full: true, includeCanvas:false });
  if (thread.truncated) fail("전체 스레드를 읽지 못해 승인을 중지했습니다.");
  const s=await settings(owner),rule=s?config(s).channels.find(c=>c.id===channel):undefined;
  const messages = thread.messages.filter(m => m.user !== connection.botUserId);
  const evidenceMessages=messages.flatMap(m=>{
    if(!m.botId)return [{ts:m.ts,user:m.user,text:m.text}];
    if(!rule?.relayUserIds?.includes(m.user))return [];
    let body=m.text;if(rule.relayPrefix&&!body.trim().replace(/^\*+/,'').startsWith(rule.relayPrefix))return [];
    if(rule.relayContentStart){const start=body.indexOf(rule.relayContentStart);if(start<0)return [];body=body.slice(start+rule.relayContentStart.length).replace(/^[\s*_：:]+/u,'');}
    if(rule.relayContentEnd){const end=body.indexOf(rule.relayContentEnd);if(end<0)return [];body=body.slice(0,end).trim();}
    return body?[{ts:m.ts,user:m.user,text:body}]:[];
  });
  const evidence=evidenceMessages.map(m=>m.text);
  const raw = evidence.join("\n\n---\n\n"),safe=redactTicketText(raw).replace(/(?<!\d)(?:\+82[- ]?1[016789]|01[016789])[- ]?\d{3,4}[- ]?\d{4}(?!\d)/g,'[연락처 삭제]');
  const hasAttachments=Boolean(thread.attachmentsPresent||thread.imageFiles?.length||thread.canvasCandidateCount);
  return { connection, token, raw,safe,evidenceMessages:evidenceMessages.map(m=>({...m,text:redactTicketText(m.text).replace(/(?<!\d)(?:\+82[- ]?1[016789]|01[016789])[- ]?\d{3,4}[- ]?\d{4}(?!\d)/g,'[연락처 삭제]')})), requester: messages[0]?.user || user, hasAttachments, hash: await digest(JSON.stringify({messages:messages.map(m => ({ user: m.user, ts: m.ts, text: m.text })),hasAttachments,evidence})) };
}
export type TicketIntakeEvent={channel:string;ts:string;user:string;text:string;threadTs?:string;hasAttachments?:boolean;isRelay?:boolean;recovery?:boolean;forceReview?:boolean};
export type TicketIntakeOutcome={state:'analyzed'|'no_work'|'existing'|'ignored';requestIds:string[];reason?:string};
export async function intakeTicketEvent(connection:{ownerId:string;teamId:string;botUserId:string},event:TicketIntakeEvent){return (await analyzeTicketEvent(connection,event)).state!=='ignored';}
export async function analyzeTicketEvent(connection: { ownerId: string; teamId: string; botUserId: string }, event: TicketIntakeEvent):Promise<TicketIntakeOutcome> {
  const s = await settings(connection.ownerId);
  const ignored:TicketIntakeOutcome={state:'ignored',requestIds:[]};
  if (!s?.enabled || s.team_id !== connection.teamId) return ignored;
  const c = config(s);
  if(event.channel===c.destination){
    if(event.isRelay)return ignored;
    const link=event.text.match(/https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([CG][A-Z0-9]+)\/p([0-9]{16,})/i);
    if(!link||!c.channels.some(r=>r.enabled&&r.id===link[1]))return ignored;
    const ts=`${link[2].slice(0,-6)}.${link[2].slice(-6)}`;
    return analyzeTicketEvent(connection,{...event,channel:link[1],ts,threadTs:undefined});
  }
  const rule = c.channels.find(r => r.id === event.channel && r.enabled);
  if (!rule) return ignored;
  if(event.isRelay&&(!rule.relayUserIds?.includes(event.user)||(rule.relayPrefix&&!event.text.trim().replace(/^\*+/,'').startsWith(rule.relayPrefix))))return ignored;
  const rootTs = event.threadTs || event.ts;
  const represented=await rows<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE owner_id=? AND source_channel=? AND source_ts=? AND source_event_ts=?",s.owner_id,event.channel,rootTs,event.ts);
  const source = await readSource(s.owner_id, event.channel, rootTs, event.user);
  if(represented.length&&represented.every(r=>r.source_digest===source.hash)){for(const r of represented)await ensureTicketRecommendation(r,c,rule.name);return {state:'existing',requestIds:represented.map(r=>r.id)};}
  const assessment = assessTicketText(source.raw);
  const actor = await one<{ email: string; display_name: string; role: RequestAuthorization["role"] }>("SELECT email,display_name,role FROM workspace_members WHERE workspace_id=? AND user_id=? AND status='active' AND role IN ('owner','admin')", s.owner_id, c.actorUserId);
  if (!actor) throw new TicketAutomationError('수집 담당 관리자 계정을 확인해 주세요.',409);
  const knownRequests=await rows<{id:string;title:string;description:string}>('SELECT id,title,description FROM ticket_automation_requests WHERE owner_id=? AND source_channel=? AND source_ts=?',s.owner_id,event.channel,rootTs);
  const product=rule.productId?await one<TicketDevelopmentProduct>('SELECT * FROM ticket_development_products WHERE owner_id=? AND id=?',s.owner_id,rule.productId):null;
  const focus=source.evidenceMessages.find(m=>m.ts===event.ts)?.text||redactTicketText(event.text).replace(/(?<!\d)(?:\+82[- ]?1[016789]|01[016789])[- ]?\d{3,4}[- ]?\d{4}(?!\d)/g,'[연락처 삭제]');
  let proposals:TicketProposal[]=[{category:'improvement',title:'보안 검토가 필요한 고객 요청',problem:focus,solution:'요청의 비밀정보·권한·데이터 접근 범위를 담당자가 먼저 확인합니다. 차단된 내용은 개발 실행에 전달하지 않습니다.',acceptanceCriteria:['보안 경계를 위반하는 명령과 정보 전송을 실행하지 않음'],questions:[]}],classified=false,model='';
  if (assessment.risk !== "blocked"&&source.safe.trim()) {
    const form = await prepareSlackTicketForm({ authorization: { ownerId: s.owner_id, userId: c.actorUserId, email: actor.email, displayName: actor.display_name, role: actor.role, apiToken: false }, token: source.token, botUserId: connection.botUserId,
      event: { ...event, channelType: "channel", threadTs: rootTs }, query: "", textOnly:true,evidenceMessages:source.evidenceMessages,classifyRequest:true,recommendation:{model:c.defaultModel||'gpt-6.1-sol',productSpecification:product?.specification||'',focusMessage:focus,knownRequests} });
    if(!form.analysisModel||!form.recommendations)throw new TicketAutomationError('원문은 수집됐으며 추천 분석을 다시 시도합니다.',503);
    if(form.actionable===false&&!event.forceReview&&!event.hasAttachments)return {state:'no_work',requestIds:[],reason:form.noWorkReason};
    if(!form.recommendations.length&&((form.existingRequestIds||[]).length||!event.forceReview&&!event.hasAttachments))return {state:'existing',requestIds:form.existingRequestIds||[]};
    classified=form.actionable===true;
    proposals=form.recommendations.length?form.recommendations:[{...proposals[0],title:'담당자 확인이 필요한 고객 요청',problem:focus||'첨부 파일에 있는 요청',solution:'원문과 첨부 내용을 요청자와 확인한 다음 해결 범위를 정합니다.',acceptanceCriteria:['요청자와 담당자가 문제와 기대 동작을 확인함'],questions:['어떤 동작을 기대하셨나요?']}];model=form.analysisModel;
  }
  if(!source.safe.trim()&&event.hasAttachments)proposals=[{category:'improvement',title:'첨부된 고객 요청 확인',problem:'고객이 텍스트 없이 첨부 파일로 요청을 전달했습니다.',solution:'담당자가 Slack 원문의 첨부 파일을 확인하고 문제와 기대 동작을 요청자에게 확인합니다.',acceptanceCriteria:['첨부 원문을 확인하고 해결할 문제와 범위를 기록함'],questions:['첨부 내용에서 어떤 동작을 원하시나요?']}];
  const statements:ReturnType<typeof env.DB.prepare>[]=[],plans:{id:string;index:number;auto:boolean}[]=[];
  for(const proposal of proposals){
  const title=redactTicketText(proposal.title).slice(0,240),description=redactTicketText(ticketProposalDescription(proposal)).slice(0,4000);
  const derived = assessTicketText(`${title}\n${description}`);
  const risk = assessment.risk === "blocked" || derived.risk === "blocked" ? "blocked" : assessment.risk;
  const autoPort = rule.autoApprove === "low_risk" && risk === "low" ? await chooseTicketPort(s.owner_id, rule.memberId, rule.portId || null, event.channel,rule.productId||null,rule.repositoryId||'') : null;
  const selectedPortId = rule.portId || null,eligibilityPortId=rule.portId||autoPort?.id||null;
  const id = crypto.randomUUID(), time = now();
  const requester = await slackApi<{ ok:boolean; user?: {is_bot?:boolean;deleted?:boolean;real_name?: string; profile?: { display_name?: string } } }>(source.token,"users.info",{user:source.requester}).catch(()=>null);
  const requesterId=requester?.user?.is_bot||requester?.user?.deleted?'':source.requester;
  const requesterName = requesterId?(requester?.user?.profile?.display_name || requester?.user?.real_name || source.requester):'';
  const issueKey=await digest(`${proposal.category}\n${title}\n${proposal.problem}`);
  plans.push({id,index:statements.length,auto:proposal.category!=='guidance'&&!event.recovery&&!event.forceReview&&classified&&canAutoApproveTicket({mode:rule.autoApprove,risk,memberId:rule.memberId,portId:eligibilityPortId,hasAttachments:event.hasAttachments||source.hasAttachments})});
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO ticket_automation_requests(id,owner_id,team_id,source_channel,source_ts,source_event_ts,issue_key,category,analysis_json,source_user,requester_slack_user,requester_name,source_digest,source_text,title,description,risk,reasons_json,state,member_id,port_id,created_at,updated_at,product_id,repository_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, s.owner_id, s.team_id, event.channel, rootTs,event.ts,issueKey,proposal.category,JSON.stringify({model,proposal:JSON.parse(redactTicketText(JSON.stringify(proposal))),original:focus}), event.user, requesterId, requesterName, source.hash, source.safe, title, description, risk, JSON.stringify([...assessment.reasons, ...derived.reasons]), risk === "blocked" ? "blocked" : "recommended", rule.memberId || null, selectedPortId, time, time,rule.productId||null,rule.repositoryId||''));
  statements.push(env.DB.prepare("INSERT INTO ticket_automation_audit(id,owner_id,request_id,actor_user_id,action,revision,details_json,created_at) SELECT ?,owner_id,id,'slack','intake_validated',1,?,? FROM ticket_automation_requests WHERE id=? AND owner_id=?").bind(crypto.randomUUID(),JSON.stringify({risk,sourceDigest:source.hash}),time,id,s.owner_id));
  const r={id,owner_id:s.owner_id,state:risk==='blocked'?'blocked' as const:'recommended' as const,revision:1,category:proposal.category};
  statements.push(ticketMessageStatement(r,'source',c.destination,null,`#${rule.name} 고객 원문 · ${TICKET_CATEGORY_LABELS[proposal.category]}\n${focus}\n\n${sourceLink({source_channel:event.channel,source_ts:event.ts})}`));
  statements.push(ticketMessageStatement(r,'recommendation',c.destination,null,`[${TICKET_CATEGORY_LABELS[proposal.category]}] ${escapeSlackText(title)}\n\n${escapeSlackText(description)}\n\n추천 모델: ${model||(risk==='blocked'?'보안 정책':'담당자 검토')}`));
  }
  const results=await env.DB.batch(statements),inserted=plans.filter(p=>results[p.index]?.meta.changes),requestIds=inserted.map(p=>p.id);
  for(const {id,auto}of inserted)if(auto){
    const a: RequestAuthorization = { ownerId: s.owner_id, userId: c.actorUserId, email: actor.email, displayName: actor.display_name, role: actor.role, apiToken: false };
    try { await changeTicketRequest(a, { id, action: "create", revision: 1 }); await changeTicketRequest(a, { id, action: "approve", revision: 2, automatic: true }); }
    catch { /* Visible created/recommended state stays in the review queue. */ }
  }
  return {state:'analyzed',requestIds};
}
async function ensureTicketRecommendation(r:TicketAutomationRequest,c:TicketAutomationConfig,channelName:string){
  const analysis=JSON.parse(r.analysis_json||'{}');
  await queueTicketMessage(r.owner_id,r.id,'source',c.destination,null,`#${channelName} 고객 원문 · ${TICKET_CATEGORY_LABELS[r.category]}\n${analysis.original||r.source_text}\n\n${sourceLink({source_channel:r.source_channel,source_ts:r.source_event_ts||r.source_ts})}`);
  await queueTicketMessage(r.owner_id,r.id,'recommendation',c.destination,null,`[${TICKET_CATEGORY_LABELS[r.category]}] ${escapeSlackText(r.title)}\n\n${escapeSlackText(r.description)}\n\n추천 모델: ${analysis.model||'보안 정책'}`);
}
async function requestFor(a: RequestAuthorization, id: string) {
  const r = await one<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE id=? AND owner_id=?", id, a.ownerId);
  if (!r) fail("티켓 요청을 찾을 수 없습니다.", 404);
  if (a.apiToken || a.role === "viewer") fail("변경 권한이 없습니다.", 403);
  const member = await one<{ id: string }>("SELECT id FROM workspace_members WHERE workspace_id=? AND user_id=? AND status='active'", a.ownerId, a.userId);
  if (!canManageTeam(a) && member?.id !== r.member_id) fail("담당자 또는 관리자만 변경할 수 있습니다.", 403);
  return r;
}
export async function ticketRequestFor(a:RequestAuthorization,id:string){return requestFor(a,id);}
export async function verifiedTicketRequester(owner:string,team:string,channel:string,userId:string){
  const connection=await getSlackConnection(owner);if(!connection||connection.teamId!==team)fail('Slack 연결을 확인해 주세요.');
  const token=await slackTokenForConnection(connection),members=await requesterChannelMembers(token,channel);
  if(!/^[UW][A-Z0-9]+$/.test(userId)||!members.has(userId))fail('원문 고객 채널의 요청자를 선택해 주세요.');
  const profile=await slackApi<{ok:boolean;user?:{is_bot?:boolean;deleted?:boolean;real_name?:string;profile?:{display_name?:string}}}>(token,'users.info',{user:userId});
  if(!profile.user||profile.user.is_bot||profile.user.deleted)fail('활성 Slack 사용자를 선택해 주세요.');
  return {id:userId,name:profile.user.profile?.display_name||profile.user.real_name||userId};
}
async function requesterChannelMembers(token:string, channel:string) {
  const ids = new Set<string>(); let cursor = "";
  for(let page=0;page<10;page++) {
    const result = await slackApi<{ok:boolean;members?:string[];response_metadata?:{next_cursor?:string}}>(token,"conversations.members",{channel,limit:200,cursor:cursor||undefined});
    for(const id of result.members??[])ids.add(id);
    cursor=result.response_metadata?.next_cursor||"";if(!cursor)return ids;
  }
  fail("채널 멤버가 너무 많습니다. Slack 원문에서 요청자를 확인해 주세요.");
}
export async function ticketRequesterOptions(a:RequestAuthorization,id:string,query:string) {
  const r=await requestFor(a,id),connection=await getSlackConnection(a.ownerId);if(!connection||connection.teamId!==r.team_id)fail("Slack 연결을 확인해 주세요.");
  const token=await slackTokenForConnection(connection),ids=await requesterChannelMembers(token,r.source_channel),users:Array<{id:string;name:string}>=[];
  const q=query.normalize("NFKC").toLocaleLowerCase();let cursor="";
  for(let page=0;page<20;page++) {
    const result=await slackApi<{ok:boolean;members?:Array<{id:string;is_bot?:boolean;deleted?:boolean;real_name?:string;profile?:{display_name?:string}}> ;response_metadata?:{next_cursor?:string}}>(token,"users.list",{limit:200,cursor:cursor||undefined});
    for(const u of result.members??[]) {const name=u.profile?.display_name||u.real_name||u.id;if(ids.has(u.id)&&!u.is_bot&&!u.deleted&&(!q||`${name} ${u.id}`.normalize("NFKC").toLocaleLowerCase().includes(q)))users.push({id:u.id,name});}
    cursor=result.response_metadata?.next_cursor||"";if(!cursor||users.length>=40)break;
  }
  if(!users.some(u=>u.id===r.requester_slack_user)&&ids.has(r.requester_slack_user))users.unshift({id:r.requester_slack_user,name:r.requester_name||r.requester_slack_user});
  return {users:users.slice(0,40)};
}
export async function changeTicketRequest(a: RequestAuthorization, p: Record<string, unknown>) {
  const r = await requestFor(a, text(p.id, 80)), action = text(p.action, 30), time = now();
  if (Number(p.revision) !== r.revision) fail("내용이 변경되었습니다. 새로고침 후 확인해 주세요.", 409);
  if(action==='stop') {
    if(!['queued','running','waiting_answer'].includes(r.state))fail("진행 중인 요청만 중지할 수 있습니다.",409);
    const result=await env.DB.batch([
      env.DB.prepare("UPDATE local_agent_jobs SET status='cancelled',error_text='operator_stopped',updated_at=? WHERE id=? AND workspace_id=? AND status IN ('queued','running') AND EXISTS(SELECT 1 FROM ticket_automation_requests WHERE id=? AND revision=?)").bind(time,r.job_id,r.owner_id,r.id,r.revision),
      env.DB.prepare("UPDATE ticket_automation_requests SET state='failed',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state IN ('queued','running','waiting_answer')").bind(time,r.id,r.owner_id,r.revision),
      env.DB.prepare("UPDATE ticket_automation_outbox SET state='cancelled',updated_at=? WHERE request_id=? AND owner_id=? AND state='pending' AND kind<>'recommendation'").bind(time,r.id,r.owner_id),
    ]);if(!result[1].meta.changes)fail("동시에 변경되었습니다.",409);
    const s=await settings(r.owner_id);if(s)await queueTicketMessage(r.owner_id,r.id,`stopped:${r.revision}`,config(s).destination,await managementThread(r.id),`담당자가 작업을 중지했습니다. · ${escapeSlackText(r.title)}`);
  } else if(action==='release_confirm') {
    if(!['review','published'].includes(r.state))fail("개발 완료 후 실제 배포·병합 결과를 확인해 주세요.");
    if(r.release_commit)fail("이미 반영 확인된 티켓입니다.",409);
    const commit=text(p.commit,64);if(!/^[a-f0-9]{40,64}$/.test(commit)||p.acknowledged!==true)fail("직접 확인한 Git 커밋과 배포·병합 확인이 필요합니다.");
    if((await unresolvedDependencies(r)).length)fail("선행 티켓의 반영을 먼저 확인해 주세요.",409);
    const ready=(await repositoryRequests(r)).filter(v=>['review','published'].includes(v.state)&&!v.release_commit);
    for(const other of ready)if(ticketPriorityRank(other.priority)<ticketPriorityRank(r.priority)&&!(await unresolvedDependencies(other)).length)fail("같은 저장소의 우선순위가 높은 티켓을 먼저 반영해 주세요.",409);
    await updateTicketRevision("UPDATE ticket_automation_requests SET release_commit=?,release_confirmed_by=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?",commit,a.userId,time,r.id,a.ownerId,r.revision);
  } else if(action==='reassign') {
    if(r.state!=='queued')fail("실행 대기 중인 티켓만 다시 배정할 수 있습니다.",409);
    const job=await one("SELECT id FROM local_agent_jobs WHERE id=? AND workspace_id=? AND status='queued'",r.job_id,r.owner_id);if(!job)fail("이미 실행 중입니다.",409);
    const result=await env.DB.batch([
      env.DB.prepare("UPDATE ticket_automation_requests SET state='created',job_id=NULL,security_json='{}',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND EXISTS(SELECT 1 FROM local_agent_jobs WHERE id=? AND status='queued')").bind(time,r.id,r.owner_id,r.revision,r.job_id),
      env.DB.prepare("UPDATE local_agent_jobs SET status='cancelled',updated_at=? WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM ticket_automation_requests WHERE id=? AND revision=? AND job_id IS NULL)").bind(time,r.job_id,r.id,r.revision+1),
    ]);if(!result[0].meta.changes)fail("동시에 변경되었습니다.",409);
  } else if(action === "refresh_source") {
    if(!["recommended","created","security_review","blocked","failed"].includes(r.state)||await one("SELECT id FROM local_agent_jobs WHERE id=? AND status IN ('queued','running')",r.job_id))fail("실행 중인 요청은 원문을 다시 분석할 수 없습니다.",409);
    const source=await readSource(r.owner_id,r.source_channel,r.source_ts,r.source_user),assessment=assessTicketText(source.raw);
    let title=source.safe.split('\n')[0].slice(0,240)||r.title,description=source.safe.slice(0,4000),category=r.category,analysis=JSON.parse(r.analysis_json||'{}');
    if(assessment.risk!=='blocked') {
      const s=await settings(r.owner_id),product=r.product_id?await one<TicketDevelopmentProduct>('SELECT * FROM ticket_development_products WHERE id=? AND owner_id=?',r.product_id,r.owner_id):null;
      const focus=source.evidenceMessages.find(m=>m.ts===(r.source_event_ts||r.source_ts))?.text||source.safe;
      const form=await prepareSlackTicketForm({authorization:a,token:source.token,botUserId:source.connection.botUserId,event:{channel:r.source_channel,ts:r.source_ts,threadTs:r.source_ts,user:r.source_user,text:'',channelType:'channel'},query:'',textOnly:true,evidenceMessages:source.evidenceMessages,recommendation:{model:s?config(s).defaultModel||'gpt-6.1-sol':'gpt-6.1-sol',productSpecification:product?.specification||'',focusMessage:`현재 다시 검토할 티켓: ${r.title}\n이 티켓의 범위 한 건만 구체화합니다.\n${focus}`,knownRequests:[]}});
      if(!form.analysisModel||!form.recommendations?.length)fail('추천을 다시 분석하지 못했습니다. 원문은 유지됩니다. 잠시 후 다시 시도해 주세요.',503);
      if(form.recommendations.length!==1)fail('독립 요청이 여러 개입니다. 수집 점검에서 원문을 요청으로 다시 검토해 주세요.',409);
      const proposal=form.recommendations[0];title=redactTicketText(proposal.title).slice(0,240);description=redactTicketText(ticketProposalDescription(proposal));category=proposal.category;analysis={model:form.analysisModel,proposal:JSON.parse(redactTicketText(JSON.stringify(proposal))),original:focus};
    }
    const derived=assessTicketText(`${title}\n${description}`),risk=assessment.risk==='blocked'||derived.risk==='blocked'?'blocked':assessment.risk;
    const results=await env.DB.batch([
      env.DB.prepare("UPDATE items SET title=?,description=?,status='todo',updated_at=? WHERE owner_id=? AND id IN (?,?) AND source='slack_ticket' AND source_ref=? AND EXISTS(SELECT 1 FROM ticket_automation_requests WHERE id=? AND owner_id=? AND revision=?)").bind(title,description,time,a.ownerId,r.ticket_id,r.task_id,r.id,r.id,a.ownerId,r.revision),
      env.DB.prepare("UPDATE ticket_automation_requests SET category=?,analysis_json=?,source_digest=?,source_text=?,title=?,description=?,risk=?,reasons_json=?,state=?,job_id=NULL,answer='',question='',security_json='{}',approved_at=NULL,approved_by=NULL,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?").bind(category,JSON.stringify(analysis),source.hash,source.safe,title,description,risk,JSON.stringify([...assessment.reasons,...derived.reasons]),risk==='blocked'?'blocked':r.ticket_id?'created':'recommended',time,r.id,a.ownerId,r.revision),
    ]);if(!results[1].meta.changes)fail("동시에 변경되었습니다.",409);
  } else if (action === "requester") {
    if(!["recommended","created","review"].includes(r.state))fail("개발 전 또는 완료 안내 검토 중에 요청자를 변경해 주세요.");
    const userId=text(p.requesterSlackUser,80),connection=await getSlackConnection(a.ownerId);if(!connection||connection.teamId!==r.team_id)fail("Slack 연결을 확인해 주세요.");
    const token=await slackTokenForConnection(connection),members=await requesterChannelMembers(token,r.source_channel);
    if(!/^[UW][A-Z0-9]+$/.test(userId)||!members.has(userId))fail("원문 고객 채널의 요청자를 선택해 주세요.");
    const profile=await slackApi<{ok:boolean;user?:{is_bot?:boolean;deleted?:boolean;real_name?:string;profile?:{display_name?:string}}}>(token,"users.info",{user:userId});
    if(!profile.user||profile.user.is_bot||profile.user.deleted)fail("활성 Slack 사용자를 선택해 주세요.");
    await updateTicketRevision("UPDATE ticket_automation_requests SET requester_slack_user=?,requester_name=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?",userId,profile.user.profile?.display_name||profile.user.real_name||userId,time,r.id,a.ownerId,r.revision);
  } else if(action==='review_notice'){
    if(r.state!=='review')fail('완료 안내 검토 중에 수정해 주세요.',409);
    const notice=text(p.notice,4000);if(!notice)fail('고객에게 보낼 안내문을 입력해 주세요.');
    const requester=p.requesterSlackUser===undefined?{id:r.requester_slack_user,name:r.requester_name}:await verifiedTicketRequester(a.ownerId,r.team_id,r.source_channel,text(p.requesterSlackUser,80));
    await updateTicketRevision('UPDATE ticket_automation_requests SET notice=?,requester_slack_user=?,requester_name=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?',redactTicketText(notice),requester.id,requester.name,time,r.id,a.ownerId,r.revision);
  } else if (action === "edit") {
    if (!["recommended", "created"].includes(r.state)) fail("개발 전 요청만 수정할 수 있습니다.", 409);
    const title = text(p.title, 240), description = text(p.description, 4000), memberId = text(p.memberId, 80), portId = text(p.portId, 80);
    const category=p.category===undefined?r.category:p.category as TicketCategory;
    if(!TICKET_CATEGORIES.includes(category))fail('티켓 분류를 선택해 주세요.');
    const requester=p.requesterSlackUser===undefined?{id:r.requester_slack_user,name:r.requester_name}:await verifiedTicketRequester(a.ownerId,r.team_id,r.source_channel,text(p.requesterSlackUser,80));
    const productId=p.productId===undefined?r.product_id:text(p.productId,80)||null,repositoryId=p.repositoryId===undefined?r.repository_id:text(p.repositoryId,80),priority=TICKET_PRIORITIES.includes(p.priority as TicketPriority)?p.priority as TicketPriority:r.priority;
    if(productId||repositoryId)await productContext(a.ownerId,productId,repositoryId);
    const dependencies=await validateDependencies(a.ownerId,r.id,p.dependencies===undefined?JSON.parse(r.dependencies_json):p.dependencies,productId,repositoryId);
    if (!title) fail("제목을 입력해 주세요.");
    if (memberId && !await one("SELECT id FROM workspace_members WHERE id=? AND workspace_id=? AND status='active'", memberId, a.ownerId)) fail("활성 담당자를 선택해 주세요.");
    if (portId && !await one("SELECT id FROM ticket_execution_ports WHERE id=? AND owner_id=? AND member_id=? AND enabled=1", portId, a.ownerId, memberId)) fail("담당자의 포트를 선택해 주세요.");
    const risk = assessTicketText(`${r.source_text}\n${title}\n${description}`);
    const results=await env.DB.batch([
      env.DB.prepare("UPDATE items SET title=?,description=?,priority=?,updated_at=? WHERE owner_id=? AND id IN (?,?) AND EXISTS(SELECT 1 FROM ticket_automation_requests WHERE id=? AND owner_id=? AND revision=?)").bind(redactTicketText(title),redactTicketText(description),priority,time,a.ownerId,r.ticket_id,r.task_id,r.id,a.ownerId,r.revision),
      env.DB.prepare("DELETE FROM item_assignments WHERE owner_id=? AND item_id=? AND role='task_assignee' AND EXISTS(SELECT 1 FROM ticket_automation_requests WHERE id=? AND owner_id=? AND revision=?)").bind(a.ownerId,r.task_id,r.id,a.ownerId,r.revision),
      env.DB.prepare("INSERT INTO item_assignments(id,owner_id,item_id,member_id,role,created_at,updated_at) SELECT ?,owner_id,task_id,?,'task_assignee',?,? FROM ticket_automation_requests WHERE id=? AND owner_id=? AND revision=? AND task_id IS NOT NULL AND ?<>''").bind(crypto.randomUUID(),memberId,time,time,r.id,a.ownerId,r.revision,memberId),
      env.DB.prepare("UPDATE ticket_automation_requests SET category=?,requester_slack_user=?,requester_name=?,title=?,description=?,member_id=?,port_id=?,risk=?,reasons_json=?,state=?,product_id=?,repository_id=?,priority=?,dependencies_json=?,security_json='{}',revision=revision+1,approved_at=NULL,approved_by=NULL,updated_at=? WHERE id=? AND owner_id=? AND revision=?").bind(category,requester.id,requester.name,redactTicketText(title),redactTicketText(description),memberId||null,portId||null,risk.risk,JSON.stringify(risk.reasons),risk.risk==='blocked'?'blocked':r.state,productId||null,repositoryId,priority,JSON.stringify(dependencies),time,r.id,a.ownerId,r.revision),
    ]);
    if(!results[3].meta.changes)fail("동시에 변경되었습니다.",409);
  } else if (action === "create") {
    if (r.state !== "recommended" || r.risk === "blocked") fail("생성할 수 없는 요청입니다.", 409);
    const ticketId = crypto.randomUUID(), taskId = crypto.randomUUID();
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO items(id,owner_id,kind,title,description,priority,status,source,source_ref,created_by_user_id,created_at,updated_at) SELECT ?,owner_id,'ticket',title,description,priority,'todo','slack_ticket',id,?,?,? FROM ticket_automation_requests WHERE id=? AND owner_id=? AND revision=? AND state='recommended' AND risk<>'blocked'`).bind(ticketId, a.userId, time, time, r.id, a.ownerId, r.revision),
      env.DB.prepare(`INSERT INTO items(id,owner_id,parent_id,kind,title,description,priority,status,source,source_ref,created_by_user_id,created_at,updated_at) SELECT ?,owner_id,?,'task',title,description,priority,'todo','slack_ticket',id,?,?,? FROM ticket_automation_requests WHERE id=? AND owner_id=? AND revision=? AND state='recommended' AND risk<>'blocked'`).bind(taskId, ticketId, a.userId, time, time, r.id, a.ownerId, r.revision),
      env.DB.prepare("UPDATE ticket_automation_requests SET state='created',ticket_id=?,task_id=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state='recommended' AND risk<>'blocked'").bind(ticketId, taskId, time, r.id, a.ownerId, r.revision),
      env.DB.prepare(`INSERT INTO item_assignments(id,owner_id,item_id,member_id,role,created_at,updated_at) SELECT ?,owner_id,task_id,member_id,'task_assignee',?,? FROM ticket_automation_requests WHERE id=? AND owner_id=? AND ticket_id=? AND task_id=? AND member_id IS NOT NULL AND revision=?`).bind(crypto.randomUUID(),time,time,r.id,a.ownerId,ticketId,taskId,r.revision+1),
    ]);
    if (!results[2].meta.changes) fail("이미 생성되었거나 변경되었습니다.", 409);
  } else if (action === "approve" || action === "force") {
    const force = action === "force", previousSecurity = JSON.parse(r.security_json || "{}");
    const overrideReason = force ? text(p.reason,500) : "";
    if ((force ? r.state !== "security_review" || previousSecurity.verdict !== "warning" : r.state !== "created") || r.risk === "blocked") fail("검토 후 생성된 티켓만 승인할 수 있습니다.", 409);
    if(force && (p.acknowledged!==true || overrideReason.length<5 || redactTicketText(overrideReason)!==overrideReason))fail("경고를 확인하고 비밀정보 없이 사유를 5자 이상 남겨 주세요.");
    const s = await settings(a.ownerId); if (!s?.enabled) fail("티켓 자동화를 먼저 켜 주세요.");
    if (!config(s).channels.some(c => c.id === r.source_channel && c.enabled)) fail("고객 채널 연결을 확인해 주세요.");
    const source = await readSource(a.ownerId, r.source_channel, r.source_ts, r.source_user);
    if (source.hash !== r.source_digest || assessTicketText(source.raw).risk === "blocked") {
      await updateTicketRevision("UPDATE ticket_automation_requests SET state='blocked',risk='blocked',reasons_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?", JSON.stringify(["원문 변경 또는 보안 검증 실패: 원문을 확인하고 새 요청으로 검토해 주세요."]), time, r.id, a.ownerId, r.revision);
      fail("원문이 변경되었거나 보안 검증을 통과하지 못했습니다.", 409);
    }
    if (assessTicketText(`${r.source_text}\n${r.title}\n${r.description}\n${r.answer}`).risk === "blocked") fail("보안 검증을 통과하지 못했습니다.", 403);
    if(r.category==='guidance'){
      if(!r.member_id)fail('안내문을 검토할 담당자를 먼저 지정해 주세요.');
      const notice=(r.description.split('안내 초안\n')[1]?.split('\n\n완료 확인 기준')[0]||r.description).trim();
      await updateTicketRevision("UPDATE ticket_automation_requests SET state='review',notice=?,revision=revision+1,approved_by=?,approved_at=?,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state='created'",redactTicketText(notice).slice(0,4000),a.userId,time,time,r.id,a.ownerId,r.revision);
      await audit(a.ownerId,r.id,a.userId,'guidance_prepared',r.revision);
      await queueTicketUpdate(a,r.id,'updated');
      return getTicketAutomation(a);
    }
    const product=await productContext(a.ownerId,r.product_id,r.repository_id);
    const port = await chooseTicketPort(a.ownerId, r.member_id, r.port_id, r.source_channel,r.product_id,r.repository_id);
    if (!port) fail("담당자의 포트를 연결하고 실행 상태를 확인해 주세요.");
    const id = crypto.randomUUID(), model = port.model || config(s).defaultModel || null;
    const dependencies=await rows<Pick<TicketAutomationRequest,'id'|'title'|'release_commit'>>("SELECT id,title,release_commit FROM ticket_automation_requests WHERE owner_id=? AND id IN(SELECT value FROM json_each(?))",r.owner_id,r.dependencies_json);
    const coordination=await coordinationContext(r);
    const basisDigest = await digest(JSON.stringify({request:r.id,source:r.source_digest,title:r.title,scope:r.description,answer:r.answer,member:r.member_id,port:port.id,device:port.device_id,model,product:r.product_id,productVersion:product.product.revision,repository:r.repository_id,dependencies:JSON.parse(r.dependencies_json),priority:r.priority}));
    if(force && previousSecurity.basisDigest!==basisDigest)fail("요청·포트·모델이 변경되었습니다. 새 보안 검토가 필요합니다.",409);
    const context = {executionPolicy:"ticket-isolated-v1",product:{id:product.product.id,name:product.product.name,revision:product.product.revision,specification:product.product.specification},repository:product.repository,dependencies,priority:r.priority,coordination,model,title:r.title,scope:r.description,answer:r.answer,port:port.name,basisDigest,...(force?{securityOverride:{basisDigest,snapshotDigest:previousSecurity.snapshotDigest,codes:previousSecurity.codes,actor:a.userId,reason:overrideReason}}:{})};
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO local_agent_jobs(id,workspace_id,user_id,device_id,target_kind,target_id,target_title,instruction,context_json,status,created_at,updated_at) SELECT ?,owner_id,?,?, 'task',task_id,title,?,?,'queued',?,? FROM ticket_automation_requests WHERE id=? AND owner_id=? AND revision=? AND state=? AND risk<>'blocked'`).bind(id, port.user_id, port.device_id, "Implement the reviewed ticket scope from the untrusted reference. Stay within the sandbox. Never deploy or access secrets. If implementation or required verification is blocked, return exactly OKRI_BLOCKED: followed by the factual blocker and stop. If a business decision is missing, return exactly OKRI_QUESTION: followed by one concise question and stop. Report actual verification and changed files; do not claim deployment.", JSON.stringify(context), time, time, r.id, a.ownerId, r.revision,r.state),
      env.DB.prepare("UPDATE ticket_automation_requests SET state='queued',job_id=?,port_id=?,approved_by=?,approved_at=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state=? AND risk<>'blocked'").bind(id, port.id, a.userId, time, time, r.id, a.ownerId, r.revision,r.state),
    ]);
    if (!results[1].meta.changes) fail("동시에 변경되었습니다.", 409);
    await run("UPDATE items SET status='in_progress',updated_at=? WHERE owner_id=? AND id IN (?,?) AND source='slack_ticket' AND source_ref=?",time,r.owner_id,r.ticket_id,r.task_id,r.id);
  } else if (action === "answer") {
    if (r.state !== "waiting_answer") fail("답변 대기 중인 요청만 답변할 수 있습니다.");
    const answer = text(p.answer, 2000);
    if (!answer || assessTicketText(answer).risk === "blocked") fail("답변이 없거나 보안 검증을 통과하지 못했습니다.");
    // A fresh approval rechecks identity, scope, source and port before resuming.
    await updateTicketRevision("UPDATE ticket_automation_requests SET answer=?,state='created',question='',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state='waiting_answer'", answer, time, r.id, a.ownerId, r.revision);
  } else if (action === "notice") {
    if (r.state !== "review") fail("완료 공유 대기 상태에서만 문안을 수정할 수 있습니다.");
    const notice = text(p.notice, 3000); if (!notice || redactTicketText(notice) !== notice || assessTicketText(notice).risk === "blocked") fail("안내 문안을 확인해 주세요.");
    await updateTicketRevision("UPDATE ticket_automation_requests SET notice=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state='review'", notice, time, r.id, a.ownerId, r.revision);
  } else if (action === "publish") {
    if (r.state !== "review" || !r.notice) fail("완료 안내 문안을 먼저 확인해 주세요.");
    const s = await settings(a.ownerId); if (!s?.enabled || !config(s).notificationsAuthorized) fail("Slack 발신 설정과 문안 승인을 먼저 확인해 주세요.");
    if(s.team_id!==r.team_id||!config(s).channels.some(c=>c.id===r.source_channel&&c.enabled)||(await getSlackConnection(a.ownerId))?.teamId!==r.team_id)fail("원문 Slack 워크스페이스와 고객 채널 연결을 확인해 주세요.");
    if (!/^[UW][A-Z0-9]+$/.test(r.requester_slack_user)) fail("완료 안내를 받을 Slack 요청자를 먼저 지정해 주세요.");
    const connection=await getSlackConnection(a.ownerId),token=await slackTokenForConnection(connection!);
    const recipient=await slackApi<{ok:boolean;user?:{is_bot?:boolean;deleted?:boolean}}>(token,'users.info',{user:r.requester_slack_user});
    if(!recipient.user||recipient.user.is_bot||recipient.user.deleted||!(await requesterChannelMembers(token,r.source_channel)).has(r.requester_slack_user))fail("원문 채널의 활성 Slack 요청자를 다시 지정해 주세요.");
    const body=`<@${r.requester_slack_user}>\n${escapeSlackText(r.notice)}`,outboxId=`${r.id}:completion:${r.revision}`;
    const result=await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO ticket_automation_outbox(id,owner_id,request_id,kind,channel_id,thread_ts,body_json,created_at,updated_at) SELECT ?,owner_id,id,?,source_channel,source_ts,?,?,? FROM ticket_automation_requests WHERE id=? AND owner_id=? AND revision=? AND state='review'").bind(outboxId,`completion:${r.revision}`,JSON.stringify({text:body,unfurl_links:false,unfurl_media:false}),time,time,r.id,a.ownerId,r.revision),
      env.DB.prepare("UPDATE ticket_automation_requests SET state='publishing',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state='review' AND EXISTS(SELECT 1 FROM ticket_automation_outbox WHERE id=? AND state='pending')").bind(time,r.id,a.ownerId,r.revision,outboxId),
    ]);if(!result[1].meta.changes)fail("동시에 변경되었습니다.",409);
  } else if(action==='cancel_publish') {
    if(r.state!=='publishing')fail("전송 대기 중인 안내만 취소할 수 있습니다.",409);
    const id=`${r.id}:completion:${r.revision-1}`;
    const result=await env.DB.batch([
      env.DB.prepare("UPDATE ticket_automation_requests SET state='review',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND EXISTS(SELECT 1 FROM ticket_automation_outbox WHERE id=? AND state='pending')").bind(time,r.id,a.ownerId,r.revision,id),
      env.DB.prepare("UPDATE ticket_automation_outbox SET state='cancelled',updated_at=? WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM ticket_automation_requests WHERE id=? AND revision=? AND state='review')").bind(time,id,r.id,r.revision+1),
    ]);if(!result[0].meta.changes)fail("이미 전송을 시작했거나 결과 확인이 필요합니다.",409);
  } else if (action === "dismiss") {
    if (!["recommended", "created", "security_review", "blocked", "failed"].includes(r.state)) fail("진행 중인 요청은 제외할 수 없습니다.");
    await updateTicketRevision("UPDATE ticket_automation_requests SET state='dismissed',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?", time, r.id, a.ownerId, r.revision);
  } else fail("지원하지 않는 작업입니다.");
  if (["edit", "create", "approve", "force", "answer", "notice", "refresh_source"].includes(action)) {
    const updated = await one<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE id=? AND owner_id=?", r.id, a.ownerId);
    const s = await settings(a.ownerId);
    if (updated && s) await queueTicketMessage(a.ownerId, r.id, `state:${updated.revision}`, config(s).destination, await managementThread(r.id), `${escapeSlackText(updated.title)} · ${updated.state === "created" ? "담당자 검토 후 개발을 승인해 주세요." : updated.state === "queued" ? "승인됨 · 실행 대기" : "내용이 변경되었습니다."}`);
  }
  await audit(a.ownerId, r.id, a.userId, action, r.revision,action==='force'?{reason:text(p.reason,500)}:{});
  if(['edit','create','approve','force','answer','requester','notice','review_notice','refresh_source','reassign'].includes(action))await queueTicketUpdate(a,r.id,'updated');
  return getTicketAutomation(a,{requestId:r.id});
}

async function queueTicketMessage(owner: string, id: string, kind: string, channel: string, thread: string | null, body: string) {
  const r = await one<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE id=? AND owner_id=?", id, owner);
  if(r)await ticketMessageStatement(r,kind,channel,thread,body).run();
}
type MessageTicket=Pick<TicketAutomationRequest,'id'|'owner_id'|'state'|'revision'|'category'>;
function ticketMessagePayload(r:MessageTicket,kind:string,body:string){
  const id=r.id;
  const action = r?.state === "recommended" ? "create" : r?.state === "created" ? "approve" : r?.state === "review" ? "publish" : null;
  const safe=redactTicketText(body),blocks: Record<string, unknown>[] = [];
  for(let offset=0;offset<safe.length;offset+=2800)blocks.push({type:'section',text:{type:kind==='source'?'plain_text':'mrkdwn',text:safe.slice(offset,offset+2800)}});
  if(kind!=='source'&&!kind.startsWith('completion:'))blocks.push({type:'context',elements:[{type:'mrkdwn',text:`<${publicUrl()}/?view=tickets&ticketAutomation=1&request=${encodeURIComponent(id)}|OKRI에서 보기>`}]});
  if (r && kind!=='source' && !kind.startsWith("completion:")) blocks.push({ type: "actions", elements: [
    ...(action ? [{ type: "button", text: { type: "plain_text", text: action === "create" ? "티켓 생성" : action === "approve" ? r.category==='guidance'?'안내문 검토':'개발 승인' : "완료 안내 공유 승인" }, action_id: `ticket_auto_${action}`, value: `${id}:${r.revision}` }] : []),
    { type: "button", text: { type: "plain_text", text: r.state==='review'?'완료 안내 수정':'내용·담당자·포트 수정' },action_id:'ticket_auto_edit',value:`${id}:${r.revision}` },
    ...(['recommended','created','blocked','failed','security_review'].includes(r.state)?[{type:'button',text:{type:'plain_text',text:'원문 다시 분석'},action_id:'ticket_auto_refresh_source',value:`${id}:${r.revision}`}]:[]),
    ...(['queued','running','waiting_answer'].includes(r.state)?[{type:'button',text:{type:'plain_text',text:'실행 중지'},action_id:'ticket_auto_stop',value:`${id}:${r.revision}`}]:[]),
    ...(['recommended','created','blocked','failed'].includes(r.state)?[{type:'button',text:{type:'plain_text',text:'요청 제외'},action_id:'ticket_auto_dismiss',value:`${id}:${r.revision}`,confirm:{title:{type:'plain_text',text:'요청 제외'},text:{type:'plain_text',text:'원문과 처리 이력은 남기고 처리 대상에서 제외할까요?'},confirm:{type:'plain_text',text:'제외'},deny:{type:'plain_text',text:'취소'}}}]:[]),
    { type:'button',text:{type:'plain_text',text:'티켓 운영 열기'},action_id:'ticket_queue_open',value:'{}'},
  ] });
  return {text:(kind==='source'?escapeSlackText(safe):safe).slice(0,39000),blocks,unfurl_links:false,unfurl_media:false};
}
function ticketMessageStatement(r:MessageTicket,kind:string,channel:string,thread:string|null,body:string){
  const time=now();return env.DB.prepare('INSERT OR IGNORE INTO ticket_automation_outbox(id,owner_id,request_id,kind,channel_id,thread_ts,body_json,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ticket_automation_requests WHERE id=? AND owner_id=?)').bind(`${r.id}:${kind}`,r.owner_id,r.id,kind,channel,thread,JSON.stringify(ticketMessagePayload(r,kind,body)),time,time,r.id,r.owner_id);
}
function publicUrl() {
  const runtime = env as typeof env & { OKRI_PUBLIC_URL?: string };
  const url = new URL(runtime.OKRI_PUBLIC_URL || "https://okri.ai");
  return url.origin;
}
export async function syncTicketJobs() {
  const tickets = await rows<TicketAutomationRequest & { job_status: string; result_text: string; progress_text: string; error_text: string; lease_expires_at: string }>(`SELECT r.*,j.status job_status,j.result_text,j.progress_text,j.error_text,j.lease_expires_at FROM ticket_automation_requests r JOIN local_agent_jobs j ON j.id=r.job_id AND j.workspace_id=r.owner_id WHERE r.state IN ('queued','running') LIMIT 100`);
  for (const r of tickets) {
    const s = await settings(r.owner_id); if (!s?.enabled) continue;
    const c = config(s), time = now();
    const mention = await one<{ slack_user_id: string }>("SELECT slack_user_id FROM slack_member_links WHERE owner_id=? AND member_id=? AND team_id=?", r.owner_id, r.member_id, r.team_id);
    const tag = mention ? `<@${mention.slack_user_id}> ` : "";
    if (r.job_status === "running") {
      if(!JSON.parse(r.security_json||'{}').allow)continue;
      await run("UPDATE ticket_automation_requests SET state='running',updated_at=? WHERE id=? AND state='queued'", time, r.id);
      const bucket = String(Math.floor(Date.now()/600000));
      await queueTicketMessage(r.owner_id, r.id, `progress:${bucket}`, c.destination, await managementThread(r.id), `${tag}진행 중 · ${escapeSlackText(r.title)}\n${escapeSlackText(redactTicketText(r.progress_text || "로컬 개발 작업 진행 중"))}`);
    } else if (r.job_status === "completed") {
      try{await requireTicketPreflightForCompletion(r.job_id!);}catch{await run("UPDATE ticket_automation_requests SET state='blocked',reasons_json=?,revision=revision+1,updated_at=? WHERE id=? AND job_id=? AND state IN ('queued','running')",JSON.stringify(["포트 최종 검증 이력이 없어 완료 처리를 중지했습니다."]),time,r.id,r.job_id);continue;}
      const result = redactTicketText(r.result_text || "작업 결과를 확인해 주세요.");
      const question = result.startsWith("OKRI_QUESTION:") ? result.slice(14).trim().slice(0, 2000) : "";
      const state = question ? "waiting_answer" : result.startsWith('OKRI_BLOCKED:')?'failed':/\[REDACTED(?:_[A-Z_]+)?\]|\[비밀정보 삭제\]/.test(result)?"blocked":"review";
      const notice = state==='review' ? `요청하신 ‘${r.title}’의 개발 작업이 완료되었습니다.\n${result.slice(0, 2400)}\n담당자 확인 후 적용·배포 상태를 안내드립니다.`:'';
      const changed = await run("UPDATE ticket_automation_requests SET state=?,question=?,notice=?,revision=revision+1,updated_at=? WHERE id=? AND job_id=? AND state IN ('queued','running')", state, question, notice, time, r.id, r.job_id);
      if(changed.meta.changes){await audit(r.owner_id,r.id,"runner",state,r.revision,{jobId:r.job_id});if(state==='review')await run("UPDATE items SET status='done',updated_at=? WHERE id=? AND owner_id=? AND source='slack_ticket' AND source_ref=?",time,r.task_id,r.owner_id,r.id);}
      if (changed.meta.changes) await queueTicketMessage(r.owner_id, r.id, `result:${r.job_id}`, c.destination, await managementThread(r.id), `${tag}${question ? `확인이 필요합니다.\n${escapeSlackText(question)}` : state==='review'?`개발 완료 · ${escapeSlackText(r.title)}\n완료 안내를 검토한 뒤 공유를 승인해 주세요.\n${escapeSlackText(notice)}`:`개발 확인 필요 · ${escapeSlackText(r.title)}\n${escapeSlackText(result.slice(0,2400))}`}`);
    } else if (["failed", "cancelled"].includes(r.job_status)) {
      await run("UPDATE ticket_automation_requests SET state='failed',revision=revision+1,updated_at=? WHERE id=? AND job_id=? AND state IN ('queued','running')", time, r.id, r.job_id);
      await queueTicketMessage(r.owner_id, r.id, `failed:${r.job_id}`, c.destination, await managementThread(r.id), `${tag}작업 확인 필요 · ${escapeSlackText(r.title)}\n${escapeSlackText(redactTicketText(r.error_text || "포트 연결 또는 작업 결과를 확인해 주세요."))}`);
    }
  }
}
async function managementThread(id: string) { return (await one<{ message_ts: string }>("SELECT COALESCE(thread_ts,message_ts) AS message_ts FROM ticket_automation_outbox WHERE request_id=? AND kind IN ('source','recommendation') AND state='sent' ORDER BY CASE kind WHEN 'source' THEN 0 ELSE 1 END LIMIT 1", id))?.message_ts ?? null; }
export async function deliverTicketOutbox() {
  // A crash/timeout after Slack accepted a message is ambiguous. Never blindly resend it.
  await run("UPDATE ticket_automation_outbox SET state='uncertain',last_error='delivery_confirmation_required' WHERE state='sending' AND updated_at<?", new Date(Date.now()-120000).toISOString());
  const pending = await rows<{ id: string; owner_id: string; request_id: string; kind: string; channel_id: string; thread_ts: string | null; body_json: string }>("SELECT * FROM ticket_automation_outbox WHERE state='pending' ORDER BY CASE WHEN kind='source' THEN 0 ELSE 1 END,created_at LIMIT 30");
  for (const message of pending) {
    const s = await settings(message.owner_id); if (!s?.enabled || !config(s).notificationsAuthorized) continue;
    const c = config(s), r = await one<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE id=? AND owner_id=?", message.request_id, message.owner_id);
    if (!r) continue;
    const completion = message.kind.startsWith("completion:");
    if(message.kind.startsWith('progress:')&&r.state!=='running'){await run("UPDATE ticket_automation_outbox SET state='cancelled',updated_at=? WHERE id=? AND state='pending'",now(),message.id);continue;}
    if ((completion && (r.state !== "publishing" || message.kind !== `completion:${r.revision-1}` || !c.channels.some(ch => ch.id === message.channel_id && ch.enabled))) || (!completion && message.channel_id !== c.destination)) {
      await env.DB.batch([
        env.DB.prepare("UPDATE ticket_automation_outbox SET state='cancelled',updated_at=? WHERE id=? AND state='pending'").bind(now(),message.id),
        ...(completion?[env.DB.prepare("UPDATE ticket_automation_requests SET state='review',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND state='publishing' AND revision=?").bind(now(),r.id,r.owner_id,r.revision)]:[]),
      ]);continue;
    }
    const connection = await getSlackConnection(message.owner_id); if (!connection || connection.teamId !== r.team_id) continue;
    const sourceParent=message.kind==='recommendation'?await one<{message_ts:string}>("SELECT message_ts FROM ticket_automation_outbox WHERE request_id=? AND kind='source' AND state='sent'",r.id):null;
    const threadTs = completion ? message.thread_ts : message.kind==='source'?null:message.kind === "recommendation" ? sourceParent?.message_ts||null : await managementThread(r.id);
    if (!completion && message.kind!=='source' && !threadTs) continue;
    const claimed = await run("UPDATE ticket_automation_outbox SET state='sending',thread_ts=?,updated_at=? WHERE id=? AND state='pending'",threadTs, now(), message.id); if (!claimed.meta.changes) continue;
    try {
      const token = await slackTokenForConnection(connection);
      const stored=JSON.parse(message.body_json),payload=!completion&&message.kind!=='source'?ticketMessagePayload(r,message.kind,stored.text):stored;
      const result = await slackApi<{ ok: boolean; ts?: string }>(token, "chat.postMessage", { channel: message.channel_id,client_msg_id:await ticketDeliveryId(message.id), ...(threadTs ? { thread_ts: threadTs } : {}), ...payload });
      if (!result.ts) throw new Error("missing_message_ts");
      if (completion) {
        await env.DB.batch([
          env.DB.prepare("UPDATE ticket_automation_outbox SET state='sent',message_ts=?,updated_at=? WHERE id=? AND state='sending'").bind(result.ts,now(),message.id),
          env.DB.prepare("UPDATE ticket_automation_requests SET state='published',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND state='publishing' AND revision=?").bind(now(),r.id,r.owner_id,r.revision),
        ]);
        await run("UPDATE items SET status='done',updated_at=? WHERE id IN (?,?) AND owner_id=? AND source='slack_ticket' AND source_ref=?",now(),r.ticket_id,r.task_id,r.owner_id,r.id);
        await audit(r.owner_id,r.id,"slack","completion_shared",r.revision,{channel:r.source_channel,messageTs:result.ts});
        await slackApi(token,'reactions.remove',{channel:r.source_channel,timestamp:r.source_ts,name:'hourglass_flowing_sand'}).catch(()=>undefined);
        await slackApi(token, "reactions.add", { channel: r.source_channel, timestamp: r.source_ts, name: "white_check_mark" }).catch(() => undefined);
      }else await run("UPDATE ticket_automation_outbox SET state='sent',message_ts=?,thread_ts=?,updated_at=? WHERE id=? AND state='sending'",result.ts,threadTs,now(),message.id);
      if (message.kind.startsWith("progress:")) await slackApi(token, "reactions.add", { channel: r.source_channel, timestamp: r.source_ts, name: "hourglass_flowing_sand" }).catch(() => undefined);
      if(message.kind.startsWith('stopped:')||message.kind.startsWith('failed:'))await slackApi(token,'reactions.remove',{channel:r.source_channel,timestamp:r.source_ts,name:'hourglass_flowing_sand'}).catch(()=>undefined);
    } catch { await run("UPDATE ticket_automation_outbox SET state='uncertain',last_error='delivery_confirmation_required',updated_at=? WHERE id=?", now(), message.id); }
  }
}
async function ticketDeliveryId(id:string){const h=await digest(id);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
/** Recover accepted-but-timed-out sends by their correlation id. Never resend an ambiguous message. */
export async function reconcileTicketDeliveries(){
  const deadline=Date.now()+20000;
  const pending=await rows<{id:string;owner_id:string;request_id:string;kind:string;channel_id:string;thread_ts:string|null;updated_at:string}>("SELECT * FROM ticket_automation_outbox WHERE state='uncertain' AND updated_at<? AND (reconcile_next_at IS NULL OR reconcile_next_at<=?) ORDER BY COALESCE(reconcile_next_at,''),updated_at LIMIT 3",new Date(Date.now()-120000).toISOString(),now());
  for(const m of pending){
    if(Date.now()>deadline)break;
    await run("UPDATE ticket_automation_outbox SET reconcile_next_at=? WHERE id=? AND state='uncertain'",new Date(Date.now()+300000).toISOString(),m.id);
    const connection=await getSlackConnection(m.owner_id);if(!connection)continue;
    try{
      const token=await slackTokenForConnection(connection),correlation=await ticketDeliveryId(m.id);let cursor='',found:string|undefined;
      for(let page=0;page<3&&Date.now()<deadline;page++){
        const result=await slackApi<{ok:boolean;messages?:{ts:string;client_msg_id?:string;user?:string}[];response_metadata?:{next_cursor?:string}}>(token,m.thread_ts?'conversations.replies':'conversations.history',{channel:m.channel_id,...(m.thread_ts?{ts:m.thread_ts}:{}),oldest:String(Date.parse(m.updated_at)/1000-300),latest:String(Date.parse(m.updated_at)/1000+300),inclusive:true,limit:100,...(cursor?{cursor}:{})});
        found=result.messages?.find(v=>v.client_msg_id===correlation&&v.user===connection.botUserId)?.ts;
        cursor=result.response_metadata?.next_cursor||'';if(found||!cursor)break;
      }
      if(!found)continue;
      const completion=m.kind.startsWith('completion:');
      await env.DB.batch([
        env.DB.prepare("UPDATE ticket_automation_outbox SET state='sent',message_ts=?,last_error=NULL,updated_at=? WHERE id=? AND state='uncertain'").bind(found,now(),m.id),
        ...(completion?[env.DB.prepare("UPDATE ticket_automation_requests SET state='published',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND state='publishing' AND ?='completion:'||(revision-1)").bind(now(),m.request_id,m.owner_id,m.kind)]:[]),
      ]);
      if(completion){await run("UPDATE items SET status='done',updated_at=? WHERE owner_id=? AND source='slack_ticket' AND source_ref=? AND id IN(SELECT ticket_id FROM ticket_automation_requests WHERE id=? AND state='published' UNION SELECT task_id FROM ticket_automation_requests WHERE id=? AND state='published')",now(),m.owner_id,m.request_id,m.request_id,m.request_id);}
      await audit(m.owner_id,m.request_id,'slack','delivery_receipt_recovered',null,{outboxId:m.id,messageTs:found});
    }catch{/* Keep the visible uncertain state until Slack confirms the exact message. */}
  }
}
export async function runTicketAutomation() {
  await Promise.all([
    (async()=>{await (await import('@/lib/ticket-intake-queue')).runTicketIntake();await deliverTicketOutbox();})(),
    (async()=>{await syncTicketJobs();await reconcileTicketDeliveries();await deliverTicketOutbox();})(),
  ]);
}

export async function ticketSlackAction(teamId: string, userId: string, action: string, value: string) {
  const linked = await dailyMemberBySlack(teamId, userId); if (!linked) fail("OKRI 계정을 먼저 연결해 주세요.", 403);
  const [id, revision] = value.split(":");
  await changeTicketRequest(linked.authorization, { id, revision: Number(revision), action });
}
export async function queueTicketUpdate(a:RequestAuthorization,id:string,kind:string){
  const r=await requestFor(a,id),s=await settings(a.ownerId);if(!s)return;
  const body=r.state==='review'?`[${TICKET_CATEGORY_LABELS[r.category]}] ${escapeSlackText(r.title)}\n\n고객에게 보낼 안내문\n${escapeSlackText(r.notice)}\n\n이 문안으로 요청자에게 공유할까요?`:`[${TICKET_CATEGORY_LABELS[r.category]}] ${escapeSlackText(r.title)}\n\n${escapeSlackText(r.description)}\n\n${r.member_id?'담당자 지정됨':'담당자 미지정'} · ${r.category==='guidance'?'안내 검토':r.state==='created'?'개발 승인 대기':r.state==='queued'?'실행 대기':'추천 검토'}`;
  const parent=await one("SELECT id FROM ticket_automation_outbox WHERE request_id=? AND kind IN ('source','recommendation')",r.id);
  if(!parent)await ensureTicketRecommendation(r,config(s),config(s).channels.find(c=>c.id===r.source_channel)?.name||r.source_channel);
  else if(kind==='updated'&&r.source_event_ts==='')await queueTicketMessage(a.ownerId,r.id,'source',config(s).destination,null,`고객 원문\n${JSON.parse(r.analysis_json||'{}').original||r.source_text}\n\n${sourceLink(r)}`);
  await run("UPDATE ticket_automation_outbox SET state='cancelled',updated_at=? WHERE request_id=? AND kind LIKE 'updated:%' AND kind<>? AND state='pending'",now(),r.id,`updated:${r.revision}`);
  await queueTicketMessage(a.ownerId,id,`updated:${r.revision}`,config(s).destination,await managementThread(id),body);
}

export async function handleTicketThreadReply(teamId: string, event: { channel: string; ts: string; user: string; text: string; threadTs?: string }) {
  if (!event.threadTs) return false;
  const r = await one<TicketAutomationRequest>(`SELECT r.* FROM ticket_automation_requests r JOIN ticket_automation_outbox o ON o.request_id=r.id AND o.owner_id=r.owner_id JOIN ticket_automation_settings s ON s.owner_id=r.owner_id AND s.enabled=1 WHERE r.team_id=? AND o.channel_id=? AND o.message_ts=? AND o.kind IN ('source','recommendation') AND o.state='sent'`, teamId, event.channel, event.threadTs);
  if (!r || r.state !== "waiting_answer") return false;
  const linked = await dailyMemberBySlack(teamId, event.user);
  if (!linked || linked.authorization.ownerId !== r.owner_id || (linked.memberId !== r.member_id && !canManageTeam(linked.authorization))) return true;
  await changeTicketRequest(linked.authorization, { id: r.id, action: "answer", revision: r.revision, answer: event.text });
  const updated = await one<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE id=? AND owner_id=?", r.id, r.owner_id);
  if (updated) await changeTicketRequest(linked.authorization, { id: r.id, revision: updated.revision, action: "approve" });
  return true;
}

/** Rechecked by the device pickup endpoint; an approval never grants lasting authority. */
export async function validateTicketJobPickup(jobId: string, isolatedTicketSupport = false) {
  const r = await one<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE job_id=?", jobId);
  if (!r) return true; // Existing non-ticket local jobs retain their contract.
  if (!isolatedTicketSupport) return false;
  if((await unresolvedDependencies(r)).length)return false;
  const job=await one<{context_json:string}>("SELECT context_json FROM local_agent_jobs WHERE id=?",jobId),context=JSON.parse(job?.context_json||'{}');
  const product=r.product_id?await one<TicketDevelopmentProduct>("SELECT * FROM ticket_development_products WHERE id=? AND owner_id=?",r.product_id,r.owner_id):null;
  if(!product||context.product?.revision!==product.revision){await run("UPDATE ticket_automation_requests SET state='blocked',reasons_json=?,revision=revision+1,updated_at=? WHERE id=? AND state='queued'",JSON.stringify(["제품 명세가 변경되어 재검토가 필요합니다."]),now(),r.id);await run("UPDATE local_agent_jobs SET status='cancelled',updated_at=? WHERE id=? AND status='queued'",now(),jobId);return false;}
  for(const other of await repositoryRequests(r))if(other.state==='queued'&&ticketPriorityRank(other.priority)<ticketPriorityRank(r.priority)&&!(await unresolvedDependencies(other)).length)return false;
  const s = await settings(r.owner_id);
  const valid = s?.enabled && config(s).channels.some(c => c.id === r.source_channel && c.enabled)
    && await one(`SELECT p.id FROM ticket_execution_ports p JOIN workspace_members m ON m.id=p.member_id AND m.workspace_id=p.owner_id JOIN local_agent_jobs j ON j.id=? AND j.device_id=p.device_id AND j.workspace_id=p.owner_id AND j.user_id=m.user_id WHERE p.id=? AND p.owner_id=? AND p.member_id=? AND p.enabled=1 AND m.status='active' AND p.product_id=? AND p.repository_id=? AND EXISTS(SELECT 1 FROM json_each(p.channel_ids_json) WHERE value=?)`, jobId, r.port_id, r.owner_id, r.member_id,r.product_id,r.repository_id, r.source_channel);
  let safe = Boolean(valid && r.state === "queued" && r.risk !== "blocked");
  if (safe) {
    try { const source = await readSource(r.owner_id, r.source_channel, r.source_ts, r.source_user); safe = source.hash === r.source_digest && assessTicketText(source.raw).risk !== "blocked"; }
    catch { return false; } // Transient read failures leave the queue intact.
  }
  if (!safe) await env.DB.batch([
    env.DB.prepare("UPDATE local_agent_jobs SET status='cancelled',updated_at=? WHERE id=? AND status='queued'").bind(now(), jobId),
    env.DB.prepare("UPDATE ticket_automation_requests SET state='blocked',risk='blocked',reasons_json=?,revision=revision+1,updated_at=? WHERE id=? AND job_id=? AND state='queued'").bind(JSON.stringify(["배정·권한·원문이 변경되어 실행을 중지했습니다."]), now(), r.id, jobId),
  ]);
  return safe;
}

const SECURITY_CODES = new Set(["scope_ambiguous","sensitive_change","dependency_network","destructive","coordination_conflict","exfiltration","secrets","security_boundary"]);
const HARD_SECURITY_CODES = new Set(["exfiltration","secrets","security_boundary"]);
/** Device-scoped final checkpoint. Customer text cannot issue an execution grant. */
export async function validateTicketPreflight(device:{id:string;workspaceId:string;userId:string},p:Record<string,unknown>) {
  const job = await one<{id:string;context_json:string;lease_id:string;lease_expires_at:string}>(`SELECT id,context_json,lease_id,lease_expires_at FROM local_agent_jobs WHERE id=? AND workspace_id=? AND user_id=? AND device_id=? AND status='running' AND lease_id=? AND lease_expires_at>?`,text(p.id,80),device.workspaceId,device.userId,device.id,text(p.leaseId,80),now());
  if(!job)fail("유효한 포트 실행 권한이 없습니다.",409);
  const r = await one<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE job_id=? AND owner_id=? AND state IN ('queued','running')",job.id,device.workspaceId);
  const context=JSON.parse(job.context_json||"{}");
  if(!r||context.executionPolicy!=="ticket-isolated-v1")fail("티켓 검증 대상이 아닙니다.",409);
  if(!/^[a-f0-9]{64}$/.test(String(p.snapshotDigest))||p.basisDigest!==context.basisDigest)fail("승인된 요청과 검증 대상이 다릅니다.",409);
  const codes=Array.isArray(p.codes)?[...new Set(p.codes.filter((v):v is string=>typeof v==='string'&&SECURITY_CODES.has(v)))].sort():[];
  let verdict=p.verdict==="pass"?"pass":p.verdict==="warning"?"warning":"blocked";
  if(codes.some(code=>HARD_SECURITY_CODES.has(code)))verdict="blocked";
  if(verdict==="pass"&&codes.length)verdict="warning";
  if(verdict==="warning"&&!codes.length)codes.push("scope_ambiguous");
  const s=await settings(r.owner_id);
  const port=await one<Port>("SELECT p.* FROM ticket_execution_ports p JOIN workspace_members m ON m.id=p.member_id AND m.workspace_id=p.owner_id AND m.user_id=? AND m.status='active' WHERE p.id=? AND p.owner_id=? AND p.member_id=? AND p.device_id=? AND p.enabled=1",device.userId,r.port_id,r.owner_id,r.member_id,device.id);
  const source=await readSource(r.owner_id,r.source_channel,r.source_ts,r.source_user);
  const currentProduct=r.product_id?await one<TicketDevelopmentProduct>("SELECT * FROM ticket_development_products WHERE id=? AND owner_id=?",r.product_id,r.owner_id):null;
  if(!currentProduct||currentProduct.revision!==context.product?.revision||port?.product_id!==r.product_id||port?.repository_id!==r.repository_id){verdict='blocked';codes.push('security_boundary');}
  const paths=Array.isArray(p.paths)?[...new Set(p.paths.filter((v):v is string=>typeof v==='string'&&v.length>0&&v.length<=240&&!(v.startsWith('/')||v.startsWith('\\')||/[:\p{Cc}]/u.test(v))&&!v.replaceAll('\\','/').split('/').includes('..')).map(v=>v.replaceAll('\\','/')))].slice(0,50):[];
  const coordination={paths,updatedAt:now(),priority:r.priority};
  const otherPlans=(await repositoryRequests(r)).filter(v=>v.state==='running'&&v.job_id!==job.id);
  if(otherPlans.some(v=>{const other=JSON.parse(v.coordination_json||'{}').paths as string[]|undefined;return !paths.length||!other?.length||paths.some(a=>other.some(b=>a.toLocaleLowerCase()===b.toLocaleLowerCase()));})){verdict=verdict==='blocked'?'blocked':'warning';codes.push('coordination_conflict');}
  if(!s?.enabled||!config(s).channels.some(c=>c.enabled&&c.id===r.source_channel)||!port||!JSON.parse(port.channel_ids_json).includes(r.source_channel)||(port.model||config(s).defaultModel||null)!==context.model||source.hash!==r.source_digest||assessTicketText(source.raw).risk==="blocked") {verdict="blocked";codes.push("security_boundary");}
  const override=context.securityOverride;
  const overrideValid=verdict==="warning"&&override?.basisDigest===context.basisDigest&&override.snapshotDigest===p.snapshotDigest&&codes.every(code=>override.codes?.includes(code))&&typeof override.reason==="string";
  const allow=verdict==="pass"||overrideValid;
  const security={verdict,codes,basisDigest:context.basisDigest,snapshotDigest:p.snapshotDigest,jobId:job.id,leaseDigest:await digest(job.lease_id),allow,checkedAt:now(),...(overrideValid?{override:{actor:override.actor,reason:override.reason}}:{})};
  if(allow) {
    const result=await run(`UPDATE ticket_automation_requests SET security_json=?,coordination_json=?,state='running',updated_at=? WHERE id=? AND owner_id=? AND job_id=? AND revision=? AND state IN ('queued','running') AND (?=1 OR NOT EXISTS(SELECT 1 FROM ticket_automation_requests other JOIN local_agent_jobs oj ON oj.id=other.job_id AND oj.workspace_id=other.owner_id WHERE other.owner_id=? AND other.id<>? AND other.state='running' AND json_extract(oj.context_json,'$.repository.remote')=? AND (?='[]' OR COALESCE(json_array_length(other.coordination_json,'$.paths'),0)=0 OR EXISTS(SELECT 1 FROM json_each(?) p JOIN json_each(other.coordination_json,'$.paths') q ON lower(p.value)=lower(q.value) OR instr(lower(p.value),lower(q.value)||'/')=1 OR instr(lower(q.value),lower(p.value)||'/')=1))))`,JSON.stringify(security),JSON.stringify(coordination),now(),r.id,r.owner_id,job.id,r.revision,overrideValid?1:0,r.owner_id,r.id,context.repository?.remote||'',JSON.stringify(paths),JSON.stringify(paths));
    if(!result.meta.changes)return validateTicketPreflight(device,{...p,verdict:'warning',codes:[...codes,'coordination_conflict']});
  } else {
    await env.DB.batch([
      env.DB.prepare("UPDATE local_agent_jobs SET status='cancelled',error_text=?,updated_at=? WHERE id=? AND lease_id=? AND status='running'").bind(verdict==="warning"?"security_review_required":"security_preflight_blocked",now(),job.id,job.lease_id),
      env.DB.prepare("UPDATE ticket_automation_requests SET security_json=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND job_id=? AND revision=? AND state IN ('queued','running')").bind(JSON.stringify(security),verdict==="warning"?"security_review":"blocked",now(),r.id,r.owner_id,job.id,r.revision),
    ]);
    if(s)await queueTicketMessage(r.owner_id,r.id,`security:${job.id}`,config(s).destination,await managementThread(r.id),`보안 검토 필요 · ${escapeSlackText(r.title)}\n${verdict==="warning"?"포트 검증에서 경고가 발견되었습니다. OKRI에서 확인 사유를 남긴 뒤 진행할 수 있습니다.":"비밀정보 또는 실행 경계 검증에 실패하여 중지했습니다."}`);
  }
  await audit(r.owner_id,r.id,device.userId,allow?(overrideValid?"preflight_warning_override_used":"preflight_passed"):verdict==="warning"?"preflight_warning":"preflight_blocked",r.revision,{jobId:job.id,basisDigest:context.basisDigest,snapshotDigest:p.snapshotDigest,codes,...(overrideValid?{reason:override.reason}:{})});
  return {allow,verdict,coordination:await coordinationContext(r)};
}

export async function requireTicketPreflightForCompletion(jobId:string,device?:{id:string;workspaceId:string;userId:string}) {
  if(device&&!await one("SELECT id FROM local_agent_jobs WHERE id=? AND device_id=? AND workspace_id=? AND user_id=?",jobId,device.id,device.workspaceId,device.userId))fail("유효한 포트 실행 권한이 없습니다.",403);
  const r=await one<TicketAutomationRequest>("SELECT * FROM ticket_automation_requests WHERE job_id=?",jobId);
  if(r){const security=JSON.parse(r.security_json||"{}"),job=await one<{lease_id:string}>("SELECT lease_id FROM local_agent_jobs WHERE id=?",jobId);if(r.state!=="running"||!security.allow||security.jobId!==jobId||!job?.lease_id||security.leaseDigest!==await digest(job.lease_id))fail("포트의 최종 검증을 통과해야 완료할 수 있습니다.",409);}
}
