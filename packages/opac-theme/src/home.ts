// Home page stylesheet (`@altis/opac-theme`): full-bleed photographic hero with directional WCAG AA scrim, docked focal
// catalogue search card, and varied section rhythm (RHYTHM 3) across books, Dewey classes, library profile, news, gallery,
// and opening hours.
//
// Hero contrast & gradient rationale (R-01, R-25, R-31):
// - `.slide:not(.slide-nophoto)::after` lays a directional dark scrim over the full-bleed 16:9 photograph so white headline
//   (`#ffffff`, >= 8.45:1) and lead copy (`#edf1ef`, >= 7.42:1) hold WCAG AA even over a pure `#ffffff` background region,
//   while leaving the right side of the library photograph open and vivid.
// - Without slides (`.slide-nophoto`), the hero renders a compact solid `--panel` header band with no empty photo box.
// - Controls in `.hero-ui` and `.hero-dots a` meet the 44x44px (`2.75rem`) touch target minimum (R-03).

const POSITIONS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;
const SLIDES_MAX = 6;
const slideNumbers = Array.from({ length: SLIDES_MAX }, (_, i) => i + 1);

export const HOME_CSS: string = [
  '.hero{position:relative;background:#141817;color:#ffffff}',
  '.hero-track{display:grid;overflow:hidden;touch-action:pan-y}',
  '.hero-track>.slide{grid-area:1/1;visibility:hidden;opacity:0}',
  '.hero-track.js>.slide.is-on{visibility:visible;opacity:1}',
  '.hero-track:not(.js)>.slide{visibility:visible;opacity:1;z-index:0}',
  '.hero-track:not(.js)>.slide:first-child{z-index:1}',
  '.hero-track:not(.js)>.slide:target{z-index:2}',
  '.slide{position:relative;display:grid;min-height:clamp(25rem,38vw,32rem);min-width:0}',
  '.slide>img{position:absolute;inset:0;z-index:0;display:block;width:100%;height:100%;max-width:none;object-fit:cover}',
  // Purposeful contrast scrim over full-bleed photography (R-01, R-25): >= 7.18:1 for overlaid copy across the text column.
  '.slide:not(.slide-nophoto)::after{content:"";grid-area:1/1;z-index:1;pointer-events:none;' +
    'background:linear-gradient(98deg,rgb(12 16 15/.86) 0%,rgb(12 16 15/.74) 48%,rgb(12 16 15/.16) 100%)}',
  '.slide-text{grid-area:1/1;z-index:2;color:#ffffff;display:flex;align-items:flex-end;min-width:0;width:100%;' +
    'max-width:calc(var(--wide) + 2*var(--gutter));margin:0 auto;padding:3rem var(--gutter) 2.75rem}',
  '.slide-nophoto{min-height:17rem;background:var(--panel)}',
  '.slide-nophoto .slide-text{align-items:center;padding:3rem var(--gutter);color:var(--on-panel)}',
  '.slide-body{max-width:36rem;min-width:0}',
  '.slide-nophoto .slide-body{max-width:44rem}',
  '.slide-note{margin:0 0 .5rem;font-size:.90625rem;font-weight:600;color:#edf1ef}',
  '.slide h1,.slide h2{margin:0;font-size:clamp(1.875rem,3vw + .75rem,2.75rem);line-height:1.15;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere}',
  '.slide-lead{margin:.75rem 0 0;font-size:clamp(1rem,.35vw + .92rem,1.125rem);line-height:1.55;max-width:48ch;color:#edf1ef;white-space:pre-line}',
  '.slide-cta{display:flex;flex-wrap:wrap;gap:.625rem;margin:1.375rem 0 0}',
  POSITIONS.map((p) => `.hero-pos-${p}{object-position:50% ${p}%}`).join(''),

  // Carousel controls: 44x44px (`2.75rem`) buttons and dot hit-boxes in a grounded dark pill on the bottom-right.
  '.hero-ui{position:absolute;z-index:3;right:max(var(--gutter),calc(50vw - 37.5rem));bottom:1.75rem;display:inline-flex;align-items:center;gap:.25rem;' +
    'padding:.1875rem .5rem;border-radius:var(--radius);background:rgb(12 16 15/.62);border:1px solid rgb(255 255 255/.24);color:#ffffff}',
  '.hero-ui button{display:grid;place-items:center;width:2.75rem;height:2.75rem;border:0;border-radius:var(--radius-sm);background:none;' +
    'color:inherit;cursor:pointer;padding:0}',
  '.hero-ui button:hover{background:rgb(255 255 255/.16)}',
  '.hero-ui button:active{background:rgb(255 255 255/.26)}',
  '.hero-ui .ico{width:1.125rem;height:1.125rem}',
  '.hero-dots{display:flex;gap:.125rem;margin-right:.25rem}',
  '.hero-dots a{display:block;width:1.75rem;height:.25rem;box-sizing:content-box;padding:1.25rem .5rem;border-radius:2px;' +
    'background-color:rgb(255 255 255/.42);background-clip:content-box}',
  '.hero-dots a:hover{background-color:rgb(255 255 255/.72)}',
  '.hero-dots a[aria-current="true"]{background-color:#ffffff}',
  '.hero:has(.hero-track:not(.js)>.slide:target) .hero-dots a[aria-current="true"]{background-color:rgb(255 255 255/.42)}',
  slideNumbers.map((n) => `.hero:has(.hero-track:not(.js)>#slide-${n}:target) .hero-dots a:nth-child(${n})`).join(',') + '{background-color:#ffffff}',
  '.hero a:focus-visible,.hero button:focus-visible{outline-color:#ffffff}',
  '@media (prefers-reduced-motion:no-preference){.hero-track.js>.slide{transition:opacity .45s ease,visibility .45s}}',

  // Full-width flush search band immediately below the hero: zero dead side gutters, compact two-line layout.
  '.home-search{padding:1.375rem 0}',

  // Varied section rhythm (RHYTHM 3, R-05): distinct vertical cadence and one stone institutional band (`.section-band`).
  '.section{padding:3.75rem 0}',
  '.section-compact{padding:2.75rem 0}',
  '.section-band{background:var(--layer);border-block:1px solid var(--border);padding:4.5rem 0}',
  '.h3{margin:0 0 .875rem;font-size:1.125rem;letter-spacing:-.01em}',
  '.h3 small{color:var(--muted);font-weight:400;font-size:.90625rem}',

  // New titles on the home page get larger 84px book covers so physical book proportions stand out from dense search rows.
  '.home-titles .card{grid-template-columns:5.25rem minmax(0,1fr);gap:1.125rem;padding:1.125rem 0}',
  '.home-titles .card .book-cover{padding:.5rem .4375rem}',
  '.home-titles .card .book-cover .cover-title{font-size:.6875rem}',

  // Institutional story & collection ledger: asymmetric editorial split + tabular fact strip.
  '.about{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(20rem,.85fr);gap:3.5rem;align-items:center}',
  '.about-nophoto{grid-template-columns:minmax(0,1fr)}',
  '.about h2{margin:0 0 .875rem;font-size:clamp(1.4375rem,1.6vw + .85rem,1.75rem);letter-spacing:-.01em}',
  '.about p{margin:0;max-width:64ch;font-size:1.03125rem;line-height:1.6}',
  '.about p+p{margin-top:.875rem}',
  '.about .more-link{margin-top:1.125rem}',
  '.about-photo{margin:0}',
  '.about-photo img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:var(--radius);border:1px solid var(--border)}',
  '.about-photo figcaption,.gallery figcaption,.facilities figcaption{font-size:.875rem;color:var(--muted);margin-top:.4375rem}',
  '.figures{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--border-strong);border-bottom:1px solid var(--border);margin:2.5rem 0 0;padding:0}',
  '.figures-3{grid-template-columns:repeat(3,minmax(0,1fr))}',
  '.figures-2{grid-template-columns:repeat(2,minmax(0,1fr))}',
  '.figures-1{grid-template-columns:minmax(0,1fr)}',
  '.figures>div{display:flex;flex-direction:column-reverse;gap:.125rem;padding:1.125rem 1.5rem;min-width:0}',
  '.figures>div+div{border-left:1px solid var(--border)}',
  '.figures>div:first-child{padding-left:0}',
  '.figures dd{margin:0;font-size:clamp(1.625rem,2.4vw + .75rem,2.125rem);line-height:1.15;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}',
  '.figures dt{font-size:.90625rem;color:var(--muted)}',

  // Services: typographic columns under crisp rule lines, without decorative cards or icons (R-04, R-14).
  '.svc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1.5rem 2.5rem;margin:0;padding:0;list-style:none}',
  '.svc-grid li{border-top:2px solid var(--text);padding:1rem 0 .5rem;min-width:0}',
  '.svc-grid h3{margin:0 0 .375rem;font-size:1.0625rem;font-weight:700}',
  '.svc-grid p{margin:0;font-size:.9375rem;color:var(--muted)}',

  // Asymmetric pairing: numbered popular list beside two-column Dewey Decimal index.
  '.cols-2{display:grid;grid-template-columns:minmax(0,.92fr) minmax(0,1.28fr);gap:3.5rem;margin-top:3rem}',
  '.cols-1{grid-template-columns:minmax(0,1fr)}',
  '.cols-2:first-child{margin-top:0}',
  '.rank{margin:0;padding:0;list-style:none}',
  '.rank li{display:grid;grid-template-columns:1.75rem minmax(0,1fr);gap:.5rem;padding:.6875rem 0;border-top:1px solid var(--border);align-items:baseline}',
  '.rank-n{color:var(--muted);font-weight:600;font-variant-numeric:tabular-nums}',
  '.rank a{color:var(--text);font-weight:600;font-size:.96875rem}',
  '.rank small{display:block;color:var(--muted);font-size:.875rem;margin-top:.125rem}',
  '.ddc{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 2rem;margin:0;padding:0;list-style:none}',
  '.ddc a{display:grid;grid-template-columns:2.625rem minmax(0,1fr) auto;gap:.5rem;min-height:2.75rem;padding:.625rem 0;border-top:1px solid var(--border);color:var(--text);' +
    'font-size:.9375rem;align-items:baseline}',
  '.ddc a:hover{color:var(--accent)}',
  '.ddc .mono,.ddc-count{color:var(--muted)}',
  '.ddc-count{font-size:.875rem;font-variant-numeric:tabular-nums}',
  '.class-ranking{margin:0;padding:0;list-style:none;max-width:44rem}',
  '.class-ranking li{display:grid;grid-template-columns:7rem minmax(0,1fr) auto;gap:.25rem 1rem;align-items:baseline;padding:.6875rem 0;' +
    'border-top:1px solid var(--border)}',
  '.class-place{color:var(--muted);font-size:.875rem}',
  '.class-label{font-weight:600;overflow-wrap:anywhere}',
  '.class-counts{color:var(--muted);font-size:.875rem;font-variant-numeric:tabular-nums}',

  // News list beside upcoming agenda rail.
  '.news-agenda{display:grid;grid-template-columns:minmax(0,1fr) 21.5rem;gap:3.5rem;align-items:start}',
  '.news-agenda-1{grid-template-columns:minmax(0,1fr)}',
  '.news-rows{margin:0;padding:0;list-style:none}',
  '.newsrow{position:relative;display:grid;grid-template-columns:12rem minmax(0,1fr);gap:1.25rem;padding:1.25rem 0;border-top:1px solid var(--border)}',
  '.news-rows>li:first-child>.newsrow{border-top:0;padding-top:0}',
  '.newsrow-nophoto{grid-template-columns:minmax(0,1fr)}',
  '.newsrow img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover;border-radius:var(--radius-sm);background:var(--layer-2);border:1px solid var(--border)}',
  '.newsmeta{margin:0 0 .25rem;font-size:.84375rem;color:var(--muted)}',
  '.newsmeta b{color:var(--text);font-weight:600}',
  '.newsrow h3{margin:0 0 .25rem;font-size:1.125rem}',
  '.newsrow h3 a{color:var(--text)}',
  '.newsrow h3 a::after{content:"";position:absolute;inset:0}',
  '.newsrow:hover h3 a{color:var(--accent);text-decoration:underline}',
  '.newsrow p.news-summary{margin:0;font-size:.9375rem;color:var(--muted);max-width:64ch}',
  '.agenda{margin:0;padding:0;list-style:none}',
  '.agenda li{display:grid;grid-template-columns:3.25rem minmax(0,1fr);gap:.875rem;padding:.75rem 0;border-top:1px solid var(--border);align-items:center}',
  '.datebox{border:1px solid var(--border-strong);border-radius:var(--radius-sm);text-align:center;padding:.3125rem 0;background:var(--surface)}',
  '.datebox b{display:block;font-size:1.0625rem;line-height:1.2;font-variant-numeric:tabular-nums}',
  '.datebox small{display:block;font-size:.75rem;color:var(--muted);line-height:1.2}',
  '.agenda-title{display:block;font-weight:600;font-size:.9375rem;color:var(--text)}',
  '.agenda-meta{display:block;font-size:.875rem;color:var(--muted)}',

  '.gallery,.facilities{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1.25rem;margin:0;padding:0;list-style:none}',
  '.gallery figure,.facilities figure{margin:0}',
  '.gallery img,.facilities img{display:block;width:100%;height:auto;aspect-ratio:3/2;object-fit:cover;border-radius:var(--radius-sm);background:var(--layer-2);border:1px solid var(--border)}',
  '.facilities figcaption b{display:block;color:var(--text);font-size:.9375rem;font-weight:600}',

  // Civic visit directory & membership invitation strip.
  '.visit{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}',
  '.visit-2{grid-template-columns:repeat(2,minmax(0,1fr))}',
  '.visit-1{grid-template-columns:minmax(0,1fr)}',
  '.visit>div{padding:1.5rem;min-width:0}',
  '.visit>div+div{border-left:1px solid var(--border)}',
  '.visit h3{margin:0 0 .75rem;font-size:1.0625rem}',
  '.visit p{margin:0;font-size:.9375rem}',
  '.visit-address{white-space:pre-line}',
  '.visit .more-link{margin-top:.75rem}',
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
    'background:var(--accent-soft);padding:1.375rem 1.625rem;margin-top:1.5rem}',
  '.cta h2{margin:0;font-size:1.125rem}',
  '.cta p{margin:.1875rem 0 0;font-size:.9375rem;color:var(--muted)}',

  // Tablet / small-laptop state (640px-1099px): two-column grids and balanced proportions instead of stretched mobile or cramped 4-col.
  '@media (max-width:68.74rem){' +
    '.about{grid-template-columns:minmax(0,1fr) 20rem;gap:2.5rem}' +
    '.svc-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:1.25rem 2rem}' +
    '.gallery,.facilities{grid-template-columns:repeat(2,minmax(0,1fr))}' +
    '.cols-2,.news-agenda{grid-template-columns:minmax(0,1fr);gap:2.5rem}' +
    '.visit{grid-template-columns:repeat(2,minmax(0,1fr))}' +
    '.visit>div:nth-child(3){grid-column:1/-1;border-left:0;border-top:1px solid var(--border)}' +
    '}',

  // Phone / narrow tablet state (<= 859px): vertical photo scrim, clean non-overlapping search dock, stacked sections.
  '@media (max-width:53.74rem){' +
    '.slide{min-height:24.5rem}' +
    '.slide-nophoto{min-height:14rem}' +
    '.slide:not(.slide-nophoto)::after{background:linear-gradient(180deg,rgb(12 16 15/.24) 0%,rgb(12 16 15/.74) 40%,rgb(12 16 15/.90) 100%)}' +
    '.slide-text{padding:5.5rem var(--gutter) 5.25rem;align-items:flex-end}' +
    '.slide-nophoto .slide-text{padding:2.25rem var(--gutter)}' +
    '.hero-ui{left:var(--gutter);right:auto;bottom:1rem}' +
    '.home-search{padding:1.125rem 0}' +
    '.section{padding:2.5rem 0}.section-compact{padding:2rem 0}.section-band{padding:2.75rem 0}' +
    '.about,.about-nophoto{grid-template-columns:minmax(0,1fr);gap:1.75rem}' +
    '.cols-2{margin-top:2rem;gap:2rem}' +
    '.figures,.figures-3{grid-template-columns:1fr 1fr}.figures>div{padding:.875rem 1rem}.figures>div:nth-child(odd){padding-left:0;border-left:0}' +
    '.figures>div:nth-child(n+3){border-top:1px solid var(--border)}' +
    '.home-titles>li:nth-child(n+5){display:none}' +
    '.ddc{grid-template-columns:minmax(0,1fr)}' +
    '.newsrow{grid-template-columns:6.75rem minmax(0,1fr);gap:.875rem}.newsrow-nophoto{grid-template-columns:minmax(0,1fr)}' +
    '.home-news .news-summary{display:none}.newsrow h3{font-size:1rem}' +
    '.visit,.visit-2{grid-template-columns:minmax(0,1fr)}.visit>div+div,.visit>div:nth-child(3){border-left:0;border-top:1px solid var(--border);grid-column:auto}' +
    '.cta{flex-direction:column;align-items:flex-start;padding:1.25rem}' +
    '.class-ranking li{grid-template-columns:minmax(0,1fr)}' +
    '}',

  // Compact phone state (< 640px): single-column services and single/paired gallery reflow cleanly without cramped text.
  '@media (max-width:39.99rem){' +
    '.svc-grid{grid-template-columns:minmax(0,1fr);gap:.75rem}' +
    '.gallery,.facilities{grid-template-columns:1fr 1fr;gap:.75rem}' +
    '}',
].join('\n');
