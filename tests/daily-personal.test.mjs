import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import { serverLanguage } from "./helpers/language-fixture.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
function compile(source, deps = {}) {
  const loaded = { exports: {} };
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "module", "exports", output)((name) => {
    assert.ok(name in deps, `Unmocked import ${name}`); return deps[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}
const work = compile(await read("../lib/daily-work.ts"));
const form = compile(await read("../lib/slack-daily-form.ts"));
const matching = compile(await read("../lib/slack-member-matching.ts"));
const dailySource = await read("../lib/daily-bot.ts");
const schema = JSON.parse(await read("../drizzle/meta/0038_snapshot.json"));
const migration = await read("../drizzle/0045_daily_work_selection.sql");
const yesterdayMigration = await read("../drizzle/0047_daily_yesterday_selection.sql");
const checklistMigration = await read("../drizzle/0049_slack_daily_checklists.sql");
const checklistSource = await read("../lib/slack-daily-checklist.ts");
const date = "2026-09-04";
const authorization = { ownerId: "w", userId: "u", role: "owner", apiToken: false };
function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  for (const table of Object.values(schema.tables)) {
    const columns = Object.values(table.columns).map((c) => `${c.name} ${c.type}${c.primaryKey ? " PRIMARY KEY" : ""}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${c.default}` : ""}`);
    for (const fk of Object.values(table.foreignKeys)) columns.push(`FOREIGN KEY (${fk.columnsFrom}) REFERENCES ${fk.tableTo} (${fk.columnsTo}) ON DELETE ${fk.onDelete}`);
    db.exec(`CREATE TABLE ${table.name} (${columns.join(",")})`);
    for (const index of Object.values(table.indexes)) db.exec(`CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${index.name} ON ${table.name} (${index.columns})${index.where ? ` WHERE ${index.where}` : ""}`);
  }
  assert.ok(!migration.includes("\r"));
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  assert.ok(!yesterdayMigration.includes("\r"));
  db.exec(yesterdayMigration.replaceAll("--> statement-breakpoint", ""));
  db.exec(checklistMigration.replaceAll("--> statement-breakpoint", ""));
  const raw = { prepare(sql) {
    const statement = db.prepare(sql); let args = [];
    return { bind(...values) { args = values; return this; }, async first() { return statement.get(...args) ?? null; },
      async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; } };
  }, async batch(statements) {
    db.exec("BEGIN");
    try { const results = []; for (const s of statements) results.push(await s.run()); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  db.exec(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ('w','Workspace','u'),('other','Other','other-user');
    INSERT INTO workspace_members (id,workspace_id,user_id,email,display_name,role,status) VALUES
      ('me','w','u','me@example.test','Me','owner','active'),('colleague','w','c','colleague@example.test','Same name','member','active'),
      ('foreign','other','other-user','foreign@example.test','Same name','owner','active');
    INSERT INTO items (id,owner_id,kind,title,status) VALUES
      ('project','w','project','My project','backlog'),('worker','w','project','Worker project','in_progress'),
      ('task','w','task','My task','todo'),('not-mine','w','task','Colleague task','todo'),
      ('done','w','task','Finished','done'),('foreign-task','other','task','Foreign task','todo');
    INSERT INTO item_assignments (id,owner_id,item_id,member_id,role) VALUES
      ('a1','w','project','me','project_dri'),('a2','w','worker','me','project_worker'),
      ('a3','w','task','me','task_assignee'),('a4','w','not-mine','colleague','task_assignee'),
      ('a5','w','done','me','task_assignee'),('a6','other','foreign-task','foreign','task_assignee');
    INSERT INTO routines (id,owner_id,title,assignee_member_id) VALUES ('routine','w','My routine','me'),('other-routine','w','Other routine','colleague');
    INSERT INTO slack_connections (id,owner_id,user_id,team_id,encrypted_bot_token) VALUES ('slack','w','u','T','mock');`);
  const tableProxy = (table) => new Proxy({}, { get: (_, key) => key === "$table" ? table : key });
  const ormSchema = { workspaceMembers: tableProxy("workspace_members"), items: tableProxy("items"), routines: tableProxy("routines") };
  const api = compile(dailySource, {
    "cloudflare:workers": { env: { DB: raw } }, "@/db/schema": ormSchema,
    "drizzle-orm": { eq: (key, value) => ({ key, value }), and: (...args) => args },
    "@/db": { getDb: () => ({ select: () => ({ from: (table) => ({ where: (conditions) => ({ limit: async () => {
      const rows = db.prepare(`SELECT * FROM ${table.$table}`).all().map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, x) => x.toUpperCase()), v])));
      return rows.filter((row) => conditions.every(({ key, value }) => row[key] === value)).slice(0, 1);
    } }) }) }) }) },
    "@/lib/daily-work": work, "@/lib/pace-data": { ensureWorkspace: async () => {}, dispatchSlackAutomationEvent: async () => {}, createItem: async (ownerId, input) => {
      if (!options.allowCreation) throw new Error("Must never invent tasks");
      await options.beforeCreate?.();
      const task = { id: crypto.randomUUID(), ownerId, priority: "medium", ...input };
      db.prepare("INSERT INTO items (id,owner_id,kind,title,status,parent_id,routine_id,due_date,source,source_ref,created_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(task.id, ownerId, task.kind, task.title, task.status, task.parentId, task.routineId, task.dueDate, task.source, task.sourceRef, task.createdByUserId);
      return task;
    }, replaceItemAssignmentRole: async (ownerId, itemId, role, memberIds) => {
      db.prepare("DELETE FROM item_assignments WHERE owner_id=? AND item_id=? AND role=?").run(ownerId, itemId, role);
      for (const memberId of memberIds) db.prepare("INSERT INTO item_assignments (id,owner_id,item_id,member_id,role) VALUES (?,?,?,?,?)").run(crypto.randomUUID(), ownerId, itemId, memberId, role);
    } },
  });
  const checklist = compile(checklistSource, { "cloudflare:workers": { env: { DB: raw } }, "@/lib/daily-bot": api, "@/lib/slack-daily-form": form });
  return { db, raw, api, checklist };
}

test("personal daily includes assigned DRI/worker projects, tasks and routines only", async (t) => {
  const { raw, db } = fixture(t);
  assert.deepEqual((await work.listDailyWork(raw, "w", "me", date)).map((w) => w.key).sort(),
    ["project:project", "project:worker", "routine:routine", "task:task"]);
  db.exec("INSERT INTO routine_completions (id,owner_id,routine_id,completion_date) VALUES ('done-routine','w','routine','2026-09-04')");
  assert.ok(!(await work.listDailyWork(raw, "w", "me", date)).some((w) => w.kind === "routine"));
  assert.ok((await work.listDailyWork(raw, "w", "me", "2026-09-05")).some((w) => w.kind === "routine"));
});

test("project and routine selection submits snapshots without creating tasks or changing work", async (t) => {
  const { raw, db, api } = fixture(t);
  const before = db.prepare("SELECT * FROM items ORDER BY id").all();
  await api.saveDailyDraft(authorization, { date, selectedWorkIds: ["project:project", "routine:routine"] }, false);
  const submitted = await api.submitDailyDraft(authorization, date, "slack");
  assert.deepEqual(submitted.work.map((w) => w.key), ["project:project", "routine:routine"]);
  assert.deepEqual(submitted.tasks, []);
  assert.deepEqual(db.prepare("SELECT * FROM items ORDER BY id").all(), before);
  db.exec("UPDATE items SET title='Renamed' WHERE id='project'");
  assert.equal(work.dailyWorkSnapshots(db.prepare("SELECT work_snapshot_json FROM daily_submissions").get().work_snapshot_json)[0].title, "My project");
  const dashboard = await api.getDailyDashboard(authorization, date);
  assert.equal(dashboard.team.find((m) => m.memberId === "me").submission.work.length, 2);
  assert.equal((await work.validateDailyWork(raw, "w", "me", date, [])).length, 0);
});

test("foreign, unassigned and changed work are rejected before submission", async (t) => {
  const { raw, db, api } = fixture(t);
  for (const key of ["task:not-mine", "task:foreign-task", "routine:other-routine", "task:done"]) {
    await assert.rejects(work.validateDailyWork(raw, "w", "me", date, [key]));
    await assert.rejects(api.saveDailyDraft(authorization, { date, selectedWorkIds: [key] }, false));
  }
  await api.saveDailyDraft(authorization, { date, selectedWorkIds: ["project:project"] }, false);
  db.exec("DELETE FROM item_assignments WHERE id='a1'");
  await assert.rejects(api.submitDailyDraft(authorization, date));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_submissions").get().n, 0);
});

test("skip clears work; old task-only clients retain selected project and routine", async (t) => {
  const { api } = fixture(t);
  await api.saveDailyDraft(authorization, { date, selectedWorkIds: ["project:worker"] }, false);
  await api.saveDailyDraft(authorization, { date, selectedTaskIds: ["task"] }, false);
  let draft = await api.getDailyDashboard(authorization, date);
  assert.deepEqual(draft.draft.selectedWorkIds.sort(), ["project:worker", "task:task"]);
  await api.saveDailyDraft(authorization, { date, skipReason: "vacation" }, false);
  const submitted = await api.submitDailyDraft(authorization, date);
  assert.deepEqual(submitted.work, []); assert.deepEqual(submitted.tasks, []);
});

