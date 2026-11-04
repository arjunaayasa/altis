// The base module of @altis/opac-theme (Phase 2 Task 3, S16: the 1b stylesheet moved here): the tokens, the accents
// and the page frame every OPAC page shares. Task 21 (the OPAC shell) owns the shared tokens: besides the 1b colours it
// added the catalogue's (visible focus, cards, facets, the availability statuses, the shelf map) and a wider page for
// result grids (`--wide`; `--measure` stays the reading width). Every other Phase 2 task writes its CSS in its own
// module (shell.ts, pages.ts, search.ts, detail.ts) with these tokens, and index.ts joins them in a fixed order.
//
// - Layout plus tokens: every colour, the page width and the gutter are custom properties on `:root`; a library's
//   accent is the one token that changes, through the `[data-accent=<name>]` blocks (the `data-accent` attribute is on
//   `<html>`). The light and dark schemes follow the visitor's system (`prefers-color-scheme`).
// - Contrast: each accent is at least 4.5:1 against the page and card backgrounds as link and border colour, and the
//   text on an accent background (`--accent-ink`) at least 4.5:1 against the accent, in both schemes. The status
//   colours (`--ok`, `--warn`, `--danger`) are at least 4.5:1 as text on the page and card backgrounds of their scheme;
//   the focus ring (`--focus`, the accent) at least 3:1 against both.
// - Nothing is fetched: no @import, no web font, no url(). The CSP allows the app's own origin and `data:` images only.
// - Mobile first: one column, a 1 rem gutter, long words wrap (`overflow-wrap`), targets are at least 2.75 rem high.

/** The accent names, the six values of the `opac.accent` setting (Task 8). */
export const ACCENTS = Object.freeze(['teal', 'blue', 'green', 'purple', 'red', 'slate'] as const);

export type AccentName = (typeof ACCENTS)[number];

/** The accent of a library that has not chosen one (the setting's default). */
export const DEFAULT_ACCENT: AccentName = 'teal';

/** True when `s` is one of {@link ACCENTS}; an exact match. */
export function isAccent(s: unknown): s is AccentName {
  return typeof s === 'string' && (ACCENTS as readonly string[]).includes(s);
}

/** `--accent` per scheme: darker on the light page, lighter on the dark one. */
const ACCENT_COLORS: Readonly<Record<AccentName, { light: string; dark: string }>> = Object.freeze({
  teal: { light: '#0f766e', dark: '#2dd4bf' },
  blue: { light: '#1d4ed8', dark: '#60a5fa' },
  green: { light: '#15803d', dark: '#4ade80' },
  purple: { light: '#7e22ce', dark: '#c084fc' },
  red: { light: '#b91c1c', dark: '#f87171' },
  slate: { light: '#334155', dark: '#cbd5e1' },
});

const accentBlocks = (scheme: 'light' | 'dark'): string =>
  ACCENTS.map((name) => `[data-accent=${name}]{--accent:${ACCENT_COLORS[name][scheme]}}`).join('');

/**
 * The base stylesheet (the 1b OPAC_CSS). The `:root` tokens come first and the `[data-accent]` blocks after them: both
 * match `<html>` with the same specificity, so the later one wins.
 */
export const BASE_CSS: string = [
  // Tokens.
  ':root{color-scheme:light dark;' +
    '--bg:#f8fafc;--surface:#ffffff;--text:#0f172a;--muted:#475569;--border:#cbd5e1;--accent:#0f766e;--accent-ink:#ffffff;' +
    '--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;' +
    '--gutter:1rem;--measure:42rem;--wide:72rem;--radius:.5rem;' +
    // Phase 2 Task 21: the catalogue's shared tokens.
    '--focus:var(--accent);--card-bg:var(--surface);--card-border:var(--border);--card-shadow:0 1px 2px rgb(15 23 42/.08);' +
    '--facet-bg:var(--surface);--ok:#15803d;--warn:#a16207;--danger:#b91c1c;' +
    '--map-bg:var(--surface);--map-shelf:#94a3b8;--map-highlight:var(--accent)}',
  accentBlocks('light'),
  '@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--surface:#111a2e;--text:#e2e8f0;--muted:#94a3b8;--border:#334155;' +
    '--accent:#2dd4bf;--accent-ink:#0b1220;--card-shadow:none;--ok:#4ade80;--warn:#facc15;--danger:#f87171;--map-shelf:#475569}' +
    accentBlocks('dark') +
    '}',

  // Layout.
  '*,*::before,*::after{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}',
  'body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:1rem/1.6 var(--font)}',
  'a{color:var(--accent);text-underline-offset:.2em}',
  'a:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:2px}',

  '.site-header{background:var(--surface);border-top:4px solid var(--accent);border-bottom:1px solid var(--border)}',
  '.bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem;' +
    'max-width:var(--wide);margin:0 auto;padding:.5rem var(--gutter)}',
  '.brand{display:inline-flex;align-items:center;min-height:2.75rem;min-width:0;font-size:1.125rem;font-weight:700;' +
    'color:var(--text);text-decoration:none;overflow-wrap:anywhere}',
  '.brand:hover{text-decoration:underline}',

  '.lang{display:flex;gap:.5rem}',
  '.lang a{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 1rem;border:1px solid var(--accent);' +
    'border-radius:var(--radius);color:var(--accent);font-weight:600;text-decoration:none}',
  '.lang a:hover{text-decoration:underline}',
  '.lang a[aria-current]{background:var(--accent);color:var(--accent-ink)}',

  'main{flex:1;width:100%;max-width:var(--wide);margin:0 auto;padding:2rem var(--gutter) 3rem}',
  'h1{margin:0 0 1rem;font-size:clamp(1.5rem,1rem + 3vw,2.25rem);line-height:1.2;overflow-wrap:anywhere}',
  'h2{margin:2rem 0 .5rem;font-size:1.25rem;line-height:1.3}',
  'p{margin:0 0 1rem;overflow-wrap:anywhere}',
  '.welcome{white-space:pre-line;font-size:1.125rem}',
  '.notice{padding:1rem 1.25rem;background:var(--surface);border:1px solid var(--border);' +
    'border-left:4px solid var(--accent);border-radius:var(--radius)}',
  '.notice h2{margin:0 0 .5rem}',
  '.notice p:last-child{margin-bottom:0}',

  '.site-footer{border-top:1px solid var(--border);background:var(--surface);color:var(--muted)}',
  '.site-footer .bar{justify-content:flex-start}',
  '.site-footer a{display:inline-flex;align-items:center;min-height:2.75rem}',
].join('\n');
