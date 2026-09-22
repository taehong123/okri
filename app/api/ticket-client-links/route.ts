import { authorizeRequest } from "@/lib/pace-data";
import { ClientDirectoryError, listTicketClientLinks, setTicketClientLink } from "@/lib/client-directory";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  try {
    const ticketId = new URL(request.url).searchParams.get("ticketId")?.trim() || undefined;
    return Response.json({ links: await listTicketClientLinks(authorization.ownerId, ticketId) }, { headers });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const payload = await request.json() as Record<string, unknown>;
    const ticketId = typeof payload.ticketId === "string" ? payload.ticketId.trim() : "";
    const clientId = typeof payload.clientId === "string" && payload.clientId.trim() ? payload.clientId.trim() : null;
    const productIds = Array.isArray(payload.productIds)
      ? payload.productIds.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim())
      : [];
    if (!ticketId) throw new ClientDirectoryError("ticket_id_required", "Ticket ID가 필요합니다.");
    const link = await setTicketClientLink(authorization.ownerId, ticketId, clientId, productIds);
    return Response.json({ link }, { headers });
  } catch (error) {
    return routeError(error);
  }
}

function routeError(error: unknown) {
  const resolved = error instanceof ClientDirectoryError
    ? error
    : new ClientDirectoryError("ticket_client_request_failed", "Ticket 고객 연결을 처리하지 못했습니다.", 500);
  return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status, headers });
}
