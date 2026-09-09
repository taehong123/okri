import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { items, okrCycles, type OkrCycle, type PaceItem } from "@/db/schema";
import {
  getItemDeletePermissionMap,
  getWorkspaceRules,
  ITEM_STATUSES,
  listOkrCycles,
  type ItemStatus,
  type OkrCycleStatus,
} from "@/lib/pace-data";

type RuntimeEnv = typeof env & { DB: D1Database };

export type OkrFileMetadataInput = {
  name: string;
  department: string;
  startDate: string;
  endDate: string;
  status: OkrCycleStatus;
};

export type OkrFileInitiativeInput = {
  id?: string | null;
  clientId: string;
  title: string;
  status: ItemStatus;
};

export type OkrFileKeyResultInput = {
  id?: string | null;
  clientId: string;
  title: string;
  status: ItemStatus;
  progress: number;
  initiatives: OkrFileInitiativeInput[];
};

export type OkrFileObjectiveInput = {
  id?: string | null;
  clientId: string;
  title: string;
  status: ItemStatus;
  keyResults: OkrFileKeyResultInput[];
};

export type OkrProjectResolutionInput = {
  projectId: string;
  action: "move" | "trash";
  targetInitiativeRef?: string | null;
};

export type OkrFileSaveInput = {
  expectedRevision?: string | null;
  metadata: OkrFileMetadataInput;
  objective: OkrFileObjectiveInput;
  projectResolutions?: OkrProjectResolutionInput[];
};

export type OkrFileProjectSummary = {
  id: string;
  title: string;
  parentId: string;
  cycleId: string | null;
  taskCount: number;
  canTrash: boolean;
  updatedAt: string;
};

export type OkrFileInitiative = {
  id: string;
  clientId: string;
  title: string;
  status: ItemStatus;
  sortOrder: number;
  updatedAt: string;
  linkedProjects: OkrFileProjectSummary[];
};

export type OkrFileKeyResult = {
  id: string;
  clientId: string;
  title: string;
  status: ItemStatus;
  progress: number;
  sortOrder: number;
  updatedAt: string;
  initiatives: OkrFileInitiative[];
};

export type OkrFileObjective = {
  id: string;
  clientId: string;
  title: string;
  status: ItemStatus;
  updatedAt: string;
  keyResults: OkrFileKeyResult[];
};

export type OkrInitiativeOption = {
  id: string;
  title: string;
  cycleId: string;
  cycleName: string;
};

export type OkrFileResponse = {
  cycle: ReturnType<typeof serializeCycle>;
  revision: string;
  objective: OkrFileObjective | null;
  objectiveCount: number;
  needsSplit: boolean;
  initiativeOptions: OkrInitiativeOption[];
};

type OkrFileContext = {
  cycle: OkrCycle;
  okrItems: PaceItem[];
  projects: PaceItem[];
  projectTasks: PaceItem[];
  permissions: Record<string, boolean>;
  allInitiatives: PaceItem[];
  cycleNames: Map<string, string>;
  revision: string;
};

type NormalizedNode = {
  id: string;
  clientId: string;
  existingId: string | null;
  kind: "objective" | "key_result" | "initiative";
  title: string;
  status: ItemStatus;
  progress: number;
  parentId: string | null;
  sortOrder: number;
};

export class OkrFileConflictError extends Error {
  constructor() {
    super("OKR file changed while you were editing it");
    this.name = "OkrFileConflictError";
  }
}

export async function getOkrFile(ownerId: string, userId: string, cycleId: string): Promise<OkrFileResponse> {
  const context = await loadOkrFileContext(ownerId, userId, cycleId);
  return serializeOkrFile(context);
}

