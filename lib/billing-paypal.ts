import { env } from "cloudflare:workers";
import {
  getPayPalPrice, PayPalError, paypalConfigured, paypalPublicOrigin, paypalRequest,
  safePayPalApprovalUrl, verifyPayPalWebhook,
  type PayPalPlan, type PayPalPrice, type PayPalSubscription, type PayPalTransaction,
} from "./paypal-api";

type Row = {
  id: string; workspace_id: string; user_id: string; plan: PayPalPlan; provider_plan_id: string;
  provider_subscription_id: string | null; approval_url: string | null; currency: string; price_value: string;
  status: string; paid_through: string | null; closed_at: string | null; created_at: string;
};

let schemaReady: Promise<unknown> | null = null;
export async function ensurePayPalSchema() {
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS billing_paypal_subscriptions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
        plan TEXT NOT NULL CHECK (plan IN ('team','business')), provider_plan_id TEXT NOT NULL,
        provider_subscription_id TEXT UNIQUE, approval_url TEXT, currency TEXT NOT NULL, price_value TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CREATING', paid_through TEXT, closed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
      env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_paypal_open_workspace ON billing_paypal_subscriptions(workspace_id) WHERE closed_at IS NULL"),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS billing_paypal_transactions (
        id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES billing_paypal_subscriptions(id),
        workspace_id TEXT NOT NULL, status TEXT NOT NULL, currency TEXT NOT NULL,
        price_value TEXT NOT NULL, paid_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_paypal_transactions_workspace ON billing_paypal_transactions(workspace_id,paid_at)"),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS billing_paypal_events (
        id TEXT PRIMARY KEY,event_type TEXT NOT NULL,subscription_id TEXT NOT NULL,processed_at TEXT NOT NULL)`),
    ]);
    void schemaReady.catch(() => { schemaReady = null; });
  }
  await schemaReady;
}

export async function getPayPalSubscription(workspaceId: string) {
  return env.DB.prepare("SELECT * FROM billing_paypal_subscriptions WHERE workspace_id = ? AND closed_at IS NULL")
    .bind(workspaceId).first<Row>();
}

export async function expirePayPalEntitlement(workspaceId: string) {
  const now = new Date().toISOString();
  // Expiry is local and runs on entitlement reads, even if the provider is unavailable.
  await env.DB.batch([
    env.DB.prepare(`UPDATE workspace_subscriptions SET plan = 'free', status = 'free', next_plan = NULL,
      next_billing_at = NULL, cancel_at_period_end = 0, updated_at = ?
      WHERE workspace_id = ? AND EXISTS (SELECT 1 FROM billing_paypal_subscriptions p
        WHERE p.workspace_id = workspace_subscriptions.workspace_id AND p.closed_at IS NULL
          AND p.paid_through IS NOT NULL AND p.paid_through <= ?)`)
      .bind(now, workspaceId, now),
    env.DB.prepare(`UPDATE billing_paypal_subscriptions SET closed_at = ?, updated_at = ?
      WHERE workspace_id = ? AND closed_at IS NULL AND status IN ('CANCELLED','EXPIRED')
        AND (paid_through IS NULL OR paid_through <= ?)`)
      .bind(now, now, workspaceId, now),
  ]);
}

export async function payPalCheckoutOptions() {
  if (!paypalConfigured()) return [] as PayPalPrice[];
  try { return [await getPayPalPrice("team"), await getPayPalPrice("business")]; }
  catch (error) { console.error("PayPal checkout readiness", error instanceof PayPalError ? error.code : "request_failed"); return []; }
}

export async function withWorkspaceLock<T>(workspaceId: string, action: () => Promise<T>) {
  const holder = crypto.randomUUID();
  const key = `paypal:${workspaceId}`;
  const now = new Date().toISOString();
  const claim = await env.DB.prepare(`INSERT INTO billing_leases (lease_key,holder_id,expires_at,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(lease_key) DO UPDATE SET holder_id=excluded.holder_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at
    WHERE billing_leases.expires_at <= ?`)
    .bind(key, holder, new Date(Date.now() + 300_000).toISOString(), now, now).run();
  if (!claim.meta.changes) throw new PayPalError("billing_busy", 409);
  try { return await action(); }
  finally { await env.DB.prepare("DELETE FROM billing_leases WHERE lease_key = ? AND holder_id = ?").bind(key, holder).run(); }
}

export async function createPayPalCheckout(workspaceId: string, userId: string, plan: PayPalPlan, quoted: { currency: unknown; value: unknown }) {
  return withWorkspaceLock(workspaceId, async () => {
    const price = await getPayPalPrice(plan);
    if (quoted.currency !== price.currency || quoted.value !== price.value) throw new PayPalError("billing_price_changed", 409);
    const other = await env.DB.prepare(`SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND plan != 'free'
      AND NOT EXISTS (SELECT 1 FROM billing_paypal_subscriptions WHERE workspace_id = ? AND closed_at IS NULL)`)
      .bind(workspaceId, workspaceId).first();
    const card = await env.DB.prepare("SELECT 1 FROM billing_payment_methods WHERE workspace_id = ? AND active = 1").bind(workspaceId).first();
    const cardSession = await env.DB.prepare("SELECT 1 FROM billing_sessions WHERE workspace_id = ? AND expires_at > ?")
      .bind(workspaceId, new Date().toISOString()).first();
    if (other || card || cardSession) throw new PayPalError("billing_existing_subscription", 409);
    let row = await getPayPalSubscription(workspaceId);
    if (row && row.plan !== plan) throw new PayPalError("billing_existing_subscription", 409);
    if (!row) {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO billing_paypal_subscriptions
        (id,workspace_id,user_id,plan,provider_plan_id,currency,price_value,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(id, workspaceId, userId, plan, price.planId, price.currency, price.value, now, now).run();
      row = (await getPayPalSubscription(workspaceId))!;
    }
    if (row.provider_subscription_id) {
      const result = await syncSubscription(row);
      if (result.status !== "APPROVAL_PENDING" || !row.approval_url) throw new PayPalError("billing_existing_subscription", 409);
      return { approvalUrl: safePayPalApprovalUrl(row.approval_url) };
    }
    // PayPal keeps request IDs for 72h. Do not retry an uncertain create outside that window.
    if (Date.now() - Date.parse(row.created_at) > 48 * 60 * 60_000) throw new PayPalError("billing_reconciliation_required", 409);
    const origin = paypalPublicOrigin();
    const remote = await paypalRequest<PayPalSubscription>("/v1/billing/subscriptions", {
      method: "POST", requestId: row.id, body: {
        plan_id: row.provider_plan_id, custom_id: row.id, quantity: "1",
        application_context: { brand_name: "OKRI", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW",
          return_url: `${origin}/?view=billing&paypal=return`, cancel_url: `${origin}/?view=billing&paypal=cancel` },
      },
    });
    const approval = remote.links?.find((link) => link.rel === "approve")?.href;
    if (!/^I-[A-Z0-9]+$/.test(remote.id) || !approval) throw new PayPalError("paypal_invalid_subscription");
    const approvalUrl = safePayPalApprovalUrl(approval);
    await env.DB.prepare(`UPDATE billing_paypal_subscriptions SET provider_subscription_id=?, approval_url=?, status=?, updated_at=? WHERE id=?`)
      .bind(remote.id, approvalUrl, remote.status, new Date().toISOString(), row.id).run();
    return { approvalUrl };
  });
}

export function paidMonthEndsAt(value: string, startTime = value) {
  const paid = new Date(value);
  const anchor = new Date(startTime);
  if (![paid, anchor].every((date) => Number.isFinite(date.getTime()))) throw new PayPalError("paypal_invalid_payment_time");
  const atMonth = (offset: number) => {
    const date = new Date(anchor);
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + offset);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(anchor.getUTCDate(), last));
    return date;
  };
  const months = (paid.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + paid.getUTCMonth() - anchor.getUTCMonth();
  let end = atMonth(Math.max(1, months));
  if (end <= paid) end = atMonth(Math.max(1, months) + 1);
  return end.toISOString();
}

export function validatePayPalSubscription(row: Pick<Row, "id" | "provider_plan_id" | "provider_subscription_id">, remote: PayPalSubscription) {
  if (remote.id !== row.provider_subscription_id || remote.plan_id !== row.provider_plan_id || remote.custom_id !== row.id
    || (remote.quantity && remote.quantity !== "1") || remote.plan_overridden) throw new PayPalError("paypal_subscription_mismatch", 409);
}

async function syncSubscription(row: Row) {
  if (!row.provider_subscription_id) throw new PayPalError("billing_reconciliation_required", 409);
  const remote = await paypalRequest<PayPalSubscription>(`/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`);
  validatePayPalSubscription(row, remote);
  const now = new Date().toISOString();
  const start = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
  const query = new URLSearchParams({ start_time: start, end_time: now });
  const history = await paypalRequest<{ transactions?: PayPalTransaction[] }>(`/v1/billing/subscriptions/${row.provider_subscription_id}/transactions?${query}`);
  const statements = [];
  for (const payment of history.transactions || []) {
    const amount = payment.amount_with_breakdown?.gross_amount;
    if (!amount || amount.currency_code !== row.currency || Number(amount.value) !== Number(row.price_value)) {
      throw new PayPalError("paypal_payment_mismatch", 409);
    }
    if (!Number.isFinite(Date.parse(payment.time)) || Date.parse(payment.time) > Date.now() + 60_000) throw new PayPalError("paypal_invalid_payment_time");
    statements.push(env.DB.prepare(`INSERT INTO billing_paypal_transactions
      (id,subscription_id,workspace_id,status,currency,price_value,paid_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at
        WHERE billing_paypal_transactions.subscription_id=excluded.subscription_id
          AND billing_paypal_transactions.status NOT IN ('REFUNDED','REVERSED')`)
      .bind(payment.id, row.id, row.workspace_id, payment.status, amount.currency_code, amount.value, new Date(payment.time).toISOString(), now));
  }
  if (statements.length) await env.DB.batch(statements);
  // Approval and ACTIVE alone are not evidence of a successful charge.
  const paid = await env.DB.prepare(`SELECT paid_at FROM billing_paypal_transactions
    WHERE subscription_id=? AND status='COMPLETED' ORDER BY paid_at DESC LIMIT 1`).bind(row.id).first<{ paid_at: string }>();
  const paidThrough = paid ? paidMonthEndsAt(paid.paid_at, remote.start_time) : null;
  const entitled = Boolean(paidThrough && paidThrough > now);
  const canceled = ["CANCELLED", "EXPIRED"].includes(remote.status);
  const pending = ["APPROVAL_PENDING", "APPROVED"].includes(remote.status);
  const localStatus = !entitled ? "free" : canceled ? "cancel_at_period_end" : remote.status === "SUSPENDED" ? "past_due" : "active";
  await env.DB.batch([
    env.DB.prepare("UPDATE billing_paypal_subscriptions SET status=?, paid_through=?, updated_at=? WHERE id=?")
      .bind(remote.status, paidThrough, now, row.id),
    env.DB.prepare(`UPDATE workspace_subscriptions SET plan=?,status=?,next_plan=?,cancel_at_period_end=?,
      trial_started_at=NULL,trial_ends_at=NULL,current_period_started_at=?,current_period_ends_at=?,
      next_billing_at=?,grace_ends_at=NULL,first_paid_at=coalesce(first_paid_at,?),last_paid_at=?,updated_at=?
      WHERE workspace_id=? AND EXISTS(SELECT 1 FROM billing_paypal_subscriptions WHERE id=? AND closed_at IS NULL)`)
      .bind(entitled ? row.plan : "free", localStatus, canceled ? "free" : null, canceled ? 1 : 0,
        paid?.paid_at || null, paidThrough, canceled || pending ? null : remote.billing_info?.next_billing_time || null,
        paid?.paid_at || null, paid?.paid_at || null, now, row.workspace_id, row.id),
  ]);
  await expirePayPalEntitlement(row.workspace_id);
  return { status: remote.status, entitled, pending, paidThrough };
}

export async function syncPayPalWorkspace(workspaceId: string) {
  return withWorkspaceLock(workspaceId, async () => {
    const row = await getPayPalSubscription(workspaceId);
    if (!row) return { entitled: false, pending: false };
    return syncSubscription(row);
  });
}

export async function cancelPayPalSubscription(workspaceId: string) {
  return withWorkspaceLock(workspaceId, async () => {
    const row = await getPayPalSubscription(workspaceId);
    if (!row?.provider_subscription_id) throw new PayPalError("billing_subscription_not_found", 409);
    const remote = await paypalRequest<PayPalSubscription>(`/v1/billing/subscriptions/${row.provider_subscription_id}`);
    validatePayPalSubscription(row, remote);
    if (!["CANCELLED", "EXPIRED"].includes(remote.status)) {
      await paypalRequest(`/v1/billing/subscriptions/${row.provider_subscription_id}/cancel`, {
        method: "POST", body: { reason: "Workspace owner canceled the subscription in OKRI." },
      });
    }
    const result = await syncSubscription(row);
    if (!["CANCELLED", "EXPIRED"].includes(result.status)) throw new PayPalError("billing_cancellation_pending", 409);
    return { canceled: true, effective: result.entitled ? "period_end" : "immediate" };
  });
}

export async function refundPayPalFirstPayment(workspaceId: string) {
  return withWorkspaceLock(workspaceId, async () => {
    const row = await env.DB.prepare("SELECT * FROM billing_paypal_subscriptions WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1")
      .bind(workspaceId).first<Row>();
    if (!row) throw new PayPalError("billing_subscription_not_found", 409);
    const first = await env.DB.prepare("SELECT * FROM billing_paypal_transactions WHERE workspace_id=? ORDER BY paid_at LIMIT 1")
      .bind(workspaceId).first<{ id: string; subscription_id: string; paid_at: string; status: string }>();
    if (!first || first.subscription_id !== row.id || Date.now() - Date.parse(first.paid_at) > 7 * 24 * 60 * 60_000) throw new PayPalError("billing_refund_ineligible", 409);
    if (first.status !== "REFUNDED") {
      if (first.status !== "COMPLETED") throw new PayPalError("billing_refund_ineligible", 409);
      const used = await env.DB.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM items WHERE owner_id=? AND kind='project' AND julianday(created_at)>julianday(?))
        OR EXISTS(SELECT 1 FROM ai_usage_events WHERE owner_id=? AND julianday(created_at)>julianday(?))`)
        .bind(workspaceId, first.paid_at, workspaceId, first.paid_at).first();
      if (used) throw new PayPalError("billing_refund_ineligible", 409);
      // Eligibility is checked before stopping renewal. Stop the mandate before issuing a refund.
      const remote = await paypalRequest<PayPalSubscription>(`/v1/billing/subscriptions/${row.provider_subscription_id}`);
      validatePayPalSubscription(row, remote);
      if (!["CANCELLED", "EXPIRED"].includes(remote.status)) {
        await paypalRequest(`/v1/billing/subscriptions/${row.provider_subscription_id}/cancel`, {
          method: "POST", body: { reason: "Owner requested cancellation and first-payment refund." },
        });
      }
      const refunded = await paypalRequest<{ state: string }>(`/v1/payments/sale/${encodeURIComponent(first.id)}/refund`, {
        method: "POST", requestId: `refund-${first.id}`, body: {},
      });
      if (refunded.state !== "completed") throw new PayPalError("billing_refund_pending", 409);
      await env.DB.prepare("UPDATE billing_paypal_transactions SET status='REFUNDED',updated_at=? WHERE id=?")
        .bind(new Date().toISOString(), first.id).run();
    }
    await syncSubscription(row);
    return { refunded: true };
  });
}

