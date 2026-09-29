import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const source = name => readFile(new URL("../" + name, import.meta.url), "utf8");
function compile(source, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", code)(name => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const api = compile(await source("lib/payple-api.ts"));
const service = compile(await source("lib/billing-payple.ts"), { "./payple-api": api });
const config = { PAYPLE_CST_ID: "merchant-id", PAYPLE_CUST_KEY: "private-key", PAYPLE_CLIENT_KEY: "public-client",
  PAYPLE_API_URL: "https://democpay.payple.kr", PAYPLE_REFUND_KEY: "refund-key", OKRI_PUBLIC_URL: "https://okri.example" };

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  db.exec("CREATE TABLE billing_transactions(order_id TEXT PRIMARY KEY,status TEXT)");
  t.after(() => db.close());
  const bind = (sql, args = []) => ({ bind: (...values) => bind(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  const runtime = { ...config, DB: { prepare: sql => bind(sql) } };
  const state = { calls: [], lost: false, lostRefund: false, mismatch: false, queryFailure: false };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body); state.calls.push({ url, ...init, body });
    const result = data => Response.json(data);
    if (url.endsWith("/php/auth.php")) return result({ result: "success", cst_id: "rotated-id", custKey: "rotated-key", AuthKey: "auth-token", return_url: "https://evil.example" });
    assert.equal(body.PCD_CST_ID, "rotated-id"); assert.equal(body.PCD_CUST_KEY, "rotated-key"); assert.equal(body.PCD_AUTH_KEY, "auth-token");
    if (url.includes("PUSERINFO")) return result({ PCD_PAY_RST: "success", PCD_PAY_TYPE: "card", PCD_PAYER_ID: state.mismatch ? "wrong" : body.PCD_PAYER_ID, PCD_PAY_CARDNUM: "1234-**-**-5678" });
    if (url.includes("cPayCAct.php")) {
      if (state.lostRefund) throw new Error("response lost");
      return result({ PCD_PAY_RST: "success", PCD_PAY_OID: body.PCD_PAY_OID, PCD_REFUND_TOTAL: body.PCD_REFUND_TOTAL });
    }
    if (url.includes("PAYM") && state.lost) throw new Error("response lost");
    if (url.includes("PayChkAct") && state.queryFailure) return result({ PCD_PAY_RST: "error" });
    return result({ PCD_PAY_RST: "success", PCD_PAY_TYPE: "card", PCD_PAYER_ID: "billing-key", PCD_PAY_OID: body.PCD_PAY_OID,
      PCD_PAY_TOTAL: state.mismatch ? "1" : "2900", PCD_PAY_TIME: "20260930000001", PCD_PAY_CARDTRADENUM: "provider-tx", PCD_PAY_CARDRECEIPT: "https://receipt.example/tx" });
  });
  return { runtime, state, db, charge: () => service.chargePaypleOnce(runtime, "billing-key", "order-1", 2900, "workspace") };
}
const migration = await source("drizzle/0068_payple_attempts.sql");

test("Traefik HTTPS reaches billing authentication without weakening origin or host checks", async () => {
  assert.match(await source("deploy/k8s/deployment.yaml"), /name: VINEXT_TRUST_PROXY\s+value: "1"/);
  const previous = process.env.VINEXT_TRUST_PROXY;
  const previousHosts = process.env.VINEXT_TRUSTED_HOSTS;
  process.env.VINEXT_TRUST_PROXY = "1";
  delete process.env.VINEXT_TRUSTED_HOSTS;
  let proxy;
  try {
    proxy = await import("data:text/javascript;base64," + Buffer.from(await source("node_modules/vinext/dist/server/proxy-trust.js")).toString("base64"));
  } finally {
    if (previous === undefined) delete process.env.VINEXT_TRUST_PROXY; else process.env.VINEXT_TRUST_PROXY = previous;
    if (previousHosts === undefined) delete process.env.VINEXT_TRUSTED_HOSTS; else process.env.VINEXT_TRUSTED_HOSTS = previousHosts;
  }
  let authCalls = 0;
  const routes = compile(await source("lib/billing-route.ts"), {
    "@/lib/pace-data": { authorizeRequest: async () => { authCalls++; return Response.json({}, { status: 401 }); } },
    "./paypal-api": { PayPalError: class extends Error {} },
  });
  const headers = new Headers({ host: "okri.ai", "x-forwarded-proto": "https", "x-forwarded-host": "evil.example",
    origin: "https://okri.ai", "sec-fetch-site": "same-origin" });
  const url = `${proxy.resolveRequestProtocol(headers)}://${proxy.resolveRequestHost(headers, "localhost")}/api/billing/payple/session`;
  assert.equal(url, "https://okri.ai/api/billing/payple/session");
  assert.equal((await routes.authorizeBillingOwner(new Request(url, { headers }))).status, 401);
  assert.equal(authCalls, 1);
  for (const origin of [null, "http://okri.ai", "https://evil.example", "null"]) {
    if (origin === null) headers.delete("origin"); else headers.set("origin", origin);
    assert.equal((await routes.authorizeBillingOwner(new Request(url, { headers }))).status, 403);
  }
  headers.set("origin", "https://okri.ai"); headers.set("sec-fetch-site", "cross-site");
  assert.equal((await routes.authorizeBillingOwner(new Request(url, { headers }))).status, 403);
  assert.equal(authCalls, 1);
});

