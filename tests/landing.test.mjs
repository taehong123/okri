import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clientLanguage } from "./helpers/client-language-fixture.mjs";
import { language, serverLanguage } from "./helpers/language-fixture.mjs";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function compile(path, imports = {}) {
  const compiled = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const target = { exports: {} };
  new Function("require", "exports", "module", compiled)((id) => id.endsWith(".css") ? { default: new Proxy({}, { get: (_, key) => key }) } : id === "@/lib/client-language" ? clientLanguage : id === "./language" ? language : imports[id] ?? require(id), target.exports, target);
  return target.exports;
}
const translations = compile("lib/landing-copy.ts");
const themes = compile("lib/themes.ts");
const install = compile("lib/app-install.ts");
const installButton = compile("app/app-install-button.tsx", { "@/lib/app-install": install });
const brandLogo = compile("app/brand-logo.tsx", { "@/lib/brand-artwork": compile("lib/brand-artwork.ts") });
const examples = compile("app/landing-examples.tsx");
const { LandingScreen } = compile("app/landing.tsx", { "@/lib/landing-copy": translations, "@/lib/guide-copy": compile("lib/guide-copy.ts"), "./landing-examples": examples, "./app-install-button": installButton, "./brand-logo": brandLogo });
const { getLandingCopy, landingLanguages, resolveLandingLanguage } = translations;
const landingCopy = Object.fromEntries(await Promise.all(landingLanguages.map(async ({ id }) => [id, getLandingCopy(await serverLanguage.serverTranslator(id), id)])));

test("language selection honors the saved five-language preference and browser fallback", () => {
  assert.equal(resolveLandingLanguage("ja", ["ko-KR"]), "ja");
  assert.equal(resolveLandingLanguage("invalid", ["de-DE", "es-MX"]), "es");
  assert.equal(resolveLandingLanguage(null, ["zh-Hant-TW"]), "zh");
  assert.equal(resolveLandingLanguage(null, ["EN_us"]), "en");
  assert.equal(resolveLandingLanguage(null, ["de-DE"]), "en");
  assert.equal(resolveLandingLanguage(null, []), "en");
});

for (const { id } of landingLanguages) test(`${id}: four complete independent stories and translated controls`, () => {
  const copy = landingCopy[id];
  assert.equal(copy.slides.length, 4);
  assert.equal(new Set(copy.slides.map((slide) => slide.title)).size, 4);
  for (const [key, value] of Object.entries(copy)) if (key !== "slides" && key !== "example") assert.ok(typeof value === "string" && value.trim(), key);
  for (const slide of copy.slides) for (const value of Object.values(slide)) assert.ok(value.trim());
  if (id !== "ko") for (const value of [copy.heroTitle, copy.heroDescription, copy.exampleSource]) assert.doesNotMatch(value, /[가-힣]/);
});

test("server rendering puts the stories before an independent Google sign-in", () => {
  const html = renderToStaticMarkup(React.createElement(LandingScreen, { reason: null, onSignIn() { throw new Error("render must never sign in"); } }));
  assert.match(html, /세계적인 기업들이 선택한 OKR/);
  assert.match(html, /내 일이 어떤 성과와 연결되는지/);
  assert.match(html, /Google로 시작하기/);
  assert.match(html, /목표부터 오늘 할 일까지/);
  assert.match(html, /href="\/download"/);
  assert.match(html, /href="\/guide"/);
  assert.match(html, /OKRI 앱 다운로드/);
  assert.equal((html.match(/class="landing-slide"/g) ?? []).length, 4);
  assert.equal((html.match(/ inert=""/g) ?? []).length, 3);
  assert.match(html, /<section class="landing-story"/);
  assert.match(html, /<section class="landing-auth"/);
  assert.ok(html.indexOf("landing-story") < html.indexOf("landing-auth"));
  assert.match(html, /class="landing-brand-home" aria-label="홈으로 이동"/);
  assert.match(html, /href="https:\/\/www\.whatmatters\.com\/faqs\/okr-examples-and-how-to-write-them"/);
  assert.match(html, /<summary>예시 출처/);
  assert.match(html, /Healthcare\.gov의 Objective와 Key Result는 공개 사례를 번역했고/);
  assert.match(html, /aria-current="step"/);
  assert.doesNotMatch(html, /<img|<picture|landing-step/);
  assert.doesNotMatch(html, /!프로젝트생성|!테스크생성|AllVibe/);
});

