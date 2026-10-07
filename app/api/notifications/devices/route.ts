import { authorizeRequest } from "@/lib/pace-data";
import { disableNotificationDevice, registerNotificationDevice, type PushPlatform } from "@/lib/notifications";

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  try {
    const payload = await request.json() as Record<string, unknown>;
    if (payload.platform !== "android" && payload.platform !== "ios") throw new Error("Invalid push platform");
    if (typeof payload.token !== "string" || typeof payload.appId !== "string") throw new Error("Invalid push registration");
    return Response.json(await registerNotificationDevice({
      workspaceId: authorization.ownerId,
      userId: authorization.userId,
      token: payload.token,
      platform: payload.platform,
      appId: payload.appId,
      locale: typeof payload.locale === "string" ? payload.locale : "en",
      environment: payload.environment === "development" ? "development" : "production",
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to register this device";
    return Response.json({ error: message }, { status: /configured/.test(message) ? 503 : 400 });
  }
}

export async function DELETE(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  try {
    const payload = await request.json() as Record<string, unknown>;
    if ((payload.platform !== "android" && payload.platform !== "ios") || typeof payload.token !== "string" || typeof payload.appId !== "string") {
      throw new Error("Invalid push registration");
    }
    return Response.json(await disableNotificationDevice(
      authorization.userId,
      payload.token,
      payload.platform as PushPlatform,
      payload.appId,
    ));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to disable this device" }, { status: 400 });
  }
}
