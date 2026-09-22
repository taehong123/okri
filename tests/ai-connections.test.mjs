import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import { drizzle } from "drizzle-orm/d1";

const require = createRequire(import.meta.url);
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function load(path, mocks = {}, override) {
  const loadedModule = { exports: {} };
  const compiled = ts.transpileModule(override ?? source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", compiled)((name) => name in mocks ? mocks[name] : require(name), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const providers = load("lib/integration-providers.ts");
const schema = load("db/schema.ts");
const authorization = { ownerId: "workspace-a", userId: "user-a", displayName: "<Owner>", email: "owner@example.com", role: "owner", apiToken: false };

test("AI dialog uses defined shared layout tokens, theme colors and paired primary button state colors", () => {
  const css = source("app/ai-connections.css");
  const theme = load("lib/themes.ts");
  const layoutTokens = source("app/globals.css").match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.ok(layoutTokens, "Shared layout tokens must exist");
  const defined = new Set([...`${theme.themeCss}\n${layoutTokens}`.matchAll(/--([a-z-]+):/g)].map((match) => match[1]));
  for (const match of css.matchAll(/var\(--([a-z-]+)/g)) assert.ok(defined.has(match[1]), `Undefined AI color token: ${match[1]}`);
  for (const state of ["primary", "primary-hover", "primary-active", "disabled"]) {
    assert.ok(css.includes(`--button-${state}-bg`));
    assert.ok(css.includes(`--button-${state}-fg`));
  }
  assert.doesNotMatch(css, /var\(--(?:text|bg)\)/);
});

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, scheduled_deletion_at TEXT);
    INSERT INTO workspaces (id) VALUES ('workspace-a'), ('workspace-b');
    CREATE TABLE workspace_members (id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, email TEXT, display_name TEXT, role TEXT, status TEXT, invited_by_user_id TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO workspace_members (id,workspace_id,user_id,email,display_name,role,status) VALUES ('member-a','workspace-a','user-a','owner@example.com','Owner','owner','active');
    CREATE TABLE integration_tokens (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
    INSERT INTO integration_tokens VALUES ('legacy-gpt','workspace-a','user-a','ChatGPT OAuth','legacy-gpt','prefix','2020-01-01',NULL,NULL),
      ('legacy-other','workspace-a','user-a','Codex','legacy-other','prefix','2020-01-01',NULL,NULL);`);
  sql.exec(source("drizzle/0035_ai_connections.sql"));
  const DB = {
    prepare(query) {
      return {
        values: [], query,
        bind(...values) { this.values = values; return this; },
        async first() { return sql.prepare(query).get(...this.values) ?? null; },
        async all() { return { results: sql.prepare(query).all(...this.values), success: true }; },
        async raw() { return sql.prepare(query).all(...this.values).map((row) => Object.values(row)); },
        async run() { const result = sql.prepare(query).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec("COMMIT"); return result; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  const data = source("lib/pace-data.ts");
  const tokenFunctions = data.slice(data.indexOf("export async function createIntegrationToken("), data.indexOf("export async function authorizeRequest("));
  const tokens = load("lib/pace-data.ts", { "@/db": { getDb: () => drizzle(DB) }, "@/db/schema": schema, "@/lib/integration-providers": providers }, `
    import { and, desc, eq, isNull, inArray, sql } from 'drizzle-orm';
    import { getDb } from '@/db'; import { integrationTokens } from '@/db/schema';
    import { effectiveIntegrationProvider } from '@/lib/integration-providers';
    const ensureSchema = async () => {}; ${tokenFunctions}`);
  const common = { "cloudflare:workers": { env: { DB } }, "@/lib/pace-data": tokens, "@/lib/integration-providers": providers, "@/lib/themes": load("lib/themes.ts"),
    "@/lib/mcp-oauth-metadata": load("lib/mcp-oauth-metadata.ts"), "@/lib/brand-artwork": load("lib/brand-artwork.ts") };
  const tokenSecurity = load("lib/integration-token-security.ts");
  const oauth = load("lib/mcp-oauth.ts", common);
  const approval = load("lib/mcp-oauth-approval.ts", common);
  const routes = { ...common, "@/lib/mcp-oauth": oauth, "@/lib/mcp-oauth-approval": approval, "@/lib/pace-data": {
    ...tokens,
    authorizeRequest: async (request) => ({ ...authorization, userId: request.headers.get("x-test-user") ?? authorization.userId, ownerId: request.headers.get("x-test-workspace") ?? authorization.ownerId, role: request.headers.get("x-test-role") ?? authorization.role, apiToken: request.headers.has("authorization") }),
    canManageTeam: (auth) => auth.role === "owner" || auth.role === "admin",
    getTeam: async () => ({ workspace: { name: '<Workspace "A">' } }),
  }, "@/lib/integration-token-security": tokenSecurity };
  const authFunction = data.slice(data.indexOf("export async function authorizeRequest("), data.indexOf("async function canonicalUserIdForGoogle("));
  const canManage = data.slice(data.indexOf("export function canManageTeam("), data.indexOf("function workspaceAvatarUrl("));
  const realAuth = load("lib/pace-data.ts", { ...common, "@/db": { getDb: () => drizzle(DB) }, "@/db/schema": schema }, `
    import { env } from 'cloudflare:workers'; import { and, desc, eq, isNull, inArray, sql } from 'drizzle-orm';
    import { getDb } from '@/db'; import { integrationTokens, workspaceMembers, workspaces } from '@/db/schema';
    import { effectiveIntegrationProvider } from '@/lib/integration-providers';
    const ensureSchema = async () => {}; const ensureBillingSchema = async () => {}; const readGoogleSession = async () => null;
    const memberCanWrite = async () => true;
    ${tokenFunctions} ${authFunction} ${canManage}`);
  return { sql, tokens, oauth, approval, realAuth, authorize: load("app/oauth/authorize/route.ts", routes), register: load("app/oauth/register/route.ts", routes), api: load("app/api/integration-tokens/route.ts", routes),
    clientKeysApi: load("app/api/integration-tokens/clients/route.ts", routes), personalMcpApi: load("app/api/integration-tokens/personal-mcp/route.ts", routes),
    bearerApi: load("app/api/integration-tokens/route.ts", { ...routes, "@/lib/pace-data": { ...routes["@/lib/pace-data"], authorizeRequest: realAuth.authorizeRequest } }) };
}
const verifier = "a".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const resource = "https://okri.ai/api/mcp";
async function consent(f, redirectUri = "https://claude.ai/api/mcp/auth_callback", headers = {}) {
  const client = await f.oauth.registerMcpOAuthClient({ redirectUris: [redirectUri], clientName: "Untrusted name" });
  const url = new URL("https://okri.ai/oauth/authorize");
  const params = { client_id: client.clientId, redirect_uri: redirectUri, response_type: "code", resource, code_challenge: challenge, code_challenge_method: "S256", state: "original-state" };
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await f.authorize.GET(new Request(url, { headers }));
  const html = await response.text();
  const id = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(id && csrf, html);
  return { client, url, html, id, csrf, cookie: response.headers.get("set-cookie").split(";")[0], response, redirectUri };
}
function submit(f, c, { fields = {}, headers = {} } = {}) {
  return f.authorize.POST(new Request("https://okri.ai/oauth/authorize", { method: "POST", headers: {
    origin: "https://okri.ai", "content-type": "application/x-www-form-urlencoded", cookie: c.cookie, ...headers,
  }, body: new URLSearchParams({ request_id: c.id, csrf: c.csrf, decision: "approve", ...fields }) }));
}

test("official links prefill OKRI; strict redirect policy supports only native port variation", () => {
  for (const organization of [false, true]) {
    const url = new URL(providers.claudeInstallUrl(organization));
    assert.equal(url.searchParams.get("connectorName"), "OKRI"); assert.equal(url.searchParams.get("connectorUrl"), resource);
    assert.equal(url.pathname, organization ? "/admin-settings/connectors" : "/customize/connectors");
  }
  assert.equal(providers.oauthProviderForRedirect("https://claude.ai/api/mcp/auth_callback"), "claude");
  assert.equal(providers.oauthProviderForRedirect("https://chatgpt.com/connector_platform_oauth_redirect"), "chatgpt");
  assert.equal(providers.matchesOAuthRedirect(["http://localhost:1234/callback"], "http://localhost:65432/callback"), true);
  assert.equal(providers.matchesOAuthRedirect(["http://127.0.0.1:1234/callback"], "http://localhost:1234/callback"), false);
  for (const uri of ["https://claude.ai.evil.test/api/mcp/auth_callback", "https://evil@claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback?evil=1", "https://claude.ai/api/mcp/auth_callback#x", "http://192.168.1.2:3000/callback", "http://localhost:3000/other", "http://localhost:3000/callback?x=1", "https://chatgpt.com:444/connector/oauth/x"]) assert.equal(providers.oauthProviderForRedirect(uri), null, uri);
  assert.equal(providers.registeredOAuthProvider(["https://claude.ai/api/mcp/auth_callback", "http://localhost:1/callback"]), null);
});

test("migration preserves historical tokens and provider filters/caps/revocation isolate users and workspaces", async () => {
  const f = fixture();
  try {
    let connections = await f.tokens.listIntegrationTokens(authorization);
    assert.deepEqual(connections.map((c) => c.provider).sort(), ["chatgpt", "other"]);
    for (let i = 0; i < 12; i++) await f.tokens.createIntegrationToken(authorization, "Claude OAuth", "claude");
    await f.tokens.createIntegrationToken({ ...authorization, userId: "other-user" }, "Claude OAuth", "claude");
    await f.tokens.createIntegrationToken({ ...authorization, ownerId: "workspace-b" }, "Claude OAuth", "claude");
    assert.equal((await f.tokens.listIntegrationTokens(authorization, "claude")).length, 10);
    assert.equal((await f.tokens.listIntegrationTokens(authorization, "chatgpt")).length, 1);
    assert.equal((await f.tokens.revokeIntegrationTokens(authorization, undefined, "claude")).revoked, 10);
    connections = await f.tokens.listIntegrationTokens(authorization);
    assert.deepEqual(connections.map((c) => c.id).sort(), ["legacy-gpt", "legacy-other"]);
    assert.equal((await f.tokens.listIntegrationTokens({ ...authorization, ownerId: "workspace-b" }, "claude")).length, 1);
    assert.equal((await f.tokens.listIntegrationTokens({ ...authorization, userId: "other-user" }, "claude")).length, 1);
    assert.equal(providers.effectiveIntegrationProvider({ name: "ChatGPT OAuth", provider: "other" }), "other");
    assert.equal((await f.api.GET(new Request("https://okri.ai/api/integration-tokens?provider=invalid"))).status, 400);
  } finally { f.sql.close(); }
});

test("Claude approval is escaped, user/workspace/CSRF/origin bound and consumed once; exchange preserves PKCE/resource/callback", async () => {
  const f = fixture();
  try {
    const c = await consent(f);
    assert.match(c.html, /Claude 연결 승인/); assert.match(c.html, /&lt;Owner&gt;/); assert.match(c.html, /&lt;Workspace &quot;A&quot;&gt;/);
    assert.equal(c.response.headers.get("x-frame-options"), "DENY");
    assert.doesNotMatch(c.response.headers.get("content-security-policy"), /unsafe-inline/);
    const nonce = c.html.match(/<script nonce="([a-f0-9]+)"/)?.[1];
    assert.ok(nonce && c.response.headers.get("content-security-policy").includes(`'nonce-${nonce}'`));
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_codes").get().n, 0);
    for (const override of [ { headers: { origin: "https://evil.test" } }, { headers: { "x-test-user": "attacker" } }, { headers: { "x-test-workspace": "workspace-b" } }, { headers: { cookie: "" } }, { fields: { csrf: "b".repeat(64) } }, { headers: { authorization: "Bearer test" } } ]) assert.equal((await submit(f, c, override)).status, 400);
    const approved = await submit(f, c, { fields: { redirect_uri: "https://evil.test/callback", workspace_id: "workspace-b" } });
    assert.equal(approved.status, 303);
    const callback = new URL(approved.headers.get("location"));
    assert.equal(callback.origin, "https://claude.ai"); assert.equal(callback.searchParams.get("state"), "original-state");
    assert.equal((await submit(f, c)).status, 400);
    const grant = { code: callback.searchParams.get("code"), clientId: c.client.clientId, redirectUri: c.redirectUri, codeVerifier: verifier, resource };
    for (const tamper of [{ codeVerifier: "b".repeat(64) }, { resource: "https://evil.test/api/mcp" }, { clientId: "forged" }, { redirectUri: "http://localhost:3000/callback" }]) await assert.rejects(f.oauth.exchangeMcpOAuthAuthorizationCode({ ...grant, ...tamper }), /invalid_grant/);
    const token = await f.oauth.exchangeMcpOAuthAuthorizationCode(grant);
    assert.match(token.accessToken, /^okri_/);
    await assert.rejects(f.oauth.exchangeMcpOAuthAuthorizationCode(grant), /invalid_grant/);
    const [record] = await f.tokens.listIntegrationTokens(authorization, "claude");
    assert.equal(record.name, "Claude OAuth"); assert.equal(record.lastUsedAt, null);
  } finally { f.sql.close(); }
});

test("cancel, expired approval, expired code, forged callback and direct Code port binding", async () => {
  const f = fixture();
  try {
    const cancel = await consent(f);
    const response = await submit(f, cancel, { fields: { decision: "cancel" } });
    assert.equal(new URL(response.headers.get("location")).searchParams.get("error"), "access_denied");
    assert.equal((await submit(f, cancel)).status, 400);
    const expired = await consent(f);
    f.sql.prepare("UPDATE mcp_oauth_approvals SET expires_at='2000-01-01' WHERE id=?").run(expired.id);
    assert.equal((await submit(f, expired)).status, 400);
    const code = await consent(f, "http://127.0.0.1:43111/callback");
    assert.match(code.html, /http:\/\/127\.0\.0\.1:43111\/callback/);
    const redirect = new URL((await submit(f, code)).headers.get("location"));
    const grant = { code: redirect.searchParams.get("code"), clientId: code.client.clientId, redirectUri: code.redirectUri, codeVerifier: verifier, resource };
    await assert.rejects(f.oauth.exchangeMcpOAuthAuthorizationCode({ ...grant, redirectUri: "http://127.0.0.1:43112/callback" }), /invalid_grant/);
    await f.oauth.exchangeMcpOAuthAuthorizationCode(grant);
    assert.equal((await f.tokens.listIntegrationTokens(authorization, "claude_code")).length, 1);
    const oldCode = await f.oauth.createMcpOAuthAuthorizationCode(authorization, { clientId: code.client.clientId, redirectUri: code.redirectUri, codeChallenge: challenge, resource, scope: "okri:read" });
    f.sql.exec("UPDATE mcp_oauth_codes SET expires_at='2000-01-01'");
    await assert.rejects(f.oauth.exchangeMcpOAuthAuthorizationCode({ ...grant, code: oldCode }), /invalid_grant/);
    code.url.searchParams.set("redirect_uri", "https://evil.test/callback");
    assert.equal((await f.authorize.GET(new Request(code.url))).status, 400);
  } finally { f.sql.close(); }
});

test("DCR rejects spoofed/mixed metadata; existing ChatGPT callback still issues a code without a new approval", async () => {
  const f = fixture();
  try {
    for (const redirect_uris of [["https://evil.test/callback"], ["https://claude.ai/api/mcp/auth_callback", 42]]) {
      const response = await f.register.POST(new Request("https://okri.ai/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris }) }));
      assert.equal(response.status, 400);
    }
    const client = await f.oauth.registerMcpOAuthClient({ redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"] });
    const url = new URL("https://okri.ai/oauth/authorize");
    Object.entries({ client_id: client.clientId, redirect_uri: client.redirectUris[0], response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource }).forEach(([k, v]) => url.searchParams.set(k, v));
    const response = await f.authorize.GET(new Request(url));
    assert.equal(response.status, 303); assert.ok(new URL(response.headers.get("location")).searchParams.has("code"));
  } finally { f.sql.close(); }
});

test("OAuth bearer access stays workspace-bound, revocable, and limited by scope and current role", async () => {
  const f = fixture();
  const policy = load("lib/work-intake.ts");
  try {
    const { token } = await f.tokens.createIntegrationToken(authorization, "Claude OAuth", "claude", "okri:read");
    const request = (method = "POST") => new Request("https://okri.ai/api/mcp?workspaceId=workspace-b", { method, headers: { authorization: `Bearer ${token}`, "x-okri-workspace-id": "workspace-b" } });
    assert.equal((await f.realAuth.authorizeRequest(request())).status, 403);
    const read = await f.realAuth.authorizeRequest(request(), { allowViewerWrite: policy.isReadOnlyMcpRequest({ method: "tools/call", params: { name: "list_items" } }), requiredIntegrationScope: "okri:read" });
    assert.equal(read.ownerId, "workspace-a"); assert.equal(read.userId, "user-a");
    assert.equal(policy.isReadOnlyMcpRequest({ method: "tools/call", params: { name: "create_item" } }), false);
    assert.equal(policy.isReadOnlyMcpRequest([{ method: "tools/list" }]), false);
    assert.equal(policy.isReadOnlyMcpRequest({ method: "tools/call", params: { name: "unknown" } }), false);
    f.sql.exec("UPDATE workspace_members SET role='member'");
    assert.equal(f.realAuth.canManageTeam(await f.realAuth.authorizeRequest(request("GET"))), false);
    f.sql.exec("UPDATE workspace_members SET role='viewer'");
    const viewer = await f.realAuth.authorizeRequest(request(), { allowViewerWrite: policy.isReadOnlyMcpRequest({ method: "tools/list" }), requiredIntegrationScope: "okri:read" });
    assert.equal(viewer.role, "viewer");
    f.sql.exec("UPDATE workspace_members SET status='removed'");
    assert.equal((await f.realAuth.authorizeRequest(request("GET"))).status, 403);
    await f.tokens.revokeIntegrationTokens(authorization, undefined, "claude");
    assert.equal((await f.realAuth.authorizeRequest(request("GET"))).status, 401);
  } finally { f.sql.close(); }
});

test("client sync bearer is least-privilege and cannot read regular APIs or call MCP", async () => {
  const f = fixture();
  try {
    const { token, connection } = await f.tokens.createIntegrationToken(authorization, "CRM push", "other", "okri:clients:write", true);
    const request = (method = "POST") => new Request("https://okri.ai/api/items", { method, headers: { authorization: `Bearer ${token}` } });
    for (const attempt of [
      f.realAuth.authorizeRequest(request("GET")),
      f.realAuth.authorizeRequest(request("POST")),
      f.realAuth.authorizeRequest(request("POST"), { requiredIntegrationScope: "okri:read", allowViewerWrite: true }),
      f.realAuth.authorizeRequest(request("POST"), { requiredIntegrationScope: "okri:write" }),
    ]) {
      const response = await attempt;
      assert.ok(response instanceof Response);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "integration_scope_denied");
    }
    const accepted = await f.realAuth.authorizeRequest(request("POST"), { requiredIntegrationScope: "okri:clients:write" });
    assert.equal(accepted.integrationTokenId, connection.id);
    assert.equal(accepted.oauthScopes, "okri:clients:write");
    assert.deepEqual((await f.tokens.listIntegrationTokensByScopes(authorization, ["okri:clients:write"])).map((entry) => entry.id), [connection.id]);
    const legacy = await f.tokens.createIntegrationToken(authorization, "Existing integration", "other", "okri:read okri:write");
    const legacyAccepted = await f.realAuth.authorizeRequest(new Request("https://okri.ai/api/integrations/clients/upsert", { method: "POST", headers: { authorization: `Bearer ${legacy.token}` } }), { requiredIntegrationScope: ["okri:clients:write", "okri:write"] });
    assert.equal(legacyAccepted.integrationTokenId, legacy.connection.id);
  } finally { f.sql.close(); }
});

test("purpose key routes require browser same-origin access and isolate individual users and keys", async () => {
  const f = fixture();
  const write = (url, body, headers = {}) => new Request(url, { method: "POST", headers: {
    origin: "https://okri.ai", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers,
  }, body: JSON.stringify(body) });
  try {
    assert.equal((await f.clientKeysApi.POST(new Request("https://okri.ai/api/integration-tokens/clients", { method: "POST", body: "{}" }))).status, 403);
    assert.equal((await f.clientKeysApi.POST(write("https://okri.ai/api/integration-tokens/clients", { name: "CRM" }, { origin: "https://evil.test" }))).status, 403);
    assert.equal((await f.clientKeysApi.POST(write("https://okri.ai/api/integration-tokens/clients", { name: "CRM" }, { authorization: "Bearer forbidden" }))).status, 403);
    assert.equal((await f.clientKeysApi.POST(write("https://okri.ai/api/integration-tokens/clients", { name: "CRM" }, { "x-test-role": "member" }))).status, 403);

    const createdResponse = await f.clientKeysApi.POST(write("https://okri.ai/api/integration-tokens/clients", { name: "CRM 고객 동기화" }));
    assert.equal(createdResponse.status, 201);
    assert.match(createdResponse.headers.get("cache-control"), /no-store/);
    const created = await createdResponse.json();
    assert.match(created.token, /^okri_/);
    assert.equal(created.connection.name, "CRM 고객 동기화");
    const listed = await f.clientKeysApi.GET(new Request("https://okri.ai/api/integration-tokens/clients", { headers: { "sec-fetch-site": "same-origin" } }));
    const listedText = await listed.text();
    assert.equal(listed.status, 200);
    assert.equal(JSON.parse(listedText).keys.length, 1);
    assert.equal(listedText.includes(created.token), false);
    const otherUser = await f.clientKeysApi.GET(new Request("https://okri.ai/api/integration-tokens/clients", { headers: { "sec-fetch-site": "same-origin", "x-test-user": "user-b" } }));
    assert.equal((await otherUser.json()).keys.length, 0);

    const viewerWrite = await f.personalMcpApi.POST(write("https://okri.ai/api/integration-tokens/personal-mcp", { name: "Viewer MCP", access: "read_write" }, { "x-test-role": "viewer" }));
    assert.equal(viewerWrite.status, 403);
    const viewerRead = await f.personalMcpApi.POST(write("https://okri.ai/api/integration-tokens/personal-mcp", { name: "Viewer MCP", access: "read" }, { "x-test-role": "viewer" }));
    assert.equal(viewerRead.status, 201);
    const readKey = await viewerRead.json();
    assert.match(readKey.token, /^okri_/);
    const mcpList = await f.personalMcpApi.GET(new Request("https://okri.ai/api/integration-tokens/personal-mcp", { headers: { "sec-fetch-site": "same-origin" } }));
    const mcpText = await mcpList.text();
    assert.equal(mcpText.includes(readKey.token), false);
    assert.equal(JSON.parse(mcpText).keys[0].access, "read");

    const crossOriginDelete = await f.clientKeysApi.DELETE(new Request(`https://okri.ai/api/integration-tokens/clients?id=${created.connection.id}`, { method: "DELETE", headers: { origin: "https://evil.test" } }));
    assert.equal(crossOriginDelete.status, 403);
    const otherDelete = await f.clientKeysApi.DELETE(new Request(`https://okri.ai/api/integration-tokens/clients?id=${created.connection.id}`, { method: "DELETE", headers: { origin: "https://okri.ai", "sec-fetch-site": "same-origin", "x-test-user": "user-b" } }));
    assert.equal(otherDelete.status, 404);
    const deleted = await f.clientKeysApi.DELETE(new Request(`https://okri.ai/api/integration-tokens/clients?id=${created.connection.id}`, { method: "DELETE", headers: { origin: "https://okri.ai", "sec-fetch-site": "same-origin" } }));
    assert.equal(deleted.status, 200);
    assert.equal((await f.personalMcpApi.GET(new Request("https://okri.ai/api/integration-tokens/personal-mcp", { headers: { "sec-fetch-site": "same-origin" } }))).status, 200);
  } finally { f.sql.close(); }
});

test("connection management rejects current and legacy bearer scopes across providers", async () => {
  const f = fixture();
  try {
    for (const scope of ["okri:read", "okri:read okri:write", "okrptr:read", "okrptr:read okrptr:write"]) {
      const { token } = await f.tokens.createIntegrationToken(authorization, "Claude OAuth", "claude", scope);
      for (const method of ["POST", "DELETE"]) {
        const response = await f.bearerApi[method](new Request("https://okri.ai/api/integration-tokens?provider=chatgpt", {
          method, headers: { authorization: `Bearer ${token}` },
        }));
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error, "browser_session_required");
      }
    }
    assert.equal((await f.tokens.listIntegrationTokens(authorization, "chatgpt")).length, 1);
    const response = await f.api.DELETE(new Request("https://okri.ai/api/integration-tokens?provider=chatgpt", { method: "DELETE" }));
    assert.equal(response.status, 200);
    assert.equal((await f.tokens.listIntegrationTokens(authorization, "chatgpt")).length, 0);
    assert.equal((await f.tokens.listIntegrationTokens(authorization, "claude")).length, 4);
  } finally { f.sql.close(); }
});

