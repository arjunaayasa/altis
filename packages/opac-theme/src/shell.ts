// The `shell` module of @altis/opac-theme (S16), the OPAC shell (Phase 2 Task 21; spec §9.1, §9.2): the skip link,
// visible focus on every control, the header's site menu and search band, the footer's blocks, and the shared
// components the catalogue's pages build on: the substitute cover (`.book-cover`, a cloth colour per DDC main class with
// the title, the author and a spine label), title cards (`.card-grid`/`.card-list` of `.card`), facets (`.facet`),
// the availability table (`.availability` with `.status-*`), the shelf map (`.shelf-map`), section heads and `.prose`
// for long text. Tasks 20, 33 and 34 add only what is their own in their modules. Mobile first, every colour from
// base.ts's tokens (AA contrast in both schemes), targets at least 2.75 rem high (2.25 rem in the dense link lists of
// the facets and the footer), nothing fetched.

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
  '.skip-link{position:absolute;left:var(--gutter);top:-10rem;z-index:10;padding:.75rem 1rem;background:var(--bg);' +
    'color:var(--text);font-weight:700;border:2px solid var(--accent);border-radius:var(--radius);text-decoration:none}',
  '.skip-link:focus{top:.5rem}',
  'main:focus{outline:none}',
  '.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
    'clip:rect(0,0,0,0);white-space:nowrap;border:0}',

  // Visible focus on every control (base.ts gives links theirs; this makes it the same everywhere).
  'a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,' +
    'summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}',

  // The site menu on the header bar; on a narrow screen only the "Katalog" button (and the footer's links).
  '.menu{display:none}',
  '.menu ul{display:flex;flex-wrap:wrap;gap:0 .125rem;margin:0;padding:0;list-style:none}',
  '.menu a{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .625rem;border-radius:var(--radius-sm);color:#fff;' +
    'font-weight:600;font-size:.9375rem;text-decoration:none}',
  '.menu a:hover{text-decoration:underline}',
  '.menu a[aria-current]{border-radius:0;box-shadow:inset 0 -2px 0 #fff}',
  '.nav-catalog{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .875rem;border:1px solid #fff;' +
    'border-radius:var(--radius-sm);color:#fff;font-weight:600;font-size:.9375rem;text-decoration:none}',
  '.site-header .akun-link{padding:0 .625rem;color:#fff;font-size:.9375rem;text-decoration:none}',
  '.site-header .akun-link:hover,.nav-catalog:hover{text-decoration:underline}',
  '@media (min-width:52rem){.menu{display:block}.nav-catalog{display:none}}',

  // The search band under the header bar (the catalogue's pages): the second neutral layer, the search form.
  '.search-band{background:var(--layer);border-bottom:1px solid var(--border);color:var(--text);--focus:var(--accent)}',
  '.bar-tools{padding-top:1rem;padding-bottom:1rem}',

  // The search form: an optional field choice, the text, the button (46 px, the OPAC's search height).
  '.search-box{flex:1 1 16rem;max-width:47.5rem}',
  '.search-row{display:flex;flex-wrap:wrap;gap:.5rem}',
  '.search-box input[type=search],.search-box select{min-height:2.875rem;padding:0 .75rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font:inherit}',
  '.search-box input[type=search]{flex:1 1 12rem;min-width:0}',
  '.search-box select{flex:0 1 auto;max-width:100%}',
  '.search-box input::placeholder{color:var(--faint);opacity:1}',
  '.search-box button{min-height:2.875rem;padding:0 1.375rem;border:0;border-radius:var(--radius-sm);background:var(--accent);' +
    'color:var(--accent-ink);font:inherit;font-weight:700;cursor:pointer}',

  // Section heads: the heading (and a line under it) on the left, a "see all" link on the right.
  '.section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1rem;margin:0 0 .875rem}',
  '.section-head h2{margin:0}',
  '.section-sub{margin:.125rem 0 0;color:var(--muted);font-size:.875rem}',
  '.section-link{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:600}',

  // Home page blocks shared with other pages: the class grid and the news list.
  '.hero{padding:0 0 1rem}',
  '.search-hero{max-width:none;margin:0}',
  '.home-section{margin-top:3.5rem}',
  '.home-section h2{margin:0 0 .875rem}',
  '.more{margin:1rem 0 0}',
  '.class-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem;margin:0;padding:0;list-style:none}',
  '.class-grid a{display:grid;gap:.125rem;align-content:start;height:100%;min-height:2.75rem;padding:.875rem 1rem;background:var(--bg);' +
    'border:1px solid var(--border);border-radius:var(--radius);color:var(--text);text-decoration:none}',
  '.class-grid a:hover{border-color:var(--accent)}',
  '.class-grid a:hover .class-name{text-decoration:underline}',
  '.class-code{color:var(--accent);font-size:1.375rem;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}',
  '.class-name{font-weight:600;line-height:1.3;overflow-wrap:anywhere}',
  '.class-count{color:var(--muted);font-size:.8125rem;font-variant-numeric:tabular-nums}',
  '@media (min-width:60rem){.class-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}',
  '.news-list{display:grid;gap:1.5rem;margin:0;padding:0;list-style:none}',
  '.news-list article{display:grid;gap:.375rem;align-content:start;padding-top:.875rem;border-top:1px solid var(--border)}',
  '.news-list h3{margin:0;font-size:1rem;line-height:1.4}',
  '.news-list time{display:block;color:var(--muted);font-size:.8125rem}',
  '.news-list p{margin:0;color:var(--muted);font-size:.9375rem}',
  '@media (min-width:54rem){.news-list{grid-template-columns:repeat(3,minmax(0,1fr))}}',

  // The substitute cover: the cloth of the title's class, the title and author, and the call number's spine label.
  coverBlocks('light'),
  `@media (prefers-color-scheme:dark){${coverBlocks('dark')}}`,
  '.book-cover{display:flex;flex-direction:column;justify-content:space-between;gap:.5rem;width:100%;aspect-ratio:2/3;' +
    'padding:.875rem .75rem .625rem 1rem;border-radius:2px 5px 5px 2px;background:var(--cover);color:var(--cover-ink);' +
    'box-shadow:inset 4px 0 0 rgb(0 0 0/.14);overflow:hidden}',
  '.cover-text{display:block;min-width:0}',
  '.cover-title{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;font-weight:700;font-size:.875rem;' +
    'line-height:1.2;overflow-wrap:anywhere}',
  '.cover-author{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:.375rem;' +
    'color:var(--cover-sub);font-size:.71875rem;line-height:1.25}',
  `.spine-label{display:grid;align-self:flex-start;max-width:100%;padding:.1875rem .375rem;border-radius:2px;background:${SPINE_LABEL_COLORS.bg};` +
    `color:${SPINE_LABEL_COLORS.text};font-size:.65625rem;line-height:1.25;font-weight:700;font-variant-numeric:tabular-nums;overflow:hidden}`,
  '.spine-label span{display:block;white-space:nowrap;overflow:hidden}',
  // The narrow strip of a result list: the cloth only.
  '.book-cover-sm{width:2.75rem;padding:0;border-radius:1px 3px 3px 1px;box-shadow:inset 2px 0 0 rgb(0 0 0/.14)}',
  '.book-cover-sm>*{display:none}',
  // The detail page's large cover.
  '.book-cover-lg{padding:1.25rem 1rem .875rem 1.375rem}',
  '.book-cover-lg .cover-title{font-size:1.125rem;-webkit-line-clamp:7}',
  '.book-cover-lg .cover-author{font-size:.875rem}',
  '.book-cover-lg .spine-label{font-size:.8125rem;padding:.25rem .5rem}',

  // Title cards: a grid of covers with the title, the author and the availability below (home, browsing), or a list
  // (results). No box: the cover carries the card; the title's link covers the whole card.
  '.card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.5rem 1.125rem;margin:0;padding:0;list-style:none}',
  '.card-list{display:grid;margin:0;padding:0;list-style:none}',
  '.card{position:relative;display:flex;flex-direction:column;gap:.625rem;min-width:0}',
  '.card-cover{display:block;width:100%;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:2px 5px 5px 2px;background:var(--layer-2)}',
  '.card-body{display:flex;flex-direction:column;gap:.125rem;min-width:0}',
  '.card-title{color:var(--text);font-weight:700;line-height:1.3;text-decoration:none;overflow-wrap:anywhere}',
  '.card-grid .card-title{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:.9375rem}',
  '.card-grid .card-title::after{content:"";position:absolute;inset:0}',
  '.card-title:hover{color:var(--accent);text-decoration:underline}',
  '.card-subtitle{font-weight:400}',
  '.card-meta{color:var(--muted);font-size:.8125rem;overflow-wrap:anywhere}',
  '@media (min-width:35rem){.card-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}',
  '@media (min-width:62.5rem){.card-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}',

  // Facets: plain lists under a heading; each value a link drawn as a check box with its count.
  '.facet{margin:0 0 1.375rem;padding:0}',
  '.facet h2,.facet h3{margin:0 0 .375rem;font-size:.875rem;font-weight:700}',
  '.facet ul{margin:0;padding:0;list-style:none}',
  '.facet a{display:flex;align-items:center;gap:.5rem;min-height:2.25rem;color:var(--text);text-decoration:none;font-size:.9375rem}',
  '.facet a::before{content:"";flex:none;width:1rem;height:1rem;border:1px solid var(--border-strong);border-radius:3px;background:var(--bg)}',
  '.facet a[aria-current]{font-weight:700}',
  '.facet a[aria-current]::before{border-color:var(--accent);background:var(--accent);box-shadow:inset 0 0 0 3px var(--bg)}',
  '.facet a:hover .facet-label{text-decoration:underline}',
  '.facet-count{margin-left:auto;color:var(--faint);font-weight:400;font-variant-numeric:tabular-nums}',

  // The availability table and its statuses: coloured words (never colour alone).
  '.table-scroll{max-width:100%;overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius)}',
  '.availability{width:100%;border-collapse:collapse;font-size:.9375rem;font-variant-numeric:tabular-nums}',
  '.availability th{padding:.5rem .75rem;background:var(--layer);border-bottom:1px solid var(--border);color:var(--muted);' +
    'font-size:.75rem;font-weight:600;text-align:left;white-space:nowrap}',
  '.availability td{padding:.625rem .75rem;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}',
  '.availability tbody tr:last-child td{border-bottom:0}',
  '.status{display:inline;font-weight:600}',
  '.status-ok{color:var(--ok)}',
  '.status-warn{color:var(--warn)}',
  '.status-danger{color:var(--danger)}',

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

  // The footer: the library's blocks (contact, links, hours, search), then the line with the software and staff links.
  '.foot-grid{display:grid;gap:2rem;max-width:var(--wide);margin:0 auto;padding:2.5rem var(--gutter) 0}',
  '.foot-block{min-width:0}',
  '.foot-block h2{margin:0 0 .5rem;color:var(--foot-text);font-size:.9375rem;line-height:1.4}',
  '.foot-block p{margin:0;line-height:1.75}',
  '.foot-address{white-space:pre-line}',
  '.foot-links{margin:0;padding:0;list-style:none}',
  '.site-footer .foot-links a{min-height:2.25rem}',
  '.foot-hours{border-collapse:collapse;line-height:1.75}',
  '.foot-hours th{padding:0 1rem 0 0;font-weight:400;text-align:left;vertical-align:top}',
  '.foot-hours td{padding:0;font-variant-numeric:tabular-nums;color:var(--foot-text)}',
  '.foot-search{--focus:#fff}',
  '.foot-search input[type=search]{background:rgb(255 255 255/.06);border-color:rgb(255 255 255/.3);color:var(--foot-text)}',
  '.foot-search input::placeholder{color:var(--foot-muted)}',
  '.foot-bottom{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0 1.5rem;max-width:var(--wide);margin:0 auto;' +
    'padding:.5rem var(--gutter) 1rem;font-size:.8125rem}',
  '.foot-grid+.foot-bottom{margin-top:2rem;border-top:1px solid rgb(255 255 255/.12)}',
  '.foot-bottom p{display:flex;flex-wrap:wrap;align-items:center;gap:0 1rem;margin:0}',
  '@media (min-width:40rem){.foot-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@media (min-width:60rem){.foot-grid{grid-template-columns:1.2fr 1fr 1fr 1.3fr}}',
].join('\n');