test("work parsing bounds selection and rejects forged kinds", () => {
  for (const input of ['"bad"', ["owner:me"], ["project:"], Array.from({ length: 51 }, (_, i) => `project:${i}`)]) assert.throws(() => work.parseDailyWorkKeys(input));
  assert.deepEqual(work.parseDailyWorkKeys(["task:t", "task:t"]), ["task:t"]);
});

test("failed selection writes roll back both notes and previous selections", async (t) => {
  const { db, api } = fixture(t);
  await api.saveDailyDraft(authorization, { date, todayNote: "Original", selectedWorkIds: ["project:project"] }, false);
  db.exec("CREATE TRIGGER fail_selection BEFORE INSERT ON daily_scrum_task_selections BEGIN SELECT RAISE(ABORT,'mock failure'); END");
  await assert.rejects(api.saveDailyDraft(authorization, { date, todayNote: "Unsaved", selectedWorkIds: ["task:task"] }, false));
  const original = db.prepare("SELECT today_note,work_selection_json FROM daily_scrums").get();
  assert.equal(original.today_note, "Original");
  assert.equal(original.work_selection_json, '["project:project"]');
});

test("Slack v2 modal uses searchable completed and today multi-selects", () => {
  const entries = Array.from({ length: 75 }, (_, i) => ({ key: `task:${i}`, id: String(i), title: "Long title ".repeat(20), kind: "task", parentTitle: "Project", dueDate: null }));
  const yesterday = entries.map((entry, index) => ({ ...entry, completedYesterday: index === 0, willCompleteOnSubmit: index !== 0 }));
  const modal = form.dailyForm({ work: entries, yesterdayWork: yesterday, memberName: "Me", date, selected: ["task:72"], selectedYesterday: ["task:0", "task:2"], yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", metadata: "{}", noPlannedTasks: false });
  const inputs = modal.blocks.filter((b) => b.type === "input");
  assert.equal(inputs[0].block_id, "yesterday_work");
  assert.equal(inputs[0].label.text, "완료한 일");
  assert.equal(inputs[0].element.type, "multi_external_select");
  assert.equal(inputs[0].element.initial_options.length, 2);
  assert.match(inputs[0].element.initial_options[1].description.text, /제출 시 완료 처리/);
  assert.equal(inputs[2].block_id, "today_work");
  assert.equal(inputs[2].element.initial_options[0].value, "task:72");
  assert.ok(!JSON.stringify(modal).includes("new_task"));
  assert.ok(modal.blocks.length < 100);
});

test("DRI and participants can add their own Task, including backlog projects, without creating on lookup", async (t) => {
  const { db, api } = fixture(t, { allowCreation: true });
  db.exec("UPDATE workspace_members SET role='member' WHERE id='me'");
  const auth = { ...authorization, role: "member" };
  const dashboard = await api.getDailyDashboard(auth, date);
  assert.deepEqual(dashboard.createTargets.projects.map((entry) => entry.id).sort(), ["project", "worker"]);
  assert.ok(dashboard.createTargets.projects.every((entry) => entry.hasTasks === false));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items").get().n, 6);
  await api.saveDailyDraft(auth, { date, todayNote: "Keep notes", selectedWorkIds: ["task:task"] }, false);
  for (const parentId of ["worker", "project"]) {
    const input = { date, parentKind: "project", parentId, title: `My ${parentId} task`, requestId: parentId };
    const task = await api.createExplicitDailyTask(auth, input);
    assert.equal(task.parentId, parentId);
    assert.deepEqual(db.prepare("SELECT member_id FROM item_assignments WHERE item_id=?").all(task.id).map((row) => row.member_id), ["me"]);
    assert.equal((await api.createExplicitDailyTask(auth, input)).id, task.id);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items").get().n, 8);
  const result = await api.getDailyDashboard(auth, date);
  assert.equal(result.draft.todayNote, "Keep notes");
  assert.equal(result.draft.selectedTaskIds.length, 3);
  assert.equal(db.prepare("SELECT status FROM items WHERE id='project'").get().status, "backlog");
});

test("Task creation rejects viewers, removed participants, foreign and closed projects", async (t) => {
  const { db, api } = fixture(t, { allowCreation: true });
  const input = { date, title: "My task", parentKind: "project", parentId: "worker", requestId: "creation" };
  await assert.rejects(api.createExplicitDailyTask({ ...authorization, role: "viewer" }, input));
  db.exec("UPDATE workspace_members SET role='viewer' WHERE id='me'");
  await assert.rejects(api.createExplicitDailyTask(authorization, input));
  db.exec("UPDATE workspace_members SET role='member' WHERE id='me'; DELETE FROM item_assignments WHERE id='a2'");
  await assert.rejects(api.createExplicitDailyTask(authorization, input));
  await assert.rejects(api.createExplicitDailyTask(authorization, { ...input, parentId: "foreign-task" }));
  db.exec("UPDATE items SET status='done' WHERE id='project'");
  await assert.rejects(api.createExplicitDailyTask(authorization, { ...input, parentId: "project" }));
  db.exec("UPDATE workspace_members SET status='inactive' WHERE id='me'");
  await assert.rejects(api.createExplicitDailyTask(authorization, input));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items").get().n, 6);
});

test("task-focused Slack checklist shows empty projects but only offers Task choices under them", () => {
  const project = { id: "p", key: "project:p", kind: "project", title: "Project" };
  const empty = { id: "e", key: "project:e", kind: "project", title: "Empty Project" };
  const task = { id: "t", key: "task:t", kind: "task", title: "My Task", parentId: "p", parentKind: "project", parentTitle: "Project" };
  const input = { ...checklistInput([project, task, empty]), taskFocused: true, taskTargets: [{ key: "project:p", title: "Project", hasTasks: true }, { key: "project:e", title: "Empty Project", hasTasks: false }] };
  const modal = form.dailyChecklistForm(input, "{}");
  assert.deepEqual(modal.blocks.filter((block) => block.block_id?.startsWith("daily_choice_")).map((block) => block.label.text), ["My Task"]);
  assert.equal(modal.blocks.filter((block) => block.accessory?.action_id === "daily_checklist_add_task").length, 1);
  const emptyHeading = modal.blocks.findIndex((block) => block.text?.text === "Empty Project");
  assert.equal(modal.blocks[emptyHeading + 1].elements[0].text, "아직 Task가 없습니다.");
  assert.equal(modal.blocks[emptyHeading + 2].elements[0].action_id, "daily_checklist_add_task");
  assert.equal(modal.blocks[emptyHeading + 2].elements[0].value, "project:e");
  assert.match(JSON.stringify(modal), /아직 Task가 없습니다/);
});

test("empty-project buttons and their inline editor fit Slack limits in every language", async () => {
  const projects = Array.from({ length: 20 }, (_, i) => ({ id: `p-${i}`, key: `project:p-${i}`, kind: "project", title: `Project ${i}` }));
  for (const language of ["ko", "en", "ja", "zh", "es"]) {
    const translate = await serverLanguage.serverTranslator(language);
    const input = { ...checklistInput(projects), taskFocused: true, taskTargets: projects.map((p) => ({ key: p.key, title: p.title, hasTasks: false })) };
    const initial = form.dailyChecklistForm(input, "{}", translate);
    assert.equal(initial.blocks.filter((b) => b.block_id?.startsWith("daily_add_")).length, 20);
    for (const block of initial.blocks.filter((b) => b.block_id?.startsWith("daily_add_"))) {
      assert.equal(block.elements[0].text.text, translate("Task 추가"));
      assert.ok(block.elements[0].text.text.length <= 75);
    }
    const opened = form.dailyChecklistForm({ ...input, taskEntry: { parentKey: "project:p-19", title: "", requestId: "request" } }, "{}", translate);
    const index = opened.blocks.findIndex((b) => b.block_id === "daily_new_task");
    assert.equal(opened.blocks[index - 2].text.text, "Project 19");
    assert.equal(opened.blocks[index].label.text, translate("새 Task 제목"));
    assert.equal(opened.blocks[index + 1].elements[0].text.text, translate("추가하고 오늘 할 일에 선택"));
    assert.equal(opened.blocks.filter((b) => b.element?.focus_on_load).length, 1);
    assert.ok(initial.blocks.length <= 100 && opened.blocks.length <= 100);
  }
});

test("empty-project editor opens and cancels even with unfinished choices elsewhere", async (t) => {
  const { raw, db, checklist } = fixture(t);
  const input = { ...checklistInput(await work.listDailyWork(raw, "w", "me", date)), taskFocused: true,
    taskTargets: [{ key: "project:worker", title: "Worker project", hasTasks: false }] };
  const opened = await checklist.createDailyChecklist("w", "me", input, (key) => key);
  const state = { "daily_choice_task:task": { choice: { selected_options: [{ value: "today" }, { value: "done" }] } },
    today_note: { value: { value: "Unsubmitted note" } } };
  const added = await checklist.editDailyChecklistTask(authorization, opened.private_metadata, state, "add", "project:worker", (key) => key);
  assert.equal(added.blocks.find((b) => b.block_id === "daily_new_task").element.focus_on_load, true);
  assert.equal(added.blocks.find((b) => b.block_id === "today_note").element.initial_value, "Unsubmitted note");
  const cancelled = await checklist.editDailyChecklistTask(authorization, added.private_metadata, state, "cancel", "project:worker", (key) => key);
  assert.equal(cancelled.blocks.some((b) => b.block_id === "daily_new_task"), false);
  // Opening a field must not create a Task or commit incomplete checkbox choices.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items").get().n, 6);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_submissions").get().n, 0);
  const invalid = await checklist.handleDailyChecklist(authorization, cancelled.private_metadata, state, false, (key) => key);
  assert.ok(invalid.errors["daily_choice_task:task"]);
});

test("untouched null checkbox state does not block adding a Task to an empty project", async (t) => {
  const { raw, checklist } = fixture(t, { allowCreation: true });
  const opened = await checklist.createDailyChecklist("w", "me", { ...checklistInput(await work.listDailyWork(raw, "w", "me", date)), taskFocused: true,
    taskTargets: [{ key: "project:worker", title: "Worker project", hasTasks: false }] }, (key) => key);
  const state = { "daily_choice_task:task": { choice: { selected_options: null } } };
  const added = await checklist.editDailyChecklistTask(authorization, opened.private_metadata, state, "add", "project:worker", (key) => key);
  assert.ok(added.blocks.find((b) => b.block_id === "daily_new_task"));
  const created = await checklist.editDailyChecklistTask(authorization, added.private_metadata,
    { ...state, daily_new_task: { title: { value: "First Task" } } }, "create", "project:worker", (key) => key);
  assert.ok(created.blocks.find((b) => b.label?.text === "First Task")?.element.initial_options.some((o) => o.value === "today"));
});

test("Slack participant adds a Task inside the checklist, preserves choices and notes, and replay creates once", async (t) => {
  const { db, raw, api, checklist } = fixture(t, { allowCreation: true });
  const dashboard = await api.getDailyDashboard(authorization, date);
  const input = { ...checklistInput(await work.listDailyWork(raw, "w", "me", date)), taskFocused: true,
    taskTargets: dashboard.createTargets.projects.map((project) => ({ ...project, key: `project:${project.id}` })) };
  const opened = await checklist.createDailyChecklist("w", "me", input, (key) => key);
  const add = await checklist.editDailyChecklistTask(authorization, opened.private_metadata,
    { "daily_choice_task:task": choice("today"), today_note: { value: { value: "Keep this note" } } }, "add", "project:worker", (key) => key);
  const state = { daily_new_task: { title: { value: "Explicit participant task" } } };
  const created = await checklist.editDailyChecklistTask(authorization, add.private_metadata, state, "create", "project:worker", (key) => key);
  await checklist.editDailyChecklistTask(authorization, add.private_metadata, state, "create", "project:worker", (key) => key);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE title='Explicit participant task'").get().n, 1);
  const saved = JSON.parse(db.prepare("SELECT payload_json FROM slack_daily_checklists").get().payload_json);
  assert.equal(saved.todayNote, "Keep this note");
  assert.equal(saved.choices["task:task"], "today");
  assert.equal(saved.choices[`task:${db.prepare("SELECT id FROM items WHERE title='Explicit participant task'").get().id}`], "today");
  assert.equal(saved.taskEntry, undefined);
  assert.equal(created.blocks.find((block) => block.block_id === "daily_choice_task:task").element.initial_options[0].value, "today");
  assert.notEqual(opened.blocks.find((block) => block.block_id === "no_planned").element.action_id,
    created.blocks.find((block) => block.block_id === "no_planned").element.action_id);
  const submission = await checklist.handleDailyChecklist(authorization, created.private_metadata, {}, false, (key) => key);
  assert.equal(submission.submission.tasks.length, 2);
  assert.equal(submission.submission.work.length, 0);
  assert.equal(submission.submission.todayNote, "Keep this note");
});

test("Slack Task creation retains its title after a failure and rejects permission changes", async (t) => {
  let fail = true;
  const { raw, db, checklist } = fixture(t, { allowCreation: true, beforeCreate: () => { if (fail) throw new Error("Mock failure"); } });
  const opened = await checklist.createDailyChecklist("w", "me", { ...checklistInput(await work.listDailyWork(raw, "w", "me", date)), taskFocused: true,
    taskTargets: [{ key: "project:worker", title: "Worker project" }] }, (key) => key);
  const add = await checklist.editDailyChecklistTask(authorization, opened.private_metadata, {}, "add", "project:worker", (key) => key);
  const state = { daily_new_task: { title: { value: "Keep task title" } } };
  await assert.rejects(checklist.editDailyChecklistTask(authorization, add.private_metadata, state, "create", "project:worker", (key) => key), /Mock failure/);
  const retry = await checklist.retryDailyChecklist(authorization, add.private_metadata, {}, "", (key) => key);
  assert.equal(retry.blocks.find((block) => block.block_id === "daily_new_task").element.initial_value, "Keep task title");
  db.exec("DELETE FROM item_assignments WHERE id='a2'");
  fail = false;
  await assert.rejects(checklist.editDailyChecklistTask(authorization, retry.private_metadata, state, "create", "project:worker", (key) => key));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items").get().n, 6);
});

test("simultaneous Slack create actions claim one Task and retain safe input IDs in five languages", async (t) => {
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const { raw, db, checklist } = fixture(t, { allowCreation: true, beforeCreate: async () => { entered(); await pending; } });
  const input = { ...checklistInput(await work.listDailyWork(raw, "w", "me", date)), taskFocused: true, noPlannedTasks: true,
    taskTargets: [{ key: "project:worker", title: "사용자가 작성한 프로젝트", hasTasks: false }] };
  const opened = await checklist.createDailyChecklist("w", "me", input, (key) => key);
  const add = await checklist.editDailyChecklistTask(authorization, opened.private_metadata, {}, "add", "project:worker", (key) => key);
  for (const language of ["ko", "en", "ja", "zh", "es"]) {
    const translate = await serverLanguage.serverTranslator(language);
    const payload = JSON.parse(db.prepare("SELECT payload_json FROM slack_daily_checklists").get().payload_json);
    const translated = form.dailyChecklistForm(payload, add.private_metadata, translate);
    assert.equal(translated.blocks.find((block) => block.block_id === "daily_new_task").label.text, translate("새 Task 제목"));
    assert.equal(translated.blocks.filter((block) => block.accessory?.action_id === "daily_checklist_add_task").length, 0);
    assert.ok(translated.blocks.length < 100);
  }
  const state = { daily_new_task: { title: { value: "Create exactly once" } } };
  const first = checklist.editDailyChecklistTask(authorization, add.private_metadata, state, "create", "project:worker", (key) => key);
  await ready;
  const duplicate = await checklist.editDailyChecklistTask(authorization, add.private_metadata, state, "create", "project:worker", (key) => key);
  await checklist.editDailyChecklistTask(authorization, duplicate.private_metadata, state, "create", "project:worker", (key) => key);
  release();
  const created = await first;
  const saved = JSON.parse(db.prepare("SELECT payload_json FROM slack_daily_checklists").get().payload_json);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE title='Create exactly once'").get().n, 1);
  assert.equal(saved.noPlannedTasks, false);
  assert.equal(created.blocks.find((block) => block.block_id === "no_planned").element.initial_options, undefined);
  const oldNone = opened.blocks.find((block) => block.block_id === "no_planned").element.action_id;
  assert.equal(checklist.mergeDailyChecklist(saved, { no_planned: { [oldNone]: { selected_options: [{ value: "yes" }] } } }, (key) => key).next.noPlannedTasks, false);
});

test("Task retries repair a failed own assignment but never reclaim a reassigned or archived Task", async (t) => {
  const { db, api } = fixture(t, { allowCreation: true });
  const input = { date, title: "My explicit Task", parentKind: "project", parentId: "worker", requestId: "recover-assignment" };
  const task = await api.createExplicitDailyTask(authorization, input);
  db.prepare("DELETE FROM item_assignments WHERE item_id=?").run(task.id);
  assert.equal((await api.createExplicitDailyTask(authorization, input)).id, task.id);
  assert.equal(db.prepare("SELECT member_id FROM item_assignments WHERE item_id=?").get(task.id).member_id, "me");
  db.prepare("UPDATE item_assignments SET member_id='colleague' WHERE item_id=?").run(task.id);
  await assert.rejects(api.createExplicitDailyTask(authorization, input));
  assert.equal(db.prepare("SELECT member_id FROM item_assignments WHERE item_id=?").get(task.id).member_id, "colleague");
  db.prepare("UPDATE items SET archived_at='2026-09-05' WHERE id=?").run(task.id);
  await assert.rejects(api.createExplicitDailyTask(authorization, input));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE source_ref IS NOT NULL").get().n, 1);
});

const checklistInput = (entries) => ({ date, memberName: "Me", work: entries, choices: {}, selectedYesterday: [], page: 0,
  todayNote: "", yesterdayNote: "", blockersNote: "", skipReason: null, skipNote: "", noPlannedTasks: false });
const choice = (...values) => ({ choice: { selected_options: values.map((value) => ({ value })) } });

test("new checklist shows every task without search, grouped by stable project ID with overdue dates", async () => {
  const entries = Array.from({ length: 101 }, (_, i) => ({ key: `task:${i}`, id: String(i), title: `Task ${i}`, kind: "task", parentId: `project-${Math.floor(i / 2)}`, parentKind: "project", parentTitle: "Same project name", dueDate: "2026-09-01" }));
  const seen = [];
  for (let page = 0; page < Math.ceil(entries.length / form.DAILY_CHECKLIST_PAGE_SIZE); page++) {
    const modal = form.dailyChecklistForm({ ...checklistInput(entries), page }, "opaque-metadata");
    assert.ok(modal.blocks.length <= 100);
    assert.ok(!JSON.stringify(modal).includes("external_select"));
    assert.match(JSON.stringify(modal), /기한 초과/);
    for (const input of modal.blocks.filter((block) => block.block_id?.startsWith("daily_choice_"))) {
      assert.equal(input.element.type, "checkboxes");
      assert.deepEqual(input.element.options.map((option) => option.value), ["today", "done", "delete"]);
      seen.push(input.block_id);
    }
  }
  assert.equal(new Set(seen).size, 101);
  assert.notEqual(form.dailyWorkGroup(entries[0]).key, form.dailyWorkGroup(entries[2]).key);
  for (const lang of ["en", "ja", "zh", "es"]) {
    const t = await serverLanguage.serverTranslator(lang);
    const modal = form.dailyChecklistForm(checklistInput(entries.slice(0, 1)), "{}", t);
    assert.ok(!/[가-힣]/.test(JSON.stringify(modal)));
    assert.ok(modal.blocks.find((block) => block.block_id === "daily_choice_0").element.options.find((option) => option.value === "delete"));
    assert.ok(JSON.stringify(modal).includes("Task 0"));
  }
});

test("checkbox conflicts are rejected and unchecking removes a plan without cancelling the task", async (t) => {
  const { raw, db, checklist } = fixture(t);
  const input = checklistInput(await work.listDailyWork(raw, "w", "me", date));
  input.choices["task:task"] = "today";
  const index = input.work.findIndex((entry) => entry.key === "task:task");
  const merged = checklist.mergeDailyChecklist(input, { [`daily_choice_${index}`]: choice("today", "done") }, (key) => key);
  assert.ok(merged.errors[`daily_choice_${index}`]);
  const cleared = checklist.mergeDailyChecklist(input, { [`daily_choice_${index}`]: choice() }, (key) => key);
  assert.equal(cleared.next.choices["task:task"], undefined);
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
});

test("checklist submit completes today's tasks atomically and retries never duplicate completion", async (t) => {
  const { raw, db, checklist, api } = fixture(t);
  const initial = checklistInput(await work.listDailyWork(raw, "w", "me", date));
  const modal = await checklist.createDailyChecklist("w", "me", initial, (key) => key);
  const id = JSON.parse(modal.private_metadata).id;
  const stored = JSON.parse(db.prepare("SELECT payload_json FROM slack_daily_checklists WHERE id=?").get(id).payload_json);
  const values = Object.fromEntries(stored.work.map((entry, i) => [`daily_choice_${i}`, choice(entry.key === "task:task" || entry.kind === "routine" ? "done" : "exclude")]));
  const first = await checklist.handleDailyChecklist(authorization, modal.private_metadata, values, false, (key) => key);
  assert.ok(first.submission);
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "done");
  assert.equal(db.prepare("SELECT status FROM items WHERE id='project'").get().status, "backlog");
  assert.equal(db.prepare("SELECT completion_date FROM routine_completions").get().completion_date, date);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM activity_log WHERE item_id='task'").get().payload).effectiveDate, date);
  assert.equal(first.submission.work.filter((entry) => entry.completedToday).length, 2);
  const nextDay = await work.listDailyYesterdayWork(raw, "w", "me", "2026-09-05", "Asia/Seoul");
  assert.deepEqual(nextDay.filter((entry) => entry.completedYesterday).map((entry) => entry.key).sort(), ["routine:routine", "task:task"]);
  const nextDashboard = await api.getDailyDashboard(authorization, "2026-09-05");
  assert.deepEqual(nextDashboard.draft.selectedYesterdayWorkIds.sort(), ["routine:routine", "task:task"]);
  const replay = await checklist.handleDailyChecklist(authorization, modal.private_metadata, values, false, (key) => key);
  assert.equal(replay.submission.id, first.submission.id);
  assert.equal(replay.submission.newlyCompletedCount, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_submissions").get().n, 1);
});

test("completed work is revalidated and a failed transaction does not complete anything", async (t) => {
  const { db, api } = fixture(t);
  await api.saveDailyDraft(authorization, { date, selectedWorkIds: [], noPlannedTasks: true }, false);
  for (const key of ["task:not-mine", "task:foreign-task", "task:done"]) await assert.rejects(api.submitDailyDraft(authorization, date, "slack", `bad-${key}`, [key]));
  db.exec("CREATE TRIGGER fail_submission BEFORE INSERT ON daily_submissions BEGIN SELECT RAISE(ABORT,'mock failure'); END");
  await assert.rejects(api.submitDailyDraft(authorization, date, "slack", "failed", ["task:task", "routine:routine"]));
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM routine_completions").get().n, 0);
});

test("delete on submit moves only the selected Task to Trash and replays never delete twice", async (t) => {
  const { raw, db, checklist } = fixture(t);
  db.exec("UPDATE items SET parent_id='project', status='in_progress', progress=35, description='Keep the document' WHERE id='task'");
  const modal = await checklist.createDailyChecklist("w", "me", checklistInput(await work.listDailyWork(raw, "w", "me", date)), (key) => key);
  const stored = JSON.parse(db.prepare("SELECT payload_json FROM slack_daily_checklists").get().payload_json);
  const index = stored.work.findIndex((entry) => entry.key === "task:task");
  const values = { [`daily_choice_${index}`]: choice("delete") };
  const before = db.prepare("SELECT * FROM items WHERE id <> 'task' ORDER BY id").all();
  const result = await checklist.handleDailyChecklist(authorization, modal.private_metadata, values, false, (key) => key);
  assert.ok(result.submission);
  assert.deepEqual(result.submission.work, []);
  const trashed = db.prepare("SELECT * FROM items WHERE id='task'").get();
  assert.equal(trashed.status, "archived");
  assert.equal(trashed.archived_from_status, "in_progress");
  assert.equal(trashed.archive_root_id, "task");
  assert.ok(trashed.archived_at);
  assert.equal(trashed.parent_id, "project");
  assert.equal(trashed.description, "Keep the document");
  assert.equal(trashed.progress, 35);
  assert.deepEqual(db.prepare("SELECT * FROM items WHERE id <> 'task' ORDER BY id").all(), before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM item_assignments WHERE item_id='task'").get().n, 1);
  assert.ok(!(await work.listDailyWork(raw, "w", "me", date)).some((entry) => entry.key === "task:task"));
  assert.ok(!(await work.listDailyWork(raw, "w", "me", "2026-09-05")).some((entry) => entry.key === "task:task"));
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM activity_log WHERE action='item_trashed'").get().payload).rootId, "task");
  const replay = await checklist.handleDailyChecklist(authorization, modal.private_metadata, values, false, (key) => key);
  assert.equal(replay.submission.id, result.submission.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='item_trashed'").get().n, 1);

  // Exercise the existing Trash restore SQL, not a parallel test-only restore implementation.
  const source = ts.createSourceFile("pace-data.ts", await read("../lib/pace-data.ts"), ts.ScriptTarget.Latest, true);
  const restore = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "restoreTrashedItems");
  const queries = [];
  const visit = (node) => { if (ts.isNoSubstitutionTemplateLiteral(node)) queries.push(node.text); ts.forEachChild(node, visit); };
  visit(restore);
  const restoreSql = queries.find((sql) => sql.includes("UPDATE items") && sql.includes("routine_id = ?") && sql.includes("archive_root_id = NULL"));
  assert.ok(restoreSql);
  db.prepare(restoreSql).run("project", null, new Date().toISOString(), "w", "task");
  const restored = db.prepare("SELECT status, archived_at, archive_root_id, progress FROM items WHERE id='task'").get();
  assert.equal(restored.status, "in_progress");
  assert.equal(restored.archived_at, null);
  assert.equal(restored.archive_root_id, null);
  assert.equal(restored.progress, 35);
  assert.ok((await work.listDailyWork(raw, "w", "me", date)).some((entry) => entry.key === "task:task"));
  await checklist.handleDailyChecklist(authorization, modal.private_metadata, values, false, (key) => key);
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "in_progress");
});

test("deletion is never offered or accepted for Project and Routine rows", async (t) => {
  const { raw, db, checklist, api } = fixture(t);
  const input = checklistInput(await work.listDailyWork(raw, "w", "me", date));
  const modal = form.dailyChecklistForm(input, "{}");
  input.work.forEach((entry, i) => {
    const options = modal.blocks.find((block) => block.block_id === `daily_choice_${i}`).element.options;
    assert.equal(options.some((option) => option.value === "delete"), entry.kind === "task");
    if (entry.kind !== "task") assert.ok(checklist.mergeDailyChecklist(input, { [`daily_choice_${i}`]: choice("delete") }, (key) => key).errors[`daily_choice_${i}`]);
  });
  await api.saveDailyDraft(authorization, { date, noPlannedTasks: true }, false);
  for (const key of ["project:project", "project:worker", "routine:routine", "task:not-mine", "task:foreign-task", "task:done"]) {
    await assert.rejects(api.submitDailyDraft(authorization, date, "slack", `delete-${key}`, [], [key]));
  }
  await assert.rejects(api.submitDailyDraft({ ...authorization, role: "viewer" }, date, "slack", "viewer-delete", [], ["task:task"]));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_submissions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE archived_at IS NOT NULL").get().n, 0);
});

test("completion and deletion roll back together on a write failure", async (t) => {
  const { db, api } = fixture(t);
  await api.saveDailyDraft(authorization, { date, noPlannedTasks: true }, false);
  db.exec("INSERT INTO slack_daily_channels (id,owner_id,channel_id,channel_name) VALUES ('daily-channel','w','C','Daily')");
  db.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON slack_daily_publications BEGIN SELECT RAISE(ABORT,'mock publication failure'); END");
  await assert.rejects(api.submitDailyDraft(authorization, date, "slack", "delete-rollback", ["routine:routine"], ["task:task"]));
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM routine_completions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_submissions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log").get().n, 0);
  db.exec("DROP TRIGGER fail_publication");
  await api.submitDailyDraft(authorization, date, "slack", "delete-rollback", ["routine:routine"], ["task:task"]);
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "archived");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM routine_completions").get().n, 1);
});

test("assignment, workspace membership and Task changes are rechecked atomically before deletion", async (t) => {
  for (const change of ["DELETE FROM item_assignments WHERE id='a3'", "UPDATE workspace_members SET role='viewer' WHERE id='me'", "UPDATE workspace_members SET status='inactive' WHERE id='me'", "UPDATE items SET status='done' WHERE id='task'", "UPDATE items SET kind='project' WHERE id='task'"]) {
    await t.test(change, async (t) => {
      const { db, raw, api } = fixture(t);
      await api.saveDailyDraft(authorization, { date, noPlannedTasks: true }, false);
      const batch = raw.batch;
      raw.batch = async (statements) => { db.exec(change); return batch(statements); };
      await assert.rejects(api.submitDailyDraft(authorization, date, "slack", "delete-race", [], ["task:task"]));
      assert.equal(db.prepare("SELECT archived_at FROM items WHERE id='task'").get().archived_at, null);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_submissions").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log").get().n, 0);
    });
  }
});

