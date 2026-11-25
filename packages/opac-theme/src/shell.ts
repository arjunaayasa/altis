// Shared OPAC shell frame and reusable catalogue components: top hours/language bar, header with discoverable mobile menu,
// search bar, breadcrumbs, editorial section headers, cloth-bound substitute book covers, facets, responsive availability
// cards, shelf map, and multi-breakpoint footer.

import { oklchHex } from './color.js';

export const COVER_CLASSES = Object.freeze(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'x'] as const);

export type CoverClass = (typeof COVER_CLASSES)[number];

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

/** Cloth-bound substitute cover colours per DDC main class (title >= 6.5:1, author >= 5:1 in both schemes). */
export const COVER_COLORS: Readonly<Record<'light' | 'dark', CoverPalette>> = Object.freeze({
  light: palette(0.44, 0.065),
  dark: palette(0.4, 0.06),
});

export const SPINE_LABEL_COLORS = Object.freeze({ bg: oklchHex(0.98, 0.005, 90), text: oklchHex(0.2, 0.01, 255) });

const coverBlocks = (scheme: 'light' | 'dark', prefix = ''): string =>
  COVER_CLASSES.map((cls) => {
    const c = COVER_COLORS[scheme][cls];
    return `${prefix}.cover-${cls}{--cover:${c.bg};--cover-ink:${c.ink};--cover-sub:${c.sub}}`;
  }).join('');

