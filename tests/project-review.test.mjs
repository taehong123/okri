import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { preferences } from "./helpers/language-fixture.mjs";

const require = createRequire(import.meta.url);
function compile(source, dependencies = {}) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", js)((name) => name in dependencies ? dependencies[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const core = compile(await readFile(new URL("../lib/project-review.ts", import.meta.url), "utf8"));
const writerSource = await readFile(new URL("../lib/project-review-writer.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../lib/project-review-service.ts", import.meta.url), "utf8");
const mcpReviewSource = await readFile(new URL("../lib/project-review-mcp.ts", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../lib/project-review-editor.ts", import.meta.url), "utf8");
const reviewRouteSource = await readFile(new URL("../app/api/project-reviews/route.ts", import.meta.url), "utf8");
const billingSource = await readFile(new URL("../lib/billing.ts", import.meta.url), "utf8");
const billingAst = ts.createSourceFile("billing.ts", billingSource, ts.ScriptTarget.Latest, true);
const quotaSource = billingAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "prepareReviewedProjectQuota").getText(billingAst);
const permissionSource = billingAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "reviewedProjectPermissionGuard").getText(billingAst);
const editorPolicySource = billingAst.statements.filter((node) => ts.isFunctionDeclaration(node) && ["memberCanWrite", "getEditorEnforcementState"].includes(node.name?.text)).map((node) => node.getText(billingAst)).join("\n");
const paceSource = await readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8");
const paceAst = ts.createSourceFile("pace-data.ts", paceSource, ts.ScriptTarget.Latest, true);
const documentHelpers = compile(paceAst.statements.filter((node) => ts.isFunctionDeclaration(node) && ["prepareProjectTemplateDocument", "normalizeBlockContent", "parseBlockArray", "blocksFromPlainText", "normalizeDocumentText"].includes(node.name?.text)).map((node) => node.getText(paceAst)).join("\n"));
const migrations = await Promise.all((await readdir(new URL("../drizzle/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort().map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")));
const identity = { ownerId: "a", userId: "user", apiToken: false, role: "owner" };

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const migration of migrations) db.exec(migration);
  db.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO workspaces (id,name,owner_user_id) VALUES ('a','Team A','user'),('b','Private B','other');
    INSERT INTO okr_cycles (id,owner_id,name,start_date,end_date,status) VALUES ('cycle','a','Q3','2026-07-01','2026-09-30','active');
    INSERT INTO workspace_members (id,workspace_id,user_id,display_name,email,role,status) VALUES
      ('me','a','user','태홍','me@example.com','owner','active'),('peer','a','peer','민지','peer@example.com','member','active'),('other','b','other','다른 팀','other@example.com','owner','active');
    INSERT INTO items (id,owner_id,kind,title,description,parent_id,cycle_id,status,updated_at) VALUES
      ('o','a','objective','고객 경험','고객의 가입 경험을 개선',NULL,'cycle','todo','2026-09-02'),
      ('kr','a','key_result','활성화 40%','첫 핵심행동 완료율','o','cycle','todo','2026-09-02'),
      ('i','a','initiative','첫 경험 단순화','온보딩 이탈 감소','kr','cycle','todo','2026-09-02'),
      ('i2','a','initiative','결제 경험 개선','결제 실패를 줄임','kr','cycle','todo','2026-09-02'),
      ('orphan','a','initiative','고아','',NULL,'cycle','todo','2026-09-02'),
      ('private','b','initiative','비밀 연결','Private',NULL,NULL,'todo','2026-09-02');
    INSERT INTO property_definitions (id,owner_id,name,type,options,default_value,updated_at) VALUES ('budget','a','예산','number','[]','7','2026-09-02');
    INSERT INTO project_templates (id,owner_id,name,content,plain_text,updated_at) VALUES ('template','a','개발 계획','[]','승인한 본문','2026-09-02');
  `);
  const stats = { batches: 0, beforeBatch: null, loseResponse: false, lastBatchError: null, billingEnabled: true };
  const d1 = {
    prepare(sql) {
      const bind = (...values) => ({ sql, values,
        async first() { return db.prepare(sql).get(...values) ?? null; },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async run() { const result = db.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
      });
      return { ...bind(), bind };
    },
    async batch(statements) {
      stats.batches++;
      stats.beforeBatch?.();
      db.exec("BEGIN");
      let committed = false;
      try {
        const results = statements.map((statement) => ({ meta: { changes: Number(db.prepare(statement.sql).run(...statement.values).changes) } }));
        db.exec("COMMIT");
        committed = true;
        if (stats.loseResponse) throw new Error("lost response after commit");
        return results;
      } catch (error) { stats.lastBatchError = error; if (!committed) db.exec("ROLLBACK"); throw error; }
    },
  };
  const propertyRows = () => db.prepare("SELECT * FROM property_definitions WHERE owner_id = 'a' AND active = 1").all().map((row) => ({
    id: row.id, name: row.name, type: row.type, options: row.options, defaultValue: row.default_value, systemKey: row.system_key, sortOrder: row.sort_order, updatedAt: row.updated_at,
  }));
  const pace = {
    ...documentHelpers,
    getWorkspaceRules: async () => ({ defaultPriority: "medium", defaultCadence: "weekly" }),
    listProjectPropertyDefinitions: async () => propertyRows(),
    getProjectTemplate: async (_owner, id) => { const row = db.prepare("SELECT * FROM project_templates WHERE id = ?").get(id); return row ? { id: row.id, name: row.name, content: row.content, plainText: row.plain_text, updatedAt: row.updated_at } : null; },
    validateItemPropertiesByName: async (_owner, values) => Object.entries(values).map(([name, value]) => {
      const property = propertyRows().find((row) => row.name === name);
      if (!property || property.systemKey) throw new Error("Property not found");
      return { property, value };
    }),
  };
  const quotaContext = { billingEnforcementEnabled: () => stats.billingEnabled, getWorkspaceSubscription: async () => db.prepare("SELECT plan FROM workspace_subscriptions WHERE workspace_id = 'a'").get() ?? { plan: "free" },
    validPlan: (plan) => ["free", "team", "business"].includes(plan), BILLING_PLANS: { free: { projectLimit: 3, editorLimit: 3 }, team: { projectLimit: 100, editorLimit: 10 }, business: { projectLimit: null, editorLimit: null } }, kstPeriod: () => ({ key: "2026-09", resetsAt: "2026-10-01" }) };
  const runtime = { DB: d1 };
  const quota = compile(`const { env } = require('cloudflare:workers'); const { billingEnforcementEnabled, getWorkspaceSubscription, validPlan, BILLING_PLANS, kstPeriod } = require('quota-context');\n${quotaSource}\n${permissionSource}\n${editorPolicySource}`, { "cloudflare:workers": { env: runtime }, "quota-context": quotaContext });
  class BillingLimitError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
  const dependencies = { "cloudflare:workers": { env: { DB: d1 } }, "@/lib/project-review": core, "@/lib/pace-data": pace, "@/lib/billing": { ...quota, BillingLimitError } };
  const writer = compile(writerSource, dependencies);
  const editor = compile(editorSource, dependencies);
  dependencies["@/lib/project-review-editor"] = editor;
  const service = compile(serviceSource, dependencies);
  const mcp = compile(mcpReviewSource, { ...dependencies, "@/lib/project-review-service": service, "@/lib/project-review-writer": writer });
  const approve = async (review, parentId = "i2") => {
    const parent = await core.getReviewInitiative(d1, "a", parentId);
    try {
      return await core.approveProjectReview(d1, identity, { id: review.id, version: review.version, initiativeId: parentId, initiativeFingerprint: parent?.fingerprint ?? "wrong" },
        (draft, selected, completed) => writer.writeReviewedProject(identity, draft, selected, completed));
    } catch (error) { error.cause = stats.lastBatchError; throw error; }
  };
  const propose = async (input = {}) => {
    const staged = await service.stageProjectReview(identity, { title: "결제 개편", dueDate: "2026-09-15", driMemberId: "me", workerMemberIds: ["peer"], templateId: "template", ...input }, [{ initiativeId: "i", reason: "검토할 AI 후보" }], "https://okri.ai");
    return core.getProjectReview(d1, identity, staged.id);
  };
  const route = (auth = identity) => compile(reviewRouteSource, { ...dependencies,
    "@/lib/language-preferences": preferences,
    "@/lib/pace-data": { ...pace, authorizeRequest: async () => auth, ensureWorkspace: async () => {} },
    "@/lib/project-review-writer": writer,
  });
  return { db, d1, stats, writer, service, propose, approve, route, quota, runtime, editor, mcp };
}

const mcpIdentity = { ...identity, apiToken: true, oauthScopes: "okri:read okri:write" };
async function mcpConfirmation(f, review, parentId = "i2", changes = {}) {
  const context = await f.mcp.readMcpProjectReview(mcpIdentity, review.id, { includeContext: true, cycleId: null });
  const parent = context.candidates.choices.find((entry) => entry.id === parentId);
  return { review_id: context.id, version: context.version, confirmed: true, initiative_id: parent.id,
    initiative_fingerprint: parent.fingerprint, editor_revision: context.editor.revision,
    proposal: { ...context.proposal, requestedCycleId: parent.cycleId, ...changes } };
}

test("personal MCP proposes, edits, chooses another file and completes without a browser URL", async () => {
  const f = fixture();
  try {
    seedEditableFields(f);
    const staged = await f.mcp.stageMcpProjectReview(mcpIdentity, { title: "결제 개편" }, [{ initiativeId: "i", reason: "가입 이탈 개선" }], "https://okri.ai");
    assert.equal(staged.state, "awaiting_user_confirmation"); assert.equal(staged.projectId, null);
    assert.equal(staged.url, undefined); assert.match(staged.nextStep, /manage_project/);
    assert.equal(staged.recommendations[0].initiative.id, "i");
    const input = await mcpConfirmation(f, staged, "in", { title: "확정된 재방문 개선", driMemberId: "peer", workerMemberIds: ["me"], dueDate: "2026-09-25",
      properties: { 예산: 0, 메모: "대화에서 수정", 분류: "운영", 출시일: "2026-09-25", 검토됨: false, 검토자: "peer", 협업자: ["me"] } });
    const result = await f.mcp.confirmMcpProjectReview(mcpIdentity, input);
    assert.equal(result.state, "created"); assert.ok(result.projectId);
    assert.equal(result.summary.dri, "민지"); assert.equal(result.summary.cycleId, "next");
    assert.deepEqual(result.initiativePath, ["확장", "유지율", "재방문 개선"]);
    assert.deepEqual(result.summary.properties, input.proposal.properties);
    assert.equal(f.db.prepare("SELECT title FROM items WHERE id = ?").get(result.projectId).title, input.proposal.title);
    const retry = await f.mcp.confirmMcpProjectReview(mcpIdentity, input);
    assert.deepEqual(retry, result); assert.equal(f.stats.batches, 1);
  } finally { f.db.close(); }
});

test("MCP cannot create without explicit confirmation or omit reviewed fields", async () => {
  const f = fixture();
  try {
    const review = await f.propose(); const input = await mcpConfirmation(f, review);
    for (const confirmed of [false, undefined]) await assert.rejects(() => f.mcp.confirmMcpProjectReview(mcpIdentity, { ...input, confirmed }));
    const partial = { ...input.proposal }; delete partial.dueDate;
    await assert.rejects(() => f.mcp.confirmMcpProjectReview(mcpIdentity, { ...input, proposal: partial }), (error) => error.code === "invalid_proposal");
    assert.equal((await f.mcp.readMcpProjectReview(mcpIdentity, review.id)).state, "pending");
    assert.equal(f.stats.batches, 0);
  } finally { f.db.close(); }
});

test("MCP confirmation enforces personal identity, write scopes, role and review ownership", async () => {
  const f = fixture();
  try {
    const review = await f.propose(); const input = await mcpConfirmation(f, review);
    for (const auth of [{ ...mcpIdentity, oauthScopes: "okri:read" }, { ...mcpIdentity, oauthScopes: undefined },
      { ...mcpIdentity, role: "viewer" }, { ...mcpIdentity, userId: "api-token" },
      { ...mcpIdentity, userId: "peer" }, { ...mcpIdentity, ownerId: "b" }]) {
      await assert.rejects(() => f.mcp.confirmMcpProjectReview(auth, input));
      await assert.rejects(() => f.mcp.cancelMcpProjectReview(auth, review.id, review.version));
    }
    assert.equal(f.stats.batches, 0);
  } finally { f.db.close(); }
});

test("legacy MCP write scopes remain writable during the OKRI migration", async () => {
  const f = fixture();
  try {
    const review = await f.propose();
    const input = await mcpConfirmation(f, review);
    const result = await f.mcp.confirmMcpProjectReview({ ...mcpIdentity, oauthScopes: "okrptr:read okrptr:write" }, input);
    assert.equal(result.state, "created");
    assert.ok(result.projectId);
  } finally { f.db.close(); }
});

test("MCP stale catalogs and lineage retain the draft, while cancellation and expiry cannot create", async () => {
  const f = fixture();
  try {
    const review = await f.propose(); const input = await mcpConfirmation(f, review);
    f.db.exec("UPDATE property_definitions SET updated_at = 'changed' WHERE id = 'budget'");
    await assert.rejects(() => f.mcp.confirmMcpProjectReview(mcpIdentity, input), (error) => error.code === "editor_changed");
    const refreshed = await mcpConfirmation(f, review);
    f.db.exec("UPDATE items SET updated_at = 'changed' WHERE id = 'kr'");
    await assert.rejects(() => f.mcp.confirmMcpProjectReview(mcpIdentity, refreshed), (error) => error.code === "initiative_changed");
    const cancelled = await f.mcp.cancelMcpProjectReview(mcpIdentity, review.id, review.version);
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.projectId, null);
    await assert.rejects(() => f.mcp.confirmMcpProjectReview(mcpIdentity, input));
    const next = await f.propose({ title: "만료 테스트" }); const nextInput = await mcpConfirmation(f, next);
    f.db.prepare("UPDATE assistant_drafts SET payload_json = json_set(payload_json, '$.expiresAt', '2000-01-01') WHERE id = ?").run(next.id);
    await assert.rejects(() => f.mcp.confirmMcpProjectReview(mcpIdentity, nextInput), (error) => error.code === "review_expired");
    assert.equal(f.stats.batches, 0);
  } finally { f.db.close(); }
});

test("MCP concurrent confirmations and lost responses save only once", async () => {
  const f = fixture();
  try {
    const input = await mcpConfirmation(f, await f.propose());
    f.stats.loseResponse = true;
    const results = await Promise.allSettled([f.mcp.confirmMcpProjectReview(mcpIdentity, input), f.mcp.confirmMcpProjectReview(mcpIdentity, input)]);
    assert.ok(results.some((entry) => entry.status === "fulfilled" && entry.value.state === "created"));
    const receipt = await f.mcp.readMcpProjectReview(mcpIdentity, input.review_id);
    assert.equal(receipt.state, "created"); assert.equal(f.stats.batches, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 1);
    assert.equal((await f.mcp.confirmMcpProjectReview(mcpIdentity, input)).projectId, receipt.projectId);
  } finally { f.db.close(); }
});

test("MCP rechecks write permission during the atomic save and rolls everything back", async () => {
  const f = fixture();
  try {
    const input = await mcpConfirmation(f, await f.propose());
    f.stats.beforeBatch = () => f.db.exec("UPDATE workspace_members SET status = 'inactive' WHERE id = 'me'");
    await assert.rejects(() => f.mcp.confirmMcpProjectReview(mcpIdentity, input));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_monthly_usage").get().n, 0);
    assert.equal((await f.mcp.readMcpProjectReview(mcpIdentity, input.review_id)).state, "failed");
  } finally { f.db.close(); }
});

test("Proposal is not creation; defaults are visible and same-request retries reuse the pending review", async () => {
  const f = fixture();
  try {
    const review = await f.propose();
    assert.equal(review.state, "pending"); assert.equal(review.selectedParent, null);
    assert.deepEqual(review.proposal.properties, { 예산: 7 });
    assert.equal(review.fieldLabels.dri, "태홍");
    assert.equal((await f.propose()).id, review.id);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_monthly_usage").get().n, 0);
    const choices = await core.listReviewInitiatives(f.d1, "a", "가입 경험");
    assert.deepEqual(choices.choices.map((row) => row.id), ["i", "i2"]);
    assert.equal(await core.getReviewInitiative(f.d1, "a", "private"), null);
    assert.equal(await core.getReviewInitiative(f.d1, "a", "orphan"), null);
  } finally { f.db.close(); }
});

function seedEditableFields(f) {
  f.db.exec(`INSERT INTO property_definitions (id,owner_id,name,type,options,default_value,sort_order,updated_at) VALUES
    ('text','a','메모','text','[]','null',1,'1'),
    ('select','a','분류','select','["제품","운영"]','null',2,'1'),
    ('date','a','출시일','date','[]','null',3,'1'),
    ('checkbox','a','검토됨','checkbox','[]','null',4,'1'),
    ('member','a','검토자','member','[]','null',5,'1'),
    ('members','a','협업자','members','[]','null',6,'1');
    INSERT INTO okr_cycles (id,owner_id,name,start_date,end_date,status,version) VALUES ('next','a','Q4','2026-10-01','2026-12-31','planned',2);
    INSERT INTO items (id,owner_id,kind,title,parent_id,cycle_id,status,updated_at) VALUES
      ('on','a','objective','확장',NULL,'next','todo','1'),
      ('kn','a','key_result','유지율','on','next','todo','1'),
      ('in','a','initiative','재방문 개선','kn','next','todo','1');
    INSERT INTO project_templates (id,owner_id,name,content,plain_text,updated_at) VALUES ('other-template','a','운영 계획','[]','새 템플릿','1');
  `);
}
async function editedRequest(f, review, proposal, revision, parentId = "in") {
  const parent = await core.getReviewInitiative(f.d1, "a", parentId);
  return new Request("https://okri.ai/api/project-reviews", { method: "POST", headers: { Origin: "https://okri.ai", "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve", id: review.id, version: review.version, confirmed: true,
      initiativeId: parent.id, initiativeFingerprint: parent.fingerprint, proposal, editorRevision: revision }) });
}

test("Editable catalog is scoped, ordered and separate from candidate search; unset fields are visible", async () => {
  const f = fixture();
  try {
    seedEditableFields(f);
    const review = await f.propose({ requestedCycleId: "cycle" });
    assert.equal(review.proposal.properties.검토됨, null);
    assert.equal(review.propertyLabels.검토자, "미지정");
    assert.equal(review.fieldOrigins["properties.예산"], "default");
    const get = await f.route().GET(new Request(`https://okri.ai/api/project-reviews?id=${review.id}`));
    const result = await get.json();
    assert.deepEqual(result.editor.properties.map((p) => p.type), ["number", "text", "select", "date", "checkbox", "member", "members"]);
    assert.equal(result.editor.members.some((m) => m.id === "other"), false);
    assert.equal(result.editor.revision.length, 64);
    const search = await f.route().GET(new Request(`https://okri.ai/api/project-reviews?id=${review.id}&mode=candidates&cycleId=next`));
    assert.deepEqual(Object.keys(await search.clone().json()), ["candidates"]);
    assert.deepEqual((await search.json()).candidates.choices.map((c) => c.id), ["in"]);
    assert.equal((await core.getProjectReview(f.d1, identity, review.id)).proposal.requestedCycleId, "cycle");
  } finally { f.db.close(); }
});

