import { env } from "cloudflare:workers";

type PayPalEnv = typeof env & {
  PAYPAL_ENVIRONMENT?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_TEAM_PLAN_ID?: string;
  PAYPAL_BUSINESS_PLAN_ID?: string;
  OKRI_PUBLIC_URL?: string;
};

export type PayPalPlan = "team" | "business";
export type PayPalPrice = { plan: PayPalPlan; planId: string; currency: string; value: string };
export class PayPalError extends Error {
  constructor(readonly code: string, readonly status = 502) { super(code); }
}

export function paypalConfigured() {
  const e = env as PayPalEnv;
  return Boolean(["live", "sandbox"].includes(e.PAYPAL_ENVIRONMENT || "") && e.PAYPAL_CLIENT_ID
    && e.PAYPAL_CLIENT_SECRET && e.PAYPAL_WEBHOOK_ID && e.PAYPAL_TEAM_PLAN_ID && e.PAYPAL_BUSINESS_PLAN_ID);
}

function apiOrigin() {
  const mode = (env as PayPalEnv).PAYPAL_ENVIRONMENT;
  if (mode === "live") return "https://api-m.paypal.com";
  if (mode === "sandbox") return "https://api-m.sandbox.paypal.com";
  throw new PayPalError("paypal_not_configured", 503);
}

export function paypalPublicOrigin() {
  const origin = new URL((env as PayPalEnv).OKRI_PUBLIC_URL || "https://okri.ai");
  if (origin.protocol !== "https:") throw new PayPalError("paypal_invalid_origin", 503);
  return origin.origin;
}

export function safePayPalApprovalUrl(value: string) {
  const url = new URL(value);
  const host = (env as PayPalEnv).PAYPAL_ENVIRONMENT === "live" ? "www.paypal.com" : "www.sandbox.paypal.com";
  if (url.protocol !== "https:" || url.hostname !== host || url.port || url.username || url.password) {
    throw new PayPalError("paypal_invalid_approval_url");
  }
  return url.href;
}

export async function paypalRequest<T>(path: string, options: { method?: string; body?: unknown; requestId?: string } = {}): Promise<T> {
  if (!paypalConfigured()) throw new PayPalError("paypal_not_configured", 503);
  const e = env as PayPalEnv;
  const origin = apiOrigin();
  const auth = await fetch(`${origin}/v1/oauth2/token`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Basic ${btoa(`${e.PAYPAL_CLIENT_ID}:${e.PAYPAL_CLIENT_SECRET}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const token = await auth.json() as { access_token?: string };
  if (!auth.ok || !token.access_token) throw new PayPalError("paypal_auth_failed", 503);
  const response = await fetch(`${origin}${path}`, {
    method: options.method || "GET", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", Prefer: "return=representation",
      ...(options.requestId ? { "PayPal-Request-Id": options.requestId } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    // Provider payloads can include payer details; retain only an opaque diagnostic ID.
    const failure = await response.json().catch(() => ({})) as { debug_id?: string };
    console.error("PayPal API", { status: response.status, debugId: failure.debug_id });
    throw new PayPalError("paypal_request_failed", response.status >= 500 ? 502 : 409);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

type ProviderPlan = {
  id: string; status: string; quantity_supported?: boolean;
  billing_cycles: Array<{ tenure_type: string; total_cycles: number; sequence: number;
    frequency: { interval_unit: string; interval_count: number };
    pricing_scheme: { fixed_price?: { currency_code: string; value: string } } }>;
  payment_preferences?: { setup_fee?: { value: string }; auto_bill_outstanding?: boolean };
  taxes?: { percentage: string; inclusive: boolean };
};

export function validatePayPalPlan(plan: PayPalPlan, expectedId: string, data: ProviderPlan): PayPalPrice {
  const cycle = data.billing_cycles?.[0];
  const price = cycle?.pricing_scheme?.fixed_price;
  if (data.id !== expectedId || data.status !== "ACTIVE" || data.quantity_supported
    || data.billing_cycles?.length !== 1 || cycle.tenure_type !== "REGULAR" || cycle.total_cycles !== 0
    || cycle.frequency?.interval_unit !== "MONTH" || cycle.frequency.interval_count !== 1
    || Number(data.payment_preferences?.setup_fee?.value || 0) !== 0
    || data.payment_preferences?.auto_bill_outstanding !== false
    || (Number(data.taxes?.percentage || 0) > 0 && !data.taxes?.inclusive)
    || !price || !/^[A-Z]{3}$/.test(price.currency_code) || !/^\d+(\.\d{1,2})?$/.test(price.value)
    || !Number.isFinite(Number(price.value)) || Number(price.value) <= 0) {
    throw new PayPalError("paypal_plan_mismatch", 503);
  }
  return { plan, planId: expectedId, currency: price.currency_code, value: price.value };
}

export async function getPayPalPrice(plan: PayPalPlan) {
  const e = env as PayPalEnv;
  const id = plan === "team" ? e.PAYPAL_TEAM_PLAN_ID : e.PAYPAL_BUSINESS_PLAN_ID;
  if (!id || !/^P-[A-Z0-9]+$/.test(id)) throw new PayPalError("paypal_not_configured", 503);
  return validatePayPalPlan(plan, id, await paypalRequest<ProviderPlan>(`/v1/billing/plans/${id}`));
}

export type PayPalSubscription = {
  id: string; plan_id: string; custom_id: string; status: string; quantity?: string;
  plan_overridden?: boolean; start_time?: string;
  billing_info?: { next_billing_time?: string };
  links?: Array<{ rel: string; href: string }>;
};
export type PayPalTransaction = { id: string; status: string; time: string;
  amount_with_breakdown: { gross_amount: { currency_code: string; value: string } } };

export type PayPalEvent = { id: string; event_type: string; resource: { id?: string; billing_agreement_id?: string; sale_id?: string } };
export async function verifyPayPalWebhook(request: Request): Promise<PayPalEvent> {
  const reader = request.body?.getReader();
  if (!reader) throw new PayPalError("invalid_webhook", 400);
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 100_000) { await reader.cancel(); throw new PayPalError("invalid_webhook", 413); }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  let event: PayPalEvent;
  try { event = JSON.parse(body) as PayPalEvent; } catch { throw new PayPalError("invalid_webhook", 400); }
  if (!event.id || !event.event_type || !event.resource) throw new PayPalError("invalid_webhook", 400);
  const fields = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
  if (fields.some((name) => !request.headers.get(name))) throw new PayPalError("invalid_webhook_signature", 401);
  let certificate: URL;
  try { certificate = new URL(request.headers.get("paypal-cert-url")!); } catch { throw new PayPalError("invalid_webhook_signature", 401); }
  if (certificate.protocol !== "https:" || certificate.username || certificate.password || certificate.port
    || !["api.paypal.com", "api-m.paypal.com", "api.sandbox.paypal.com", "api-m.sandbox.paypal.com"].includes(certificate.hostname)
    || !certificate.pathname.startsWith("/v1/notifications/certs/")) throw new PayPalError("invalid_webhook_signature", 401);
  const verified = await paypalRequest<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
    method: "POST", body: {
      auth_algo: request.headers.get(fields[0]), cert_url: request.headers.get(fields[1]),
      transmission_id: request.headers.get(fields[2]), transmission_sig: request.headers.get(fields[3]),
      transmission_time: request.headers.get(fields[4]), webhook_id: (env as PayPalEnv).PAYPAL_WEBHOOK_ID, webhook_event: event,
    },
  });
  if (verified.verification_status !== "SUCCESS") throw new PayPalError("invalid_webhook_signature", 401);
  return event;
}