test("viewer consent permanently bounds scope even after promotion; demotion at approval also narrows scope", async () => {
  const f = fixture();
  try {
    for (const roles of [["viewer", "member"], ["owner", "viewer"]]) {
      const c = await consent(f, undefined, { "x-test-role": roles[0] });
      const stored = JSON.parse(f.sql.prepare("SELECT request_json FROM mcp_oauth_approvals WHERE id=?").get(c.id).request_json);
      if (roles[0] === "viewer") {
        assert.equal(stored.scope, "okri:read");
        assert.match(c.html, /읽기 전용/);
        assert.doesNotMatch(c.html, /업무 생성·수정·삭제/);
      }
      const response = await submit(f, c, { headers: { "x-test-role": roles[1] } });
      const code = new URL(response.headers.get("location")).searchParams.get("code");
      const issued = await f.oauth.exchangeMcpOAuthAuthorizationCode({ code, clientId: c.client.clientId, redirectUri: c.redirectUri, codeVerifier: verifier, resource });
      assert.equal(issued.scope, "okri:read");
      f.sql.exec("UPDATE workspace_members SET role='member'");
      const headers = { authorization: `Bearer ${issued.accessToken}` };
      assert.equal((await f.realAuth.authorizeRequest(new Request(resource, { method: "POST", headers }))).status, 403);
      const read = await f.realAuth.authorizeRequest(new Request(resource, { method: "POST", headers }), { allowViewerWrite: true, requiredIntegrationScope: "okri:read" });
      assert.equal(read.role, "member");
      assert.equal(read.oauthScopes, "okri:read");
    }
  } finally { f.sql.close(); }
});