test("One edited approval saves another file, all seven types, false/0, assignments, document and final receipt", async () => {
  const f = fixture();
  try {
    seedEditableFields(f);
    const review = await f.propose({ requestedCycleId: "cycle" });
    const editor = await f.editor.getProjectReviewEditor("a");
    const proposal = { ...review.proposal, title: "수정한 Project", description: "수정한 범위", requestedCycleId: "next",
      driMemberId: "peer", workerMemberIds: ["me"], dueDate: "2026-10-15", status: "in_progress", priority: "urgent", progress: 25, cadence: "monthly", templateId: "other-template",
      properties: { 예산: 0, 메모: "확정 문구", 분류: "운영", 출시일: "2026-10-01", 검토됨: false, 검토자: "peer", 협업자: ["me", "peer"] } };
    const response = await f.route().POST(await editedRequest(f, review, proposal, editor.revision));
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(result.review.proposal, proposal);
    assert.equal(result.review.fieldLabels.dri, "민지"); assert.equal(result.review.fieldLabels.template, "운영 계획");
    assert.equal(result.review.propertyLabels.검토자, "민지"); assert.equal(result.review.propertyLabels.협업자, "태홍, 민지");
    assert.equal(result.review.fieldOrigins.title, "edited");
    const item = f.db.prepare("SELECT * FROM items WHERE id = ?").get(review.projectId);
    assert.equal(item.title, proposal.title); assert.equal(item.parent_id, "in"); assert.equal(item.cycle_id, "next");
    assert.equal(item.due_date, proposal.dueDate); assert.equal(item.progress, 25); assert.equal(item.cadence, "monthly");
    const properties = f.db.prepare("SELECT p.name,v.value FROM item_property_values v JOIN property_definitions p ON p.id=v.property_id WHERE v.item_id=?").all(review.projectId);
    assert.deepEqual(Object.fromEntries(properties.map((p) => [p.name, JSON.parse(p.value)])), proposal.properties);
    assert.equal(f.db.prepare("SELECT plain_text FROM project_documents WHERE project_id=?").get(review.projectId).plain_text, "새 템플릿\n\n수정한 범위");
    const summary = core.projectReviewSummary(await core.getProjectReview(f.d1, identity, review.id));
    assert.equal(summary.cycleId, "next"); assert.equal(summary.displayProperties.검토자, "민지");
    // Retry even after the catalog changes returns the original receipt, never a new write.
    f.db.exec("UPDATE project_templates SET updated_at='later'");
    assert.equal((await f.route().POST(await editedRequest(f, review, proposal, editor.revision))).status, 200);
    assert.equal(f.db.prepare("SELECT count(*) n FROM items WHERE kind='project'").get().n, 1);
  } finally { f.db.close(); }
});

