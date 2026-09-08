import { validChallenge, validState } from "@/lib/native-session";
import { env } from "cloudflare:workers";
import { nativeFlowCookie } from "@/lib/native-browser-flow";
export async function GET(request: Request) {
  const url = new URL(request.url), challenge = url.searchParams.get("challenge") || "", state = url.searchParams.get("state") || "";
  if (!validChallenge(challenge) || !validState(state)) return Response.json({ error: "Invalid sign-in request" }, { status: 400 });
  const secret = (env as { GOOGLE_TOKEN_ENCRYPTION_KEY?: string }).GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!secret) return Response.json({ error: "Sign-in is unavailable" }, { status: 503 });
  const callback = "/api/native/callback?challenge=" + encodeURIComponent(challenge) + "&state=" + encodeURIComponent(state);
  const login = new URL("/api/auth/google", request.url);
  login.searchParams.set("returnTo", callback);
  return new Response(null, { status: 302, headers: { Location: login.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Set-Cookie": await nativeFlowCookie(challenge, state, secret) } });
}
