import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sources = Object.fromEntries(await Promise.all([
  ["settings", "daily/settings"], ["onboarding", "onboarding"], ["disconnect", "disconnect"], ["callback", "callback"], ["events", "events"],
].map(async ([name, path]) => [name, ts.transpileModule(await readFile(new URL(`../app/api/slack/${path}/route.ts`, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText])));
const oauthOutput = ts.transpileModule(await readFile(new URL("../lib/slack-oauth.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const digestSource = ts.createSourceFile("digest.ts", await readFile(new URL("../lib/slack-daily-digest.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const digestFunction = digestSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "parseDigestSettings").getFullText(digestSource);
const digestCode = ts.transpileModule(digestFunction.replace("export function", "function"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const parseDigestSettings = new Function(`${digestCode}; return parseDigestSettings;`)();

function harness() {
  const calls = [], pending = [], receipts = new Set();
  const old = { id: "old", ownerId: "workspace", teamId: "T-old", botUserId: "U-bot", encryptedBotToken: "mock-cipher" };
  const state = {
    authorization: { ownerId: "workspace", userId: "user", role: "owner" },
    oauth: { ownerId: "workspace", userId: "user", returnTo: "/?bot=daily" },
    stillAdmin: true, configured: true, signature: true, connection: old,
    target: null, cleanupError: null, deleteError: null,
    install: { access_token: "mock-token", team: { id: "T-new" }, scope: "chat:write" },
  };
  class SlackWorkspaceConnectionError extends Error {}
  class SlackOAuthExchangeError extends Error {}
  const deps = {
    "@/lib/slack-daily-digest": { parseDigestSettings },
    "@/lib/slack-daily-manual": {
      async latestDailyManualRun() { return null; },
      async startDailyManualRun(_db, auth, id) { calls.push(["bulk-start", auth.ownerId, id]); return { id, status: "pending" }; },
      async getDailyManualRun(_db, ownerId, id) { calls.push(["bulk-read", ownerId, id]); return { id, status: "pending" }; },
      async processDailyManualRun(_db, ownerId, id) { calls.push(["bulk-process", ownerId, id]); },
    },
    "@/lib/slack-bot-delivery": { async runDueSlackBotDeliveries() { calls.push(["retry-deliveries"]); } },
    "cloudflare:workers": {
      env: { SLACK_TOKEN_ENCRYPTION_KEY: "mock", SLACK_SIGNING_SECRET: "mock", DB: { prepare() {
        return { bind(id, team) { return { async run() {
          calls.push(["receipt", id, team]);
          const changes = Number(!receipts.has(id)); receipts.add(id);
          return { meta: { changes } };
        } }; } };
      } } },
      waitUntil(promise) { pending.push(promise); },
    },
    "@/lib/pace-data": {
      async authorizeRequest(request) { calls.push(["authorize", request.headers.get("x-okri-workspace-id")]); return state.authorization; },
      canManageTeam: (auth) => ["owner", "admin"].includes(auth.role),
      async ensureWorkspace(id) { calls.push(["ensure", id]); },
      async getSlackConnection(id) { calls.push(["connection", id]); return state.connection; },
      async getSlackConnectionByTeam(team) { calls.push(["team", team]); return state.target; },
      async deleteSlackConnection(id, expected) {
        calls.push(["delete", id, expected]);
        if (state.deleteError) throw new Error(state.deleteError);
        state.connection = null;
      },
      async consumeSlackOAuthState(value) { calls.push(["state", value]); return state.oauth; },
      async hasWorkspaceAdminAccess(owner, user) { calls.push(["access", owner, user]); return state.stillAdmin; },
      async saveSlackConnection(value) { calls.push(["save", value.ownerId, value.teamId]); return { previousConnection: state.connection }; },
      SlackWorkspaceConnectionError,
    },
    "@/lib/slack-daily": {
      async updateSlackDailySettings(ownerId, input) { calls.push(["update", ownerId, input]); return { settings: input }; },
      async configureSlackDailyOnboarding(auth, input) { calls.push(["setup", auth.ownerId, input]); return { settings: input }; },
      async disconnectSlackDaily(id, connection) {
        calls.push(["cleanup", id, connection.id]);
        if (state.cleanupError) throw new Error(state.cleanupError);
      },
      async syncSlackDailyInstallation(id) { calls.push(["sync", id]); },
      async reconcileDailyReminders(id, options) { calls.push(["reconcile", id, options]); },
      async repairSlackDailyReminders(id) { calls.push(["repair", id]); },
      async handleDeliveredDailyReminder(value) { calls.push(["delivery", value]); },
      async getSlackDailySettings(auth) { calls.push(["settings", auth.ownerId]); return { ownerId: auth.ownerId, delivery: { status: "ready" } }; },
    },
    "@/lib/slack-work-command": {
      parseSlackWorkCommand: () => null,
      async handleSlackWorkCommandEvent() { calls.push(["work-command"]); },
    },
    "@/lib/slack-oauth": {
      slackConfigured: () => state.configured,
      async verifySlackRequest() { calls.push(["verify"]); return state.signature; },
      async decryptSlackSecret() { calls.push(["decrypt"]); return "mock-token"; },
      async revokeSlackToken() { calls.push(["revoke"]); },
      async encryptSlackSecret() { calls.push(["encrypt"]); return "mock-new-cipher"; },
      async exchangeSlackCode() { calls.push(["exchange"]); return state.install; },
      redirectWithSlackStatus: (request, path, status) => Response.redirect(new URL(`${path}&slack=${status}`, request.url), 303),
      classifySlackOAuthError: () => "oauth_exchange_failed", slackScopes: ["chat:write"], SlackOAuthExchangeError,
    },
  };
  const routes = Object.fromEntries(Object.entries(sources).map(([name, output]) => {
    const loaded = { exports: {} };
    new Function("require", "module", "exports", output)((id) => {
      assert.ok(id in deps, `unmocked dependency ${id}`); return deps[id];
    }, loaded, loaded.exports);
    return [name, loaded.exports];
  }));
  const request = (method = "POST", body) => new Request("https://example.test/api/slack?state=state&code=code", {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  return { routes, state, calls, pending, request, old };
}

test("summary settings and onboarding preserve OFF/time and validate input under workspace admin authorization", async () => {
  for (const [name, method] of [["settings", "PATCH"], ["onboarding", "POST"]]) {
    const h = harness();
    const response = await h.routes[name][method](h.request(method, { ownerId: "foreign", summaryEnabled: false, summaryTime: "13:30" }));
    assert.equal(response.status, 200);
    const write = h.calls.find((call) => ["update", "setup"].includes(call[0]));
    assert.equal(write[1], "workspace"); assert.equal(write[2].summaryEnabled, false); assert.equal(write[2].summaryTime, "13:30");
    for (const input of [{ summaryEnabled: "false" }, { summaryTime: "24:00" }, { summaryTime: null }]) {
      assert.equal((await h.routes[name][method](h.request(method, input))).status, 400);
    }
    for (const role of ["member", "viewer"]) {
      h.state.authorization.role = role;
      assert.equal((await h.routes[name][method](h.request(method, { summaryEnabled: true }))).status, 403);
    }
    assert.equal(h.calls.filter((call) => ["update", "setup"].includes(call[0])).length, 1);
  }
});

test("daily settings do not require channel message history or mention access", () => {
  const loaded = { exports: {} };
  new Function("require", "module", "exports", oauthOutput)(() => ({}), loaded, loaded.exports);
  for (const scope of ["channels:history", "groups:history", "app_mentions:read"]) {
    assert.ok(!loaded.exports.slackDailyScopes.includes(scope));
    assert.ok(loaded.exports.slackScopes.includes(scope));
  }
  assert.ok(loaded.exports.slackDailyScopes.includes("im:history"));
  assert.ok(loaded.exports.slackDailyScopes.includes("chat:write"));
});

test("bulk send and polling use authorized workspace and require admin access", async () => {
  for (const role of ["owner", "admin", "member", "viewer"]) {
    const h = harness(); h.state.authorization.role = role;
    const response = await h.routes.settings.PATCH(h.request("PATCH", { action: "send_all_now", requestId: "manual-request-0001", ownerId: "other" }));
    assert.equal(response.status, ["owner", "admin"].includes(role) ? 202 : 403);
    await Promise.all(h.pending);
    if (role === "owner" || role === "admin") assert.deepEqual(h.calls.find((call) => call[0] === "bulk-start"), ["bulk-start", "workspace", "manual-request-0001"]);
    else assert.ok(!h.calls.some((call) => call[0].startsWith("bulk-")));
    const poll = await h.routes.settings.GET(new Request("https://example.test/api/slack/daily/settings?runId=manual-request-0001&ownerId=other"));
    assert.equal(poll.status, ["owner", "admin"].includes(role) ? 200 : 403);
  }
  const h = harness();
  await h.routes.settings.GET(new Request("https://example.test/api/slack/daily/settings"));
  assert.ok(!h.calls.some((call) => call[0].startsWith("bulk-")));
});

for (const role of ["owner", "admin", "member", "viewer", "unauthenticated"]) {
  test(`repair and disconnect enforce ${role} access without cross-workspace input`, async () => {
    for (const action of ["repair", "disconnect"]) {
      const h = harness();
      h.state.authorization = role === "unauthenticated" ? new Response(null, { status: 401 }) : { ...h.state.authorization, role };
      const response = action === "repair"
        ? await h.routes.settings.PATCH(h.request("PATCH", { action: "repair", ownerId: "other" }))
        : await h.routes.disconnect.POST(h.request("POST", { ownerId: "other" }));
      const allowed = ["owner", "admin"].includes(role);
      assert.equal(response.status, allowed ? 200 : role === "unauthenticated" ? 401 : 403);
      if (!allowed) assert.deepEqual(h.calls.map((c) => c[0]), ["authorize"]);
      else if (action === "repair") assert.deepEqual(h.calls.find((c) => c[0] === "reconcile"), ["reconcile", "workspace", { verify: true }]);
      else assert.deepEqual(h.calls.find((c) => c[0] === "cleanup"), ["cleanup", "workspace", "old"]);
    }
  });
}

test("disconnect retains the token on busy or failed cleanup and deletes only its captured connection", async () => {
  for (const error of ["reservation in flight", "cancellation rejected"]) {
    const h = harness(); h.state.cleanupError = error;
    const response = await h.routes.disconnect.POST(h.request());
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, error);
    assert.equal(h.state.connection.id, "old");
    assert.ok(!h.calls.some((c) => ["delete", "revoke"].includes(c[0])));
  }
  const h = harness();
  assert.equal((await h.routes.disconnect.POST(h.request())).status, 200);
  assert.deepEqual(h.calls.filter((c) => ["cleanup", "delete", "revoke"].includes(c[0])), [
    ["cleanup", "workspace", "old"], ["delete", "workspace", "old"], ["revoke"],
  ]);
});

test("disconnect does not report success when credentials are unavailable or replaced concurrently", async () => {
  for (const scenario of ["configuration", "replacement"]) {
    const h = harness();
    if (scenario === "configuration") h.state.configured = false;
    else h.state.deleteError = "connection changed";
    assert.equal((await h.routes.disconnect.POST(h.request())).status, scenario === "configuration" ? 503 : 409);
    assert.ok(!h.calls.some((c) => c[0] === "revoke"));
    assert.equal(h.state.connection.id, "old");
  }
});

for (const scenario of ["missing-state", "wrong-workspace", "wrong-user", "viewer", "revoked-admin"]) {
  test(`OAuth ${scenario} is rejected before changing any installation`, async () => {
    const h = harness();
    if (scenario === "missing-state") h.state.oauth = null;
    if (scenario === "wrong-workspace") h.state.authorization.ownerId = "other";
    if (scenario === "wrong-user") h.state.authorization.userId = "other";
    if (scenario === "viewer") h.state.authorization.role = "viewer";
    if (scenario === "revoked-admin") h.state.stillAdmin = false;
    const response = await h.routes.callback.GET(h.request("GET"));
    assert.match(response.headers.get("location"), /slack=(workspace_admin_required|oauth_exchange_failed)/);
    assert.ok(!h.calls.some((c) => ["exchange", "cleanup", "save", "sync"].includes(c[0])));
  });
}

test("OAuth preflights team ownership and preserves an installation when old reservations cannot be canceled", async () => {
  for (const scenario of ["foreign-team", "cleanup-failure"]) {
    const h = harness();
    if (scenario === "foreign-team") h.state.target = { ownerId: "other" };
    else h.state.cleanupError = "reservation locked";
    const response = await h.routes.callback.GET(h.request("GET"));
    assert.match(response.headers.get("location"), /slack=(workspace_already_connected|oauth_exchange_failed)/);
    assert.ok(!h.calls.some((c) => ["save", "revoke", "sync"].includes(c[0])));
    if (scenario === "foreign-team") assert.ok(!h.calls.some((c) => c[0] === "cleanup"));
  }
});

test("OAuth team switch cleans before saving and same-team reinstall keeps recipient setup", async () => {
  for (const sameTeam of [false, true]) {
    const h = harness();
    if (sameTeam) h.state.install.team.id = "T-old";
    const response = await h.routes.callback.GET(h.request("GET"));
    assert.match(response.headers.get("location"), /slack=setup_required/);
    assert.deepEqual(h.calls.find((c) => c[0] === "authorize"), ["authorize", "workspace"]);
    assert.deepEqual(h.calls.filter((c) => ["cleanup", "save", "revoke", "sync"].includes(c[0])).map((c) => c[0]),
      sameTeam ? ["save", "sync"] : ["cleanup", "save", "revoke", "sync"]);
  }
});

test("unsigned or duplicate Slack events cannot dispatch maintenance", async () => {
  const h = harness();
  const event = { event_id: "event", team_id: "T-old", event: { type: "app_home_opened" } };
  h.state.signature = false;
  assert.equal((await h.routes.events.POST(h.request("POST", event))).status, 401);
  assert.equal(h.pending.length, 0);
  assert.ok(!h.calls.some((c) => c[0] === "receipt"));
  h.state.signature = true; h.state.target = h.old;
  await h.routes.events.POST(h.request("POST", event));
  await h.routes.events.POST(h.request("POST", event));
  await Promise.all(h.pending);
  assert.deepEqual(h.calls.filter((c) => c[0] === "repair"), [["repair", "workspace"]]);
  assert.ok(!h.calls.some((c) => c[0] === "reconcile"));
});

test("Slack event dispatch uses the signed team's workspace and exact delivery marker", async () => {
  const h = harness();
  await h.routes.events.POST(h.request("POST", { event_id: "foreign", team_id: "T-unknown" }));
  assert.equal(h.pending.length, 0);
  h.state.target = { ...h.old, ownerId: "other", teamId: "T-other", botUserId: "U-other" };
  await h.routes.events.POST(h.request("POST", { event_id: "other", team_id: "T-other", ownerId: "workspace", event: { type: "app_home_opened" } }));
  await h.routes.events.POST(h.request("POST", { event_id: "delivered", team_id: "T-other", event: {
    type: "message", channel_type: "im", channel: "D-other", user: "U-other", blocks: [{ block_id: "marker" }],
  } }));
  await Promise.all(h.pending);
  assert.deepEqual(h.calls.filter((c) => c[0] === "repair"), [["repair", "other"]]);
  assert.deepEqual(h.calls.find((c) => c[0] === "delivery"), ["delivery", { teamId: "T-other", channelId: "D-other", botId: "U-other", blockIds: ["marker"] }]);
});

test("Slack OAuth exchange and token revocation have bounded external requests", async (t) => {
  const loaded = { exports: {} };
  new Function("module", "exports", oauthOutput)(loaded, loaded.exports);
  const deadlines = [], calls = [];
  t.mock.method(AbortSignal, "timeout", (ms) => { deadlines.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    calls.push(new URL(url).pathname);
    return Response.json({ ok: true });
  });
  await loaded.exports.exchangeSlackCode({ SLACK_CLIENT_ID: "fixture", SLACK_CLIENT_SECRET: "fixture" }, new Request("https://example.test/api/slack/callback"), "fixture-code");
  await loaded.exports.revokeSlackToken("fixture-token");
  assert.deepEqual(deadlines, [15_000, 15_000]);
  assert.deepEqual(calls, ["/api/oauth.v2.access", "/api/auth.revoke"]);
});