test("Invalid edited types/options/members and stale catalog return field errors without claiming or losing the draft", async () => {
  const f = fixture();
  try {
    seedEditableFields(f);
    const review = await f.propose();
    const editor = await f.editor.getProjectReviewEditor("a");
    const proposal = { ...review.proposal, requestedCycleId: "next" };
    for (const [key, value] of [["예산", false], ["메모", 5], ["분류", "없는 옵션"], ["출시일", "2026-02-30"], ["검토됨", 0], ["검토자", "other"], ["협업자", ["other"]]]) {
      const response = await f.route().POST(await editedRequest(f, review, { ...proposal, properties: { ...proposal.properties, [key]: value } }, editor.revision));
      const result = await response.json();
      assert.equal(response.status, 400, key); assert.ok(result.fieldErrors[`properties.${key}`], key);
    }
    for (const [key, value] of [["title", ""], ["progress", 101], ["dueDate", "2026-02-30"], ["driMemberId", "other"], ["workerMemberIds", ["other"]], ["templateId", "missing"]]) {
      const response = await f.route().POST(await editedRequest(f, review, { ...proposal, [key]: value }, editor.revision));
      assert.equal(response.status, 400, key); assert.ok((await response.json()).fieldErrors[key], key);
    }
    f.db.exec(`UPDATE property_definitions SET options='["개발"]',updated_at='changed' WHERE id='select'`);
    const stale = await f.route().POST(await editedRequest(f, review, { ...proposal, properties: { ...proposal.properties, 분류: "운영" } }, editor.revision));
    const result = await stale.json();
    assert.equal(stale.status, 409); assert.equal(result.code, "editor_changed"); assert.ok(result.fieldErrors["properties.분류"]);
    assert.notEqual(result.editor.revision, editor.revision);
    assert.deepEqual((await core.getProjectReview(f.d1, identity, review.id)).proposal, review.proposal);
    assert.equal(f.db.prepare("SELECT count(*) n FROM items WHERE kind='project'").get().n, 0);
  } finally { f.db.close(); }
});

