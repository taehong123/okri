import {env} from "cloudflare:workers";
import {setActiveWorkspace} from "./pace-data";
import {reserveEditorSeat,releaseEditorSeat} from "./billing";
import {completeOnboardingForInvitedWorkspace} from "./account-onboarding";
import {InviteLinkError,type InviteLinkSigner,acceptWorkspaceInviteLink} from "./workspace-invite-links";
import type {RequestAuthorization} from "./pace-data";
type Runtime={GOOGLE_TOKEN_ENCRYPTION_KEY?:string;OKRI_API_TOKEN?:string;OKRPTR_API_TOKEN?:string;PACE_API_TOKEN?:string;OKRI_PUBLIC_URL?:string;OKRPTR_PUBLIC_URL?:string};
export function workspaceInviteBase(){const runtime=env as Runtime;return runtime.OKRI_PUBLIC_URL?.trim()||runtime.OKRPTR_PUBLIC_URL?.trim()||"https://okri.ai";}
export const signWorkspaceInviteLink:InviteLinkSigner=async row=>{
 const runtime=env as Runtime,secret=runtime.GOOGLE_TOKEN_ENCRYPTION_KEY||runtime.OKRI_API_TOKEN||runtime.OKRPTR_API_TOKEN||runtime.PACE_API_TOKEN;if(!secret)throw new InviteLinkError("invite_link_signing_unavailable",503);
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]),signed=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(JSON.stringify(["okri-workspace-link-v1",row.id,row.workspace_id,row.role,row.expires_at])));
 return "wl_"+row.id+"."+Array.from(new Uint8Array(signed),b=>b.toString(16).padStart(2,"0")).join("");
};
export const acceptInviteLink=(auth:RequestAuthorization,token:string)=>acceptWorkspaceInviteLink(env.DB,auth,token,{reserveSeat:reserveEditorSeat,releaseSeat:releaseEditorSeat,activate:setActiveWorkspace,completeOnboarding:(user,workspace,name)=>completeOnboardingForInvitedWorkspace(env.DB,user,workspace,name)});
