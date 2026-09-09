import { authorizeRequest, ensureWorkspace } from "@/lib/pace-data";
import {
  createLocalAgentJob,
  listLocalAgentJobs,
  localAgentErrorResponse,
} from "@/lib/local-agent";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    await ensureWorkspace(authorization.ownerId);
    const url = new URL(request.url);
    return Response.json({ jobs: await listLocalAgentJobs(authorization, {
      targetKind: url.searchParams.get("targetKind") ?? undefined,
      targetId: url.searchParams.get("targetId") ?? undefined,
    }) }, { headers: noStore });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    await ensureWorkspace(authorization.ownerId);
    const payload = await request.json() as Record<string, unknown>;
    const job = await createLocalAgentJob(authorization, {
      deviceId: payload.deviceId,
      targetKind: payload.targetKind,
      targetId: payload.targetId,
      instruction: payload.instruction,
    });
    return Response.json({ job }, { status: 201, headers: noStore });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