test("monthly renewal clamps month ends and preserves the UTC time", () => {
  for (const [start, expected] of [
    ["2026-01-31T12:34:56.000Z", "2026-02-28T12:34:56.000Z"],
    ["2028-01-31T12:34:56.000Z", "2028-02-29T12:34:56.000Z"],
    ["2026-12-15T12:34:56.000Z", "2027-01-15T12:34:56.000Z"],
  ]) {
    const date = new Date(start);
    assert.equal(service.nextPaypleBillingMonth(date).toISOString(), expected);
    assert.equal(date.toISOString(), start);
  }
});

test("scheduled charges require configured notices and the promised trial notice lead times", async t => {
  const { runtime, db } = fixture(t);
  db.exec("CREATE TABLE billing_notifications(workspace_id TEXT,kind TEXT,status TEXT,sent_at TEXT)");
  const now = new Date("2026-09-30T12:00:00.000Z");
  const start = "2026-08-31T12:00:00.000Z";
  assert.equal(await service.paypleScheduledChargeReady(runtime, "workspace", null, now), false);
  const configured = { ...runtime, RESEND_API_KEY: "mock", OKRI_BILLING_FROM: "billing@example.com" };
  assert.equal(await service.paypleScheduledChargeReady(configured, "workspace", null, now), true);
  assert.equal(await service.paypleScheduledChargeReady(configured, "workspace", start, now), false);
  const insert = db.prepare("INSERT INTO billing_notifications VALUES ('workspace',?,'sent',?)");
  insert.run("trial_contract_confirmation", start);
  insert.run("trial_ending_7d", "2026-09-23T12:00:00.000Z");
  insert.run("trial_ending_1d", "2026-09-29T12:00:01.000Z");
  assert.equal(await service.paypleScheduledChargeReady(configured, "workspace", start, now), false);
  assert.equal(await service.paypleScheduledChargeReady(configured, "workspace", start, new Date(now.getTime() + 1000)), true);
  assert.equal(await service.paypleScheduledChargeReady(configured, "other", start, now), false);
});

test("SDK uses public client key, never merchant credentials or an arbitrary script URL", () => {
  assert.deepEqual(api.paypleSdk(config), { clientKey: "public-client", authUrl: "https://democpay.payple.kr/js/v1/payment.js" });
  assert.throws(() => api.paypleSdk({ ...config, PAYPLE_CLIENT_KEY: "" }), /missing/);
  for (const url of ["http://cpay.payple.kr", "https://cpay.payple.kr.evil.example", "https://cpay.payple.kr/payment", "https://user@cpay.payple.kr"]) {
    assert.throws(() => api.paypleOrigin({ ...config, PAYPLE_API_URL: url }), /invalid_origin/);
  }
});

test("billing-key lookup authenticates first and requires a returned matching card key", async t => {
  const f = fixture(t);
  assert.equal((await api.inquirePaypleKey(config, "billing-key")).billingKey, "billing-key");
  assert.equal(f.state.calls[0].body.PCD_PAY_WORK, "PUSERINFO");
  assert.equal(f.state.calls[1].url, "https://democpay.payple.kr/php/cPayUser/api/cPayUserAct.php?ACT_=PUSERINFO");
  assert.equal(f.state.calls[1].headers.Referer, "https://okri.example");
  assert.equal(f.state.calls[1].redirect, "error");
  f.state.mismatch = true;
  await assert.rejects(() => api.inquirePaypleKey(config, "billing-key"), /key_mismatch/);
});

test("repeated charge requests persist one provider charge and verify the amount", async t => {
  const f = fixture(t);
  const first = await f.charge(); const second = await f.charge();
  assert.deepEqual(first, second);
  assert.equal(f.state.calls.filter(c => c.url.includes("PAYM")).length, 1);
  assert.equal(f.db.prepare("SELECT status FROM billing_payple_attempts").get().status, "paid");
  await assert.rejects(() => service.chargePaypleOnce(f.runtime, "other-key", "order-1", 2900, "workspace"), /order_mismatch/);
  await assert.rejects(() => service.chargePaypleOnce(f.runtime, "billing-key", "order-1", 4900, "workspace"), /order_mismatch/);
  await assert.rejects(() => service.chargePaypleOnce(f.runtime, "billing-key", "order-1", 2900, "other"), /order_mismatch/);
});

