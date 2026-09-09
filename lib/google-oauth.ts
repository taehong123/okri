export type GoogleRuntimeEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  GOOGLE_TOKEN_ENCRYPTION_KEY?: string;
};

export type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

export type GoogleProfile = {
  sub: string;
  email: string;
  name: string;
  emailVerified: boolean;
};

export type GoogleCalendarEventPayload = {
  summary: string;
  description: string;
  start: { date: string } | { dateTime: string; timeZone?: string };
  end: { date: string } | { dateTime: string; timeZone?: string };
};

export const googleScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events",
];

export function googleConfigured(runtime: GoogleRuntimeEnv) {
  return Boolean(runtime.GOOGLE_CLIENT_ID && runtime.GOOGLE_CLIENT_SECRET && runtime.GOOGLE_TOKEN_ENCRYPTION_KEY);
}

export function googleRedirectUri(runtime: GoogleRuntimeEnv, request: Request) {
  const requestUrl = new URL(request.url);
  if (["okri.ai", "okrptr.com"].includes(requestUrl.hostname)) {
    return new URL("/api/google/callback", requestUrl.origin).toString();
  }
  return runtime.GOOGLE_OAUTH_REDIRECT_URI || new URL("/api/google/callback", request.url).toString();
}

export function googleCanonicalSignInUrl(runtime: GoogleRuntimeEnv, request: Request, returnTo: string) {
  const requestUrl = new URL(request.url);
  const callbackOrigin = new URL(googleRedirectUri(runtime, request)).origin;
  if (callbackOrigin === requestUrl.origin) return null;
  const canonical = new URL("/api/auth/google", callbackOrigin);
  canonical.searchParams.set("returnTo", returnTo);
  return canonical.toString();
}

export function googleAuthorizationUrl(runtime: GoogleRuntimeEnv, request: Request, state: string) {
  const clientId = requireGoogleValue(runtime.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", googleRedirectUri(runtime, request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", googleScopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export function googleSignInAuthorizationUrl(runtime: GoogleRuntimeEnv, request: Request, state: string) {
  const clientId = requireGoogleValue(runtime.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", googleRedirectUri(runtime, request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoogleCode(runtime: GoogleRuntimeEnv, request: Request, code: string) {
  return googleTokenRequest(runtime, {
    code,
    grant_type: "authorization_code",
    redirect_uri: googleRedirectUri(runtime, request),
  });
}

export async function refreshGoogleAccessToken(runtime: GoogleRuntimeEnv, refreshToken: string) {
  return googleTokenRequest(runtime, {
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Google profile request failed");
  const data = await response.json() as Record<string, unknown>;
  return {
    sub: stringValue(data.sub),
    email: stringValue(data.email),
    name: stringValue(data.name),
    emailVerified: data.email_verified === true,
  };
}

export async function upsertGoogleCalendarEvent(accessToken: string, existingEventId: string | null, event: GoogleCalendarEventPayload) {
  const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const url = existingEventId ? `${base}/${encodeURIComponent(existingEventId)}` : base;
  const response = await fetch(url, {
    method: existingEventId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (!response.ok && existingEventId && response.status === 404) return upsertGoogleCalendarEvent(accessToken, null, event);
  if (!response.ok) throw new Error("Google Calendar event sync failed");
  const data = await response.json() as Record<string, unknown>;
  return {
    id: stringValue(data.id),
    htmlLink: stringValue(data.htmlLink),
  };
}

export async function revokeGoogleToken(token: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
}

export async function encryptSecret(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const encoded = new TextEncoder().encode(value);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded));
  return `${bytesToBase64(iv)}.${bytesToBase64(encrypted)}`;
}

export async function decryptSecret(value: string, secret: string) {
  const [ivValue, encryptedValue] = value.split(".");
  if (!ivValue || !encryptedValue) throw new Error("Stored Google token is invalid");
  const key = await encryptionKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivValue) },
    key,
    base64ToBytes(encryptedValue),
  );
  return new TextDecoder().decode(decrypted);
}

async function googleTokenRequest(runtime: GoogleRuntimeEnv, body: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireGoogleValue(runtime.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
      client_secret: requireGoogleValue(runtime.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
      ...body,
    }),
  });
  if (!response.ok) throw new Error("Google OAuth token exchange failed");
  return response.json() as Promise<GoogleTokenResponse>;
}

function requireGoogleValue(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function encryptionKey(secret: string) {
  if (!secret) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
