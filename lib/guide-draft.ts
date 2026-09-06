export const GUIDE_DRAFT_KEY = "okri.guide-draft";
export const GUIDE_DRAFT_EVENT = "okri-guide-draft";
export const GUIDE_DRAFT_MAX_LENGTH = 1000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function parseGuideDraft(raw: string | null, now = Date.now()): string | null {
  if (!raw || raw.length > 7000) return null;
  try {
    const value = JSON.parse(raw) as { text?: unknown; savedAt?: unknown };
    if (typeof value.text !== "string" || typeof value.savedAt !== "number"
      || !Number.isFinite(value.savedAt) || value.savedAt > now || now - value.savedAt > MAX_AGE_MS) return null;
    const text = value.text.trim();
    return text && text.length <= GUIDE_DRAFT_MAX_LENGTH ? text : null;
  } catch { return null; }
}

export function saveGuideDraft(storage: Pick<Storage, "setItem">, text: string, now = Date.now()) {
  const value = text.trim();
  if (!value || value.length > GUIDE_DRAFT_MAX_LENGTH) throw new Error("Invalid guide draft");
  storage.setItem(GUIDE_DRAFT_KEY, JSON.stringify({ text: value, savedAt: now }));
}
