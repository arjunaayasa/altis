// The `home` module of @altis/opac-theme (S16), the OPAC home page as the library's profile site: the hero band around
// the header, the search card floating at its lower edge, the subject pills and availability of the title lists, the
// popular titles, the "about" block with its facts, the services and facility photos, the loans per class, and the
// visit block with today's opening hours marked. Mobile first, every colour from base.ts's tokens or the hero's own
// (always dark, white text), no url() and no @import.
//
// Contrast on the hero: its text is white. Over a photo an even overlay of rgb(8 12 20) keeps it at least 4.5:1 even
// where the photo is pure white: the overlay is 60 % dark (5.2:1) unless the library chose a darker step (`hero-ov-<n>`,
// up to 80 %); 55 % would fall under 4.5:1, so no lighter step exists. Without a photo the band is the accent's
// light-scheme colour, at least 5:1 against white for every accent, in both schemes, or the library's own colour, which
// the setting only takes when white text keeps 4.5:1 on it (the page sets it as `--hero-bg` in a style element with the
// response's nonce). Focus rings on the band are white.

import { ACCENTS, type AccentName } from './base.js';

/** The hero band's colour without a photo: each accent's dark (light-scheme) value. */
const HERO_COLORS: Readonly<Record<AccentName, string>> = Object.freeze({
  teal: '#0f766e',
  blue: '#1d4ed8',
  green: '#15803d',
  purple: '#7e22ce',
  red: '#b91c1c',
  slate: '#334155',
});

/** The photo's vertical positions, in steps of 10 (the `opac.home` setting's). */
const POSITIONS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

/** The overlay's darkness over the photo, in percent: 60 (the floor, the default) to 80 in steps of 5 (the setting's). */
const HERO_OVERLAYS = Object.freeze([60, 65, 70, 75, 80] as const);

