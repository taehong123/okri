import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const apiSource = await source("lib/paypal-api.ts");
const billingSource = await source("lib/billing-paypal.ts");
const migrations = await Promise.all((await readdir(new URL("../drizzle/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort().map((name) => source(`drizzle/${name}`)));
function compile(source, dependencies) {
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => dependencies[name] ?? require(name), module, module.exports);
  return module.exports;
}
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  for (const sql of migrations) db.exec(sql);
  db.exec(`INSERT INTO workspaces(id,name,owner_user_id) VALUES('a','Example A','owner'),('b','Example B','other');
    INSERT INTO workspace_subscriptions(workspace_id,billing_owner_user_id) VALUES('a','owner'),('b','other');`);
  const d1 = {
    prepare(sql) {
      const bind = (...args) => ({ sql, args,
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
      });
      return { ...bind(), bind };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try { const result = statements.map((s) => ({ meta: { changes: Number(db.prepare(s.sql).run(...s.args).changes) } })); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const env = { DB: d1, PAYPAL_ENVIRONMENT: "sandbox", PAYPAL_CLIENT_ID: "fake-client", PAYPAL_CLIENT_SECRET: "fake-secret",
    PAYPAL_WEBHOOK_ID: "WH-EXAMPLE", PAYPAL_TEAM_PLAN_ID: "P-TEAM", PAYPAL_BUSINESS_PLAN_ID: "P-BUSINESS", OKRI_PUBLIC_URL: "https://okri.example" };
  const api = compile(apiSource, { "cloudflare:workers": { env } });
  const service = compile(billingSource, { "cloudflare:workers": { env }, "./paypal-api": api });
  const plan = { id: "P-TEAM", status: "ACTIVE", quantity_supported: false,
    payment_preferences: { setup_fee: { value: "0" }, auto_bill_outstanding: false },
    billing_cycles: [{ tenure_type: "REGULAR", sequence: 1, total_cycles: 0, frequency: { interval_unit: "MONTH", interval_count: 1 }, pricing_scheme: { fixed_price: { currency_code: "USD", value: "9.00" } } }] };
  const remote = { id: "I-EXAMPLE", plan_id: "P-TEAM", custom_id: "", status: "APPROVAL_PENDING", quantity: "1", plan_overridden: false,
    billing_info: { next_billing_time: new Date(Date.now() + 30 * 86400000).toISOString() },
    links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=EXAMPLE" }] };
  const state = { transactions: [], requests: [], signature: "SUCCESS", createLost: false, refundState: "completed", cancelFails: false };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    state.requests.push({ url: String(url), ...init });
    const pathname = new URL(url).pathname;
    const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (pathname.endsWith("/oauth2/token")) return response({ access_token: "fake-access" });
    if (pathname.startsWith("/v1/billing/plans/")) return response({ ...plan, id: pathname.split("/").at(-1) });
    if (pathname === "/v1/billing/subscriptions") {
      const body = JSON.parse(init.body);
      remote.custom_id = body.custom_id;
      if (state.createLost) { state.createLost = false; throw new Error("connection lost after create"); }
      return response(remote, 201);
    }
    if (pathname.endsWith("/transactions")) return response({ transactions: state.transactions });
    if (pathname.endsWith("/cancel")) {
      if (state.cancelFails) return response({}, 503);
      remote.status = "CANCELLED"; return new Response(null, { status: 204 });
    }
    if (pathname.endsWith("/refund")) {
      if (state.refundState === "completed") state.transactions[0].status = "REFUNDED";
      return response({ state: state.refundState });
    }
    if (pathname.endsWith("/verify-webhook-signature")) return response({ verification_status: state.signature });
    if (pathname === "/v1/billing/subscriptions/I-EXAMPLE") return response(remote);
    throw new Error(`Unexpected provider call: ${pathname}`);
  });
  t.after(() => db.close());
  const create = () => service.createPayPalCheckout("a", "owner", "team", { currency: "USD", value: "9.00" });
  const pay = () => {
    remote.status = "ACTIVE";
    state.transactions = [{ id: "SALE-EXAMPLE", status: "COMPLETED", time: new Date().toISOString(),
      amount_with_breakdown: { gross_amount: { currency_code: "USD", value: "9.00" } } }];
  };
  const subscription = () => db.prepare("SELECT * FROM workspace_subscriptions WHERE workspace_id='a'").get();
  return { db, env, api, service, plan, remote, state, create, pay, subscription };
}

test("Free has five editors and no checkout capability is invented", async (t) => {
  assert.match(await source("lib/billing.ts"), /free:.*editorLimit: 5/);
  assert.match(await source("worker/index.ts"), /ctx.waitUntil\(import\("@\/lib\/billing"\).then\(\(\{ runBillingBatch \}\) => runBillingBatch\(\)\)\)/);
  const f = fixture(t);
  delete f.env.PAYPAL_CLIENT_SECRET;
  assert.equal(f.api.paypalConfigured(), false);
  assert.deepEqual(await f.service.payPalCheckoutOptions(), []);
  await assert.rejects(f.create, /paypal_not_configured/);
  assert.equal(f.state.requests.length, 0);
});

test("provider prices must be monthly, active, fixed, tax-inclusive and without hidden fees or arrears", (t) => {
  const f = fixture(t);
  assert.equal(f.api.validatePayPalPlan("team", "P-TEAM", f.plan).value, "9.00");
  for (const mutate of [
    (p) => p.status = "INACTIVE", (p) => p.billing_cycles[0].frequency.interval_unit = "YEAR",
    (p) => p.billing_cycles[0].tenure_type = "TRIAL", (p) => p.payment_preferences.setup_fee.value = "10",
    (p) => p.payment_preferences.auto_bill_outstanding = true, (p) => p.taxes = { percentage: "10", inclusive: false },
    (p) => p.billing_cycles[0].pricing_scheme.fixed_price.value = "-1",
  ]) { const plan = structuredClone(f.plan); mutate(plan); assert.throws(() => f.api.validatePayPalPlan("team", "P-TEAM", plan), /paypal_plan_mismatch/); }
  assert.throws(() => f.api.safePayPalApprovalUrl("https://www.paypal.com.evil.example/"), /paypal_invalid_approval_url/);
});

test("checkout checks the displayed price and resumes one persistent subscription", async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.service.createPayPalCheckout("a", "owner", "team", { currency: "KRW", value: "1" }), /billing_price_changed/);
  await f.create(); await f.create();
  assert.equal(f.state.requests.filter((r) => r.url.endsWith("/v1/billing/subscriptions")).length, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM billing_paypal_subscriptions").get().n, 1);
  assert.equal(f.subscription().plan, "free");
});

test("uncertain creates reuse the request ID; expired deduplication windows cannot duplicate a charge", async (t) => {
  const f = fixture(t);
  f.state.createLost = true;
  await assert.rejects(f.create, /connection lost/);
  await f.create();
  const creates = f.state.requests.filter((r) => r.url.endsWith("/v1/billing/subscriptions"));
  assert.equal(creates[0].headers["PayPal-Request-Id"], creates[1].headers["PayPal-Request-Id"]);
  f.db.exec("UPDATE billing_paypal_subscriptions SET provider_subscription_id=NULL,created_at='2000-01-01T00:00:00.000Z'");
  await assert.rejects(f.create, /billing_reconciliation_required/);
});

test("ACTIVE approval does not grant access; a verified matching payment does", async (t) => {
  const f = fixture(t); await f.create(); f.remote.status = "ACTIVE";
  await f.service.syncPayPalWorkspace("a"); assert.equal(f.subscription().plan, "free");
  f.pay(); await f.service.syncPayPalWorkspace("a");
  assert.equal(f.subscription().plan, "team");
  assert.equal(f.db.prepare("SELECT plan FROM workspace_subscriptions WHERE workspace_id='b'").get().plan, "free");
  assert.ok(f.subscription().current_period_ends_at > new Date().toISOString());
});

test("mismatched subscription ownership, plan, amount and currency fail closed", async (t) => {
  const f = fixture(t); await f.create(); f.pay();
  const original = f.remote.custom_id; f.remote.custom_id = "other-workspace";
  await assert.rejects(() => f.service.syncPayPalWorkspace("a"), /paypal_subscription_mismatch/);
  f.remote.custom_id = original; f.remote.plan_id = "P-OTHER";
  await assert.rejects(() => f.service.syncPayPalWorkspace("a"), /paypal_subscription_mismatch/);
  f.remote.plan_id = "P-TEAM"; f.state.transactions[0].amount_with_breakdown.gross_amount.currency_code = "EUR";
  await assert.rejects(() => f.service.syncPayPalWorkspace("a"), /paypal_payment_mismatch/);
  assert.equal(f.subscription().plan, "free");
});

test("cancel stops the remote mandate, preserves the paid period and expires without provider availability", async (t) => {
  const f = fixture(t); await f.create(); f.pay(); await f.service.syncPayPalWorkspace("a");
  await f.service.cancelPayPalSubscription("a");
  assert.equal(f.remote.status, "CANCELLED"); assert.equal(f.subscription().plan, "team");
  assert.equal(f.subscription().status, "cancel_at_period_end");
  assert.equal(f.subscription().next_billing_at, null);
  f.db.exec("UPDATE billing_paypal_subscriptions SET paid_through='2000-01-01T00:00:00.000Z'");
  delete f.env.PAYPAL_CLIENT_SECRET;
  await f.service.expirePayPalEntitlement("a");
  assert.equal(f.subscription().plan, "free");
  assert.equal(await f.service.getPayPalSubscription("a"), null);
});

test("failed provider cancellation is not reported as canceled", async (t) => {
  const f = fixture(t); await f.create(); f.pay(); await f.service.syncPayPalWorkspace("a"); f.state.cancelFails = true;
  await assert.rejects(() => f.service.cancelPayPalSubscription("a"), /paypal_request_failed/);
  assert.equal(f.subscription().status, "active");
});

test("refund checks eligibility before cancellation; full refund revokes access", async (t) => {
  const f = fixture(t); await f.create(); f.pay(); await f.service.syncPayPalWorkspace("a");
  const paid = f.state.transactions[0].time;
  f.db.prepare("INSERT INTO items(id,owner_id,kind,title,created_at) VALUES('new-project','a','project','Example',?)").run(new Date(Date.parse(paid) + 1000).toISOString());
  await assert.rejects(() => f.service.refundPayPalFirstPayment("a"), /billing_refund_ineligible/);
  assert.equal(f.remote.status, "ACTIVE");
  f.db.exec("DELETE FROM items WHERE id='new-project'");
  await f.service.refundPayPalFirstPayment("a");
  assert.equal(f.remote.status, "CANCELLED"); assert.equal(f.subscription().plan, "free");
  assert.equal(f.db.prepare("SELECT status FROM billing_paypal_transactions").get().status, "REFUNDED");
});

test("webhooks reject invalid signatures and replay without duplicating transactions", async (t) => {
  const f = fixture(t); await f.create(); f.pay();
  const event = { id: "WH-EVENT", event_type: "PAYMENT.SALE.COMPLETED", resource: { billing_agreement_id: "I-EXAMPLE" } };
  const request = () => new Request("https://okri.example/api/billing/paypal/webhook", { method: "POST", body: JSON.stringify(event),
    headers: Object.fromEntries(["auth-algo", "cert-url", "transmission-id", "transmission-sig", "transmission-time"].map((key) => [`paypal-${key}`, "example"])) });
  f.state.signature = "FAILURE";
  await assert.rejects(() => f.service.receivePayPalWebhook(request()), /invalid_webhook_signature/);
  assert.equal(f.subscription().plan, "free");
  f.state.signature = "SUCCESS";
  await f.service.receivePayPalWebhook(request()); await f.service.receivePayPalWebhook(request());
  assert.equal(f.db.prepare("SELECT count(*) n FROM billing_paypal_transactions").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM billing_paypal_events").get().n, 1);
});

test("monthly access clamps month ends instead of skipping into the following month", (t) => {
  const f = fixture(t);
  assert.equal(f.service.paidMonthEndsAt("2026-01-31T10:00:00.000Z"), "2026-02-28T10:00:00.000Z");
  assert.equal(f.service.paidMonthEndsAt("2028-01-31T10:00:00.000Z"), "2028-02-29T10:00:00.000Z");
  assert.equal(f.service.paidMonthEndsAt("2026-02-28T10:00:00.000Z", "2026-01-31T10:00:00.000Z"), "2026-03-31T10:00:00.000Z");
  assert.equal(f.service.paidMonthEndsAt("2026-02-01T10:00:00.000Z", "2026-01-31T10:00:00.000Z"), "2026-02-28T10:00:00.000Z");
});

test("webhook refund cannot be undone by an older completed transaction snapshot", async (t) => {
  const f = fixture(t); await f.create(); f.pay(); await f.service.syncPayPalWorkspace("a");
  const event = { id: "WH-REFUND", event_type: "PAYMENT.SALE.REFUNDED", resource: { sale_id: "SALE-EXAMPLE" } };
  const request = new Request("https://okri.example/api/billing/paypal/webhook", { method: "POST", body: JSON.stringify(event),
    headers: Object.fromEntries(["auth-algo", "cert-url", "transmission-id", "transmission-sig", "transmission-time"].map((key) => [`paypal-${key}`, "example"])) });
  await f.service.receivePayPalWebhook(request);
  await f.service.syncPayPalWorkspace("a");
  assert.equal(f.subscription().plan, "free");
  assert.equal(f.db.prepare("SELECT status FROM billing_paypal_transactions").get().status, "REFUNDED");
});

test("provider checkout exclusion covers existing cards and in-flight card sessions", async (t) => {
  const f = fixture(t);
  f.db.prepare(`INSERT INTO billing_sessions(token_hash,workspace_id,user_id,plan,price_won,consented_at,expires_at,used_at)
    VALUES ('session','a','owner','team',11000,?,?,?)`).run(new Date().toISOString(), "2099-01-01T00:00:00Z", new Date().toISOString());
  await assert.rejects(f.create, /billing_existing_subscription/);
  assert.equal(f.state.requests.filter((r) => r.url.endsWith("/v1/billing/subscriptions")).length, 0);
});

test("migration is LF and preserves payment records independently of workspace deletion", async (t) => {
  const sql = await source("drizzle/0051_paypal_billing.sql");
  assert.ok(!sql.includes("\r"));
  const f = fixture(t); await f.create(); f.pay(); await f.service.syncPayPalWorkspace("a");
  await f.service.cancelPayPalSubscription("a");
  f.db.exec("PRAGMA foreign_keys=ON; DELETE FROM workspaces WHERE id='a'");
  assert.equal(f.db.prepare("SELECT count(*) n FROM billing_paypal_transactions").get().n, 1);
  const pace = await source("lib/pace-data.ts");
  assert.match(pace, /async function permanentlyDeleteWorkspace\(id: string\) \{\s+await cancelSubscription\(id\)/);
});

test("payment routes require an interactive owner and same-origin request", async (t) => {
  let identity = { ownerId: "a", userId: "owner", role: "owner", apiToken: false };
  const f = fixture(t);
  const guard = compile(await source("lib/billing-route.ts"), { "@/lib/pace-data": { authorizeRequest: async () => identity }, "./paypal-api": f.api });
  const request = (origin) => new Request("https://okri.example/api/billing/paypal/checkout", { method: "POST", headers: { origin } });
  assert.equal((await guard.authorizeBillingOwner(request("https://evil.example"))).status, 403);
  identity = { ...identity, role: "member" };
  assert.equal((await guard.authorizeBillingOwner(request("https://okri.example"))).status, 403);
  identity = { ...identity, role: "owner", apiToken: true };
  assert.equal((await guard.authorizeBillingOwner(request("https://okri.example"))).status, 403);
  identity = { ...identity, apiToken: false };
  assert.equal((await guard.authorizeBillingOwner(request("https://okri.example"))).ownerId, "a");
});
