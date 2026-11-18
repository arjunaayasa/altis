// The `home` module of @altis/opac-theme, the OPAC home page as the library's profile site: the hero's slides (a solid
// panel of the library colour with the text, a photo beside it), the "about" block with the library's figures, the
// services, the title lists (new titles as cards, the most borrowed as a numbered list, the subjects by class), news
// and agenda, the gallery, and the visit block with the call to become a member. Every colour from base.ts's tokens,
// no url(), no @import, no gradient.
//
// The hero has nothing to scroll: its slides lie on top of each other in one grid cell and the track clips what is
// outside it. Without the slider's script the first slide is on top and an indicator (a link `#slide-n`) brings its
// slide to the top (`:target`); with it (`.js` on the track) only the slide `is-on` shows and a change fades. A
// slide is at least 440 px high and grows with its text; its photo never sets the height (`contain:size`), and the
// panel keeps room at its foot for the controls, so they never meet the text. The panel's text is white on
// `--panel`, which is held to 4.5:1 (base.ts, brand.ts); focus rings on it are white.

/** The photo's vertical positions, in steps of 10 (the `opac.home` setting's). */
const POSITIONS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

/** At most this many slides (the setting's limit): the indicator rules below are written per slide. */
const SLIDES_MAX = 6;

const slideNumbers = Array.from({ length: SLIDES_MAX }, (_, i) => i + 1);

