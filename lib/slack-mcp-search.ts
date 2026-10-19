import { workName } from "./slack-mcp-plan";

type SearchRow = { id: string; kind: string; title: string; description: string; cycleId: string | null; parentTitle: string | null; grandparentTitle: string | null; ancestorTitle: string | null };

export async function searchSlackWork(db: D1Database, ownerId: string, input: { query: string; kind?: string; limit?: number }) {
  const query = input.query.normalize("NFC").trim().slice(0, 120);
  if (workName(query).length < 2) throw new Error("Use a short distinctive subject of at least two characters.");
  const [items, routines] = await db.batch([
    db.prepare(`SELECT i.id, i.kind, i.title, substr(i.description,1,600) AS description, i.cycle_id AS cycleId,
      p.title AS parentTitle, g.title AS grandparentTitle, a.title AS ancestorTitle
      FROM items i LEFT JOIN items p ON p.id=i.parent_id AND p.owner_id=i.owner_id
      LEFT JOIN items g ON g.id=p.parent_id AND g.owner_id=i.owner_id
      LEFT JOIN items a ON a.id=g.parent_id AND a.owner_id=i.owner_id
      LEFT JOIN okr_cycles c ON c.id=i.cycle_id AND c.owner_id=i.owner_id
      WHERE i.owner_id=? AND i.kind IN ('project','initiative','ticket') AND i.archived_at IS NULL AND i.status!='archived'
        AND (c.status IS NULL OR c.status!='closed')
        AND (p.id IS NULL OR (p.archived_at IS NULL AND p.status!='archived'))
        AND (g.id IS NULL OR (g.archived_at IS NULL AND g.status!='archived'))
        AND (a.id IS NULL OR (a.archived_at IS NULL AND a.status!='archived'))
        AND (i.kind!='initiative' OR (p.kind='key_result' AND g.kind='objective'
          AND p.cycle_id IS i.cycle_id AND g.cycle_id IS i.cycle_id))
      ORDER BY i.id LIMIT 2001`).bind(ownerId),
    db.prepare(`SELECT id,'routine' AS kind,title,substr(description,1,600) AS description,NULL AS cycleId,
      NULL AS parentTitle,NULL AS grandparentTitle,NULL AS ancestorTitle FROM routines
      WHERE owner_id=? AND active=1 AND (system_key IS NULL OR system_key!='general') ORDER BY id LIMIT 2001`).bind(ownerId),
  ]);
  const rows = [...items.results.slice(0, 2000), ...routines.results.slice(0, 2000)] as SearchRow[];
  const terms = [...new Set([workName(query), ...query.split(/\s+/).map(workName).filter((term) => term.length >= 2)])];
  const ranked = rows.filter((row) => !input.kind || row.kind === input.kind).map((row) => {
    const title = workName(row.title), context = workName([row.description, row.parentTitle, row.grandparentTitle, row.ancestorTitle].filter(Boolean).join(" "));
    const exact = title === terms[0];
    let score = exact ? 1000 : title.includes(terms[0]) ? 700 : 0;
    for (const term of terms) {
      if (title.includes(term)) score += 120;
      else if (context.includes(term)) score += 35;
      if (term.length >= 3) {
        const grams = [...new Set(Array.from({ length: term.length - 2 }, (_, i) => term.slice(i, i + 3)))];
        const matched = grams.filter((gram) => title.includes(gram)).length;
        if (matched) score += 70 * matched / grams.length;
        if (editDistanceAtMostOne(term, title)) score += 180;
      }
    }
    return { ...row, path: [row.ancestorTitle, row.grandparentTitle, row.parentTitle, row.title].filter(Boolean),
      match: exact ? "exact" : "candidate", score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { query, items: ranked.slice(0, Math.max(1, Math.min(20, input.limit || 8))),
    truncated: items.results.length > 2000 || routines.results.length > 2000,
    instruction: "Candidates are evidence, not automatic placement. Compare each requested subject separately, descriptions and full hierarchy. Respect explicit exclusions and the latest user corrections. Search a shorter term if needed; no result in a truncated list does not prove absence. Existing Routine and Project are distinct: respect the explicitly requested kind." };
}

function editDistanceAtMostOne(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, changes = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++changes > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return changes + (i < a.length || j < b.length ? 1 : 0) <= 1;
}
