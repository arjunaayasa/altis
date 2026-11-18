// The base module of @altis/opac-theme: the tokens, the accents and the page frame every OPAC page shares. Every other
// module writes its CSS with these tokens, and index.ts joins them in a fixed order.
//
// - The visual system: a tidy, restrained library site. One accent (the library colour) on neutral greys; flat colours
//   only (no gradient anywhere), thin 1 px lines rather than shadows (a shadow only under the phone menu), radius 4 px
//   on controls and 6 px on cards and photos, a 4/8 px grid, letter spacing 0 (large headings -0.01em), body 16 px on
//   a line height of 1.5, headings 1.2-1.25. The statuses (`--ok`, `--warn`, `--danger`) always come with words.
// - Layout plus tokens: every colour, the page width and the gutter are custom properties on `:root`. The accent is
//   the token that changes: one of six named accents through the `[data-accent=<name>]` blocks (the attribute is on
//   `<html>`), or the library's own colour, whose tokens the page writes in a style element (brand.ts). The light and
//   dark schemes follow the visitor's system (`prefers-color-scheme`); the dark one is its own set of values.
// - Contrast: each accent is at least 4.5:1 against the page and the second layer as link colour, and the text on an
//   accent background (`--accent-ink`) at least 4.5:1 against the accent, in both schemes. The muted texts and the
//   status colours are at least 4.5:1 on the page and the second layer of their scheme; the focus ring at least 3:1
//   against what it surrounds. The panel of a slide (`--panel`) carries white text at 4.5:1 or more; the footer's
//   texts are at least 4.5:1 on the footer.
// - Nothing is fetched: no @import and no url(). The typeface's `@font-face` rules are not part of these modules
//   (fonts.ts); the CSP allows the app's own origin and `data:` images only.
// - Long words wrap (`overflow-wrap`); a link or button is at least 2.5 rem high where it stands alone.
// - Motion: hover and state changes ease out in 150 ms; none at all when the visitor asks for reduced motion.

import { hexRgb, oklchHex, rgbToOklch } from './color.js';
import { OPAC_FONT_STACK } from './fonts.js';

/** The accent names, the six values of the `opac.accent` setting (Task 8). */
export const ACCENTS = Object.freeze(['teal', 'blue', 'green', 'purple', 'red', 'slate'] as const);

export type AccentName = (typeof ACCENTS)[number];

/** The accent of a library that has not chosen one (the setting's default). */
export const DEFAULT_ACCENT: AccentName = 'teal';

// ---- Komunitas (OPAC look) ----
/**
 * The accent a fresh install starts with: the design's blue, stored by the install itself. The setting's default
 * stays {@link DEFAULT_ACCENT}, so a library installed before keeps the accent it has (chosen or not).
 */
export const FRESH_INSTALL_ACCENT: AccentName = 'blue';

/** True when `s` is one of {@link ACCENTS}; an exact match. */
export function isAccent(s: unknown): s is AccentName {
  return typeof s === 'string' && (ACCENTS as readonly string[]).includes(s);
}

/** `--accent` per scheme: darker on the light page, lighter on the dark one. Blue is the design's one accent. */
export const ACCENT_COLORS: Readonly<Record<AccentName, { light: string; dark: string }>> = Object.freeze({
  teal: { light: '#0f766e', dark: '#2dd4bf' },
  blue: { light: oklchHex(0.48, 0.14, 255), dark: oklchHex(0.72, 0.12, 255) },
  green: { light: '#15803d', dark: '#4ade80' },
  purple: { light: '#7e22ce', dark: '#c084fc' },
  red: { light: '#b91c1c', dark: '#f87171' },
  slate: { light: '#334155', dark: '#cbd5e1' },
});

/**
 * The panel behind a slide's text for each accent when the library set no colour of its own: the accent of the light
 * scheme (white text on it is above 4.5:1), and a deep, muted shade of its hue in the dark scheme.
 */
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

/** The neutral, status and footer colours of each scheme (the values the tests hold to their contrast). */
export const SCHEME_COLORS = Object.freeze({
  light: Object.freeze({
    bg: '#ffffff',
    layer: '#f5f6f6',
    layer2: '#eceeee',
    text: '#1b1f1e',
    muted: '#59625f',
    faint: '#66706c',
    border: '#dde1e0',
    borderStrong: '#bcc3c1',
    ok: '#1b6e45',
    warn: '#7d5200',
    danger: '#a8271f',
    okBg: '#e9f3ed',
    warnBg: '#faf0d9',
    footBg: '#1e2221',
    footText: '#e8ebea',
    footMuted: '#a9b1ae',
    footLine: '#363c3a',
  }),
  dark: Object.freeze({
    bg: '#131615',
    layer: '#1a1e1d',
    layer2: '#222726',
    text: '#e8ebea',
    muted: '#a6aeab',
    faint: '#949c99',
    border: '#2d3331',
    borderStrong: '#454d4a',
    ok: '#74c79a',
    warn: '#e2b75e',
    danger: '#f0938b',
    okBg: '#16291f',
    warnBg: '#2c2513',
    footBg: '#0d0f0f',
    footText: '#e8ebea',
    footMuted: '#a9b1ae',
    footLine: '#2a2f2d',
  }),
});

/** A shade of `hex`: its OKLCH lightness moved by `by`, hue and chroma kept. */
function shade(hex: string, by: number): string {
  const [l, c, h] = rgbToOklch(hexRgb(hex));
  return oklchHex(Math.min(1, Math.max(0, l + by)), c, h);
}

