import type {RequestAuthorization} from "./pace-data";
export class InviteLinkError extends Error {constructor(public code:string,public status=400){super(code);this.name="InviteLinkError";}}
type Row={id:string;workspace_id:string;workspace_name:string;role:"admin"|"member"|"viewer";token_hash:string;invited_by_user_id:string;expires_at:string;revoked_at:string|null;created_at:string;updated_at:string};
export type InviteLinkSigner=(row:Pick<Row,"id"|"workspace_id"|"role"|"expires_at">)=>Promise<string>;
const tokenPattern=/^wl_[a-f0-9-]{36}\.[a-f0-9]{64}$/;
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,"0")).join("");
async function currentWorkspace(db:D1Database,auth:RequestAuthorization,admin=false) {
 const row=await db.prepare(`SELECT w.id,w.name,w.kind,m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=? AND m.status='active' WHERE w.id=? AND w.scheduled_deletion_at IS NULL`).bind(auth.userId,auth.ownerId).first<{id:string;name:string;kind:string;role:string}>();
 if(!row)throw new InviteLinkError("workspace_not_found",404);
 if(admin&&(!["owner","admin"].includes(auth.role)||!["owner","admin"].includes(row.role)))throw new InviteLinkError("workspace_admin_required",403);
 if(admin&&auth.oauthScopes!==undefined&&!auth.oauthScopes.split(/\s+/).includes("okri:write"))throw new InviteLinkError("write_access_required",403);
 return row;
}
async function summary(row:Row,sign:InviteLinkSigner,base:string) {
 const token=await sign(row);if(!tokenPattern.test(token)||await digest(token)!==row.token_hash)throw new InviteLinkError("invite_link_signing_changed",409);
 const url=new URL(base);if(url.protocol!=="https:"&&!["localhost","127.0.0.1"].includes(url.hostname))throw new InviteLinkError("invite_link_origin_invalid",500);url.hash="invite="+encodeURIComponent(token);
 return {workspaceId:row.workspace_id,workspaceName:row.workspace_name,inviteUrl:url.toString(),role:row.role,expiresAt:row.expires_at};
}
export async function getWorkspaceInviteLink(db:D1Database,auth:RequestAuthorization,sign:InviteLinkSigner,base:string,now=new Date()) {
 const workspace=await currentWorkspace(db,auth);
 const row=await db.prepare(`SELECT l.*,w.name AS workspace_name FROM workspace_invite_links l JOIN workspaces w ON w.id=l.workspace_id WHERE l.workspace_id=? AND l.revoked_at IS NULL AND l.expires_at>?`).bind(workspace.id,now.toISOString()).first<Row>();
 return row?{found:true,...await summary(row,sign,base)}:{found:false,workspaceId:workspace.id,workspaceName:workspace.name,inviteUrl:null,role:null,expiresAt:null};
}
export async function createWorkspaceInviteLink(db:D1Database,auth:RequestAuthorization,input:{role?:"admin"|"member"|"viewer";expiresInDays?:number;replaceExisting?:boolean},sign:InviteLinkSigner,base:string,now=new Date()) {
 const workspace=await currentWorkspace(db,auth,true);if(workspace.kind!=="team")throw new InviteLinkError("team_workspace_required");
 const role=input.role??"member",days=input.expiresInDays??30;if(!["admin","member","viewer"].includes(role)||!Number.isInteger(days)||days<1||days>30||input.replaceExisting!==undefined&&typeof input.replaceExisting!=="boolean")throw new InviteLinkError("invalid_invite_link");
 const existing=input.replaceExisting?null:await getWorkspaceInviteLink(db,auth,sign,base,now);if(existing?.found&&!input.replaceExisting){if(existing.role!==role)throw new InviteLinkError("invite_link_replacement_required",409);return {...existing,created:false};}
 const previous=await db.prepare("SELECT id FROM workspace_invite_links WHERE workspace_id=?").bind(workspace.id).first<{id:string}>();
 const row:Row={id:crypto.randomUUID(),workspace_id:workspace.id,workspace_name:workspace.name,role,token_hash:"",invited_by_user_id:auth.userId,expires_at:new Date(now.getTime()+days*86400000).toISOString(),revoked_at:null,created_at:now.toISOString(),updated_at:now.toISOString()};row.token_hash=await digest(await sign(row));const link=await summary(row,sign,base),guard=crypto.randomUUID();
 try{await db.batch([
  db.prepare(`INSERT INTO workspace_invite_link_guards(id,valid) SELECT ?,CASE WHEN coalesce((SELECT id FROM workspace_invite_links WHERE workspace_id=?),'')=? AND EXISTS(SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND m.role IN ('owner','admin') AND m.status='active' AND w.kind='team' AND w.scheduled_deletion_at IS NULL) THEN 1 ELSE 0 END`).bind(guard,workspace.id,previous?.id??"",workspace.id,auth.userId),
  db.prepare(`INSERT INTO workspace_invite_links(id,workspace_id,role,token_hash,invited_by_user_id,expires_at,revoked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?) ON CONFLICT(workspace_id) DO UPDATE SET id=excluded.id,role=excluded.role,token_hash=excluded.token_hash,invited_by_user_id=excluded.invited_by_user_id,expires_at=excluded.expires_at,revoked_at=NULL,created_at=excluded.created_at,updated_at=excluded.updated_at`).bind(row.id,row.workspace_id,row.role,row.token_hash,row.invited_by_user_id,row.expires_at,row.created_at,row.updated_at),
  db.prepare("DELETE FROM workspace_invite_link_guards WHERE id=?").bind(guard),
 ]);}catch{throw new InviteLinkError("invite_link_conflict",409);}
 return {found:true,...link,created:true};
}
async function byToken(db:D1Database,token:string) {
 if(!tokenPattern.test(token))throw new InviteLinkError("invite_link_not_found",404);
 const row=await db.prepare(`SELECT l.*,w.name AS workspace_name FROM workspace_invite_links l JOIN workspaces w ON w.id=l.workspace_id WHERE l.token_hash=? AND w.kind='team' AND w.scheduled_deletion_at IS NULL`).bind(await digest(token)).first<Row>();
 if(!row)throw new InviteLinkError("invite_link_not_found",404);return row;
}
export async function previewWorkspaceInviteLink(db:D1Database,token:string,now=new Date()) {
 const row=await byToken(db,token);const inviter=await db.prepare("SELECT display_name FROM workspace_members WHERE workspace_id=? AND user_id=? AND status='active'").bind(row.workspace_id,row.invited_by_user_id).first<{display_name:string}>();
 return {workspace:{id:row.workspace_id,name:row.workspace_name},role:row.role,inviterName:inviter?.display_name||"Workspace admin",emailHint:"",kind:"workspace_link" as const,status:row.revoked_at?"revoked" as const:row.expires_at<=now.toISOString()?"expired" as const:"pending" as const,expiresAt:row.expires_at};
}
export async function acceptWorkspaceInviteLink(db:D1Database,auth:RequestAuthorization,token:string,deps:{reserveSeat:(workspace:string,role:string)=>Promise<string|null>;releaseSeat:(id:string|null)=>Promise<unknown>;activate:(user:string,workspace:string)=>Promise<unknown>;completeOnboarding:(user:string,workspace:string,name:string)=>Promise<unknown>},now=new Date()) {
 if(auth.apiToken||auth.oauthScopes!==undefined||!auth.email)throw new InviteLinkError("verified_session_required",403);
 const row=await byToken(db,token);if(row.revoked_at||row.expires_at<=now.toISOString())throw new InviteLinkError("invite_link_expired",410);
 const email=auth.email.trim().toLowerCase(),existing=await db.prepare("SELECT * FROM workspace_members WHERE workspace_id=? AND (user_id=? OR lower(email)=?) ORDER BY user_id=? DESC LIMIT 1").bind(row.workspace_id,auth.userId,email,auth.userId).first<Record<string,string>>();
 if(existing&&(existing.user_id!==auth.userId||existing.status!=="active"))throw new InviteLinkError("membership_conflict",409);
 let id=existing?.id??crypto.randomUUID();
 if(!existing){const reservation=await deps.reserveSeat(row.workspace_id,row.role),guard=crypto.randomUUID();try{await db.batch([
  db.prepare(`INSERT INTO workspace_invite_link_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM workspace_invite_links l JOIN workspaces w ON w.id=l.workspace_id WHERE l.id=? AND l.token_hash=? AND l.revoked_at IS NULL AND l.expires_at>? AND w.kind='team' AND w.scheduled_deletion_at IS NULL) THEN 1 ELSE 0 END`).bind(guard,row.id,row.token_hash,now.toISOString()),
  db.prepare(`INSERT INTO workspace_members(id,workspace_id,user_id,email,display_name,role,status,invited_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(workspace_id,user_id) DO NOTHING`).bind(id,row.workspace_id,auth.userId,email,auth.displayName.trim().slice(0,100)||email.split("@")[0],row.role,row.invited_by_user_id,now.toISOString(),now.toISOString()),
  db.prepare("DELETE FROM workspace_invite_link_guards WHERE id=?").bind(guard),
 ]);}catch{throw new InviteLinkError("invite_link_join_conflict",409);}finally{await deps.releaseSeat(reservation);}}
 const member=await db.prepare("SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=? AND status='active'").bind(row.workspace_id,auth.userId).first<Record<string,string>>();if(!member)throw new InviteLinkError("membership_conflict",409);id=member.id;
 await deps.activate(auth.userId,row.workspace_id);await deps.completeOnboarding(auth.userId,row.workspace_id,row.workspace_name);
 return {accepted:true,workspaceId:row.workspace_id,workspaceName:row.workspace_name,member:{id,email:member.email,displayName:member.display_name,role:member.role,status:"active",isCurrent:true,createdAt:member.created_at}};
}