/** The CSS of the home page. */
export const HOME_CSS: string = [
  ':root{--hero-bg:#0f766e}',
  ACCENTS.map((name) => `[data-accent=${name}]{--hero-bg:${HERO_COLORS[name]}}`).join(''),

  // The hero band: the header in the library's photo (or colour), the text at its foot.
  '.hero-band{position:relative;isolation:isolate;display:flex;flex-direction:column;overflow:hidden;background:var(--hero-bg);' +
    'color:#fff;border:0;--focus:#fff}',
  '.hero-photo{min-height:24rem}',
  // A column flexbox would shrink the centred bars to their content: they keep the page width.
  '.hero-band>.bar{width:100%}',
  '.hero-img{position:absolute;inset:0;z-index:-2;width:100%;height:100%;max-width:none;object-fit:cover;object-position:50% 50%}',
  POSITIONS.map((p) => `.hero-pos-${p}{object-position:50% ${p}%}`).join(''),
  '.hero-photo::before{content:"";position:absolute;inset:0;z-index:-1;background:rgb(8 12 20/.6)}',
  HERO_OVERLAYS.map((p) => `.hero-ov-${p}::before{background:rgb(8 12 20/.${p})}`).join(''),
  '.hero-band .brand,.hero-band .akun-link,.hero-band .menu a{color:#fff}',
  '.hero-band .lang a{border-color:#fff;color:#fff}',
  '.hero-band .lang a[aria-current]{background:#fff;color:#0f172a}',
  '.hero-band a:focus-visible{outline-color:#fff}',
  '.hero-text{width:100%;max-width:var(--wide);margin:auto auto 0;padding:2rem var(--gutter) 4.5rem}',
  '.hero-text h1{max-width:24ch;margin:0 0 .75rem;color:#fff;text-wrap:balance}',
  '.hero-lead{max-width:60ch;margin:0;font-size:1.125rem;white-space:pre-line;color:#fff}',

  // The search card, pulled up over the band's lower edge (main's top padding is 2 rem).
  '.home-search{position:relative;z-index:1;margin:-4.5rem 0 0;padding:1rem;background:var(--surface);border:1px solid var(--border);' +
    'border-radius:var(--radius);box-shadow:0 8px 24px rgb(15 23 42/.14)}',
  '.home-search .search-hero{max-width:none;margin:0}',
  '.home-search-meta{margin:.5rem 0 0;color:var(--muted);font-size:.9375rem}',

  // The subject pills above a list of titles: each subject with its number of titles, wrapping.
  '.subject-pills{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1rem;padding:0;list-style:none}',
  '.subject-pills a{display:inline-flex;align-items:center;gap:.375rem;min-height:2.25rem;padding:.25rem .875rem;' +
    'border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--text);text-decoration:none;font-size:.9375rem}',
  '.subject-pills a:hover{border-color:var(--accent)}',
  '.pill-count{color:var(--muted);font-variant-numeric:tabular-nums}',
  // Availability on a title: a word, in a status colour with its outline (never colour alone).
  '.card-status{align-self:flex-start;margin-top:.25rem}',
  '.status-muted{color:var(--muted)}',

  // The popular titles: a numbered list.
  '.section-note{margin:-.5rem 0 1rem;color:var(--muted);font-size:.9375rem;max-width:var(--measure)}',
  '.popular-list{margin:0;padding:0 0 0 2rem;max-width:var(--measure)}',
  '.popular-list li{padding:.5rem 0;border-bottom:1px solid var(--border)}',
  '.popular-list li::marker{color:var(--muted);font-weight:700}',
  '.popular-list a{font-weight:600;overflow-wrap:anywhere}',
  '.popular-list .card-meta{display:block}',
  '.popular-list .card-status{display:inline-block;margin-top:.375rem}',

  // About: a photo beside the text and the facts.
  '.about-grid{display:grid;gap:1.5rem;align-items:center}',
  '.about-body h2{margin-top:0}',
  '.about-text{max-width:var(--measure);white-space:pre-line}',
  '.home-figure{display:grid;gap:.5rem;margin:0;min-width:0}',
  '.home-figure img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:var(--radius);background:var(--border)}',
  '.home-figure figcaption{color:var(--muted);font-size:.875rem}',
  '.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:1px;margin:1rem 0 0;overflow:hidden;' +
    'background:var(--border);border:1px solid var(--border);border-radius:var(--radius)}',
  '.facts>div{padding:.625rem .875rem;background:var(--surface)}',
  '.facts dt{color:var(--muted);font-size:.875rem}',
  '.facts dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums}',

  // Services and facility photos.
  '.services-grid{display:grid;gap:1.5rem;align-items:start}',
  '.service-list{margin:0;padding:0;list-style:none;border-top:1px solid var(--border)}',
  '.service-list li{padding:.875rem 0;border-bottom:1px solid var(--border)}',
  '.service-list h3{margin:0;font-size:1rem;line-height:1.4}',
  '.service-list p{margin:.125rem 0 0;color:var(--muted)}',
  '.facility-photos{display:grid;gap:1rem}',

  // The loans per class: one card per class, its place, name and counts.
  '.class-ranking{display:grid;gap:1rem;margin:0;padding:0;list-style:none}',
  '.class-ranking li{display:grid;gap:.25rem;padding:1rem 1.125rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}',
  '.class-place{color:var(--muted);font-size:.875rem;font-weight:600}',
  '.class-label{font-size:1.25rem;font-weight:700;overflow-wrap:anywhere}',
  '.class-counts{color:var(--muted);font-variant-numeric:tabular-nums}',

  // The visit block: location and opening hours.
  '.visit-grid{display:grid;gap:1.5rem}',
  '.visit-block h3{margin:0 0 .5rem;font-size:1rem}',
  '.visit-address{white-space:pre-line}',
  '.hours{width:100%;max-width:28rem;border-collapse:collapse}',
  '.hours th,.hours td{padding:.375rem 0;border-bottom:1px solid var(--border);text-align:left;font-weight:400;vertical-align:top}',
  '.hours td{padding-left:1rem;text-align:right;font-variant-numeric:tabular-nums}',
  '.hours .today th,.hours .today td{font-weight:700}',
  '.home-search-meta span+span::before{content:" · "}',

  // Wider screens: two columns, a taller band.
  '@media (min-width:30rem){.facility-n2,.facility-n3,.facility-n4{grid-template-columns:1fr 1fr}}',
  '@media (min-width:48rem){.hero-photo{min-height:30rem}.hero-text{padding-top:3rem;padding-bottom:5rem}' +
    '.home-search{margin-top:-5rem;padding:1.25rem 1.5rem}' +
    '.about-grid{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:2.5rem}.about-nophoto{grid-template-columns:1fr}' +
    '.services-grid{grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:2.5rem}.services-single{grid-template-columns:1fr}' +
    '.visit-grid{grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:2.5rem}' +
    '.class-ranking{grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))}}',
].join('\n');
