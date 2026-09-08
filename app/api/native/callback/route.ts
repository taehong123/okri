import { env } from "cloudflare:workers";
import { authorizeRequest } from "@/lib/pace-data";
import { issueNativeCode, validChallenge, validState } from "@/lib/native-session";
import { clearNativeFlowCookie, validNativeBrowserFlow } from "@/lib/native-browser-flow";
export async function GET(request: Request) {
  const url = new URL(request.url), challenge = url.searchParams.get("challenge") || "", state = url.searchParams.get("state") || "";
  if (!validChallenge(challenge) || !validState(state)) return Response.json({ error: "Invalid sign-in request" }, { status: 400 });
  if (!await validNativeBrowserFlow(request, challenge, state, (env as { GOOGLE_TOKEN_ENCRYPTION_KEY?: string }).GOOGLE_TOKEN_ENCRYPTION_KEY)) return Response.json({ error: "Sign-in has expired. Restart from the app." }, { status: 400 });
  const target = new URL("okri://auth");
  target.searchParams.set("state", state);
  if (url.searchParams.has("auth")) target.searchParams.set("error", "sign_in_failed");
  else {
    const auth = await authorizeRequest(request, { allowViewerWrite: true });
    if (auth instanceof Response || auth.apiToken || request.headers.has("authorization")) target.searchParams.set("error", "sign_in_failed");
    else target.searchParams.set("code", await issueNativeCode(env.DB, auth.userId, challenge));
  }
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Set-Cookie": clearNativeFlowCookie() } });
}
