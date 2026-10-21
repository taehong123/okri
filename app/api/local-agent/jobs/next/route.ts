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
    return Response.json({ job: await claimNextLocalAgentJob(device, isolatedTicketSupport) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
