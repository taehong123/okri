import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as jose from "jose";
import ts from "typescript";
import { compileLanguageModule, d1Fixture } from "./helpers/language-fixture.mjs";
const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");
const native = compileLanguageModule(await read("lib/native-session.ts"));
const review = compileLanguageModule(await read("lib/native-review.ts"), { "./native-session": native });
const apple = compileLanguageModule(await read("lib/apple-native.ts"), { jose, "./google-oauth": {}, "./native-session": native });
const migration = await read("drizzle/0054_native_sessions.sql");
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,email_normalized TEXT,display_name TEXT); INSERT INTO users VALUES('u','demo@example.test','Demo');");
  db.exec(migration); return { db, d1: d1Fixture(db) };
}
test("native migration is LF-only and replayable", () => { assert.ok(!migration.includes("\r")); const { db } = fixture(); db.exec(migration); db.close(); });
test("PKCE login rejects wrong verifier, consumes code once and stores only hashes", async () => {
  const { db, d1 } = fixture();
  try {
    const verifier = native.randomToken(), code = await native.issueNativeCode(d1, "u", await native.challengeFor(verifier));
    assert.equal(await native.exchangeNativeCode(d1, code, native.randomToken()), null);
    const results = await Promise.all([native.exchangeNativeCode(d1, code, verifier), native.exchangeNativeCode(d1, code, verifier)]);
    assert.equal(results.filter(Boolean).length, 1);
    const session = results.find(Boolean);
    assert.equal((await native.readNativeIdentity(d1, session.accessToken)).id, "u");
    assert.notEqual(db.prepare("SELECT token_hash FROM native_sessions").get().token_hash, session.accessToken);
    assert.notEqual(db.prepare("SELECT code_hash FROM native_auth_codes").get().code_hash, code);
    await native.revokeNativeSession(d1, session.accessToken);
    assert.equal(await native.readNativeIdentity(d1, session.accessToken), null);
  } finally { db.close(); }
});
test("expired codes and sessions cannot authenticate", async () => {
  const { db, d1 } = fixture();
  try {
    const verifier = native.randomToken(), code = await native.issueNativeCode(d1, "u", await native.challengeFor(verifier));
    db.exec("UPDATE native_auth_codes SET expires_at='2000-01-01T00:00:00.000Z'");
    assert.equal(await native.exchangeNativeCode(d1, code, verifier), null);
    const session = await native.issueNativeSession(d1, "u");
    db.exec("UPDATE native_sessions SET expires_at='2000-01-01T00:00:00.000Z'");
    assert.equal(await native.readNativeIdentity(d1, session.accessToken), null);
    assert.equal(await native.readNativeIdentity(d1, "okri_other"), null);
  } finally { db.close(); }
});
test("Apple identity requires signature, audience, issuer, nonce and verified email", async () => {
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const resolver = jose.createLocalJWKSet({ keys: [{ ...await jose.exportJWK(publicKey), kid: "test" }] });
  const sign = claims => new jose.SignJWT({ email: "demo@example.test", email_verified: true, nonce: "nonce", ...claims }).setProtectedHeader({ alg: "RS256", kid: "test" }).setSubject("apple-user").setIssuer("https://appleid.apple.com").setAudience("ai.okri.app").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const token = await sign({});
  assert.equal((await apple.verifyAppleToken(token, "nonce", "ai.okri.app", resolver)).subject, "apple-user");
  await assert.rejects(apple.verifyAppleToken(token, "wrong", "ai.okri.app", resolver));
  await assert.rejects(apple.verifyAppleToken(token, "nonce", "other.app", resolver));
  await assert.rejects(apple.verifyAppleToken(await sign({ email_verified: false }), "nonce", "ai.okri.app", resolver));
  assert.equal(apple.appleConfigured({}), false);
});
test("native browser handoff is bound to the browser, challenge and state", async () => {
  const oauth = compileLanguageModule(await read("lib/google-oauth.ts"));
  const flow = compileLanguageModule(await read("lib/native-browser-flow.ts"), { "./google-oauth": oauth });
  const cookie = (await flow.nativeFlowCookie("challenge", "state", "test-secret")).split(";")[0];
  const request = new Request("https://okri.ai/api/native/callback", { headers: { cookie } });
  assert.equal(await flow.validNativeBrowserFlow(request, "challenge", "state", "test-secret"), true);
  assert.equal(await flow.validNativeBrowserFlow(request, "other", "state", "test-secret"), false);
  assert.equal(await flow.validNativeBrowserFlow(request, "challenge", "other", "test-secret"), false);
  assert.equal(await flow.validNativeBrowserFlow(request, "challenge", "state", "wrong-secret"), false);
  assert.equal(await flow.validNativeBrowserFlow(new Request(request.url), "challenge", "state", "test-secret"), false);
});

