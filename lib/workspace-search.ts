export const SEARCH_KINDS = ["okr_file", "objective", "key_result", "initiative", "project", "task", "routine", "member"] as const;
export type SearchKind = typeof SEARCH_KINDS[number];
export type SearchResult = {
  id: string;
  kind: SearchKind;
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  cycleId: string | null;
  cycleName: string | null;
  routineId: string | null;
  status: string;
  dueDate: string | null;
  assignee: string | null;
};
export type SearchFilters = { kind: string; assignee: string; status: string; due: string; cycle: string };
export const EMPTY_SEARCH_FILTERS: SearchFilters = { kind: "", assignee: "", status: "", due: "", cycle: "" };
export function searchRef(result: Pick<SearchResult, "kind" | "id">) { return `${result.kind}:${result.id}`; }

export type SearchRequest = { query: string; filters: SearchFilters; date: string; offset: number; refs: string[] };
export function parseSearchRequest(params: URLSearchParams): SearchRequest {
  const query = (params.get("q") ?? "").trim();
  const filters = Object.fromEntries(Object.keys(EMPTY_SEARCH_FILTERS).map((key) => [key, params.get(key) ?? ""])) as SearchFilters;
  const date = params.get("date") ?? new Date().toISOString().slice(0, 10);
  const offset = Number(params.get("offset") ?? 0);
  const refs = params.getAll("ref");
  if (query.length > 160 || (filters.kind && !SEARCH_KINDS.includes(filters.kind as SearchKind))
    || !["", "active", "completed", "blocked"].includes(filters.status)
    || !["", "today", "overdue", "none"].includes(filters.due)
    || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000
    || refs.length > 10 || refs.some((ref) => ref.length > 180 || !SEARCH_KINDS.some((kind) => ref.startsWith(`${kind}:`)))
    || filters.assignee.length > 128 || filters.cycle.length > 128) throw new Error("invalid_search");
  return { query, filters, date, offset, refs };
}

// Scope every source and join by the authenticated workspace. Never search a
// capped bootstrap array or expose an archived parent through result metadata.
export function buildSearchQuery(ownerId: string, input: SearchRequest) {
  const conditions = ["1 = 1"];
  const args: (string | number)[] = [ownerId];
  const escaped = input.query.replace(/[\\%_]/g, "\\$&");
  if (input.query) {
    conditions.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    args.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (input.filters.kind) { conditions.push("kind = ?"); args.push(input.filters.kind); }
  if (input.filters.assignee) {
    conditions.push(`((kind = 'routine' AND assigneeId = ?) OR (kind IN ('project','task') AND EXISTS (
      SELECT 1 FROM item_assignments a, scope s WHERE a.owner_id = s.ownerId AND a.item_id = records.id
        AND a.member_id = ? AND a.role IN ('project_dri','task_assignee'))))`);
    args.push(input.filters.assignee, input.filters.assignee);
  }
  if (input.filters.cycle) { conditions.push("cycleId = ?"); args.push(input.filters.cycle); }
  if (input.filters.status) {
    conditions.push(input.filters.status === "completed" ? "status IN ('done','development_done','closed')"
      : input.filters.status === "active" ? "status NOT IN ('done','development_done','closed','inactive')" : "status = 'blocked'");
  }
  if (input.filters.due) {
    conditions.push("kind IN ('project','task','objective','key_result','initiative','okr_file')");
    if (input.filters.due === "none") conditions.push("dueDate IS NULL");
    else { conditions.push(input.filters.due === "today" ? "substr(dueDate,1,10) = ?" : "substr(dueDate,1,10) < ? AND status NOT IN ('done','development_done','closed')"); args.push(input.date); }
  }
  if (input.refs.length) { conditions.push(`kind || ':' || id IN (${input.refs.map(() => "?").join(",")})`); args.push(...input.refs); }
  args.push(input.query, `${escaped}%`, 31, input.offset);
  return {
    sql: `WITH scope AS (SELECT ? AS ownerId), records AS (
      SELECT i.id, i.kind, i.title, i.description, i.parent_id AS parentId,
        COALESCE(p.title, CASE WHEN r.system_key IS NULL THEN r.title END) AS parentTitle,
        i.cycle_id AS cycleId, c.name AS cycleName, i.routine_id AS routineId, i.status, i.due_date AS dueDate,
        NULL AS assigneeId,
        (SELECT group_concat(m.display_name, ', ') FROM item_assignments a
          JOIN workspace_members m ON m.id = a.member_id AND m.workspace_id = s.ownerId AND m.status = 'active'
          WHERE a.owner_id = s.ownerId AND a.item_id = i.id AND a.role IN ('project_dri','task_assignee')) AS assignee,
        i.updated_at AS updatedAt
      FROM items i JOIN scope s ON i.owner_id = s.ownerId
      LEFT JOIN items p ON p.id = i.parent_id AND p.owner_id = s.ownerId AND p.archived_at IS NULL AND p.status != 'archived'
      LEFT JOIN routines r ON r.id = i.routine_id AND r.owner_id = s.ownerId AND r.active = 1
      LEFT JOIN okr_cycles c ON c.id = i.cycle_id AND c.owner_id = s.ownerId
      WHERE i.archived_at IS NULL AND i.status != 'archived'
      UNION ALL
      SELECT r.id, 'routine', r.title, r.description, NULL, NULL, NULL, NULL, NULL,
        CASE WHEN r.active = 1 THEN 'active' ELSE 'inactive' END, NULL, r.assignee_member_id, m.display_name, r.updated_at
      FROM routines r JOIN scope s ON r.owner_id = s.ownerId
      LEFT JOIN workspace_members m ON m.id = r.assignee_member_id AND m.workspace_id = s.ownerId AND m.status = 'active'
      WHERE r.system_key IS NULL
      UNION ALL
      SELECT c.id, 'okr_file', c.name, c.department, NULL, NULL, c.id, c.name, NULL, c.status, c.end_date, NULL, NULL, c.updated_at
      FROM okr_cycles c JOIN scope s ON c.owner_id = s.ownerId
      UNION ALL
      SELECT m.id, 'member', m.display_name, '', NULL, NULL, NULL, NULL, NULL, 'active', NULL, m.id, NULL, m.updated_at
      FROM workspace_members m JOIN scope s ON m.workspace_id = s.ownerId WHERE m.status = 'active'
    ) SELECT id, kind, title, parentId, parentTitle, cycleId, cycleName, routineId, status, dueDate, assignee
      FROM records WHERE ${conditions.join(" AND ")}
      ORDER BY CASE WHEN title = ? COLLATE NOCASE THEN 0 WHEN title LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
        CASE WHEN status IN ('done','development_done','closed','inactive') THEN 1 ELSE 0 END,
        updatedAt DESC, kind, id LIMIT ? OFFSET ?`,
    args,
  };
}

export async function searchWorkspace(db: D1Database, ownerId: string, input: SearchRequest) {
  const query = buildSearchQuery(ownerId, input);
  const { results } = await db.prepare(query.sql).bind(...query.args).all<SearchResult>();
  return { results: results.slice(0, 30), nextOffset: results.length > 30 ? input.offset + 30 : null };
}
