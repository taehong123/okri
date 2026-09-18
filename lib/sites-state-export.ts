const encoder = new TextEncoder();
const PAGE_SIZE = 250;
const ALLOWED_ORIGIN = "https://chatgpt.com";

type ExportEnv = {
  DB: D1Database;
  WORKSPACE_AVATARS: R2Bucket;
  OKRI_MIGRATION_EXPORT_TOKEN?: string;
};

function corsHeaders(origin: string | null): HeadersInit {
  return origin === ALLOWED_ORIGIN ? {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "x-okri-migration-token, content-type",
    "Vary": "Origin",
  } : {};
}

function tokensMatch(actual: string | null, expected: string | undefined) {
  if (!actual || !expected) return false;
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length));
    for (const byte of chunk) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function exportValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { base64: bytesToBase64(value) };
  if (value instanceof ArrayBuffer) return { base64: bytesToBase64(new Uint8Array(value)) };
  return value;
}

function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

async function enqueueObjectData(controller: ReadableStreamDefaultController<Uint8Array>, object: R2ObjectBody, metadata: R2Object) {
  const prefix = JSON.stringify({
    type: "object",
    key: metadata.key,
    contentType: metadata.httpMetadata?.contentType ?? null,
    customMetadata: metadata.customMetadata ?? {},
    uploaded: metadata.uploaded,
    data: "",
  }).replace(/""}$/, '"');
  controller.enqueue(encoder.encode(prefix));

  const reader = object.body.getReader();
  let remainder = new Uint8Array(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const combined = new Uint8Array(remainder.length + value.length);
    combined.set(remainder);
    combined.set(value, remainder.length);
    const completeLength = combined.length - (combined.length % 3);
    if (completeLength) controller.enqueue(encoder.encode(bytesToBase64(combined.subarray(0, completeLength))));
    remainder = combined.slice(completeLength);
  }
  if (remainder.length) controller.enqueue(encoder.encode(bytesToBase64(remainder)));
  controller.enqueue(encoder.encode('"}\n'));
}

async function writeExport(controller: ReadableStreamDefaultController<Uint8Array>, env: ExportEnv) {
  const values = Object.fromEntries(Object.entries(env as object).filter(([key, value]) => key !== "OKRI_MIGRATION_EXPORT_TOKEN" && typeof value === "string"));
  controller.enqueue(encoder.encode(`${JSON.stringify({ type: "runtime", values })}\n`));

  const schema = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>();
  for (const { name } of schema.results) {
    let offset = 0;
    while (true) {
      const page = await env.DB.prepare(`SELECT * FROM ${quoteIdentifier(name)} LIMIT ? OFFSET ?`).bind(PAGE_SIZE, offset).all<Record<string, unknown>>();
      const rows = page.results.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, exportValue(value)])));
      if (rows.length) controller.enqueue(encoder.encode(`${JSON.stringify({ type: "table", name, rows })}\n`));
      if (rows.length < PAGE_SIZE) break;
      offset += rows.length;
    }
  }

  let cursor: string | undefined;
  do {
    const page = await env.WORKSPACE_AVATARS.list({ cursor, limit: 1000, include: ["httpMetadata", "customMetadata"] });
    for (const metadata of page.objects) {
      const object = await env.WORKSPACE_AVATARS.get(metadata.key);
      if (!object) throw new Error("export_failed");
      await enqueueObjectData(controller, object, metadata);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  controller.enqueue(encoder.encode(`${JSON.stringify({ type: "complete" })}\n`));
  controller.close();
}

export function exportOptions(request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== ALLOWED_ORIGIN) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(null, { status: 204, headers: { ...corsHeaders(origin), "Cache-Control": "no-store" } });
}

export function exportState(request: Request, env: ExportEnv) {
  const origin = request.headers.get("origin");
  if (!tokensMatch(request.headers.get("x-okri-migration-token"), env.OKRI_MIGRATION_EXPORT_TOKEN)) {
    return new Response(null, { status: 404, headers: { ...corsHeaders(origin), "Cache-Control": "no-store" } });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void writeExport(controller, env).catch(() => controller.error(new Error("State export failed")));
    },
  });
  return new Response(stream, {
    headers: { ...corsHeaders(origin), "Cache-Control": "no-store", "Content-Type": "application/x-ndjson" },
  });
}
