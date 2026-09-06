import { env } from "cloudflare:workers";
import { authorizeRequest } from "@/lib/pace-data";
import { parseSearchRequest, searchWorkspace } from "@/lib/workspace-search";

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  let input;
  try { input = parseSearchRequest(new URL(request.url).searchParams); }
  catch { return Response.json({ error: "Invalid search filters", code: "invalid_search" }, { status: 400 }); }
  try {
    const result = await searchWorkspace(env.DB, authorization.ownerId, input);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Search unavailable", code: "search_unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
