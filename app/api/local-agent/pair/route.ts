import { claimLocalAgentPairing, localAgentErrorResponse } from "@/lib/local-agent";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const result = await claimLocalAgentPairing({
      code: payload.code,
      name: payload.name,
      platform: payload.platform,
    });
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
