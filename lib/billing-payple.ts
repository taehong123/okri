import { chargePayple, inquirePayplePayment, PaypleError, refundPayple, type PaypleConfig } from "./payple-api";

type Runtime = PaypleConfig & { DB: D1Database };
export async function paypleScheduledChargeReady(runtime: Runtime & {
  RESEND_API_KEY?: string; OKRI_BILLING_FROM?: string; OKRPTR_BILLING_FROM?: string;
}, workspaceId: string, trialStartedAt: string | null, now: Date) {
  if (!runtime.RESEND_API_KEY || !(runtime.OKRI_BILLING_FROM || runtime.OKRPTR_BILLING_FROM)) return false;
  if (!trialStartedAt) return true;
  const row = await runtime.DB.prepare(`SELECT count(DISTINCT kind) AS sent FROM billing_notifications
    WHERE workspace_id=? AND status='sent' AND sent_at>=? AND (
      kind='trial_contract_confirmation' OR
      (kind='trial_ending_7d' AND sent_at<=?) OR (kind='trial_ending_1d' AND sent_at<=?))`)
    .bind(workspaceId, trialStartedAt, new Date(now.getTime() - 7 * 86400000).toISOString(),
      new Date(now.getTime() - 86400000).toISOString()).first<{ sent: number }>();
  return row?.sent === 3;
}

export function nextPaypleBillingMonth(date: Date) {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

type Attempt = { order_id: string; workspace_id: string; key_hash: string; price_won: number; pay_date: string;
  status: "pending" | "paid" | "refund_pending" | "refunded"; transaction_id: string | null; receipt_url: string | null };

export async function chargePaypleOnce(runtime: Runtime, billingKey: string, orderId: string, priceWon: number, workspaceId: string) {
  if (!workspaceId) throw new PaypleError("payple_workspace_missing");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(billingKey))), x => x.toString(16).padStart(2, "0")).join("");
  const now = new Date().toISOString();
  const payDate = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replaceAll("-", "");
  // A durable claim precedes any provider mutation. Unknown results are queried,
  // never charged again, even after a process restart or a lost response.
  const claimed = await runtime.DB.prepare(`INSERT OR IGNORE INTO billing_payple_attempts
    (order_id,workspace_id,key_hash,price_won,pay_date,status,created_at,updated_at)
    SELECT ?,?,?,?,?,'pending',?,? WHERE NOT EXISTS (
      SELECT 1 FROM billing_payple_attempts a WHERE a.workspace_id=? AND a.order_id<>? AND
      (a.status IN ('pending','refund_pending') OR (a.status='paid' AND NOT EXISTS
        (SELECT 1 FROM billing_transactions t WHERE t.order_id=a.order_id AND t.status='paid'))))`)
    .bind(orderId, workspaceId, hash, priceWon, payDate, now, now, workspaceId, orderId).run();
  const row = await runtime.DB.prepare("SELECT * FROM billing_payple_attempts WHERE order_id=?").bind(orderId).first<Attempt>();
  if (!row) throw new PaypleError("payple_reconciliation_required", true);
  if (row.workspace_id !== workspaceId || row.key_hash !== hash || row.price_won !== priceWon) throw new PaypleError("payple_order_mismatch", true);
  if (row.status === "refunded" || row.status === "refund_pending") throw new PaypleError("payple_order_refunded", true);
  if (row.status === "paid" && row.transaction_id) return { transactionId: row.transaction_id, receiptUrl: row.receipt_url };
  try {
    const paid = claimed.meta.changes
      ? await chargePayple(runtime, billingKey, orderId, priceWon)
      : await inquirePayplePayment(runtime, orderId, row.pay_date, priceWon, billingKey);
    await runtime.DB.prepare(`UPDATE billing_payple_attempts SET status='paid',transaction_id=?,receipt_url=?,pay_date=?,updated_at=? WHERE order_id=? AND status='pending'`)
      .bind(paid.transactionId, paid.receiptUrl, paid.payDate || row.pay_date, new Date().toISOString(), orderId).run();
    return { transactionId: paid.transactionId, receiptUrl: paid.receiptUrl };
  } catch {
    // Conservatively require reconciliation even for declines until the merchant
    // has supplied its definitive retryable decline-code contract.
    throw new PaypleError("payple_reconciliation_required", true);
  }
}

export async function refundPaypleOnce(runtime: Runtime, orderId: string, priceWon: number) {
  const row = await runtime.DB.prepare("SELECT * FROM billing_payple_attempts WHERE order_id=?").bind(orderId).first<Attempt>();
  if (!row || row.price_won !== priceWon || row.status === "pending" || row.status === "refund_pending") throw new PaypleError("payple_refund_unconfirmed", true);
  if (row.status === "refunded") return;
  const claim = await runtime.DB.prepare("UPDATE billing_payple_attempts SET status='refund_pending',updated_at=? WHERE order_id=? AND status='paid'")
    .bind(new Date().toISOString(), orderId).run();
  if (!claim.meta.changes) throw new PaypleError("payple_refund_unconfirmed", true);
  await refundPayple(runtime, orderId, row.pay_date, priceWon);
  await runtime.DB.prepare("UPDATE billing_payple_attempts SET status='refunded',updated_at=? WHERE order_id=?")
    .bind(new Date().toISOString(), orderId).run();
}
