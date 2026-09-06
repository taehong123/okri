"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, FoldVertical, Link2, UnfoldVertical, UserRound } from "lucide-react";
import { BrandLogo } from "../brand-logo";
import { applyGuestLanguage, chooseGuestLanguage, useLanguage, t } from "@/lib/client-language";
import { formatLocale, isLanguage, languages, type Language } from "@/lib/language";
import { getGuideCopy, guideKinds, guideTypeNames, type GuideCopy } from "@/lib/guide-copy";
import { buildGuideTree, type GuideExampleNode } from "@/lib/guide-example";
import { GUIDE_DRAFT_MAX_LENGTH, saveGuideDraft } from "@/lib/guide-draft";
import { PUBLIC_APP_URL } from "@/lib/brand";
import "./guide.css";

const expandableIds = ["objective", "kr-0", "kr-1", "initiative-0", "initiative-1", "project-0", "project-1", "project-2", "project-3"];
const subscribeHydration = () => () => {};

export default function GuidePage() {
  const ready = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const { language } = useLanguage();
  const copy = getGuideCopy(language);
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  const [sharing, setSharing] = useState<"idle" | "copied" | "fallback">("idle");
  const [expanded, setExpanded] = useState(() => new Set(expandableIds));
  const input = useRef<HTMLTextAreaElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const tree = buildGuideTree(copy);
  const shareUrl = new URL("/guide", PUBLIC_APP_URL);
  shareUrl.searchParams.set("lang", language);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("lang");
    void (isLanguage(requested) ? chooseGuestLanguage(requested) : applyGuestLanguage()).catch(() => undefined);
  }, []);

  function start(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) { input.current?.focus(); return; }
    try {
      saveGuideDraft(window.sessionStorage, text);
      window.location.assign("/?guide=1");
    } catch { setError(true); input.current?.focus(); }
  }

  async function share() {
    try { await navigator.clipboard.writeText(shareUrl.toString()); setSharing("copied"); }
    catch { setSharing("fallback"); window.requestAnimationFrame(() => { linkInput.current?.focus(); linkInput.current?.select(); }); }
  }

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return <main className="okr-guide" lang={language} data-ready={ready}>
    <header className="guide-header">
      <Link className="guide-brand" href="/" prefetch={false} aria-label={copy.home}><BrandLogo size="compact" decorative /></Link>
      <div className="guide-header-actions">
        <label><span className="sr-only">{copy.language}</span><select disabled={!ready} value={language} onChange={(event) => {
          const next = event.target.value as Language;
          void chooseGuestLanguage(next).then(() => {
            const url = new URL(location.href); url.searchParams.set("lang", next);
            history.replaceState(history.state, "", url);
          }).catch(() => undefined);
        }}>{languages.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
        <button type="button" disabled={!ready} className="guide-icon" onClick={() => void share()} aria-label={copy.share} title={copy.share}>{sharing === "copied" ? <Check size={18} /> : <Link2 size={18} />}</button>
      </div>
    </header>
    <div className="guide-share-status" role="status">{sharing === "copied" && copy.copied}</div>
    {sharing === "fallback" && <label className="guide-share-fallback">{copy.shareFallback}<input ref={linkInput} value={shareUrl.toString()} readOnly onFocus={(event) => event.currentTarget.select()} /></label>}

    <section className="guide-intro" aria-labelledby="guide-title">
      <h1 id="guide-title">{copy.title}</h1>
      <p>{copy.intro}</p>
      <form className="guide-conversation" onSubmit={start}>
        <label htmlFor="guide-goal">{copy.question}</label>
        <textarea id="guide-goal" disabled={!ready} ref={input} value={text} onChange={(event) => { setText(event.target.value); setError(false); }} placeholder={copy.placeholder} maxLength={GUIDE_DRAFT_MAX_LENGTH} rows={2} aria-describedby={error ? "guide-draft-error guide-login-note" : "guide-login-note"} aria-invalid={error || undefined} />
        <div><span id="guide-login-note">{copy.signInNote}</span><button className="primary-action" type="submit" disabled={!ready}>{copy.start}<ArrowRight size={18} aria-hidden="true" /></button></div>
        {error && <p id="guide-draft-error" role="alert">{copy.storageError}</p>}
      </form>
    </section>

    <section className="guide-map" aria-labelledby="guide-map-title">
      <header className="guide-map-header">
        <div><h2 id="guide-map-title">{copy.example}</h2><p>{copy.exampleNote}</p></div>
        <div className="guide-map-actions">
          <button type="button" disabled={!ready} className="guide-icon" onClick={() => setExpanded(new Set(expandableIds))} aria-label={copy.expand} title={copy.expand}><UnfoldVertical size={18} /></button>
          <button type="button" disabled={!ready} className="guide-icon" onClick={() => setExpanded(new Set())} aria-label={copy.collapse} title={copy.collapse}><FoldVertical size={18} /></button>
        </div>
      </header>
      <ol className="guide-tree"><TreeNode node={tree} copy={copy} language={language} expanded={expanded} onToggle={toggle} ready={ready} /></ol>
      <p className="guide-outcome-note">{copy.outcomeNote}</p>
    </section>

    <section className="guide-roles" aria-labelledby="guide-roles-title">
      <h2 id="guide-roles-title">{copy.roles}</h2>
      <dl>
        <div><dt><UserRound size={18} aria-hidden="true" />{copy.dri}<span>Project · DRI</span></dt><dd>{copy.driDefinition}</dd></div>
        <div><dt><UserRound size={18} aria-hidden="true" />{copy.assignee}<span>Task · Assignee</span></dt><dd>{copy.assigneeDefinition}</dd></div>
      </dl>
      <p>{copy.roleNote}</p>
    </section>

    <details className="guide-glossary">
      <summary>{copy.terms}<ChevronDown size={18} aria-hidden="true" /></summary>
      <dl>{guideKinds.map((kind) => <div key={kind}><dt>{guideTypeNames[kind]}</dt><dd>{copy.definitions[kind]}</dd></div>)}</dl>
      <p>{copy.structureNote}</p>
      <a href="https://www.whatmatters.com/faqs/outputs-vs-outcome-okr" target="_blank" rel="noreferrer">{copy.source}<ArrowUpRight size={16} aria-hidden="true" /></a>
    </details>
    <footer className="guide-footer"><Link href="/" prefetch={false}>{copy.home}<ArrowRight size={16} aria-hidden="true" /></Link><div><a href="/terms">{copy.legalTerms}</a><a href="/privacy">{copy.privacy}</a></div></footer>
  </main>;
}

