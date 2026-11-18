// The base module of @altis/opac-theme (Phase 2 Task 3, S16: the 1b stylesheet moved here): the tokens, the accents
// and the page frame every OPAC page shares (the dark header bar in the library's colour, the search band, the dark
// footer). Every other module writes its CSS with these tokens, and index.ts joins them in a fixed order.
//
// - The visual system: calm, dense and easy to scan. Neutrals carry almost everything; the accent is only for links,
//   actions, the selection and focus; the statuses (`--ok`, `--warn`, `--danger`) always come with words. No gradient,
//   no blur, no shadow except on the floating search card. Radius 6 px on controls, 8 px on containers; 1 px lines.
// - Layout plus tokens: every colour, the page width and the gutter are custom properties on `:root`; a library's
//   accent is the one token that changes, through the `[data-accent=<name>]` blocks (the `data-accent` attribute is on
//   `<html>`). The light and dark schemes follow the visitor's system (`prefers-color-scheme`); the dark one is its own
//   set of values (darker canvas, a darker second layer, lighter lines and accent), not an inversion.
// - Contrast: each accent is at least 4.5:1 against the page and the second layer as link colour, and the text on an
//   accent background (`--accent-ink`) at least 4.5:1 against the accent, in both schemes. The muted texts and the
//   status colours are at least 4.5:1 on the page and the second layer of their scheme; the focus ring (the accent, or
//   white on the dark bars) at least 3:1 against what it surrounds. The header bar's text is white on the library's
//   colour (at least 4.5:1, the setting refuses less) or on the deep default of each accent; the footer's texts are at
//   least 4.5:1 on the footer.
// - Nothing is fetched: no @import and no url(). The typeface's `@font-face` rules are not part of these modules
//   (fonts.ts); the CSP allows the app's own origin and `data:` images only.
// - Mobile first: one column, a 1 rem gutter, long words wrap (`overflow-wrap`), targets are at least 2.75 rem high.
// - Motion: hover and state changes ease out in 150 ms; none at all when the visitor asks for reduced motion.

import { oklchHex } from './color.js';
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
 * The header bar's colour of each accent when the library set no colour of its own: a deep, muted shade of the
 * accent's hue (white text on it is above 12:1), a step darker in the dark scheme.
 */
export const BAR_COLORS: Readonly<Record<AccentName, { light: string; dark: string }>> = Object.freeze(
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
    ).map(([name, hue, chroma]) => [name, { light: oklchHex(0.3, chroma, hue), dark: oklchHex(0.25, chroma * 0.7, hue) }]),
  ) as Record<AccentName, { light: string; dark: string }>,
);

/** The neutral, status and footer colours of each scheme (the values the tests hold to their contrast). */
export const SCHEME_COLORS = Object.freeze({
  light: Object.freeze({
    bg: '#ffffff',
    layer: oklchHex(0.976, 0.004, 255),
    layer2: oklchHex(0.952, 0.006, 255),
    text: oklchHex(0.23, 0.015, 255),
    muted: oklchHex(0.44, 0.014, 255),
    faint: oklchHex(0.54, 0.012, 255),
    border: oklchHex(0.91, 0.006, 255),
    borderStrong: oklchHex(0.82, 0.01, 255),
    ok: oklchHex(0.46, 0.11, 150),
    warn: oklchHex(0.47, 0.1, 65),
    danger: oklchHex(0.5, 0.17, 25),
    footBg: oklchHex(0.24, 0.02, 255),
    footText: oklchHex(0.94, 0.006, 255),
    footMuted: oklchHex(0.76, 0.014, 255),
  }),
  dark: Object.freeze({
    bg: oklchHex(0.205, 0.008, 255),
    layer: oklchHex(0.18, 0.008, 255),
    layer2: oklchHex(0.255, 0.01, 255),
    text: oklchHex(0.94, 0.005, 255),
    muted: oklchHex(0.78, 0.01, 255),
    faint: oklchHex(0.68, 0.01, 255),
    border: oklchHex(0.3, 0.01, 255),
    borderStrong: oklchHex(0.41, 0.012, 255),
    ok: oklchHex(0.8, 0.11, 150),
    warn: oklchHex(0.84, 0.1, 82),
    danger: oklchHex(0.78, 0.12, 25),
    footBg: oklchHex(0.15, 0.008, 255),
    footText: oklchHex(0.94, 0.006, 255),
    footMuted: oklchHex(0.76, 0.014, 255),
  }),
});

const accentBlocks = (scheme: 'light' | 'dark'): string =>
  ACCENTS.map((name) => `[data-accent=${name}]{--accent:${ACCENT_COLORS[name][scheme]};--hero-bg:${BAR_COLORS[name][scheme]}}`).join('');