test("legacy exclusions, paging, cancelling and conflicting choices never delete work", async (t) => {
  const { raw, db, checklist, api } = fixture(t);
  const entries = await work.listDailyWork(raw, "w", "me", date);
  const task = entries.find((entry) => entry.key === "task:task");
  const legacy = await checklist.createDailyChecklist("w", "me", { ...checklistInput([task]), noPlannedTasks: true, choices: { "task:task": "exclude" } }, (key) => key);
  assert.ok(!JSON.stringify(legacy).includes('"value":"exclude"'));
  await checklist.handleDailyChecklist(authorization, legacy.private_metadata, { daily_choice_0: choice("exclude") }, false, (key) => key);
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
  const modal = await checklist.createDailyChecklist("w", "me", checklistInput([task, ...Array.from({ length: 20 }, (_, i) => ({ ...task, id: `t-${i}`, key: `task:t-${i}` }))]), (key) => key);
  const next = await checklist.handleDailyChecklist(authorization, modal.private_metadata, { daily_choice_0: choice("delete") }, false, (key) => key);
  const back = await checklist.handleDailyChecklist(authorization, next.view.private_metadata, {}, true, (key) => key);
  assert.equal(back.view.blocks.find((b) => b.block_id === "daily_choice_0").element.initial_options[0].value, "delete");
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
  const cleared = checklist.mergeDailyChecklist(checklistInput([task]), { daily_choice_0: choice() }, (key) => key);
  assert.deepEqual(cleared.next.choices, {});
  assert.ok(checklist.mergeDailyChecklist(checklistInput([task]), { daily_choice_0: choice("done", "delete") }, (key) => key).errors.daily_choice_0);
  await api.saveDailyDraft(authorization, { date, selectedWorkIds: ["task:task"] }, false);
  await assert.rejects(api.submitDailyDraft(authorization, date, "slack", "overlap-delete", [], ["task:task"]));
  await api.saveDailyDraft(authorization, { date, selectedWorkIds: [], noPlannedTasks: true }, false);
  await assert.rejects(api.submitDailyDraft(authorization, date, "slack", "overlap-done-delete", ["task:task"], ["task:task"]));
  await api.saveDailyDraft(authorization, { date, skipReason: "vacation" }, false);
  await assert.rejects(api.submitDailyDraft(authorization, date, "slack", "skip-delete", [], ["task:task"]));
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
});

