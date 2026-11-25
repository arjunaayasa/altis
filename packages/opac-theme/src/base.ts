// Base OPAC design tokens, named accents, and shared typography/button primitives.
// Visual rationale (R-31):
// - Palette: warm archival paper neutrals (#faf9f5 / #f2efe8 light, #141615 / #1c1f1d dark) + 1 library accent (R-29).
// - Control borders (`--border-strong`) hold >= 3:1 non-text contrast against surfaces in both schemes (WCAG 1.4.11).
// - Typography: Plus Jakarta Sans for Indonesian/English legibility, fluid headings, tabular numerals for call numbers/counts.
// - Radius: 4px controls (`--radius-sm`), 6px surfaces/photos (`--radius`) so inputs, buttons, and cards keep distinct roles (R-11).
// - Elevation: flat surfaces by default; shadows reserved only for the home search dock (`--shadow-dock`) and mobile menu (`--shadow-pop`) (R-12).
// - Nothing external is fetched (`no @import`, `no url()`); CSP permits only same-origin assets and `data:` icons.

import { hexRgb, oklchHex, rgbToOklch } from './color.js';
import { OPAC_FONT_STACK } from './fonts.js';

export const ACCENTS = Object.freeze(['teal', 'blue', 'green', 'purple', 'red', 'slate'] as const);

export type AccentName = (typeof ACCENTS)[number];

export const DEFAULT_ACCENT: AccentName = 'teal';

/** Default accent stored by a fresh installation; existing installations keep `DEFAULT_ACCENT`. */
export const FRESH_INSTALL_ACCENT: AccentName = 'blue';

export function isAccent(s: unknown): s is AccentName {
  return typeof s === 'string' && (ACCENTS as readonly string[]).includes(s);
}

/** Accent colours per scheme, each verified >= 4.5:1 on both `--bg` and `--layer`. */
export const ACCENT_COLORS: Readonly<Record<AccentName, { light: string; dark: string }>> = Object.freeze({
  teal: { light: '#0d6e66', dark: '#2dd4bf' },
  blue: { light: oklchHex(0.48, 0.14, 255), dark: oklchHex(0.72, 0.12, 255) },
  green: { light: '#147536', dark: '#4ade80' },
  purple: { light: '#761fc2', dark: '#c084fc' },
  red: { light: '#b01a1a', dark: '#f87171' },
  slate: { light: '#334155', dark: '#cbd5e1' },
});

/** Solid fallback surface for a hero without photos (`--on-panel` white >= 4.5:1). */
export const PANEL_COLORS: Readonly<Record<AccentName, { light: string; dark: string }>> = Object.freeze(
  Object.fromEntries(
    (
      [
        ['teal', 185, 0.06],
        ['blue', 255, 0.06],
        ['green', 150, 0.06],
        ['purple', 305, 0.06],
        ['red', 25, 0.07],
        ['slate', 255, 0.02],
      ] as const
    ).map(([name, hue, chroma]) => [name, { light: ACCENT_COLORS[name].light, dark: oklchHex(0.32, chroma, hue) }]),
  ) as Record<AccentName, { light: string; dark: string }>,
);

/** Neutral, status, and footer tokens per scheme (all text >= 4.5:1, control borders >= 3.0:1). */
export const SCHEME_COLORS = Object.freeze({
  light: Object.freeze({
    bg: '#faf9f5',
    layer: '#f2efe8',
    layer2: '#e6e2d8',
    text: '#1b1f1d',
    muted: '#525a56',
    faint: '#5e6762',
    border: '#dedad0',
    borderStrong: '#737b76',
    ok: '#196941',
    warn: '#784e00',
    danger: '#a1241c',
    okBg: '#e6f2eb',
    warnBg: '#f8eed6',
    footBg: '#191c1a',
    footText: '#eceae4',
    footMuted: '#b0ada4',
    footLine: '#313633',
  }),
  dark: Object.freeze({
    bg: '#141615',
    layer: '#1c1f1d',
    layer2: '#242826',
    text: '#eceae4',
    muted: '#aba89f',
    faint: '#9a978e',
    border: '#2e3330',
    borderStrong: '#7e8681',
    ok: '#74c79a',
    warn: '#e2b75e',
    danger: '#f0938b',
    okBg: '#16291f',
    warnBg: '#2c2513',
    footBg: '#0d0f0e',
    footText: '#eceae4',
    footMuted: '#b0ada4',
    footLine: '#282d2a',
  }),
});

