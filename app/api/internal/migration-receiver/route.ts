import { createHash, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const TRANSFER_HEADER = "x-okri-migration-receiver";
const MAX_TRANSFER_BYTES = 900 * 1024 * 1024;

export async function POST(request: Request) {
  if (new URL(request.url).searchParams.get("setup") === "1") return setup(request);
  if (!await hasTransferToken(request.headers.get(TRANSFER_HEADER))) return missing(request);
  if (!request.body) return Response.json({ code: "migration_body_required" }, { status: 400, headers: headersFor(request) });
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TRANSFER_BYTES) {
    return Response.json({ code: "migration_payload_too_large" }, { status: 413, headers: headersFor(request) });
  }

  const outputPath = resolve(process.env.OKRI_DATA_PATH?.trim() || "/var/lib/okri", "migration-transfer.ndjson");
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.partial`;
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o750 });
  let byteCount = 0;
  const hash = createHash("sha256");
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteCount += chunk.length;
      if (byteCount > MAX_TRANSFER_BYTES) return callback(new Error("migration_payload_too_large"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(request.body as never),
      limiter,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    await rename(temporaryPath, outputPath);
    await rm(tokenPath(), { force: true });
    return Response.json({ accepted: true, bytes: byteCount, sha256: hash.digest("hex") }, { status: 201, headers: headersFor(request) });
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    const code = error instanceof Error && error.message === "migration_payload_too_large" ? "migration_payload_too_large" : "migration_transfer_failed";
    return Response.json({ code }, { status: code === "migration_payload_too_large" ? 413 : 500, headers: headersFor(request) });
  }
}

export function GET(request: Request) { return missing(request); }
export function OPTIONS(request: Request) { return new Response(null, { status: 204, headers: headersFor(request) }); }

const privateHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

async function setup(request: Request) {
  if (request.headers.get("origin") !== "https://chatgpt.com") return missing(request);
  const supplied = request.headers.get(TRANSFER_HEADER);
  if (!supplied || supplied.length < 48 || supplied.length > 256) return missing(request);
  const path = tokenPath();
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o750 });
    await writeFile(path, digest(supplied), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return Response.json({ ready: true }, { status: 201, headers: headersFor(request) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return Response.json({ code: "migration_receiver_already_armed" }, { status: 409, headers: headersFor(request) });
    return Response.json({ code: "migration_receiver_setup_failed" }, { status: 500, headers: headersFor(request) });
  }
}

function missing(request: Request) {
  // Do not advertise a short-lived production transfer endpoint.
  return Response.json({ code: "not_found" }, { status: 404, headers: headersFor(request) });
}

async function hasTransferToken(value: string | null) {
  if (!value) return false;
  const supplied = Buffer.from(digest(value));
  const expected = Buffer.from(await readFile(tokenPath(), "utf8").catch(() => ""));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function tokenPath() { return resolve(process.env.OKRI_DATA_PATH?.trim() || "/var/lib/okri", "migration-receiver-token.sha256"); }
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }

function headersFor(request: Request) {
  const headers = new Headers(privateHeaders);
  if (request.headers.get("origin") === "https://chatgpt.com") {
    headers.set("Access-Control-Allow-Origin", "https://chatgpt.com");
    headers.set("Access-Control-Allow-Headers", `content-type, ${TRANSFER_HEADER}`);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Vary", "Origin");
  }
  return headers;
}