/** The CSS of the home page. */
export const HOME_CSS: string = [
  // ---- The hero ----
  '.hero{position:relative;background:var(--panel)}',
  '.hero-track{display:grid;overflow:hidden;touch-action:pan-y}',
  '.hero-track>.slide{grid-area:1/1;visibility:hidden;opacity:0}',
  '.hero-track.js>.slide.is-on{visibility:visible;opacity:1}',
  // Without the script: every slide is drawn, the first on top, the one an indicator points at above it.
  '.hero-track:not(.js)>.slide{visibility:visible;opacity:1;z-index:0}',
  '.hero-track:not(.js)>.slide:first-child{z-index:1}',
  '.hero-track:not(.js)>.slide:target{z-index:2}',
  '.slide{display:grid;grid-template-columns:max(44%,calc(50% - 6.25rem)) minmax(0,1fr);min-height:27.5rem;min-width:0}',
  '.slide-nophoto{grid-template-columns:minmax(0,1fr)}',
  '.slide-text{background:var(--panel);color:var(--on-panel);display:flex;align-items:center;min-width:0;' +
    'padding:2.5rem 3rem 5.5rem max(var(--gutter),calc(50vw - 37.5rem))}',
  '.slide-body{max-width:30rem;min-width:0}',
  '.slide-nophoto .slide-body{max-width:44rem}',
  '.slide-note{margin:0 0 .5rem;font-size:.90625rem;font-weight:600;opacity:.9}',
  '.slide h1,.slide h2{margin:0;font-size:2.375rem;line-height:1.2;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere}',
  '.slide-lead{margin:.75rem 0 0;font-size:1.0625rem;line-height:1.5;max-width:44ch;white-space:pre-line}',
  '.slide-cta{display:flex;flex-wrap:wrap;gap:.5rem;margin:1.25rem 0 0}',
  '.slide>img{display:block;width:100%;height:100%;max-width:none;object-fit:cover;min-width:0;contain:size}',
  POSITIONS.map((p) => `.hero-pos-${p}{object-position:50% ${p}%}`).join(''),
  // The controls: thin line indicators without numbers (24 x 3 px in a 27 px high target), small borderless buttons.
  '.hero-ui{position:absolute;z-index:3;left:max(var(--gutter),calc(50vw - 37.5rem));bottom:1.75rem;display:flex;align-items:center;gap:.25rem;' +
    'color:var(--on-panel)}',
  '.hero-ui button{display:grid;place-items:center;width:1.75rem;height:1.75rem;border:0;border-radius:var(--radius-sm);background:none;' +
    'color:inherit;cursor:pointer;padding:0;opacity:.85}',
  '.hero-ui button:hover{opacity:1;background:color-mix(in srgb,var(--on-panel) 14%,transparent)}',
  '.hero-ui .ico{width:1rem;height:1rem}',
  '.hero-dots{display:flex;gap:.375rem;margin-right:.75rem}',
  '.hero-dots a{display:block;width:1.5rem;height:.1875rem;box-sizing:content-box;padding:.75rem 0;border-radius:2px;' +
    'background-color:color-mix(in srgb,var(--on-panel) 40%,transparent);background-clip:content-box}',
  '.hero-dots a:hover{background-color:color-mix(in srgb,var(--on-panel) 70%,transparent)}',
  '.hero-dots a[aria-current="true"]{background-color:var(--on-panel)}',
  // Without the script the indicator of the slide on top is the bright one.
  '.hero:has(.hero-track:not(.js)>.slide:target) .hero-dots a[aria-current="true"]{background-color:color-mix(in srgb,var(--on-panel) 40%,transparent)}',
  slideNumbers.map((n) => `.hero:has(.hero-track:not(.js)>#slide-${n}:target) .hero-dots a:nth-child(${n})`).join(',') + '{background-color:var(--on-panel)}',
  '.hero a:focus-visible,.hero button:focus-visible{outline-color:var(--on-panel)}',
  '@media (prefers-reduced-motion:no-preference){.hero-track.js>.slide{transition:opacity .45s ease,visibility .45s}}',

  // ---- Sections ----
  '.section{padding:4rem 0}',
  '.section-alt{background:var(--layer);border-block:1px solid var(--border)}',
  '.section-alt+.section-alt{border-top:0}',
  '.h3{margin:0 0 .75rem;font-size:1.125rem}',
  '.h3 small{color:var(--muted);font-weight:400;font-size:.90625rem}',

  // About: the text beside one photo, then the row of figures between two lines.
  '.about{display:grid;grid-template-columns:minmax(0,1fr) 25rem;gap:3.5rem;align-items:start}',
  '.about-nophoto{grid-template-columns:minmax(0,1fr)}',
  '.about h2{margin:0 0 .75rem;font-size:1.625rem}',
  '.about p{margin:0;max-width:64ch}',
  '.about p+p{margin-top:.75rem}',
  '.about .more-link{display:inline-block;margin-top:1rem}',
  '.about-photo{margin:0}',
  '.about-photo img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover;border-radius:var(--radius)}',
  '.about-photo figcaption,.gallery figcaption,.facilities figcaption{font-size:.875rem;color:var(--muted);margin-top:.375rem}',
  '.figures{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-block:1px solid var(--border);margin:2rem 0 0;padding:0}',
  '.figures-3{grid-template-columns:repeat(3,minmax(0,1fr))}',
  '.figures-2{grid-template-columns:repeat(2,minmax(0,1fr))}',
  '.figures-1{grid-template-columns:minmax(0,1fr)}',
  '.figures>div{display:flex;flex-direction:column-reverse;padding:1rem 1.5rem;min-width:0}',
  '.figures>div+div{border-left:1px solid var(--border)}',
  '.figures>div:first-child{padding-left:0}',
  '.figures dd{margin:0;font-size:1.75rem;line-height:1.2;font-weight:700;font-variant-numeric:tabular-nums}',
  '.figures dt{font-size:.90625rem;color:var(--muted)}',

  // Services: three columns of a title and one sentence, a line above each; no card, no icon.
  '.svc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 2.5rem;margin:0;padding:0;list-style:none}',
  '.svc-grid li{border-top:1px solid var(--border-strong);padding:1rem 0 1.5rem;min-width:0}',
  '.svc-grid h3{margin:0 0 .25rem;font-size:1.0625rem;font-weight:600}',
  '.svc-grid p{margin:0;font-size:.9375rem;color:var(--muted)}',

  // The most borrowed (a numbered list) beside the subjects by class (two columns, with their number of titles).
  '.cols-2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:3.5rem;margin-top:3rem}',
  '.cols-1{grid-template-columns:minmax(0,1fr)}',
  '.cols-2:first-child{margin-top:0}',
  '.rank{margin:0;padding:0;list-style:none}',
  '.rank li{display:grid;grid-template-columns:1.5rem minmax(0,1fr);gap:.5rem;padding:.625rem 0;border-top:1px solid var(--border);align-items:baseline}',
  '.rank-n{color:var(--muted);font-variant-numeric:tabular-nums}',
  '.rank a{color:var(--text);font-weight:600;font-size:.9375rem}',
  '.rank small{display:block;color:var(--muted);font-size:.875rem}',
  '.ddc{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 2rem;margin:0;padding:0;list-style:none}',
  '.ddc a{display:grid;grid-template-columns:2.5rem minmax(0,1fr) auto;gap:.5rem;padding:.625rem 0;border-top:1px solid var(--border);color:var(--text);' +
    'font-size:.9375rem;align-items:baseline}',
  '.ddc .mono,.ddc-count{color:var(--muted)}',
  '.ddc-count{font-size:.875rem;font-variant-numeric:tabular-nums}',
  '.class-ranking{margin:0;padding:0;list-style:none;max-width:44rem}',
  '.class-ranking li{display:grid;grid-template-columns:7rem minmax(0,1fr) auto;gap:.25rem 1rem;align-items:baseline;padding:.625rem 0;' +
    'border-top:1px solid var(--border)}',
  '.class-place{color:var(--muted);font-size:.875rem}',
  '.class-label{font-weight:600;overflow-wrap:anywhere}',
  '.class-counts{color:var(--muted);font-size:.875rem;font-variant-numeric:tabular-nums}',

  // News rows (a small photo, the kind and date, the title, the summary) beside the agenda (a bordered date box).
  '.news-agenda{display:grid;grid-template-columns:minmax(0,1fr) 21.25rem;gap:3.5rem}',
  '.news-agenda-1{grid-template-columns:minmax(0,1fr)}',
  '.news-rows{margin:0;padding:0;list-style:none}',
  '.newsrow{position:relative;display:grid;grid-template-columns:11.5rem minmax(0,1fr);gap:1.25rem;padding:1.25rem 0;border-top:1px solid var(--border)}',
  '.news-rows>li:first-child>.newsrow{border-top:0;padding-top:0}',
  '.newsrow-nophoto{grid-template-columns:minmax(0,1fr)}',
  '.newsrow img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover;border-radius:var(--radius-sm);background:var(--layer-2)}',
  '.newsmeta{margin:0 0 .25rem;font-size:.84375rem;color:var(--muted)}',
  '.newsmeta b{color:var(--text);font-weight:600}',
  '.newsrow h3{margin:0 0 .25rem;font-size:1.125rem}',
  '.newsrow h3 a{color:var(--text)}',
  '.newsrow h3 a::after{content:"";position:absolute;inset:0}',
  '.newsrow:hover h3 a{color:var(--accent);text-decoration:underline}',
  '.newsrow p.news-summary{margin:0;font-size:.9375rem;color:var(--muted);max-width:64ch}',
  '.agenda{margin:0;padding:0;list-style:none}',
  '.agenda li{display:grid;grid-template-columns:3rem minmax(0,1fr);gap:.75rem;padding:.75rem 0;border-top:1px solid var(--border);align-items:center}',
  '.datebox{border:1px solid var(--border-strong);border-radius:var(--radius-sm);text-align:center;padding:.25rem 0;background:var(--bg)}',
  '.datebox b{display:block;font-size:1.0625rem;line-height:1.2}',
  '.datebox small{display:block;font-size:.75rem;color:var(--muted);line-height:1.2}',
  '.agenda-title{display:block;font-weight:600;font-size:.9375rem;color:var(--text)}',
  '.agenda-meta{display:block;font-size:.875rem;color:var(--muted)}',

  // The gallery and the facilities: photos in a row with their captions below.
  '.gallery,.facilities{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin:0;padding:0;list-style:none}',
  '.gallery figure,.facilities figure{margin:0}',
  '.gallery img,.facilities img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover;border-radius:var(--radius-sm);background:var(--layer-2)}',
  '.facilities figcaption b{display:block;color:var(--text);font-size:.9375rem;font-weight:600}',

  // The visit block: one box of three columns (address, hours, contact), then the call to become a member.
  '.visit{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)}',
  '.visit-2{grid-template-columns:repeat(2,minmax(0,1fr))}',
  '.visit-1{grid-template-columns:minmax(0,1fr)}',
  '.visit>div{padding:1.5rem;min-width:0}',
  '.visit>div+div{border-left:1px solid var(--border)}',
  '.visit h3{margin:0 0 .75rem;font-size:1.0625rem}',
  '.visit p{margin:0;font-size:.9375rem}',
  '.visit-address{white-space:pre-line}',
  '.visit .more-link{display:inline-block;margin-top:.75rem}',
  '.hours{width:100%;border-collapse:collapse;font-size:.9375rem}',
  '.hours th,.hours td{padding:.375rem 0;border-top:1px solid var(--border);font-weight:400;text-align:left;vertical-align:top}',
  '.hours tr:first-child th,.hours tr:first-child td{border-top:0;padding-top:0}',
  '.hours td{text-align:right;font-variant-numeric:tabular-nums;padding-left:1rem}',
  '.hours .today th,.hours .today td{font-weight:600}',
  '.visit .note,.note{margin:.75rem 0 0;font-size:.875rem;color:var(--muted)}',
  '.kv{display:grid;grid-template-columns:5.5rem minmax(0,1fr);gap:.375rem .75rem;margin:0;font-size:.9375rem}',
  '.kv dt{color:var(--muted)}',
  '.kv dd{margin:0;overflow-wrap:anywhere}',
  '.cta{display:flex;align-items:center;justify-content:space-between;gap:1.5rem;border:1px solid var(--border);border-radius:var(--radius);' +
    'background:var(--bg);padding:1.25rem 1.5rem;margin-top:1.5rem}',
  '.cta h2{margin:0;font-size:1.125rem}',
  '.cta p{margin:.125rem 0 0;font-size:.9375rem;color:var(--muted)}',

  // ---- Narrower screens ----
  '@media (max-width:68.74rem){.about{grid-template-columns:minmax(0,1fr) 20rem;gap:2.5rem}}',
  '@media (max-width:53.74rem){' +
    '.slide{grid-template-columns:minmax(0,1fr);grid-template-rows:11.25rem 1fr;min-height:30rem}' +
    '.slide-nophoto{grid-template-rows:1fr;min-height:20rem}' +
    '.slide>img{grid-row:1;height:11.25rem}' +
    '.slide-text{padding:1.5rem var(--gutter) 4.75rem;align-items:flex-start}' +
    '.slide h1,.slide h2{font-size:1.75rem}.slide-lead{font-size:1rem}' +
    '.section{padding:2.5rem 0}' +
    '.about h2{font-size:1.375rem}' +
    '.about,.about-nophoto,.news-agenda,.cols-2{grid-template-columns:minmax(0,1fr);gap:2rem}' +
    '.cols-2{margin-top:2rem}' +
    '.figures,.figures-3{grid-template-columns:1fr 1fr}.figures>div{padding:.75rem 1rem}.figures>div:nth-child(odd){padding-left:0;border-left:0}' +
    '.figures>div:nth-child(n+3){border-top:1px solid var(--border)}.figures dd{font-size:1.375rem}' +
    '.svc-grid{grid-template-columns:minmax(0,1fr)}.svc-grid li{padding:.75rem 0 1rem}' +
    // A phone shows four new titles and the news without their summaries.
    '.home-titles>li:nth-child(n+5){display:none}' +
    '.ddc{grid-template-columns:minmax(0,1fr)}' +
    '.newsrow{grid-template-columns:6.5rem minmax(0,1fr);gap:.75rem}.newsrow-nophoto{grid-template-columns:minmax(0,1fr)}' +
    '.home-news .news-summary{display:none}.newsrow h3{font-size:1rem}' +
    '.gallery,.facilities{grid-template-columns:1fr 1fr;gap:.75rem}' +
    '.visit,.visit-2{grid-template-columns:minmax(0,1fr)}.visit>div+div{border-left:0;border-top:1px solid var(--border)}' +
    '.cta{flex-direction:column;align-items:flex-start}' +
    '.class-ranking li{grid-template-columns:minmax(0,1fr)}' +
    '}',
].join('\n');
