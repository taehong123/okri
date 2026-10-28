import {waitUntil} from 'cloudflare:workers';
import {
  authorizeLocalAgentDevice,
  claimNextLocalAgentJob,
  localAgentErrorResponse,
} from "@/lib/local-agent";

export async function POST(request: Request) {
  const device = await authorizeLocalAgentDevice(request);
  if (device instanceof Response) return device;
  try {
    const isolatedTicketSupport = request.headers.get("X-OKRI-Ticket-Sandbox") === "v1";
    const job=await claimNextLocalAgentJob(device, isolatedTicketSupport,request.headers.get('X-OKRI-Ticket-ReadOnly')==='v1',request.headers.get('X-OKRI-Ticket-Conversation')==='v1',request.headers.get('X-OKRI-Ticket-Images')==='v1');
    if(job?.conversation)waitUntil(import('@/lib/ticket-automation').then(m=>m.deliverTicketOutbox()).catch(()=>undefined));
    return Response.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
