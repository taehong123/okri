import { isLanguage, type Language } from "./language";

export const ANDROID_TEST_CONSENT_VERSION = "2026-09-26";

type Statement = {
  bind: (...values: unknown[]) => Statement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<unknown>;
};

export type AndroidTestDatabase = {
  prepare: (sql: string) => Statement;
};

export type AndroidTestSignup = {
  email: string;
  phone: string;
  language: Language;
  consent: true;
  website: string;
};

export type AndroidTestAccess = { token: string; hash: string };

export type AndroidTestPortal = {
  id: string;
  email: string;
  phoneLastFour: string;
  language: Language;
  status: string;
  invitedAt: string | null;
  optedInAt: string | null;
  eligibleAt: string | null;
  rewardedAt: string | null;
  feedback: Array<{ id: string; message: string; createdAt: string }>;
};

export class AndroidTestSignupError extends Error {
  constructor(public code: "invalid_email" | "invalid_phone" | "consent_required" | "invalid_request" | "invalid_feedback" | "invalid_access") {
    super(code);
  }
}

export function normalizeAndroidTestEmail(value: unknown) {
  if (typeof value !== "string") throw new AndroidTestSignupError("invalid_email");
  const email = value.normalize("NFKC").trim().toLowerCase();
  const hasControlCharacter = [...email].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (email.length < 3 || email.length > 254 || hasControlCharacter || /\s/.test(email)
    || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) throw new AndroidTestSignupError("invalid_email");
  return email;
}

export function normalizeAndroidTestPhone(value: unknown) {
  if (typeof value !== "string") throw new AndroidTestSignupError("invalid_phone");
  const normalized = value.normalize("NFKC").trim().replace(/[\s().-]/g, "");
  const digits = normalized.startsWith("+") ? normalized.slice(1) : normalized;
  if (!/^\d{8,15}$/.test(digits) || (!normalized.startsWith("+") && !/^0\d{8,14}$/.test(normalized))) {
    throw new AndroidTestSignupError("invalid_phone");
  }
  return normalized.startsWith("+") ? `+${digits}` : digits;
}

export function parseAndroidTestSignup(payload: unknown): AndroidTestSignup {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AndroidTestSignupError("invalid_request");
  const value = payload as Record<string, unknown>;
  if (value.consent !== true) throw new AndroidTestSignupError("consent_required");
  return {
    email: normalizeAndroidTestEmail(value.email),
    phone: normalizeAndroidTestPhone(value.phone),
    language: isLanguage(value.language) ? value.language : "en",
    consent: true,
    website: typeof value.website === "string" ? value.website.slice(0, 200) : "",
  };
}

export function parseAndroidTestFeedback(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AndroidTestSignupError("invalid_request");
  const value = payload as Record<string, unknown>;
  const access = typeof value.access === "string" ? value.access.trim() : "";
  const message = typeof value.message === "string" ? value.message.normalize("NFKC").trim() : "";
  if (!/^[A-Za-z0-9_-]{32,96}$/.test(access)) throw new AndroidTestSignupError("invalid_access");
  if (message.length < 3 || message.length > 2_000 || hasControlCharacter(message)) throw new AndroidTestSignupError("invalid_feedback");
  return { access, message };
}

export async function createAndroidTestAccess(): Promise<AndroidTestAccess> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(bytes);
  return { token, hash: await hashAccessToken(token) };
}

export async function hashAccessToken(token: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

export async function saveAndroidTestSignup(db: AndroidTestDatabase, input: AndroidTestSignup & {
  encryptedPhone: string;
  phoneLastFour: string;
  accessTokenHash: string;
}, now = new Date()) {
  const timestamp = now.toISOString();
  await db.prepare(`INSERT INTO android_test_signups (
      id, email_normalized, encrypted_phone, phone_last_four, access_token_hash, language, status,
      consent_version, consent_accepted_at, first_applied_at, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email_normalized) DO UPDATE SET
      encrypted_phone=excluded.encrypted_phone,
      phone_last_four=excluded.phone_last_four,
      access_token_hash=excluded.access_token_hash,
      language=excluded.language,
      status=CASE WHEN android_test_signups.status='cancelled' THEN 'applied' ELSE android_test_signups.status END,
      consent_version=excluded.consent_version,
      consent_accepted_at=excluded.consent_accepted_at,
      last_applied_at=excluded.last_applied_at,
      updated_at=excluded.updated_at`)
    .bind(crypto.randomUUID(), input.email, input.encryptedPhone, input.phoneLastFour, input.accessTokenHash, input.language,
      ANDROID_TEST_CONSENT_VERSION, timestamp, timestamp, timestamp, timestamp, timestamp).run();
}

export async function findAndroidTestPortal(db: AndroidTestDatabase, access: string): Promise<AndroidTestPortal | null> {
  if (!/^[A-Za-z0-9_-]{32,96}$/.test(access)) return null;
  const hash = await hashAccessToken(access);
  const signup = await db.prepare(`SELECT id, email_normalized, phone_last_four, language, status,
      invited_at, opted_in_at, eligible_at, rewarded_at
    FROM android_test_signups WHERE access_token_hash = ?`).bind(hash).first<{
      id: string; email_normalized: string; phone_last_four: string; language: Language; status: string;
      invited_at: string | null; opted_in_at: string | null; eligible_at: string | null; rewarded_at: string | null;
    }>();
  if (!signup) return null;
  const feedbackRows = await db.prepare(`SELECT id, message, created_at FROM android_test_feedback
    WHERE signup_id = ? ORDER BY created_at DESC LIMIT 30`).bind(signup.id).all<{ id: string; message: string; created_at: string }>();
  return {
    id: signup.id,
    email: maskEmail(signup.email_normalized),
    phoneLastFour: signup.phone_last_four,
    language: isLanguage(signup.language) ? signup.language : "en",
    status: signup.status,
    invitedAt: signup.invited_at,
    optedInAt: signup.opted_in_at,
    eligibleAt: signup.eligible_at,
    rewardedAt: signup.rewarded_at,
    feedback: feedbackRows.results.map((feedback) => ({ id: feedback.id, message: feedback.message, createdAt: feedback.created_at })),
  };
}

export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

export function phoneLastFour(phone: string) { return phone.slice(-4); }

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
