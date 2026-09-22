import {
  authorizeRequest,
  canManageTeam,
  createIntegrationToken,
  listIntegrationTokensByScopes,
  revokeIntegrationTokenByScopes,
} from "@/lib/pace-data";
import {
  CLIENT_SYNC_SCOPE,
  denyUnsafeTokenManagementRequest,
  integrationTokenName,
  integrationTokenResponse,
} from "@/lib/integration-token-security";

async function authorize(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  const denied = denyUnsafeTokenManagementRequest(request, authorization);
  if (denied) return denied;
  if (!canManageTeam(authorization)) {
    return integrationTokenResponse({ error: "고객 동기화 키는 Owner 또는 Admin만 관리할 수 있습니다.", code: "admin_required" }, 403);
  }
  return authorization;
}

export async function GET(request: Request) {
  const authorization = await authorize(request);
  if (authorization instanceof Response) return authorization;
  return integrationTokenResponse({ keys: await listIntegrationTokensByScopes(authorization, [CLIENT_SYNC_SCOPE]) });
}

export async function POST(request: Request) {
  const authorization = await authorize(request);
  if (authorization instanceof Response) return authorization;
  const payload = await request.json().catch(() => null) as { name?: unknown } | null;
  const name = integrationTokenName(payload?.name, "고객 동기화");
  if (!name) return integrationTokenResponse({ error: "키 이름은 1~50자로 입력해 주세요.", code: "invalid_name" }, 400);
  const created = await createIntegrationToken(authorization, name, "other", CLIENT_SYNC_SCOPE, true);
  return integrationTokenResponse(created, 201);
}

export async function DELETE(request: Request) {
  const authorization = await authorize(request);
  if (authorization instanceof Response) return authorization;
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return integrationTokenResponse({ error: "폐기할 키를 선택해 주세요.", code: "id_required" }, 400);
  const result = await revokeIntegrationTokenByScopes(authorization, id, [CLIENT_SYNC_SCOPE]);
  if (!result.revoked) return integrationTokenResponse({ error: "현재 워크스페이스에서 해당 키를 찾을 수 없습니다.", code: "key_not_found" }, 404);
  return integrationTokenResponse(result);
}
