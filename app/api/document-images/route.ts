import { env } from "cloudflare:workers";
import { BillingLimitError, recordDocumentImageUsage, releaseStorageUpload, reserveStorageUpload } from "@/lib/billing";
import { authorizeRequest } from "@/lib/pace-data";
import { verifiedImageType } from "@/lib/project-images";
import { DOCUMENT_IMAGE_MAX_BYTES, documentImageUrl, readDocumentImageTarget, safeDocumentImageName, type DocumentImageTarget } from "@/lib/document-images";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request);
  if (authorization instanceof Response) return authorization;
  try {
    const query = new URL(request.url).searchParams;
    const target = readDocumentImageTarget(query);
    if (!target) return failure(400, "invalid_target");
    if (!await canAccessTarget(authorization.ownerId, target)) return failure(404, "not_found");
    if (Number(request.headers.get("content-length")) > DOCUMENT_IMAGE_MAX_BYTES) return failure(413, "image_too_large");
    const reader = request.body?.getReader();
    if (!reader) return failure(400, "invalid_image");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > DOCUMENT_IMAGE_MAX_BYTES) { await reader.cancel(); return failure(413, "image_too_large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const mimeType = verifiedImageType(bytes);
    if (!mimeType || mimeType !== request.headers.get("content-type")?.split(";")[0].trim()) return failure(400, "invalid_image");
    const bucket = (env as typeof env & { WORKSPACE_AVATARS?: R2Bucket }).WORKSPACE_AVATARS;
    if (!bucket) return failure(503, "storage_unavailable");
    const imageId = crypto.randomUUID();
    const name = safeDocumentImageName(query.get("name") ?? "image");
    const key = objectKey(authorization.ownerId, target, imageId);
    const reservation = await reserveStorageUpload(authorization.ownerId, size);
    try {
      await bucket.put(key, bytes, { httpMetadata: { contentType: mimeType }, customMetadata: {
        ownerId: authorization.ownerId, ...target, name, createdBy: authorization.userId ?? "", byteSize: String(size),
      } });
      // Do not attach to an item archived/deleted while the upload was in flight.
      if (!await canAccessTarget(authorization.ownerId, target)) { await bucket.delete(key); return failure(404, "not_found"); }
      await recordDocumentImageUsage({ id: imageId, workspaceId: authorization.ownerId, ...target, byteSize: size,
        objectKey: key, createdByUserId: authorization.userId });
    } catch (error) {
      await bucket.delete(key).catch(() => undefined);
      throw error;
    } finally { await releaseStorageUpload(reservation).catch(() => undefined); }
    return Response.json({ url: documentImageUrl(target, imageId), name }, { status: 201, headers: privateHeaders });
  } catch (error) {
    if (error instanceof BillingLimitError && error.code === "storage_quota_exceeded") return failure(402, error.code);
    return failure(500, "upload_failed");
  }
}

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, { allowViewerWrite: true });
  if (authorization instanceof Response) return authorization;
  try {
    const query = new URL(request.url).searchParams;
    const target = readDocumentImageTarget(query);
    const imageId = query.get("imageId") ?? "";
    if (!target || !/^[a-f0-9-]{36}$/i.test(imageId)) return failure(404, "not_found");
    if (!await canAccessTarget(authorization.ownerId, target)) return failure(404, "not_found");
    const bucket = (env as typeof env & { WORKSPACE_AVATARS?: R2Bucket }).WORKSPACE_AVATARS;
    if (!bucket) return failure(503, "storage_unavailable");
    const image = await bucket.get(objectKey(authorization.ownerId, target, imageId));
    if (!image || image.size > DOCUMENT_IMAGE_MAX_BYTES) return failure(404, "not_found");
    const metadata = image.customMetadata;
    if (metadata?.ownerId !== authorization.ownerId || metadata.targetId !== target.targetId || metadata.targetKind !== target.targetKind) return failure(404, "not_found");
    const bytes = new Uint8Array(await image.arrayBuffer());
    const mimeType = verifiedImageType(bytes);
    if (!mimeType || mimeType !== image.httpMetadata?.contentType) return failure(404, "not_found");
    await recordDocumentImageUsage({ id: imageId, workspaceId: authorization.ownerId, ...target, byteSize: image.size,
      objectKey: objectKey(authorization.ownerId, target, imageId), createdByUserId: metadata.createdBy }).catch(() => undefined);
    return new Response(bytes, { headers: { ...privateHeaders, "Content-Type": mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(safeDocumentImageName(metadata.name ?? "image"))}` } });
  } catch { return failure(500, "image_unavailable"); }
}

async function canAccessTarget(ownerId: string, target: DocumentImageTarget) {
  const statement = target.targetKind === "routine"
    ? env.DB.prepare("SELECT id FROM routines WHERE owner_id = ? AND id = ? AND system_key IS NULL").bind(ownerId, target.targetId)
    : env.DB.prepare("SELECT id FROM items WHERE owner_id = ? AND id = ? AND kind = ? AND archived_at IS NULL").bind(ownerId, target.targetId, target.targetKind);
  return Boolean(await statement.first());
}

function objectKey(ownerId: string, target: DocumentImageTarget, imageId: string) {
  return `document-images/v1/${encodeURIComponent(ownerId)}/${target.targetKind}/${target.targetId}/${imageId}`;
}

function failure(status: number, code: string) { return Response.json({ code }, { status, headers: privateHeaders }); }
