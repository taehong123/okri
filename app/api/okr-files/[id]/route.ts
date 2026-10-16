import { authorizeRequest, ensureWorkspace, ItemDeletePermissionError } from "@/lib/pace-data";
import { getOkrFile, getOkrFileRead, OkrFileConflictError, updateOkrFile, type OkrFileSaveInput } from "@/lib/okr-files";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  const authorizedAt = Date.now();
  try {
    await ensureWorkspace(authorization.ownerId);
    const workspaceReadyAt = Date.now();
    const { id } = await context.params;
    const readMode = new URL(request.url).searchParams.get("mode") === "read";
    const file = readMode
      ? await getOkrFileRead(authorization.ownerId, id)
      : await getOkrFile(authorization.ownerId, authorization.userId, id);
    const loadedAt = Date.now();
    const etag = `"${file.revision}"`;
    const headers = {
      "Cache-Control": "private, no-cache, must-revalidate",
      ETag: etag,
      "Server-Timing": [
        `auth;dur=${authorizedAt - startedAt}`,
        `workspace;dur=${workspaceReadyAt - authorizedAt}`,
        `query;dur=${loadedAt - workspaceReadyAt}`,
      ].join(", "),
      Vary: "Cookie",
    };
    if (readMode && etagMatches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
    return Response.json({ file }, { headers });
  } catch (error) {
    return routeError(error);
  }
}

function etagMatches(requestValue: string | null, currentValue: string) {
  if (!requestValue) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//i, "");
  const current = normalize(currentValue);
  return requestValue.split(",").some((candidate) => candidate.trim() === "*" || normalize(candidate) === current);
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: false });
  if (authorization instanceof Response) return authorization;
  try {
    await ensureWorkspace(authorization.ownerId);
    const { id } = await context.params;
    const payload = await request.json() as OkrFileSaveInput;
    const file = await updateOkrFile(authorization.ownerId, authorization.userId, id, payload);
    return Response.json({ file });
  } catch (error) {
    return routeError(error);
  }
}

function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (error instanceof OkrFileConflictError) return Response.json({ error: message, file: error.file }, { status: 409 });
  if (error instanceof ItemDeletePermissionError || /cannot (move .* to trash|convert .* to a Routine)/i.test(message)) return Response.json({ error: message }, { status: 403 });
  const status = /required|invalid|unsupported|at most|before|belong|available|not found|split|resolution|target/i.test(message) ? 400 : 500;
  return Response.json({ error: message }, { status });
}
