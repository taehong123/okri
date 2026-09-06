"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, LoaderCircle, LogIn } from "lucide-react";
import { getLandingCopy, landingLanguages, type LandingLanguage } from "@/lib/landing-copy";
import { AppInstallButton } from "./app-install-button";
import { BrandLogo } from "./brand-logo";
import { LandingExample } from "./landing-examples";
import { getGuideCopy } from "@/lib/guide-copy";
import "./landing.css";
import { chooseGuestLanguage, t, useLanguage } from "@/lib/client-language";

const HEALTHCARE_OKR_SOURCE = "https://www.whatmatters.com/faqs/okr-examples-and-how-to-write-them";

export function LandingScreen({ reason, onSignIn }: { reason: string | null; onSignIn: () => void }) {
  const { language } = useLanguage();
  const copy = getLandingCopy(t, language);
  const [index, setIndex] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const currentIndex = useRef(0);
  const signingInRef = useRef(false);
  const scrollFrame = useRef<number | null>(null);
  const unavailable = reason === "missing_config";

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    // Keep the selected slide aligned when the window, fonts, or language changes.
    const resize = new ResizeObserver(() => node.scrollTo({ left: currentIndex.current * node.clientWidth, behavior: "instant" }));
    resize.observe(node);
    const restore = () => { signingInRef.current = false; setSigningIn(false); };
    window.addEventListener("pageshow", restore);
    return () => {
      resize.disconnect();
      window.removeEventListener("pageshow", restore);
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, []);

  function navigate(next: number) {
    const target = Math.max(0, Math.min(copy.slides.length - 1, next));
    const node = viewport.current;
    if (!node) return;
    node.scrollTo({ left: target * node.clientWidth, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  function goHome() {
    document.getElementById("landing-slide-0")?.scrollTo({ top: 0, behavior: "instant" });
    window.scrollTo({ top: 0, behavior: "instant" });
    navigate(0);
  }

  function trackScroll() {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      const node = viewport.current;
      if (!node?.clientWidth) return;
      const next = Math.max(0, Math.min(3, Math.round(node.scrollLeft / node.clientWidth)));
      currentIndex.current = next;
      setIndex(next);
    });
  }

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: 3 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    navigate(next);
  }

  function signIn() {
    if (signingInRef.current || unavailable) return;
    signingInRef.current = true;
    setSigningIn(true);
    try { onSignIn(); } catch { signingInRef.current = false; setSigningIn(false); }
  }

  return (
    <main className="landing-shell" lang={language}>
      <header className="landing-header">
        <h1>
          <button type="button" className="landing-brand-home" onClick={goHome} aria-label={t("홈으로 이동")}>
            <BrandLogo size="compact" decorative />
          </button>
        </h1>
        <label className="landing-language">
          <span className="sr-only">{copy.language}</span>
          <select value={language} onChange={(event) => {
            const next = event.target.value as LandingLanguage;
            void chooseGuestLanguage(next).catch(() => undefined);
          }}>
            {landingLanguages.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
      </header>

      <div className="landing-main">
        <section className="landing-story" aria-label={copy.carousel} aria-roledescription="carousel">
          <p className="landing-kicker">{copy.heroTitle}</p>
          {/* A scrollable carousel needs a focus stop for native and arrow-key scrolling. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
          <div className="landing-viewport" role="group" ref={viewport} onScroll={trackScroll} onKeyDown={handleKeys} tabIndex={0} aria-label={copy.carousel}>
            {copy.slides.map((slide, slideIndex) => (
              // Each independently scrolling slide must also be keyboard focusable.
              <section key={slideIndex} id={`landing-slide-${slideIndex}`} className="landing-slide" role="group" tabIndex={slideIndex === index ? 0 : -1} aria-roledescription={copy.slide} aria-label={`${slideIndex + 1} / 4`} aria-hidden={slideIndex !== index} inert={slideIndex !== index}>
                <div className="landing-slide-inner">
                  <div className="landing-copy">
                    <h2>{slide.title}</h2>
                    <p>{slide.description}</p>
                  </div>
                  <figure className="landing-product">
                    <LandingExample kind={slide.example} copy={copy.example} />
                    {slideIndex === 0 && <figcaption className="landing-evidence">
                      <details>
                        <summary>{copy.sourceLabel}<ChevronDown size={16} aria-hidden="true" /></summary>
                        <div className="landing-evidence-body">
                          <p>{copy.exampleSource}</p>
                          <div className="landing-sources">
                            <a href={HEALTHCARE_OKR_SOURCE} target="_blank" rel="noreferrer">Healthcare.gov<ArrowUpRight size={14} aria-hidden="true" /></a>
                            <a href="https://blog.google/company-news/outreach-and-initiatives/small-business/lets-make-work-better/" target="_blank" rel="noreferrer">{copy.google}<ArrowUpRight size={14} aria-hidden="true" /></a>
                            <a href="https://www.whatmatters.com/okrs-explained/john-doerr-operation-crush" target="_blank" rel="noreferrer">{copy.intel}<ArrowUpRight size={14} aria-hidden="true" /></a>
                          </div>
                        </div>
                      </details>
                    </figcaption>}
                  </figure>
                  <div className="landing-context">
                    {slideIndex === 2 && <p>{copy.mcp}</p>}
                    {slideIndex === 3 && <p>{copy.slack}</p>}
                  </div>
                </div>
              </section>
            ))}
          </div>
          <nav className="landing-navigation" aria-label={copy.carousel}>
            <div className="landing-dots">
              {copy.slides.map((slide, slideIndex) => <button key={slideIndex} type="button" aria-label={`${copy.slide} ${slideIndex + 1}: ${slide.title}`} aria-current={index === slideIndex ? "step" : undefined} aria-controls={`landing-slide-${slideIndex}`} title={slide.title} onClick={() => navigate(slideIndex)}><span /></button>)}
            </div>
            <div className="landing-arrows">
              <button type="button" className="secondary landing-arrow" aria-label={copy.previous} title={copy.previous} disabled={index === 0} onClick={() => navigate(index - 1)}><ArrowLeft size={20} aria-hidden="true" /></button>
              <button type="button" className="secondary landing-arrow" aria-label={copy.next} title={copy.next} disabled={index === 3} onClick={() => navigate(index + 1)}><ArrowRight size={20} aria-hidden="true" /></button>
            </div>
            <span className="sr-only" aria-live="polite" aria-atomic="true">{copy.slide} {index + 1} / 4: {copy.slides[index].title}</span>
          </nav>
        </section>

        <section className="landing-auth" aria-label={copy.login}>
          <button type="button" className="primary-action landing-login-button" aria-describedby="landing-login-note" disabled={signingIn || unavailable} aria-busy={signingIn} onClick={signIn}>
            {signingIn ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : <LogIn size={18} aria-hidden="true" />}
            <span>{signingIn ? copy.loggingIn : copy.login}</span>
          </button>
          <div className="landing-login-meta">
            <p id="landing-login-note">{copy.loginNote}</p>
            <AppInstallButton placement="login" />
          </div>
          <a className="landing-guide-link" href="/guide">{getGuideCopy(language).guideLink}<ArrowUpRight size={16} aria-hidden="true" /></a>
          {(reason === "failed" || unavailable) && <p className="landing-auth-error" role="alert">{unavailable ? copy.unavailable : copy.loginError}</p>}
        </section>
      </div>
    </main>
  );
}
