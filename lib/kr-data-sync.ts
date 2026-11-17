export type KrDataSyncCadence = "hourly" | "daily" | "weekly" | "manual";

type ConnectionRow = {
  id: string;
  owner_id: string;
  kr_item_id: string;
  name: string;
  endpoint_url: string;
  value_path: string;
  baseline_value: number;
  target_value: number;
  unit: string;
  cadence: KrDataSyncCadence;
  active: number;
  last_value: number | null;
  last_sync_status: string;
  last_error: string;
  last_synced_at: string | null;
  next_sync_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

type DataTargetKind = "key_result" | "project";

export async function syncKrDataConnectionWithDb(d1: D1Database, ownerId: string, id: string) {
  const connection = await d1.prepare("SELECT * FROM kr_data_connections WHERE owner_id = ? AND id = ? LIMIT 1")
    .bind(ownerId, id).first<ConnectionRow>();
  if (!connection) throw new Error("Data connection not found");
  return syncConnection(d1, connection);
}

export async function syncDueKrDataConnectionsWithDb(d1: D1Database) {
  const now = new Date().toISOString();
  let due: ConnectionRow[];
  try {
    const result = await d1.prepare(`SELECT connection.* FROM kr_data_connections AS connection
      WHERE connection.active = 1 AND connection.next_sync_at IS NOT NULL AND connection.next_sync_at <= ?
        AND NOT EXISTS(SELECT 1 FROM kr_project_metrics m WHERE m.owner_id=connection.owner_id AND m.kr_item_id=connection.kr_item_id AND m.active=1)
        AND EXISTS (
          SELECT 1 FROM items AS target
          WHERE target.owner_id = connection.owner_id
            AND target.id = connection.kr_item_id
            AND target.kind IN ('key_result', 'project')
            AND target.archived_at IS NULL
        )
      ORDER BY next_sync_at ASC LIMIT 25`).bind(now).all<ConnectionRow>();
    due = result.results;
  } catch {
    return { attempted: 0, failed: 0 };
  }
  const results: PromiseSettledResult<unknown>[] = [];
  for (let index = 0; index < due.length; index += 5) {
    results.push(...await Promise.allSettled(due.slice(index, index + 5).map((connection) => syncConnection(d1, connection))));
  }
  return { attempted: due.length, failed: results.filter((result) => result.status === "rejected").length };
}

async function syncConnection(d1: D1Database, connection: ConnectionRow) {
  const now = new Date();
  const timestamp = now.toISOString();
  const nextSyncAt = connection.active && connection.cadence !== "manual" ? nextSync(connection.cadence, now) : null;
  try {
    const target = await d1.prepare(`SELECT id, kind FROM items
      WHERE owner_id = ? AND id = ? AND kind IN ('key_result', 'project') AND archived_at IS NULL LIMIT 1`)
      .bind(connection.owner_id, connection.kr_item_id).first<{ id: string; kind: DataTargetKind }>();
    if (!target) throw new Error("Data target not found");
    const projectSource=await d1.prepare("SELECT id FROM kr_project_metrics WHERE owner_id=? AND kr_item_id=? AND active=1").bind(connection.owner_id,connection.kr_item_id).first();
    if(projectSource)throw new Error("KR uses Project contributions");
    const payload = await fetchMetric(connection.endpoint_url);
    const value = numericValueAtPath(payload, connection.value_path);
    const progress = metricProgress(value, connection.baseline_value, connection.target_value);
    const guard=crypto.randomUUID();
    await d1.batch([
      d1.prepare(`INSERT INTO project_contribution_guards(id,valid) SELECT ?,CASE WHEN
        EXISTS(SELECT 1 FROM kr_data_connections WHERE owner_id=? AND id=? AND updated_at=?
          AND endpoint_url=? AND value_path=? AND baseline_value=? AND target_value=? AND unit=? AND cadence=? AND active=?)
        AND EXISTS(SELECT 1 FROM items WHERE owner_id=? AND id=? AND kind=? AND archived_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM kr_project_metrics WHERE owner_id=? AND kr_item_id=? AND active=1)
        THEN 1 ELSE 0 END`).bind(guard,connection.owner_id,connection.id,connection.updated_at,connection.endpoint_url,connection.value_path,connection.baseline_value,connection.target_value,connection.unit,connection.cadence,connection.active,connection.owner_id,target.id,target.kind,connection.owner_id,target.id),
      d1.prepare(`UPDATE kr_data_connections SET
        last_value = ?, last_sync_status = 'success', last_error = '', last_synced_at = ?, next_sync_at = ?, updated_at = ?
        WHERE owner_id = ? AND id = ?`).bind(value, timestamp, nextSyncAt, timestamp, connection.owner_id, connection.id),
      d1.prepare("UPDATE items SET progress = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND kind = ?")
        .bind(progress, timestamp, connection.owner_id, target.id, target.kind),
      d1.prepare(`INSERT INTO kr_metric_observations(id,owner_id,kr_item_id,source,event_kind,current_value,baseline_value,target_value,unit,observed_at)
        SELECT ?,?,?, 'api','synced',?,?,?,?,? WHERE ?='key_result'`).bind(crypto.randomUUID(),connection.owner_id,target.id,value,connection.baseline_value,connection.target_value,connection.unit,timestamp,target.kind),
      d1.prepare(`INSERT INTO activity_log (id, owner_id, item_id, action, source, payload, created_at)
        VALUES (?, ?, ?, 'data_synced', 'api', ?, ?)`)
        .bind(crypto.randomUUID(), connection.owner_id, target.id, JSON.stringify({ connectionId: connection.id, targetKind: target.kind, value, progress }), timestamp),
      d1.prepare("DELETE FROM project_contribution_guards WHERE id=?").bind(guard),
    ]);
    return { connection: serialize({ ...connection, last_value: value, last_sync_status: "success", last_error: "", last_synced_at: timestamp, next_sync_at: nextSyncAt, updated_at: timestamp }, target.kind), progress, value };
  } catch (error) {
    const message = errorMessage(error);
    await d1.prepare(`UPDATE kr_data_connections SET
      last_sync_status = 'error', last_error = ?, next_sync_at = ?, updated_at = ?
      WHERE owner_id = ? AND id = ? AND updated_at=? AND NOT EXISTS(SELECT 1 FROM kr_project_metrics m WHERE m.owner_id=kr_data_connections.owner_id AND m.kr_item_id=kr_data_connections.kr_item_id AND m.active=1)`).bind(message, nextSyncAt, timestamp, connection.owner_id, connection.id,connection.updated_at).run();
    throw new Error(message);
  }
}

function serialize(row: ConnectionRow, targetKind: DataTargetKind) {
  return {
    id: row.id,
    itemId: row.kr_item_id,
    targetKind,
    name: row.name,
    endpointUrl: row.endpoint_url,
    valuePath: row.value_path,
    baselineValue: row.baseline_value,
    targetValue: row.target_value,
    unit: row.unit,
    cadence: row.cadence,
    active: Boolean(row.active),
    lastValue: row.last_value,
    lastSyncStatus: row.last_sync_status,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
    nextSyncAt: row.next_sync_at,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeEndpoint(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("A valid API URL is required"); }
  if (url.protocol !== "https:") throw new Error("Data APIs must use HTTPS");
  if (url.username || url.password) throw new Error("API credentials cannot be embedded in the URL");
  const hostname = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) throw new Error("Private or local API addresses are not supported");
  url.hash = "";
  return url.toString();
}

function isPrivateHostname(hostname: string) {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

async function fetchMetric(endpointUrl: string) {
  let currentUrl = normalizeEndpoint(endpointUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(currentUrl, { method: "GET", headers: { Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("API redirected too many times");
      currentUrl = normalizeEndpoint(new URL(location, currentUrl).toString());
      continue;
    }
    if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 1_000_000) throw new Error("API response is larger than 1 MB");
    try { return JSON.parse(body) as unknown; } catch { throw new Error("API response is not valid JSON"); }
  }
  throw new Error("API request failed");
}

function numericValueAtPath(payload: unknown, valuePath: string) {
  const segments = valuePath.trim() ? valuePath.replace(/\[(\d+)\]/g, ".$1").split(".").map((segment) => segment.trim()).filter(Boolean) : [];
  let value: unknown = payload;
  for (const segment of segments) {
    if (["__proto__", "prototype", "constructor"].includes(segment) || typeof value !== "object" || value === null) throw new Error("The configured value path was not found");
    value = (value as Record<string, unknown>)[segment];
  }
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.replaceAll(",", "")) : Number.NaN;
  if (!Number.isFinite(numeric)) throw new Error("The configured value is not numeric");
  return numeric;
}

function metricProgress(current: number, baseline: number, target: number) {
  return Math.max(0, Math.min(100, Math.round(((current - baseline) / (target - baseline)) * 100)));
}

function nextSync(cadence: KrDataSyncCadence, from: Date) {
  const milliseconds = cadence === "hourly" ? 3_600_000 : cadence === "daily" ? 86_400_000 : 604_800_000;
  return new Date(from.getTime() + milliseconds).toISOString();
}

function errorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") return "API request timed out after 10 seconds";
  return error instanceof Error ? error.message.slice(0, 300) : "Data sync failed";
}
