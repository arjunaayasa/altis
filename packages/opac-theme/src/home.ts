// The `home` module of @altis/opac-theme (S16), the OPAC home page as the library's profile site: the hero band around
// the header, the search card floating at its lower edge (the field choice, the text, the collection's facts), the
// subject pills and availability of the title lists, the numbered popular titles, the "about" block with its facts,
// the services and facility photos, the loans per class, and the visit block (location, opening hours with today's
// marked, the loan rules per member type). Mobile first, every colour from base.ts's tokens or the hero's own (always
// dark, white text), no url() and no @import.
//
// Contrast on the hero: its text is white. Over a photo an even overlay of rgb(8 12 20) keeps it at least 4.5:1 even
// where the photo is pure white: the overlay is 60 % dark (5.2:1) unless the library chose a darker step (`hero-ov-<n>`,
// up to 80 %); 55 % would fall under 4.5:1, so no lighter step exists. Without a photo the band is the header bar's
// colour (base.ts: a deep shade of the accent, at least 12:1 against white), or the library's own colour, which the
// setting only takes when white text keeps 4.5:1 on it (the page sets it as `--hero-bg` in a style element with the
// response's nonce). Focus rings on the band are white.

/** The photo's vertical positions, in steps of 10 (the `opac.home` setting's). */
const POSITIONS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

/** The overlay's darkness over the photo, in percent: 60 (the floor, the default) to 80 in steps of 5 (the setting's). */
const HERO_OVERLAYS = Object.freeze([60, 65, 70, 75, 80] as const);