test("Routine tasks retain their Routine and deleted Tasks under an archived Project keep its restore root", async (t) => {
  const { db, api } = fixture(t);
  db.exec("UPDATE items SET routine_id='routine' WHERE id='task'");
  const routinesBefore = db.prepare("SELECT * FROM routines ORDER BY id").all();
  await api.saveDailyDraft(authorization, { date, noPlannedTasks: true }, false);
  await api.submitDailyDraft(authorization, date, "slack", "routine-task-delete", [], ["task:task"]);
  assert.equal(db.prepare("SELECT routine_id FROM items WHERE id='task'").get().routine_id, "routine");
  assert.deepEqual(db.prepare("SELECT * FROM routines ORDER BY id").all(), routinesBefore);
  db.exec("UPDATE items SET archived_at=NULL, archived_from_status=NULL, archive_root_id=NULL, status='todo', parent_id='project', routine_id=NULL WHERE id='task'");
  db.exec("UPDATE items SET archived_at='2026-09-01', status='archived', archived_from_status='backlog', archive_root_id=id WHERE id='project'");
  await api.submitDailyDraft(authorization, date, "slack", "archived-parent-delete", [], ["task:task"]);
  assert.equal(db.prepare("SELECT archive_root_id FROM items WHERE id='task'").get().archive_root_id, "project");
});

