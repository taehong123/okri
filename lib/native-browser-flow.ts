import { decryptSecret, encryptSecret } from "./google-oauth";
const COOKIE = "__Host-okri_native_flow";
const attributes = "Path=/; HttpOnly; Secure; SameSite=Lax";
export async function nativeFlowCookie(challenge: string, state: string, secret: string) {
  const value = await encryptSecret(JSON.stringify({ challenge, state, expires: Date.now() + 600000 }), secret);
  return `${COOKIE}=${encodeURIComponent(value)}; ${attributes}; Max-Age=600`;
}
export function clearNativeFlowCookie() { return `${COOKIE}=; ${attributes}; Max-Age=0`; }
export async function validNativeBrowserFlow(request: Request, challenge: string, state: string, secret?: string) {
  if (!secret) return false;
  const cookie = request.headers.get("cookie")?.split(";").map(c => c.trim()).find(c => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (!cookie) return false;
  try {
    const flow = JSON.parse(await decryptSecret(decodeURIComponent(cookie), secret));
    return flow.challenge === challenge && flow.state === state && typeof flow.expires === "number" && flow.expires > Date.now();
  } catch { return false; }
}
