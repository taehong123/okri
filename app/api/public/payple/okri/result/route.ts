import { env } from "cloudflare:workers";
import { assertPaypleBridgeRequest, stagePaypleBridgeResult } from "@/lib/payple-bridge";

export async function POST(request: Request) {
  try {
    assertPaypleBridgeRequest(request);
    const text = await request.text();
    if (text.length > 16384) throw new Error("invalid_result");
    const body = JSON.parse(text) as { sessionToken?: unknown; result?: Record<string, unknown>; accepted?: boolean; firstPaymentWon?: unknown; priceWon?: unknown };
    if (typeof body.sessionToken !== "string" || !body.result) throw new Error("invalid_result");
    return Response.json(await stagePaypleBridgeResult(env, body.sessionToken, body.result,
      { accepted: body.accepted === true, firstPaymentWon: body.firstPaymentWon, priceWon: body.priceWon }), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ code: "payple_result_unconfirmed" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
