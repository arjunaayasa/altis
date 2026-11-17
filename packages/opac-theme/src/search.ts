// The `search` module of @altis/opac-theme (S16), the search page: the results as a list with thin lines between them
// (no boxes), the facets, paging and the spelling suggestion (spec §4, §9.1). Owned by Phase 2 Task 33; written here
// and in no other module. index.ts joins the modules in a fixed order; the tokens (colours, spacing) come from base.ts
// as custom properties, and the shared components (`.card*`, `.book-cover`, `.facet`, `.status*`, `.search-box`,
// `.visually-hidden`) from shell.ts. Mobile first: the results, then the facets below them (a "Saring hasil" link
// jumps there); from 60 rem the facets take a narrow column on the left. Every target is at least 2.75 rem high (the
// facet rows 2.25 rem), focus stays visible (shell.ts), nothing is fetched.

/** The CSS of the search page. */
export const SEARCH_CSS: string = [
  '.search-page{padding-bottom:1rem}',
  '.search-main{max-width:47.5rem}',

  // Notices: the index being rebuilt, the spelling line, the page cap.
  '.notice{margin:1rem 0;padding:.75rem 1rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius)}',
  '.notice-warn{border-color:var(--warn)}',
  '.notice-correction em{font-style:normal;font-weight:700}',

  // The layout: results, then the facets; two columns on wide screens.
  '.search-layout{display:grid;gap:2rem}',
  '.search-results{display:grid;gap:.75rem;align-content:start;min-width:0}',
  '.results-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1rem}',
  '.results-head h1{margin:0;font-size:1.375rem;line-height:1.3}',
  '.search-summary{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.25rem 1rem;margin:0}',
  '.search-count{margin:0;color:var(--muted);font-size:.9375rem}',
  '.filter-jump{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:600}',

  // The order and year forms.
  '.sort-form{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;font-size:.9375rem}',
  '.sort-form select,.year-form input{min-height:2.5rem;padding:0 .5rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font:inherit}',
  '.sort-form button,.year-form button{min-height:2.5rem;padding:0 .875rem;border:1px solid var(--border-strong);border-radius:var(--radius-sm);' +
    'background:var(--bg);color:var(--text);font:inherit;font-weight:600;cursor:pointer}',
  '.sort-form button:hover,.year-form button:hover{background:var(--layer-2)}',
  '.year-form label{display:block;margin-bottom:.375rem;font-size:.875rem;font-weight:700}',
  '.year-row{display:flex;gap:.5rem}',
  '.year-row input{flex:1;min-width:0}',

  // Results: a list with thin lines, the cover (or the cloth strip) on the left, no box.
  '.result-list{border-top:1px solid var(--border)}',
  '.result-list .card{display:grid;grid-template-columns:2.75rem minmax(0,1fr);gap:1rem;align-items:start;padding:1rem 0;' +
    'border-bottom:1px solid var(--border)}',
  '.result-list .card-cover{width:2.75rem;border-radius:1px 3px 3px 1px}',
  '.result-list .card-title{color:var(--accent);font-size:1.125rem;line-height:1.35}',
  '.result-list .card-meta{font-size:.875rem}',
  '.result-line{color:var(--text);font-size:.9375rem;overflow-wrap:anywhere}',
  '.call-number{font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.02em}',
  '.card-badges{display:flex;flex-wrap:wrap;gap:.25rem .75rem;margin-top:.125rem;font-size:.9375rem}',
  '.search-empty{display:grid;gap:.5rem;padding:1rem 0;border-top:1px solid var(--border)}',
  '.search-empty p{margin:0}',
  '.search-empty p+p{color:var(--muted)}',
  '.empty-clear{display:inline-flex;align-items:center;justify-self:start;min-height:2.5rem;padding:0 .875rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);color:var(--text);font-weight:600;text-decoration:none}',
  '.empty-clear:hover{background:var(--layer-2)}',
  '.feed-link{margin:1rem 0 0;font-size:.875rem}',

  // The pager: links and the current page as boxes of at least 2.75 rem.
  '.pager{margin:1.5rem 0 0}',
  '.pager ul{display:flex;flex-wrap:wrap;gap:.25rem;margin:0;padding:0;list-style:none}',
  '.pager a,.pager [aria-current]{display:inline-flex;align-items:center;justify-content:center;min-width:2.75rem;min-height:2.75rem;' +
    'padding:0 .75rem;border:1px solid var(--border);border-radius:var(--radius-sm);text-decoration:none}',
  '.pager a:hover{background:var(--layer-2)}',
  '.pager [aria-current]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:700}',
  '.pager-gap{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .25rem;color:var(--muted)}',

  // Facets (the lists themselves are shell.ts's `.facet`) and the active filters.
  '.facets>h2{margin:0 0 1rem;font-size:1rem}',
  '.facet-label{min-width:0;overflow-wrap:anywhere}',
  '.facet-more summary{display:flex;align-items:center;min-height:2.25rem;color:var(--accent);font-size:.9375rem;font-weight:600;cursor:pointer}',
  '.facet-hint{display:block;margin:.25rem 0 0;color:var(--muted);font-size:.8125rem}',
  '.facets>.facet-hint{margin:0 0 1rem}',
  '.filters-active{margin:0 0 1.375rem;padding:0 0 1rem;border-bottom:1px solid var(--border)}',
  '.filters-active h3{margin:0 0 .375rem;font-size:.875rem}',
  '.filters-active ul{margin:0;padding:0;list-style:none}',
  '.filters-active a{display:flex;align-items:center;min-height:2.25rem;font-size:.9375rem}',
  '.filters-clear{margin:.25rem 0 0;font-size:.9375rem}',

  // Wide screens: the facets on the left, the jump link no longer needed.
  '@media (min-width:60rem){.search-layout{grid-template-columns:13.75rem minmax(0,1fr);gap:2.5rem;align-items:start}' +
    '.facets{grid-column:1;grid-row:1}.search-results{grid-column:2}.filter-jump{display:none}}',
].join('\n');