test("50 deletions fit the binding limit and a 51st selection is rejected", async (t) => {
  const { raw, db, api } = fixture(t);
  const keys = Array.from({ length: 50 }, (_, i) => `task:delete-${i}`);
  for (let i = 0; i < 50; i++) {
    db.prepare("INSERT INTO items (id,owner_id,kind,title,status) VALUES (?,'w','task',?,'todo')").run(`delete-${i}`, `Delete ${i}`);
    db.prepare("INSERT INTO item_assignments (id,owner_id,item_id,member_id,role) VALUES (?,'w',?,'me','task_assignee')").run(`ad-${i}`, `delete-${i}`);
  }
  await api.saveDailyDraft(authorization, { date, noPlannedTasks: true }, false);
  const prepare = raw.prepare;
  raw.prepare = (sql) => {
    const statement = prepare(sql), bind = statement.bind;
    statement.bind = (...values) => { assert.ok(values.length <= 100); return bind.apply(statement, values); };
    return statement;
  };
  await assert.rejects(api.submitDailyDraft(authorization, date, "slack", "too-many-deletes", [], [...keys, "task:task"]));
  const result = await api.submitDailyDraft(authorization, date, "slack", "bulk-delete", [], keys);
  assert.ok(result.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE archived_at IS NOT NULL").get().n, 50);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action='item_trashed'").get().n, 50);
});

test("assignment changes between validation and transaction prevent completion", async (t) => {
  const { db, raw, api } = fixture(t);
  await api.saveDailyDraft(authorization, { date, selectedWorkIds: [], noPlannedTasks: true }, false);
  const batch = raw.batch;
  raw.batch = async (statements) => { db.exec("DELETE FROM item_assignments WHERE id='a3'"); return batch(statements); };
  await assert.rejects(api.submitDailyDraft(authorization, date, "slack", "race", ["task:task"]));
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_submissions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity_log").get().n, 0);
});

