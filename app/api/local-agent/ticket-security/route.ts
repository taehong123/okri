import { authorizeLocalAgentDevice, localAgentErrorResponse } from "@/lib/local-agent";
import { validateTicketPreflight, deliverTicketOutbox, TicketAutomationError } from "@/lib/ticket-automation";
import {waitUntil} from 'cloudflare:workers';
export async function POST(request:Request) {
  const device=await authorizeLocalAgentDevice(request);if(device instanceof Response)return device;
  try {
    if(Number(request.headers.get("content-length")||0)>12000)return Response.json({error:"검증 요청이 너무 큽니다."},{status:413});
    const body=await request.text();if(body.length>12000)return Response.json({error:"검증 요청이 너무 큽니다."},{status:413});
    const result=await validateTicketPreflight(device,JSON.parse(body));
    waitUntil(deliverTicketOutbox().catch(()=>undefined));
    return Response.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(error){if(error instanceof TicketAutomationError)return Response.json({error:error.message},{status:error.status,headers:{"Cache-Control":"no-store"}});return localAgentErrorResponse(error);}
}
