import { authorizeLocalAgentDevice } from "@/lib/local-agent";

export async function POST(request: Request) {
  const device = await authorizeLocalAgentDevice(request);
  if (device instanceof Response) return device;
  return Response.json({ active: true, deviceId: device.id }, { headers: { "Cache-Control": "no-store" } });
}