test("the fourth story explains shipped Slack bots and the approval and setup steps in all five languages", () => {
  for (const { id } of landingLanguages) {
    const story = landingCopy[id].slides[3];
    assert.match(story.title, /Slack/);
    assert.match(story.description, /Task/);
    assert.match(landingCopy[id].slack, /Slack/);
    if (id !== "ko") {
      for (const value of [...Object.values(story), landingCopy[id].slack]) assert.doesNotMatch(value, /[가-힣]/);
    }
    assert.doesNotMatch(`${story.title} ${story.description}`, /Notion|노션|!테스크생성|!프로젝트생성/i);
  }
  assert.match(landingCopy.ko.slides[3].title, /Slack 연결은 버튼 하나로/);
  for (const capability of ["데일리 스크럼", "누락 확인", "Task 생성", "변경 알림"]) {
    assert.ok(landingCopy.ko.slides[3].description.includes(capability));
  }
  assert.match(landingCopy.ko.slack, /Slack 승인 후/);
  assert.match(landingCopy.ko.slack, /대상과 시간을 설정/);
  const html = renderToStaticMarkup(React.createElement(LandingScreen, { reason: null, onSignIn() {} }));
  assert.ok(html.includes(landingCopy.ko.slack));
});

test("authentication failures and unavailable configuration stay visible by the login control", () => {
  const failure = renderToStaticMarkup(React.createElement(LandingScreen, { reason: "failed", onSignIn() {} }));
  assert.match(failure, /role="alert"/);
  assert.match(failure, /Google 로그인을 완료하지 못했습니다/);
  const unavailable = renderToStaticMarkup(React.createElement(LandingScreen, { reason: "missing_config", onSignIn() {} }));
  assert.match(unavailable, /aria-describedby="landing-login-note" disabled=""/);
  assert.match(unavailable, /Google 로그인 설정을 완료하는 중/);
});

test("new styling uses registered roles and retains stable typography and motion choices", () => {
  const css = read("app/landing.css");
  const common = read("app/globals.css");
  const known = new Set([...Object.keys(themes.THEMES[0].tokens), ...Array.from(common.matchAll(/--([\w-]+)\s*:/g), ([, key]) => key)]);
  for (const [, token] of css.matchAll(/var\(--([\w-]+)/g)) assert.ok(known.has(token), `Unknown token ${token}`);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|linear-gradient|letter-spacing\s*:\s*[^0]|font-size\s*:[^;]*(?:vw|clamp)|\bzoom\s*:/i);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /grid-template-rows: auto minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /\.landing-main \{/);
  assert.match(css, /\.landing-story \{[^}]*border-top:/);
  assert.doesNotMatch(css, /\.landing-layout|\.landing-entry/);
  assert.doesNotMatch(css, /\.landing-login\s*\{/);
});

test("only the signed-out branch changes and sign-in preserves path, search and invitation hash", () => {
  const page = read("app/page.tsx");
  assert.match(page, /authState.status === "unauthenticated"\) return <LandingScreen reason=\{authState.reason\} onSignIn=\{startGoogleSignIn\}/);
  assert.match(page, /window.location.pathname\}\$\{window.location.search\}\$\{window.location.hash/);
  assert.match(page, /api\/auth\/google\?returnTo=\$\{encodeURIComponent\(returnTo\)\}/);
  const landing = read("app/landing.tsx");
  assert.doesNotMatch(landing, /fetch\(|setInterval\(|setTimeout\(/);
  assert.match(landing, /signingInRef.current \|\| unavailable/);
  assert.match(landing, /function goHome\(\)/);
  assert.match(landing, /navigate\(0\)/);
  assert.match(page, /className="workspace-brand"[\s\S]*onClick=\{\(\) => navigateView\("okr"\)\}/);
});

test("every product example is localized native text without fake interactive controls or screenshot requests", () => {
  for (const { id } of landingLanguages) for (const slide of landingCopy[id].slides) {
    const html = renderToStaticMarkup(React.createElement(examples.LandingExample, { kind: slide.example, copy: landingCopy[id].example }));
    assert.match(html, new RegExp(`data-example="${slide.example}"`));
    assert.doesNotMatch(html, /<img|<picture|<button|<input|<select|<a /);
    if (id !== "ko") assert.doesNotMatch(html, /[가-힣]/);
  }
  assert.equal(landingCopy.en.example.currentValue, "3 / 100,000");
  assert.equal(landingCopy.en.example.targetValue, "70%");
  assert.equal(landingCopy.ko.example.current, "출시 당시 가입 성공");
  assert.equal(landingCopy.ko.example.target, "목표 완료율");
  assert.match(landingCopy.en.example.task, /failure logs/i);
  assert.match(landingCopy.en.example.objective, /Healthcare\.gov/);
  for (const { id } of landingLanguages) {
    assert.match(landingCopy[id].exampleSource, /Healthcare\.gov/);
    if (id !== "ko") assert.doesNotMatch(landingCopy[id].exampleSource, /[가-힣]/);
  }
  assert.doesNotMatch(read("app/landing-examples.tsx"), /fetch\(|setInterval\(|setTimeout\(/);
  const html = renderToStaticMarkup(React.createElement(examples.LandingExample, { kind: "connection", copy: landingCopy.en.example }));
  assert.deepEqual([...html.matchAll(/data-kind="([^"]+)"/g)].map((match) => match[1]), ["task", "project", "initiative", "key-result", "objective"]);
});
