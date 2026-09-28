import { env } from "cloudflare:workers";
import { consumePaypleBridgeResult } from "@/lib/payple-bridge";
import { completePaypleRegistration } from "@/lib/billing";
import { authorizeBillingOwner, billingErrorResponse } from "@/lib/billing-route";

export async function POST(request: Request) {
  const owner = await authorizeBillingOwner(request);
  if (owner instanceof Response) return owner;
  try {
    const body = await request.json() as { sessionToken?: unknown };
    if (typeof body.sessionToken !== "string") throw new Error("invalid_session");
    const input = await consumePaypleBridgeResult(env, body.sessionToken, owner.ownerId, owner.userId);
    return Response.json(await completePaypleRegistration(input), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return billingErrorResponse(error); }
}