function TreeNode({ node, copy, language, expanded, onToggle, ready }: { node: GuideExampleNode; copy: GuideCopy; language: Language; expanded: Set<string>; onToggle: (id: string) => void; ready: boolean }) {
  const open = expanded.has(node.id);
  const percent = new Intl.NumberFormat(formatLocale(language), { style: "percent", maximumFractionDigits: 0 });
  const date = node.date && new Intl.DateTimeFormat(formatLocale(language), { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(node.date));
  return <li className={`guide-branch guide-branch-${node.kind}`}>
    <article className="guide-node" data-kind={node.kind} aria-labelledby={`guide-title-${node.id}`}>
      <header><div><span className="guide-type">{guideTypeNames[node.kind]}</span><span className="guide-node-meaning">{copy.short[node.kind]}</span></div>
        {node.children && <button type="button" disabled={!ready} className="guide-icon" onClick={() => onToggle(node.id)} aria-expanded={open} aria-controls={`guide-children-${node.id}`} aria-label={`${node.title} · ${open ? t("접기") : t("펼치기")}`} title={open ? t("접기") : t("펼치기")}>{open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>}
      </header>
      <h3 id={`guide-title-${node.id}`}>{node.title}</h3>
      {node.metric && <dl className="guide-metric"><div><dt>{copy.baseline}</dt><dd>{percent.format(node.metric[0])}</dd></div><div><dt>{copy.target}</dt><dd>{percent.format(node.metric[1])}</dd></div></dl>}
      {(node.person || date) && <div className="guide-node-meta">
        {node.person && <span><UserRound size={14} aria-hidden="true" />{node.kind === "project" ? copy.dri : copy.assignee}<b>{node.person}</b></span>}
        {date && <span>{copy.due}<time dateTime={node.date}>{date}</time></span>}
      </div>}
    </article>
    {node.children && <ol id={`guide-children-${node.id}`} hidden={!open}>{node.children.map((child) => <TreeNode key={child.id} node={child} copy={copy} language={language} expanded={expanded} onToggle={onToggle} ready={ready} />)}</ol>}
  </li>;
}
