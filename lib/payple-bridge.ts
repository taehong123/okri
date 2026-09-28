import { decryptPrivateValue, encryptPrivateValue } from "./secret-crypto";
import { inquirePaypleKey, paypleSdk, PaypleError, type PaypleConfig } from "./payple-api";

export const PAYPLE_BRIDGE_ORIGIN = "https://mamuree.com";
export const PAYPLE_BRIDGE_PATH = "/api/public/payple/okri";
type Runtime = PaypleConfig & { DB: D1Database; PAYPLE_BILLING_KEY_ENCRYPTION_KEY?: string; PAYPLE_CHECKOUT_VERIFIED?: string; PAYPLE_PILOT_USER_ID?: string };
type Session = { token_hash: string; workspace_id: string; user_id: string; plan: string; price_won: number };

export function paypleBridgeUrl(config: PaypleConfig, token: string) {
  if (!config.PAYPLE_CHECKOUT_ORIGIN) return null;
  if (config.PAYPLE_CHECKOUT_ORIGIN !== PAYPLE_BRIDGE_ORIGIN) throw new PaypleError("payple_invalid_checkout_origin");
  // Fragment tokens never enter proxy request/access logs or Referer headers.
  return `${PAYPLE_BRIDGE_ORIGIN}${PAYPLE_BRIDGE_PATH}/bridge#${encodeURIComponent(token)}`;
}

async function sessionFor(runtime: Runtime, token: string) {
  if (runtime.PAYPLE_CHECKOUT_VERIFIED !== "true" || runtime.PAYPLE_CHECKOUT_ORIGIN !== PAYPLE_BRIDGE_ORIGIN
    || !runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY) throw new PaypleError("payple_bridge_unavailable");
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new PaypleError("payple_invalid_session");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const session = await runtime.DB.prepare(`SELECT token_hash,workspace_id,user_id,plan,price_won FROM billing_sessions
    WHERE token_hash=? AND used_at IS NULL AND expires_at>?`).bind(hash, new Date().toISOString()).first<Session>();
  if (!session) throw new PaypleError("payple_invalid_session");
  if (runtime.PAYPLE_PILOT_USER_ID && runtime.PAYPLE_PILOT_USER_ID !== session.user_id) throw new PaypleError("payple_bridge_unavailable");
  return session;
}

export function assertPaypleBridgeRequest(request: Request) {
  if (new URL(request.url).origin !== PAYPLE_BRIDGE_ORIGIN
    || request.headers.get("origin") !== PAYPLE_BRIDGE_ORIGIN
    || request.headers.get("sec-fetch-site") === "cross-site") throw new PaypleError("payple_bridge_origin");
}

export async function readPaypleBridgeSession(runtime: Runtime, token: string) {
  const session = await sessionFor(runtime, token);
  return { ...paypleSdk(runtime), plan: session.plan, priceWon: session.price_won,
    firstPaymentWon: await firstPaymentWon(runtime, session) };
}

async function firstPaymentWon(runtime: Runtime, session: Session) {
  const usedTrial = await runtime.DB.prepare(`SELECT 1 FROM billing_trial_claims WHERE billing_owner_user_id=
    (SELECT owner_user_id FROM workspaces WHERE id=?) LIMIT 1`).bind(session.workspace_id).first();
  return usedTrial ? session.price_won : 0;
}

export async function stagePaypleBridgeResult(runtime: Runtime, token: string, result: Record<string, unknown>, consent: {
  accepted: boolean; firstPaymentWon: unknown; priceWon: unknown;
}) {
  const session = await sessionFor(runtime, token);
  if (!consent.accepted || consent.priceWon !== session.price_won || consent.firstPaymentWon !== await firstPaymentWon(runtime, session)) {
    throw new PaypleError("payple_consent_changed");
  }
  if (result.PCD_PAY_RST !== "success" || result.PCD_PAY_TYPE !== "card" || result.PCD_PAY_WORK !== "AUTH"
    || typeof result.PCD_PAYER_ID !== "string") throw new PaypleError("payple_invalid_result");
  const verified = await inquirePaypleKey(runtime, result.PCD_PAYER_ID);
  const encrypted = await encryptPrivateValue(JSON.stringify({ ...verified, firstPaymentWon: consent.firstPaymentWon,
    consentedAt: new Date().toISOString() }), runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY!);
  // First result wins. This endpoint stages a key only, never charges or grants a plan.
  await runtime.DB.prepare(`INSERT OR IGNORE INTO billing_payple_bridge_results (token_hash,encrypted_result,created_at)
    VALUES (?,?,?)`).bind(session.token_hash, encrypted, new Date().toISOString()).run();
  return { returnUrl: `https://okri.ai/?view=billing&payple=return#${encodeURIComponent(token)}` };
}

export async function requirePaypleImmediateConsent(runtime: Runtime, hash: string, priceWon: number) {
  const row = await runtime.DB.prepare("SELECT encrypted_result FROM billing_payple_bridge_results WHERE token_hash=?")
    .bind(hash).first<{ encrypted_result: string }>();
  if (!row || !runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY) throw new PaypleError("payple_immediate_consent_required");
  const result = JSON.parse(await decryptPrivateValue(row.encrypted_result, runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY));
  if (result.firstPaymentWon !== priceWon || !result.consentedAt) throw new PaypleError("payple_immediate_consent_required");
}

export async function consumePaypleBridgeResult(runtime: Runtime, token: string, workspaceId: string, userId: string) {
  const session = await sessionFor(runtime, token);
  if (session.workspace_id !== workspaceId || session.user_id !== userId) throw new PaypleError("payple_session_owner");
  const row = await runtime.DB.prepare("SELECT encrypted_result FROM billing_payple_bridge_results WHERE token_hash=?")
    .bind(session.token_hash).first<{ encrypted_result: string }>();
  if (!row) throw new PaypleError("payple_result_missing");
  const result = JSON.parse(await decryptPrivateValue(row.encrypted_result, runtime.PAYPLE_BILLING_KEY_ENCRYPTION_KEY!)) as {
    billingKey: string; maskedCard: string; cardCompany: string;
  };
  return { ...result, payerId: result.billingKey, sessionToken: token, workspaceId, userId };
}
