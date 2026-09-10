/** Theme identity, preview colors, first paint and editor scheme share one registry. */
export const THEME_STORAGE_KEY = "okri.theme";
export const LEGACY_THEME_STORAGE_KEY = "okrptr.theme";
export const DEFAULT_THEME = "white";

// Radix Colors 3.0.0, unmodified sRGB steps 1-12. See docs/THEMES.md.
const radix = {
  gray: ["#fcfcfc","#f9f9f9","#f0f0f0","#e8e8e8","#e0e0e0","#d9d9d9","#cecece","#bbbbbb","#8d8d8d","#838383","#646464","#202020"],
  grayDark: ["#111111","#191919","#222222","#2a2a2a","#313131","#3a3a3a","#484848","#606060","#6e6e6e","#7b7b7b","#b4b4b4","#eeeeee"],
  slate: ["#fcfcfd","#f9f9fb","#f0f0f3","#e8e8ec","#e0e1e6","#d9d9e0","#cdced6","#b9bbc6","#8b8d98","#80838d","#60646c","#1c2024"],
  slateDark: ["#111113","#18191b","#212225","#272a2d","#2e3135","#363a3f","#43484e","#5a6169","#696e77","#777b84","#b0b4ba","#edeef0"],
  sand: ["#fdfdfc","#f9f9f8","#f1f0ef","#e9e8e6","#e2e1de","#dad9d6","#cfceca","#bcbbb5","#8d8d86","#82827c","#63635e","#21201c"],
  mauveDark: ["#121113","#1a191b","#232225","#2b292d","#323035","#3c393f","#49474e","#625f69","#6f6d78","#7c7a85","#b5b2bc","#eeeef0"],
  gold: ["#fdfdfc","#faf9f2","#f2f0e7","#eae6db","#e1dccf","#d8d0bf","#cbc0aa","#b9a88d","#978365","#8c7a5e","#71624b","#3b352b"],
  teal: ["#fafefd","#f3fbf9","#e0f8f3","#ccf3ea","#b8eae0","#a1ded2","#83cdc1","#53b9ab","#12a594","#0d9b8a","#008573","#0d3d38"],
  cyanDark: ["#0b161a","#101b20","#082c36","#003848","#004558","#045468","#12677e","#11809c","#00a2c7","#23afd0","#4ccce6","#b6ecf7"],
  violet: ["#fdfcfe","#faf8ff","#f4f0fe","#ebe4ff","#e1d9ff","#d4cafe","#c2b5f5","#aa99ec","#6e56cf","#654dc4","#6550b9","#2f265f"],
  violetDark: ["#14121f","#1b1525","#291f43","#33255b","#3c2e69","#473876","#56468b","#6958ad","#6e56cf","#7d66d9","#baa7ff","#e2ddfe"],
  blue: ["#fbfdff","#f4faff","#e6f4fe","#d5efff","#c2e5ff","#acd8fc","#8ec8f6","#5eb1ef","#0090ff","#0588f0","#0d74ce","#113264"],
  blueDark: ["#0d1520","#111927","#0d2847","#003362","#004074","#104d87","#205d9e","#2870bd","#0090ff","#3b9eff","#70b8ff","#c2e6ff"],
  pinkDark: ["#191117","#21121d","#37172f","#4b143d","#591c47","#692955","#833869","#a84885","#d6409f","#de51a8","#ff8dcc","#fdd1ea"],
  red: ["#fffcfc","#fff7f7","#feebec","#ffdbdc","#ffcdce","#fdbdbe","#f4a9aa","#eb8e90","#e5484d","#dc3e42","#ce2c31","#641723"],
  redDark: ["#191111","#201314","#3b1219","#500f1c","#611623","#72232d","#8c333a","#b54548","#e5484d","#ec5d5e","#ff9592","#ffd1d9"],
  green: ["#fbfefc","#f4fbf6","#e6f6eb","#d6f1df","#c4e8d1","#adddc0","#8eceaa","#5bb98b","#30a46c","#2b9a66","#218358","#193b2d"],
  greenDark: ["#0e1512","#121b17","#132d21","#113b29","#174933","#20573e","#28684a","#2f7c57","#30a46c","#33b074","#3dd68c","#b1f1cb"],
  amber: ["#fefdfb","#fefbe9","#fff7c2","#ffee9c","#fbe577","#f3d673","#e9c162","#e2a336","#ffc53d","#ffba18","#ab6400","#4f3422"],
  amberDark: ["#16120c","#1d180f","#302008","#3f2700","#4d3000","#5c3d05","#714f19","#8f6424","#ffc53d","#ffd60a","#ffca16","#ffe7b3"],
  orange: ["#fefcfb","#fff7ed","#ffefd6","#ffdfb5","#ffd19a","#ffc182","#f5ae73","#ec9455","#f76b15","#ef5f00","#cc4e00","#582d1d"],
  orangeDark: ["#17120e","#1e160f","#331e0b","#462100","#562800","#66350c","#7e451d","#a35829","#f76b15","#ff801f","#ffa057","#ffe0c2"],
  purple: ["#fefcfe","#fbf7fe","#f7edfe","#f2e2fc","#ead5f9","#e0c4f4","#d1afec","#be93e4","#8e4ec6","#8347b9","#8145b5","#402060"],
  purpleDark: ["#18111b","#1e1523","#301c3b","#3d224e","#48295c","#54346b","#664282","#8457aa","#8e4ec6","#9a5cd0","#d19dff","#ecd9fa"],
} as const;
type Scale = readonly string[];