/** The colour tokens of one scheme. */
function schemeTokens(scheme: 'light' | 'dark'): string {
  const c = SCHEME_COLORS[scheme];
  return (
    `--bg:${c.bg};--surface:${c.bg};--layer:${c.layer};--layer-2:${c.layer2};--text:${c.text};--muted:${c.muted};--faint:${c.faint};` +
    `--border:${c.border};--border-strong:${c.borderStrong};--ok:${c.ok};--warn:${c.warn};--danger:${c.danger};` +
    `--foot-bg:${c.footBg};--foot-text:${c.footText};--foot-muted:${c.footMuted};` +
    `--accent:${ACCENT_COLORS[DEFAULT_ACCENT][scheme]};--hero-bg:${BAR_COLORS[DEFAULT_ACCENT][scheme]};` +
    `--accent-ink:${scheme === 'light' ? '#ffffff' : c.bg};--map-shelf:${scheme === 'light' ? '#94a3b8' : '#475569'}`
  );
}

/**
 * The base stylesheet (the 1b OPAC_CSS). The `:root` tokens come first and the `[data-accent]` blocks after them: both
 * match `<html>` with the same specificity, so the later one wins.
 */
export const BASE_CSS: string = [
  // Tokens.
  `:root{color-scheme:light dark;${schemeTokens('light')};` +
    `--font:${OPAC_FONT_STACK};` +
    '--gutter:1rem;--measure:42rem;--wide:73.75rem;--radius:.5rem;--radius-sm:.375rem;' +
    // Phase 2 Task 21: the catalogue's shared tokens.
    '--focus:var(--accent);--accent-soft:color-mix(in srgb,var(--accent) 12%,var(--bg));--card-bg:var(--surface);' +
    '--card-border:var(--border);--card-shadow:none;--facet-bg:var(--surface);' +
    '--map-bg:var(--surface);--map-highlight:var(--accent);--shadow-pop:0 10px 30px rgb(15 23 42/.12),0 1px 3px rgb(15 23 42/.08)}',
  accentBlocks('light'),
  `@media (prefers-color-scheme:dark){:root{${schemeTokens('dark')};--shadow-pop:0 10px 30px rgb(0 0 0/.45),0 1px 3px rgb(0 0 0/.3)}` +
    accentBlocks('dark') +
    '}',

  // Layout.
  '*,*::before,*::after{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}',
  'body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:1rem/1.55 var(--font);' +
    '-webkit-font-smoothing:antialiased}',
  'a{color:var(--accent);text-underline-offset:.2em}',
  'a:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:2px}',

  // The header: a bar in the library's colour (the deep shade of its accent by default), white text.
  '.site-header{background:var(--hero-bg);color:#fff;--focus:#fff}',
  '.bar{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem 1.25rem;max-width:var(--wide);margin:0 auto;padding:.625rem var(--gutter)}',
  '.brand{display:inline-flex;align-items:center;min-height:2.75rem;min-width:0;margin-right:auto;font-size:1.0625rem;font-weight:700;' +
    'line-height:1.3;color:#fff;text-decoration:none;overflow-wrap:anywhere}',
  '.brand:hover{text-decoration:underline}',

  // The language switch: the other language's name (the page's own is marked current and not drawn).
  '.lang{display:flex;gap:.25rem}',
  '.lang a{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .625rem;border-radius:var(--radius-sm);color:#fff;' +
    'font-weight:600;font-size:.9375rem;text-decoration:none}',
  '.lang a:hover{text-decoration:underline}',
  '.lang a[aria-current]{display:none}',

  'main{flex:1;width:100%;max-width:var(--wide);margin:0 auto;padding:2rem var(--gutter) 3.5rem}',
  'h1{margin:0 0 1rem;font-size:clamp(1.5rem,1.25rem + 1.2vw,1.875rem);line-height:1.2;letter-spacing:-.01em;overflow-wrap:anywhere;text-wrap:balance}',
  'h2{margin:2rem 0 .5rem;font-size:1.25rem;line-height:1.3;text-wrap:balance}',
  'p{margin:0 0 1rem;overflow-wrap:anywhere}',
  '.welcome{white-space:pre-line;font-size:1.125rem}',
  '.notice{padding:.75rem 1rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius)}',
  '.notice h2{margin:0 0 .5rem}',
  '.notice p:last-child{margin-bottom:0}',

  // The footer: dark in both schemes, the library's contact, links, hours and a search field above a bottom line.
  '.site-footer{margin-top:auto;background:var(--foot-bg);color:var(--foot-muted);font-size:.875rem;--focus:#fff}',
  '.site-footer a{display:inline-flex;align-items:center;min-height:2.75rem;color:var(--foot-text);text-decoration:none}',
  '.site-footer a:hover{text-decoration:underline}',
  '.site-footer .bar{justify-content:flex-start}',

  // Motion: state changes only, and none when the visitor asks for less.
  'a,button,input,select{transition:background-color .15s ease-out,border-color .15s ease-out,color .15s ease-out}',
  '@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}',
  '@media (min-width:40rem){:root{--gutter:1.25rem}}',
].join('\n');