test("Slack acknowledges checklist submission before slow work finishes", async () => {
  const pending = [], updates = [];
  let finish;
  const workResult = new Promise((resolve) => { finish = resolve; });
  const route = compile(await read("../app/api/slack/interactions/route.ts"), {
    "@/lib/slack-management-actions": {},
    "cloudflare:workers": { env: { SLACK_SIGNING_SECRET: "mock", DB: {} }, waitUntil: (promise) => pending.push(promise) },
    "@/lib/pace-data": { getSlackConnectionByTeam: async () => ({ ownerId: "w" }) },
    "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => true },
    "@/lib/language-preferences": { memberMessageLanguage: async () => "en", workspaceMessageLanguage: async () => "en" },
    "@/lib/server-language": serverLanguage,
    "@/lib/slack-daily": { dailyMemberBySlack: async () => ({ authorization, memberId: "me" }),
      updateDailyChecklistView: async (...args) => updates.push(args), publishDailySubmission: async () => {}, reconcileDailyReminders: async () => {} },
    "@/lib/slack-daily-checklist": { handleDailyChecklist: async () => workResult, retryDailyChecklist: async () => null },
    "@/lib/slack-task-changes": { runDueTaskChanges: async () => {} },
    "@/lib/slack-work-command": {}, "@/lib/daily-bot": {},
  });
  const response = await route.POST(new Request("https://example.test/api/slack/interactions", { method: "POST", body: new URLSearchParams({ payload: JSON.stringify({
    type: "view_submission", team: { id: "T" }, user: { id: "U" }, view: { id: "V", callback_id: "daily_checklist_submit", private_metadata: "{}", state: { values: {} } },
  }) }) }));
  assert.equal((await response.json()).response_action, "update");
  assert.equal(updates.length, 0);
  finish({ submission: { id: "submission" } });
  await Promise.all(pending);
  assert.equal(updates.length, 1);
  assert.match(JSON.stringify(updates[0]), /Submitted/);
});

test("signed Task actions acknowledge first and update the same Slack modal without publishing", async () => {
  const pending = [], calls = [], updates = [];
  let signature = true;
  const route = compile(await read("../app/api/slack/interactions/route.ts"), {
    "@/lib/slack-management-actions": {},
    "cloudflare:workers": { env: { SLACK_SIGNING_SECRET: "mock", DB: {} }, waitUntil: (promise) => pending.push(promise) },
    "@/lib/pace-data": { getSlackConnectionByTeam: async () => ({ ownerId: "w" }) },
    "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => signature },
    "@/lib/language-preferences": { memberMessageLanguage: async () => "en", workspaceMessageLanguage: async () => "en" },
    "@/lib/server-language": serverLanguage,
    "@/lib/slack-daily": { dailyMemberBySlack: async () => ({ authorization, memberId: "me" }),
      updateDailyChecklistView: async (...args) => updates.push(args), publishDailySubmission: async () => assert.fail("Creation must not publish a daily") },
    "@/lib/slack-daily-checklist": { editDailyChecklistTask: async (...args) => { calls.push(args); return { type: "modal", blocks: [] }; } },
    "@/lib/slack-work-command": {}, "@/lib/daily-bot": {},
  });
  const request = (action) => new Request("https://example.test/api/slack/interactions", { method: "POST", body: new URLSearchParams({ payload: JSON.stringify({
    type: "block_actions", team: { id: "T" }, user: { id: "U" }, actions: [{ action_id: `daily_checklist_${action}_task`, value: "project:worker" }],
    view: { id: "V", hash: "view-hash", callback_id: "daily_checklist_submit", private_metadata: "metadata", state: { values: { today_note: { value: { value: "Keep notes" } } } } },
  }) }) });
  for (const action of ["add", "create", "cancel"]) {
    const response = await route.POST(request(action));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    while (pending.length) await Promise.all(pending.splice(0));
    const call = calls.at(-1);
    assert.equal(call[0].ownerId, "w"); assert.equal(call[1], "metadata");
    assert.equal(call[2].today_note.value.value, "Keep notes");
    assert.equal(call[3], action); assert.equal(call[4], "project:worker");
    assert.deepEqual(updates.at(-1).slice(0, 3), ["w", "V", "view-hash"]);
  }
  signature = false;
  assert.equal((await route.POST(request("create"))).status, 401);
  assert.equal(calls.length, 3);
});

test("Task buttons acknowledge before slow identity lookups and use block_actions state", async () => {
  const pending = [], edits = [], updates = [];
  let release;
  const lookup = new Promise((resolve) => { release = resolve; });
  const route = compile(await read("../app/api/slack/interactions/route.ts"), {
    "cloudflare:workers": { env: { SLACK_SIGNING_SECRET: "mock", DB: {} }, waitUntil: (promise) => pending.push(promise) },
    "@/lib/pace-data": { getSlackConnectionByTeam: async () => lookup },
    "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => true },
    "@/lib/language-preferences": { memberMessageLanguage: async () => "en", workspaceMessageLanguage: async () => "en" },
    "@/lib/server-language": serverLanguage,
    "@/lib/slack-daily": { dailyMemberBySlack: async () => ({ authorization, memberId: "me" }), updateDailyChecklistView: async (...args) => updates.push(args) },
    "@/lib/slack-daily-checklist": { editDailyChecklistTask: async (...args) => { edits.push(args); return { type: "modal", blocks: [] }; } },
    "@/lib/slack-management-actions": {},
    "@/lib/slack-work-command": {}, "@/lib/daily-bot": {},
  });
  const response = await Promise.race([
    route.POST(new Request("https://example.test/api/slack/interactions", { method: "POST", body: new URLSearchParams({ payload: JSON.stringify({
      type: "block_actions", team: { id: "T" }, user: { id: "U" }, actions: [{ action_id: "daily_checklist_create_task", value: "project:worker" }],
      state: { values: { daily_new_task: { title: { value: "Typed title" } } } },
      view: { id: "V", hash: "hash", callback_id: "daily_checklist_submit", private_metadata: "metadata", state: { values: {} } },
    }) }) })),
    new Promise((resolve) => { const timer = setTimeout(() => resolve(null), 1000); timer.unref(); }),
  ]);
  release({ ownerId: "w" });
  assert.ok(response, "Slack must receive an acknowledgement while the database lookup is pending");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  while (pending.length) await Promise.all(pending.splice(0));
  assert.equal(edits[0][2].daily_new_task.title.value, "Typed title");
  assert.equal(updates.length, 1);
});

test("failed Slack view recovery is logged without payload data and displays a minimal error", async (t) => {
  const pending = [], updates = [], logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const route = compile(await read("../app/api/slack/interactions/route.ts"), {
    "cloudflare:workers": { env: { SLACK_SIGNING_SECRET: "mock", DB: {} }, waitUntil: (promise) => pending.push(promise) },
    "@/lib/pace-data": { getSlackConnectionByTeam: async () => ({ ownerId: "w" }) },
    "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => true },
    "@/lib/language-preferences": { memberMessageLanguage: async () => "en", workspaceMessageLanguage: async () => "en" },
    "@/lib/server-language": serverLanguage,
    "@/lib/slack-daily": { dailyMemberBySlack: async () => ({ authorization, memberId: "me" }), updateDailyChecklistView: async (...args) => {
      updates.push(args);
      if (updates.length < 3) throw Object.assign(new Error("private title and xoxb-secret"), { code: "invalid_arguments" });
    } },
    "@/lib/slack-daily-checklist": { editDailyChecklistTask: async () => ({ type: "modal", blocks: [] }), retryDailyChecklist: async () => ({ type: "modal", blocks: [] }) },
    "@/lib/slack-management-actions": {},
    "@/lib/slack-work-command": {}, "@/lib/daily-bot": {},
  });
  const response = await route.POST(new Request("https://example.test/api/slack/interactions", { method: "POST", body: new URLSearchParams({ payload: JSON.stringify({
    type: "block_actions", team: { id: "T" }, user: { id: "U" }, actions: [{ action_id: "daily_checklist_add_task", value: "project:worker" }],
    view: { id: "V", hash: "hash", callback_id: "daily_checklist_submit", private_metadata: "metadata" },
  }) }) }));
  assert.equal(response.status, 200);
  while (pending.length) await Promise.all(pending.splice(0));
  assert.deepEqual(logs.map((row) => row[1].stage), ["edit_or_update", "recover_view"]);
  assert.ok(logs.every((row) => row[1].code === "invalid_arguments"));
  assert.doesNotMatch(JSON.stringify(logs), /private title|xoxb-secret/);
  assert.equal(updates.length, 3);
  assert.equal(updates[2][3].blocks.length, 1);
});