test("store reviewer access is secret-backed and creates an isolated native session", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email_normalized TEXT UNIQUE NOT NULL,language_preference TEXT NOT NULL DEFAULT 'ko',resolved_language TEXT NOT NULL DEFAULT 'ko',language_revision INTEGER NOT NULL DEFAULT 0,onboarding_state TEXT,display_name TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  db.exec(migration);
  const runtime = { DB: d1Fixture(db), OKRI_MOBILE_REVIEW_USERNAME: "google-reviewer", OKRI_MOBILE_REVIEW_PASSWORD: "a-long-random-review-password" };
  try {
    assert.equal(review.reviewAccessConfigured(runtime), true);
    assert.equal(await review.authenticateNativeReviewer(runtime, "google-reviewer", "wrong-password"), null);
    assert.equal(db.prepare("SELECT count(*) n FROM users").get().n, 0);
    const session = await review.authenticateNativeReviewer(runtime, "google-reviewer", "a-long-random-review-password");
    assert.match(session.accessToken, /^okri_native_[a-f0-9]{64}$/);
    assert.equal(session.user.email, "google-play-review@okri.invalid");
    assert.equal(db.prepare("SELECT resolved_language FROM users").get().resolved_language, "en");
  } finally { db.close(); }
});

const journal = JSON.parse(await read("drizzle/meta/_journal.json"));
const baseSchema = JSON.parse(await read("drizzle/meta/0038_snapshot.json"));
const allMigrations = await Promise.all(journal.entries.filter(entry => entry.idx >= 39).map(entry => read(`drizzle/${entry.tag}.sql`)));
const deletion = compileLanguageModule(await read("lib/native-account.ts"));
function deletionFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const table of Object.values(baseSchema.tables)) {
    const columns = Object.values(table.columns).map(c => `${c.name} ${c.type}${c.primaryKey ? " PRIMARY KEY" : ""}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${c.default}` : ""}`);
    for (const fk of Object.values(table.foreignKeys)) columns.push(`FOREIGN KEY (${fk.columnsFrom}) REFERENCES ${fk.tableTo} (${fk.columnsTo}) ON DELETE ${fk.onDelete}`);
    for (const constraint of Object.values(table.checkConstraints || {})) columns.push(`CONSTRAINT ${constraint.name} CHECK (${constraint.value})`);
    db.exec(`CREATE TABLE ${table.name} (${columns.join(",")})`);
    for (const index of Object.values(table.indexes)) db.exec(`CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${index.name} ON ${table.name} (${index.columns})${index.where ? ` WHERE ${index.where}` : ""}`);
  }
  for (const migration of allMigrations) db.exec(migration);
  const schema = d1Fixture(db), recorded = [];
  const d1 = { prepare: sql => ({ bind: (...values) => { const result = { sql, values }; recorded.push(result); return result; } }) };
  const batch = statements => { db.exec("BEGIN"); try { for (const { sql, values } of statements) db.prepare(sql).run(...values); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };
  return { db, d1, batch, schema };
}
test("account deletion removes solo data and preserves other teams in one transaction", () => {
  const { db, d1, batch } = deletionFixture();
  try {
    db.exec(`INSERT INTO users(id,email_normalized,display_name) VALUES('u','demo@example.test','Demo'),('other','other@example.test','Other');
      INSERT INTO workspaces(id,name,owner_user_id) VALUES('mine','Mine','u'),('team','Team','other');
      INSERT INTO workspace_members(id,workspace_id,user_id,display_name,role,status) VALUES('m','mine','u','Demo','owner','active'),('shared','team','u','Demo','member','active');
      INSERT INTO items(id,owner_id,kind,title) VALUES('private','mine','task','Private'),('shared-task','team','task','Shared');`);
    batch(deletion.accountDeletionStatements(d1, "u", ["mine"]));
    assert.equal(db.prepare("SELECT count(*) n FROM users WHERE id='u'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM items WHERE id='private'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM items WHERE id='shared-task'").get().n, 1);
    assert.equal(db.prepare("SELECT status FROM workspace_members WHERE id='shared'").get().status, "inactive");
    assert.equal(db.prepare("SELECT count(*) n FROM native_account_deletion_guards").get().n, 0);
  } finally { db.close(); }
});
test("account deletion rolls back if another member joined or ownership changed", () => {
  for (const change of ["INSERT INTO workspace_members(id,workspace_id,user_id,display_name,role,status) VALUES('other','mine','other','Other','member','active')", "UPDATE workspaces SET owner_user_id='other' WHERE id='mine'"]) {
    const { db, d1, batch } = deletionFixture();
    try {
      db.exec("INSERT INTO users(id,email_normalized,display_name) VALUES('u','demo@example.test','Demo'); INSERT INTO workspaces(id,name,owner_user_id) VALUES('mine','Mine','u'); INSERT INTO items(id,owner_id,kind,title) VALUES('task','mine','task','Task')");
      const statements = deletion.accountDeletionStatements(d1, "u", ["mine"]);
      db.exec(change);
      assert.throws(() => batch(statements), /native_account_deletion_safe/);
      assert.equal(db.prepare("SELECT count(*) n FROM users WHERE id='u'").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM items WHERE id='task'").get().n, 1);
    } finally { db.close(); }
  }
});
test("native requests enforce live membership, workspace identity and editor permissions", async () => {
  const source = await read("lib/pace-data.ts"), ast = ts.createSourceFile("pace-data.ts", source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "authorizeRequest").getText(ast);
  let identity = { id: "u", email: "demo@example.test", displayName: "Demo" };
  let membership = { workspaceId: "w", status: "active", role: "member", displayName: "Demo" }, editor = true;
  const deps = { env: { DB: {} }, ensureSchema: async () => {}, ensureBillingSchema: async () => {},
    requestedWorkspaceId: request => request.headers.get("x-okri-workspace-id"), resolveWorkspaceMembership: async () => membership, memberCanWrite: async () => editor };
  const { authorizeRequest } = compileLanguageModule(`const { ${Object.keys(deps).join(",")} } = require("deps");\n${fn}`, { deps, "@/lib/native-session": { readNativeIdentity: async () => identity } });
  const request = (method = "GET", workspace = "w") => new Request("https://okri.ai/api/items", { method, headers: { Authorization: "Bearer okri_native_mock", "x-okri-workspace-id": workspace } });
  assert.equal((await authorizeRequest(request())).ownerId, "w");
  assert.equal((await authorizeRequest(request("GET", "other"))).status, 403);
  membership = { ...membership, role: "viewer" };
  assert.equal((await authorizeRequest(request("PATCH"))).status, 403);
  assert.equal((await authorizeRequest(request())).role, "viewer");
  membership = { ...membership, role: "member" }; editor = false;
  assert.equal((await authorizeRequest(request("PATCH"))).status, 403);
  membership = { ...membership, status: "inactive" };
  assert.equal((await authorizeRequest(request())).status, 403);
  identity = null;
  assert.equal((await authorizeRequest(request())).status, 401);
});
