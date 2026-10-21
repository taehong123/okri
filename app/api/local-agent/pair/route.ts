import { claimLocalAgentPairing, localAgentErrorResponse } from "@/lib/local-agent";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const result = await claimLocalAgentPairing({
      code: payload.code,
      name: payload.name,
      platform: payload.platform,
    });
    const { finishTicketPortPairing } = await import("@/lib/ticket-automation");
    await finishTicketPortPairing(result.device.id);
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
