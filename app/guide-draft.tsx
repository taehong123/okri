"use client";

import { useSyncExternalStore } from "react";
import { ArrowDown, X } from "lucide-react";
import { useLanguage } from "@/lib/client-language";
import { getGuideCopy } from "@/lib/guide-copy";
import { GUIDE_DRAFT_EVENT, GUIDE_DRAFT_KEY, parseGuideDraft } from "@/lib/guide-draft";
import "./guide-draft.css";

function subscribe(listener: () => void) {
  window.addEventListener(GUIDE_DRAFT_EVENT, listener);
  return () => window.removeEventListener(GUIDE_DRAFT_EVENT, listener);
}
function snapshot() {
  if (new URLSearchParams(location.search).get("guide") !== "1") return null;
  try { return sessionStorage.getItem(GUIDE_DRAFT_KEY); } catch { return null; }
}
function clear() {
  try { sessionStorage.removeItem(GUIDE_DRAFT_KEY); } catch { /* The URL also consumes this handoff. */ }
  const url = new URL(location.href); url.searchParams.delete("guide");
  history.replaceState(history.state, "", url);
  window.dispatchEvent(new Event(GUIDE_DRAFT_EVENT));
}

export function GuideDraft({ active, ready, onUse }: { active: boolean; ready: boolean; onUse: (value: string) => void }) {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  const { language } = useLanguage();
  const copy = getGuideCopy(language);
  const text = parseGuideDraft(raw);
  if (!active || !text) return null;
  return <aside className="guide-draft" aria-labelledby="guide-draft-title">
    <header><h3 id="guide-draft-title">{copy.pendingTitle}</h3><button className="icon-button" type="button" onClick={clear} aria-label={copy.dismiss} title={copy.dismiss}><X size={16} /></button></header>
    <p>{text}</p>
    <div><small>{copy.pendingNote}</small><button className="secondary" type="button" disabled={!ready} onClick={() => {
      onUse(text); clear();
      requestAnimationFrame(() => document.getElementById("assistant-message")?.focus());
    }}>{copy.addMessage}<ArrowDown size={16} aria-hidden="true" /></button></div>
  </aside>;
}
