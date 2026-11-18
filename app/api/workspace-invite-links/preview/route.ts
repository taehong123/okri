import {env} from "cloudflare:workers";
import {InviteLinkError,previewWorkspaceInviteLink} from "@/lib/workspace-invite-links";
export async function GET(request:Request){try{const token=new URL(request.url).searchParams.get("token")??"";return Response.json({invitation:await previewWorkspaceInviteLink(env.DB,token)},{headers:{"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"}});}catch(error){return Response.json({code:error instanceof InviteLinkError?error.code:"workspace_invite_link_failed"},{status:error instanceof InviteLinkError?error.status:500});}}
