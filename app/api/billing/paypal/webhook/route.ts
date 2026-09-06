import { ensureBillingSchema } from "@/lib/billing";
import { receivePayPalWebhook } from "@/lib/billing-paypal";
import { billingErrorResponse } from "@/lib/billing-route";

export async function POST(request: Request) {
  try {
    await ensureBillingSchema();
    return Response.json(await receivePayPalWebhook(request));
  } catch (error) { return billingErrorResponse(error); }
}
