import { completePaypleRegistration } from "@/lib/billing";
import { authorizeBillingOwner, billingErrorResponse } from "@/lib/billing-route";

export async function POST(request: Request) {
  const authorization = await authorizeBillingOwner(request);
  if (authorization instanceof Response) return authorization;
  if (authorization.role !== "owner") return Response.json({ error: "결제수단은 Owner만 등록할 수 있습니다." }, { status: 403 });
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  const required = ["sessionToken", "billingKey", "payerId"] as const;
  if (!payload || required.some((key) => typeof payload[key] !== "string" || !String(payload[key]).trim())) {
    return Response.json({ error: "Payple 카드 등록 결과가 올바르지 않습니다." }, { status: 400 });
  }
  try {
    return Response.json(await completePaypleRegistration({
      workspaceId: authorization.ownerId,
      userId: authorization.userId,
      sessionToken: String(payload.sessionToken),
      billingKey: String(payload.billingKey),
      payerId: String(payload.payerId),
      maskedCard: typeof payload.maskedCard === "string" ? payload.maskedCard : "",
      cardCompany: typeof payload.cardCompany === "string" ? payload.cardCompany : "",
      paypleTransactionId: typeof payload.paypleTransactionId === "string" ? payload.paypleTransactionId : undefined,
    }));
  } catch (error) {
    return billingErrorResponse(error);
  }
}
