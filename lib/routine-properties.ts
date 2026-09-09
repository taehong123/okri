export type RoutinePropertyValue = string | number | boolean | string[] | null;
type Row = { id: string; owner_id: string; name: string; type: string; options: string; default_value: string; active: number; sort_order: number; updated_at: string };
const types = ["text", "number", "select", "date", "checkbox", "member", "members"];
export const DEFAULT_ROUTINE_CLASSIFICATION = {
  name: "분류",
  options: ["운영", "고객지원(CS)", "품질관리(QA)", "재무", "인사(HR)"],
  defaultValue: "운영",
} as const;
const defaultRoutineClassificationMigration = "routine_default_classification_v1";
export class RoutinePropertyError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function defaultRoutineClassificationMigrationId(ownerId: string) {
  return `${defaultRoutineClassificationMigration}:${ownerId}`;
}

/**
 * Add the editable back-office classification once per workspace. An existing
 * user-created `분류` property wins, and the marker prevents later user edits,
 * removal or renaming from being overwritten by initialization.
 */
export async function ensureDefaultRoutineClassification(db: D1Database, ownerId: string) {
  const migrationId = defaultRoutineClassificationMigrationId(ownerId);
  if (await db.prepare("SELECT id FROM app_migrations WHERE id = ?").bind(migrationId).first()) return;

  const defaultId = `routine-classification-${ownerId}`;
  type Existing = { id: string };
  let existing = await db.prepare(`SELECT id FROM routine_property_definitions
    WHERE owner_id = ? AND (id = ? OR lower(name) = lower(?)) LIMIT 1`)
    .bind(ownerId, defaultId, DEFAULT_ROUTINE_CLASSIFICATION.name).first<Existing>();
  if (!existing) {
    const now = new Date().toISOString();
    await db.prepare(`INSERT OR IGNORE INTO routine_property_definitions
      (id,owner_id,name,type,options,default_value,active,sort_order,created_at,updated_at)
      VALUES (?,?,?,'select',?,?,1,
        COALESCE((SELECT MAX(sort_order) FROM routine_property_definitions WHERE owner_id = ?), 0) + 10,?,?)`)
      .bind(
        defaultId,
        ownerId,
        DEFAULT_ROUTINE_CLASSIFICATION.name,
        JSON.stringify(DEFAULT_ROUTINE_CLASSIFICATION.options),
        JSON.stringify(DEFAULT_ROUTINE_CLASSIFICATION.defaultValue),
        ownerId,
        now,
        now,
      ).run();
    existing = await db.prepare(`SELECT id FROM routine_property_definitions
      WHERE owner_id = ? AND (id = ? OR lower(name) = lower(?)) LIMIT 1`)
      .bind(ownerId, defaultId, DEFAULT_ROUTINE_CLASSIFICATION.name).first<Existing>();
  }
  if (!existing) throw new Error("Default Routine classification could not be initialized");

  const statements = existing.id === defaultId ? [
    db.prepare(`UPDATE routines
      SET properties_json = json_patch(properties_json, json_object(?, ?))
      WHERE owner_id = ? AND system_key IS NULL
        AND NOT EXISTS (SELECT 1 FROM json_each(routines.properties_json) WHERE key = ?)`)
      .bind(defaultId, DEFAULT_ROUTINE_CLASSIFICATION.defaultValue, ownerId, defaultId),
  ] : [];
  statements.push(
    db.prepare("INSERT OR IGNORE INTO app_migrations (id, applied_at) VALUES (?, CURRENT_TIMESTAMP)").bind(migrationId),
  );
  await db.batch(statements);
}

export function parseRoutineProperties(json: string | null | undefined): Record<string, RoutinePropertyValue> {
  try { const value = JSON.parse(json ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}

export function normalizeRoutineProperty(property: Pick<Row, "name" | "type" | "options">, value: unknown): RoutinePropertyValue {
  const fail = () => { throw new RoutinePropertyError(`'${property.name}' 속성 값을 확인해 주세요.`); };
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  if (property.type === "members") {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) return fail();
    return [...new Set(value as string[])];
  }
  if (property.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return fail();
    return value;
  }
  if (property.type === "checkbox") return typeof value === "boolean" ? value : fail();
  if (typeof value !== "string" || value.length > 4000) return fail();
  const result = value.trim();
  if (!result) return null;
  if (property.type === "select" && !(JSON.parse(property.options) as string[]).includes(result)) return fail();
  if (property.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result)) return fail();
  return result;
}

async function validateMembers(db: D1Database, ownerId: string, property: Pick<Row, "type">, value: RoutinePropertyValue) {
  if (!value || !["member", "members"].includes(property.type)) return;
  const ids = Array.isArray(value) ? value : [value];
  const found = await db.prepare("SELECT id FROM workspace_members WHERE workspace_id = ? AND status = 'active' AND id IN (SELECT value FROM json_each(?))")
    .bind(ownerId, JSON.stringify(ids)).all();
  if (found.results.length !== ids.length) throw new RoutinePropertyError("현재 워크스페이스의 활성 멤버를 선택해 주세요.");
}

async function rows(db: D1Database, ownerId: string) {
  return (await db.prepare("SELECT * FROM routine_property_definitions WHERE owner_id = ? ORDER BY sort_order, name").bind(ownerId).all<Row>()).results;
}
function serialize(row: Row, valueCount = 0) {
  return { id: row.id, name: row.name, type: row.type, options: JSON.parse(row.options) as string[], defaultValue: JSON.parse(row.default_value) as RoutinePropertyValue, active: Boolean(row.active), sortOrder: row.sort_order, systemKey: null, valueCount };
}
export async function listRoutineProperties(db: D1Database, ownerId: string, includeInactive = false) {
  const [definitions, counts] = await Promise.all([rows(db, ownerId), db.prepare(`SELECT j.key AS id, COUNT(*) AS count FROM routines r, json_each(r.properties_json) j
    WHERE r.owner_id = ? AND j.type != 'null' GROUP BY j.key`).bind(ownerId).all<{ id: string; count: number }>()]);
  const usage = new Map(counts.results.map((row) => [row.id, row.count]));
  return definitions.filter((row) => includeInactive || row.active).map((row) => serialize(row, usage.get(row.id) ?? 0));
}

