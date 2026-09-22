import { env } from "cloudflare:workers";
import { authorizeRequest, canManageTeam, deleteSlackConnection, ensureWorkspace, getSlackConnection } from "@/lib/pace-data";
import { decryptSlackSecret, revokeSlackToken, slackConfigured, type SlackRuntimeEnv } from "@/lib/slack-oauth";
import { disconnectSlackDaily } from "@/lib/slack-daily";

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  if (!canManageTeam(authorization)) return Response.json({ error: "Workspace admin access is required" }, { status: 403 });
  await ensureWorkspace(authorization.ownerId);

  const runtime = env as SlackRuntimeEnv;
  const connection = await getSlackConnection(authorization.ownerId);
  if (connection && slackConfigured(runtime)) {
    try {
      await disconnectSlackDaily(authorization.ownerId, connection);
      await deleteSlackConnection(authorization.ownerId, connection.id);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Slack 예약을 정리하지 못했습니다. 다시 시도해 주세요." }, { status: 409 });
    }
    try {
      const token = await decryptSlackSecret(connection.encryptedBotToken, runtime.SLACK_TOKEN_ENCRYPTION_KEY!);
      await revokeSlackToken(token);
    } catch {
      // Reservations are already canceled; token revocation can be best effort.
    }
    if (connection.encryptedUserToken) {
      try {
        const token = await decryptSlackSecret(connection.encryptedUserToken, runtime.SLACK_TOKEN_ENCRYPTION_KEY!);
        await revokeSlackToken(token);
      } catch {
        // The delegated Canvas token is also revoked on a best-effort basis.
      }
    }
  } else if (connection) return Response.json({ error: "Slack 서비스 설정을 확인한 뒤 연결 해제를 다시 시도해 주세요." }, { status: 503 });

  return Response.json({ disconnected: true });
}
