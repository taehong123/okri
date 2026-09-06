import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { items, okrCycles, routines, routineCompletions, itemPropertyValues, projectHiddenProperties } from "@/db/schema";
import { getItem, getItemAssignmentMap, serializeItem, serializeRoutine } from "@/lib/pace-data";
import type { SearchKind } from "./workspace-search";

// Hydrate just the selected record's context. Search results may be outside the
// bootstrap's first 200 records, or changed externally since the last refresh.
export async function resolveSearchResult(ownerId: string, kind: SearchKind, id: string, date: string) {
  const db = getDb();
  const item = !["okr_file", "routine", "member"].includes(kind) ? await getItem(ownerId, id) : null;
  if (item && (item.kind !== kind || item.archivedAt || item.status === "archived")) return null;
  if (!item && !["okr_file", "routine"].includes(kind)) return null;
  const cycleId = kind === "okr_file" ? id : item?.cycleId;
  const [cycle] = cycleId ? await db.select().from(okrCycles).where(and(eq(okrCycles.ownerId, ownerId), eq(okrCycles.id, cycleId))) : [];
  if (kind === "okr_file" && !cycle) return null;
  const routineId = kind === "routine" ? id : item?.routineId;
  const [routine] = routineId ? await db.select().from(routines).where(and(eq(routines.ownerId, ownerId), eq(routines.id, routineId))) : [];
  if (kind === "routine" && (!routine || routine.systemKey)) return null;
  const [completion] = routine ? await db.select().from(routineCompletions).where(and(eq(routineCompletions.ownerId, ownerId), eq(routineCompletions.routineId, routine.id), eq(routineCompletions.completionDate, date))) : [];
  const context = new Map<string, NonNullable<typeof item>>();
  let ancestor = item;
  while (ancestor && !context.has(ancestor.id) && context.size < 6) {
    if (ancestor.archivedAt || ancestor.status === "archived") break;
    context.set(ancestor.id, ancestor);
    ancestor = ancestor.parentId ? await getItem(ownerId, ancestor.parentId) : null;
  }
  if (cycle) {
    const tree = await db.select().from(items).where(and(eq(items.ownerId, ownerId), eq(items.cycleId, cycle.id),
      inArray(items.kind, ["objective", "key_result", "initiative"]), isNull(items.archivedAt), ne(items.status, "archived")));
    tree.forEach((row) => context.set(row.id, row));
  }
  if (item?.kind === "project") {
    const tasks = await db.select().from(items).where(and(eq(items.ownerId, ownerId), eq(items.parentId, id), eq(items.kind, "task"), isNull(items.archivedAt), ne(items.status, "archived")));
    tasks.forEach((row) => context.set(row.id, row));
  }
  const rows = [...context.values()];
  const assignments = rows.length ? await getItemAssignmentMap(ownerId, rows.map((row) => row.id)) : {};
  const projectIds = rows.filter((row) => row.kind === "project").map((row) => row.id);
  const values = projectIds.length ? await db.select().from(itemPropertyValues).where(and(eq(itemPropertyValues.ownerId, ownerId), inArray(itemPropertyValues.itemId, projectIds))) : [];
  const hidden = projectIds.length ? await db.select().from(projectHiddenProperties).where(and(eq(projectHiddenProperties.ownerId, ownerId), inArray(projectHiddenProperties.projectId, projectIds))) : [];
  const propertyValues: Record<string, Record<string, unknown>> = Object.fromEntries(projectIds.map((projectId) => [projectId, {}]));
  for (const value of values) {
    try { propertyValues[value.itemId][value.propertyId] = JSON.parse(value.value); }
    catch { propertyValues[value.itemId][value.propertyId] = value.value; }
  }
  return {
    items: rows.map((row) => serializeItem(row, {}, assignments[row.id] ?? [])),
    cycles: cycle ? [cycle] : [],
    routines: routine ? [serializeRoutine(routine, date, completion)] : [],
    propertyValues,
    hiddenByProject: Object.fromEntries(projectIds.map((projectId) => [projectId, hidden.filter((row) => row.projectId === projectId).map((row) => row.propertyId)])),
  };
}