test("paged checklists preserve notes and choices, reject foreign/viewer access, and expire", async (t) => {
  const { raw, db, checklist } = fixture(t);
  const entries = await work.listDailyWork(raw, "w", "me", date);
  const input = checklistInput(Array.from({ length: 25 }, (_, i) => ({ ...entries[0], id: `p-${i}`, key: `project:p-${i}` })));
  const modal = await checklist.createDailyChecklist("w", "me", input, (key) => key);
  const next = await checklist.handleDailyChecklist(authorization, modal.private_metadata, { daily_choice_0: choice("today"), today_note: { value: { value: "Keep my note" } } }, false, (key) => key);
  assert.ok(next.view);
  const back = await checklist.handleDailyChecklist(authorization, next.view.private_metadata, { daily_choice_20: choice("exclude") }, true, (key) => key);
  assert.equal(back.view.blocks.find((b) => b.block_id === "daily_choice_0").element.initial_options[0].value, "today");
  assert.equal(back.view.blocks.find((b) => b.block_id === "today_note").element.initial_value, "Keep my note");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_submissions").get().n, 0);
  await assert.rejects(checklist.handleDailyChecklist({ ...authorization, role: "viewer" }, back.view.private_metadata, {}, false, (key) => key));
  await assert.rejects(checklist.handleDailyChecklist({ ...authorization, userId: "c" }, back.view.private_metadata, {}, false, (key) => key));
  const stale = await checklist.handleDailyChecklist(authorization, modal.private_metadata, {}, false, (key) => key);
  assert.equal(JSON.parse(stale.view.private_metadata).revision, 2);
  db.exec("UPDATE slack_daily_checklists SET expires_at='2000-01-01'");
  await assert.rejects(checklist.handleDailyChecklist(authorization, back.view.private_metadata, {}, false, (key) => key));
});

test("completed candidates auto-select actual completions and mark incomplete choices only on submit", async (t) => {
  const { raw, db, api } = fixture(t);
  db.exec(`INSERT INTO activity_log (id,owner_id,item_id,action,source,payload,created_at)
    VALUES ('completed-yesterday','w','done','updated','web','{"status":"done"}','2026-09-03T02:00:00.000Z')`);
  const candidates = await work.listDailyYesterdayWork(raw, "w", "me", date, "Asia/Seoul");
  assert.equal(candidates.find((entry) => entry.key === "task:done").completedYesterday, true);
  assert.equal(candidates.find((entry) => entry.key === "task:task").willCompleteOnSubmit, true);
  const initial = await api.getDailyDashboard(authorization, date);
  assert.deepEqual(initial.draft.selectedYesterdayWorkIds, ["task:done"]);

  await api.saveDailyDraft(authorization, {
    date, selectedWorkIds: [], selectedYesterdayWorkIds: ["task:done", "task:task", "routine:routine"], noPlannedTasks: true,
  }, false);
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM routine_completions").get().count, 0);
  const submitted = await api.submitDailyDraft(authorization, date, "web", "request-1");
  assert.equal(submitted.newlyCompletedCount, 2);
  assert.deepEqual(submitted.yesterdayWork.map((entry) => entry.key), ["task:done", "task:task", "routine:routine"]);
  assert.deepEqual({ ...db.prepare("SELECT status,progress FROM items WHERE id='task'").get() }, { status: "done", progress: 100 });
  assert.equal(db.prepare("SELECT completion_date FROM routine_completions WHERE routine_id='routine'").get().completion_date, date);
  const activity = db.prepare("SELECT source,payload,created_at FROM activity_log WHERE item_id='task'").get();
  assert.equal(activity.source, "daily");
  assert.equal(JSON.parse(activity.payload).effectiveDate, date);
  assert.equal(JSON.parse(activity.payload).origin, "daily_completed_selection");
  assert.match(activity.created_at, /^2026-/);
  assert.equal((await api.submitDailyDraft(authorization, date, "web", "request-1")).id, submitted.id);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM daily_submissions").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM activity_log WHERE item_id='task'").get().count, 1);
});

test("completed-work draft rejects overlap and failed submit rolls back completions", async (t) => {
  const { db, api } = fixture(t);
  await assert.rejects(api.saveDailyDraft(authorization, {
    date, selectedWorkIds: ["task:task"], selectedYesterdayWorkIds: ["task:task"],
  }, false), /동시에/);
  await api.saveDailyDraft(authorization, {
    date, selectedWorkIds: [], selectedYesterdayWorkIds: ["project:project"], noPlannedTasks: true,
  }, false);
  db.exec("UPDATE items SET parent_id='project' WHERE id='task'; CREATE TRIGGER fail_submission BEFORE INSERT ON daily_submissions BEGIN SELECT RAISE(ABORT,'mock failure'); END");
  await assert.rejects(api.submitDailyDraft(authorization, date, "web", "request-failed"));
  assert.deepEqual({ ...db.prepare("SELECT status,progress FROM items WHERE id='project'").get() }, { status: "backlog", progress: 0 });
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
  db.exec("DROP TRIGGER fail_submission");
  await api.submitDailyDraft(authorization, date, "web", "request-project");
  assert.equal(db.prepare("SELECT status FROM items WHERE id='project'").get().status, "done");
  assert.equal(db.prepare("SELECT status FROM items WHERE id='task'").get().status, "todo");
});

test("Slack modal translates system copy per recipient without translating user-authored work", async () => {
  const translate = await serverLanguage.serverTranslator("en");
  const modal = form.dailyForm({
    work: [{ key: "task:user", id: "user", title: "고객이 작성한 제목", kind: "task", parentTitle: "사용자 Project", dueDate: null }],
    yesterdayWork: [], memberName: "Taeho", date, selected: ["task:user"], selectedYesterday: [], yesterdayNote: "", todayNote: "", blockersNote: "", skipReason: null, skipNote: "", metadata: "{}", noPlannedTasks: false,
  }, translate);
  const rendered = JSON.stringify(modal);
  assert.equal(modal.title.text, "Daily");
  assert.equal(modal.close.text, "Cancel");
  assert.match(rendered, /고객이 작성한 제목/);
  assert.match(rendered, /사용자 Project/);
  assert.doesNotMatch(rendered, /오늘 할 업무|오늘 메모|데일리 스킵/);
});

test("Slack email matching preserves explicit links and does not match people by name", () => {
  const members = [{ id: "me", email: " ME@example.test ", display_name: "Same" }, { id: "other", email: "other@example.test", display_name: "Same" }];
  const users = [{ id: "U1", profile: { email: "me@example.test", display_name: "Same" } }, { id: "U2", profile: { display_name: "Same" } }];
  let plan = matching.planSlackMemberMatches(members, users, [], "T");
  assert.equal(plan[0].reason, "email_match_pending"); assert.equal(plan[1].reason, "email_not_found");
  plan = matching.planSlackMemberMatches(members, users, [{ member_id: "other", slack_user_id: "U1", matched_by: "manual", team_id: "T" }], "T");
  assert.equal(plan[0].reason, "already_linked"); assert.equal(plan[1].reason, "connected");
  assert.equal(matching.planSlackMemberMatches(members, [...users, { id: "U3", profile: { email: "me@example.test" } }], [], "T")[0].reason, "email_ambiguous");
  assert.equal(matching.planSlackMemberMatches(members, users.map((u) => ({ ...u, deleted: true })), [{ member_id: "me", slack_user_id: "U1", team_id: "T" }], "T")[0].reason, "slack_account_inactive");
});

test("linking cannot overwrite another member, cross workspace or erase manual links on resync", async (t) => {
  const { db, raw } = fixture(t);
  const users = [{ id: "U1", profile: { email: "me@example.test" } }, { id: "U2", profile: { email: "colleague@example.test" } }];
  await matching.attachSlackMember(raw, "w", "T", "colleague", users[0], "admin");
  await assert.rejects(matching.attachSlackMember(raw, "w", "T", "me", users[0], "email"));
  await assert.rejects(matching.attachSlackMember(raw, "w", "T", "foreign", users[1], "admin"));
  await matching.synchronizeSlackMembers(raw, "w", "T", users);
  const links = db.prepare("SELECT member_id, slack_user_id, matched_by FROM slack_member_links").all();
  assert.equal(links.length, 1); assert.equal(links[0].member_id, "colleague"); assert.equal(links[0].matched_by, "admin");
});

test("email synchronization adds new members once and preserves cached DM channels", async (t) => {
  const { db, raw } = fixture(t);
  const users = [{ id: "U1", profile: { email: "me@example.test" } }, { id: "U2", profile: { email: "colleague@example.test" } }];
  assert.equal((await matching.synchronizeSlackMembers(raw, "w", "T", users)).linked, 2);
  db.exec("UPDATE slack_member_links SET dm_channel_id='D-cache' WHERE member_id='me'");
  assert.equal((await matching.synchronizeSlackMembers(raw, "w", "T", users)).linked, 0);
  assert.equal(db.prepare("SELECT dm_channel_id FROM slack_member_links WHERE member_id='me'").get().dm_channel_id, "D-cache");
  db.exec("DELETE FROM slack_member_links WHERE member_id='me'; UPDATE workspace_members SET email='changed@example.test' WHERE id='me'");
  await assert.rejects(matching.attachSlackMember(raw, "w", "T", "me", users[0], "email"));
});

