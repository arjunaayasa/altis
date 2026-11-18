// The `shell` module of @altis/opac-theme: the frame of every page and the components the pages share. The skip link,
// visible focus on every control, the strip above the header (today's hours, telephone, e-mail, language), the header
// (logo, menu, member button; the menu a `<details>` on a narrow screen), the search band, a page's head with its
// breadcrumb, the footer, and the shared components: the substitute cover (`.book-cover`, a flat colour per DDC main
// class with the title, the author and a spine label), title cards, facets (`.facet`), the availability table
// (`.availability` with `.status-*`), the shelf map (`.shelf-map`), section heads and `.prose` for long text. Every
// colour from base.ts's tokens (AA contrast in both schemes), nothing fetched, no gradient.

import { oklchHex } from './color.js';

/** The substitute cover's classes: the ten DDC main classes `0`-`9`, then `x` for a title without a class. */
export const COVER_CLASSES = Object.freeze(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'x'] as const);

export type CoverClass = (typeof COVER_CLASSES)[number];

/** The hue (OKLCH degrees) of each main class's cloth; a title without a class is a near-neutral grey. */
const COVER_HUES: Readonly<Record<CoverClass, number>> = Object.freeze({
  '0': 255,
  '1': 300,
  '2': 150,
  '3': 230,
  '4': 25,
  '5': 195,
  '6': 55,
  '7': 345,
  '8': 70,
  '9': 120,
  x: 255,
});

type CoverPalette = Readonly<Record<CoverClass, { bg: string; ink: string; sub: string }>>;

function palette(lightness: number, chroma: number): CoverPalette {
  return Object.freeze(
    Object.fromEntries(
      COVER_CLASSES.map((cls) => {
        const hue = COVER_HUES[cls];
        const c = cls === 'x' ? 0.012 : chroma;
        return [cls, { bg: oklchHex(lightness, c, hue), ink: oklchHex(0.97, 0.01, hue), sub: oklchHex(0.88, 0.02, hue) }];
      }),
    ) as Record<CoverClass, { bg: string; ink: string; sub: string }>,
  );
}

/**
 * The substitute cover's colours per class and scheme: the cloth (`bg`, a muted mid-dark tone), the title (`ink`) and
 * the author (`sub`), both light tints of the same hue. The title is above 6.5:1 and the author above 5:1 on the cloth
 * in both schemes; the spine label is a paper label with near-black text whatever the scheme.
 */
export const COVER_COLORS: Readonly<Record<'light' | 'dark', CoverPalette>> = Object.freeze({
  light: palette(0.44, 0.065),
  dark: palette(0.4, 0.06),
});

/** The spine label's paper and print. */
export const SPINE_LABEL_COLORS = Object.freeze({ bg: oklchHex(0.98, 0.005, 90), text: oklchHex(0.2, 0.01, 255) });

const coverBlocks = (scheme: 'light' | 'dark'): string =>
  COVER_CLASSES.map((cls) => {
    const c = COVER_COLORS[scheme][cls];
    return `.cover-${cls}{--cover:${c.bg};--cover-ink:${c.ink};--cover-sub:${c.sub}}`;
  }).join('');

