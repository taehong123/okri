export type DocumentImageTarget = { targetKind: "project" | "task" | "routine"; targetId: string };
export const DOCUMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export function readDocumentImageTarget(query: URLSearchParams): DocumentImageTarget | null {
  const targetKind = query.get("targetKind");
  const targetId = query.get("targetId") ?? "";
  if (!["project", "task", "routine"].includes(targetKind ?? "") || !/^[a-zA-Z0-9_-]{1,128}$/.test(targetId)) return null;
  return { targetKind: targetKind as DocumentImageTarget["targetKind"], targetId };
}

export function documentImageUrl(target: DocumentImageTarget, imageId: string) {
  return `/api/document-images?${new URLSearchParams({ ...target, imageId })}`;
}

export function safeDocumentImageName(value: string) {
  return [...value].filter(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    .join("").replace(/[\\/]/g, "-").trim().slice(0, 180) || "image";
}