function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

function seed(neutral: Scale, accent: Scale, secondary: Scale, scheme: "light" | "dark", monochrome = false) {
  const dark = scheme === "dark";
  const foreground = dark ? neutral[0] : "#FFFFFF";
  const primary = monochrome ? neutral[11] : contrast(accent[10], foreground) >= 4.5 ? accent[10] : accent[11];
  const primaryHover = monochrome ? neutral[10] : accent[11];
  const accentText = monochrome ? neutral[11] : contrast(accent[10], accent[2]) >= 4.5 ? accent[10] : accent[11];
  const secondaryText = contrast(secondary[10], secondary[2]) >= 4.5 ? secondary[10] : secondary[11];
  return {
    scheme, page: monochrome ? "#FFFFFF" : neutral[0], surface: neutral[1], raised: dark ? neutral[1] : "#FFFFFF",
    subtle: neutral[2], hover: neutral[3], sidebar: monochrome ? "#FFFFFF" : dark ? neutral[0] : neutral[1],
    text: neutral[11], muted: neutral[10], faint: neutral[10], line: neutral[5], control: neutral[9],
    primary, onPrimary: foreground, primaryHover, primaryActive: monochrome ? neutral[11] : accent[11],
    accent: accentText, accentSoft: accent[2], link: accentText, focus: accentText,
    secondaryAccent: secondaryText, secondarySoft: secondary[2],
  };
}

const themeSeeds = {
  white: { label: "화이트", description: "화이트와 잉크", ...seed(radix.gray, radix.gray, radix.gray, "light", true) },
  beige: { label: "베이지", description: "샌드와 골드", ...seed(radix.sand, radix.gold, radix.teal, "light") },
  gray: { label: "그레이", description: "슬레이트와 청록", ...seed(radix.slate, radix.teal, radix.violet, "light") },
  dark: { label: "다크", description: "차콜과 블루", ...seed(radix.grayDark, radix.blueDark, radix.violetDark, "dark") },
  neon: { label: "네온", description: "슬레이트와 시안", ...seed(radix.slateDark, radix.cyanDark, radix.violetDark, "dark") },
  cyberpunk: { label: "사이버펑크", description: "모브와 핑크", ...seed(radix.mauveDark, radix.pinkDark, radix.cyanDark, "dark") },
} as const;

export type ThemeMode = keyof typeof themeSeeds;
export type ColorScheme = "light" | "dark";
type Seed = (typeof themeSeeds)[ThemeMode];

