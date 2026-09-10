import { env } from "cloudflare:workers";
import { slackApi } from "@/lib/slack-daily";
import { BillingLimitError, releaseStorageUpload, reserveStorageUpload } from "@/lib/billing";

type ProjectImageRuntimeEnv = typeof env & {
  WORKSPACE_AVATARS?: R2Bucket;
};

export type SlackImageFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  urlPrivateDownload: string;
};

export type ProjectImage = {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  byteSize: number;
  source: string;
  createdAt: string;
};

type ProjectImageRow = {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  byteSize: number;
  objectKey: string;
  source: string;
  createdAt: string;
};

type SlackFileInfoResult = {
  file?: {
    id?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    size?: number;
    url_private?: string;
    url_private_download?: string;
  };
};

const maxImageBytes = 5 * 1024 * 1024;
const maxThreadImageBytes = 20 * 1024 * 1024;
const maxAgentThreadImageBytes = 10 * 1024 * 1024;
const maxAgentThreadImages = 3;
export const maxSlackThreadImages = 10;

export async function readSlackImagesForAgent(token: string, files: SlackImageFile[]) {
  const images: Array<{ name: string; mimeType: string; data: string }> = [];
  const uniqueFiles = [...new Map(files.map((file) => [file.id, file])).values()].slice(0, maxAgentThreadImages);
  const loaded = await Promise.all(uniqueFiles.map(async (reference) => {
    try {
      const file = await hydrateSlackFile(token, reference);
      if (!file || file.size <= 0 || file.size > maxImageBytes) return null;
      const downloadUrl = slackDownloadUrl(file.urlPrivateDownload);
      if (!downloadUrl) return null;
      const response = await fetchSlackFile(token, downloadUrl);
      if (!response) return null;
      if (!response.ok || Number(response.headers.get("content-length") || 0) > maxImageBytes) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mimeType = verifiedImageType(bytes);
      if (!mimeType || bytes.byteLength > maxImageBytes) return null;
      return { name: cleanFileName(file.name), mimeType, bytes };
    } catch (error) {
      const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
      console.error("Slack agent image read failed", { name: error instanceof Error ? error.name : "unknown",
        code: typeof detail.code === "string" ? detail.code : "" });
      return null;
    }
  }));
  let totalBytes = 0;
  for (const image of loaded) {
    if (!image || totalBytes + image.bytes.byteLength > maxAgentThreadImageBytes) continue;
    totalBytes += image.bytes.byteLength;
    images.push({ name: image.name, mimeType: image.mimeType, data: arrayBufferToBase64(image.bytes) });
  }
  return images;
}

export async function listProjectImages(ownerId: string, projectId: string) {
  await assertProject(ownerId, projectId);
  const rows = await env.DB.prepare(`SELECT id, project_id AS projectId, name, mime_type AS mimeType,
      byte_size AS byteSize, object_key AS objectKey, source, created_at AS createdAt
    FROM project_images
    WHERE owner_id = ? AND project_id = ?
    ORDER BY created_at, id`).bind(ownerId, projectId).all<ProjectImageRow>();
  return rows.results.map(serializeProjectImage);
}

export async function getProjectImage(ownerId: string, imageId: string) {
  const row = await env.DB.prepare(`SELECT image.id, image.project_id AS projectId, image.name,
      image.mime_type AS mimeType, image.byte_size AS byteSize, image.object_key AS objectKey,
      image.source, image.created_at AS createdAt
    FROM project_images image
    JOIN items project ON project.id = image.project_id AND project.owner_id = image.owner_id AND project.kind = 'project'
    WHERE image.owner_id = ? AND image.id = ?`).bind(ownerId, imageId).first<ProjectImageRow>();
  if (!row) throw new Error("Project image not found");
  const object = await imageBucket().get(row.objectKey);
  if (!object) throw new Error("Project image data is unavailable");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== row.byteSize || verifiedImageType(bytes) !== row.mimeType) {
    throw new Error("Project image data failed verification");
  }
  return { image: serializeProjectImage(row), data: bytes };
}

export async function getProjectImageCounts(ownerId: string, projectIds: string[]) {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (!ids.length) return {} as Record<string, number>;
  const rows = await env.DB.prepare(`SELECT project_id AS projectId, count(*) AS count
    FROM project_images
    WHERE owner_id = ? AND project_id IN (${ids.map(() => "?").join(",")})
    GROUP BY project_id`).bind(ownerId, ...ids).all<{ projectId: string; count: number }>();
  return Object.fromEntries(rows.results.map((row) => [row.projectId, Number(row.count) || 0]));
}

