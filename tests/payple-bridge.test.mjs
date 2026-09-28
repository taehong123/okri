import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const source = path => readFile(new URL("../" + path, import.meta.url), "utf8");
function compile(source, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", code)(name => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const cryptoModule = compile(await source("lib/secret-crypto.ts"));
const api = compile(await source("lib/payple-api.ts"));
let lookups = 0;
const bridge = compile(await source("lib/payple-bridge.ts"), {
  "./secret-crypto": cryptoModule, "./payple-api": { ...api, inquirePaypleKey: async (_, key) => {
    lookups++; return { billingKey: key, maskedCard: "1234-****-5678", cardCompany: "test" };
  } },
});
const html = compile(await source("lib/payple-bridge-page.ts"), {
  "./payple-bridge": bridge, "./themes": compile(await source("lib/themes.ts")),
});
const token = "11111111-1111-4111-8111-111111111111";
const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), n => n.toString(16).padStart(2,"0")).join("");
async function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE billing_sessions(token_hash TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,plan TEXT,price_won INTEGER,used_at TEXT,expires_at TEXT)");
  db.exec("CREATE TABLE workspaces(id TEXT PRIMARY KEY,owner_user_id TEXT); INSERT INTO workspaces VALUES ('workspace','owner'); CREATE TABLE billing_trial_claims(billing_owner_user_id TEXT)");
  db.exec(await source("drizzle/0069_payple_bridge.sql"));
  db.prepare("INSERT INTO billing_sessions VALUES (?,?,?,?,?,NULL,?)").run(hash, "workspace", "owner", "team", 2900, "2099-01-01");
  const prepare = (sql, args=[]) => ({ bind: (...values) => prepare(sql, values), first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }) });
  return { db, runtime: { DB: { prepare }, PAYPLE_CLIENT_KEY: "public-key", PAYPLE_API_URL: "https://democpay.payple.kr",
    PAYPLE_BILLING_KEY_ENCRYPTION_KEY: "isolated-test-key", PAYPLE_CHECKOUT_ORIGIN: "https://mamuree.com", PAYPLE_CHECKOUT_VERIFIED: "true" } };
}

test("only the dedicated merchant bridge is allowed and tokens remain in fragments", () => {
  const url = new URL(bridge.paypleBridgeUrl({ PAYPLE_CHECKOUT_ORIGIN: "https://mamuree.com" }, token));
  assert.equal(url.origin, "https://mamuree.com"); assert.equal(url.pathname, "/api/public/payple/okri/bridge");
  assert.equal(url.search, ""); assert.equal(url.hash, "#" + token);
  assert.throws(() => bridge.paypleBridgeUrl({ PAYPLE_CHECKOUT_ORIGIN: "https://evil.example" }, token));
  for (const origin of [null, "https://okri.ai", "https://evil.example"]) {
    assert.throws(() => bridge.assertPaypleBridgeRequest(new Request("https://mamuree.com/api/public/payple/okri/session", { headers: origin ? { origin } : {} })));
  }
  bridge.assertPaypleBridgeRequest(new Request("https://mamuree.com/api/public/payple/okri/session", { headers: { origin: "https://mamuree.com" } }));
});

test("expired, consumed and disabled bridge sessions fail closed", async t => {
  const { runtime, db } = await fixture(t);
  assert.equal((await bridge.readPaypleBridgeSession(runtime, token)).priceWon, 2900);
  await assert.rejects(() => bridge.readPaypleBridgeSession({ ...runtime, PAYPLE_CHECKOUT_VERIFIED: "false" }, token));
  await assert.rejects(() => bridge.readPaypleBridgeSession({ ...runtime, PAYPLE_PILOT_USER_ID: "different-user" }, token));
  await assert.rejects(() => bridge.readPaypleBridgeSession(runtime, "bad"));
  db.exec("UPDATE billing_sessions SET used_at='used'");
  await assert.rejects(() => bridge.readPaypleBridgeSession(runtime, token));
  db.exec("UPDATE billing_sessions SET used_at=NULL,expires_at='2000-01-01'");
  await assert.rejects(() => bridge.readPaypleBridgeSession(runtime, token));
});

