import {waitUntil} from 'cloudflare:workers';
import {
  authorizeLocalAgentDevice,
  localAgentErrorResponse,
  reportLocalAgentJob,
} from "@/lib/local-agent";

export async function POST(request: Request) {
  const device = await authorizeLocalAgentDevice(request);
  if (device instanceof Response) return device;
  try {
    const payload = await request.json() as Record<string, unknown>;
    if(payload.status==="completed"&&typeof payload.id==="string"){
      const {requireTicketPreflightForCompletion}=await import("@/lib/ticket-automation");
      try{await requireTicketPreflightForCompletion(payload.id,device);}catch{return Response.json({error:"Ticket port final validation is required.",code:"ticket_security_required"},{status:409,headers:{"Cache-Control":"no-store"}});}
    }
    const job = await reportLocalAgentJob(device, {
      id: payload.id,
      leaseId: payload.leaseId,
      status: payload.status,
      progressText: payload.progressText,
      resultText: payload.resultText,
      errorText: payload.errorText,
    });
    const {ticketProblemChanges}=await import('@/lib/ticket-automation');
    const problemChanges=payload.status==='running'&&typeof payload.id==='string'?await ticketProblemChanges(payload.id,payload.appliedProblemChangeIds):[];
    if(['completed','failed'].includes(String(payload.status)))waitUntil(import('@/lib/ticket-automation').then(async m=>{await m.syncTicketJobs();await m.deliverTicketOutbox();}).catch(()=>undefined));
    return Response.json({ job,problemChanges }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
