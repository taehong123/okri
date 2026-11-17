import { env } from "cloudflare:workers";
import { authorizeRequest, ensureWorkspace } from "@/lib/pace-data";
import { readProjectTaskGoal, saveProjectTaskGoal, TaskGoalError } from "@/lib/project-task-goals";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  try {
    await ensureWorkspace(authorization.ownerId);
    const projectId = new URL(request.url).searchParams.get("projectId")?.trim();
    if (!projectId) throw new TaskGoalError("invalid_goal", 400);
    return Response.json(await readProjectTaskGoal(env.DB, authorization.ownerId, projectId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    await ensureWorkspace(authorization.ownerId);
    const input = await request.json() as Record<string, unknown> | null;
    if (!input || typeof input.projectId !== "string" || !input.projectId.trim()) throw new TaskGoalError("invalid_goal", 400);
    return Response.json(await saveProjectTaskGoal(env.DB, authorization.ownerId, input.projectId.trim(), input), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  if (error instanceof TaskGoalError) return Response.json({ code: error.code }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ code: "invalid_goal" }, { status: 400 });
  return Response.json({ code: "goal_save_failed" }, { status: 500 });
}
