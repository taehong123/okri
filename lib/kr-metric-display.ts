import { choice, PerformanceError, record } from "./kr-performance-model";
import { METRIC_DISPLAY_MODES, type MetricDisplayMode, type MetricDisplaySettings } from "./kr-metric-display-format";

type Row = { kr_item_id: string; mode: MetricDisplayMode; increment: number | null; revision: number; updated_at: string };
type Actor = { ownerId: string; role: string; oauthScopes?: string };
const defaultSettings: MetricDisplaySettings = { mode: "default", increment: null, revision: 0, updatedAt: null };
const settings = (row: Row | null): MetricDisplaySettings => row
  ? { mode: row.mode, increment: row.increment, revision: row.revision, updatedAt: row.updated_at } : defaultSettings;
const columns = "kr_item_id,mode,increment,revision,updated_at";

export async function listMetricDisplaySettings(db: D1Database, ownerId: string, ids: string[]) {
  if (!ids.length) return new Map<string, MetricDisplaySettings>();
  const { results } = await db.prepare(`SELECT ${columns} FROM kr_metric_display_settings
    WHERE owner_id=? AND kr_item_id IN (SELECT value FROM json_each(?))`).bind(ownerId, JSON.stringify(ids)).all<Row>();
  return new Map(results.map(row => [row.kr_item_id, settings(row)]));
}

export async function readMetricDisplaySettings(db: D1Database, ownerId: string, id: string) {
  const row = await db.prepare(`SELECT d.kr_item_id,d.mode,d.increment,d.revision,d.updated_at FROM items k
    LEFT JOIN kr_metric_display_settings d ON d.owner_id=k.owner_id AND d.kr_item_id=k.id
    WHERE k.owner_id=? AND k.id=? AND k.kind='key_result' AND k.archived_at IS NULL`)
    .bind(ownerId, id).first<Row>();
  if (!row) throw new PerformanceError("key_result_not_found", 404);
  return settings(row.kr_item_id ? row : null);
}

export async function saveMetricDisplaySettings(db: D1Database, actor: Actor, id: string, raw: unknown) {
  if (actor.role === "viewer" || actor.oauthScopes !== undefined && !actor.oauthScopes.split(/\s+/).includes("okri:write")) {
    throw new PerformanceError("write_access_required", 403);
  }
  const input = record(raw);
  const mode = choice(input.mode, METRIC_DISPLAY_MODES);
  const increment = input.increment;
  if (mode === "increment" && (typeof increment !== "number" || !Number.isFinite(increment) ||
      increment < 0.000001 || increment > 1e12 || Number(increment.toFixed(6)) !== increment)) {
    throw new PerformanceError("invalid_metric_display_increment");
  }
  const chosen = mode === "increment" ? increment as number : null;
  const expected = input.expectedRevision;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) {
    throw new PerformanceError("performance_revision_required");
  }
  const before = await readMetricDisplaySettings(db, actor.ownerId, id);
  if (before.mode === mode && before.increment === chosen &&
      (before.revision === expected || before.revision === expected + 1)) return before;
  if (before.revision !== expected) throw new PerformanceError("metric_display_revision_conflict", 409);

  const row = await db.prepare(`INSERT INTO kr_metric_display_settings(id,owner_id,kr_item_id,mode,increment,revision,updated_at)
    SELECT ?,?,?,?,?,?,? WHERE coalesce((SELECT revision FROM kr_metric_display_settings WHERE owner_id=? AND kr_item_id=?),0)=?
      AND EXISTS(SELECT 1 FROM items WHERE owner_id=? AND id=? AND kind='key_result' AND archived_at IS NULL)
    ON CONFLICT(kr_item_id) DO UPDATE SET mode=excluded.mode,increment=excluded.increment,
      revision=excluded.revision,updated_at=excluded.updated_at RETURNING ${columns}`)
    .bind(id, actor.ownerId, id, mode, chosen, expected + 1, new Date().toISOString(),
      actor.ownerId, id, expected, actor.ownerId, id).first<Row>();
  if (row) return settings(row);
  const current = await readMetricDisplaySettings(db, actor.ownerId, id);
  if (current.revision === expected + 1 && current.mode === mode && current.increment === chosen) return current;
  throw new PerformanceError("metric_display_revision_conflict", 409);
}
