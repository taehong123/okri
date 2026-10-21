import { authorizeLocalAgentDevice } from "@/lib/local-agent";

export async function POST(request: Request) {
  const device = await authorizeLocalAgentDevice(request);
  if (device instanceof Response) return device;
  const payload = await request.json().catch(() => ({})) as { models?: unknown;repositoryRemote?:unknown };
  if (payload.models) {
    const { recordTicketPortModels } = await import("@/lib/ticket-automation");
      await recordTicketPortModels(device, payload.models,payload.repositoryRemote);
  }
  return Response.json({ active: true, deviceId: device.id }, { headers: { "Cache-Control": "no-store" } });
}