function shade(hex: string, by: number): string {
  const [l, c, h] = rgbToOklch(hexRgb(hex));
  return oklchHex(Math.min(1, Math.max(0, l + by)), c, h);
}

function accentTokens(name: AccentName, scheme: 'light' | 'dark'): string {
  const accent = ACCENT_COLORS[name][scheme];
  const hover = shade(accent, scheme === 'light' ? -0.07 : 0.06);
  return `--accent:${accent};--accent-hover:${hover};--panel:${scheme === 'light' ? PANEL_COLORS[name].light : PANEL_COLORS[name].dark}`;
}

const accentBlocks = (scheme: 'light' | 'dark', prefix = ''): string =>
  ACCENTS.map((name) => `${prefix}[data-accent=${name}]{${accentTokens(name, scheme)}}`).join('');

function schemeTokens(scheme: 'light' | 'dark'): string {
  const c = SCHEME_COLORS[scheme];
  const surface = scheme === 'light' ? '#ffffff' : '#191c1a';
  return (
    `--bg:${c.bg};--surface:${surface};--layer:${c.layer};--layer-2:${c.layer2};--text:${c.text};--muted:${c.muted};--faint:${c.faint};` +
    `--border:${c.border};--border-strong:${c.borderStrong};--ok:${c.ok};--warn:${c.warn};--danger:${c.danger};` +
    `--ok-bg:${c.okBg};--warn-bg:${c.warnBg};` +
    `--foot-bg:${c.footBg};--foot-text:${c.footText};--foot-muted:${c.footMuted};--foot-line:${c.footLine};` +
    `${accentTokens(DEFAULT_ACCENT, scheme)};--on-panel:#ffffff;` +
    `--accent-ink:${scheme === 'light' ? '#ffffff' : c.bg};--map-shelf:${scheme === 'light' ? '#94a3b8' : '#475569'}`
  );
}

