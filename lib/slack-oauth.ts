export type SlackRuntimeEnv = {
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_TOKEN_ENCRYPTION_KEY?: string;
  SLACK_OAUTH_REDIRECT_URI?: string;
};

export type SlackOAuthResponse = {
  ok: boolean;
  access_token?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string };
  error?: string;
};

export type SlackOAuthResultCode =
  | "connected"
  | "setup_required"
  | "workspace_admin_required"
  | "slack_admin_approval_required"
  | "workspace_already_connected"
  | "authorization_cancelled"
  | "missing_scope"
  | "oauth_exchange_failed"
  | "service_unavailable";

export class SlackOAuthExchangeError extends Error {
  readonly slackCode: string;

  constructor(slackCode: string) {
    super(`Slack OAuth exchange failed: ${slackCode}`);
    this.name = "SlackOAuthExchangeError";
    this.slackCode = slackCode;
  }
}

export const slackDailyScopes = [
  "commands",
  "chat:write",
  "im:write",
  "im:history",
  "users:read",
  "users:read.email",
  "channels:read",
  "channels:join",
  "groups:read",
];

export const slackScopes = [...slackDailyScopes, "channels:history", "groups:history", "app_mentions:read", "files:read"];

export function slackConfigured(runtime: SlackRuntimeEnv) {
  return Boolean(runtime.SLACK_CLIENT_ID && runtime.SLACK_CLIENT_SECRET && runtime.SLACK_SIGNING_SECRET && runtime.SLACK_TOKEN_ENCRYPTION_KEY);
}

export function slackRedirectUri(runtime: SlackRuntimeEnv, request: Request) {
  const requestUrl = new URL(request.url);
  if (["okri.ai", "okrptr.com"].includes(requestUrl.hostname)) {
    return new URL("/api/slack/callback", requestUrl.origin).toString();
  }
  return runtime.SLACK_OAUTH_REDIRECT_URI || new URL("/api/slack/callback", request.url).toString();
}

export function slackCommandUrl(request: Request) {
  return new URL("/api/slack/commands", request.url).toString();
}

export function slackInteractionUrl(request: Request) {
  return new URL("/api/slack/interactions", request.url).toString();
}

export function slackEventsUrl(request: Request) {
  return new URL("/api/slack/events", request.url).toString();
}

export function slackAuthorizationUrl(runtime: SlackRuntimeEnv, request: Request, state: string) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", requireSlackValue(runtime.SLACK_CLIENT_ID, "SLACK_CLIENT_ID"));
  url.searchParams.set("scope", slackScopes.join(","));
  url.searchParams.set("redirect_uri", slackRedirectUri(runtime, request));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeSlackCode(runtime: SlackRuntimeEnv, request: Request, code: string) {
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireSlackValue(runtime.SLACK_CLIENT_ID, "SLACK_CLIENT_ID"),
      client_secret: requireSlackValue(runtime.SLACK_CLIENT_SECRET, "SLACK_CLIENT_SECRET"),
      redirect_uri: slackRedirectUri(runtime, request),
      code,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json() as SlackOAuthResponse;
  if (!response.ok || !data.ok) throw new SlackOAuthExchangeError(data.error || "oauth_exchange_failed");
  return data;
}

export function classifySlackOAuthError(code: string, description = ""): SlackOAuthResultCode {
  const normalized = `${code} ${description}`.toLocaleLowerCase();
  if (/admin|approval|approved|restricted_action|request_pending/.test(normalized)) return "slack_admin_approval_required";
  if (/invalid_scope|missing_scope|scope_not_allowed/.test(normalized)) return "missing_scope";
  if (/access_denied|cancel|denied_by_user/.test(normalized)) return "authorization_cancelled";
  return "oauth_exchange_failed";
}

export function redirectWithSlackStatus(request: Request, returnTo: string, status: SlackOAuthResultCode) {
  const url = new URL(returnTo, request.url);
  url.searchParams.set("slack", status);
  return Response.redirect(url.toString(), 303);
}

export async function revokeSlackToken(token: string) {
  await fetch("https://slack.com/api/auth.revoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(15_000),
  });
}

export async function verifySlackRequest(request: Request, rawBody: string, signingSecret: string) {
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 60 * 5) return false;
  const expected = await slackSignature(signingSecret, `v0:${timestamp}:${rawBody}`);
  return timingSafeEqual(expected, signature);
}

export async function encryptSlackSecret(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const encoded = new TextEncoder().encode(value);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded));
  return `${bytesToBase64(iv)}.${bytesToBase64(encrypted)}`;
}

export async function decryptSlackSecret(value: string, secret: string) {
  const [ivValue, encryptedValue] = value.split(".");
  if (!ivValue || !encryptedValue) throw new Error("Stored Slack token is invalid");
  const key = await encryptionKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivValue) },
    key,
    base64ToBytes(encryptedValue),
  );
  return new TextDecoder().decode(decrypted);
}

async function slackSignature(signingSecret: string, baseString: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString)));
  return `v0=${bytesToHex(signature)}`;
}

async function encryptionKey(secret: string) {
  if (!secret) throw new Error("SLACK_TOKEN_ENCRYPTION_KEY is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function requireSlackValue(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
