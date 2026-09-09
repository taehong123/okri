"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { OverlayDialog } from "@/app/overlay-dialog";
import { t } from "@/lib/client-language";

export type DocumentProperty = { key: string; label: string; value: ReactNode; primary?: boolean };

/** Read first. Opening the summary never mounts controls or performs a write. */
export function DocumentProperties({ entries, readOnly = false, dirty = false, autoSave = true, onEditorClose, children }: {
  entries: DocumentProperty[];
  readOnly?: boolean;
  dirty?: boolean;
  autoSave?: boolean;
  onEditorClose?: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const summary = entries.filter(entry => entry.primary);
  function closeEditor() { setEditing(false); onEditorClose?.(); }
  return <section className="document-properties">
    <div className="document-properties-bar">
      <button type="button" className="document-properties-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
        <ChevronDown size={15} aria-hidden="true" /><span>{t("속성")}</span>
      </button>
      <div className="document-properties-summary">{summary.map(entry => <span key={entry.key}><span className="sr-only">{entry.label}: </span>{entry.value}</span>)}</div>
      {!readOnly && <button type="button" className="secondary document-properties-change" aria-haspopup="dialog" onClick={() => setEditing(true)}>{t("변경")}</button>}
    </div>
    <dl id={id} className="document-property-list" hidden={!expanded}>{entries.map(entry => <div key={entry.key}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>
    {editing && !readOnly && <OverlayDialog title={t("속성 편집")} dirty={dirty} initialFocus=".document-properties-editor input, .document-properties-editor textarea, .document-properties-editor select" onRequestClose={closeEditor}>
      {requestClose => <section className="document-properties-editor property-panel">
        <header><div><h2>{t("속성 편집")}</h2>{autoSave && <p>{t("변경 즉시 저장")}</p>}</div><button type="button" className="icon-button" aria-label={t("닫기")} onClick={() => requestClose("close-button")}><X size={17} /></button></header>
        {children(closeEditor)}
      </section>}
    </OverlayDialog>}
  </section>;
}
