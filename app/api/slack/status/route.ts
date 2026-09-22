import { env } from "cloudflare:workers";
import { authorizeRequest, ensureWorkspace, getSlackConnection, serializeSlackConnection } from "@/lib/pace-data";
import { slackCanvasUserScopes, slackCommandUrl, slackConfigured, slackEventsUrl, slackInteractionUrl, slackRedirectUri, slackScopes, type SlackRuntimeEnv } from "@/lib/slack-oauth";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  await ensureWorkspace(authorization.ownerId);
  const runtime = env as SlackRuntimeEnv;
  const connection = await getSlackConnection(authorization.ownerId);
  const configured = slackConfigured(runtime);
  const grantedScopes = new Set((connection?.scope ?? "").split(/[ ,]/).map((scope) => scope.trim()).filter(Boolean));
  const grantedUserScopes = new Set((connection?.userScope ?? "").split(/[ ,]/).map((scope) => scope.trim()).filter(Boolean));
  const missingScopes = connection ? [
    ...slackScopes.filter((scope) => !grantedScopes.has(scope)),
    ...slackCanvasUserScopes.filter((scope) => !grantedUserScopes.has(scope)),
    ...(!connection.encryptedUserToken ? ["canvas_user_token"] : []),
  ] : [];
  const dailySettings = connection
    ? await env.DB.prepare("SELECT onboarding_completed_at FROM slack_daily_settings WHERE owner_id = ? LIMIT 1").bind(authorization.ownerId).first<{ onboarding_completed_at: string | null }>()
    : null;
  const state = !configured
    ? "service_unavailable"
    : !connection
      ? "workspace_disconnected"
      : missingScopes.length
        ? "reauthorization_required"
        : !dailySettings?.onboarding_completed_at
          ? "setup_required"
          : "connected";
  const statusMessage = state === "service_unavailable"
    ? "Slack 연결을 잠시 사용할 수 없습니다. 서비스 설정을 확인해 주세요."
    : state === "workspace_disconnected"
      ? "Owner 또는 Admin이 이 OKRI 워크스페이스에 사용할 Slack을 연결할 수 있습니다."
      : state === "reauthorization_required"
        ? "허들 메모 Canvas를 포함한 새 봇 기능에 필요한 Slack 권한을 다시 승인해 주세요."
        : state === "setup_required"
          ? "OKRI 연결이 완료되었습니다. 데일리 발송 설정을 완료해 주세요."
          : "OKRI 연결이 완료되었습니다.";
  return Response.json({
    slack: {
      ...serializeSlackConnection(connection, {
      redirectUrl: slackRedirectUri(runtime, request),
      commandUrl: slackCommandUrl(request),
      interactionUrl: slackInteractionUrl(request),
      eventsUrl: slackEventsUrl(request),
      }),
      state,
      statusMessage,
      missingScopes,
      connectionScope: "workspace",
      distributionMode: "direct_oauth",
      connectedTeam: connection ? { id: connection.teamId, name: connection.teamName } : null,
    },
  });
}
