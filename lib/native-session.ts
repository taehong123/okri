export const NATIVE_TOKEN_PREFIX = "okri_native_";
const DURATION = 30 * 24 * 60 * 60 * 1000;
export type NativeIdentity = { id: string; email: string; displayName: string; createdAt: string };

export async function digest(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
}
export async function challengeFor(verifier: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
export function validChallenge(value: string) { return /^[A-Za-z0-9_-]{43}$/.test(value); }
export function validState(value: string) { return /^[A-Za-z0-9_-]{32,128}$/.test(value); }

// Tables are installed by migration 0054, not lazily during authentication.
export async function issueNativeCode(db: D1Database, userId: string, challenge: string) {
  if (!validChallenge(challenge)) throw new Error("Invalid PKCE challenge");
  const code = randomToken();
  await db.prepare("INSERT INTO native_auth_codes(code_hash, user_id, challenge, expires_at) VALUES(?,?,?,?)")
    .bind(await digest(code), userId, challenge, new Date(Date.now() + 120000).toISOString()).run();
  return code;
}
export async function exchangeNativeCode(db: D1Database, code: string, verifier: string) {
  if (!/^[a-f0-9]{64}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return null;
  const row = await db.prepare("UPDATE native_auth_codes SET used_at = ? WHERE code_hash = ? AND challenge = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id")
    .bind(new Date().toISOString(), await digest(code), await challengeFor(verifier), new Date().toISOString()).first<{ user_id: string }>();
  if (!row) return null;
  return issueNativeSession(db, row.user_id);
}
export async function issueNativeSession(db: D1Database, userId: string) {
  const user = await db.prepare("SELECT id, email_normalized AS email, display_name AS displayName FROM users WHERE id = ?").bind(userId)
    .first<{ id: string; email: string; displayName: string }>();
  if (!user) return null;
  const accessToken = NATIVE_TOKEN_PREFIX + randomToken();
  const expiresAt = new Date(Date.now() + DURATION).toISOString();
  await db.prepare("INSERT INTO native_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)")
    .bind(await digest(accessToken), userId, new Date().toISOString(), expiresAt).run();
  return { accessToken, expiresAt, user };
}
export async function readNativeIdentity(db: D1Database, token: string): Promise<NativeIdentity | null> {
  if (!/^okri_native_[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare("SELECT u.id, u.email_normalized AS email, u.display_name AS displayName, s.created_at AS createdAt FROM native_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?")
    .bind(await digest(token), new Date().toISOString()).first<NativeIdentity>();
}
export async function revokeNativeSession(db: D1Database, token: string) {
  await db.prepare("UPDATE native_sessions SET revoked_at = ? WHERE token_hash = ?")
    .bind(new Date().toISOString(), await digest(token)).run();
}
