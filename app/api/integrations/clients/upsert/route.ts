import { authorizeRequest } from "@/lib/pace-data";
import {
  ClientDirectoryError,
  reserveClientIntegrationRequest,
  upsertClientsFromIntegration,
  type ExternalClientInput,
} from "@/lib/client-directory";

const MAX_BODY_BYTES = 1_048_576;
const SECURITY_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
};
const BULK_FIELDS = new Set(["clients", "replace_products", "replaceProducts", "source_name", "sourceName", "source_url", "sourceUrl"]);
const SINGLE_FIELDS = new Set([
  "external_customer_id", "externalCustomerId", "name", "phone", "email", "products",
  "replace_products", "replaceProducts", "source_name", "sourceName", "source_url", "sourceUrl",
]);
const CLIENT_FIELDS = new Set(["external_customer_id", "externalCustomerId", "name", "phone", "email", "products"]);
const PRODUCT_FIELDS = new Set(["external_product_id", "externalProductId", "name"]);

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return secureResponse(authorization);
  if (!authorization.integrationTokenId) {
    return json({ error: "워크스페이스 integration token이 필요합니다.", code: "integration_token_required" }, 403);
  }
  try {
    requireJson(request);
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new ClientDirectoryError("payload_too_large", "요청 본문이 너무 큽니다.", 413);
    await reserveClientIntegrationRequest(authorization.ownerId, await requestFingerprint(request));
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 128 || hasControlCharacters(idempotencyKey)) {
      throw new ClientDirectoryError("idempotency_key_invalid", "1~128자의 Idempotency-Key 헤더가 필요합니다.");
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new ClientDirectoryError("payload_too_large", "요청 본문이 너무 큽니다.", 413);
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new ClientDirectoryError("json_invalid", "JSON 요청 본문을 확인해 주세요."); }
    const payload = object(value, "payload_invalid");
    const bulk = Object.hasOwn(payload, "clients");
    rejectUnknown(payload, bulk ? BULK_FIELDS : SINGLE_FIELDS);
    const rawClients = bulk ? payload.clients : [payload];
    if (!Array.isArray(rawClients)) throw new ClientDirectoryError("clients_invalid", "clients는 배열이어야 합니다.");
    const replaceProducts = readBooleanAlias(payload, "replace_products", "replaceProducts", true);
    const sourceName = readStringAlias(payload, "source_name", "sourceName", true);
    const sourceUrl = readStringAlias(payload, "source_url", "sourceUrl", false);
    const clients = rawClients.map((entry) => parseClient(entry, !bulk));
    const result = await upsertClientsFromIntegration(
      authorization.ownerId,
      authorization.userId,
      clients,
      idempotencyKey,
      replaceProducts,
      { name: sourceName, url: sourceUrl || null },
    );
    return json(result, result.replayed ? 200 : 201);
  } catch (error) {
    const resolved = error instanceof ClientDirectoryError
      ? error
      : new ClientDirectoryError("client_upsert_failed", "클라이언트 upsert를 처리하지 못했습니다.", 500);
    return json({ error: resolved.message, code: resolved.code }, resolved.status, resolved.status === 429 ? { "Retry-After": "60" } : undefined);
  }
}

function parseClient(value: unknown, includesEnvelopeFields = false): ExternalClientInput {
  const row = object(value, "client_invalid");
  rejectUnknown(row, includesEnvelopeFields ? SINGLE_FIELDS : CLIENT_FIELDS);
  const rawProducts = row.products === undefined ? [] : row.products;
  if (!Array.isArray(rawProducts)) throw new ClientDirectoryError("products_invalid", "products는 배열이어야 합니다.");
  return {
    externalCustomerId: readStringAlias(row, "external_customer_id", "externalCustomerId", true),
    name: readString(row, "name", true),
    phone: readString(row, "phone", false),
    email: readString(row, "email", false),
    products: rawProducts.map((product) => {
      if (typeof product === "string") return { name: product };
      const entry = object(product, "product_invalid");
      rejectUnknown(entry, PRODUCT_FIELDS);
      return {
        externalProductId: readStringAlias(entry, "external_product_id", "externalProductId", false) || null,
        name: readString(entry, "name", true),
      };
    }),
  };
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClientDirectoryError(code, "요청 형식을 확인해 주세요.");
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ClientDirectoryError("unknown_field", "지원하지 않는 요청 필드가 있습니다.");
}

function readString(value: Record<string, unknown>, key: string, required: boolean) {
  const entry = value[key];
  if (entry === undefined && !required) return "";
  if (typeof entry !== "string" || (required && !entry.trim())) throw new ClientDirectoryError(`${key}_invalid`, "문자열 입력값을 확인해 주세요.");
  return entry;
}

function readStringAlias(value: Record<string, unknown>, snake: string, camel: string, required: boolean) {
  if (Object.hasOwn(value, snake) && Object.hasOwn(value, camel)) throw new ClientDirectoryError("ambiguous_field", "같은 필드의 두 표기법을 함께 사용할 수 없습니다.");
  const key = Object.hasOwn(value, snake) ? snake : camel;
  return readString(value, key, required);
}

function readBooleanAlias(value: Record<string, unknown>, snake: string, camel: string, fallback: boolean) {
  if (Object.hasOwn(value, snake) && Object.hasOwn(value, camel)) throw new ClientDirectoryError("ambiguous_field", "같은 필드의 두 표기법을 함께 사용할 수 없습니다.");
  const entry = Object.hasOwn(value, snake) ? value[snake] : value[camel];
  if (entry === undefined) return fallback;
  if (typeof entry !== "boolean") throw new ClientDirectoryError("replace_products_invalid", "replace_products는 boolean이어야 합니다.");
  return entry;
}

function requireJson(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new ClientDirectoryError("content_type_invalid", "Content-Type은 application/json이어야 합니다.", 415);
}

function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

async function requestFingerprint(request: Request) {
  const address = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function json(value: unknown, status: number, extra?: Record<string, string>) {
  return Response.json(value, { status, headers: { ...SECURITY_HEADERS, ...extra } });
}

function secureResponse(response: Response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  headers.delete("Access-Control-Allow-Origin");
  headers.delete("Access-Control-Allow-Credentials");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