export async function saveSlackProjectImages(input: {
  ownerId: string;
  projectId: string;
  createdByUserId: string;
  teamId: string;
  token: string;
  files: SlackImageFile[];
  imagesTruncated?: boolean;
}) {
  await assertProject(input.ownerId, input.projectId);
  const uniqueFiles = [...new Map(input.files.map((file) => [file.id, file])).values()].slice(0, maxSlackThreadImages);
  let totalBytes = 0;
  let saved = 0;
  let reused = 0;
  let skipped = input.imagesTruncated ? Math.max(1, input.files.length - uniqueFiles.length) : 0;
  let failed = 0;
  let quotaExceeded = false;

  for (const reference of uniqueFiles) {
    const sourceRef = `${input.teamId}:${reference.id}`;
    const existing = await env.DB.prepare(`SELECT id FROM project_images
      WHERE owner_id = ? AND project_id = ? AND source = 'slack' AND source_ref = ?`)
      .bind(input.ownerId, input.projectId, sourceRef).first();
    if (existing) {
      reused += 1;
      continue;
    }
    try {
      const file = await hydrateSlackFile(input.token, reference);
      if (!file || file.size <= 0 || file.size > maxImageBytes || totalBytes + file.size > maxThreadImageBytes) {
        skipped += 1;
        continue;
      }
      const downloadUrl = slackDownloadUrl(file.urlPrivateDownload);
      if (!downloadUrl) throw new Error("Slack file URL is not allowed");
      const response = await fetchSlackFile(input.token, downloadUrl);
      if (!response) throw new Error("Slack file download redirect is not allowed");
      if (!response.ok) throw new Error(`Slack file download failed: ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > maxImageBytes) {
        skipped += 1;
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mimeType = verifiedImageType(bytes);
      if (!mimeType || bytes.byteLength > maxImageBytes || totalBytes + bytes.byteLength > maxThreadImageBytes) {
        skipped += 1;
        continue;
      }
      const id = crypto.randomUUID();
      const objectKey = `project-images/v1/${input.ownerId}/${input.projectId}/${id}.${imageExtension(mimeType)}`;
      const storageReservation = await reserveStorageUpload(input.ownerId, bytes.byteLength);
      try {
        await imageBucket().put(objectKey, bytes, {
          httpMetadata: { contentType: mimeType },
          customMetadata: { ownerId: input.ownerId, projectId: input.projectId, source: "slack" },
        });
        const now = new Date().toISOString();
        const result = await env.DB.prepare(`INSERT OR IGNORE INTO project_images
          (id, owner_id, project_id, name, mime_type, byte_size, object_key, source, source_ref, created_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'slack', ?, ?, ?)`)
          .bind(id, input.ownerId, input.projectId, cleanFileName(file.name), mimeType, bytes.byteLength, objectKey,
            sourceRef, input.createdByUserId, now).run();
        if (!result.meta.changes) {
          await imageBucket().delete(objectKey);
          reused += 1;
          await releaseStorageUpload(storageReservation).catch(() => undefined);
          continue;
        }
      } catch (error) {
        await imageBucket().delete(objectKey);
        await releaseStorageUpload(storageReservation).catch(() => undefined);
        throw error;
      }
      await releaseStorageUpload(storageReservation).catch(() => undefined);
      totalBytes += bytes.byteLength;
      saved += 1;
    } catch (error) {
      if (error instanceof BillingLimitError && error.code === "storage_quota_exceeded") {
        quotaExceeded = true;
        skipped += uniqueFiles.length - saved - reused - skipped - failed;
        break;
      }
      console.error("Slack Project image save failed", reference.id, error);
      failed += 1;
    }
  }
  return { found: uniqueFiles.length, saved, reused, skipped, failed, quotaExceeded };
}

async function hydrateSlackFile(token: string, reference: SlackImageFile): Promise<SlackImageFile | null> {
  if (reference.id
    && reference.mimeType.startsWith("image/")
    && reference.size > 0
    && slackDownloadUrl(reference.urlPrivateDownload)) {
    return reference;
  }
  const result = await slackApi<SlackFileInfoResult>(token, "files.info", { file: reference.id });
  const file = result.file;
  if (!file?.id || !String(file.mimetype ?? "").startsWith("image/")) return null;
  return {
    id: file.id,
    name: file.name || file.title || reference.name || "Slack image",
    mimeType: file.mimetype || reference.mimeType,
    size: Number(file.size) || reference.size,
    urlPrivateDownload: file.url_private_download || file.url_private || reference.urlPrivateDownload,
  };
}

function slackDownloadUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !isSlackFileHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchSlackFile(token: string, value: string) {
  const initial = slackDownloadUrl(value);
  if (!initial) return null;
  let current: string = initial;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response: Response = await fetch(current, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location: string | null = response.headers.get("location");
    if (!location) return null;
    try {
      const next: URL = new URL(location, current);
      if (next.protocol !== "https:" || !isSlackFileHost(next.hostname)) return null;
      current = next.toString();
    } catch {
      return null;
    }
  }
  return null;
}

function isSlackFileHost(hostname: string) {
  return hostname === "slack.com"
    || hostname.endsWith(".slack.com")
    || hostname === "slack-files.com"
    || hostname.endsWith(".slack-files.com")
    || hostname === "slack-edge.com"
    || hostname.endsWith(".slack-edge.com");
}

async function assertProject(ownerId: string, projectId: string) {
  const project = await env.DB.prepare("SELECT id FROM items WHERE owner_id = ? AND id = ? AND kind = 'project'")
    .bind(ownerId, projectId).first();
  if (!project) throw new Error("Project not found");
}

function imageBucket() {
  const bucket = (env as ProjectImageRuntimeEnv).WORKSPACE_AVATARS;
  if (!bucket) throw new Error("Project image storage is not configured");
  return bucket;
}

function serializeProjectImage(row: ProjectImageRow): ProjectImage {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    mimeType: row.mimeType,
    byteSize: Number(row.byteSize) || 0,
    source: row.source,
    createdAt: row.createdAt,
  };
}

export function verifiedImageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "image/gif";
  return null;
}

export function arrayBufferToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function imageExtension(mimeType: ProjectImage["mimeType"]) {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[mimeType] || "bin";
}

function cleanFileName(value: string) {
  const printable = [...value].filter((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }).join("");
  const cleaned = printable.replace(/[\\/]/g, "-").trim().slice(0, 255);
  return cleaned || "Slack image";
}
