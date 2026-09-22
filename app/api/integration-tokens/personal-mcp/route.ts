import {
  authorizeRequest,
  createIntegrationToken,
  listIntegrationTokensByScopes,
  revokeIntegrationTokenByScopes,
} from "@/lib/pace-data";
import {
  PERSONAL_MCP_READ_SCOPE,
  PERSONAL_MCP_WRITE_SCOPE,
  denyUnsafeTokenManagementRequest,
  integrationTokenName,
  integrationTokenResponse,
} from "@/lib/integration-token-security";

const PERSONAL_MCP_SCOPES = [PERSONAL_MCP_READ_SCOPE, PERSONAL_MCP_WRITE_SCOPE];

async function authorize(request: Request, allowViewerWrite = true) {
  const authorization = await authorizeRequest(request, { allowViewerWrite });
  if (authorization instanceof Response) return authorization;
  return denyUnsafeTokenManagementRequest(request, authorization) ?? authorization;
}

export async function GET(request: Request) {
  const authorization = await authorize(request);
  if (authorization instanceof Response) return authorization;
  const rows = await listIntegrationTokensByScopes(authorization, PERSONAL_MCP_SCOPES);
  return integrationTokenResponse({
    keys: rows.map((row) => ({ ...row, access: row.scopes === PERSONAL_MCP_WRITE_SCOPE ? "read_write" : "read" })),
  });
}

export async function POST(request: Request) {
  const payload = await request.clone().json().catch(() => null) as { name?: unknown; access?: unknown } | null;
  const access = payload?.access === "read" ? "read" : payload?.access === "read_write" ? "read_write" : null;
  if (!access) return integrationTokenResponse({ error: "키 권한을 선택해 주세요.", code: "invalid_access" }, 400);
  const authorization = await authorize(request, access === "read");
  if (authorization instanceof Response) return authorization;
  if (access === "read_write" && authorization.role === "viewer") {
    return integrationTokenResponse({ error: "Viewer는 조회 전용 MCP 키만 만들 수 있습니다.", code: "viewer_read_only" }, 403);
  }
  const name = integrationTokenName(payload?.name, "개인 MCP");
  if (!name) return integrationTokenResponse({ error: "키 이름은 1~50자로 입력해 주세요.", code: "invalid_name" }, 400);
  const scopes = access === "read_write" ? PERSONAL_MCP_WRITE_SCOPE : PERSONAL_MCP_READ_SCOPE;
  const created = await createIntegrationToken(authorization, name, "other", scopes, true);
  return integrationTokenResponse({ ...created, access }, 201);
}

export async function DELETE(request: Request) {
  const authorization = await authorize(request);
  if (authorization instanceof Response) return authorization;
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return integrationTokenResponse({ error: "폐기할 키를 선택해 주세요.", code: "id_required" }, 400);
  const result = await revokeIntegrationTokenByScopes(authorization, id, PERSONAL_MCP_SCOPES);
  if (!result.revoked) return integrationTokenResponse({ error: "현재 사용자와 워크스페이스에서 해당 키를 찾을 수 없습니다.", code: "key_not_found" }, 404);
  return integrationTokenResponse(result);
}
