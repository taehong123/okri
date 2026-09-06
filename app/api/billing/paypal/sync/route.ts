import { syncPayPalWorkspace } from "@/lib/billing-paypal";
import { authorizeBillingOwner, billingErrorResponse } from "@/lib/billing-route";

export async function POST(request: Request) {
  const authorization = await authorizeBillingOwner(request);
  if (authorization instanceof Response) return authorization;
  try { return Response.json(await syncPayPalWorkspace(authorization.ownerId), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return billingErrorResponse(error); }
}
