import { refundFirstPayment } from "@/lib/billing";
import { authorizeBillingOwner, billingErrorResponse } from "@/lib/billing-route";
import { PayPalError } from "@/lib/paypal-api";

export async function POST(request: Request) {
  const authorization = await authorizeBillingOwner(request);
  if (authorization instanceof Response) return authorization;
  if (authorization.role !== "owner") return Response.json({ error: "환불은 Owner만 요청할 수 있습니다." }, { status: 403 });
  try {
    return Response.json(await refundFirstPayment(authorization.ownerId));
  } catch (error) {
    if (error instanceof PayPalError) return billingErrorResponse(error);
    return Response.json({ error: error instanceof Error ? error.message : "환불을 처리하지 못했습니다." }, { status: 400 });
  }
}
