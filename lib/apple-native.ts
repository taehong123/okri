import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import { decryptSecret, encryptSecret } from "./google-oauth";
import { digest, randomToken } from "./native-session";

export type AppleNativeEnv = {
  APPLE_TEAM_ID?: string; APPLE_KEY_ID?: string; APPLE_PRIVATE_KEY?: string;
  APPLE_BUNDLE_ID?: string; GOOGLE_TOKEN_ENCRYPTION_KEY?: string; DB: D1Database;
};
const keys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
export function appleConfigured(runtime: AppleNativeEnv) {
  return !!(runtime.APPLE_TEAM_ID && runtime.APPLE_KEY_ID && runtime.APPLE_PRIVATE_KEY && runtime.GOOGLE_TOKEN_ENCRYPTION_KEY);
}
export async function appleChallenge(db: D1Database) {
  const nonce = randomToken();
  await db.prepare("INSERT INTO native_apple_nonces(nonce_hash,expires_at) VALUES(?,?)")
    .bind(await digest(nonce), new Date(Date.now() + 300000).toISOString()).run();
  return nonce;
}
export async function verifyAppleToken(token: string, nonce: string, audience: string, resolver = keys) {
  const { payload } = await jwtVerify(token, resolver, { issuer: "https://appleid.apple.com", audience, algorithms: ["RS256"], maxTokenAge: "10m" });
  if (payload.nonce !== nonce || !payload.sub || typeof payload.email !== "string" ||
      (payload.email_verified !== true && payload.email_verified !== "true")) throw new Error("Invalid Apple identity");
  return { subject: payload.sub, email: payload.email, issuedAt: payload.iat! };
}
async function clientSecret(runtime: AppleNativeEnv) {
  if (!appleConfigured(runtime)) throw new Error("Apple login is not configured");
  const key = await importPKCS8(runtime.APPLE_PRIVATE_KEY!.replaceAll("\\n", "\n"), "ES256");
  return new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: runtime.APPLE_KEY_ID! })
    .setIssuer(runtime.APPLE_TEAM_ID!).setAudience("https://appleid.apple.com")
    .setSubject(runtime.APPLE_BUNDLE_ID || "ai.okri.app").setIssuedAt().setExpirationTime("5m").sign(key);
}
export async function acceptAppleCredential(runtime: AppleNativeEnv, input: { identityToken: string; nonce: string; authorizationCode: string }) {
  if (!/^[a-f0-9]{64}$/.test(input.nonce) || input.authorizationCode.length > 2048 || input.identityToken.length > 10000) throw new Error("Invalid Apple credential");
  const identity = await verifyAppleToken(input.identityToken, input.nonce, runtime.APPLE_BUNDLE_ID || "ai.okri.app");
  const nonce = await runtime.DB.prepare("UPDATE native_apple_nonces SET used_at = ? WHERE nonce_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING nonce_hash")
    .bind(new Date().toISOString(), await digest(input.nonce), new Date().toISOString()).first();
  if (!nonce) throw new Error("Apple sign-in expired");
  const response = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: runtime.APPLE_BUNDLE_ID || "ai.okri.app", client_secret: await clientSecret(runtime), grant_type: "authorization_code", code: input.authorizationCode }),
    signal: AbortSignal.timeout(15000),
  });
  const tokens = await response.json() as { refresh_token?: string; id_token?: string };
  if (!response.ok || !tokens.refresh_token || !tokens.id_token) throw new Error("Apple authorization failed");
  const exchanged = await verifyAppleToken(tokens.id_token, input.nonce, runtime.APPLE_BUNDLE_ID || "ai.okri.app");
  if (exchanged.subject !== identity.subject || exchanged.email !== identity.email) throw new Error("Apple identity mismatch");
  return { ...identity, encryptedRefreshToken: await encryptSecret(tokens.refresh_token, runtime.GOOGLE_TOKEN_ENCRYPTION_KEY!) };
}
export async function saveAppleGrant(runtime: AppleNativeEnv, userId: string, subject: string, encrypted: string) {
  await runtime.DB.prepare("INSERT INTO native_apple_grants(user_id,subject,encrypted_token) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET subject=excluded.subject,encrypted_token=excluded.encrypted_token")
    .bind(userId, subject, encrypted).run();
}
export async function revokeAppleGrant(runtime: AppleNativeEnv, userId: string) {
  const grant = await runtime.DB.prepare("SELECT encrypted_token FROM native_apple_grants WHERE user_id = ?").bind(userId).first<{ encrypted_token: string }>();
  if (!grant) return;
  const response = await fetch("https://appleid.apple.com/auth/revoke", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: runtime.APPLE_BUNDLE_ID || "ai.okri.app", client_secret: await clientSecret(runtime),
      token: await decryptSecret(grant.encrypted_token, runtime.GOOGLE_TOKEN_ENCRYPTION_KEY!), token_type_hint: "refresh_token" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Apple authorization could not be revoked");
  await runtime.DB.prepare("DELETE FROM native_apple_grants WHERE user_id = ?").bind(userId).run();
}
