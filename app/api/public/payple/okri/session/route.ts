import { env } from "cloudflare:workers";
import { assertPaypleBridgeRequest, readPaypleBridgeSession } from "@/lib/payple-bridge";

export async function POST(request: Request) {
  try {
    assertPaypleBridgeRequest(request);
    const body = await request.json() as { sessionToken?: unknown };
    if (typeof body.sessionToken !== "string") throw new Error("invalid_session");
    return Response.json(await readPaypleBridgeSession(env, body.sessionToken), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ code: "payple_bridge_unavailable" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
