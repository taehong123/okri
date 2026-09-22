import type { RequestAuthorization } from "@/lib/pace-data";

export const CLIENT_SYNC_SCOPE = "okri:clients:write";
export const PERSONAL_MCP_READ_SCOPE = "okri:read";
export const PERSONAL_MCP_WRITE_SCOPE = "okri:read okri:write";
export const INTEGRATION_TOKEN_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
};

export function denyUnsafeTokenManagementRequest(request: Request, authorization: RequestAuthorization) {
  if (authorization.apiToken || request.headers.has("authorization")) {
    return integrationTokenResponse({ error: "브라우저 로그인 세션이 필요합니다.", code: "browser_session_required" }, 403);
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    return integrationTokenResponse({ error: "동일한 OKRI 화면에서 다시 시도해 주세요.", code: "invalid_origin" }, 403);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin !== new URL(request.url).origin) {
      return integrationTokenResponse({ error: "동일한 OKRI 화면에서 다시 시도해 주세요.", code: "invalid_origin" }, 403);
    }
  }
  return null;
}

export function integrationTokenName(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const name = value.normalize("NFC").trim();
  if (!name || name.length > 50 || [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return null;
  return name;
}

export function integrationTokenResponse(value: unknown, status = 200) {
  return Response.json(value, { status, headers: INTEGRATION_TOKEN_HEADERS });
}
