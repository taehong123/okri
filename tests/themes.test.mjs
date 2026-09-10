import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import postcss from "postcss";

const source = await readFile(new URL("../lib/themes.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { THEMES, DEFAULT_THEME, isThemeMode, themeColorScheme, themeCss, themeBootstrapScript } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const css = (await Promise.all(["../app/globals.css", "../app/workspace-design.css", "../app/project-review/review.css"].map((path) => readFile(new URL(path, import.meta.url), "utf8")))).join("\n");
const luminance = (hex) => {
  const c = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

test("six complete themes share identity, first paint, editor scheme and preview palettes", () => {
  assert.deepEqual(THEMES.map((theme) => theme.mode), ["white", "beige", "gray", "dark", "neon", "cyberpunk"]);
  assert.equal(DEFAULT_THEME, "white");
  assert.equal(isThemeMode("toString"), false);
  const expected = Object.keys(THEMES[0].tokens).sort();
  for (const theme of THEMES) {
    assert.deepEqual(Object.keys(theme.tokens).sort(), expected);
    assert.equal(themeColorScheme(theme.mode), ["dark", "neon", "cyberpunk"].includes(theme.mode) ? "dark" : "light");
    assert.ok(themeCss.includes(`[data-theme-preview="${theme.mode}"]`));
    assert.ok(themeCss.includes(`html[data-theme="${theme.mode}"]`));
  }
});

for (const theme of THEMES) {
  test(`${theme.mode}: semantic text, actions, states, badges and focus meet contrast targets`, () => {
    const t = theme.tokens;
    function pair(fg, bg, minimum = 4.5) {
      const ratio = contrast(t[fg], t[bg]);
      assert.ok(ratio >= minimum, `${theme.mode}: ${fg}/${bg} is ${ratio}, expected ${minimum}`);
    }
    for (const bg of ["bg-page", "bg-surface", "bg-raised", "bg-subtle", "bg-hover", "bg-sidebar"]) {
      for (const fg of ["text-primary", "text-secondary", "text-tertiary", "text-link", "input-placeholder", "icon-default"]) pair(fg, bg);
      pair("focus-ring", bg, 3);
      pair("border-control", bg, 3);
      for (const role of ["success", "warning", "danger", "info", "purple", "orange"]) pair(`${role}-fg`, bg, 3);
    }
    for (const state of ["", "hover-", "active-"]) pair(`button-primary-${state}fg`, `button-primary-${state}bg`);
    for (const state of ["", "hover-", "active-"]) pair("button-danger-fg", `button-danger-${state}bg`);
    for (const state of ["", "hover-", "active-"]) pair(`button-secondary-${state}fg`, `button-secondary-${state}bg`);
    for (const state of ["hover-", "active-"]) pair(`button-ghost-${state}fg`, `button-ghost-${state}bg`);
    pair("button-disabled-fg", "button-disabled-bg", 3);
    for (const role of ["success", "warning", "danger", "info", "purple", "orange", "neutral-badge", "selected", "toast"]) pair(`${role}-fg`, `${role}-bg`);
    pair("objective-badge-text", "objective-badge-bg");
    pair("project-badge-text", "project-badge-bg");
    pair("kr-badge-text", "kr-badge-bg");
    pair("initiative-badge-text", "initiative-badge-bg");
    pair("kr-rail", "bg-raised", 3);
    pair("initiative-rail", "bg-raised", 3);
    pair("progress-fill", "progress-track", 3);
    assert.equal(t["kr-rail"], t["kr-badge-text"]);
    assert.equal(t["kr-rail"], t["progress-fill"]);
    assert.equal(t["initiative-rail"], t["initiative-badge-text"]);
  });
}

test("all stylesheet palette references resolve and no action uses a text token as its fill", () => {
  const declared = new Set([...`${themeCss}\n${css}`.matchAll(/--([\w-]+)\s*:/g)].map((match) => match[1]));
  for (const match of css.matchAll(/var\(--([\w-]+)/g)) {
    assert.ok(declared.has(match[1]) || ["custom-columns", "custom-column-tracks", "depth"].includes(match[1]), `missing --${match[1]}`);
  }
  const root = postcss.parse(css);
  root.walkDecls((decl) => {
    if (/^background(-color)?$/.test(decl.prop)) assert.doesNotMatch(decl.value, /^var\(--(?:ink|accent-strong)\)$/);
    if (decl.prop === "color") assert.doesNotMatch(decl.value, /^(white|#fff(?:fff)?|var\(--(?:raised|paper)\))$/i);
    if (/^color$|^background(-color)?$/.test(decl.prop)) assert.doesNotMatch(decl.value, /^(#[a-f\d]{3,8}|rgba?\()/i, "component colors belong in the theme registry");
    if (decl.prop === "opacity" && /disabled|inactive|archived|scheduled/.test(decl.parent.selector ?? "")) assert.ok(Number.parseFloat(decl.value) === 1, "disabled ancestors must not fade their otherwise-readable controls");
  });
  assert.doesNotMatch(css, /html\[data-theme="dark"\]\s+:where/);
  assert.doesNotMatch(css, /text-shadow/);
});

test("first paint preserves every saved theme and tolerates missing, invalid or blocked storage", () => {
  for (const saved of [...THEMES.map((theme) => theme.mode), null, "obsolete", "toString", "__proto__"]) {
    const root = { dataset: {}, style: {} };
    vm.runInNewContext(themeBootstrapScript, {
      document: { documentElement: root },
      window: { localStorage: { getItem: () => saved, setItem: () => assert.fail("first paint must not rewrite preferences") } },
    });
    assert.equal(root.dataset.theme, isThemeMode(saved) ? saved : DEFAULT_THEME);
    assert.equal(root.style.colorScheme, themeColorScheme(saved));
  }
  const root = { dataset: {}, style: {} };
  vm.runInNewContext(themeBootstrapScript, { document: { documentElement: root }, window: { get localStorage() { throw new Error("blocked"); } } });
  assert.equal(root.dataset.theme, DEFAULT_THEME);
});

test("white chrome is strictly neutral while semantic status colors retain meaning", () => {
  const white = THEMES.find((theme) => theme.mode === "white").tokens;
  const roles = ["bg-page", "bg-sidebar", "bg-surface", "bg-subtle", "bg-hover", "bg-raised", "text-primary", "text-secondary", "text-tertiary", "text-link", "icon-default", "border-default", "border-control", "menu-bg", "menu-fg", "modal-bg", "input-bg", "input-fg", "selected-bg", "selected-fg", "initiative-badge-bg", "initiative-badge-text", "initiative-rail"];
  for (const role of roles) {
    const channels = white[role].slice(1).match(/../g).map((part) => parseInt(part, 16));
    assert.equal(new Set(channels).size, 1, `${role} must have no color cast`);
  }
  assert.equal(white["bg-sidebar"], white["bg-page"]);
  assert.notEqual(white["danger-fg"], white["text-primary"]);
  assert.notEqual(white["success-fg"], white["text-primary"]);
  assert.notEqual(white["info-fg"], white["text-primary"]);
  assert.doesNotMatch(css, /var\(--blue\)/, "legacy blue must not style generic UI");
  const rules = postcss.parse(css);
  rules.walkRules((rule) => {
    if (!/^\.(assistant-stage|assistant-example|chat-okr-context|general-routine-icon|system-badge|integration-service-icon|workspace-daily-bot-heading|integration-oauth-flow)/.test(rule.selector)) return;
    rule.walkDecls((decl) => assert.doesNotMatch(decl.value, /var\(--info-(?:fg|bg)\)/, `${rule.selector} is not a status alert`));
  });
});

test("default workflow states use the theme accent while informational blue stays semantic", () => {
  const rules = postcss.parse(css);
  for (const selector of [".status-todo", ".priority-medium", ".status-dot.status-todo"]) {
    const declarations = [];
    rules.walkRules((rule) => {
      if (rule.selector?.split(",").map((entry) => entry.trim()).includes(selector)) {
        rule.walkDecls((declaration) => declarations.push(declaration.value));
      }
    });
    assert.ok(declarations.length > 0, `${selector} must be styled`);
    assert.ok(declarations.some((value) => /var\(--accent(?:-fg)?\)/.test(value)), `${selector} must follow the active accent`);
    assert.ok(declarations.every((value) => !/var\(--info-(?:fg|bg)\)/.test(value)), `${selector} must not introduce informational blue`);
  }
  assert.match(css, /\.toast-info\s*\{[^}]*var\(--info-bg\)/, "informational feedback keeps its semantic palette");
  assert.match(css, /\.group-blue\s*\{[^}]*var\(--info-bg\)/, "user-chosen blue groups stay blue");
});

test("readability uses scalable roles instead of per-screen font patches or CSS zoom", () => {
  const root = postcss.parse(css);
  const roles = { "--type-body": "1rem", "--type-label": ".875rem", "--type-meta": ".8125rem", "--type-section": "1.125rem", "--type-page": "1.5rem" };
  for (const [name, value] of Object.entries(roles)) {
    const declarations = [];
    root.walkDecls(name, (decl) => declarations.push(decl.value));
    assert.deepEqual(declarations, [value], `${name} has one source of truth`);
  }
  for (const [name, sizes] of Object.entries({ "--control-height": ["2.25rem", "2.75rem"], "--field-height": ["2.5rem", "2.75rem"], "--row-height": ["3rem", "3.25rem"] })) {
    const declarations = [];
    root.walkDecls(name, (decl) => {
      declarations.push(decl.value);
      if (decl.parent.parent.type === "atrule") assert.equal(decl.parent.parent.params, "(max-width: 980px), (pointer: coarse)");
    });
    assert.deepEqual(declarations, sizes, `${name} only changes for touch-sized controls`);
  }
  root.walkDecls("font-size", (decl) => assert.doesNotMatch(decl.value, /\dpx\b/, `fixed type in ${decl.parent.selector}`));
  root.walkDecls("zoom", () => assert.fail("Do not scale the entire application with zoom"));
  root.walkDecls("letter-spacing", (decl) => assert.equal(decl.value, "0"));
  root.walkRules("html", (rule) => rule.walkDecls("font-size", () => assert.equal(rule.parent.type, "root", "Viewport width must not change the user's text scale")));
  const white = THEMES.find((theme) => theme.mode === "white").tokens;
  assert.equal(white["text-link"], white["text-primary"]);
  assert.equal(white["focus-ring"], white["text-primary"]);
});

test("mobile daily completion stays compact without shrinking its touch target", () => {
  assert.match(css, /\.app-shell \.scrum-toolbar > div \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.app-shell \.scrum-toolbar > div > button\.primary-action \{[^}]*width: auto;[^}]*min-width: max-content;[^}]*border-radius: 999px;/);
  assert.match(css, /\.app-shell \.scrum-toolbar > div > button\.primary-action \{[^}]*justify-self: end;/);
});

test("hierarchy colors change with each theme instead of sharing fixed rails", () => {
  assert.equal(new Set(THEMES.map((theme) => theme.tokens["kr-rail"])).size, THEMES.length);
  for (const theme of THEMES) {
    assert.equal(theme.tokens["kr-badge-bg"], theme.tokens["selected-bg"]);
    assert.equal(theme.tokens["kr-badge-text"], theme.tokens["accent-fg"]);
  }
});

test("Korean and Latin use the same self-hosted, selectively loaded variable font", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const fontCss = await readFile(new URL("../public/fonts/pretendard-1.3.9/pretendardvariable-dynamic-subset.css", import.meta.url), "utf8");
  assert.match(layout, /import "\.\/fonts\.css"/);
  const bundledFontCss = await readFile(new URL("../app/fonts.css", import.meta.url), "utf8");
  assert.match(bundledFontCss, /url\(\/fonts\/pretendard-1\.3\.9\/woff2-dynamic-subset\//);
  assert.doesNotMatch(layout, /next\/font\/google/);
  assert.match(css, /font-family: var\(--font-ui\)/);
  assert.match(fontCss, /font-display: swap/);
  const faces = postcss.parse(fontCss);
  const paths = [];
  faces.walkAtRules("font-face", (face) => {
    let range = false;
    face.walkDecls("unicode-range", () => { range = true; });
    face.walkDecls("src", (decl) => paths.push(decl.value.match(/url\(([^)]+)\)/)[1]));
    assert.ok(range, "Every font subset has a Unicode range");
  });
  assert.equal(paths.length, 92);
  for (const path of paths) {
    const data = await readFile(new URL(`../public/fonts/pretendard-1.3.9/${path}`, import.meta.url));
    assert.equal(data.subarray(0, 4).toString(), "wOF2");
  }
});
