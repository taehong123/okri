import { env } from "cloudflare:workers";
import { acceptAppleCredential, appleChallenge, appleConfigured, saveAppleGrant, type AppleNativeEnv } from "@/lib/apple-native";
import { canonicalUserIdForVerifiedIdentity } from "@/lib/pace-data";
import { issueNativeSession } from "@/lib/native-session";
const runtime = () => env as unknown as AppleNativeEnv;
export async function GET() {
  if (!appleConfigured(runtime())) return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  return Response.json({ enabled: true }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  if (!appleConfigured(runtime())) return Response.json({ error: "Apple sign-in is not configured" }, { status: 503 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (body?.action === "challenge") return Response.json({ nonce: await appleChallenge(env.DB) }, { headers: { "Cache-Control": "no-store" } });
  if (!body || ["identityToken", "nonce", "authorizationCode"].some(k => typeof body[k] !== "string")) return Response.json({ error: "Invalid Apple sign-in" }, { status: 400 });
  try {
    const identity = await acceptAppleCredential(runtime(), body as { identityToken: string; nonce: string; authorizationCode: string });
    const name = typeof body.name === "string" ? body.name.slice(0, 80) : "";
    const userId = await canonicalUserIdForVerifiedIdentity(identity.subject, identity.email, name, request, "apple", identity.issuedAt);
    await saveAppleGrant(runtime(), userId, identity.subject, identity.encryptedRefreshToken);
    return Response.json(await issueNativeSession(env.DB, userId), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Apple sign-in failed. Try again.", code: "apple_sign_in_failed" }, { status: 400 });
  }
}