test("Edited snapshots allow explicit nulls and never introduce unseen defaults; missing fields are rejected", async () => {
  const f = fixture();
  try {
    seedEditableFields(f);
    const review = await f.propose(), editor = await f.editor.getProjectReviewEditor("a");
    const proposal = { ...review.proposal, requestedCycleId: "next", driMemberId: null, workerMemberIds: [], dueDate: null, templateId: null,
      properties: Object.fromEntries(editor.properties.map((p) => [p.name, null])) };
    const incomplete = { ...proposal }; delete incomplete.priority;
    assert.equal((await f.route().POST(await editedRequest(f, review, incomplete, editor.revision))).status, 400);
    f.db.exec("UPDATE property_definitions SET default_value='99' WHERE id='budget'");
    const response = await f.route().POST(await editedRequest(f, review, proposal, editor.revision));
    assert.equal(response.status, 200);
    assert.equal(f.db.prepare("SELECT value FROM item_property_values WHERE property_id='budget'").get().value, "null");
    assert.equal(f.db.prepare("SELECT count(*) n FROM item_assignments").get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM project_documents").get().n, 0);
  } finally { f.db.close(); }
});

test("Edited approval retains atomic rollback and one-claim behavior under races", async () => {
  for (const race of ["concurrent", "member", "property", "template", "receipt", "lost-response"]) {
    const f = fixture();
    try {
      seedEditableFields(f);
      const review = await f.propose(), editor = await f.editor.getProjectReviewEditor("a");
      const proposal = { ...review.proposal, title: "최종 확정 내용", requestedCycleId: "next", properties: { ...review.proposal.properties, 예산: 0, 검토됨: false } };
      if (race === "member") f.stats.beforeBatch = () => f.db.exec("UPDATE workspace_members SET status='removed' WHERE id='peer'");
      if (race === "property") f.stats.beforeBatch = () => f.db.exec("UPDATE property_definitions SET updated_at='changed' WHERE id='budget'");
      if (race === "template") f.stats.beforeBatch = () => f.db.exec("UPDATE project_templates SET updated_at='changed' WHERE id='template'");
      if (race === "receipt") f.db.exec(`CREATE TRIGGER failed_receipt BEFORE UPDATE ON assistant_drafts WHEN json_extract(NEW.payload_json,'$.state')='created' BEGIN SELECT RAISE(ABORT,'receipt failure'); END`);
      if (race === "lost-response") f.stats.loseResponse = true;
      const request = await editedRequest(f, review, proposal, editor.revision);
      const responses = race === "concurrent" ? await Promise.all([f.route().POST(request), f.route().POST(await editedRequest(f, review, { ...proposal, title: "두 번째 승인" }, editor.revision))]) : [await f.route().POST(request)];
      const shouldCreate = ["concurrent", "lost-response"].includes(race);
      assert.equal(responses.filter((response) => response.status === 200).length, shouldCreate ? 1 : 0, race);
      assert.equal(f.db.prepare("SELECT count(*) n FROM items WHERE kind='project'").get().n, shouldCreate ? 1 : 0, race);
      if (!shouldCreate) for (const table of ["item_assignments", "item_property_values", "project_documents", "activity_log", "project_monthly_usage"]) assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, race + table);
      else {
        const saved = await core.getProjectReview(f.d1, identity, review.id);
        assert.equal(saved.proposal.title, f.db.prepare("SELECT title FROM items WHERE id=?").get(review.projectId).title);
      }
    } finally { f.db.close(); }
  }
});