export const SHELL_CSS: string = [
  '.nav-progress{position:fixed;top:0;left:0;right:0;z-index:60;height:2.5px;background:var(--accent);transform-origin:0 50%;' +
    'transform:scaleX(0);opacity:0;pointer-events:none}',
  '.nav-progress.is-active{opacity:1;transform:scaleX(.82)}',
  '.nav-progress.is-done{opacity:0;transform:scaleX(1)}',
  '.skip-link{position:absolute;left:.5rem;top:-10rem;z-index:50;padding:.625rem .875rem;background:var(--surface);color:var(--text);font-weight:600;' +
    'border:1px solid var(--border-strong);border-radius:var(--radius-sm);text-decoration:none}',
  '.skip-link:focus{top:.5rem}',
  'main:focus{outline:none}',
  '.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
    'clip:rect(0,0,0,0);white-space:nowrap;border:0}',
  '.ico{width:1.125rem;height:1.125rem;flex:none;vertical-align:-.1875rem}',

  'a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,' +
    'summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}',

  // Top utility strip: real open/closed status dot paired with words (C-4), contact links, and 44px-tall language targets.
  '.topstrip{background:var(--layer);border-bottom:1px solid var(--border);font-size:.84375rem;color:var(--muted)}',
  '.topstrip .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem 1.5rem;min-height:2.5rem}',
  '.topstrip a{color:inherit}',
  '.topstrip a:hover{color:var(--text)}',
  '.topstrip .ico{width:.875rem;height:.875rem;vertical-align:-.125rem;margin-right:.25rem}',
  '.top-today{white-space:nowrap}',
  '.open-dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--ok);margin-right:.375rem}',
  '.open-dot-off{background:var(--border-strong)}',
  '.lang{display:flex;align-items:center;gap:.125rem;margin-left:auto}',
  '.lang a{position:relative;display:inline-flex;align-items:center;min-height:2.5rem;padding:0 .5rem}',
  '.lang a+a{margin-left:.25rem;padding-left:.75rem}',
  '.lang a+a::before{content:"";position:absolute;left:0;top:50%;height:.875rem;transform:translateY(-50%);border-left:1px solid var(--border-strong)}',
  '.lang a[aria-current]{color:var(--text);font-weight:600}',
  '.theme-toggle[hidden],.theme-toggle [hidden]{display:none}',
  '.theme-toggle>span{display:inline-flex;align-items:center;gap:.4375rem}',
  '.theme-toggle .ico{width:1rem;height:1rem}',
  '.theme-word{line-height:1}',

  // Site header: logo/sitename, underlined current menu item, member link, and labelled mobile `<details>` menu.
  '.site-header{border-bottom:1px solid var(--border);background:var(--surface)}',
  '.site-header .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 2.5rem;min-height:4.375rem}',
  '.sitelogo{display:flex;align-items:center;gap:.75rem;flex:none;min-width:0;max-width:60%;color:var(--text)}',
  '.sitelogo:hover{text-decoration:none}',
  '.sitelogo img{display:block;height:2.5rem;width:auto;max-width:15rem}',
  '.sitename{font-weight:700;font-size:1.0625rem;line-height:1.25;letter-spacing:-.01em;color:var(--text);overflow-wrap:anywhere}',
  '.logo-plate-on{background:#fff;padding:.25rem .375rem;border-radius:var(--radius-sm);box-sizing:content-box}',
  '@media (prefers-color-scheme:dark){.logo-plate{background:#fff;padding:.25rem .375rem;border-radius:var(--radius-sm);box-sizing:content-box}}',
  ':root[data-theme=dark] .logo-plate{background:#fff;padding:.25rem .375rem;border-radius:var(--radius-sm);box-sizing:content-box}',
  ':root[data-theme=light] .logo-plate{background:none;padding:0}',
  '.mainnav{display:flex;gap:1.75rem;align-self:stretch;min-width:0}',
  '.site-header .mainnav{flex-wrap:wrap;row-gap:.25rem}',
  '.mainnav a{display:flex;align-items:center;color:var(--text);font-size:.9375rem;font-weight:500;border-bottom:2px solid transparent;' +
    'border-top:2px solid transparent;white-space:nowrap}',
  '.mainnav a:hover{text-decoration:none;color:var(--accent)}',
  '.mainnav a[aria-current]{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}',
  '.head-actions{margin-left:auto;display:flex;align-items:center;gap:.5rem;flex:none}',
  '.mobnav{display:none;position:relative}',
  '.mobnav summary{list-style:none;display:inline-flex;align-items:center;gap:.375rem;min-height:2.75rem;padding:0 .75rem;' +
    'border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface);cursor:pointer;color:var(--text);font:600 .90625rem/1 var(--font)}',
  '.mobnav summary:hover{background:var(--layer);border-color:var(--text)}',
  '.mobnav summary::-webkit-details-marker{display:none}',
  '.mobnav-word{line-height:1}',
  '.mobnav nav{position:absolute;right:0;top:calc(100% + .5rem);z-index:20;width:min(16.5rem,calc(100vw - 2*var(--gutter)));background:var(--surface);' +
    'border:1px solid var(--border-strong);border-radius:var(--radius);box-shadow:var(--shadow-pop);padding:.5rem}',
  '.mobnav nav a{display:flex;align-items:center;min-height:2.75rem;padding:.5rem .75rem;color:var(--text);border-radius:var(--radius-sm);text-decoration:none}',
  '.mobnav nav a:hover{background:var(--layer)}',
  '.mobnav nav a[aria-current]{color:var(--accent);background:var(--accent-soft);font-weight:600}',

  // Catalogue search band across inner pages and home page: flush full-width bar, compact single-line header + joined input.
  '.search-band{background:var(--layer);border-bottom:1px solid var(--border);padding:1.25rem 0}',
  '.search-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1.5rem;margin-bottom:.5rem}',
  '.search-label{display:block;font-weight:700;font-size:.9375rem;margin-bottom:.5rem;color:var(--text)}',
  '.search-head .search-label,.search-head .search-meta{margin:0}',
  '.search-row{display:flex;align-items:stretch;gap:.625rem}',
  '.search-join{position:relative;display:flex;align-items:stretch;flex:1;min-width:0;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface)}',
  '.search-join:focus-within{outline:2px solid var(--focus);outline-offset:1px}',
  '.search-join:has(>select)::before{content:"";position:absolute;left:7.5rem;top:50%;width:.4375rem;height:.4375rem;' +
    'border-right:1.75px solid var(--muted);border-bottom:1.75px solid var(--muted);transform:translateY(-65%) rotate(45deg);pointer-events:none}',
  '.search-join select,.search-join input{border:0;border-radius:var(--radius-sm);background:none;color:var(--text);font:400 1rem var(--font);' +
    'height:2.875rem;padding:0 .875rem;min-width:0}',
  '.search-join select{-webkit-appearance:none;appearance:none;border-right:1px solid var(--border);border-radius:var(--radius-sm) 0 0 var(--radius-sm);' +
    'flex:none;width:8.75rem;padding-right:2rem;cursor:pointer}',
  '.search-join input{flex:1}',
  '.search-join select:focus-visible,.search-join input:focus-visible{outline:none}',
  '.search-box input::placeholder{color:var(--faint);opacity:1}',
  '.search-row .btn{height:3rem;min-height:3rem;padding:0 1.5rem}',
  '.search-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem 1.25rem;margin:.625rem 0 0;font-size:.875rem;color:var(--muted)}',

  '.pagehead{background:var(--layer);border-bottom:1px solid var(--border);padding:1.125rem 0 1.875rem}',
  '.pagehead-slim{padding:.875rem 0}',
  '.crumbs ol{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem;margin:0;padding:0;list-style:none;font-size:.875rem;color:var(--muted)}',
  '.crumbs li{display:inline-flex;align-items:center;gap:.375rem;min-width:0}',
  '.crumbs .ico{width:.875rem;height:.875rem}',
  '.pagehead h1{margin:.875rem 0 0;font-size:clamp(1.5rem,2.2vw + .85rem,2rem);line-height:1.2;letter-spacing:-.01em}',
  '.pagehead-lead{margin:.375rem 0 0;color:var(--muted);max-width:68ch}',

  // Identity motif: editorial index rule beneath section headings, pairing display title with quiet action link.
  '.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:1.5rem;padding-bottom:.75rem;border-bottom:1px solid var(--border);margin:0 0 1.5rem}',
  '.section-head h2{margin:0;font-size:clamp(1.3125rem,1.4vw + .85rem,1.625rem);letter-spacing:-.01em}',
  '.section-sub{margin:.25rem 0 0;color:var(--muted);max-width:68ch}',
  '.section-link{display:inline-flex;align-items:center;min-height:2.25rem;font-weight:600;font-size:.9375rem;white-space:nowrap}',
  '.section-note{margin:.75rem 0 0;color:var(--muted);font-size:.875rem;max-width:68ch}',

  '.status{display:inline-flex;align-items:center;gap:.375rem;font-weight:600}',
  '.status .ico{width:1rem;height:1rem}',
  '.status-ok{color:var(--ok)}',
  '.status-warn{color:var(--warn)}',
  '.status-danger{color:var(--danger)}',
  '.status-muted{color:var(--muted)}',

  coverBlocks('light'),
  `@media (prefers-color-scheme:dark){${coverBlocks('dark')}}`,
  coverBlocks('light', ':root[data-theme=light] '),
  coverBlocks('dark', ':root[data-theme=dark] '),
  '.book-cover{display:flex;flex-direction:column;justify-content:space-between;gap:.25rem;width:100%;aspect-ratio:2/3;' +
    'padding:.75rem .625rem;border-radius:3px;background:var(--cover);color:var(--cover-ink);overflow:hidden;border:1px solid rgb(0 0 0/.12)}',
  '.cover-text{display:block;min-width:0}',
  '.cover-title{display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;font-weight:600;font-size:.8125rem;' +
    'line-height:1.25;overflow-wrap:anywhere}',
  '.cover-author{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:.25rem;' +
    'color:var(--cover-sub);font-size:.6875rem;line-height:1.25}',
  `.spine-label{display:grid;align-self:flex-start;max-width:100%;padding:.125rem .25rem;border-radius:2px;background:${SPINE_LABEL_COLORS.bg};` +
    `color:${SPINE_LABEL_COLORS.text};font:500 .5625rem/1.3 var(--mono);overflow:hidden}`,
  '.spine-label span{display:block;white-space:nowrap;overflow:hidden}',
  '.book-cover-sm{width:1.75rem;padding:0;border-radius:2px}',
  '.book-cover-sm>*{display:none}',
  '.book-cover-lg{padding:1.25rem 1rem .875rem}',
  '.book-cover-lg .cover-title{font-size:1.125rem;-webkit-line-clamp:7}',
  '.book-cover-lg .cover-author{font-size:.875rem}',
  '.book-cover-lg .spine-label{font-size:.75rem;padding:.25rem .5rem}',

  // Three-state book grid: 3 cols wide (>= 68.75rem), 2 cols tablet (42rem-68.74rem), 1 col phone (< 42rem).
  '.card-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1.5rem 2.5rem;margin:0;padding:0;list-style:none}',
  '.card-list{display:grid;margin:0;padding:0;list-style:none}',
  '.card{position:relative;display:grid;grid-template-columns:4.25rem minmax(0,1fr);gap:1rem;align-items:start;min-width:0;padding:1rem 0;' +
    'border-top:1px solid var(--border)}',
  '.card-cover{display:block;width:100%;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:3px;background:var(--layer-2);border:1px solid var(--border)}',
  '.card .book-cover{padding:.4375rem .375rem}',
  '.card .book-cover .cover-title{font-size:.5625rem;line-height:1.25}',
  '.card .book-cover .cover-author,.card .book-cover .spine-label{display:none}',
  '.card-body{display:flex;flex-direction:column;gap:.1875rem;min-width:0}',
  '.card-title{color:var(--text);font-weight:600;line-height:1.35;text-decoration:none;overflow-wrap:anywhere}',
  '.card-grid .card-title::after{content:"";position:absolute;inset:0}',
  '.card-title:hover,.card:hover .card-title{color:var(--accent);text-decoration:underline}',
  '.card-subtitle{font-weight:400}',
  '.card-meta{color:var(--muted);font-size:.90625rem;overflow-wrap:anywhere}',
  '.card-status{font-size:.875rem;margin-top:.375rem}',
  '@media (max-width:68.74rem){.card-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:1.25rem 2rem}}',
  '@media (max-width:41.99rem){.card-grid{grid-template-columns:1fr;gap:0}}',

  '.facet{margin:0;padding:1rem 0;border-top:1px solid var(--border)}',
  '.facet h2,.facet h3{margin:0 0 .5rem;font-size:.90625rem;font-weight:600}',
  '.facet ul{margin:0;padding:0;list-style:none}',
  '.facet a{display:flex;align-items:center;gap:.5rem;min-height:2.375rem;color:var(--text);text-decoration:none;font-size:.9375rem}',
  '.facet a::before{content:"";flex:none;width:1rem;height:1rem;border:1px solid var(--border-strong);border-radius:3px;background:var(--surface)}',
  '.facet a[aria-current]{font-weight:600}',
  '.facet a[aria-current]::before{border-color:var(--accent);background:var(--accent);box-shadow:inset 0 0 0 3px var(--surface)}',
  '.facet a:hover .facet-label{text-decoration:underline}',
  '.facet-count{margin-left:auto;color:var(--muted);font-size:.875rem;font-weight:400;font-variant-numeric:tabular-nums}',

  '.table-scroll{max-width:100%;overflow-x:auto}',
  '.availability{width:100%;border-collapse:collapse;font-size:.9375rem;font-variant-numeric:tabular-nums}',
  '.availability th{padding:.5rem .75rem .5rem 0;border-bottom:1px solid var(--border-strong);color:var(--muted);' +
    'font-size:.84375rem;font-weight:600;text-align:left;white-space:nowrap}',
  '.availability td{padding:.625rem .75rem .625rem 0;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}',
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

  '.shelf-map{max-width:100%;margin:1rem 0}',
  '.shelf-map-plan{position:relative;overflow:hidden;background:var(--map-bg);border:1px solid var(--border);border-radius:var(--radius)}',
  '.shelf-map-plan img{display:block;width:100%;height:auto}',
  '.shelf-map-plan svg{position:absolute;top:0;left:0;width:100%;height:100%}',
  '.shelf-map .shelf{fill:var(--map-shelf)}',
  '.shelf-map .shelf-here{fill:var(--map-highlight)}',

  '.prose{max-width:var(--measure)}',

  // Footer reflows across 3 states: 4 asymmetric columns (>= 53.75rem), 2 columns (36rem-53.74rem), 1 column (< 36rem).
  '.site-footer{margin-top:auto;background:var(--foot-bg);color:var(--foot-muted);font-size:.90625rem;--focus:#fff}',
  '.site-footer a{color:var(--foot-muted)}',
  '.site-footer a:hover{color:#fff}',
  '.foot-cols{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:2.5rem;padding-top:3.25rem;padding-bottom:2.75rem}',
  '.foot-block{min-width:0}',
  '.foot-block h2{margin:0 0 .75rem;color:var(--foot-text);font-size:.90625rem;font-weight:600;line-height:1.4}',
  '.foot-block p{margin:0}',
  '.foot-block p+p{margin-top:.5rem}',
  '.site-footer .sitelogo{margin-bottom:1rem;max-width:100%}',
  '.site-footer .sitelogo img{height:2.25rem}',
  '.site-footer .sitename{color:#fff}',
  '.foot-tagline{color:var(--foot-text)}',
  '.foot-address{white-space:pre-line}',
  '.foot-contact{display:grid;justify-items:start;gap:.125rem;overflow-wrap:anywhere}',
  '.foot-links{margin:0;padding:0;list-style:none}',
  '.foot-links li{margin-bottom:.25rem}',
  '.foot-links a{display:inline-flex;align-items:center;min-height:2rem}',
  '.foot-hours{width:100%;max-width:100%;border-collapse:collapse}',
  '.foot-hours th{padding:0 1rem .375rem 0;font-weight:400;text-align:left;vertical-align:top;overflow-wrap:anywhere}',
  '.foot-hours td{padding:0 0 .375rem;font-variant-numeric:tabular-nums;vertical-align:top;overflow-wrap:anywhere}',
  '.foot-bottom{border-top:1px solid var(--foot-line);font-size:.84375rem}',
  '.foot-bottom .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.5rem;padding-top:1rem;padding-bottom:1rem}',
  '.foot-staff{margin-left:auto}',

  '@media (max-width:68.74rem){.mainnav{gap:1.25rem}.site-header .wrap{gap:1.5rem}}',
  '@media (max-width:53.74rem){.hide-s{display:none!important}.mainnav{display:none}.mobnav{display:block}.topstrip .wrap{gap:.75rem;min-height:2.75rem}' +
    '.lang a{min-height:2.75rem}.theme-toggle{min-width:2.75rem;min-height:2.75rem;padding:0 .625rem}' +
    '.site-header .wrap{min-height:3.875rem}.sitelogo img{height:2.125rem}.sitelogo{max-width:70%}' +
    '.search-row{flex-wrap:wrap}.search-join{flex-basis:100%}.search-join select{width:7.25rem}.search-join:has(>select)::before{left:6rem}.search-row .btn{width:100%}' +
    '.section-head{flex-direction:column;gap:.25rem;margin-bottom:1.125rem}.section-link{min-height:2.75rem}' +
    '.facet a,.foot-links a{min-height:2.75rem}' +
    '.foot-cols{grid-template-columns:1fr 1fr;gap:2rem 1.5rem}.foot-cols>:first-child{grid-column:1/-1}.foot-staff{margin-left:0}}',
  '@media (max-width:35.99rem){.foot-cols{grid-template-columns:1fr}}',
].join('\n');
