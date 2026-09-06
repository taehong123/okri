import { createPaypleSession, parseBillingPlan } from "@/lib/billing";
import { authorizeBillingOwner } from "@/lib/billing-route";

export async function POST(request: Request) {
  const authorization = await authorizeBillingOwner(request);
  if (authorization instanceof Response) return authorization;
  if (authorization.role !== "owner") return Response.json({ error: "결제수단과 플랜은 Owner만 관리할 수 있습니다." }, { status: 403 });
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  const plan = parseBillingPlan(payload?.plan);
  if (!plan || plan === "free") return Response.json({ error: "Team 또는 Business 플랜을 선택해 주세요." }, { status: 400 });
  try {
    return Response.json(await createPaypleSession(authorization.ownerId, authorization.userId, plan, payload?.contractAccepted === true), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "카드 등록 세션을 만들지 못했습니다.";
    return Response.json({ error: message, code: /운영 승인|설정/.test(message) ? "billing_not_configured" : "session_failed" }, { status: /운영 승인|설정/.test(message) ? 503 : 400 });
  }
}
