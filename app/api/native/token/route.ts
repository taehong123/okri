import { env } from "cloudflare:workers";
import { exchangeNativeCode } from "@/lib/native-session";
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (typeof body?.code !== "string" || typeof body?.verifier !== "string") return Response.json({ error: "Invalid token request" }, { status: 400 });
  const session = await exchangeNativeCode(env.DB, body.code, body.verifier);
  return Response.json(session ?? { error: "Sign in again", code: "invalid_grant" }, { status: session ? 200 : 400, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
}