test("one-time Slack links never take over a colleague's existing account and cannot be replayed", async (t) => {
  const { db, raw } = fixture(t);
  db.exec("INSERT INTO slack_link_tokens (token_hash,owner_id,team_id,slack_user_id,expires_at) VALUES ('hash','w','T','U1','2099-01-01T00:00:00Z')");
  const source = ts.createSourceFile("slack-daily.ts", await read("../lib/slack-daily.ts"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "consumeSlackMemberLink").getFullText(source);
  const api = compile('const { env, sha256, currentMemberForSlackPreference, getSlackConnection, slackTokenForConnection, slackApi, scheduleMemberReminder } = require("fixture");\n' + fn, {
    fixture: { env: { DB: raw }, sha256: async () => "hash", currentMemberForSlackPreference: async () => ({ id: "me", displayName: "Me" }),
      getSlackConnection: async () => ({ teamId: "T" }), slackTokenForConnection: async () => "mock",
      slackApi: async () => ({ user: { id: "U1", profile: { email: "me@example.test" } } }), scheduleMemberReminder: async () => {} },
  });
  await matching.attachSlackMember(raw, "w", "T", "colleague", { id: "U1" }, "admin");
  await assert.rejects(api.consumeSlackMemberLink(authorization, "mock"));
  assert.equal(db.prepare("SELECT member_id FROM slack_member_links").get().member_id, "colleague");
  assert.equal(db.prepare("SELECT used_at FROM slack_link_tokens").get().used_at, null);
  db.exec("DELETE FROM slack_member_links");
  assert.equal((await api.consumeSlackMemberLink(authorization, "mock")).linked, true);
  await assert.rejects(api.consumeSlackMemberLink(authorization, "mock"));
  assert.equal(db.prepare("SELECT count(*) n FROM slack_member_links").get().n, 1);
});

test("member diagnostics and manual linking enforce admin, CSRF and explicit confirmation", async () => {
  const calls = [];
  let auth = { ...authorization };
  const route = compile(await read("../app/api/slack/members/route.ts"), {
    "@/lib/pace-data": { authorizeRequest: async () => auth, canManageTeam: (a) => ["owner", "admin"].includes(a.role) },
    "@/lib/slack-daily": { manageSlackMemberConnections: async (...args) => { calls.push(args); return {}; } },
    "@/lib/slack-display": { slackErrorMessage: () => "Failed" },
  });
  const request = (body, origin = "https://example.test") => new Request("https://example.test/api/slack/members", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  auth.role = "member"; assert.equal((await route.GET(new Request("https://example.test"))).status, 403);
  auth.role = "owner"; assert.equal((await route.POST(request({ action: "link", memberId: "me", slackUserId: "U1" }))).status, 400);
  assert.equal((await route.POST(request({ action: "sync" }, "https://attacker.test"))).status, 403);
  auth.apiToken = true; assert.equal((await route.POST(request({ action: "sync" }))).status, 403);
  assert.equal(calls.length, 0);
  auth.apiToken = false; assert.equal((await route.POST(request({ action: "link", memberId: "me", slackUserId: "U1", confirmed: true }))).status, 200);
  assert.equal(calls[0][0].ownerId, "w");
});

test("signed Slack submission passes every personal checklist and rejects other-member metadata", async () => {
  const saved = [], submitted = [], pending = [];
  const state = { memberId: "me", fail: false, signature: true, role: "owner", language: "en" };
  const route = compile(await read("../app/api/slack/interactions/route.ts"), {
    "@/lib/slack-management-actions": {},
    "@/lib/slack-daily-checklist": {},
    "cloudflare:workers": { env: { SLACK_SIGNING_SECRET: "mock", DB: { prepare: () => ({ bind: () => ({ first: async () => ({ yesterday_note: "Yesterday" }) }) }) } }, waitUntil: (p) => pending.push(p) },
    "@/lib/pace-data": { getSlackConnectionByTeam: async () => ({ ownerId: "w" }) },
    "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => state.signature },
    "@/lib/language-preferences": { memberMessageLanguage: async () => state.language, workspaceMessageLanguage: async () => "ko" },
    "@/lib/server-language": serverLanguage,
    "@/lib/slack-daily": { dailyMemberBySlack: async () => ({ authorization: { ...authorization, role: state.role } }), publishDailySubmission: async () => {}, reconcileDailyReminders: async () => {} },
    "@/lib/slack-work-command": { openSlackWorkCommandModal: async () => {}, slackWorkCommandOptions: async () => ({ options: [] }), submitSlackWorkCommand: async () => ({}) },
    "@/lib/daily-bot": { currentDailyMember: async () => ({ id: "me" }), normalizeDailySkipReason: (v) => v || null,
      saveDailyDraft: async (...args) => { if (state.fail) throw new Error("저장 실패"); saved.push(args); },
      submitDailyDraft: async (...args) => { submitted.push(args); return { id: "submission" }; } },
  });
  const request = () => new Request("https://example.test/api/slack/interactions", { method: "POST", body: new URLSearchParams({ payload: JSON.stringify({
    type: "view_submission", team: { id: "T" }, user: { id: "U" }, view: { callback_id: "daily_submit",
      private_metadata: JSON.stringify({ ownerId: "w", memberId: state.memberId, date, workVersion: 1, requestId: "request" }),
      state: { values: {
        daily_work_project_0: { selected_work: { selected_options: [{ value: "project:p" }] } },
        daily_work_task_0: { selected_work: { selected_options: [{ value: "task:t" }] } },
        daily_work_more: { selected_more_work: { selected_options: [{ value: "routine:r" }] } },
      } },
    },
  }) }) });
  assert.equal((await route.POST(request())).status, 200);
  assert.deepEqual(saved[0][1].selectedWorkIds, ["project:p", "task:t", "routine:r"]);
  assert.equal(saved[0][1].yesterdayNote, "Yesterday"); assert.equal(saved[0][2], false);
  const v2Request = () => new Request("https://example.test/api/slack/interactions", { method: "POST", body: new URLSearchParams({ payload: JSON.stringify({
    type: "view_submission", team: { id: "T" }, user: { id: "U" }, view: { callback_id: "daily_submit",
      private_metadata: JSON.stringify({ ownerId: "w", memberId: "me", date, workVersion: 2, requestId: "request-v2" }),
      state: { values: {
        yesterday_work: { selected_yesterday_work: { selected_options: [{ value: "task:yesterday" }] } },
        yesterday_note: { value: { value: "어제 메모" } },
        today_work: { selected_today_work: { selected_options: [{ value: "project:today" }] } },
      } },
    },
  }) }) });
  assert.equal((await route.POST(v2Request())).status, 200);
  assert.deepEqual(saved[1][1].selectedYesterdayWorkIds, ["task:yesterday"]);
  assert.deepEqual(saved[1][1].selectedWorkIds, ["project:today"]);
  assert.equal(saved[1][1].yesterdayNote, "어제 메모");
  assert.equal(submitted[1][3], "request-v2");
  await Promise.all(pending);
  state.memberId = "colleague";
  assert.equal((await (await route.POST(request())).json()).response_action, "errors");
  assert.equal(submitted.length, 2);
  state.memberId = "me"; state.fail = true;
  assert.equal((await (await route.POST(request())).json()).response_action, "errors");
  assert.equal(submitted.length, 2);
  state.role = "viewer";
  const viewerError = await (await route.POST(request())).json();
  assert.equal(viewerError.response_action, "errors");
  assert.match(Object.values(viewerError.errors).join(" "), /Read-only members/);
  state.signature = false; assert.equal((await route.POST(request())).status, 401);
});

test("Slack slash commands use the linked member language and preserve authored Task titles", async () => {
  const created = [];
  const route = compile(await read("../app/api/slack/commands/route.ts"), {
    "cloudflare:workers": { env: { SLACK_SIGNING_SECRET: "mock", DB: {} } },
    "@/lib/pace-data": {
      ensureWorkspace: async () => {}, getSlackConnectionByTeam: async () => ({ ownerId: "w", userId: "creator" }),
      createItem: async (_ownerId, input) => { created.push(input); return { title: input.title }; }, serializeItem: (item) => item,
    },
    "@/lib/slack-daily": { dailyMemberBySlack: async () => ({ authorization, memberId: "me" }), reconcileDailyReminders: async () => {} },
    "@/lib/slack-oauth": { slackConfigured: () => true, verifySlackRequest: async () => true },
    "@/lib/language-preferences": { memberMessageLanguage: async () => "en", workspaceMessageLanguage: async () => "ko" },
    "@/lib/server-language": serverLanguage,
  });
  const request = (text) => new Request("https://example.test/api/slack/commands", { method: "POST", body: new URLSearchParams({
    team_id: "T", user_id: "U", user_name: "Me", channel_id: "C", channel_name: "general", text,
  }) });
  const help = await (await route.POST(request("help"))).json();
  assert.match(help.text, /How to use/);
  const task = await (await route.POST(request("고객 인터뷰 정리"))).json();
  assert.equal(task.text, "Saved as a Task: 고객 인터뷰 정리");
  assert.equal(created[0].title, "고객 인터뷰 정리");
});
