import { authorizeRequest } from "@/lib/pace-data";
import { listNotifications, markNotificationsRead } from "@/lib/notifications";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  return Response.json(await listNotifications(
    authorization.ownerId,
    authorization.userId,
    request.headers.get("accept-language"),
  ), { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  try {
    const payload = await request.json() as { id?: string; all?: boolean };
    return Response.json(await markNotificationsRead(authorization.ownerId, authorization.userId, payload));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to update notifications" }, { status: 400 });
  }
}
