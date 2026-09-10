import { createPayPalCheckout } from "@/lib/billing-paypal";
import { getWorkspaceSubscription } from "@/lib/billing";
import { authorizeBillingOwner, billingErrorResponse } from "@/lib/billing-route";

export async function POST(request: Request) {
  const authorization = await authorizeBillingOwner(request);
  if (authorization instanceof Response) return authorization;
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input || !["team", "business"].includes(String(input.plan)) || input.contractAccepted !== true) {
    return Response.json({ error: "요금제와 자동 갱신 조건을 확인해 주세요." }, { status: 400 });
  }
  try {
    await getWorkspaceSubscription(authorization.ownerId);
    return Response.json(await createPayPalCheckout(authorization.ownerId, authorization.userId, input.plan as "team" | "business", {
      currency: input.currency, value: input.value, seats: input.seats,
    }), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return billingErrorResponse(error); }
}
