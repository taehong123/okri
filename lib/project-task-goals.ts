export type ProjectTaskGoal = { projectId: string; targetCount: number; completedCount: number; progress: number; version: number; id: string };

export class TaskGoalError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

export async function readProjectTaskGoal(db: D1Database, ownerId: string, projectId: string) {
  const project = await db.prepare("SELECT progress FROM items WHERE owner_id = ? AND id = ? AND kind = 'project' AND archived_at IS NULL")
    .bind(ownerId, projectId).first<{ progress: number }>();
  if (!project) throw new TaskGoalError("project_not_found", 404);
  const row = await db.prepare(`SELECT g.id, g.target_count, g.version,
    (SELECT count(*) FROM items t WHERE t.owner_id = g.owner_id AND t.parent_id = g.project_id
      AND t.kind = 'task' AND t.status IN ('done', 'development_done') AND t.archived_at IS NULL) AS completed_count
    FROM project_task_goals g WHERE g.owner_id = ? AND g.project_id = ?`).bind(ownerId, projectId)
    .first<{ id: string; target_count: number; version: number; completed_count: number }>();
  const api = await db.prepare("SELECT id FROM kr_data_connections WHERE owner_id = ? AND kr_item_id = ? LIMIT 1").bind(ownerId, projectId).first();
  const goal: ProjectTaskGoal | null = row ? { id: row.id, projectId, targetCount: row.target_count, completedCount: row.completed_count,
    progress: Math.min(100, Math.round(row.completed_count / row.target_count * 100)), version: row.version } : null;
  return { goal, apiConnected: Boolean(api), progress: goal?.progress ?? project.progress };
}

export async function saveProjectTaskGoal(db: D1Database, ownerId: string, projectId: string, input: { targetCount?: unknown; expectedVersion?: unknown; expectedId?: unknown; enabled?: unknown }) {
  const { expectedVersion, enabled, targetCount } = input;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0 || typeof enabled !== "boolean") throw new TaskGoalError("invalid_goal", 400);
  if (enabled && (!Number.isSafeInteger(targetCount) || (targetCount as number) < 1 || (targetCount as number) > 1_000_000)) throw new TaskGoalError("invalid_goal", 400);
  const current = await readProjectTaskGoal(db, ownerId, projectId);
  if ((current.goal?.version ?? 0) !== expectedVersion || (current.goal && current.goal.id !== input.expectedId)) throw new TaskGoalError("goal_conflict", 409);
  if (enabled && current.apiConnected) throw new TaskGoalError("api_connected", 409);
  const now = new Date().toISOString();
  if (!enabled) {
    if (!current.goal) return current;
    const result = await db.prepare("DELETE FROM project_task_goals WHERE owner_id = ? AND project_id = ? AND version = ? AND id = ?")
      .bind(ownerId, projectId, expectedVersion, input.expectedId).run();
    if (!result.meta.changes) throw new TaskGoalError("goal_conflict", 409);
  } else {
    const result = await db.prepare(`INSERT INTO project_task_goals (id, owner_id, project_id, target_count, version, created_at, updated_at)
      SELECT ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM items WHERE id = ? AND owner_id = ? AND kind = 'project' AND archived_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM kr_data_connections WHERE owner_id = ? AND kr_item_id = ?)
        AND ((? = 0 AND NOT EXISTS (SELECT 1 FROM project_task_goals WHERE project_id = ?))
          OR EXISTS (SELECT 1 FROM project_task_goals WHERE owner_id = ? AND project_id = ? AND version = ? AND id = ?))
      ON CONFLICT(owner_id, project_id) DO UPDATE SET target_count = excluded.target_count, version = project_task_goals.version + 1, updated_at = excluded.updated_at
        WHERE project_task_goals.version = ? AND project_task_goals.id = ?`)
      .bind(crypto.randomUUID(), ownerId, projectId, targetCount, now, now, projectId, ownerId, ownerId, projectId,
        expectedVersion, projectId, ownerId, projectId, expectedVersion, input.expectedId ?? null, expectedVersion, input.expectedId ?? null).run();
    if (!result.meta.changes) throw new TaskGoalError("goal_conflict", 409);
  }
  return readProjectTaskGoal(db, ownerId, projectId);
}