/** Validate every supplied field before the routine is changed; unknown/removed fields never silently disappear. */
export async function prepareRoutineProperties(db: D1Database, ownerId: string, input: unknown, defaults = false) {
  if (input === undefined) input = {};
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 100) throw new RoutinePropertyError("루틴 속성 값을 확인해 주세요.");
  const definitions = (await rows(db, ownerId)).filter((row) => row.active);
  const byId = new Map(definitions.map((row) => [row.id, row]));
  const values: Record<string, unknown> = defaults ? Object.fromEntries(definitions.map((row) => [row.id, JSON.parse(row.default_value)])) : {};
  Object.assign(values, input);
  const result: Record<string, RoutinePropertyValue> = {};
  for (const [id, value] of Object.entries(values)) {
    const property = byId.get(id);
    if (!property) throw new RoutinePropertyError("삭제되었거나 사용할 수 없는 루틴 속성입니다. 목록을 다시 불러와 주세요.");
    const normalized = normalizeRoutineProperty(property, value);
    await validateMembers(db, ownerId, property, normalized);
    result[id] = normalized;
  }
  if (JSON.stringify(result).length > 64_000) throw new RoutinePropertyError("루틴 속성 값이 너무 큽니다.");
  return result;
}

export async function saveRoutineProperty(db: D1Database, ownerId: string, input: Record<string, unknown>, create = false) {
  const existing = await rows(db, ownerId);
  const current = create ? null : existing.find((row) => row.id === input.id);
  if (!create && !current) throw new RoutinePropertyError("루틴 속성을 찾을 수 없습니다.", 404);
  if (create && existing.length >= 100) throw new RoutinePropertyError("루틴 속성은 최대 100개까지 만들 수 있습니다.");
  const name = input.name === undefined ? current?.name ?? "" : typeof input.name === "string" ? input.name.trim() : "";
  const type = input.type === undefined ? current?.type ?? "text" : String(input.type);
  if (!name || name.length > 80 || !types.includes(type)) throw new RoutinePropertyError("속성 이름과 유형을 확인해 주세요.");
  if (existing.some((row) => row.id !== current?.id && row.name.toLowerCase() === name.toLowerCase())) throw new RoutinePropertyError("같은 이름의 루틴 속성이 있습니다.", 409);
  const options = input.options === undefined ? JSON.parse(current?.options ?? "[]") : input.options;
  if (!Array.isArray(options) || options.length > 100 || options.some((value) => typeof value !== "string" || !value.trim() || value.length > 200)) throw new RoutinePropertyError("선택 옵션을 확인해 주세요.");
  const property = { name, type, options: JSON.stringify([...new Set(options.map((value: string) => value.trim()))]) };
  const defaultValue = normalizeRoutineProperty(property, input.defaultValue === undefined ? JSON.parse(current?.default_value ?? "null") : input.defaultValue);
  await validateMembers(db, ownerId, property, defaultValue);
  if (input.active !== undefined && typeof input.active !== "boolean") throw new RoutinePropertyError("활성 상태를 확인해 주세요.");
  if (input.sortOrder !== undefined && !Number.isSafeInteger(input.sortOrder)) throw new RoutinePropertyError("속성 순서를 확인해 주세요.");
  if (input.preview === true) {
    let convertibleCount = 0, incompatibleCount = 0;
    const values = await db.prepare("SELECT properties_json FROM routines WHERE owner_id = ?").bind(ownerId).all<{ properties_json: string }>();
    for (const row of values.results) {
      const data = parseRoutineProperties(row.properties_json);
      if (!current || !Object.hasOwn(data, current.id)) continue;
      try { normalizeRoutineProperty(property, data[current.id]); convertibleCount++; } catch { incompatibleCount++; }
    }
    return { analysis: { valueCount: convertibleCount + incompatibleCount, convertibleCount, incompatibleCount } };
  }
  const id = current?.id ?? crypto.randomUUID(), now = new Date().toISOString();
  const active = input.active === undefined ? current?.active ?? 1 : input.active ? 1 : 0;
  const sortOrder = input.sortOrder ?? current?.sort_order ?? (existing.at(-1)?.sort_order ?? 0) + 10;
  if (current) {
    const saved = await db.prepare(`UPDATE routine_property_definitions SET name=?, type=?, options=?, default_value=?, active=?, sort_order=?, updated_at=?
      WHERE owner_id=? AND id=? AND updated_at=? RETURNING id`).bind(name, type, property.options, JSON.stringify(defaultValue), active, sortOrder, now, ownerId, id, current.updated_at).first();
    if (!saved) throw new RoutinePropertyError("다른 곳에서 변경된 속성입니다. 다시 불러와 주세요.", 409);
  } else {
    try { await db.prepare(`INSERT INTO routine_property_definitions (id,owner_id,name,type,options,default_value,active,sort_order,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, ownerId, name, type, property.options, JSON.stringify(defaultValue), active, sortOrder, now, now).run(); }
    catch (error) { if (/unique/i.test(String(error))) throw new RoutinePropertyError("같은 이름의 루틴 속성이 있습니다.", 409); throw error; }
  }
  return { property: (await listRoutineProperties(db, ownerId, true)).find((row) => row.id === id)! };
}
