import { issueNativeSession } from "./native-session";

export type NativeReviewEnv = {
  DB: D1Database;
  OKRI_MOBILE_REVIEW_USERNAME?: string;
  OKRI_MOBILE_REVIEW_PASSWORD?: string;
};

const REVIEW_EMAIL = "google-play-review@okri.invalid";
const REVIEW_NAME = "Google Play Review";

export function reviewAccessConfigured(runtime: NativeReviewEnv) {
  return typeof runtime.OKRI_MOBILE_REVIEW_USERNAME === "string"
    && runtime.OKRI_MOBILE_REVIEW_USERNAME.length >= 8
    && typeof runtime.OKRI_MOBILE_REVIEW_PASSWORD === "string"
    && runtime.OKRI_MOBILE_REVIEW_PASSWORD.length >= 24;
}

async function secureStringEqual(left: string, right: string) {
  const encode = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [leftHash, rightHash] = await Promise.all([encode(left), encode(right)]);
  const a = new Uint8Array(leftHash), b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function authenticateNativeReviewer(runtime: NativeReviewEnv, username: string, password: string) {
  if (!reviewAccessConfigured(runtime) || username.length > 160 || password.length > 256) return null;
  const [usernameMatches, passwordMatches] = await Promise.all([
    secureStringEqual(username, runtime.OKRI_MOBILE_REVIEW_USERNAME!),
    secureStringEqual(password, runtime.OKRI_MOBILE_REVIEW_PASSWORD!),
  ]);
  if (!usernameMatches || !passwordMatches) return null;

  const now = new Date().toISOString();
  await runtime.DB.prepare(`INSERT OR IGNORE INTO users
    (id, email_normalized, language_preference, resolved_language, language_revision, onboarding_state, display_name, created_at, updated_at)
    VALUES (?, ?, 'en', 'en', 0, NULL, ?, ?, ?)`)
    .bind(crypto.randomUUID(), REVIEW_EMAIL, REVIEW_NAME, now, now).run();
  const reviewer = await runtime.DB.prepare("SELECT id FROM users WHERE email_normalized = ? LIMIT 1")
    .bind(REVIEW_EMAIL).first<{ id: string }>();
  return reviewer ? issueNativeSession(runtime.DB, reviewer.id) : null;
}
