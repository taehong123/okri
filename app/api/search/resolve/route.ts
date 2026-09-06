import { authorizeRequest } from "@/lib/pace-data";
import { SEARCH_KINDS, parseSearchRequest, type SearchKind } from "@/lib/workspace-search";
import { resolveSearchResult } from "@/lib/workspace-search-resolve";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") as SearchKind;
  const id = params.get("id") ?? "";
  let date: string;
  try { date = parseSearchRequest(params).date; }
  catch { return Response.json({ code: "invalid_search", error: "Invalid search" }, { status: 400 }); }
  if (!SEARCH_KINDS.includes(kind) || kind === "member" || !id || id.length > 128) return Response.json({ error: "Invalid search", code: "invalid_search" }, { status: 400 });
  try {
    const result = await resolveSearchResult(authorization.ownerId, kind, id, date);
    return Response.json(result ?? { error: "Item unavailable", code: "search_item_unavailable" }, { status: result ? 200 : 404, headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Item unavailable", code: "search_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
