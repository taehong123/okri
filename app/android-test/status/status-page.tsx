"use client";

import Link from "next/link";
import { Check, CircleAlert, LoaderCircle, Send } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { BrandLogo } from "../../brand-logo";
import { getAndroidTestCopy } from "@/lib/android-test-copy";
import { applyGuestLanguage, useLanguage } from "@/lib/client-language";
import type { Language } from "@/lib/language";
import "../android-test.css";

type Portal = { email: string; phoneLastFour: string; language: Language; status: string; invitedAt: string | null; optedInAt: string | null; eligibleAt: string | null; rewardedAt: string | null; feedback: Array<{ id: string; message: string; createdAt: string }> };
const subscribeHydration = () => () => {};

export default function AndroidTestStatusPage() {
  const ready = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const { language } = useLanguage(); const copy = getAndroidTestCopy(language);
  const [portal, setPortal] = useState<Portal | null>(null); const [loadState, setLoadState] = useState<"loading" | "missing" | "error" | "ready">("loading");
  const [message, setMessage] = useState(""); const [feedbackState, setFeedbackState] = useState<"idle" | "sending" | "saved" | "error">("idle");
  const [access, setAccess] = useState<string | null>(null);
  useEffect(() => { void applyGuestLanguage().catch(() => undefined); }, []);
  useEffect(() => { setAccess(new URLSearchParams(window.location.search).get("access") ?? ""); }, []);
  useEffect(() => { if (access === null) return; if (!access) { setLoadState("missing"); return; } void load(); }, [access]);
  async function load() { try { const response = await fetch(`/api/android-test-signups/status?access=${encodeURIComponent(access)}`, { cache: "no-store" }); if (response.status === 404) { setLoadState("missing"); return; } if (!response.ok) throw new Error("status"); const payload = await response.json() as { portal: Portal }; setPortal(payload.portal); setLoadState("ready"); } catch { setLoadState("error"); } }
  async function sendFeedback(event: FormEvent) { event.preventDefault(); if (message.trim().length < 3) { setFeedbackState("error"); return; } setFeedbackState("sending"); try { const response = await fetch("/api/android-test-signups/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access, message }) }); if (!response.ok) throw new Error("feedback"); setMessage(""); setFeedbackState("saved"); await load(); } catch { setFeedbackState("error"); } }
  const stages = portal ? [{ label: copy.applied, done: true, date: null }, { label: copy.invited, done: Boolean(portal.invitedAt), date: portal.invitedAt }, { label: copy.optedIn, done: Boolean(portal.optedInAt), date: portal.optedInAt }, { label: copy.eligible, done: Boolean(portal.eligibleAt), date: portal.eligibleAt }, { label: copy.rewarded, done: Boolean(portal.rewardedAt), date: portal.rewardedAt }] : [];
  return <main className="android-test-page android-test-status-page" lang={language} data-ready={ready}><header className="android-test-header"><Link className="android-test-brand" href="/" aria-label={copy.home}><BrandLogo size="compact" decorative /></Link></header><div className="android-test-status-wrap"><section className="android-test-status-intro"><h1>{copy.statusTitle}</h1><p>{copy.statusIntro}</p></section>{loadState === "loading" && <p className="android-test-loading"><LoaderCircle size={18} aria-hidden="true" />{copy.statusLoading}</p>}{loadState === "missing" && <section className="android-test-message"><CircleAlert size={22} aria-hidden="true" /><p>{copy.statusMissing}</p></section>}{loadState === "error" && <section className="android-test-message"><CircleAlert size={22} aria-hidden="true" /><p>{copy.statusError}</p></section>}{portal && <><section className="android-test-identity"><div><small>{copy.statusEmail}</small><b>{portal.email}</b></div><div><small>{copy.statusPhone}</small><b>***-****-{portal.phoneLastFour}</b></div></section><p className="android-test-install-note">{copy.installCondition}</p><ol className="android-test-status-list">{stages.map((stage) => <li key={stage.label} className={stage.done ? "complete" : ""}><span>{stage.done ? <Check size={16} aria-hidden="true" /> : ""}</span><b>{stage.label}</b><small>{stage.date ? new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium" }).format(new Date(stage.date)) : copy.pending}</small></li>)}</ol><section className="android-test-feedback-form"><h2>{copy.feedbackTitle}</h2><form onSubmit={sendFeedback}><textarea value={message} maxLength={2000} onChange={(event) => { setMessage(event.target.value); setFeedbackState("idle"); }} placeholder={copy.feedbackPlaceholder} aria-label={copy.feedbackTitle} /><p role="status" className={feedbackState === "error" ? "android-test-error" : "android-test-feedback-message"}>{feedbackState === "saved" ? copy.feedbackSaved : feedbackState === "error" ? copy.feedbackError : ""}</p><button type="submit" disabled={feedbackState === "sending"}>{copy.feedbackSubmit}<Send size={17} aria-hidden="true" /></button></form></section><section className="android-test-feedback-history"><h2>{copy.feedbackHistory}</h2>{portal.feedback.length ? <ul>{portal.feedback.map((feedback) => <li key={feedback.id}><p>{feedback.message}</p><small>{new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", { dateStyle: "medium" }).format(new Date(feedback.createdAt))}</small></li>)}</ul> : <p>{copy.pending}</p>}</section></>}</div></main>;
}
