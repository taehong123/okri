import { authorizeRequest } from "@/lib/pace-data";
import { getNotificationPreferences, saveNotificationPreferences } from "@/lib/notifications";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  return Response.json(await getNotificationPreferences(authorization.ownerId, authorization.userId), { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  try {
    const payload = await request.json() as Record<string, unknown>;
    return Response.json(await saveNotificationPreferences(authorization.ownerId, authorization.userId, {
      assignmentPush: typeof payload.assignmentPush === "boolean" ? payload.assignmentPush : undefined,
      morningBriefPush: typeof payload.morningBriefPush === "boolean" ? payload.morningBriefPush : undefined,
      digestHour: typeof payload.digestHour === "number" ? payload.digestHour : undefined,
      timezone: typeof payload.timezone === "string" ? payload.timezone : undefined,
    }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to save notification settings" }, { status: 400 });
  }
}