/** The CSS of the home page. */
export const HOME_CSS: string = [
  // The hero band: the header in the library's photo (or colour), the text at its foot.
  '.hero-band{position:relative;isolation:isolate;display:flex;flex-direction:column;overflow:hidden;background:var(--hero-bg);' +
    'color:#fff;border:0;--focus:#fff}',
  // A column flexbox would shrink the centred bars to their content: they keep the page width.
  '.hero-band>.bar{width:100%}',
  '.hero-img{position:absolute;inset:0;z-index:-2;width:100%;height:100%;max-width:none;object-fit:cover;object-position:50% 50%}',
  POSITIONS.map((p) => `.hero-pos-${p}{object-position:50% ${p}%}`).join(''),
  '.hero-photo::before{content:"";position:absolute;inset:0;z-index:-1;background:rgb(8 12 20/.6)}',
  HERO_OVERLAYS.map((p) => `.hero-ov-${p}::before{background:rgb(8 12 20/.${p})}`).join(''),
  '.hero-band .lang a,.hero-band .menu a,.hero-band .akun-link,.hero-band .brand{color:#fff}',
  '.hero-band a:focus-visible{outline-color:#fff}',
  '.hero-text{width:100%;max-width:var(--wide);margin:0 auto;padding:2.25rem var(--gutter) 7rem}',
  '.hero-text h1{max-width:22ch;margin:0 0 .75rem;color:#fff;font-size:1.875rem;line-height:1.12;text-wrap:balance}',
  '.hero-lead{max-width:58ch;margin:0;font-size:1.0625rem;line-height:1.55;white-space:pre-line;color:#fff}',

  // The search card, pulled 4.25 rem up over the band's lower edge (main's top padding is 2 rem).
  '.home-search{position:relative;z-index:1;display:grid;gap:.75rem;margin:-6.25rem 0 0;padding:1rem;background:var(--bg);' +
    'border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-pop)}',
  '.home-search .search-hero{max-width:none;margin:0;display:grid;gap:.75rem}',
  '.home-search .search-row input[type=search],.home-search .search-row button{min-height:3.125rem;font-size:1.0625rem}',
  '.home-search .search-row input[type=search]{flex-basis:10rem}',
  '.home-search .search-row button{padding:0 1.625rem}',
  // The field choice: radio buttons drawn as a row of pills.
  '.scope{display:flex;flex-wrap:wrap;gap:.375rem;margin:0;padding:0;border:0;min-width:0}',
  '.scope label{position:relative;display:inline-flex;cursor:pointer}',
  '.scope input{position:absolute;opacity:0;width:1px;height:1px;margin:0}',
  '.scope span{display:inline-flex;align-items:center;min-height:2.25rem;padding:0 .75rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);color:var(--muted);font-size:.875rem;font-weight:600}',
  '.scope input:checked+span{background:var(--accent-soft);border-color:var(--accent);color:var(--text)}',
  '.scope input:focus-visible+span{outline:2px solid var(--focus);outline-offset:2px}',
  '.home-search-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem 1.25rem;margin:0;color:var(--muted);font-size:.875rem}',
  '.home-search-meta strong{color:var(--text);font-variant-numeric:tabular-nums}',
  '.home-search-meta a{display:inline-flex;align-items:center;min-height:2.75rem;margin-left:auto;font-weight:600}',

  // The subject pills above a list of titles: each subject with its number of titles, wrapping.
  '.subject-pills{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1.125rem;padding:0;list-style:none}',
  '.subject-pills a{display:inline-flex;align-items:center;gap:.375rem;min-height:2.25rem;padding:0 .75rem;' +
    'border:1px solid var(--border-strong);border-radius:999px;background:var(--bg);color:var(--text);text-decoration:none;font-size:.875rem}',
  '.subject-pills a:hover{border-color:var(--accent);color:var(--accent)}',
  '.pill-count{color:var(--faint);font-variant-numeric:tabular-nums}',
  // Availability on a title: coloured words (the status colour only repeats them).
  '.card-status{font-size:.8125rem}',
  '.status-muted{color:var(--muted)}',

  // The popular titles: a numbered list, the rank in its own column, the availability on the right.
  '.popular-list{margin:0;padding:0;list-style:none;counter-reset:rank;border-top:1px solid var(--border)}',
  '.popular-list li{counter-increment:rank;display:grid;grid-template-columns:2rem minmax(0,1fr);gap:.125rem .75rem;align-items:baseline;' +
    'padding:.625rem 0;border-bottom:1px solid var(--border)}',
  '.popular-list li::before{content:counter(rank);grid-row:span 3;color:var(--faint);font-weight:700;font-variant-numeric:tabular-nums}',
  '.popular-list a{color:var(--text);font-weight:700;text-decoration:none;overflow-wrap:anywhere}',
  '.popular-list a:hover{color:var(--accent);text-decoration:underline}',
  '.popular-list .card-meta{font-size:.875rem}',
  '@media (min-width:40rem){.popular-list li{grid-template-columns:2rem minmax(0,1fr) auto}.popular-list li::before{grid-row:span 2}' +
    '.popular-list .card-status{grid-column:3;grid-row:1}}',

  // About: a photo beside the text and the facts.
  '.about-grid{display:grid;gap:1.5rem;align-items:center}',
  '.about-body h2{margin-top:0}',
  '.about-text{max-width:62ch;margin:0 0 1rem;font-size:1.0625rem;line-height:1.65;white-space:pre-line}',
  '.home-figure{display:grid;gap:.5rem;margin:0;min-width:0}',
  '.home-figure img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:var(--radius);background:var(--layer-2)}',
  '.home-figure figcaption{color:var(--muted);font-size:.8125rem}',
  '.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin:.25rem 0 0;overflow:hidden;' +
    'background:var(--border);border:1px solid var(--border);border-radius:var(--radius)}',
  '.facts>div{padding:.625rem .875rem;background:var(--bg)}',
  '.facts dt{color:var(--muted);font-size:.8125rem}',
  '.facts dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums}',

  // Services and facility photos.
  '.services-grid{display:grid;gap:1.5rem;align-items:start}',
  '.service-list{margin:0;padding:0;list-style:none;border-top:1px solid var(--border)}',
  '.service-list li{display:grid;gap:.125rem;padding:.875rem 0;border-bottom:1px solid var(--border)}',
  '.service-list h3{margin:0;font-size:1rem;line-height:1.4}',
  '.service-list p{margin:0;color:var(--muted);font-size:.9375rem}',
  '.facility-photos{display:grid;gap:1rem}',

  // The loans per class: one box per class, its place, name and counts.
  '.class-ranking{display:grid;gap:1rem;margin:0;padding:0;list-style:none}',
  '.class-ranking li{display:grid;gap:.25rem;padding:1rem 1.125rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)}',
  '.class-place{color:var(--muted);font-size:.8125rem;font-weight:600}',
  '.class-label{font-size:1.25rem;font-weight:700;overflow-wrap:anywhere}',
  '.class-counts{color:var(--muted);font-size:.875rem;font-variant-numeric:tabular-nums}',

  // The visit block: location, opening hours and the loan rules side by side.
  '.visit-grid{display:grid;gap:1.75rem}',
  '.visit-block{min-width:0}',
  '.visit-block h3{margin:0 0 .5rem;font-size:1rem}',
  '.visit-block p{color:var(--muted);font-size:.9375rem}',
  '.visit-address{white-space:pre-line}',
  '.map-link{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:600}',
  '.hours{width:100%;border-collapse:collapse;font-size:.9375rem}',
  '.hours th,.hours td{padding:.375rem 0;border-bottom:1px solid var(--border);text-align:left;font-weight:400;vertical-align:top}',
  '.hours td{padding-left:1rem;text-align:right;font-variant-numeric:tabular-nums}',
  '.hours .today th,.hours .today td{font-weight:700}',
  '.rules-note{margin:.5rem 0 0;font-size:.875rem}',

  // Wider screens: two or more columns, a taller band.
  '@media (min-width:30rem){.facility-n2,.facility-n3,.facility-n4{grid-template-columns:1fr 1fr}}',
  '@media (min-width:40rem){.hero-text{padding-top:4rem;padding-bottom:8rem}.hero-text h1{font-size:2.5rem}.hero-lead{font-size:1.125rem}' +
    '.home-search{padding:1.125rem 1.25rem}.facts{grid-template-columns:repeat(auto-fit,minmax(8rem,1fr))}}',
  '@media (min-width:56rem){.about-grid{grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:2.5rem}.about-nophoto{grid-template-columns:1fr}' +
    '.services-grid{grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:2.5rem}.services-single{grid-template-columns:1fr}' +
    '.visit-grid{grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:2.5rem}' +
    '.class-ranking{grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))}}',
].join('\n');