test("User can reject a recommendation and select another Initiative; all data and receipt commit once", async () => {
  const f = fixture();
  try {
    const review = await f.propose();
    const result = await f.approve(review, "i2");
    assert.equal(result.state, "created");
    assert.equal(result.selectedParent.id, "i2");
    const item = f.db.prepare("SELECT * FROM items WHERE id = ?").get(review.projectId);
    assert.equal(item.parent_id, "i2"); assert.equal(item.cycle_id, "cycle"); assert.equal(item.due_date, "2026-09-15");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM item_assignments WHERE item_id = ?").get(item.id).n, 2);
    assert.equal(f.db.prepare("SELECT value FROM item_property_values WHERE item_id = ?").get(item.id).value, "7");
    assert.equal(f.db.prepare("SELECT plain_text FROM project_documents WHERE project_id = ?").get(item.id).plain_text, "승인한 본문");
    assert.equal((await core.getProjectReview(f.d1, identity, review.id)).state, "created");
    await f.approve(review, "i2");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 1);
    assert.equal(f.db.prepare("SELECT created_count FROM project_monthly_usage").get().created_count, 1);
  } finally { f.db.close(); }
});

test("Every write-stage failure rolls back Project, assignments, properties, document, activity and quota", async () => {
  for (const table of ["items", "item_assignments", "item_property_values", "project_documents", "activity_log", "assistant_drafts"]) {
    const f = fixture();
    try {
      const review = await f.propose();
      const operation = table === "assistant_drafts" ? "UPDATE" : "INSERT";
      const condition = table === "assistant_drafts" ? "WHEN json_extract(NEW.payload_json, '$.state') = 'created'" : table === "items" ? "WHEN NEW.kind = 'project'" : "";
      f.db.exec(`CREATE TRIGGER forced_failure BEFORE ${operation} ON ${table} ${condition} BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
      await assert.rejects(() => f.approve(review), /전체 생성을 취소/);
      for (const target of ["item_assignments", "item_property_values", "project_documents", "activity_log", "project_monthly_usage"]) {
        assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${target}`).get().n, 0, `${table} -> ${target}`);
      }
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 0, table);
      assert.equal((await core.getProjectReview(f.d1, identity, review.id)).state, "failed");
      await assert.rejects(() => f.approve(review), /이미 처리/);
    } finally { f.db.close(); }
  }
});

