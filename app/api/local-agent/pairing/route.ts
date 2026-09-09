import { authorizeRequest, ensureWorkspace } from "@/lib/pace-data";
import {
  createLocalAgentPairing,
  getLocalAgentPairingStatus,
  localAgentErrorResponse,
} from "@/lib/local-agent";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id) return Response.json({ error: "id is required" }, { status: 400, headers: noStore });
    return Response.json({ pairing: await getLocalAgentPairingStatus(authorization, id) }, { headers: noStore });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    await ensureWorkspace(authorization.ownerId);
    return Response.json({ pairing: await createLocalAgentPairing(authorization) }, { status: 201, headers: noStore });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
