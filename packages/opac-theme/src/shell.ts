// The `shell` module of @altis/opac-theme (S16), the OPAC shell (Phase 2 Task 21; spec §9.1, §9.2): the skip link,
// visible focus on every control, the header's menu and search form, the home page, and the shared components the
// catalogue's pages build on: result cards (`.card-grid`/`.card-list` of `.card`), facets (`.facet`), the availability
// table (`.availability` with `.status-*`), the shelf map (`.shelf-map`) and `.prose` for long text. Tasks 20, 33 and 34
// add only what is their own in their modules. Mobile first (one column, wider grids from the available width), every
// colour from base.ts's tokens (AA contrast in both schemes), targets at least 2.75 rem high, nothing fetched.

/** The CSS of the OPAC shell. */
export const SHELL_CSS: string = [
  // Skip link: off screen until focused, then on top of the header.
  '.skip-link{position:absolute;left:var(--gutter);top:-10rem;z-index:10;padding:.75rem 1rem;background:var(--accent);' +
    'color:var(--accent-ink);font-weight:700;border-radius:var(--radius);text-decoration:none}',
  '.skip-link:focus{top:.5rem}',
  'main:focus{outline:none}',
  '.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
    'clip:rect(0,0,0,0);white-space:nowrap;border:0}',

  // Visible focus on every control (base.ts gives links theirs; this makes it the same everywhere).
  'a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,' +
    'summary:focus-visible{outline:3px solid var(--focus);outline-offset:2px}',

  // Header: the menu and the search form below the brand.
  '.bar-tools{padding-top:0;padding-bottom:.75rem}',
  '.menu ul{display:flex;flex-wrap:wrap;gap:0 1rem;margin:0;padding:0;list-style:none}',
  '.menu a{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:600}',
  '.search-box{flex:1 1 16rem;max-width:32rem}',
  '.search-row{display:flex;gap:.5rem}',
  '.search-box input{flex:1;min-width:0;min-height:2.75rem;padding:.5rem .75rem;border:1px solid var(--muted);' +
    'border-radius:var(--radius);background:var(--bg);color:var(--text);font:inherit}',
  '.search-box input::placeholder{color:var(--muted);opacity:1}',
  '.search-box button{min-height:2.75rem;padding:0 1.25rem;border:0;border-radius:var(--radius);background:var(--accent);' +
    'color:var(--accent-ink);font:inherit;font-weight:700;cursor:pointer}',

  // Home page.
  '.hero{padding:0 0 1rem}',
  '.search-hero{max-width:40rem;margin:1.5rem 0 0}',
  '.search-hero label{display:block;margin-bottom:.5rem;font-weight:600}',
  '.search-hero input,.search-hero button{min-height:3.25rem;font-size:1.125rem}',
  '.home-section{margin-top:2.5rem}',
  '.home-section h2{margin:0 0 1rem}',
  '.more{margin:1rem 0 0}',
  '.class-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.5rem;margin:0;padding:0;list-style:none}',
  '.class-grid a{display:flex;align-items:center;gap:.75rem;min-height:2.75rem;height:100%;padding:.5rem .75rem;' +
    'background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius);color:var(--text);text-decoration:none}',
  '.class-grid a:hover .class-name{text-decoration:underline}',
  '.class-code{color:var(--accent);font-weight:700;font-variant-numeric:tabular-nums}',
  '.news-list{display:grid;gap:1rem;margin:0;padding:0;list-style:none}',
  '.news-list article{padding:1rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius)}',
  '.news-list h3{margin:0 0 .25rem;font-size:1.0625rem;line-height:1.4}',
  '.news-list time{display:block;margin-bottom:.5rem;color:var(--muted);font-size:.875rem}',
  '.news-list p{margin:0}',

  // Result cards: a grid of covers (home, browsing) or a list (results).
  '.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(9rem,1fr));gap:1rem;margin:0;padding:0;list-style:none}',
  '.card-list{display:grid;gap:1rem;margin:0;padding:0;list-style:none}',
  '.card{display:flex;flex-direction:column;gap:.5rem;min-width:0;padding:.75rem;background:var(--card-bg);' +
    'border:1px solid var(--card-border);border-radius:var(--radius);box-shadow:var(--card-shadow)}',
  '.card-list .card{flex-direction:row;align-items:flex-start}',
  '.card-cover{display:block;width:100%;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:calc(var(--radius)/2);' +
    'background:var(--border)}',
  '.card-list .card-cover{flex:none;width:4.5rem}',
  '.card-body{display:flex;flex-direction:column;gap:.25rem;min-width:0}',
  '.card-title{font-weight:600;line-height:1.35;overflow-wrap:anywhere}',
  '.card-subtitle{font-weight:400}',
  '.card-meta{color:var(--muted);font-size:.875rem;overflow-wrap:anywhere}',

  // Facets.
  '.facet{margin:0 0 1rem;padding:.75rem;background:var(--facet-bg);border:1px solid var(--card-border);border-radius:var(--radius)}',
  '.facet h2,.facet h3{margin:0 0 .5rem;font-size:1rem}',
  '.facet ul{margin:0;padding:0;list-style:none}',
  '.facet a{display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-height:2.75rem}',
  '.facet a[aria-current]{font-weight:700}',
  '.facet-count{color:var(--muted);font-variant-numeric:tabular-nums}',

  // The availability table and its statuses (text and border in the status colour, never colour alone).
  '.table-scroll{max-width:100%;overflow-x:auto}',
  '.availability{width:100%;border-collapse:collapse;font-size:.9375rem}',
  '.availability th,.availability td{padding:.5rem;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}',
  '.availability th{color:var(--muted);font-weight:600}',
  '.status{display:inline-block;padding:.125rem .5rem;border:1px solid currentColor;border-radius:999px;font-size:.875rem;font-weight:600}',
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

  // Wider screens: larger covers.
  '@media (min-width:48rem){.card-grid{grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))}.card-list .card-cover{width:6rem}}',
].join('\n');
