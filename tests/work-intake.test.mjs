import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function compile(source, dependencies = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => name in dependencies ? dependencies[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const intake = compile(await readFile(new URL("../lib/work-intake.ts", import.meta.url), "utf8"));
const mcpSource = await readFile(new URL("../app/mcp/route.ts", import.meta.url), "utf8");
const reviewCore = compile(await readFile(new URL("../lib/project-review.ts", import.meta.url), "utf8"));
const reviewMcpSource = await readFile(new URL("../lib/project-review-mcp.ts", import.meta.url), "utf8");
const routineProperties = compile(await readFile(new URL("../lib/routine-properties.ts", import.meta.url), "utf8"));

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, kind TEXT);
    CREATE TABLE okr_cycles (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT, status TEXT, start_date TEXT, end_date TEXT, updated_at TEXT);
    CREATE TABLE items (id TEXT PRIMARY KEY, owner_id TEXT, kind TEXT, title TEXT, cycle_id TEXT, parent_id TEXT, archived_at TEXT, status TEXT, updated_at TEXT);
    CREATE INDEX idx_context_owner_kind ON items(owner_id, kind);
    CREATE TABLE routines (id TEXT PRIMARY KEY, owner_id TEXT, title TEXT, system_key TEXT, active INTEGER, updated_at TEXT);
    CREATE TABLE workspace_members (id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, display_name TEXT, email TEXT, role TEXT, status TEXT);
    CREATE TABLE property_definitions (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT, type TEXT, options TEXT, default_value TEXT, system_key TEXT, active INTEGER, sort_order INTEGER);
    INSERT INTO workspaces VALUES ('a','Team A','team'),('b','Private B','team');
    INSERT INTO okr_cycles VALUES ('cycle-a','a','A active','active','2026-07-01','2026-09-30','2026-09-02'),('closed','a','Closed','closed','2025-01-01','2025-03-31','2025-01-01');
    INSERT INTO items VALUES
      ('o','a','objective','고객 경험','cycle-a',NULL,NULL,'todo','2026-09-01'),
      ('kr','a','key_result','활성화 40%','cycle-a','o',NULL,'todo','2026-09-01'),
      ('ini','a','initiative','첫 경험 단순화','cycle-a','kr',NULL,'todo','2026-09-01'),
      ('p','a','project','온보딩 개편','cycle-a','ini',NULL,'in_progress','2026-09-02'),
      ('percent','a','project','100% 완료','cycle-a','ini',NULL,'todo','2026-09-01'),
      ('old','a','project','종료 주기','closed','ini',NULL,'todo','2026-09-02'),
      ('trash','a','project','휴지통','cycle-a','ini','2026-09-01','archived','2026-09-02'),
      ('hidden','b','project','온보딩 비밀',NULL,NULL,NULL,'todo','2026-09-02');
    INSERT INTO routines VALUES ('general-a','a','General','general',1,'2026-01-01'),('r','a','주간 리뷰',NULL,1,'2026-09-02'),('paused','a','중단',NULL,0,'2026-09-02'),('private-r','b','비밀',NULL,1,'2026-09-02');
    INSERT INTO workspace_members VALUES ('me','a','user','태홍','me@example.com','owner','active'),('peer','a','peer-user','민지','peer@example.com','member','active'),('inactive','a','gone','탈퇴','gone@example.com','member','removed'),('other','b','other','타 팀','private@example.com','owner','active');
    INSERT INTO property_definitions VALUES ('budget','a','예산','number','[]','null',NULL,1,0),('off','a','예전','text','[]','null',NULL,0,1),('secret','b','비밀','text','[]','null',NULL,1,0);
    ALTER TABLE items ADD COLUMN description TEXT NOT NULL DEFAULT '';
    UPDATE items SET description = '신규 가입자의 온보딩 이탈을 줄인다' WHERE id = 'ini';
    UPDATE items SET description = '가입 후 첫 핵심행동 완료율' WHERE id = 'kr';
  `);
  const stats = { batches: 0, statements: [] };
  const d1 = {
    prepare(sql) {
      const bind = (...values) => ({
        sql, values,
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) ?? null; },
        async raw() { return db.prepare(sql).all(...values).map((row) => Object.values(row)); },
      });
      return { bind, ...bind() };
    },
    async batch(statements) {
      stats.batches++;
      stats.statements.push(...statements.map((entry) => entry.sql));
      db.exec("BEGIN");
      try {
        const result = statements.map((entry) => ({ results: db.prepare(entry.sql).all(...entry.values) }));
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  return { db, d1, stats };
}

test("Task context is one read batch with tenant isolation, lineage and no documents/properties", async () => {
  const { db, d1, stats } = fixture();
  try {
    const before = db.prepare("SELECT total_changes() AS n").get().n;
    const result = await intake.readWorkContext(d1, "a", "user", { kind: "task" });
    assert.equal(stats.batches, 1);
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
    assert.deepEqual(result.parents.map((row) => row.id), ["p", "percent"]);
    assert.deepEqual(result.parents[0].path, ["고객 경험", "활성화 40%", "첫 경험 단순화", "온보딩 개편"]);
    assert.equal(result.parents[0].cycleId, "cycle-a");
    assert.deepEqual(result.routines.map((row) => row.id), ["r"]);
    assert.equal(result.fallback.id, "general-a");
    assert.deepEqual(result.members.map((row) => row.id), ["me", "peer"]);
    assert.equal(result.members[0].isCurrent, true);
    assert.deepEqual(result.projectProperties, []);
    assert.ok(stats.statements.every((sql) => !/project_documents|item_property_values|SELECT \*/i.test(sql)));
    assert.deepEqual(result.fields.task.required, ["title"]);
  } finally { db.close(); }
});

test("Project context returns only Initiative parents and active property definitions", async () => {
  const { db, d1 } = fixture();
  try {
    db.exec("INSERT INTO property_definitions VALUES ('legacy-dri','a','DRI','text','[]','null',NULL,1,0)");
    const result = await intake.readWorkContext(d1, "a", "user", { kind: "project", includeMembers: false });
    assert.deepEqual(result.parents.map((row) => row.id), ["ini"]);
    assert.equal(result.parents[0].evidence.initiative, "신규 가입자의 온보딩 이탈을 줄인다");
    assert.equal(result.parents[0].evidence.keyResult, "가입 후 첫 핵심행동 완료율");
    const fromEvidence = await intake.readWorkContext(d1, "a", "user", { kind: "project", query: "핵심행동", includeMembers: false });
    assert.deepEqual(fromEvidence.parents.map((row) => row.id), ["ini"]);
    assert.deepEqual(result.projectProperties.map((row) => row.id), ["budget"]);
    assert.equal(result.projectProperties[0].defaultValue, null);
    assert.deepEqual(result.members, []);
    assert.ok(result.fields.project.required.some((field) => field.includes("parent_id")));
  } finally { db.close(); }
});

test("Queries escape LIKE patterns, preserve General fallback and disclose truncation", async () => {
  const { db, d1 } = fixture();
  try {
    const limited = await intake.readWorkContext(d1, "a", "user", { kind: "task", limit: 1 });
    assert.equal(limited.parents.length, 1);
    assert.equal(limited.truncated.project, true);
    assert.equal(limited.truncated.members, true);
    const filtered = await intake.readWorkContext(d1, "a", "user", { kind: "task", query: "%", memberQuery: "peer@example.com" });
    assert.deepEqual(filtered.parents.map((row) => row.id), ["percent"]);
    assert.equal(filtered.fallback.id, "general-a");
    assert.deepEqual(filtered.members.map((row) => row.id), ["peer"]);
    const injection = await intake.readWorkContext(d1, "a", "user", { kind: "task", query: "' OR 1=1 --" });
    assert.deepEqual(injection.parents, []);
  } finally { db.close(); }
});

test("Task context ranks an older Project named in the source ahead of recent candidates", async () => {
  const { db, d1 } = fixture();
  try {
    const result = await intake.readWorkContext(d1, "a", "user", {
      kind: "task", limit: 1, sourceText: "**100%완료를** 거래 규칙 실행 앱으로 다듬기",
    });
    assert.equal(result.parents[0].id, "percent");
    assert.equal(result.parents[0].sourceMatched, true);
    assert.equal(result.truncated.project, true);
    assert.match(result.nextStep, /General보다 우선/);
  } finally { db.close(); }
});

test("Unsure stays undecided; Routine does not need an Initiative or invented task", async () => {
  const { db, d1 } = fixture();
  try {
    const result = await intake.readWorkContext(d1, "a", "user");
    assert.equal(result.kind, "unsure");
    assert.deepEqual(Object.keys(result.fields), ["task", "project", "routine"]);
    assert.equal(result.parents.filter((row) => row.kind === "initiative").length, 1);
    const routine = await intake.readWorkContext(d1, "a", "user", { kind: "routine" });
    assert.deepEqual(routine.parents, []);
    assert.deepEqual(routine.fields.routine.required, ["title"]);
    assert.match(intake.WORKFLOW_INSTRUCTIONS, /Never generate extra Tasks/);
    assert.match(intake.WORKFLOW_INSTRUCTIONS, /one compact question round/);
  } finally { db.close(); }
});

test("referenced conversation placeholders are rejected while concrete repair work remains valid", () => {
  for (const input of [
    { title: "문의 내용 확인" },
    { title: "스레드 업무 내용 확인" },
    { title: "스레드 원문 확인" },
    { title: "업무 정리", description: "원본 스레드를 읽지 못해 내용이 보이면 다시 정리합니다." },
    { title: "Review conversation context", description: "Unable to read the original thread." },
  ]) assert.throws(() => intake.assertConcreteWorkInput(input), /nothing was saved/i);

  assert.doesNotThrow(() => intake.assertConcreteWorkInput({
    title: "Slack 스레드 읽기 오류 수정",
    description: "봇이 원본 스레드를 읽지 못하는 문제를 해결한다.",
  }));
  assert.doesNotThrow(() => intake.assertConcreteWorkInput({ title: "명함 시안 확정" }));
});

function mcpFixture() {
  const fixtureData = fixture();
  const calls = [];
  const reviewReceipt = { id: "10000000-0000-4000-8000-000000000001", state: "pending", projectId: "approved-project",
    version: "10000000-0000-4000-8000-000000000002", recommendations: [], expiresAt: "2099-01-01T00:00:00.000Z",
    proposal: { title: "처음 초안", properties: { 예산: null }, requestedCycleId: null }, fieldLabels: { dri: null, workers: [], template: null, cycle: null }, propertyLabels: { 예산: "미지정" }, selectedParent: null };
  const rules = { workspaceId: "a", captureInstruction: "Capture", structureInstruction: "Structure", routineInstruction: "Repeat", defaultPriority: "medium", defaultCadence: "weekly", reviewBeforeCreate: true, configured: true, createdAt: "", updatedAt: "" };
  const fullItem = (input) => ({
    id: "created", cycleId: null, parentId: null, routineId: null, kind: "task", title: "Task", description: "", status: "todo", priority: "medium", cadence: "weekly", progress: 0, dueDate: null, source: "mcp", archivedAt: null, archivedFromStatus: null, archiveRootId: null, createdAt: "", updatedAt: "", properties: {}, assignments: [], ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  });
  const initiativeChoice = { id: "ini", title: "Initiative", cycleId: "cycle-a", cycleName: "Q3", path: ["O", "KR", "Initiative"],
    description: "", keyResultDescription: "", objectiveDescription: "", fingerprint: "a".repeat(64),
    revision: { initiative: "1", keyResult: "1", objective: "1", cycleStatus: "active" } };
  const data = {
    ITEM_CADENCES: ["daily", "weekly", "monthly", "quarterly"], ITEM_KINDS: ["objective", "key_result", "initiative", "project", "task"],
    ITEM_PRIORITIES: ["low", "medium", "high", "urgent"], ITEM_STATUSES: ["todo", "in_progress", "done", "blocked", "archived"],
    GROUP_COLORS: ["gray"], GROUP_VISIBILITIES: ["open", "private"], PROPERTY_TYPES: ["text", "number"], ROUTINE_CADENCES: ["daily", "weekly", "monthly"],
    getWorkspaceRules: async () => rules,
    getItem: async (_owner, id) => id === "task" ? fullItem({ id, status: "in_progress", cycleId: "cycle-a" })
      : id === "approved-project" ? fullItem({ id, kind: "project", title: reviewReceipt.proposal.title,
        description: reviewReceipt.proposal.description, progress: reviewReceipt.proposal.progress, cycleId: "cycle-a", parentId: "ini" })
        : id === "p" || id === "ini" ? fullItem({ id, kind: id === "p" ? "project" : "initiative", cycleId: "cycle-a" }) : null,
    createItem: async (_owner, input) => { calls.push({ method: "create", input }); return fullItem(input); },
    updateItem: async (_owner, id, input) => { calls.push({ method: "update", input }); return fullItem({ id, status: "in_progress", ...input }); },
    createLinkedTasks: async (_owner, input) => { calls.push({ method: "batch", input }); return input.titles.map((title) => fullItem({ title, cycleId: "cycle-a", parentId: input.projectId, dueDate: input.dueDate })); },
    archiveProject: async (_owner, _user, id) => { calls.push({ method: "archive", id }); return { project: fullItem({ id, kind: "project", title: "Archived", archivedAt: "now" }), affectedCount: 3 }; },
    restoreProject: async (_owner, id) => { calls.push({ method: "restore", id }); return { project: fullItem({ id, kind: "project", title: "Restored" }), affectedCount: 3 }; },
    getItemPropertiesByName: async (_owner, ids) => { calls.push({ method: "properties", ids }); return {}; },
    getItemAssignmentMap: async () => ({}),
    replaceItemAssignmentRole: async () => {},
    validateItemPropertiesByName: async (_owner, properties) => { if (properties.invalid) throw new Error("Property not found"); },
    setItemPropertiesByName: async () => {},
    serializeItem: (item) => item,
  };
  const tools = new Map();
  class FakeServer {
    constructor(_identity, options) { this.instructions = options.instructions; }
    registerTool(name, definition, callback) {
      if (tools.has(name)) throw new Error(`Tool ${name} is already registered`);
      tools.set(name, { definition, callback });
    }
  }
  const serverModule = compile(`${mcpSource}\nexport { createOkriServer };`, {
    "cloudflare:workers": { env: { DB: fixtureData.d1 } },
    "@/lib/pace-data": data,
    "@/lib/routine-properties": routineProperties,
    "@/lib/project-images": {
      arrayBufferToBase64: () => "iVBORw==",
      getProjectImage: async () => ({ image: { id: "image", projectId: "p", name: "error.png", mimeType: "image/png", byteSize: 8, source: "slack", createdAt: "now" }, data: new Uint8Array(8) }),
      getProjectImageCounts: async () => ({ p: 1 }),
      listProjectImages: async () => [{ id: "image", projectId: "p", name: "error.png", mimeType: "image/png", byteSize: 8, source: "slack", createdAt: "now" }],
    },
    "@/lib/work-intake": intake,
    "@/lib/project-review": reviewCore,
    "@/lib/project-review-mcp": compile(reviewMcpSource, {
      "cloudflare:workers": { env: { DB: fixtureData.d1 } },
      "@/lib/project-review": { ...reviewCore, getProjectReview: async () => reviewReceipt,
        listReviewInitiatives: async () => ({ choices: [initiativeChoice], truncated: false }), getReviewInitiative: async (_db, _owner, id) => id === "ini" ? initiativeChoice : null,
        approveProjectReview: async (_db, _identity, _input, create, prepare) => {
          const prepared = await prepare(reviewReceipt, initiativeChoice);
          const created = { ...prepared, state: "created", projectId: "approved-project", selectedParent: initiativeChoice };
          await create(reviewReceipt, initiativeChoice, created);
          Object.assign(reviewReceipt, created);
          return reviewReceipt;
        } },
      "@/lib/project-review-editor": {
        getProjectReviewEditor: async () => ({ revision: "b".repeat(64), properties: [], members: [], templates: [], cycles: [] }),
        prepareEditedProjectReview: async (_owner, review, parent, proposal) => ({ ...review, proposal, selectedParent: parent }),
      },
      "@/lib/project-review-writer": { writeReviewedProject: async () => { calls.push({ method: "approved" }); } },
      "@/lib/project-review-service": { stageProjectReview: async (_auth, input, recommendations) => {
      if (input.properties?.invalid) throw new Error("Property not found");
      calls.push({ method: "review", input, recommendations });
      return { id: "review", state: "awaiting_user_confirmation", url: "https://okri.ai/project-review?id=review", expiresAt: "", summary: {}, selectedInitiative: null, recommendations, nextStep: "User must select and approve" };
      } },
    }),
    "@modelcontextprotocol/sdk/server/mcp.js": { McpServer: FakeServer },
  });
  async function call(name, args) {
    const { definition, callback } = tools.get(name);
    const { z } = require("zod");
    const parsed = z.object(definition.inputSchema).parse(args);
    const output = await callback(parsed);
    if (output.isError) return output;
    z.object(definition.outputSchema).parse(output.structuredContent);
    return output.structuredContent;
  }
  return { ...fixtureData, calls, tools, call, reviewReceipt, async init() { await serverModule.createOkriServer({ ownerId: "a", userId: "user", role: "owner" }); } };
}

test("MCP review outcome contains the final edited connection and property summary, never a false pending success", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    const pending = await f.call("get_project_review", { review_id: f.reviewReceipt.id });
    assert.equal(pending.review.projectId, null); assert.equal(pending.review.summary.displayProperties.예산, "미지정");
    f.reviewReceipt.state = "created";
    f.reviewReceipt.proposal = { ...f.reviewReceipt.proposal, title: "사용자가 수정한 제목", properties: { 예산: 0, 검토됨: false }, requestedCycleId: "next" };
    f.reviewReceipt.selectedParent = { path: ["O", "KR", "다른 Initiative"], cycleId: "next" };
    f.reviewReceipt.propertyLabels = { 예산: "0", 검토됨: "체크 안 됨" };
    f.reviewReceipt.fieldLabels.dri = "민지";
    const final = await f.call("get_project_review", { review_id: f.reviewReceipt.id });
    assert.equal(final.review.projectId, "approved-project"); assert.equal(final.review.title, "사용자가 수정한 제목");
    assert.deepEqual(final.review.initiativePath, ["O", "KR", "다른 Initiative"]);
    assert.equal(final.review.summary.cycleId, "next"); assert.equal(final.review.summary.dri, "민지");
    assert.deepEqual(final.review.summary.properties, { 예산: 0, 검토됨: false });
    assert.equal(f.calls.length, 0);
  } finally { f.db.close(); }
});

test("MCP approval requires an explicit confirmation snapshot and never redirects to the browser", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    const { z } = require("zod");
    const confirmation = f.tools.get("confirm_project").definition;
    const schema = z.object(confirmation.inputSchema);
    const input = { review_id: f.reviewReceipt.id, version: f.reviewReceipt.version, confirmed: true,
      initiative_id: "ini", initiative_fingerprint: "a".repeat(64), editor_revision: "b".repeat(64), proposal: {} };
    assert.equal(schema.safeParse(input).success, true);
    for (const key of Object.keys(input)) {
      const incomplete = { ...input };
      delete incomplete[key];
      assert.equal(schema.safeParse(incomplete).success, false, key);
    }
    assert.equal(schema.safeParse({ ...input, confirmed: false }).success, false);
    assert.equal(confirmation.annotations.readOnlyHint, false);
    assert.equal(f.tools.get("cancel_project_review").definition.annotations.readOnlyHint, false);
    const staged = await f.call("propose_project", { title: "Conversational approval" });
    assert.equal("url" in staged.review, false);
    assert.equal(staged.review.projectId, null);
    assert.ok(staged.review.proposal);
    assert.ok(staged.review.editor);
    assert.match(staged.review.nextStep, /manage_project|same_tool_confirmation/);
    assert.equal(f.calls.filter((call) => call.method === "create").length, 0);
  } finally { f.db.close(); }
});

test("manage_project keeps proposal, approval, edits, trash and restore in one tool", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    assert.equal([...f.tools.keys()][0], "manage_project");
    const proposed = await f.call("manage_project", { title: "명함 만들기" });
    assert.equal(proposed.action, "propose");
    assert.equal(proposed.review.projectId, null);
    const confirmed = await f.call("manage_project", { action: "confirm", confirmation: {
      review_id: f.reviewReceipt.id, version: f.reviewReceipt.version, confirmed: true,
      initiative_id: "ini", initiative_fingerprint: "a".repeat(64), editor_revision: "b".repeat(64), proposal: f.reviewReceipt.proposal,
    } });
    assert.equal(confirmed.action, "confirm");
    assert.equal(confirmed.review.projectId, "approved-project");
    const updated = await f.call("manage_project", { action: "update", project_id: "p", changes: { title: "새 명함 만들기", progress: 20 } });
    assert.equal(updated.item.title, "새 명함 만들기");
    await assert.rejects(() => f.call("manage_project", { action: "archive", project_id: "p" }), /confirmation/);
    const archived = await f.call("manage_project", { action: "archive", project_id: "p", confirmed: true });
    assert.equal(archived.affectedTaskCount, 2);
    const restored = await f.call("manage_project", { action: "restore", project_id: "p" });
    assert.equal(restored.affectedTaskCount, 2);
  } finally { f.db.close(); }
});

test("MCP does not tell users to approve closed or uncertain reviews", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    const { callback } = f.tools.get("get_project_review");
    for (const state of ["cancelled", "failed", "expired", "creating"]) {
      f.reviewReceipt.state = state;
      const result = await callback({ review_id: f.reviewReceipt.id, include_context: true });
      assert.equal(result.structuredContent.review.projectId, null);
      assert.equal("editor" in result.structuredContent.review, false);
      assert.doesNotMatch(result.content[0].text, /confirm_project/);
    }
  } finally { f.db.close(); }
});

test("MCP contracts expose source-aware preparation, optional Routine/cycle, and all read-only hints match policy", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    const result = await f.call("prepare_work", { kind: "task", source_text: "100%완료를 다듬기", limit: 1 });
    assert.equal(result.context.parents[0].id, "percent");
    assert.equal(result.context.parents[0].sourceMatched, true);
    assert.equal(f.calls.length, 0);
    const images = await f.call("list_project_images", { project_id: "p" });
    assert.equal(images.count, 1);
    const image = await f.tools.get("read_project_image").callback({ image_id: "image" });
    assert.deepEqual(image.content[1], { type: "image", data: "iVBORw==", mimeType: "image/png" });
    assert.match(f.tools.get("capture_item").definition.description, /cannot fetch a host conversation transcript/);
    for (const [name, { definition }] of f.tools) {
      assert.equal(intake.READ_ONLY_MCP_TOOLS.has(name), definition.annotations.readOnlyHint === true, name);
    }
  } finally { f.db.close(); }
});

test("MCP rejects missing-thread placeholders before any write", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    assert.match(f.tools.get("capture_item").definition.description, /placeholder Task/);
    for (const [name, input] of [
      ["capture_item", { title: "스레드 업무 내용 확인", description: "원본 스레드를 읽지 못해 우선 저장합니다." }],
      ["create_item", { kind: "task", title: "대화 내용 확인" }],
      ["create_tasks", { titles: ["명함 시안 확정", "원본 메시지 업무 파악"], parent_id: "p" }],
      ["manage_project", { title: "업무 정리", description: "Unable to read the original conversation context." }],
    ]) await assert.rejects(() => f.call(name, input), /nothing was saved/i);
    assert.equal(f.calls.length, 0);
  } finally { f.db.close(); }
});

test("MCP inherits parent's cycle and carries supplied fields; a Task does not load Project properties", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    const result = await f.call("create_item", { kind: "task", title: "카피 확정", parent_id: "p", due_date: "2026-09-04", assignee_member_id: "me", priority: "high" });
    assert.equal(result.item.cycleId, "cycle-a");
    assert.equal(result.item.dueDate, "2026-09-04");
    assert.equal(f.calls[0].input.createdByUserId, "user");
    assert.deepEqual(f.calls.find((call) => call.method === "properties").ids, []);
    const routine = await f.call("create_item", { kind: "task", title: "주간 보고", routine_id: "r" });
    assert.equal(routine.item.routineId, "r");
    assert.equal(routine.item.cycleId, null);
  } finally { f.db.close(); }
});

test("Invalid placement, field types, assignments and dates fail before any write", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    for (const args of [
      { kind: "project", title: "개편", routine_id: "r" },
      { kind: "task", title: "검토", parent_id: "p", routine_id: "r" },
      { kind: "task", title: "검토", properties: { budget: 1 } },
      { kind: "task", title: "검토", assignee_member_id: "other" },
      { kind: "task", title: "검토", due_date: "2026-02-30" },
      { kind: "task", title: "검토", parent_id: "p", cycle_id: "wrong" },
      { kind: "project", title: "개편", parent_id: "ini", properties: { invalid: 1 } },
    ]) await assert.rejects(() => f.call("create_item", args));
    assert.equal(f.calls.length, 0);
  } finally { f.db.close(); }
});

test("Legacy create_item stages once and can complete the approved Project without another exposed tool", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    for (const parent_id of [undefined, "ini", "unrelated-id"]) {
      const result = await f.call("create_item", { kind: "project", title: "결제 개편", parent_id });
      assert.equal(result.review.projectId, null);
      assert.match(result.review.same_tool_confirmation.template_id, /^okri-confirm:/);
    }
    const pending = await f.call("create_item", { kind: "project", title: "결제 개편", parent_id: "ini" });
    const created = await f.call("create_item", { kind: "project", title: "최종 결제 개편", description: "승인 전에 수정", progress: 25,
      parent_id: "ini", template_id: pending.review.same_tool_confirmation.template_id });
    assert.equal(created.item.kind, "project");
    assert.equal(created.item.title, "최종 결제 개편");
    assert.equal(created.item.description, "승인 전에 수정");
    assert.equal(created.item.progress, 25);
    assert.equal(created.item.parentId, "ini");
    assert.equal(f.calls.filter((call) => call.method === "approved").length, 1);
    const legacyPending = await f.call("create_item", { kind: "project", title: "Legacy confirmation", parent_id: "ini" });
    const legacyTemplateId = legacyPending.review.same_tool_confirmation.template_id.replace(/^okri-confirm:/, "okrptr-confirm:");
    const legacyCreated = await f.call("create_item", { kind: "project", title: "Legacy confirmed", parent_id: "ini", template_id: legacyTemplateId });
    assert.equal(legacyCreated.item.title, "Legacy confirmed");
    const staged = await f.call("propose_project", { title: "결제 개편", recommended_initiatives: [] });
    assert.equal(staged.review.selectedInitiative, null);
    assert.equal(staged.review.state, "awaiting_user_confirmation");
    assert.equal(f.calls.filter((call) => call.method === "create").length, 0);
    assert.equal(f.calls.filter((call) => call.method === "review").length, 6);
  } finally { f.db.close(); }
});

test("Relinking preserves status and batch creation carries shared fields in one call", async () => {
  const f = mcpFixture();
  try {
    await f.init();
    const linked = await f.call("link_item", { id: "task", routine_id: "r" });
    assert.equal(linked.item.status, "in_progress");
    assert.equal(linked.item.routineId, "r");
    assert.equal(f.calls[0].input.status, undefined);
    const batch = await f.call("create_tasks", { titles: ["A", "B"], parent_id: "p", assignee_member_id: "me", due_date: "2026-09-04", priority: "high" });
    assert.equal(batch.count, 2);
    const writes = f.calls.filter((entry) => entry.method === "batch");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].input.source, "mcp");
    assert.equal(writes[0].input.assigneeMemberId, "me");
    assert.equal(writes[0].input.dueDate, "2026-09-04");
  } finally { f.db.close(); }
});

test("MCP read-only dispatch fails closed for writes, unknown tools and mixed batches", () => {
  assert.equal(intake.isReadOnlyMcpRequest({ method: "tools/call", params: { name: "prepare_work" } }), true);
  assert.equal(intake.isReadOnlyMcpRequest({ method: "initialize" }), true);
  for (const name of ["manage_project", "create_item", "create_tasks", "confirm_project", "cancel_project_review", "update_workspace_rules", "delete_routine", "future_tool"]) {
    assert.equal(intake.isReadOnlyMcpRequest({ method: "tools/call", params: { name } }), false);
  }
  assert.equal(intake.isReadOnlyMcpRequest([{ method: "tools/call", params: { name: "prepare_work" } }]), false);
  assert.equal(intake.isReadOnlyMcpRequest(null), false);
});

test("Actual Task batch SQL preserves shared fields and rolls back the whole batch on failure", async () => {
  const f = fixture();
  try {
    const schema = compile(await readFile(new URL("../db/schema.ts", import.meta.url), "utf8"));
    const { getTableConfig } = require("drizzle-orm/sqlite-core");
    const { drizzle } = require("drizzle-orm/d1");
    const orm = require("drizzle-orm");
    f.db.exec("DROP TABLE items");
    for (const table of [schema.items, schema.itemAssignments, schema.activityLog]) {
      const config = getTableConfig(table);
      f.db.exec(`CREATE TABLE ${config.name} (${config.columns.map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`).join(",")})`);
    }
    const source = await readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("pace-data.ts", source, ts.ScriptTarget.Latest, true);
    const declaration = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "createLinkedTasks");
    const deps = {
      env: { DB: f.d1 }, items: schema.items, workspaceMembers: schema.workspaceMembers,
      getDb: () => drizzle(f.d1), ...orm,
      ensureWorkspace: async () => {}, ensureGeneralRoutine: async () => ({ id: "general-a" }),
      getWorkspaceRules: async () => ({ defaultPriority: "medium", defaultCadence: "weekly" }),
      getItem: async (_owner, id) => id === "p" ? { id, kind: "project", cycleId: "cycle-a", archivedAt: null } : null,
      getRoutine: async (_owner, id) => ({ id, active: id === "r" || id === "general-a" }),
      validateParent: async () => {}, dispatchSlackAutomationEvent: async () => {},
    };
    const { createLinkedTasks } = compile(`const { ${Object.keys(deps).join(",")} } = require("test-deps");\n${declaration.getText(ast)}`, { "test-deps": deps });
    const rows = await createLinkedTasks("a", { titles: ["명세", "구현"], projectId: "p", assigneeMemberId: "me", dueDate: "2026-09-04", priority: "high", cadence: "daily", source: "mcp", createdByUserId: "user" });
    assert.equal(rows.length, 2);
    assert.equal(f.stats.batches, 1);
    for (const row of f.db.prepare("SELECT * FROM items").all()) {
      assert.equal(row.parent_id, "p");
      assert.equal(row.cycle_id, "cycle-a");
      assert.equal(row.due_date, "2026-09-04");
      assert.equal(row.priority, "high");
      assert.equal(row.cadence, "daily");
      assert.equal(row.source, "mcp");
    }
    assert.equal(f.db.prepare("SELECT count(*) n FROM item_assignments WHERE member_id='me'").get().n, 2);
    f.db.exec("CREATE TRIGGER reject_failure BEFORE INSERT ON items WHEN NEW.title='실패' BEGIN SELECT RAISE(ABORT,'forced test failure'); END");
    await assert.rejects(() => createLinkedTasks("a", { titles: ["저장되면 안 됨", "실패"], routineId: "r", createdByUserId: "user" }));
    assert.equal(f.db.prepare("SELECT count(*) n FROM items").get().n, 2);
    assert.equal(f.db.prepare("SELECT count(*) n FROM activity_log").get().n, 2);
  } finally { f.db.close(); }
});