test("Stale parent, inactive member race, changed template/property, wrong user and forged approval cannot create", async () => {
  const f = fixture();
  try {
    const review = await f.propose();
    await assert.rejects(() => core.getProjectReview(f.d1, { ownerId: "a", userId: "peer" }, review.id), /찾을 수 없습니다/);
    const parent = await core.getReviewInitiative(f.d1, "a", "i2");
    f.db.prepare("UPDATE items SET updated_at = 'changed' WHERE id = 'kr'").run();
    await assert.rejects(() => core.approveProjectReview(f.d1, identity, { id: review.id, version: review.version, initiativeId: "i2", initiativeFingerprint: parent.fingerprint }, async () => assert.fail()), /변경/);
    f.stats.beforeBatch = () => f.db.exec("UPDATE workspace_members SET status = 'removed' WHERE id = 'peer'");
    await assert.rejects(() => f.approve(review), /전체 생성을 취소/);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 0);
  } finally { f.db.close(); }
  for (const mutation of ["UPDATE project_templates SET updated_at = 'changed'", "UPDATE property_definitions SET updated_at = 'changed'"]) {
    const f = fixture();
    try { const review = await f.propose(); f.db.exec(mutation); await assert.rejects(() => f.approve(review), /변경/); assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 0); }
    finally { f.db.close(); }
  }
  for (const [request, token] of [
    [new Request("https://okri.ai/api/project-reviews", { method: "POST", headers: { Origin: "https://okri.ai", Authorization: "Bearer forged" } }), true],
    [new Request("https://okri.ai/api/project-reviews", { method: "POST", headers: { Origin: "https://evil.example" } }), false],
    [new Request("https://okri.ai/api/project-reviews", { method: "POST" }), false],
  ]) assert.throws(() => core.assertProjectReviewBrowserRequest(request, { apiToken: token }));
});

test("A committed save with a lost response returns its receipt instead of creating again", async () => {
  const f = fixture();
  try { const review = await f.propose(); f.stats.loseResponse = true; assert.equal((await f.approve(review)).state, "created"); assert.equal((await f.approve(review)).state, "created"); assert.equal(f.db.prepare("SELECT created_count FROM project_monthly_usage").get().created_count, 1); }
  finally { f.db.close(); }
});

test("Concurrent approvals claim one request and consume quota only once", async () => {
  const f = fixture();
  try {
    const review = await f.propose();
    const results = await Promise.allSettled([f.approve(review), f.approve(review)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 1);
    assert.equal(f.db.prepare("SELECT created_count FROM project_monthly_usage").get().created_count, 1);
  } finally { f.db.close(); }
});

test("Approval route requires browser identity, same origin, explicit choice and checked confirmation", async () => {
  const f = fixture();
  try {
    const review = await f.propose();
    const parent = await core.getReviewInitiative(f.d1, "a", "i2");
    const payload = { decision: "approve", id: review.id, version: review.version, initiativeId: parent.id, initiativeFingerprint: parent.fingerprint, confirmed: true };
    const request = (body = payload, origin = "https://okri.ai") => new Request("https://okri.ai/api/project-reviews", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await f.route({ ...identity, apiToken: true }).POST(request())).status, 403);
    assert.equal((await f.route().POST(request(payload, "https://evil.example"))).status, 403);
    assert.equal((await f.route().POST(request({ ...payload, confirmed: false }))).status, 400);
    assert.equal((await f.route().POST(request({ ...payload, initiativeId: "" }))).status, 400);
    assert.equal((await f.route({ ...identity, ownerId: "b" }).POST(request())).status, 404);
    assert.equal((await f.route(Response.json({ error: "forbidden" }, { status: 403 })).POST(request())).status, 403);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 0);
    const response = await f.route().POST(request());
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).review.state, "created");
    assert.equal((await f.route().POST(request())).status, 200);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 1);
  } finally { f.db.close(); }
});

