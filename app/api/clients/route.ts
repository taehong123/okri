import { authorizeRequest } from "@/lib/pace-data";
import {
  ClientDirectoryError,
  createClient,
  deleteClient,
  listClients,
  updateClient,
  type ClientProductInput,
} from "@/lib/client-directory";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  const url = new URL(request.url);
  try {
    return Response.json({ clients: await listClients(authorization.ownerId, url.searchParams.get("q") ?? undefined) }, { headers });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const payload = await body(request);
    const client = await createClient(authorization.ownerId, authorization.userId, {
      name: text(payload.name),
      phone: text(payload.phone),
      email: text(payload.email),
      products: products(payload.products),
    });
    return Response.json({ client }, { status: 201, headers });
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const payload = await body(request);
    const id = text(payload.id);
    if (!id) throw new ClientDirectoryError("client_id_required", "클라이언트 ID가 필요합니다.");
    const client = await updateClient(authorization.ownerId, id, {
      ...(payload.name !== undefined ? { name: text(payload.name) } : {}),
      ...(payload.phone !== undefined ? { phone: text(payload.phone) } : {}),
      ...(payload.email !== undefined ? { email: text(payload.email) } : {}),
      ...(payload.products !== undefined ? { products: products(payload.products) } : {}),
    });
    return Response.json({ client }, { headers });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id) throw new ClientDirectoryError("client_id_required", "클라이언트 ID가 필요합니다.");
    return Response.json(await deleteClient(authorization.ownerId, id), { headers });
  } catch (error) {
    return routeError(error);
  }
}

async function body(request: Request) {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ClientDirectoryError("invalid_json", "요청 본문을 확인해 주세요.");
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function products(value: unknown): ClientProductInput[] {
  if (!Array.isArray(value)) throw new ClientDirectoryError("products_invalid", "제품 목록 형식을 확인해 주세요.");
  return value.map((entry) => {
    if (typeof entry === "string") return { name: entry };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ClientDirectoryError("product_invalid", "제품 형식을 확인해 주세요.");
    const product = entry as Record<string, unknown>;
    return { id: text(product.id) || undefined, name: text(product.name) };
  });
}

function routeError(error: unknown) {
  const resolved = error instanceof ClientDirectoryError
    ? error
    : new ClientDirectoryError("client_request_failed", "클라이언트 요청을 처리하지 못했습니다.", 500);
  return Response.json({ error: resolved.message, code: resolved.code }, { status: resolved.status, headers });
}
