import {
  authorizeRequest,
  ensureWorkspace,
  getWorkDocument,
  saveWorkDocument,
  type WorkDocumentTargetKind,
} from "@/lib/pace-data";

const targetKinds = new Set<WorkDocumentTargetKind>(["task", "routine"]);

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  try {
    await ensureWorkspace(authorization.ownerId);
    const url = new URL(request.url);
    const targetKind = readTargetKind(url.searchParams.get("targetKind"));
    const targetId = url.searchParams.get("targetId")?.trim() ?? "";
    if (!targetKind || !targetId) return Response.json({ error: "targetKind and targetId are required" }, { status: 400 });
    return Response.json({ document: await getWorkDocument(authorization.ownerId, targetKind, targetId) });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    await ensureWorkspace(authorization.ownerId);
    const payload = await request.json() as Record<string, unknown>;
    const targetKind = readTargetKind(payload.targetKind);
    const targetId = typeof payload.targetId === "string" ? payload.targetId.trim() : "";
    const content = typeof payload.content === "string" ? payload.content : "";
    const plainText = typeof payload.plainText === "string" ? payload.plainText : "";
    const expectedVersion = typeof payload.expectedVersion === "number" ? payload.expectedVersion : -1;
    if (!targetKind || !targetId || !content || expectedVersion < 0) {
      return Response.json({ error: "targetKind, targetId, content, and expectedVersion are required" }, { status: 400 });
    }
    const document = await saveWorkDocument(authorization.ownerId, targetKind, targetId, {
      content,
      plainText,
      expectedVersion,
      userId: authorization.userId,
    });
    return Response.json({ document });
  } catch (error) {
    return routeError(error);
  }
}

function readTargetKind(value: unknown): WorkDocumentTargetKind | null {
  return typeof value === "string" && targetKinds.has(value as WorkDocumentTargetKind)
    ? value as WorkDocumentTargetKind
    : null;
}

function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const status = /version conflict/i.test(message) ? 409 : /required|not found|restore|valid|large|block/i.test(message) ? 400 : 500;
  return Response.json({ error: message }, { status });
}
