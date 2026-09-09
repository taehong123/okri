import { authorizeRequest, ensureWorkspace } from "@/lib/pace-data";
import {
  listLocalAgentDevices,
  localAgentErrorResponse,
  revokeLocalAgentDevice,
} from "@/lib/local-agent";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    await ensureWorkspace(authorization.ownerId);
    return Response.json({ devices: await listLocalAgentDevices(authorization) }, { headers: noStore });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const payload = await request.json() as Record<string, unknown>;
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) return Response.json({ error: "id is required" }, { status: 400, headers: noStore });
    return Response.json({ device: await revokeLocalAgentDevice(authorization, id) }, { headers: noStore });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