/** The accent tokens of one named accent in one scheme: the accent, its hover shade, and the panel of a slide's text. */
function accentTokens(name: AccentName, scheme: 'light' | 'dark'): string {
  const accent = ACCENT_COLORS[name][scheme];
  const hover = shade(accent, scheme === 'light' ? -0.07 : 0.06);
  return `--accent:${accent};--accent-hover:${hover};--panel:${scheme === 'light' ? PANEL_COLORS[name].light : PANEL_COLORS[name].dark}`;
}

const accentBlocks = (scheme: 'light' | 'dark'): string => ACCENTS.map((name) => `[data-accent=${name}]{${accentTokens(name, scheme)}}`).join('');

/** The colour tokens of one scheme. */
function schemeTokens(scheme: 'light' | 'dark'): string {
  const c = SCHEME_COLORS[scheme];
  return (
    `--bg:${c.bg};--surface:${c.bg};--layer:${c.layer};--layer-2:${c.layer2};--text:${c.text};--muted:${c.muted};--faint:${c.faint};` +
    `--border:${c.border};--border-strong:${c.borderStrong};--ok:${c.ok};--warn:${c.warn};--danger:${c.danger};` +
    `--ok-bg:${c.okBg};--warn-bg:${c.warnBg};` +
    `--foot-bg:${c.footBg};--foot-text:${c.footText};--foot-muted:${c.footMuted};--foot-line:${c.footLine};` +
    `${accentTokens(DEFAULT_ACCENT, scheme)};--on-panel:#ffffff;` +
    `--accent-ink:${scheme === 'light' ? '#ffffff' : c.bg};--map-shelf:${scheme === 'light' ? '#94a3b8' : '#475569'}`
  );
}

/**
 * The base stylesheet. The `:root` tokens come first and the `[data-accent]` blocks after them: both match `<html>`
 * with the same specificity, so the later one wins (and the library colour's style element, after the stylesheet,
 * wins over both).
 */
export const BASE_CSS: string = [
  // Tokens.
  `:root{color-scheme:light dark;${schemeTokens('light')};` +
    `--font:${OPAC_FONT_STACK};--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;` +
    '--gutter:1.5rem;--measure:42.5rem;--wide:75rem;--radius:6px;--radius-sm:4px;' +
    '--focus:var(--accent);--accent-soft:color-mix(in srgb,var(--accent) 9%,var(--bg));--card-bg:var(--surface);' +
    '--card-border:var(--border);--card-shadow:none;--facet-bg:var(--surface);' +
    '--map-bg:var(--surface);--map-highlight:var(--accent);--shadow-pop:0 8px 24px rgb(0 0 0/.14)}',
  accentBlocks('light'),
  `@media (prefers-color-scheme:dark){:root{${schemeTokens('dark')};--shadow-pop:0 8px 24px rgb(0 0 0/.5)}` + accentBlocks('dark') + '}',

  // Layout.
  '*,*::before,*::after{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}',
  'body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:400 1rem/1.5 var(--font);' +
    'letter-spacing:0;-webkit-font-smoothing:antialiased}',
  'img{max-width:100%}',
  'a{color:var(--accent);text-decoration:none;text-underline-offset:.2em}',
  'a:hover{text-decoration:underline}',
  'a:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:2px}',
  '[hidden]{display:none!important}',

  // The page: `<main>` spans the window, so that a band (the hero, a page head, a section in the second layer) can
  // too; `.wrap` is the content's width with its gutters, `.page` the room above and below a plain page.
  'main{flex:1;width:100%;min-width:0}',
  '.wrap{width:100%;max-width:calc(var(--wide) + 2*var(--gutter));margin:0 auto;padding-left:var(--gutter);padding-right:var(--gutter)}',
  '.page{padding-top:2rem;padding-bottom:4rem}',
  'h1,h2,h3,h4{font-weight:700;line-height:1.25;text-wrap:balance}',
  'h1{margin:0 0 1rem;font-size:1.875rem;line-height:1.2;letter-spacing:-.01em;overflow-wrap:anywhere}',
  'h2{margin:2rem 0 .5rem;font-size:1.25rem}',
  'h3{margin:1.5rem 0 .5rem;font-size:1.0625rem}',
  'p{margin:0 0 1rem;overflow-wrap:anywhere}',
  '.mono{font-family:var(--mono);font-size:.92em}',
  '.muted{color:var(--muted)}',
  '.welcome{white-space:pre-line;font-size:1.125rem}',
  '.notice{padding:.75rem 1rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius)}',
  '.notice h2{margin:0 0 .5rem}',
  '.notice p:last-child{margin-bottom:0}',

  // Buttons: 40 px high, flat; the primary one in the accent, the outline one a thin line.
  '.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:2.5rem;padding:0 1rem;border:1px solid transparent;' +
    'border-radius:var(--radius-sm);font:600 .9375rem/1.2 var(--font);cursor:pointer;text-decoration:none;text-align:center}',
  '.btn:hover{text-decoration:none}',
  '.btn-primary{background:var(--accent);color:var(--accent-ink)}',
  '.btn-primary:hover{background:var(--accent-hover)}',
  '.btn-outline{background:var(--bg);border-color:var(--border-strong);color:var(--text)}',
  '.btn-outline:hover{border-color:var(--text)}',
  '.btn-inv{background:#fff;color:var(--panel)}',
  '.btn-inv-outline{border-color:rgb(255 255 255/.6);color:#fff}',
  '.btn-inv-outline:hover{border-color:#fff}',
  '.btn-sm{min-height:2.125rem;padding:0 .75rem;font-size:.875rem}',
  '.more-link{font-weight:600;font-size:.9375rem;white-space:nowrap}',

  // Motion: state changes only, and none when the visitor asks for less.
  'a,button,input,select{transition:background-color .15s ease-out,border-color .15s ease-out,color .15s ease-out}',
  '@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}',
  '@media (max-width:53.74rem){body{font-size:.96875rem}}',
].join('\n');