test("Closed cycle and an ancestor changing between validation and commit cannot be attached", async () => {
  for (const mutation of ["UPDATE okr_cycles SET status = 'closed' WHERE id = 'cycle'", "UPDATE items SET updated_at = 'changed', title = '다른 목적' WHERE id = 'o'"]) {
    const f = fixture();
    try {
      const review = await f.propose(); f.stats.beforeBatch = () => f.db.exec(mutation);
      await assert.rejects(() => f.approve(review), /전체 생성을 취소/);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 0);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_monthly_usage").get().n, 0);
    } finally { f.db.close(); }
  }
});

test("Approver membership, role, editor selection and plan are rechecked inside the atomic batch", async () => {
  for (const mutation of [
    "UPDATE workspace_members SET status = 'removed' WHERE id = 'me'",
    "UPDATE workspace_members SET role = 'viewer' WHERE id = 'me'",
    "INSERT INTO workspace_editor_selections (workspace_id,member_id,selected) VALUES ('a','peer',1)",
    "INSERT INTO workspace_subscriptions (workspace_id,billing_owner_user_id,plan) VALUES ('a','user','team')",
    "UPDATE workspaces SET scheduled_deletion_at = '2026-09-03' WHERE id = 'a'",
  ]) {
    const f = fixture();
    try {
      // The approver is NOT an assignee: this tests their authority independently.
      const review = await f.propose({ driMemberId: null, workerMemberIds: [] });
      f.stats.beforeBatch = () => f.db.exec(mutation);
      await assert.rejects(() => f.approve(review), /전체 생성을 취소/);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 0);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_monthly_usage").get().n, 0);
    } finally { f.db.close(); }
  }
});

test("Atomic editor guard matches the existing policy for plans, explicit selection, fallback order and grace", async () => {
  for (const plan of ["free", "team", "business", "unknown"]) for (const selected of [false, true]) for (const grace of [false, true]) {
    const f = fixture();
    try {
      f.db.prepare("INSERT INTO workspace_subscriptions (workspace_id,billing_owner_user_id,plan) VALUES ('a','user',?)").run(plan);
      for (let index = 0; index < 4; index++) f.db.prepare("INSERT INTO workspace_members (id,workspace_id,user_id,role,status) VALUES (?,'a',?,'member','active')").run(`test-${index}`, `test-${index}`);
      if (selected) f.db.exec("INSERT INTO workspace_editor_selections (workspace_id,member_id,selected) VALUES ('a','peer',1)");
      if (grace) { f.runtime.BILLING_ENFORCEMENT_STARTED_AT = new Date().toISOString(); f.db.exec("UPDATE workspaces SET created_at = '2020-01-01' WHERE id = 'a'"); }
      for (const member of f.db.prepare("SELECT user_id,role FROM workspace_members WHERE workspace_id='a'").all()) {
        const guard = f.quota.reviewedProjectPermissionGuard("a", member.user_id);
        const actual = Boolean(f.db.prepare(`SELECT ${guard.sql} AS allowed`).get(...guard.bindings).allowed);
        assert.equal(actual, await f.quota.memberCanWrite("a", member.user_id, member.role), `${plan}/${selected}/${grace}/${member.user_id}`);
      }
    } finally { f.db.close(); }
  }
});

test("Template precedes the approved description, with fresh block IDs and synchronized plain text", async () => {
  const f = fixture();
  try {
    const blocks = [{ id: "template-block", type: "paragraph", content: "승인된 본문", children: [{ id: "nested-block", type: "paragraph", content: "세부" }] }];
    f.db.prepare("UPDATE project_templates SET content = ?, plain_text = '승인된 본문' WHERE id = 'template'").run(JSON.stringify(blocks));
    const review = await f.propose({ description: "# 완료 기준\n결제 이탈 감소", requestedCycleId: "cycle" });
    assert.equal(review.fieldLabels.cycle, "Q3"); assert.equal(review.templatePreview, "승인된 본문");
    await f.approve(review);
    const doc = f.db.prepare("SELECT content, plain_text FROM project_documents WHERE project_id = ?").get(review.projectId);
    const saved = JSON.parse(doc.content);
    assert.equal(saved[0].content, "승인된 본문"); assert.equal(saved[1].type, "heading"); assert.equal(saved[2].content, "결제 이탈 감소");
    assert.notEqual(saved[0].id, "template-block"); assert.notEqual(saved[0].children[0].id, "nested-block");
    assert.equal(new Set([saved[0].id, saved[0].children[0].id, saved[1].id, saved[2].id]).size, 4);
    assert.equal(doc.plain_text, "승인된 본문\n\n# 완료 기준\n결제 이탈 감소");
    assert.equal(f.db.prepare("SELECT description FROM items WHERE id = ?").get(review.projectId).description, doc.plain_text);
  } finally { f.db.close(); }
});