/** The CSS of the OPAC shell. */
export const SHELL_CSS: string = [
  // Skip link: off screen until focused, then on top of the header.
  '.skip-link{position:absolute;left:.5rem;top:-10rem;z-index:50;padding:.5rem .75rem;background:var(--bg);color:var(--text);font-weight:600;' +
    'border:1px solid var(--border-strong);border-radius:var(--radius-sm);text-decoration:none}',
  '.skip-link:focus{top:.5rem}',
  'main:focus{outline:none}',
  '.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
    'clip:rect(0,0,0,0);white-space:nowrap;border:0}',
  '.ico{width:1.125rem;height:1.125rem;flex:none;vertical-align:-.1875rem}',

  // Visible focus on every control (base.ts gives links theirs; this makes it the same everywhere).
  'a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,' +
    'summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}',

  // The strip above the header: today's hours, the telephone number and e-mail address, the language switch.
  '.topstrip{background:var(--layer);border-bottom:1px solid var(--border);font-size:.84375rem;color:var(--muted)}',
  '.topstrip .wrap{display:flex;align-items:center;gap:1.5rem;min-height:2.25rem}',
  '.topstrip a{color:inherit}',
  '.topstrip .ico{width:.875rem;height:.875rem;vertical-align:-.125rem;margin-right:.25rem}',
  '.top-today{white-space:nowrap}',
  '.open-dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--ok);margin-right:.375rem}',
  '.open-dot-off{background:var(--border-strong)}',
  '.lang{display:flex;align-items:center;margin-left:auto}',
  '.lang a{display:inline-flex;align-items:center;min-height:2.25rem;padding:0 .375rem}',
  '.lang a+a{border-left:1px solid var(--border-strong);padding-left:.75rem;margin-left:.375rem;min-height:0;line-height:1.1}',
  '.lang a[aria-current]{color:var(--text);font-weight:600}',

  // The header: the logo (or the site's name), the menu with a line under the current entry, the member button.
  '.site-header{border-bottom:1px solid var(--border);background:var(--bg)}',
  '.site-header .wrap{display:flex;align-items:center;gap:2.5rem;min-height:4.25rem}',
  '.sitelogo{display:flex;align-items:center;gap:.75rem;flex:none;min-width:0;max-width:60%;color:var(--text)}',
  '.sitelogo:hover{text-decoration:none}',
  '.sitelogo img{display:block;height:2.5rem;width:auto;max-width:15rem}',
  '.sitename{font-weight:700;font-size:1.0625rem;line-height:1.25;color:var(--text);overflow-wrap:anywhere}',
  // A logo without a version for dark backgrounds stands on a small white plate wherever the background is dark.
  '.logo-plate-on{background:#fff;padding:.25rem .375rem;border-radius:var(--radius-sm);box-sizing:content-box}',
  '@media (prefers-color-scheme:dark){.logo-plate{background:#fff;padding:.25rem .375rem;border-radius:var(--radius-sm);box-sizing:content-box}}',
  '.mainnav{display:flex;gap:1.75rem;align-self:stretch;min-width:0}',
  '.mainnav a{display:flex;align-items:center;color:var(--text);font-size:.9375rem;font-weight:500;border-bottom:2px solid transparent;' +
    'border-top:2px solid transparent;white-space:nowrap}',
  '.mainnav a:hover{text-decoration:none;color:var(--accent)}',
  '.mainnav a[aria-current]{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}',
  '.head-actions{margin-left:auto;display:flex;align-items:center;gap:.5rem;flex:none}',
  '.mobnav{display:none;position:relative}',
  '.mobnav summary{list-style:none;display:grid;place-items:center;width:2.5rem;height:2.5rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);cursor:pointer;color:var(--text)}',
  '.mobnav summary::-webkit-details-marker{display:none}',
  '.mobnav nav{position:absolute;right:0;top:3rem;z-index:20;width:15rem;background:var(--bg);border:1px solid var(--border-strong);' +
    'border-radius:var(--radius);box-shadow:var(--shadow-pop);padding:.5rem}',
  '.mobnav nav a{display:block;padding:.625rem .75rem;color:var(--text);border-radius:var(--radius-sm)}',
  '.mobnav nav a[aria-current]{color:var(--accent);font-weight:600}',

  // The search band under the header: the second layer, the search form across the page.
  '.search-band{background:var(--layer);border-bottom:1px solid var(--border);padding:1.25rem 0}',
  '.search-label{display:block;font-weight:600;font-size:.9375rem;margin-bottom:.5rem}',
  '.search-row{display:flex;gap:.5rem}',
  '.search-join{display:flex;flex:1;min-width:0;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--bg)}',
  '.search-join:focus-within{outline:2px solid var(--focus);outline-offset:1px}',
  '.search-join select,.search-join input{border:0;border-radius:var(--radius-sm);background:none;color:var(--text);font:400 1rem var(--font);' +
    'height:2.75rem;padding:0 .75rem;min-width:0}',
  '.search-join select{border-right:1px solid var(--border);border-radius:var(--radius-sm) 0 0 var(--radius-sm);flex:none;width:10.5rem}',
  '.search-join input{flex:1}',
  '.search-join select:focus-visible,.search-join input:focus-visible{outline:none}',
  '.search-box input::placeholder{color:var(--faint);opacity:1}',
  '.search-row .btn{min-height:2.875rem;padding:0 1.5rem}',
  '.search-meta{display:flex;flex-wrap:wrap;gap:.25rem 1.5rem;margin:.5rem 0 0;font-size:.875rem;color:var(--muted)}',

  // A page's head: the breadcrumb, the heading, one sentence.
  '.pagehead{background:var(--layer);border-bottom:1px solid var(--border);padding:1rem 0 1.75rem}',
  '.pagehead-slim{padding:.875rem 0}',
  '.crumbs ol{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem;margin:0;padding:0;list-style:none;font-size:.875rem;color:var(--muted)}',
  '.crumbs li{display:inline-flex;align-items:center;gap:.375rem;min-width:0}',
  '.crumbs .ico{width:.875rem;height:.875rem}',
  '.pagehead h1{margin:1rem 0 0;font-size:1.875rem;line-height:1.2;letter-spacing:-.01em}',
  '.pagehead-lead{margin:.375rem 0 0;color:var(--muted);max-width:68ch}',

  // Section heads: the heading (and a line under it) on the left, a "see all" link on the right.
  '.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:1.5rem;margin:0 0 1.5rem}',
  '.section-head h2{margin:0;font-size:1.625rem}',
  '.section-sub{margin:.25rem 0 0;color:var(--muted);max-width:68ch}',
  '.section-link{font-weight:600;font-size:.9375rem;white-space:nowrap}',
  '.section-note{margin:.75rem 0 0;color:var(--muted);font-size:.875rem;max-width:68ch}',

  // Statuses: the colour, an icon and the word.
  '.status{display:inline-flex;align-items:center;gap:.375rem;font-weight:600}',
  '.status .ico{width:1rem;height:1rem}',
  '.status-ok{color:var(--ok)}',
  '.status-warn{color:var(--warn)}',
  '.status-danger{color:var(--danger)}',
  '.status-muted{color:var(--muted)}',

  // The substitute cover: the flat colour of the title's class, the title and author, and the call number's spine label.
  coverBlocks('light'),
  `@media (prefers-color-scheme:dark){${coverBlocks('dark')}}`,
  '.book-cover{display:flex;flex-direction:column;justify-content:space-between;gap:.25rem;width:100%;aspect-ratio:2/3;' +
    'padding:.75rem .625rem;border-radius:2px;background:var(--cover);color:var(--cover-ink);overflow:hidden}',
  '.cover-text{display:block;min-width:0}',
  '.cover-title{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;font-weight:600;font-size:.8125rem;' +
    'line-height:1.25;overflow-wrap:anywhere}',
  '.cover-author{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:.25rem;' +
    'color:var(--cover-sub);font-size:.6875rem;line-height:1.25}',
  `.spine-label{display:grid;align-self:flex-start;max-width:100%;padding:.125rem .25rem;border-radius:1px;background:${SPINE_LABEL_COLORS.bg};` +
    `color:${SPINE_LABEL_COLORS.text};font:500 .5625rem/1.3 var(--mono);overflow:hidden}`,
  '.spine-label span{display:block;white-space:nowrap;overflow:hidden}',
  // The narrow strip of a table row: the colour only.
  '.book-cover-sm{width:1.75rem;padding:0;border-radius:1px}',
  '.book-cover-sm>*{display:none}',
  // The detail page's large cover.
  '.book-cover-lg{padding:1.25rem 1rem .875rem}',
  '.book-cover-lg .cover-title{font-size:1.125rem;-webkit-line-clamp:7}',
  '.book-cover-lg .cover-author{font-size:.875rem}',
  '.book-cover-lg .spine-label{font-size:.75rem;padding:.25rem .5rem}',

  // Title cards: a small cover beside the title, the author and what the copies allow, a thin line above each (the home
  // page, similar titles), or a list of rows (results). No box; the title's link covers the whole card.
  '.card-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 2.5rem;margin:0;padding:0;list-style:none}',
  '.card-list{display:grid;margin:0;padding:0;list-style:none}',
  '.card{position:relative;display:grid;grid-template-columns:4rem minmax(0,1fr);gap:1rem;align-items:start;min-width:0;padding:1rem 0;' +
    'border-top:1px solid var(--border)}',
  '.card-cover{display:block;width:100%;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:2px;background:var(--layer-2)}',
  '.card .book-cover{padding:.375rem .3125rem}',
  '.card .book-cover .cover-title{font-size:.5rem;line-height:1.25}',
  '.card .book-cover .cover-author,.card .book-cover .spine-label{display:none}',
  '.card-body{display:flex;flex-direction:column;gap:.125rem;min-width:0}',
  '.card-title{color:var(--text);font-weight:600;line-height:1.35;text-decoration:none;overflow-wrap:anywhere}',
  '.card-grid .card-title::after{content:"";position:absolute;inset:0}',
  '.card-title:hover,.card:hover .card-title{color:var(--accent);text-decoration:underline}',
  '.card-subtitle{font-weight:400}',
  '.card-meta{color:var(--muted);font-size:.90625rem;overflow-wrap:anywhere}',
  '.card-status{font-size:.875rem;margin-top:.375rem}',
  '@media (max-width:68.74rem){.card-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@media (max-width:53.74rem){.card-grid{grid-template-columns:1fr}}',

  // Facets: plain lists under a heading; each value a link drawn as a check box with its count.
  '.facet{margin:0;padding:1rem 0;border-top:1px solid var(--border)}',
  '.facet h2,.facet h3{margin:0 0 .5rem;font-size:.90625rem;font-weight:600}',
  '.facet ul{margin:0;padding:0;list-style:none}',
  '.facet a{display:flex;align-items:center;gap:.5rem;min-height:1.875rem;color:var(--text);text-decoration:none;font-size:.9375rem}',
  '.facet a::before{content:"";flex:none;width:1rem;height:1rem;border:1px solid var(--border-strong);border-radius:3px;background:var(--bg)}',
  '.facet a[aria-current]{font-weight:600}',
  '.facet a[aria-current]::before{border-color:var(--accent);background:var(--accent);box-shadow:inset 0 0 0 3px var(--bg)}',
  '.facet a:hover .facet-label{text-decoration:underline}',
  '.facet-count{margin-left:auto;color:var(--muted);font-size:.875rem;font-weight:400;font-variant-numeric:tabular-nums}',

  // Tables: a quiet header row, thin lines between the rows.
  '.table-scroll{max-width:100%;overflow-x:auto}',
  '.availability{width:100%;border-collapse:collapse;font-size:.9375rem;font-variant-numeric:tabular-nums}',
  '.availability th{padding:.5rem .75rem .5rem 0;border-bottom:1px solid var(--border-strong);color:var(--muted);' +
    'font-size:.84375rem;font-weight:600;text-align:left;white-space:nowrap}',
  '.availability td{padding:.625rem .75rem .625rem 0;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}',
  // On a phone each copy is a card: its status first, then each other cell under its column's name (`data-label`), so
  // the status never hides past the right edge; the header row stays for screen readers only.
  '@media (max-width:39.99rem){' +
    '.availability thead{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);' +
    'white-space:nowrap;border:0}' +
    '.availability,.availability tbody,.availability td{display:block;width:100%}' +
    '.availability tr{display:flex;flex-direction:column;padding:.625rem 0;border-bottom:1px solid var(--border)}' +
    '.availability td,.availability tbody tr:last-child td{padding:.125rem 0;border:0;overflow-wrap:anywhere}' +
    '.availability .availability-status{order:-1;padding-bottom:.375rem}' +
    '.availability td[data-label]::before{content:attr(data-label);display:inline-block;min-width:7.5rem;margin:0 .5rem 0 0;' +
    'color:var(--muted);font-size:.875rem;font-weight:600}' +
    '}',

  // The shelf map: the plan (a lazy <img>) with an inline SVG laid over it whose shelves are classed (`.shelf`, the
  // item's `.shelf-here`); the SVG is stretched over the image, so a box in per mille sits on its spot at any width.
  '.shelf-map{max-width:100%;margin:1rem 0}',
  '.shelf-map-plan{position:relative;overflow:hidden;background:var(--map-bg);border:1px solid var(--border);border-radius:var(--radius)}',
  '.shelf-map-plan img{display:block;width:100%;height:auto}',
  '.shelf-map-plan svg{position:absolute;top:0;left:0;width:100%;height:100%}',
  '.shelf-map .shelf{fill:var(--map-shelf)}',
  '.shelf-map .shelf-here{fill:var(--map-highlight)}',

  // Long text (pages, news, a record's summary) at a readable width.
  '.prose{max-width:var(--measure)}',

  // The footer: neutral charcoal in both schemes; four columns, then the line with the software and staff links.
  '.site-footer{margin-top:auto;background:var(--foot-bg);color:var(--foot-muted);font-size:.90625rem;--focus:#fff}',
  '.site-footer a{color:var(--foot-muted)}',
  '.site-footer a:hover{color:#fff}',
  '.foot-cols{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:2.5rem;padding-top:3rem;padding-bottom:2.5rem}',
  '.foot-block{min-width:0}',
  '.foot-block h2{margin:0 0 .75rem;color:var(--foot-text);font-size:.90625rem;font-weight:600;line-height:1.4}',
  '.foot-block p{margin:0}',
  '.foot-block p+p{margin-top:.5rem}',
  '.site-footer .sitelogo{margin-bottom:1rem;max-width:100%}',
  '.site-footer .sitelogo img{height:2.25rem}',
  '.site-footer .sitename{color:#fff}',
  '.foot-tagline{color:var(--foot-text)}',
  '.foot-address{white-space:pre-line}',
  '.foot-contact{display:grid;justify-items:start;overflow-wrap:anywhere}',
  '.foot-links{margin:0;padding:0;list-style:none}',
  '.foot-links li{margin-bottom:.375rem}',
  '.foot-hours{border-collapse:collapse}',
  '.foot-hours th{padding:0 1rem .375rem 0;font-weight:400;text-align:left;vertical-align:top}',
  '.foot-hours td{padding:0 0 .375rem;font-variant-numeric:tabular-nums;white-space:nowrap;vertical-align:top}',
  '.foot-bottom{border-top:1px solid var(--foot-line);font-size:.84375rem}',
  '.foot-bottom .wrap{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;padding-top:1rem;padding-bottom:1rem}',
  '.foot-staff{margin-left:auto}',

  // Narrow screens: the menu becomes the `<details>`, the footer two columns.
  '@media (max-width:68.74rem){.mainnav{gap:1.25rem}.site-header .wrap{gap:1.5rem}}',
  '@media (max-width:53.74rem){.hide-s{display:none!important}.mainnav{display:none}.mobnav{display:block}.topstrip .wrap{gap:.75rem}' +
    '.site-header .wrap{min-height:3.75rem}.sitelogo img{height:2.125rem}.sitelogo{max-width:75%}' +
    '.search-row{flex-wrap:wrap}.search-join{flex-basis:100%}.search-join select{width:7rem}.search-row .btn{width:100%}' +
    '.pagehead h1{font-size:1.5rem}.section-head{flex-direction:column;gap:.25rem;margin-bottom:1rem}.section-head h2{font-size:1.375rem}' +
    '.foot-cols{grid-template-columns:1fr 1fr;gap:2rem 1.5rem}.foot-cols>:first-child{grid-column:1/-1}.foot-staff{margin-left:0}}',
].join('\n');
