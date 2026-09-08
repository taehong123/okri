import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as zod from "zod";
import ts from "typescript";
import { compileLanguageModule } from "./helpers/language-fixture.mjs";
const read = p => readFile(new URL("../" + p, import.meta.url), "utf8");
const fixture = JSON.parse(await read("tests/fixtures/mobile-v1-1.0.0.json"));
const contracts = compileLanguageModule(await read("lib/mobile/v1-contract.ts"), { zod });
const { mobileV1 } = compileLanguageModule(await read("lib/mobile/v1-adapter.ts"), { "./v1-contract": contracts });
const model = compileLanguageModule(await read("mobile/src/model.ts"));
const auth = "Bearer okri_native_" + "a".repeat(64);
function request(endpoint, method = "GET", body, extra = {}) {
  return new Request("https://okri.ai/api/mobile/v1/" + endpoint, { method, headers: { authorization: auth, "content-type": "application/json", "x-okri-workspace-id": "workspace-1", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
test("frozen 1.0.0 payloads preserve every consumed field; additive web fields are stripped", () => {
  assert.deepEqual(contracts.bootstrapV1.parse({ ...fixture.bootstrap, future: 1 }), fixture.bootstrap);
  assert.deepEqual(contracts.dailyV1.parse({ ...fixture.daily, future: 1 }), fixture.daily);
  for (const [key, value] of Object.entries(fixture.requests)) assert.deepEqual(contracts.requestsV1[key].parse(value), value);
  const groups = model.workGroups(contracts.dailyV1.parse(fixture.daily).candidates.work);
  assert.deepEqual(groups.map(g => [g.kind, g.children.length]), [["project", 0], ["routine", 1]]);
});
test("new domain enum values cannot reach v1 clients without an explicit compatible adapter", async () => {
  const source = ts.createSourceFile("pace-data.ts", await read("lib/pace-data.ts"), ts.ScriptTarget.Latest, true);
  const enums = {};
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !["ITEM_KINDS", "ITEM_STATUSES", "ROUTINE_CADENCES"].includes(declaration.name.text)) continue;
      const expression = ts.isAsExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer;
      assert.ok(ts.isArrayLiteralExpression(expression));
      enums[declaration.name.text] = expression.elements.map(element => { assert.ok(ts.isStringLiteral(element)); return element.text; });
    }
  }
  assert.deepEqual(enums.ITEM_KINDS, contracts.itemV1.shape.kind.options);
  assert.deepEqual(enums.ITEM_STATUSES, contracts.itemV1.shape.status.options);
  assert.deepEqual(enums.ROUTINE_CADENCES, contracts.routineV1.shape.cadence.options);
});
test("web bootstrap composition maps isCurrent and does not expose other user IDs", async () => {
  const payload = structuredClone(fixture.bootstrap);
  payload.team.members = payload.team.members.map(({ userId, ...m }) => ({ ...m, isCurrent: true }));
  payload.team.members.push({ ...payload.team.members[0], id: "other", isCurrent: false });
  const route = mobileV1("bootstrap", async req => {
    assert.equal(new URL(req.url).pathname, "/api/bootstrap");
    assert.equal(req.headers.get("cookie"), null);
    assert.equal(req.headers.get("authorization"), auth);
    assert.equal(req.headers.get("x-okri-workspace-id"), "workspace-1");
    return Response.json(payload, { headers: { "set-cookie": "never=forward" } });
  });
  const result = await route(request("bootstrap?date=2026-09-08", "GET", undefined, { cookie: "web=session" }));
  assert.equal(result.status, 200); assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const data = await result.json();
  assert.equal(data.team.members[0].userId, data.user.id); assert.equal(data.team.members[1].userId, null);
  assert.deepEqual(model.myTasks(data).map(i => i.id), ["task-1"]);
});
test("cookie/MCP access, unknown methods, malformed dates, oversized/unknown writes never reach domain handlers", async () => {
  let calls = 0;
  const handler = async () => { calls++; return Response.json({}); };
  for (const token of ["", "Bearer okri_mcp"]) assert.equal((await mobileV1("bootstrap", handler)(request("bootstrap", "GET", undefined, { authorization: token }))).status, 401);
  assert.equal((await mobileV1("bootstrap", handler)(request("bootstrap?date=2026-02-30"))).status, 400);
  assert.equal((await mobileV1("bootstrap", handler)(request("bootstrap?includeArchived=true"))).status, 400);
  assert.equal((await mobileV1("items", handler)(request("items", "DELETE"))).status, 405);
  assert.equal((await mobileV1("items", handler)(request("items", "POST", { ...fixture.requests["POST items"], bypass: true }))).status, 400);
  assert.equal((await mobileV1("items", handler)(request("items", "POST", { kind: "task", title: "x".repeat(70000) }))).status, 413);
  assert.equal(calls, 0);
});
test("live domain membership/seat denial is preserved, not converted into success", async () => {
  for (const status of [401, 403, 409, 429, 503]) {
    const route = mobileV1("items", async () => Response.json({ code: "domain_denied" }, { status }));
    assert.equal((await route(request("items", "PATCH", fixture.requests["PATCH items"]))).status, status);
  }
  const pending = await mobileV1("items", async () => Response.json({ code: "project_confirmation_required", created: false }, { status: 202 }))(request("items", "POST", fixture.requests["POST items"]));
  assert.equal(pending.status, 202); assert.equal((await pending.json()).created, false);
});
test("missing critical read fields fail instead of silently showing an empty task list", async () => {
  const payload = structuredClone(fixture.bootstrap); delete payload.items;
  const response = await mobileV1("bootstrap", async () => Response.json(payload))(request("bootstrap"));
  assert.equal(response.status, 503);
});
test("successful committed commands acknowledge even when web response shape evolves; no extra invocation", async () => {
  let calls = 0;
  for (const key of contracts.acknowledgementsV1) {
    const [method, endpoint] = key.split(" ");
    const response = await mobileV1(endpoint, async req => {
      calls++; assert.deepEqual(await req.json(), fixture.requests[key]);
      return Response.json({ futureWebRepresentation: true }, { status: 201 });
    })(request(endpoint, method, fixture.requests[key]));
    assert.deepEqual(await response.json(), { ok: true });
  }
  assert.equal(calls, contracts.acknowledgementsV1.size);
});
test("existing daily command handlers still accept frozen idempotency and parent selections", async () => {
  const calls = [], dependencies = {
    "@/lib/pace-data": { authorizeRequest: async () => ({ ownerId: "workspace-1", userId: "user-1" }), serializeItem: t => t },
    "@/lib/daily-bot": { createExplicitDailyTask: async (a, body) => { calls.push({ a, body }); return { id: "new-task" }; } },
    "../route": { dailyRouteError: e => { throw e; } },
  };
  const domain = compileLanguageModule(await read("app/api/daily-scrum/tasks/route.ts"), dependencies);
  const response = await mobileV1("daily-scrum/tasks", domain.POST)(request("daily-scrum/tasks", "POST", fixture.requests["POST daily-scrum/tasks"]));
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), { task: { id: "new-task" } });
  assert.deepEqual(calls[0].body, fixture.requests["POST daily-scrum/tasks"]); assert.equal(calls.length, 1);
});
test("all exposed mobile business routes use the adapter and old client never falls back to web endpoints", async () => {
  for (const endpoint of ["bootstrap", "items", "routines", "routine-completions", "workspaces", "daily-scrum", "daily-scrum/tasks", "daily-scrum/submit"]) {
    assert.match(await read("app/api/mobile/v1/" + endpoint + "/route.ts"), /mobileV1\(/);
  }
  const api = compileLanguageModule(await read("mobile/src/api.ts"), { "./client-version": { clientHeaders: () => ({}) } });
  for (const path of ["/api/items", "/api/workspaces", "/api/mobile/v2/items", "/api/mobile/v1/../items", "https://evil.test/api/mobile/v1/items"]) await assert.rejects(api.request(path, null, null, "en"), /Invalid API/);
});
