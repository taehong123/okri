import { authorizeRequest } from "@/lib/pace-data";
async function retired(request: Request) {
  const auth = await authorizeRequest(request, request.method === "GET" ? { allowViewerWrite: true } : undefined);
  if (auth instanceof Response) return auth;
  return Response.json({ code: "task_count_mode_retired" }, { status: 410, headers: { "Cache-Control": "private, no-store" } });
}
export const GET = retired;
export const PUT = retired;
