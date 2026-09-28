// Payple domestic recurring card API. Secret credentials never reach the SDK.
export type PaypleConfig = {
  PAYPLE_CST_ID?: string;
  PAYPLE_CUST_KEY?: string;
  PAYPLE_CLIENT_KEY?: string;
  PAYPLE_API_URL?: string;
  PAYPLE_REFUND_KEY?: string;
  PAYPLE_CHECKOUT_ORIGIN?: string;
  OKRI_PUBLIC_URL?: string;
};

export class PaypleError extends Error {
  constructor(public code: string, public uncertain = false) { super(code); }
}

export function paypleOrigin(config: PaypleConfig) {
  const value = config.PAYPLE_API_URL?.replace(/\/$/, "");
  if (value !== "https://cpay.payple.kr" && value !== "https://democpay.payple.kr") {
    throw new PaypleError("payple_invalid_origin");
  }
  return value;
}

export function paypleSdk(config: PaypleConfig) {
  if (!config.PAYPLE_CLIENT_KEY?.trim()) throw new PaypleError("payple_client_key_missing");
  return { clientKey: config.PAYPLE_CLIENT_KEY, authUrl: paypleOrigin(config) + "/js/v1/payment.js" };
}

async function post(config: PaypleConfig, path: string, body: Record<string, unknown>, uncertain = false) {
  const origin = paypleOrigin(config);
  const referer = new URL(config.PAYPLE_CHECKOUT_ORIGIN || config.OKRI_PUBLIC_URL || "https://okri.ai");
  if (config.PAYPLE_CHECKOUT_ORIGIN && config.PAYPLE_CHECKOUT_ORIGIN !== "https://mamuree.com") {
    throw new PaypleError("payple_invalid_checkout_origin");
  }
  if (referer.protocol !== "https:" || referer.username || referer.password) throw new PaypleError("payple_invalid_referer");
  let response: Response;
  try {
    response = await fetch(origin + path, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", Referer: referer.origin },
      body: JSON.stringify(body),
    });
  } catch { throw new PaypleError("payple_response_unavailable", uncertain); }
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new PaypleError("payple_response_unavailable", uncertain);
  }
  return data;
}

async function authenticate(config: PaypleConfig, flags: Record<string, string>) {
  if (!config.PAYPLE_CST_ID || !config.PAYPLE_CUST_KEY) throw new PaypleError("payple_not_configured");
  const data = await post(config, "/php/auth.php", {
    cst_id: config.PAYPLE_CST_ID, custKey: config.PAYPLE_CUST_KEY, ...flags,
  });
  if (data.result !== "success" || [data.cst_id, data.custKey, data.AuthKey].some(value => typeof value !== "string" || !value.trim())) {
    throw new PaypleError("payple_auth_failed");
  }
  return { PCD_CST_ID: data.cst_id, PCD_CUST_KEY: data.custKey, PCD_AUTH_KEY: data.AuthKey };
}

export async function inquirePaypleKey(config: PaypleConfig, billingKey: string) {
  if (!billingKey || billingKey.length > 255) throw new PaypleError("payple_invalid_key");
  const auth = await authenticate(config, { PCD_PAY_WORK: "PUSERINFO" });
  const data = await post(config, "/php/cPayUser/api/cPayUserAct.php?ACT_=PUSERINFO", { ...auth, PCD_PAYER_ID: billingKey });
  if (data.PCD_PAY_RST !== "success" || data.PCD_PAY_TYPE !== "card" || data.PCD_PAYER_ID !== billingKey) {
    throw new PaypleError("payple_key_mismatch");
  }
  return { billingKey, cardCompany: String(data.PCD_PAY_CARDNAME || ""), maskedCard: String(data.PCD_PAY_CARDNUM || "") };
}

function validateOrder(orderId: string, priceWon: number) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(orderId) || !Number.isSafeInteger(priceWon) || priceWon <= 0 || priceWon > 999999999) {
    throw new PaypleError("payple_invalid_order");
  }
}