test("bridge stages encrypted data, never grants access, and only the originating owner can consume", async t => {
  const { runtime, db } = await fixture(t);
  const result = { PCD_PAY_RST: "success", PCD_PAY_WORK: "AUTH", PCD_PAY_TYPE: "card", PCD_PAYER_ID: "first-key" };
  const consent = { accepted: true, firstPaymentWon: 0, priceWon: 2900 };
  const response = await bridge.stagePaypleBridgeResult(runtime, token, result, consent);
  assert.equal(new URL(response.returnUrl).origin, "https://okri.ai");
  assert.ok(!db.prepare("SELECT encrypted_result FROM billing_payple_bridge_results").get().encrypted_result.includes("first-key"));
  assert.equal(db.prepare("SELECT used_at FROM billing_sessions").get().used_at, null);
  await bridge.stagePaypleBridgeResult(runtime, token, { ...result, PCD_PAYER_ID: "replacement-key" }, consent);
  assert.equal((await bridge.consumePaypleBridgeResult(runtime, token, "workspace", "owner")).billingKey, "first-key");
  await assert.rejects(() => bridge.consumePaypleBridgeResult(runtime, token, "other", "owner"), /session_owner/);
  await assert.rejects(() => bridge.consumePaypleBridgeResult(runtime, token, "workspace", "other"), /session_owner/);
  const before = lookups;
  await assert.rejects(() => bridge.stagePaypleBridgeResult(runtime, token, { ...result, PCD_PAY_RST: "close" }, consent));
  await assert.rejects(() => bridge.requirePaypleImmediateConsent(runtime, hash, 2900), /consent_required/);
  assert.equal(lookups, before);
  const finish = await source("app/api/billing/payple/complete-bridge/route.ts");
  assert.match(finish, /authorizeBillingOwner\(request\)/);
});

test("returning customers must explicitly accept today's charge before registration completes", async t => {
  const { runtime, db } = await fixture(t);
  db.exec("INSERT INTO billing_trial_claims VALUES ('owner')");
  assert.equal((await bridge.readPaypleBridgeSession(runtime, token)).firstPaymentWon, 2900);
  const result = { PCD_PAY_RST: "success", PCD_PAY_WORK: "AUTH", PCD_PAY_TYPE: "card", PCD_PAYER_ID: "key" };
  await assert.rejects(() => bridge.stagePaypleBridgeResult(runtime, token, result, { accepted: true, firstPaymentWon: 0, priceWon: 2900 }), /consent_changed/);
  await assert.rejects(() => bridge.stagePaypleBridgeResult(runtime, token, result, { accepted: false, firstPaymentWon: 2900, priceWon: 2900 }), /consent_changed/);
  await bridge.stagePaypleBridgeResult(runtime, token, result, { accepted: true, firstPaymentWon: 2900, priceWon: 2900 });
  await bridge.requirePaypleImmediateConsent(runtime, hash, 2900);
  await assert.rejects(() => bridge.requirePaypleImmediateConsent(runtime, hash, 4900), /consent_required/);
});

test("bridge HTML is localized, themed, non-cacheable and does not accept arbitrary redirects or scripts", async () => {
  for (const lang of ["ko", "en", "ja", "zh", "es"]) {
    const response = html.renderPaypleBridge(new URL(`https://mamuree.com/api/public/payple/okri/bridge?lang=${lang}&theme=dark`));
    const text = await response.text();
    assert.match(text, new RegExp(`<html lang="${lang}" data-theme="dark"`));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(text, /history.replaceState/); assert.match(text, /OKRI/);
    assert.doesNotMatch(text, /cst_id|custKey|refundCustKey/);
    assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  }
  const text = await html.renderPaypleBridge(new URL('https://mamuree.com/api/public/payple/okri/bridge?theme=%22%3E%3Cscript%3E&lang=x')).text();
  assert.match(text, /lang="en" data-theme="white"/);
});

test("routing is limited to the OKRI payment prefix without replacing existing services", async () => {
  const ingress = await source("deploy/k8s/ingress.payple-bridge.yaml.template");
  assert.match(ingress, /path: \/api\/public\/payple\/okri\n/);
  assert.doesNotMatch(ingress, /path: \/\n|external-dns/);
});