export const BASE_CSS: string = [
  `:root{color-scheme:light;${schemeTokens('light')};` +
    `--font:${OPAC_FONT_STACK};--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;` +
    '--gutter:1.5rem;--measure:42.5rem;--wide:75rem;--radius:6px;--radius-sm:4px;' +
    '--focus:var(--accent);--accent-soft:color-mix(in srgb,var(--accent) 9%,var(--bg));--card-bg:var(--surface);' +
    '--card-border:var(--border);--card-shadow:none;--facet-bg:var(--surface);' +
    '--map-bg:var(--surface);--map-highlight:var(--accent);--shadow-dock:0 12px 32px rgb(16 20 18/.09);--shadow-pop:0 10px 28px rgb(0 0 0/.16)}',
  accentBlocks('light'),
  `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;${schemeTokens('dark')};--shadow-dock:0 14px 36px rgb(0 0 0/.42);--shadow-pop:0 10px 28px rgb(0 0 0/.55)}` +
    accentBlocks('dark', ':root:not([data-theme=light])') +
    '}',
  `:root[data-theme=dark]{color-scheme:dark;${schemeTokens('dark')};--shadow-dock:0 14px 36px rgb(0 0 0/.42);--shadow-pop:0 10px 28px rgb(0 0 0/.55)}`,
  accentBlocks('dark', ':root[data-theme=dark]'),

  '*,*::before,*::after{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}',
  'body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:400 1rem/1.5 var(--font);' +
    'letter-spacing:0;-webkit-font-smoothing:antialiased}',
  'img{max-width:100%}',
  // Base-layer interaction affordances (R-39): pointer on enabled controls, not-allowed when disabled.
  'a[href],button,summary,select,label[for],input[type=checkbox],input[type=radio],[role=button],[role=tab],[role=switch]{cursor:pointer}',
  'button:disabled,select:disabled,input:disabled,textarea:disabled,[aria-disabled=true]{cursor:not-allowed;opacity:.6}',
  'a{color:var(--accent);text-decoration:none;text-underline-offset:.2em}',
  'a:hover{text-decoration:underline}',
  'a:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:2px}',
  '[hidden]{display:none!important}',

  'main{flex:1;width:100%;min-width:0}',
  '.wrap{width:100%;max-width:calc(var(--wide) + 2*var(--gutter));margin:0 auto;padding-left:var(--gutter);padding-right:var(--gutter)}',
  '.page{padding-top:2rem;padding-bottom:4rem}',
  'h1,h2,h3,h4{font-weight:700;line-height:1.25;text-wrap:balance}',
  'h1{margin:0 0 1rem;font-size:clamp(1.625rem,2vw + 1rem,2rem);line-height:1.2;letter-spacing:-.01em;overflow-wrap:anywhere}',
  'h2{margin:2rem 0 .5rem;font-size:1.25rem}',
  'h3{margin:1.5rem 0 .5rem;font-size:1.0625rem}',
  'p{margin:0 0 1rem;overflow-wrap:anywhere}',
  '.mono{font-family:var(--mono);font-size:.92em}',
  '.muted{color:var(--muted)}',
  '.welcome{white-space:pre-line;font-size:1.125rem}',
  '.notice{padding:.75rem 1rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius)}',
  '.notice h2{margin:0 0 .5rem}',
  '.notice p:last-child{margin-bottom:0}',

  // Buttons meet the 44px (`2.75rem`) minimum tap target with distinct hover and active feedback (R-03, R-39).
  '.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:2.75rem;padding:0 1.125rem;border:1px solid transparent;' +
    'border-radius:var(--radius-sm);font:600 .9375rem/1.2 var(--font);cursor:pointer;text-decoration:none;text-align:center}',
  '.btn:hover{text-decoration:none}',
  '.btn:active{transform:translateY(1px)}',
  '.btn-primary{background:var(--accent);color:var(--accent-ink)}',
  '.btn-primary:hover{background:var(--accent-hover)}',
  '.btn-outline{background:var(--surface);border-color:var(--border-strong);color:var(--text)}',
  '.btn-outline:hover{background:var(--layer);border-color:var(--text)}',
  '.btn-inv{background:#ffffff;color:#141817}',
  '.btn-inv:hover{background:#eceae4;color:#141817}',
  '.btn-inv-outline{border-color:rgb(255 255 255/.72);color:#ffffff}',
  '.btn-inv-outline:hover{background:rgb(255 255 255/.14);border-color:#ffffff}',
  '.btn-sm{min-height:2.5rem;padding:0 .875rem;font-size:.875rem}',
  '.more-link{display:inline-flex;align-items:center;gap:.375rem;min-height:2.25rem;font-weight:600;font-size:.9375rem;white-space:nowrap}',

  'a,button,input,select,summary{transition:background-color .16s ease-out,border-color .16s ease-out,color .16s ease-out,transform .12s ease-out}',
  '@media (prefers-reduced-motion:no-preference){' +
    '@view-transition{navigation:auto}' +
    'html{scroll-behavior:smooth;scroll-padding-top:1.5rem}' +
    'html[data-theme-switching],html[data-theme-switching] body,html[data-theme-switching] .topstrip,' +
    'html[data-theme-switching] .site-header,html[data-theme-switching] .search-band,html[data-theme-switching] .search-join,' +
    'html[data-theme-switching] .section-band,html[data-theme-switching] .site-footer{transition:background-color .22s ease,color .22s ease,border-color .22s ease}' +
    '.nav-progress.is-active{transition:transform 1.8s cubic-bezier(.16,1,.3,1),opacity .12s ease}' +
    '.nav-progress.is-done{transition:transform .16s ease-out,opacity .2s ease .04s}' +
    '.reveal-wait{opacity:0;transform:translateY(14px)}' +
    '.reveal-in{opacity:1;transform:none;transition:opacity .42s cubic-bezier(.22,1,.36,1),transform .42s cubic-bezier(.22,1,.36,1)}' +
    '.card-cover,.card .book-cover,.ddc a,.svc-grid li{transition:transform .22s cubic-bezier(.22,1,.36,1),border-color .16s ease,background-color .16s ease}' +
    '.card:hover .card-cover,.card:hover .book-cover{transform:translateY(-2px)}' +
    '.ddc a:hover{transform:translateY(-1px)}' +
    '}',
  '@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}',
  '@media (max-width:53.74rem){body{font-size:.96875rem}:root{--gutter:1.125rem}.btn-sm,.more-link{min-height:2.75rem}}',
].join('\n');
