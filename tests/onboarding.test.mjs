import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

async function load(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  new Function("require", "exports", outputText)((name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const model = await load("../lib/onboarding.ts");
const account = await load("../lib/account-onboarding.ts", { "./onboarding": model });

function database() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, onboarding_state TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, owner_user_id TEXT, kind TEXT, message_language TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE workspace_members (id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,email TEXT,display_name TEXT,role TEXT,status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE files (id TEXT PRIMARY KEY, owner_id TEXT, title TEXT);`);
  const db = {
    prepare(query) {
      let values = [];
      return { query, bind(...next) { values = next; return this; },
        async first() { return sql.prepare(query).get(...values) ?? null; },
        async all() { return { results: sql.prepare(query).all(...values) }; },
        async run() { const result = sql.prepare(query).run(...values); return { meta: { changes: result.changes } }; } };
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec("COMMIT"); return results; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  return { sql, db };
}

function goalState() {
  const state = model.initialOnboarding();
  state.workspaceId = "personal"; state.workspaceName = "Personal"; state.step = "review";
  state.draft = { ...state.draft, objective: "Speak English confidently", startDate: "2026-09-01", endDate: "2026-09-30",
    keyResults: [{ title: "Have eight conversations", initiative: "Practice twice a week" }] };
  return state;
}

test("migration keeps every existing user outside automatic onboarding", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec("CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT); INSERT INTO users VALUES ('existing', 'Keep name')");
    const migration = await readFile(new URL("../drizzle/0058_account_onboarding.sql", import.meta.url), "utf8");
    assert.ok(!migration.includes("\r"));
    assert.match(migration, /^ALTER TABLE .users. ADD .onboarding_state. text;/);
    sql.exec(migration);
    assert.deepEqual({ ...sql.prepare("SELECT * FROM users").get() }, { id: "existing", display_name: "Keep name", onboarding_state: null });
    const auth = await readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8");
    assert.match(auth, /if \(!emailUser\) \{[\s\S]*?onboardingState: JSON.stringify\(initialOnboarding\(\)\)/);
  } finally { sql.close(); }
});

test("answers produce one Objective, measurable results and optional Initiatives only", () => {
  const draft = goalState().draft;
  assert.deepEqual(model.setupGoalErrors(draft), []);
  const file = model.setupFileInput(draft);
  assert.equal(file.objective.keyResults[0].title, draft.keyResults[0].title);
  assert.equal(file.objective.keyResults[0].initiatives[0].title, draft.keyResults[0].initiative);
  assert.equal(file.metadata.name, draft.objective);
  assert.equal(model.setupFileInput({ ...draft, keyResults: [{ title: "One result", initiative: "" }] }).objective.keyResults[0].initiatives.length, 0);
  for (const date of ["2026-02-30", "2026-00-01", "bad"]) assert.ok(model.setupGoalErrors({ ...draft, startDate: date }).includes("dates"));
  assert.throws(() => model.setupFileInput({ ...draft, objective: "  " }));
  assert.throws(() => model.validateSetupDraft({ ...draft, keyResults: Array(6).fill({ title: "", initiative: "" }) }));
});

test("deep links, invitations and OAuth returns are not intercepted", () => {
  assert.equal(model.canAutoOpenSetup("", ""), true);
  assert.equal(model.canAutoOpenSetup("?release=224", ""), true);
  for (const path of ["?view=okr", "?settings=workspace", "?project=id", "?task=id", "?auth=failed", "?slack=connected"]) {
    assert.equal(model.canAutoOpenSetup(path, ""), false);
  }
  assert.equal(model.canAutoOpenSetup("", "#invite=token"), false);
});

test("pause and resume preserve all answers without completing setup", () => {
  const before = goalState();
  const paused = account.nextSetupState(before, { action: "pause", revision: 0 });
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.draft, before.draft);
  assert.equal(account.nextSetupState(paused, { action: "start", revision: 1 }).status, "active");
  assert.throws(() => account.nextSetupState(paused, { action: "draft", revision: 0, draft: before.draft, step: "goal" }), /setup_conflict/);
  assert.throws(() => account.nextSetupState(before, { action: "draft", revision: 0, draft: { ...before.draft, kind: "team" }, step: "goal" }), /setup_workspace_fixed/);
});

test("revision guard aborts the whole batch and never overwrites another device", async () => {
  const { sql, db } = database();
  try {
    const state = goalState(), raw = JSON.stringify(state), next = { ...state, revision: 1 };
    sql.prepare("INSERT INTO users VALUES ('u', ?)").run(raw);
    await db.batch([account.setupGuard(db, "u", raw, next), db.prepare("INSERT INTO files VALUES ('first','personal','keep')")]);
    await assert.rejects(db.batch([account.setupGuard(db, "u", raw, { ...next, revision: 2 }), db.prepare("INSERT INTO files VALUES ('duplicate','personal','bad')")]), /malformed JSON/);
    assert.equal(sql.prepare("SELECT count(*) n FROM files").get().n, 1);
    assert.equal((await account.readOnboarding(db, "u")).state.revision, 1);
    await assert.rejects(db.batch([account.setupGuard(db, "u", JSON.stringify(next), { ...next, revision: 2 }), db.prepare("INSERT INTO files VALUES ('first','personal','collision')")]));
    assert.equal((await account.readOnboarding(db, "u")).state.revision, 1);
  } finally { sql.close(); }
});

test("setup API enforces identity, explicit confirmation, destination rights and idempotent save", async () => {
  const { sql, db } = database();
  try {
    let identity = { userId: "u", ownerId: "personal", email: "me@example.com", displayName: "Me", apiToken: false };
    let readonly = false, failCreation = false;
    const state = goalState();
    sql.prepare("INSERT INTO users VALUES ('u', ?)").run(JSON.stringify(state));
    const route = await load("../app/api/account/onboarding/route.ts", {
      "cloudflare:workers": { env: { DB: db } },
      "@/lib/pace-data": {
        authorizeRequest: async (request, options) => readonly && !options?.allowViewerWrite ? new Response(null, { status: 403 }) : { ...identity, ownerId: request.headers.get("x-okri-workspace-id") ?? identity.ownerId },
        ensureWorkspace: async () => {},
        listUserWorkspaces: async () => [{ id: "personal", name: "Personal", kind: "personal", personal: true, role: "owner" }],
      },
      "@/lib/language-preferences": { readLanguagePreferences: async () => ({ resolvedLanguage: "en" }) },
      "@/lib/account-onboarding": account,
      "@/lib/onboarding": model,
      "@/lib/okr-files": { prepareOkrFileCreation: async (ownerId, _userId, input) => ({ cycleId: "file", statements: [
        db.prepare("INSERT INTO files VALUES ('file', ?, ?)").bind(ownerId, input.objective.title),
        ...(failCreation ? [db.prepare("INSERT INTO nonexistent VALUES (1)")] : []),
      ] }) },
    });
    const post = (payload, origin = "https://okri.ai") => route.POST(new Request("https://okri.ai/api/account/onboarding", {
      method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }));
    assert.equal((await post({ action: "save", revision: 0 }, "https://attacker.example")).status, 403);
    identity.apiToken = true;
    assert.equal((await post({ action: "save", revision: 0 })).status, 403);
    identity.apiToken = false;
    assert.equal((await post({ action: "save", revision: 0 })).status, 400);
    readonly = true;
    assert.equal((await post({ action: "save", revision: 0, confirmed: true })).status, 403);
    readonly = false; failCreation = true;
    assert.equal((await post({ action: "save", revision: 0, confirmed: true })).status, 500);
    assert.equal(sql.prepare("SELECT count(*) n FROM files").get().n, 0);
    assert.equal((await account.readOnboarding(db, "u")).state.cycleId, null);
    failCreation = false;
    assert.equal((await post({ action: "save", revision: 0, confirmed: true })).status, 200);
    const retry = await post({ action: "save", revision: 0, confirmed: true });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).onboarding.cycleId, "file");
    assert.equal(sql.prepare("SELECT count(*) n FROM files").get().n, 1);
    assert.equal((await account.readOnboarding(db, "u")).state.step, "tour");
    // Only the signed-in account is ever read or changed.
    assert.equal((await post({ action: "complete", revision: 1, userId: "other" })).status, 200);
    assert.equal((await account.readOnboarding(db, "other")).state, null);
    const team = model.initialOnboarding();
    team.step = "workspace"; team.draft.kind = "team"; team.draft.workspaceName = "Customer team";
    sql.prepare("UPDATE users SET onboarding_state = ? WHERE id = 'u'").run(JSON.stringify(team));
    assert.equal((await post({ action: "workspace", revision: 0 })).status, 400);
    assert.equal((await post({ action: "workspace", revision: 0, confirmed: true })).status, 200);
    const createdTeam = (await account.readOnboarding(db, "u")).state;
    assert.equal(createdTeam.workspaceName, "Customer team");
    assert.equal(createdTeam.step, "goal");
    assert.equal((await post({ action: "workspace", revision: 0, confirmed: true })).status, 200);
    assert.equal(sql.prepare("SELECT count(*) n FROM workspaces").get().n, 1);
    assert.equal(sql.prepare("SELECT count(*) n FROM workspace_members").get().n, 1);
  } finally { sql.close(); }
});
