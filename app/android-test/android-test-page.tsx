"use client";

import Link from "next/link";
import { ArrowRight, CalendarRange, Check, Gift, ListChecks, Network, Smartphone } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { BrandLogo } from "../brand-logo";
import { getAndroidTestCopy } from "@/lib/android-test-copy";
import { applyGuestLanguage, chooseGuestLanguage, useLanguage } from "@/lib/client-language";
import { isLanguage, languages, type Language } from "@/lib/language";
import "./android-test.css";

const PLAY_TEST_URL = "https://play.google.com/apps/testing/ai.okri.app";
const subscribeHydration = () => () => {};

export default function AndroidTestPage() {
  const ready = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const { language } = useLanguage();
  const copy = getAndroidTestCopy(language);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [access, setAccess] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "success">("idle");
  const [error, setError] = useState("");
  const emailInput = useRef<HTMLInputElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const consentInput = useRef<HTMLInputElement>(null);
  const successPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("lang");
    void (isLanguage(requested) ? chooseGuestLanguage(requested) : applyGuestLanguage()).catch(() => undefined);
  }, []);
  useEffect(() => { if (state === "success") successPanel.current?.focus(); }, [state]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!emailInput.current?.checkValidity()) { setError(copy.emailError); emailInput.current?.focus(); return; }
    if (!phone.trim()) { setError(copy.phoneError); phoneInput.current?.focus(); return; }
    if (!consent) { setError(copy.requiredError); consentInput.current?.focus(); return; }
    setState("submitting");
    try {
      const response = await fetch("/api/android-test-signups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, phone, consent, language, website }) });
      const payload = await response.json().catch(() => ({})) as { code?: string; access?: string };
      if (!response.ok || !payload.access) {
        setError(payload.code === "invalid_email" ? copy.emailError : payload.code === "invalid_phone" ? copy.phoneError : payload.code === "consent_required" ? copy.requiredError : copy.requestError);
        setState("idle"); return;
      }
      setAccess(payload.access); setState("success");
    } catch { setError(copy.requestError); setState("idle"); }
  }

  return <main className="android-test-page" lang={language} data-ready={ready}>
    <header className="android-test-header">
      <Link className="android-test-brand" href="/" prefetch={false} aria-label={copy.home}><BrandLogo size="compact" decorative /></Link>
      <label className="android-test-language"><span className="sr-only">{copy.language}</span><select disabled={!ready} value={language} onChange={(event) => {
        const next = event.target.value as Language;
        void chooseGuestLanguage(next).then(() => { const url = new URL(location.href); url.searchParams.set("lang", next); history.replaceState(history.state, "", url); }).catch(() => undefined);
      }}>{languages.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
    </header>
    <div className="android-test-layout">
      <section className="android-test-intro" aria-labelledby="android-test-title"><h1 id="android-test-title">{copy.title}</h1><p>{copy.intro}</p></section>
      <section className="android-test-evidence" aria-label={copy.previewLabel}>
        <section className="android-test-benefits" aria-labelledby="android-test-benefits-title"><h2 id="android-test-benefits-title">{copy.benefitTitle}</h2><ul>
          <li><Network size={18} aria-hidden="true" /><span>{copy.benefits[0]}</span></li><li><ListChecks size={18} aria-hidden="true" /><span>{copy.benefits[1]}</span></li><li><CalendarRange size={18} aria-hidden="true" /><span>{copy.benefits[2]}</span></li>
        </ul></section>
        <article className="android-test-preview"><header><span><Smartphone size={18} aria-hidden="true" />OKRI</span><b>{copy.previewToday}</b></header>
          <div className="android-test-tree"><div><small>{copy.previewObjective}</small><strong>{copy.previewObjectiveExample}</strong></div><div className="android-test-kr"><small>{copy.previewKeyResult}</small><strong>{copy.previewKeyResultExample}</strong><span><i style={{ width: "42%" }} /><b>42%</b></span></div><div><small>{copy.previewProject}</small><strong>{copy.previewProjectExample}</strong></div><ul>{copy.previewTasks.map((task) => <li key={task}><Check size={15} aria-hidden="true" />{task}</li>)}</ul></div>
        </article>
      </section>
      <aside className="android-test-signup" aria-labelledby="android-test-form-title">
        <section className="android-test-reward"><Gift size={22} aria-hidden="true" /><div><h2>{copy.rewardTitle}</h2><p>{copy.rewardBody}</p></div></section>
        <section className="android-test-conditions" aria-labelledby="android-test-conditions-title"><h2 id="android-test-conditions-title">{copy.conditionsTitle}</h2><ul>{copy.rewardConditions.map((condition) => <li key={condition}>{condition}</li>)}</ul></section>
        <section className="android-test-steps" aria-labelledby="android-test-steps-title"><h2 id="android-test-steps-title">{copy.stepsTitle}</h2><ol>{copy.steps.map((step, index) => <li key={step}><b>{index + 1}</b><span>{step}</span></li>)}</ol></section>
        {state === "success" ? <section ref={successPanel} className="android-test-success" role="status" tabIndex={-1}><h2 id="android-test-form-title">{copy.successTitle}</h2><p>{copy.successBody}</p><Link href={`/android-test/status?access=${encodeURIComponent(access)}`}>{copy.statusLink}<ArrowRight size={17} aria-hidden="true" /></Link><small>{copy.statusHint}</small><a href={PLAY_TEST_URL} target="_blank" rel="noreferrer" className="android-test-text-link">{copy.playLink}<ArrowRight size={16} aria-hidden="true" /></a><small>{copy.playNote}</small></section> :
          <form className="android-test-form" onSubmit={submit} noValidate><h2 id="android-test-form-title">{copy.formTitle}</h2><p>{copy.formIntro}</p>
            <label className="android-test-field" htmlFor="android-test-email"><span>{copy.emailLabel}</span><input ref={emailInput} id="android-test-email" type="email" inputMode="email" autoComplete="email" required maxLength={254} disabled={!ready || state === "submitting"} value={email} onChange={(event) => { setEmail(event.target.value); setError(""); }} placeholder="name@gmail.com" aria-describedby="android-test-email-hint android-test-error" /><small id="android-test-email-hint">{copy.emailHint}</small></label>
            <label className="android-test-field" htmlFor="android-test-phone"><span>{copy.phoneLabel}</span><input ref={phoneInput} id="android-test-phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={20} disabled={!ready || state === "submitting"} value={phone} onChange={(event) => { setPhone(event.target.value); setError(""); }} placeholder="010-0000-0000" aria-describedby="android-test-phone-hint android-test-error" /><small id="android-test-phone-hint">{copy.phoneHint}</small></label>
            <label className="android-test-honeypot" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} /></label>
            <label className="android-test-consent"><input ref={consentInput} type="checkbox" disabled={!ready || state === "submitting"} checked={consent} onChange={(event) => { setConsent(event.target.checked); setError(""); }} /><span>{copy.consent} <Link href="/privacy" target="_blank">{copy.privacy}</Link></span></label><div id="android-test-error" className="android-test-error" role="alert">{error}</div><button type="submit" disabled={!ready || state === "submitting"}>{state === "submitting" ? copy.submitting : copy.submit}<ArrowRight size={18} aria-hidden="true" /></button>
          </form>}
      </aside>
    </div>
    <footer className="android-test-footer"><Link href="/guide">{copy.product}</Link><div><Link href="/terms">{copy.terms}</Link><Link href="/privacy">{copy.privacy}</Link></div></footer>
  </main>;
}