test("a new checkout cannot recharge a workspace with an unresolved previous order", async t => {
  const f = fixture(t); f.state.lost = true;
  await assert.rejects(f.charge);
  await assert.rejects(() => service.chargePaypleOnce(f.runtime, "billing-key", "new-session-order", 2900, "workspace"), /reconciliation_required/);
  assert.equal(f.state.calls.filter(c => c.url.includes("PAYM")).length, 1);
  f.state.lost = false;
  await f.charge();
  await assert.rejects(() => service.chargePaypleOnce(f.runtime, "billing-key", "new-session-order", 2900, "workspace"), /reconciliation_required/);
  f.db.prepare("INSERT INTO billing_transactions VALUES (?,?)").run("order-1", "paid");
  await service.chargePaypleOnce(f.runtime, "billing-key", "next-period-order", 2900, "workspace");
  assert.equal(f.state.calls.filter(c => c.url.includes("PAYM")).length, 2);
});

test("lost payment response is recovered through inquiry without charging again", async t => {
  const f = fixture(t); f.state.lost = true;
  await assert.rejects(f.charge, /reconciliation_required/);
  assert.equal((await f.charge()).transactionId, "provider-tx");
  assert.equal(f.state.calls.filter(c => c.url.includes("PAYM")).length, 1);
  assert.equal(f.state.calls.filter(c => c.url.includes("PayChkAct.php")).length, 1);
});

test("inconclusive inquiry and mismatched payment cannot grant access or retry charges", async t => {
  const f = fixture(t); f.state.lost = true; f.state.queryFailure = true;
  await assert.rejects(f.charge, /reconciliation_required/);
  await assert.rejects(f.charge, /reconciliation_required/);
  assert.equal(f.state.calls.filter(c => c.url.includes("PAYM")).length, 1);
  f.state.queryFailure = false; f.state.mismatch = true;
  await assert.rejects(f.charge, /reconciliation_required/);
  assert.equal(f.db.prepare("SELECT status FROM billing_payple_attempts").get().status, "pending");
});

test("refund uses original order and saved KST date, not card authorization number", async t => {
  const f = fixture(t); await f.charge();
  await service.refundPaypleOnce(f.runtime, "order-1", 2900);
  await service.refundPaypleOnce(f.runtime, "order-1", 2900);
  const calls = f.state.calls.filter(c => c.url.includes("cPayCAct.php"));
  assert.equal(calls.length, 1); assert.equal(calls[0].body.PCD_PAY_OID, "order-1");
  assert.equal(calls[0].body.PCD_PAY_DATE, "20260930");
  assert.equal(calls[0].body.PCD_REFUND_KEY, config.PAYPLE_REFUND_KEY);
  await assert.rejects(f.charge, /order_refunded/);
});

test("lost refund response is not retried automatically", async t => {
  const f = fixture(t); await f.charge(); f.state.lostRefund = true;
  await assert.rejects(() => service.refundPaypleOnce(f.runtime, "order-1", 2900));
  await assert.rejects(() => service.refundPaypleOnce(f.runtime, "order-1", 2900), /unconfirmed/);
  assert.equal(f.state.calls.filter(c => c.url.includes("cPayCAct.php")).length, 1);
});

test("missing, mismatched and refunded provider evidence is rejected", () => {
  const valid = { PCD_PAY_RST: "success", PCD_PAY_TYPE: "card", PCD_PAY_OID: "order-1", PCD_PAY_TOTAL: "2900", PCD_PAYER_ID: "billing-key", PCD_PAY_CARDTRADENUM: "tx" };
  for (const patch of [{ PCD_PAY_OID: "other" }, { PCD_PAYER_ID: undefined }, { PCD_PAY_TOTAL: "1" }, { PCD_PAY_CARDTRADENUM: undefined }, { PCD_REFUND_TOTAL: "2900" }]) {
    assert.throws(() => api.validatePayplePayment({ ...valid, ...patch }, "order-1", 2900, "billing-key"), /mismatch/);
  }
});

test("frontend handles close and error before completing registration, with a relative callback", async () => {
  const ui = await source("app/billing-view.tsx");
  assert.match(ui, /clientKey: session.clientKey/);
  assert.doesNotMatch(ui, /clientKey: session.merchantId/);
  assert.ok(ui.indexOf('result.PCD_PAY_RST === "close"') < ui.indexOf('fetch("/api/billing/payple/result"'));
  const route = await source("app/api/billing/payple/result/route.ts");
  assert.match(route, /authorizeBillingOwner\(request\)/);
});

test("checkout checks the displayed quote before issuing a billing session", async () => {
  const billing = await source("lib/billing.ts");
  const start = billing.slice(billing.indexOf("export async function createPaypleSession"), billing.indexOf("export async function completePaypleRegistration"));
  assert.ok(start.indexOf("quote.priceWon !== monthlyPriceWon") < start.indexOf("INSERT INTO billing_sessions"));
  assert.match(start, /quote.seats !== billableEditors/);
  assert.match(await source("app/api/billing/payple/session/route.ts"), /priceWon: payload\?\.priceWon, seats: payload\?\.seats/);
  assert.match(await source("app/billing-view.tsx"), /seats: billing.billableEditors/);
});
