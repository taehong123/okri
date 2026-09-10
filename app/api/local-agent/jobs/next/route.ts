import {
  authorizeLocalAgentDevice,
  claimNextLocalAgentJob,
  localAgentErrorResponse,
} from "@/lib/local-agent";

export async function POST(request: Request) {
  const device = await authorizeLocalAgentDevice(request);
  if (device instanceof Response) return device;
  try {
    return Response.json({ job: await claimNextLocalAgentJob(device) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localAgentErrorResponse(error);
  }
}