test("Cancel and expiry never create; quota failure also rolls back the complete save", async () => {
  const f = fixture();
  try {
    const review = await f.propose();
    await core.cancelProjectReview(f.d1, identity, review.id, review.version);
    await assert.rejects(() => f.approve(review), /이미 처리/);
    const expired = await f.propose({ title: "만료 요청" });
    f.db.prepare("UPDATE assistant_drafts SET payload_json = json_set(payload_json, '$.expiresAt', '2000-01-01') WHERE id = ?").run(expired.id);
    await assert.rejects(() => f.approve(expired), /만료/);
    const limited = await f.propose({ title: "한도 요청" });
    f.db.exec("INSERT INTO project_monthly_usage (workspace_id, period_key, created_count) VALUES ('a','2026-09',3)");
    await assert.rejects(() => f.approve(limited), /한도/);
    assert.equal(f.db.prepare("SELECT created_count FROM project_monthly_usage").get().created_count, 3);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM items WHERE kind = 'project'").get().n, 0);
  } finally { f.db.close(); }
});

test("Generic drafts API cannot forge or overwrite system review state", async () => {
  const f = fixture();
  try {
    const draftApi = compile(await readFile(new URL("../lib/assistant-drafts.ts", import.meta.url), "utf8"), { "cloudflare:workers": { env: { DB: f.d1 } } });
    await assert.rejects(() => draftApi.saveAssistantDraft("a", "user", "system:project-review:fake", { state: "created" }), /시스템/);
    await assert.rejects(() => draftApi.deleteAssistantDraft("a", "user", "SYSTEM:PROJECT-REVIEW:fake"), /시스템/);
  } finally { f.db.close(); }
});

test("REST integration token cannot bypass Project review by claiming source=web", async () => {
  let created = 0;
  const route = compile(await readFile(new URL("../app/api/items/route.ts", import.meta.url), "utf8"), {
    "cloudflare:workers": { env: { DB: {} } },
    "@/lib/pace-data": { authorizeRequest: async () => ({ ...identity, apiToken: true }), ensureWorkspace: async () => {}, createItem: async () => { created++; }, ITEM_STATUSES: ["todo"] },
    "@/lib/billing": { BillingLimitError: class extends Error {} },
    "@/lib/project-review-service": { stageProjectReview: async () => ({ state: "awaiting_user_confirmation" }) },
    "@/lib/work-intake": { readWorkContext: async () => { throw new Error("Project review must not inspect Task placement"); }, reviewTaskGeneralPlacement: () => { throw new Error("Project review must not inspect Task placement"); } },
  });
  const response = await route.POST(new Request("https://okri.ai/api/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "임의 생성 시도", kind: "project", parentId: "i", source: "web" }) }));
  assert.equal(response.status, 202); assert.equal((await response.json()).created, false); assert.equal(created, 0);
});

test("REST integration token cannot silently default a Task to General", async () => {
  let created = 0;
  let createdInput;
  const context = {
    parents: [{ id: "project", kind: "project", title: "Existing Project", path: ["O", "KR", "I", "Existing Project"], sourceMatched: false }],
    routines: [], fallback: { id: "general", title: "General" },
  };
  const route = compile(await readFile(new URL("../app/api/items/route.ts", import.meta.url), "utf8"), {
    "cloudflare:workers": { env: { DB: {} } },
    "@/lib/pace-data": {
      authorizeRequest: async () => ({ ...identity, apiToken: true }), ensureWorkspace: async () => {},
      createItem: async (_owner, input) => { created++; createdInput = input; return { id: "task", kind: "task", title: input.title }; },
      getItemAssignmentMap: async () => ({}), replaceItemAssignmentRole: async () => {}, serializeItem: (item) => item,
      ITEM_KINDS: ["project", "task"], ITEM_STATUSES: ["todo"], ITEM_PRIORITIES: ["medium"], ITEM_CADENCES: ["weekly"],
    },
    "@/lib/billing": { BillingLimitError: class extends Error {} },
    "@/lib/project-review-service": { stageProjectReview: async () => ({}) },
    "@/lib/work-intake": {
      readWorkContext: async () => context,
      reviewTaskGeneralPlacement: (_context, confirmed) => confirmed
        ? { status: "general_ready", reason: "user_selected_general", candidates: [], general: context.fallback }
        : { status: "selection_required", reason: "active_candidates_available", candidates: context.parents, general: context.fallback },
    },
  });
  const request = (generalConfirmed) => new Request("https://okri.ai/api/items", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Create Task", kind: "task", ...(generalConfirmed ? { generalConfirmed: true } : {}) }),
  });
  const blocked = await route.POST(request(false));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "task_placement_confirmation_required");
  assert.equal(created, 0);

  const saved = await route.POST(request(true));
  assert.equal(saved.status, 201);
  assert.equal(created, 1);
  assert.equal(createdInput.routineId, "general");
});

test("Bulk OKR plan cannot bypass Project review or create ancestors before rejecting", async () => {
  let creates = 0;
  const route = compile(await readFile(new URL("../app/api/okr-plan/route.ts", import.meta.url), "utf8"), {
    "@/lib/pace-data": { authorizeRequest: async () => ({ ...identity, apiToken: true }), ensureWorkspace: async () => {}, createOkrPlan: async () => { creates++; } },
    "@/lib/billing": { BillingLimitError: class extends Error {} },
  });
  const response = await route.POST(new Request("https://okri.ai/api/okr-plan", { method: "POST", body: JSON.stringify({ cycleId: "cycle", objective: "임의 목적", keyResult: "임의 KR", initiative: "임의 연결", project: "우회 생성" }) }));
  assert.equal(response.status, 409); assert.equal((await response.json()).created, false); assert.equal(creates, 0);
});