export function validatePayplePayment(data: Record<string, unknown>, orderId: string, priceWon: number, billingKey: string) {
  if (data.PCD_PAY_RST !== "success") throw new PaypleError("payple_payment_declined");
  if (data.PCD_PAY_OID !== orderId || Number(data.PCD_PAY_TOTAL) !== priceWon || data.PCD_PAY_TYPE !== "card"
    || data.PCD_PAYER_ID !== billingKey || Number(data.PCD_REFUND_TOTAL || 0) !== 0
    || typeof data.PCD_PAY_CARDTRADENUM !== "string" || !data.PCD_PAY_CARDTRADENUM) {
    throw new PaypleError("payple_payment_mismatch", true);
  }
  let receiptUrl: string | null = null;
  try { const url = new URL(String(data.PCD_PAY_CARDRECEIPT)); if (url.protocol === "https:" && !url.username && !url.password) receiptUrl = url.href; } catch { /* Receipt is optional. */ }
  const payDate = typeof data.PCD_PAY_TIME === "string" && /^\d{14}$/.test(data.PCD_PAY_TIME)
    ? data.PCD_PAY_TIME.slice(0, 8) : null;
  return { transactionId: data.PCD_PAY_CARDTRADENUM, receiptUrl, payDate };
}

export async function inquirePayplePayment(config: PaypleConfig, orderId: string, payDate: string, priceWon: number, billingKey: string) {
  validateOrder(orderId, priceWon);
  if (!/^\d{8}$/.test(payDate)) throw new PaypleError("payple_invalid_date");
  const auth = await authenticate(config, { PCD_PAYCHK_FLAG: "Y" });
  const data = await post(config, "/php/PayChkAct.php", {
    ...auth, PCD_PAYCHK_FLAG: "Y", PCD_PAY_TYPE: "card", PCD_PAY_OID: orderId, PCD_PAY_DATE: payDate,
  });
  return validatePayplePayment(data, orderId, priceWon, billingKey);
}

export async function chargePayple(config: PaypleConfig, billingKey: string, orderId: string, priceWon: number) {
  validateOrder(orderId, priceWon);
  if (!billingKey || billingKey.length > 255) throw new PaypleError("payple_invalid_key");
  const auth = await authenticate(config, { PCD_PAY_TYPE: "card", PCD_SIMPLE_FLAG: "Y" });
  const data = await post(config, "/php/SimplePayCardAct.php?ACT_=PAYM", {
    ...auth, PCD_PAY_TYPE: "card", PCD_SIMPLE_FLAG: "Y", PCD_PAYER_ID: billingKey,
    PCD_PAY_OID: orderId, PCD_PAY_GOODS: "OKRI subscription", PCD_PAY_TOTAL: priceWon,
  }, true);
  return validatePayplePayment(data, orderId, priceWon, billingKey);
}

export async function refundPayple(config: PaypleConfig, orderId: string, payDate: string, priceWon: number) {
  validateOrder(orderId, priceWon);
  if (!/^\d{8}$/.test(payDate) || !config.PAYPLE_REFUND_KEY) throw new PaypleError("payple_invalid_refund");
  const auth = await authenticate(config, { PCD_PAYCANCEL_FLAG: "Y" });
  const data = await post(config, "/php/account/api/cPayCAct.php", {
    ...auth, PCD_REFUND_KEY: config.PAYPLE_REFUND_KEY, PCD_PAYCANCEL_FLAG: "Y",
    PCD_PAY_OID: orderId, PCD_PAY_DATE: payDate, PCD_REFUND_TOTAL: priceWon,
  }, true);
  if (data.PCD_PAY_RST !== "success" || data.PCD_PAY_OID !== orderId || Number(data.PCD_REFUND_TOTAL) !== priceWon) {
    throw new PaypleError("payple_refund_unconfirmed", true);
  }
}
