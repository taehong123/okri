import { changePlan, parseBillingPlan } from "@/lib/billing";
import { authorizeBillingOwner } from "@/lib/billing-route";

export async function POST(request: Request) {
  const authorization = await authorizeBillingOwner(request);
  if (authorization instanceof Response) return authorization;
  if (authorization.role !== "owner") return Response.json({ error: "플랜은 Owner만 변경할 수 있습니다." }, { status: 403 });
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  const plan = parseBillingPlan(payload?.plan);
  if (!plan) return Response.json({ error: "지원하는 플랜을 선택해 주세요." }, { status: 400 });
  try {
    return Response.json(await changePlan(authorization.ownerId, plan));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "플랜을 변경하지 못했습니다." }, { status: 400 });
  }
}
