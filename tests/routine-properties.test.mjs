import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/routine-properties.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0042_routine_properties.sql", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const lib = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE routines(id TEXT PRIMARY KEY, owner_id TEXT, system_key TEXT);
    CREATE TABLE workspace_members(id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT);
    CREATE TABLE workspace_backup_state(owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE app_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO routines VALUES('r','w',NULL),('other-r','other',NULL),('general','w','general');
    INSERT INTO workspace_members VALUES('m','w','active'),('gone','w','removed'),('foreign','other','active');`);
  db.exec(migration);
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => db.prepare(sql).run(...args),
  });
  const d1 = {
    prepare: statement,
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const entry of statements) results.push(await entry.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const create = async (name, type, extra = {}) => (await lib.saveRoutineProperty(d1, "w", { name, type, ...extra }, true)).property;
  return { db, d1, create };
}

test("additive LF migration preserves old routines and backup revision guards", async (t) => {
  const { db, create } = fixture(t);
  assert.ok(!migration.includes("\r"));
  assert.equal(db.prepare("SELECT properties_json FROM routines WHERE id='r'").get().properties_json, "{}");
  await create("점검 수", "number");
  assert.equal(db.prepare("SELECT revision FROM workspace_backup_state WHERE owner_id='w'").get().revision, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM routines").get().n, 3);
});

test("all seven field types and defaults survive saved JSON; zero and false remain values", async (t) => {
  const { db, d1, create } = fixture(t);
  const cases = [["메모", "text", "긴 한글 메모"], ["횟수", "number", 0], ["분류", "select", "업무"], ["점검일", "date", "2026-09-03"], ["완료 확인", "checkbox", false], ["검토자", "member", "m"], ["참여자", "members", ["m"]]];
  const supplied = {};
  for (const [name, type, value] of cases) {
    const field = await create(name, type, { options: type === "select" ? ["업무", "개인"] : [], defaultValue: value });
    supplied[field.id] = value;
  }
  const prepared = await lib.prepareRoutineProperties(d1, "w", {}, true);
  assert.deepEqual(prepared, supplied);
  db.prepare("UPDATE routines SET properties_json=json_patch(properties_json,?) WHERE id='r'").run(JSON.stringify(prepared));
  assert.deepEqual(lib.parseRoutineProperties(db.prepare("SELECT properties_json FROM routines WHERE id='r'").get().properties_json), supplied);
  const definitions = await lib.listRoutineProperties(d1, "w");
  assert.equal(definitions.length, 7);
  assert.ok(definitions.every((field) => field.valueCount === 1));
  assert.equal((await lib.listRoutineProperties(d1, "other")).length, 0);
});

test("invalid, foreign, removed fields and inactive members fail before writes", async (t) => {
  const { db, d1, create } = fixture(t);
  const count = await create("횟수", "number"), member = await create("확인자", "member");
  const choice = await create("분류", "select", { options: ["업무"] });
  for (const input of [null, [], { unknown: 1 }, { [count.id]: "NaN" }, { [count.id]: false }, { [choice.id]: "다른 선택" }, { [member.id]: "foreign" }, { [member.id]: "gone" }]) {
    await assert.rejects(lib.prepareRoutineProperties(d1, "w", input), lib.RoutinePropertyError);
  }
  await assert.rejects(lib.prepareRoutineProperties(d1, "other", { [count.id]: 4 }), lib.RoutinePropertyError);
  await lib.saveRoutineProperty(d1, "w", { id: count.id, active: false });
  await assert.rejects(lib.prepareRoutineProperties(d1, "w", { [count.id]: 4 }), lib.RoutinePropertyError);
  assert.equal(db.prepare("SELECT properties_json FROM routines WHERE id='r'").get().properties_json, "{}");
});

test("remove/restore and type preview keep existing values, names are tenant scoped and unique", async (t) => {
  const { db, d1, create } = fixture(t);
  const field = await create("Count", "number");
  db.prepare("UPDATE routines SET properties_json=? WHERE id='r'").run(JSON.stringify({ [field.id]: 7 }));
  await assert.rejects(create("count", "text"), lib.RoutinePropertyError);
  await lib.saveRoutineProperty(d1, "other", { name: "Count", type: "number" }, true);
  await lib.saveRoutineProperty(d1, "w", { id: field.id, active: false });
  assert.equal((await lib.listRoutineProperties(d1, "w")).length, 0);
  assert.equal((await lib.listRoutineProperties(d1, "w", true))[0].valueCount, 1);
  await lib.saveRoutineProperty(d1, "w", { id: field.id, active: true });
  const preview = await lib.saveRoutineProperty(d1, "w", { id: field.id, type: "date", defaultValue: null, preview: true });
  assert.equal(preview.analysis.incompatibleCount, 1);
  assert.equal(lib.parseRoutineProperties(db.prepare("SELECT properties_json FROM routines WHERE id='r'").get().properties_json)[field.id], 7);
  await assert.rejects(lib.saveRoutineProperty(d1, "other", { id: field.id, active: false }), lib.RoutinePropertyError);
});

test("strict dates, limits, field merges and clearing do not corrupt unrelated stored values", async (t) => {
  const { db, d1, create } = fixture(t);
  const date = await create("날짜", "date");
  await assert.rejects(lib.prepareRoutineProperties(d1, "w", { [date.id]: "2026-02-30" }));
  await assert.rejects(create("x".repeat(81), "text"));
  const field = await create("수", "number");
  db.prepare("UPDATE routines SET properties_json=? WHERE id='r'").run(JSON.stringify({ legacy: "보존", [field.id]: 5 }));
  const patch = await lib.prepareRoutineProperties(d1, "w", { [field.id]: null });
  db.prepare("UPDATE routines SET properties_json=json_patch(properties_json,?) WHERE id='r'").run(JSON.stringify(patch));
  assert.deepEqual(lib.parseRoutineProperties(db.prepare("SELECT properties_json FROM routines WHERE id='r'").get().properties_json), { legacy: "보존" });
});

test("default Routine classification is editable, backfills existing routines once and skips General", async (t) => {
  const { db, d1 } = fixture(t);
  await lib.ensureDefaultRoutineClassification(d1, "w");

  const [classification] = await lib.listRoutineProperties(d1, "w", true);
  assert.deepEqual(
    {
      name: classification.name,
      type: classification.type,
      options: classification.options,
      defaultValue: classification.defaultValue,
      active: classification.active,
    },
    {
      name: "분류",
      type: "select",
      options: ["운영", "고객지원(CS)", "품질관리(QA)", "재무", "인사(HR)"],
      defaultValue: "운영",
      active: true,
    },
  );
  assert.equal(lib.parseRoutineProperties(db.prepare("SELECT properties_json FROM routines WHERE id='r'").get().properties_json)[classification.id], "운영");
  assert.deepEqual(lib.parseRoutineProperties(db.prepare("SELECT properties_json FROM routines WHERE id='general'").get().properties_json), {});
  assert.deepEqual(await lib.prepareRoutineProperties(d1, "w", {}, true), { [classification.id]: "운영" });

  await lib.saveRoutineProperty(d1, "w", {
    id: classification.id,
    name: "백오피스",
    options: ["운영", "법무"],
    defaultValue: "법무",
  });
  await lib.ensureDefaultRoutineClassification(d1, "w");
  const definitions = await lib.listRoutineProperties(d1, "w", true);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].name, "백오피스");
  assert.deepEqual(definitions[0].options, ["운영", "법무"]);
  assert.equal(definitions[0].defaultValue, "법무");
  assert.equal(lib.parseRoutineProperties(db.prepare("SELECT properties_json FROM routines WHERE id='r'").get().properties_json)[classification.id], "운영");
});

test("an existing user classification wins and is never recreated after a later rename", async (t) => {
  const { db, d1, create } = fixture(t);
  const existing = await create("분류", "select", { options: ["직접 설정"], defaultValue: "직접 설정" });

  await lib.ensureDefaultRoutineClassification(d1, "w");
  assert.equal((await lib.listRoutineProperties(d1, "w", true)).length, 1);
  assert.deepEqual(lib.parseRoutineProperties(db.prepare("SELECT properties_json FROM routines WHERE id='r'").get().properties_json), {});

  await lib.saveRoutineProperty(d1, "w", { id: existing.id, name: "업무 영역" });
  await lib.ensureDefaultRoutineClassification(d1, "w");
  const definitions = await lib.listRoutineProperties(d1, "w", true);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].name, "업무 영역");
  assert.deepEqual(definitions[0].options, ["직접 설정"]);
});

test("routes preserve authorization, General protection, atomic routine writes and old snapshots", async () => {
  const route = await readFile(new URL("../app/api/routine-properties/route.ts", import.meta.url), "utf8");
  const data = await readFile(new URL("../lib/pace-data.ts", import.meta.url), "utf8");
  const backupSource = await readFile(new URL("../lib/workspace-backups.ts", import.meta.url), "utf8");
  assert.match(route, /authorizeRequest\(request\)/); assert.match(route, /!canManageTeam\(auth\)/);
  const update = data.slice(data.indexOf("export async function updateRoutine("), data.indexOf("export async function deleteRoutine("));
  assert.match(update, /General routine is protected/);
  assert.ok(update.indexOf("prepareRoutineProperties") < update.indexOf(".update(routines)"));
  assert.match(update, /json_patch/); assert.match(update, /eq\(routines.ownerId, ownerId\)/);
  assert.match(data, /ensureDefaultRoutineClassification\(\(env as RuntimeEnv\)\.DB, ownerId\)/);
  assert.match(data, /defaultRoutineClassificationMigrationId\(ownerId\)/);
  const js = ts.transpileModule(backupSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const backups = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  const tables = Object.fromEntries(backups.BACKUP_TABLES.filter((name) => name !== "routine_property_definitions").map((name) => [name, []]));
  assert.deepEqual(backups.validateSnapshot({ version: 1, workspaceId: "w", revision: 0, tables }, "w").tables.routine_property_definitions, []);
});
