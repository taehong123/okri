import { env } from "cloudflare:workers";
import {
  ITEM_CADENCES,
  ITEM_KINDS,
  ITEM_PRIORITIES,
  ITEM_STATUSES,
  authorizeRequest,
  createItem,
  createLinkedTasks,
  ensureWorkspace,
  getItemAssignmentMap,
  getPeriodReview,
  listItems,
  replaceItemAssignmentRole,
  serializeItem,
  updateItem,
  type ItemCadence,
  type ItemKind,
  type ItemPriority,
  type ItemStatus,
  type RequestAuthorization,
} from "@/lib/pace-data";
import { BillingLimitError } from "@/lib/billing";
import { stageProjectReview } from "@/lib/project-review-service";
import { readWorkContext, reviewTaskGeneralPlacement } from "@/lib/work-intake";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;

  try {
    await ensureWorkspace(authorization.ownerId);
    const url = new URL(request.url);
    const cadence = asValue(url.searchParams.get("cadence"), ITEM_CADENCES);
    const requestedStatus = url.searchParams.get("status");
    if (requestedStatus && !asValue(requestedStatus, ITEM_STATUSES)) {
      return Response.json({ error: "unsupported status" }, { status: 400 });
    }
    if (url.searchParams.get("review") === "true" && cadence) {
      const review = await getPeriodReview(authorization.ownerId, cadence);
      const assignments = await getItemAssignmentMap(authorization.ownerId, review.items.map((item) => item.id));
      return Response.json({ review: { ...review, items: review.items.map((item) => serializeItem(item, {}, assignments[item.id] ?? [])) } });
    }

    const rows = await listItems(authorization.ownerId, {
      kind: asValue(url.searchParams.get("kind"), ITEM_KINDS),
      status: asValue(requestedStatus, ITEM_STATUSES),
      cadence,
      parentId: url.searchParams.get("parentId") ?? undefined,
      query: url.searchParams.get("q") ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });
    const assignments = await getItemAssignmentMap(authorization.ownerId, rows.map((item) => item.id));
    return Response.json({ items: rows.map((item) => serializeItem(item, {}, assignments[item.id] ?? [])) });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;

  try {
    await ensureWorkspace(authorization.ownerId);
    const payload = (await request.json()) as Record<string, unknown>;
    if (payload.titles !== undefined) {
      const titles = Array.isArray(payload.titles)
        ? payload.titles.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
        : [];
      if (!titles.length) return Response.json({ error: "titles are required" }, { status: 400 });
      if (payload.kind !== undefined && payload.kind !== "task") return Response.json({ error: "bulk creation only supports Task" }, { status: 400 });
      const parentId = asNullableString(payload.parentId);
      let routineId = asNullableString(payload.routineId);
      if (authorization.apiToken && payload.generalConfirmed === true && (parentId || routineId)) {
        return Response.json({ error: "Choose an exact Project/Ticket/Routine or General, not both" }, { status: 400 });
      }
      if (authorization.apiToken && !parentId && !routineId) {
        const reviewed = await inspectTokenTaskPlacement(authorization, titles.join("\n"), undefined, payload.generalConfirmed === true);
        if (reviewed.placement.status === "selection_required") return taskPlacementRequired(reviewed.placement);
        routineId = reviewed.context.fallback?.id ?? null;
      }
      const created = await createLinkedTasks(authorization.ownerId, {
        titles,
        parentId,
        routineId,
        assigneeMemberId: asMemberIds(payload.assigneeMemberId, 1)[0] ?? null,
        createdByUserId: authorization.userId,
      });
      const assignments = await getItemAssignmentMap(authorization.ownerId, created.map((item) => item.id));
      return Response.json({ items: created.map((item) => serializeItem(item, {}, assignments[item.id] ?? [])) }, { status: 201 });
    }
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    if (!title) return Response.json({ error: "title is required" }, { status: 400 });
    if (payload.status !== undefined && !asValue(payload.status, ITEM_STATUSES)) {
      return Response.json({ error: "unsupported status" }, { status: 400 });
    }
    if (authorization.apiToken && payload.generalConfirmed === true && payload.kind !== undefined && payload.kind !== "task") {
      return Response.json({ error: "Only Tasks can select General" }, { status: 400 });
    }

    if (authorization.apiToken && payload.kind === "project") {
      const review = await stageProjectReview(authorization, {
        title, description: payload.description, status: payload.status, priority: payload.priority,
        cadence: payload.cadence, progress: payload.progress, dueDate: payload.dueDate,
        driMemberId: payload.driMemberId, workerMemberIds: payload.workerMemberIds,
        properties: payload.properties, templateId: payload.templateId, requestedCycleId: payload.cycleId,
      }, asString(payload.parentId) ? [{ initiativeId: asString(payload.parentId), reason: "연결 도구가 제안한 후보입니다. 최종 내용을 보고 직접 확인해 주세요." }] : [], new URL(request.url).origin);
      return Response.json({ code: "project_confirmation_required", created: false, review }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }

    const kind = asValue(payload.kind, ITEM_KINDS) as ItemKind | undefined;
    const parentId = payload.parentId === undefined ? undefined : asNullableString(payload.parentId);
    let routineId = asNullableString(payload.routineId);
    if (authorization.apiToken && payload.generalConfirmed === true && (parentId || routineId)) {
      return Response.json({ error: "Choose an exact Project/Ticket/Routine or General, not both" }, { status: 400 });
    }
    if (authorization.apiToken && (kind ?? "task") === "task" && !parentId && !routineId) {
      const reviewed = await inspectTokenTaskPlacement(authorization, title, asString(payload.description), payload.generalConfirmed === true);
      if (reviewed.placement.status === "selection_required") return taskPlacementRequired(reviewed.placement);
      routineId = reviewed.context.fallback?.id ?? null;
    }

    const item = await createItem(authorization.ownerId, {
      title,
      description: asString(payload.description),
      kind,
      cycleId: payload.cycleId === undefined ? undefined : asNullableString(payload.cycleId),
      parentId,
      routineId,
      status: asValue(payload.status, ITEM_STATUSES) as ItemStatus | undefined,
      priority: asValue(payload.priority, ITEM_PRIORITIES) as ItemPriority | undefined,
      cadence: asValue(payload.cadence, ITEM_CADENCES) as ItemCadence | undefined,
      progress: typeof payload.progress === "number" ? payload.progress : undefined,
      dueDate: payload.dueDate === undefined ? undefined : asNullableString(payload.dueDate),
      source: asString(payload.source) || "web",
      sourceRef: asNullableString(payload.sourceRef),
      templateId: asNullableString(payload.templateId),
      createdByUserId: authorization.userId,
    });
    await saveAssignments(authorization.ownerId, item.id, item.kind as ItemKind, payload);
    const assignments = await getItemAssignmentMap(authorization.ownerId, [item.id]);
    return Response.json({ item: serializeItem(item, {}, assignments[item.id] ?? []) }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;

  try {
    await ensureWorkspace(authorization.ownerId);
    const payload = (await request.json()) as Record<string, unknown>;
    const id = asString(payload.id);
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    if (payload.status !== undefined && !asValue(payload.status, ITEM_STATUSES)) {
      return Response.json({ error: "unsupported status" }, { status: 400 });
    }

    const item = await updateItem(authorization.ownerId, id, {
      title: asOptionalString(payload.title),
      description: asOptionalString(payload.description),
      cycleId: payload.cycleId === undefined ? undefined : asNullableString(payload.cycleId),
      status: asValue(payload.status, ITEM_STATUSES),
      priority: asValue(payload.priority, ITEM_PRIORITIES),
      cadence: asValue(payload.cadence, ITEM_CADENCES),
      progress: typeof payload.progress === "number" ? payload.progress : undefined,
      dueDate: payload.dueDate === undefined ? undefined : asNullableString(payload.dueDate),
      parentId: payload.parentId === undefined ? undefined : asNullableString(payload.parentId),
      routineId: payload.routineId === undefined ? undefined : asNullableString(payload.routineId),
      source: asOptionalString(payload.source) || "web",
    });
    await saveAssignments(authorization.ownerId, item.id, item.kind as ItemKind, payload);
    const assignments = await getItemAssignmentMap(authorization.ownerId, [item.id]);
    return Response.json({ item: serializeItem(item, {}, assignments[item.id] ?? []) });
  } catch (error) {
    return routeError(error);
  }
}

async function inspectTokenTaskPlacement(authorization: RequestAuthorization, title: string, description: string | undefined, generalConfirmed: boolean) {
  const context = await readWorkContext(env.DB, authorization.ownerId, authorization.userId, {
    kind: "task", sourceText: `${title}\n${description ?? ""}`, includeMembers: false, limit: 20,
  });
  return { context, placement: reviewTaskGeneralPlacement(context, generalConfirmed) };
}

function taskPlacementRequired(placement: ReturnType<typeof reviewTaskGeneralPlacement>) {
  return Response.json({
    code: "task_placement_confirmation_required",
    created: false,
    placement,
    nextStep: "Choose one returned Project/Ticket/Routine, or explicitly choose General and retry with generalConfirmed=true.",
  }, { status: 409, headers: { "Cache-Control": "no-store" } });
}

async function saveAssignments(ownerId: string, itemId: string, kind: ItemKind, payload: Record<string, unknown>) {
  if (kind === "project") {
    if (payload.driMemberId !== undefined) {
      await replaceItemAssignmentRole(ownerId, itemId, "project_dri", asMemberIds(payload.driMemberId, 1));
    }
    if (payload.workerMemberIds !== undefined) {
      await replaceItemAssignmentRole(ownerId, itemId, "project_worker", asMemberIds(payload.workerMemberIds));
    }
  }
  if (kind === "task" && payload.assigneeMemberId !== undefined) {
    await replaceItemAssignmentRole(ownerId, itemId, "task_assignee", asMemberIds(payload.assigneeMemberId, 1));
  }
}

function asMemberIds(value: unknown, max?: number) {
  const values = Array.isArray(value) ? value : typeof value === "string" && value.trim() ? [value] : [];
  const ids = values.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim());
  if (max !== undefined && ids.length > max) throw new Error("Only one accountable member is allowed");
  return ids;
}

function asValue<T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === "string" && values.includes(value) ? (value as T[number]) : undefined;
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value: unknown) {
  return value === undefined ? undefined : asString(value);
}

function asNullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (error instanceof BillingLimitError) return Response.json({ error: message, code: error.code, ...error.details }, { status: 409 });
  const status = /required|requires|must be|cannot have|not found|only an|archive|restore|active workspace|assignment/i.test(
    message,
  )
    ? 400
    : 500;
  return Response.json({ error: message }, { status });
}