export async function receivePayPalWebhook(request: Request) {
  const event = await verifyPayPalWebhook(request);
  if (await env.DB.prepare("SELECT 1 FROM billing_paypal_events WHERE id=?").bind(event.id).first()) return { received: true };
  const id = event.event_type.startsWith("BILLING.SUBSCRIPTION.") ? event.resource.id : event.resource.billing_agreement_id;
  const reversed = ["PAYMENT.SALE.REFUNDED", "PAYMENT.SALE.REVERSED"].includes(event.event_type);
  const saleId = event.resource.sale_id || (event.event_type === "PAYMENT.SALE.REVERSED" ? event.resource.id : null);
  const row = id ? await env.DB.prepare("SELECT * FROM billing_paypal_subscriptions WHERE provider_subscription_id=?").bind(id).first<Row>()
    : saleId ? await env.DB.prepare(`SELECT s.* FROM billing_paypal_subscriptions s INNER JOIN billing_paypal_transactions t
      ON t.subscription_id=s.id WHERE t.id=?`).bind(saleId).first<Row>() : null;
  if (!row) return { received: true };
  await withWorkspaceLock(row.workspace_id, async () => {
    if (reversed && saleId) {
      await env.DB.prepare("UPDATE billing_paypal_transactions SET status=?,updated_at=? WHERE id=? AND subscription_id=?")
        .bind(event.event_type.endsWith("REFUNDED") ? "REFUNDED" : "REVERSED", new Date().toISOString(), saleId, row.id).run();
    }
    await syncSubscription(row);
    await env.DB.prepare("INSERT OR IGNORE INTO billing_paypal_events(id,event_type,subscription_id,processed_at) VALUES (?,?,?,?)")
      .bind(event.id, event.event_type, row.id, new Date().toISOString()).run();
  });
  return { received: true };
}

export async function reconcilePayPalSubscriptions() {
  if (!paypalConfigured()) return { processed: 0, failed: 0 };
  const rows = await env.DB.prepare(`SELECT workspace_id FROM billing_paypal_subscriptions WHERE closed_at IS NULL
    AND provider_subscription_id IS NOT NULL ORDER BY updated_at LIMIT 5`).all<{ workspace_id: string }>();
  let processed = 0;
  let failed = 0;
  for (const row of rows.results) {
    try { await syncPayPalWorkspace(row.workspace_id); processed++; }
    catch (error) { failed++; console.error("PayPal reconciliation", error instanceof PayPalError ? error.code : "request_failed"); }
  }
  return { processed, failed };
}