function colors(seed: Seed, mode: ThemeMode) {
  const dark = seed.scheme === "dark";
  const danger = dark ? radix.redDark : radix.red;
  const semantic = (name: "red" | "green" | "amber" | "blue" | "purple" | "orange") => {
    const palette = radix[dark ? `${name}Dark` as const : name];
    return { fg: contrast(palette[10], palette[2]) >= 4.5 ? palette[10] : palette[11], bg: palette[2] };
  };
  return {
    "text-primary": seed.text, "text-secondary": seed.muted, "text-tertiary": seed.faint,
    "text-link": seed.link, "icon-default": seed.muted,
    "bg-page": seed.page, "bg-surface": seed.surface, "bg-raised": seed.raised,
    "bg-subtle": seed.subtle, "bg-hover": seed.hover, "bg-sidebar": seed.sidebar,
    "border-default": seed.line, "border-control": seed.control,
    "button-primary-bg": seed.primary, "button-primary-fg": seed.onPrimary,
    "button-primary-hover-bg": seed.primaryHover, "button-primary-hover-fg": seed.onPrimary,
    "button-primary-active-bg": seed.primaryActive, "button-primary-active-fg": seed.onPrimary,
    "button-secondary-bg": seed.raised, "button-secondary-fg": seed.text,
    "button-secondary-hover-bg": seed.hover, "button-secondary-hover-fg": seed.text,
    "button-secondary-active-bg": seed.subtle, "button-secondary-active-fg": seed.text,
    "button-ghost-bg": "transparent", "button-ghost-fg": seed.muted,
    "button-ghost-hover-bg": seed.hover, "button-ghost-hover-fg": seed.text,
    "button-ghost-active-bg": seed.subtle, "button-ghost-active-fg": seed.text,
    "button-disabled-bg": seed.subtle, "button-disabled-fg": seed.faint,
    "button-danger-bg": danger[10], "button-danger-fg": seed.onPrimary,
    "button-danger-hover-bg": danger[11], "button-danger-active-bg": danger[11],
    "input-bg": seed.raised, "input-fg": seed.text, "input-placeholder": seed.faint,
    "menu-bg": seed.raised, "menu-fg": seed.text, "modal-bg": seed.raised,
    "toast-bg": seed.text, "toast-fg": seed.page,
    "selected-bg": seed.accentSoft, "selected-fg": seed.accent,
    "accent-fg": seed.accent, "accent-secondary": seed.secondaryAccent, "focus-ring": seed.focus,
    "success-fg": semantic("green").fg, "success-bg": semantic("green").bg,
    "warning-fg": semantic("amber").fg, "warning-bg": semantic("amber").bg,
    "danger-fg": semantic("red").fg, "danger-bg": semantic("red").bg,
    "info-fg": semantic("blue").fg, "info-bg": semantic("blue").bg,
    "purple-fg": semantic("purple").fg, "purple-bg": semantic("purple").bg,
    "orange-fg": semantic("orange").fg, "orange-bg": semantic("orange").bg,
    "neutral-badge-fg": seed.muted, "neutral-badge-bg": seed.subtle,
    "objective-badge-bg": seed.accentSoft, "objective-badge-text": seed.accent,
    "kr-badge-bg": seed.accentSoft, "kr-badge-text": seed.accent, "kr-rail": seed.accent,
    "initiative-badge-bg": seed.secondarySoft, "initiative-badge-text": seed.secondaryAccent, "initiative-rail": seed.secondaryAccent,
    "project-badge-bg": seed.subtle, "project-badge-text": seed.accent,
    "progress-fill": seed.accent, "progress-track": seed.subtle, "progress-text": seed.accent,
    "overlay-backdrop": dark ? "rgba(0, 0, 0, .66)" : "rgba(25, 28, 33, .34)",
    "shadow-raised": dark ? "0 1px 3px rgba(0, 0, 0, .22)" : "0 1px 3px rgba(25, 28, 33, .06)",
    "shadow-overlay": dark ? "0 20px 56px rgba(0, 0, 0, .42)" : "0 18px 48px rgba(25, 28, 33, .18)",
    "selection-glow": mode === "cyberpunk" ? `0 0 10px color-mix(in srgb, ${seed.accent} 18%, transparent)` : "none",
    "skeleton-bg": seed.subtle,
  };
}

// Backwards-compatible semantic aliases. Text tokens are never action fills.
const aliases = {
  ink: "text-primary", muted: "text-secondary", faint: "text-tertiary",
  paper: "bg-page", surface: "bg-surface", raised: "bg-raised", sidebar: "bg-sidebar",
  "surface-muted": "bg-subtle", "surface-hover": "bg-hover", hover: "bg-hover",
  line: "border-default", "line-strong": "border-control",
  accent: "accent-fg", "accent-strong": "accent-fg", "accent-soft": "selected-bg",
  blue: "info-fg", red: "danger-fg", green: "success-fg", focus: "focus-ring",
  "okr-card-bg": "bg-raised", "okr-card-border": "border-default",
  "kr-hover": "bg-hover", "initiative-hover": "bg-hover",
} as const;

export const THEMES = (Object.keys(themeSeeds) as ThemeMode[]).map((mode) => ({
  mode,
  label: themeSeeds[mode].label,
  description: themeSeeds[mode].description,
  colorScheme: themeSeeds[mode].scheme as ColorScheme,
  tokens: colors(themeSeeds[mode], mode),
}));

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && Object.hasOwn(themeSeeds, value);
}

export function themeColorScheme(value: unknown): ColorScheme {
  return themeSeeds[isThemeMode(value) ? value : DEFAULT_THEME].scheme;
}

export const themeCss = THEMES.map(({ mode, colorScheme, tokens }) => {
  const selectors = `${mode === DEFAULT_THEME ? ":root, " : ""}html[data-theme="${mode}"], [data-theme-preview="${mode}"]`;
  const entries = Object.entries(tokens).map(([key, value]) => `--${key}:${value};`).join("");
  const legacy = Object.entries(aliases).map(([key, value]) => `--${key}:var(--${value});`).join("");
  return `${selectors}{color-scheme:${colorScheme};${entries}${legacy}}`;
}).join("\n");

// This runs before the body paints and migrates the previous brand's preference.
export const themeBootstrapScript = `(() => {
  const schemes = ${JSON.stringify(Object.fromEntries(THEMES.map(({ mode, colorScheme }) => [mode, colorScheme])))};
  let theme = ${JSON.stringify(DEFAULT_THEME)};
  try {
    const currentKey = ${JSON.stringify(THEME_STORAGE_KEY)};
    const saved = window.localStorage.getItem(currentKey);
    const legacy = window.localStorage.getItem(${JSON.stringify(LEGACY_THEME_STORAGE_KEY)});
    const preference = saved || legacy;
    if (Object.prototype.hasOwnProperty.call(schemes, preference)) {
      theme = preference;
      if (!saved && legacy) window.localStorage.setItem(currentKey, legacy);
    }
  } catch {}
  const root = document.documentElement;
  root.dataset.themePreference = theme;
  root.dataset.theme = theme;
  root.style.colorScheme = schemes[theme];
})();`;
