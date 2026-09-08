import { acknowledgementsV1, readsV1, requestsV1, responsesV1 } from "./v1-contract";

type Handler = (request: Request) => Promise<Response>;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function mobileV1(endpoint: string, handler: Handler): Handler {
  return async request => {
    const key = request.method + " " + endpoint;
    const schema = requestsV1[key as keyof typeof requestsV1];
    const headers = { "Cache-Control": "no-store", "X-OKRI-API-Version": "1" };
    const error = (status: number, code: string) => Response.json({ error: code, code }, { status, headers });
    if (!schema && !readsV1.has(key)) return error(405, "method_not_allowed");
    // Native sessions use live membership/seat checks in the shared domain handler.
    // Never let cookies or general-purpose MCP tokens enter this client surface.
    if (!/^Bearer okri_native_[A-Za-z0-9_-]+$/.test(request.headers.get("authorization") || "")) return error(401, "native_session_required");
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => key !== "date")) return error(400, "unsupported_query");
    if (url.searchParams.has("date")) {
      const value = url.searchParams.get("date")!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) return error(400, "invalid_date");
    }
    let body: string | undefined;
    if (schema) {
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return error(415, "json_required");
      // Bounded read also handles missing/false Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return error(400, "invalid_request");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > 65536) { await reader.cancel(); return error(413, "request_too_large"); }
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const result = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        if (!result.success) return error(400, "invalid_request");
        body = JSON.stringify(result.data);
      } catch { return error(400, "invalid_request"); }
    }
    // Internal delegation only: never a fetch to a client-controlled URL.
    url.pathname = "/api/" + endpoint;
    const forwarded = new Headers(request.headers);
    forwarded.delete("cookie"); forwarded.delete("content-length");
    const response = await handler(new Request(url, { method: request.method, headers: forwarded, body }));
    const resultHeaders = new Headers(response.headers);
    resultHeaders.delete("set-cookie");
    for (const [name, value] of Object.entries(headers)) resultHeaders.set(name, value);
    if (!response.ok) return new Response(response.body, { status: response.status, headers: resultHeaders });
    if (response.status === 202) return new Response(response.body, { status: 202, headers: resultHeaders });
    // Do not turn an already-committed write into a retryable failure if a web
    // serializer changes. Return acknowledgement and let the client refresh.
    if (acknowledgementsV1.has(key)) return Response.json({ ok: true }, { headers: resultHeaders });
    const data = record(await response.json().catch(() => null));
    const user = record(data?.user), team = record(data?.team);
    if (key === "GET bootstrap" && typeof user?.id === "string" && Array.isArray(team?.members)) {
      // The web member serializer exposes isCurrent, not other people's user IDs.
      team.members = team.members.map((member: unknown) => ({
        ...record(member), userId: record(member)?.isCurrent === true ? user.id : null,
      }));
    }
    const parsed = responsesV1[key]?.safeParse(data);
    if (!parsed?.success) {
      console.error("mobile_v1_contract_mismatch", key);
      return error(request.method === "GET" ? 503 : 409, request.method === "GET" ? "mobile_contract_unavailable" : "write_result_unavailable");
    }
    return Response.json(parsed.data, { status: response.status, headers: resultHeaders });
  };
}
