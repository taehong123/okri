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
    const job = await reportLocalAgentJob(device, {
      id: payload.id,
      leaseId: payload.leaseId,
      status: payload.status,
      progressText: payload.progressText,
      resultText: payload.resultText,
      errorText: payload.errorText,
    });
    return Response.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
