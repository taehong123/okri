import { authorizeRequest } from "@/lib/pace-data";
import { PayPalError } from "./paypal-api";

export async function authorizeBillingOwner(request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "이 사이트에서 다시 시도해 주세요." }, { status: 403 });
  }
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  if (authorization.role !== "owner" || authorization.apiToken) {
    return Response.json({ error: "결제수단과 플랜은 Owner만 관리할 수 있습니다." }, { status: 403 });
  }
  return authorization;
}

export function billingErrorResponse(error: unknown) {
  const code = error instanceof PayPalError ? error.code : "billing_request_failed";
  console.error("Billing request failed", code);
  return Response.json({ code, error: "결제를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }, {
    status: error instanceof PayPalError ? error.status : 502, headers: { "Cache-Control": "no-store" },
  });
}
