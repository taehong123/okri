import { authorizeRequest } from "@/lib/pace-data";
import {waitUntil} from 'cloudflare:workers';
import {requestTicketReconciliation,runTicketIntake,ticketIntakeStatus,importTicketSource,processTicketReceipt} from '@/lib/ticket-intake-queue';
import { bindTicketPort, changeTicketRequest, createTicketPorts, getTicketAutomation, pairTicketPort, pairOwnTicketPorts, saveTicketAutomation, saveTicketProduct, ticketRequesterOptions, TicketAutomationError,grantTicketAnalysisAllowance } from "@/lib/ticket-automation";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const a = await authorizeRequest(request, { allowViewerWrite: true }); if (a instanceof Response) return a;
  try {
    const p=new URL(request.url).searchParams;
    if(p.has('intakeOffset'))return Response.json({intake:await ticketIntakeStatus(a.ownerId,{offset:Number(p.get('intakeOffset'))||0,state:p.get('intakeState')||''})},{headers});
    return Response.json(await getTicketAutomation(a,{offset:Math.max(0,Number(p.get('offset'))||0),requestId:p.get('request')||undefined}), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const a = await authorizeRequest(request); if (a instanceof Response) return a;
  if (a.apiToken) return Response.json({ error: "계정 로그인이 필요합니다." }, { status: 403, headers });
  if (Number(request.headers.get("content-length") || 0) > 100000) return Response.json({ error: "요청이 너무 큽니다." }, { status: 413, headers });
  try {
    const raw = await request.text(); if (raw.length > 100000) throw new TicketAutomationError("요청이 너무 큽니다.", 413);
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new TicketAutomationError("요청을 확인해 주세요.");
    if(p.operation==='import_source'){
      const id=await importTicketSource(a,String(p.url||''));waitUntil(processTicketReceipt(id));
      return Response.json({receiptId:id},{headers});
    }
    if(p.operation==='analysis_allowance')return Response.json(await grantTicketAnalysisAllowance(a,p.extra),{headers});
    if(p.operation==='reconcile'){
      await requestTicketReconciliation(a,typeof p.id==='string'?p.id:undefined);
      waitUntil(runTicketIntake().catch(()=>undefined));
      return Response.json(await getTicketAutomation(a),{headers});
    }
    const result = p.operation === "product" ? await saveTicketProduct(a,p) : p.operation === "settings" ? await saveTicketAutomation(a, p) : p.operation === "ports" ? await createTicketPorts(a, p) : p.operation === "pair" ? await pairTicketPort(a, p) : p.operation === "pair_bulk" ? await pairOwnTicketPorts(a,p) : p.operation === "bind" ? await bindTicketPort(a, p) : p.operation === "requester_options" ? await ticketRequesterOptions(a, String(p.id||""),String(p.query||"").slice(0,80)) : p.operation === "request" ? await changeTicketRequest(a, p) : null;
    if (!result) throw new TicketAutomationError("지원하지 않는 작업입니다.");
    return Response.json(result, { headers });
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  if (error instanceof TicketAutomationError) return Response.json({ error: error.message }, { status: error.status, headers });
  console.error("Ticket automation request failed", { name: error instanceof Error ? error.name : "unknown" });
  return Response.json({ error: "티켓 자동화를 처리하지 못했습니다. 연결 상태를 확인해 주세요." }, { status: 500, headers });
}