export async function getOkrFileRead(ownerId: string, cycleId: string): Promise<OkrFileResponse> {
  const [cycleRows, okrItems] = await Promise.all([
    getDb().select().from(okrCycles).where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.id, cycleId))).limit(1),
    getDb().select().from(items).where(and(
      eq(items.ownerId, ownerId),
      eq(items.cycleId, cycleId),
      inArray(items.kind, ["objective", "key_result", "initiative"]),
      isNull(items.archivedAt),
    )).orderBy(asc(items.sortOrder), asc(items.createdAt)),
  ]);
  const [cycle] = cycleRows;
  if (!cycle) throw new Error("OKR file not found");
  const revision = await calculateRevision(cycle, okrItems);
  return serializeOkrFileTree(cycle, okrItems, revision);
}

export async function createOkrFile(ownerId: string, userId: string, input: OkrFileSaveInput): Promise<OkrFileResponse> {
  const { cycleId, statements } = await prepareOkrFileCreation(ownerId, userId, input);
  await (env as RuntimeEnv).DB.batch(statements);
  return getOkrFile(ownerId, userId, cycleId);
}

// Reuse the exact file validation and writes when setup completion must commit with the file.
export async function prepareOkrFileCreation(ownerId: string, userId: string, input: OkrFileSaveInput) {
  const normalized = normalizeSaveInput(input, null);
  const rules = await getWorkspaceRules(ownerId);
  const existingCycles = await getDb().select().from(okrCycles).where(eq(okrCycles.ownerId, ownerId));
  const version = existingCycles.reduce((maximum, cycle) => Math.max(maximum, cycle.version), 0) + 1;
  const cycleId = crypto.randomUUID();
  const now = new Date().toISOString();
  const d1 = (env as RuntimeEnv).DB;
  const statements: D1PreparedStatement[] = [];

  if (normalized.metadata.status === "active") {
    statements.push(d1.prepare("UPDATE okr_cycles SET status = 'planned', updated_at = ? WHERE owner_id = ? AND status = 'active'").bind(now, ownerId));
  }
  statements.push(d1.prepare(`INSERT INTO okr_cycles
    (id, owner_id, name, department, version, start_date, end_date, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(cycleId, ownerId, normalized.metadata.name, normalized.metadata.department, version, normalized.metadata.startDate, normalized.metadata.endDate, normalized.metadata.status, now, now));

  for (const node of normalized.nodes) {
    statements.push(insertNodeStatement(d1, ownerId, userId, cycleId, node, rules.defaultPriority, rules.defaultCadence, now));
  }
  statements.push(activityStatement(d1, ownerId, normalized.nodes[0].id, "okr_file_created", { cycleId }, now));
  return { cycleId, statements };
}

export async function updateOkrFile(ownerId: string, userId: string, cycleId: string, input: OkrFileSaveInput): Promise<OkrFileResponse> {
  const context = await loadOkrFileContext(ownerId, userId, cycleId);
  if (context.okrItems.filter((item) => item.kind === "objective").length > 1) throw new Error("Split this OKR file before editing it");
  if (!input.expectedRevision || input.expectedRevision !== context.revision) throw new OkrFileConflictError();

  const normalized = normalizeSaveInput(input, context);
  const currentById = new Map(context.okrItems.map((item) => [item.id, item]));
  const retainedIds = new Set(normalized.nodes.map((node) => node.existingId).filter((id): id is string => Boolean(id)));
  const removedRows = context.okrItems.filter((item) => !retainedIds.has(item.id));
  const removedIds = new Set(removedRows.map((item) => item.id));
  const removedInitiativeIds = new Set(removedRows.filter((item) => item.kind === "initiative").map((item) => item.id));
  const impactedProjects = context.projects.filter((project) => project.parentId && removedInitiativeIds.has(project.parentId));
  const resolutionByProject = new Map((input.projectResolutions ?? []).map((resolution) => [resolution.projectId, resolution]));
  const normalizedByRef = new Map<string, NormalizedNode>();
  for (const node of normalized.nodes.filter((entry) => entry.kind === "initiative")) {
    normalizedByRef.set(node.clientId, node);
    normalizedByRef.set(node.id, node);
  }
  const activeInitiatives = new Map(context.allInitiatives.filter((item) => !removedIds.has(item.id)).map((item) => [item.id, item]));
  const d1 = (env as RuntimeEnv).DB;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const rules = await getWorkspaceRules(ownerId);

  if (normalized.metadata.status === "active") {
    statements.push(d1.prepare("UPDATE okr_cycles SET status = 'planned', updated_at = ? WHERE owner_id = ? AND status = 'active' AND id != ?").bind(now, ownerId, cycleId));
  }
  statements.push(d1.prepare(`UPDATE okr_cycles
    SET name = ?, department = ?, start_date = ?, end_date = ?, status = ?, updated_at = ?
    WHERE owner_id = ? AND id = ?`)
    .bind(normalized.metadata.name, normalized.metadata.department, normalized.metadata.startDate, normalized.metadata.endDate, normalized.metadata.status, now, ownerId, cycleId));

  for (const node of normalized.nodes) {
    if (node.existingId) {
      const current = currentById.get(node.existingId);
      if (!current || current.kind !== node.kind) throw new Error("One or more OKR items do not belong to this file");
      statements.push(d1.prepare(`UPDATE items
        SET cycle_id = ?, parent_id = ?, title = ?, status = ?, progress = ?, sort_order = ?, updated_at = ?
        WHERE owner_id = ? AND id = ? AND kind = ?`)
        .bind(cycleId, node.parentId, node.title, node.status, node.progress, node.sortOrder, now, ownerId, node.id, node.kind));
    } else {
      statements.push(insertNodeStatement(d1, ownerId, userId, cycleId, node, rules.defaultPriority, rules.defaultCadence, now));
    }
  }

  for (const project of impactedProjects) {
    const resolution = resolutionByProject.get(project.id);
    if (!resolution) throw new Error(`Project resolution is required for ${project.title}`);
    if (resolution.action === "trash") {
      if (!context.permissions[project.id]) throw new Error(`You cannot move ${project.title} to trash`);
      statements.push(...trashProjectStatements(d1, ownerId, project.id, now));
      continue;
    }
    const targetRef = resolution.targetInitiativeRef?.trim();
    if (!targetRef) throw new Error(`A target Initiative is required for ${project.title}`);
    const draftTarget = normalizedByRef.get(targetRef);
    const existingTarget = activeInitiatives.get(targetRef);
    const targetId = draftTarget?.id ?? existingTarget?.id;
    const targetCycleId = draftTarget ? cycleId : existingTarget?.cycleId;
    if (!targetId || !targetCycleId) throw new Error(`The target Initiative for ${project.title} is not available`);
    statements.push(
      d1.prepare("UPDATE items SET parent_id = ?, cycle_id = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND kind = 'project'")
        .bind(targetId, targetCycleId, now, ownerId, project.id),
      d1.prepare("UPDATE items SET cycle_id = ?, updated_at = ? WHERE owner_id = ? AND parent_id = ? AND kind = 'task'")
        .bind(targetCycleId, now, ownerId, project.id),
      activityStatement(d1, ownerId, project.id, "project_relinked", { fromInitiativeId: project.parentId, toInitiativeId: targetId, cycleId: targetCycleId }, now),
    );
  }

  if (removedRows.length) {
    const placeholders = removedRows.map(() => "?").join(", ");
    const ids = removedRows.map((item) => item.id);
    statements.push(
      d1.prepare(`DELETE FROM kr_data_connections WHERE owner_id = ? AND kr_item_id IN (${placeholders})`).bind(ownerId, ...ids),
      d1.prepare(`DELETE FROM google_calendar_events WHERE owner_id = ? AND item_id IN (${placeholders})`).bind(ownerId, ...ids),
      d1.prepare(`UPDATE slack_automation_deliveries SET item_id = NULL WHERE owner_id = ? AND item_id IN (${placeholders})`).bind(ownerId, ...ids),
      d1.prepare(`DELETE FROM activity_log WHERE owner_id = ? AND item_id IN (${placeholders})`).bind(ownerId, ...ids),
      d1.prepare(`DELETE FROM items WHERE owner_id = ? AND id IN (${placeholders})`).bind(ownerId, ...ids),
    );
  }
  statements.push(activityStatement(d1, ownerId, normalized.nodes[0].id, "okr_file_updated", {
    cycleId,
    removedKeyResultCount: removedRows.filter((item) => item.kind === "key_result").length,
    removedInitiativeCount: removedRows.filter((item) => item.kind === "initiative").length,
    movedProjectCount: impactedProjects.filter((project) => resolutionByProject.get(project.id)?.action === "move").length,
    trashedProjectCount: impactedProjects.filter((project) => resolutionByProject.get(project.id)?.action === "trash").length,
  }, now));
  await d1.batch(statements);
  return getOkrFile(ownerId, userId, cycleId);
}

export async function splitOkrFile(ownerId: string, _userId: string, cycleId: string) {
  const context = await loadOkrFileContext(ownerId, _userId, cycleId);
  const objectives = context.okrItems.filter((item) => item.kind === "objective").sort(compareItems);
  if (objectives.length <= 1) return { split: false, cycles: await listOkrCycles(ownerId) };

  const allCycleItems = await getDb().select().from(items).where(and(eq(items.ownerId, ownerId), eq(items.cycleId, cycleId)));
  const children = new Map<string, PaceItem[]>();
  for (const item of allCycleItems) {
    if (!item.parentId) continue;
    children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
  }
  const descendants = (rootId: string) => {
    const result: PaceItem[] = [];
    const visit = (id: string) => {
      for (const child of children.get(id) ?? []) {
        result.push(child);
        visit(child.id);
      }
    };
    visit(rootId);
    return result;
  };
  const cycles = await getDb().select().from(okrCycles).where(eq(okrCycles.ownerId, ownerId));
  const nextVersion = cycles.reduce((maximum, cycle) => Math.max(maximum, cycle.version), 0) + 1;
  const now = new Date().toISOString();
  const d1 = (env as RuntimeEnv).DB;
  const statements: D1PreparedStatement[] = [];

  for (const [index, objective] of objectives.slice(1).entries()) {
    const newCycleId = crypto.randomUUID();
    const name = `${context.cycle.name} · ${objective.title}`.slice(0, 200);
    statements.push(d1.prepare(`INSERT INTO okr_cycles
      (id, owner_id, name, department, version, start_date, end_date, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`)
      .bind(newCycleId, ownerId, name, context.cycle.department, nextVersion + index, context.cycle.startDate, context.cycle.endDate, now, now));
    const movedIds = [objective.id, ...descendants(objective.id).map((item) => item.id)];
    const placeholders = movedIds.map(() => "?").join(", ");
    statements.push(d1.prepare(`UPDATE items SET cycle_id = ?, updated_at = ? WHERE owner_id = ? AND id IN (${placeholders})`)
      .bind(newCycleId, now, ownerId, ...movedIds));
    statements.push(activityStatement(d1, ownerId, objective.id, "okr_file_split", { fromCycleId: cycleId, toCycleId: newCycleId }, now));
  }
  statements.push(d1.prepare("UPDATE okr_cycles SET updated_at = ? WHERE owner_id = ? AND id = ?").bind(now, ownerId, cycleId));
  await d1.batch(statements);
  return { split: true, cycles: await listOkrCycles(ownerId) };
}

async function loadOkrFileContext(ownerId: string, userId: string, cycleId: string): Promise<OkrFileContext> {
  const [cycle] = await getDb().select().from(okrCycles).where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.id, cycleId))).limit(1);
  if (!cycle) throw new Error("OKR file not found");
  const okrItems = await getDb().select().from(items).where(and(
    eq(items.ownerId, ownerId),
    eq(items.cycleId, cycleId),
    inArray(items.kind, ["objective", "key_result", "initiative"]),
    isNull(items.archivedAt),
  )).orderBy(asc(items.sortOrder), asc(items.createdAt));
  const initiativeIds = okrItems.filter((item) => item.kind === "initiative").map((item) => item.id);
  const projects = initiativeIds.length ? await getDb().select().from(items).where(and(
    eq(items.ownerId, ownerId),
    eq(items.kind, "project"),
    inArray(items.parentId, initiativeIds),
    isNull(items.archivedAt),
  )).orderBy(asc(items.sortOrder), asc(items.createdAt)) : [];
  const projectIds = projects.map((project) => project.id);
  const projectTasks = projectIds.length ? await getDb().select().from(items).where(and(
    eq(items.ownerId, ownerId),
    eq(items.kind, "task"),
    inArray(items.parentId, projectIds),
    isNull(items.archivedAt),
  )) : [];
  const [permissions, allInitiatives, cycleRows] = await Promise.all([
    getItemDeletePermissionMap(ownerId, userId, projects),
    getDb().select().from(items).where(and(eq(items.ownerId, ownerId), eq(items.kind, "initiative"), isNull(items.archivedAt))).orderBy(asc(items.sortOrder), desc(items.createdAt)),
    getDb().select({ id: okrCycles.id, name: okrCycles.name }).from(okrCycles).where(eq(okrCycles.ownerId, ownerId)),
  ]);
  const revision = await calculateRevision(cycle, [...okrItems, ...projects, ...projectTasks]);
  return { cycle, okrItems, projects, projectTasks, permissions, allInitiatives, cycleNames: new Map(cycleRows.map((row) => [row.id, row.name])), revision };
}

function serializeOkrFile(context: OkrFileContext): OkrFileResponse {
  const objectives = context.okrItems.filter((item) => item.kind === "objective").sort(compareItems);
  const objective = objectives[0] ?? null;
  const projectsByInitiative = new Map<string, PaceItem[]>();
  for (const project of context.projects) {
    if (project.parentId) projectsByInitiative.set(project.parentId, [...(projectsByInitiative.get(project.parentId) ?? []), project]);
  }
  const taskCountByProject = new Map<string, number>();
  for (const task of context.projectTasks) {
    if (task.parentId) taskCountByProject.set(task.parentId, (taskCountByProject.get(task.parentId) ?? 0) + 1);
  }
  const keyResults = objective ? context.okrItems.filter((item) => item.kind === "key_result" && item.parentId === objective.id).sort(compareItems) : [];
  const serializedObjective: OkrFileObjective | null = objective ? {
    id: objective.id,
    clientId: objective.id,
    title: objective.title,
    status: objective.status as ItemStatus,
    updatedAt: objective.updatedAt,
    keyResults: keyResults.map((keyResult) => ({
      id: keyResult.id,
      clientId: keyResult.id,
      title: keyResult.title,
      status: keyResult.status as ItemStatus,
      progress: keyResult.progress,
      sortOrder: keyResult.sortOrder,
      updatedAt: keyResult.updatedAt,
      initiatives: context.okrItems.filter((item) => item.kind === "initiative" && item.parentId === keyResult.id).sort(compareItems).map((initiative) => ({
        id: initiative.id,
        clientId: initiative.id,
        title: initiative.title,
        status: initiative.status as ItemStatus,
        sortOrder: initiative.sortOrder,
        updatedAt: initiative.updatedAt,
        linkedProjects: (projectsByInitiative.get(initiative.id) ?? []).map((project) => ({
          id: project.id,
          title: project.title,
          parentId: initiative.id,
          cycleId: project.cycleId,
          taskCount: taskCountByProject.get(project.id) ?? 0,
          canTrash: context.permissions[project.id] ?? false,
          updatedAt: project.updatedAt,
        })),
      })),
    })),
  } : null;
  return {
    cycle: serializeCycle(context.cycle),
    revision: context.revision,
    objective: serializedObjective,
    objectiveCount: objectives.length,
    needsSplit: objectives.length > 1,
    initiativeOptions: context.allInitiatives.filter((initiative) => Boolean(initiative.cycleId)).map((initiative) => ({
      id: initiative.id,
      title: initiative.title,
      cycleId: initiative.cycleId!,
      cycleName: context.cycleNames.get(initiative.cycleId!) ?? "OKR",
    })),
  };
}

function serializeOkrFileTree(cycle: OkrCycle, okrItems: PaceItem[], revision: string): OkrFileResponse {
  const objectives = okrItems.filter((item) => item.kind === "objective").sort(compareItems);
  const objective = objectives[0] ?? null;
  const keyResults = objective ? okrItems.filter((item) => item.kind === "key_result" && item.parentId === objective.id).sort(compareItems) : [];
  return {
    cycle: serializeCycle(cycle),
    revision,
    objective: objective ? {
      id: objective.id,
      clientId: objective.id,
      title: objective.title,
      status: objective.status as ItemStatus,
      updatedAt: objective.updatedAt,
      keyResults: keyResults.map((keyResult) => ({
        id: keyResult.id,
        clientId: keyResult.id,
        title: keyResult.title,
        status: keyResult.status as ItemStatus,
        progress: keyResult.progress,
        sortOrder: keyResult.sortOrder,
        updatedAt: keyResult.updatedAt,
        initiatives: okrItems.filter((item) => item.kind === "initiative" && item.parentId === keyResult.id).sort(compareItems).map((initiative) => ({
          id: initiative.id,
          clientId: initiative.id,
          title: initiative.title,
          status: initiative.status as ItemStatus,
          sortOrder: initiative.sortOrder,
          updatedAt: initiative.updatedAt,
          linkedProjects: [],
        })),
      })),
    } : null,
    objectiveCount: objectives.length,
    needsSplit: objectives.length > 1,
    initiativeOptions: [],
  };
}

function normalizeSaveInput(input: OkrFileSaveInput, context: OkrFileContext | null) {
  if (!input || typeof input !== "object" || !input.metadata || typeof input.metadata !== "object") throw new Error("OKR file metadata is required");
  const metadata = input.metadata;
  const name = requireText(metadata.name, "File name", 200);
  const department = typeof metadata.department === "string" ? metadata.department.trim().slice(0, 120) : "";
  const startDate = requireDate(metadata.startDate, "Start date");
  const endDate = requireDate(metadata.endDate, "End date");
  if (startDate > endDate) throw new Error("Start date must be before end date");
  if (!(["planned", "active", "closed"] as string[]).includes(metadata.status)) throw new Error("Unsupported OKR file status");
  if (!input.objective || !Array.isArray(input.objective.keyResults) || input.objective.keyResults.length < 1) throw new Error("Objective and at least one Key Result are required");
  if (input.objective.keyResults.length > 20) throw new Error("An OKR file supports at most 20 Key Results");

  const currentById = new Map((context?.okrItems ?? []).map((item) => [item.id, item]));
  const refs = new Set<string>();
  const nodes: NormalizedNode[] = [];
  const makeNode = (source: { id?: string | null; clientId: string; title: string; status: ItemStatus }, kind: NormalizedNode["kind"], parentId: string | null, sortOrder: number, progress = 0) => {
    const clientId = requireText(source.clientId, `${kind} clientId`, 120);
    if (refs.has(clientId)) throw new Error("Every OKR item must have a unique clientId");
    refs.add(clientId);
    const existingId = source.id?.trim() || null;
    if (existingId && (!currentById.has(existingId) || currentById.get(existingId)?.kind !== kind)) throw new Error("One or more OKR items do not belong to this file");
    if (!context && existingId) throw new Error("New OKR files cannot reference existing items");
    const id = existingId ?? crypto.randomUUID();
    const status = requireItemStatus(source.status);
    const normalizedProgress = kind === "key_result" ? completed(status) ? 100 : clampProgress(progress) : 0;
    const node = { id, clientId, existingId, kind, title: requireText(source.title, kind, 500), status, progress: normalizedProgress, parentId, sortOrder };
    nodes.push(node);
    return node;
  };
  const objective = makeNode(input.objective, "objective", null, 0);
  for (const [keyResultIndex, keyResult] of input.objective.keyResults.entries()) {
    if (!Array.isArray(keyResult.initiatives) || keyResult.initiatives.length > 30) throw new Error("A Key Result supports at most 30 Initiatives");
    const normalizedKeyResult = makeNode(keyResult, "key_result", objective.id, (keyResultIndex + 1) * 10, keyResult.progress);
    for (const [initiativeIndex, initiative] of keyResult.initiatives.entries()) {
      makeNode(initiative, "initiative", normalizedKeyResult.id, (initiativeIndex + 1) * 10);
    }
  }
  return { metadata: { name, department, startDate, endDate, status: metadata.status }, nodes } as const;
}

function insertNodeStatement(d1: D1Database, ownerId: string, userId: string, cycleId: string, node: NormalizedNode, priority: string, cadence: string, now: string) {
  return d1.prepare(`INSERT INTO items
    (id, owner_id, cycle_id, parent_id, kind, title, description, status, priority, cadence, progress, sort_order, source, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'web', ?, ?, ?)`)
    .bind(node.id, ownerId, cycleId, node.parentId, node.kind, node.title, node.status, priority, cadence, node.progress, node.sortOrder, userId, now, now);
}

function trashProjectStatements(d1: D1Database, ownerId: string, projectId: string, now: string) {
  return [
    d1.prepare(`UPDATE items
      SET archived_from_status = CASE WHEN archived_from_status IS NULL THEN status ELSE archived_from_status END,
          status = 'archived', archived_at = COALESCE(archived_at, ?), archive_root_id = ?, updated_at = ?
      WHERE owner_id = ? AND archived_at IS NULL AND (id = ? OR (parent_id = ? AND kind = 'task'))`)
      .bind(now, projectId, now, ownerId, projectId, projectId),
    activityStatement(d1, ownerId, projectId, "item_trashed", { rootId: projectId, kind: "project", origin: "okr_file_update" }, now),
  ];
}

function activityStatement(d1: D1Database, ownerId: string, itemId: string, action: string, payload: Record<string, unknown>, now: string) {
  return d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
    VALUES (?, ?, ?, ?, 'web', ?, ?)`)
    .bind(crypto.randomUUID(), ownerId, itemId, action, JSON.stringify(payload), now);
}

async function calculateRevision(cycle: OkrCycle, rows: PaceItem[]) {
  const source = JSON.stringify({
    cycle: [cycle.id, cycle.name, cycle.department, cycle.startDate, cycle.endDate, cycle.status, cycle.updatedAt],
    rows: rows.sort((left, right) => left.id.localeCompare(right.id)).map((item) => [item.id, item.kind, item.parentId, item.cycleId, item.status, item.updatedAt]),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serializeCycle(cycle: OkrCycle) {
  return {
    id: cycle.id,
    name: cycle.name,
    department: cycle.department,
    version: cycle.version,
    startDate: cycle.startDate,
    endDate: cycle.endDate,
    status: cycle.status as OkrCycleStatus,
    createdAt: cycle.createdAt,
    updatedAt: cycle.updatedAt,
  };
}

function compareItems(left: PaceItem, right: PaceItem) {
  return left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function requireText(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim().slice(0, max);
}

function requireDate(value: unknown, label: string) {
  const date = requireText(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} is invalid`);
  return date;
}

function requireItemStatus(value: unknown): ItemStatus {
  if (typeof value !== "string" || value === "archived" || !ITEM_STATUSES.includes(value as ItemStatus)) throw new Error("Unsupported item status");
  return value as ItemStatus;
}

function completed(status: ItemStatus) {
  return status === "done" || status === "development_done";
}

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}
