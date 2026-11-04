// The `search` module of @altis/opac-theme (S16), the search page: result cards, facets, paging and the spelling
// suggestion (spec §4, §9.1). Owned by Phase 2 Task 33; written here and in no other module. index.ts joins the modules
// in a fixed order; the tokens (colours, spacing) come from base.ts as custom properties, and the shared components
// (`.card*`, `.facet`, `.status*`, `.search-box`, `.visually-hidden`) from shell.ts. Mobile first: the results, then the
// facets below them (a "Saring hasil" link jumps there); from 60 rem the facets take a column on the left. Every
// target is at least 2.75 rem high, focus stays visible (shell.ts), nothing is fetched.

/** The CSS of the search page. */
export const SEARCH_CSS: string = [
  // The head: the heading and the search box.
  '.search-page{padding-bottom:1rem}',
  '.search-head h1{margin:0 0 1rem}',
  '.search-main{max-width:40rem}',

  // Notices: the index being rebuilt, the spelling line, the page cap.
  '.notice{margin:1rem 0;padding:.75rem 1rem;background:var(--card-bg);border:1px solid var(--card-border);' +
    'border-left:4px solid var(--accent);border-radius:var(--radius)}',
  '.notice-warn{border-left-color:var(--warn)}',
  '.notice-correction em{font-style:normal;font-weight:700}',

  // The layout: results, then the facets; two columns on wide screens.
  '.search-layout{display:grid;gap:1.5rem;margin-top:1rem}',
  '.search-results{min-width:0}',
  '.search-summary{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem;margin:0 0 1rem}',
  '.search-count{margin:0;color:var(--muted)}',
  '.filter-jump{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:600}',

  // The order and year forms.
  '.sort-form{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}',
  '.sort-form select,.year-form input{min-height:2.75rem;padding:.25rem .5rem;border:1px solid var(--muted);' +
    'border-radius:var(--radius);background:var(--bg);color:var(--text);font:inherit}',
  '.sort-form button,.year-form button{min-height:2.75rem;padding:0 1rem;border:1px solid var(--accent);border-radius:var(--radius);' +
    'background:var(--surface);color:var(--accent);font:inherit;font-weight:600;cursor:pointer}',
  '.year-form label{display:block;margin-bottom:.5rem;font-weight:600}',
  '.year-row{display:flex;gap:.5rem}',
  '.year-row input{flex:1;min-width:0}',

  // Results.
  '.result-list{margin-top:0}',
  '.card-badges{display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.25rem}',
  '.search-empty{padding:1rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius)}',
  '.search-empty p{margin:0 0 .5rem}',
  '.search-empty p:last-child{margin:0}',
  '.feed-link{margin:1rem 0 0;font-size:.9375rem}',

  // The pager: links and the current page as boxes of at least 2.75 rem.
  '.pager{margin:1.5rem 0 0}',
  '.pager ul{display:flex;flex-wrap:wrap;gap:.25rem;margin:0;padding:0;list-style:none}',
  '.pager a,.pager [aria-current]{display:inline-flex;align-items:center;justify-content:center;min-width:2.75rem;min-height:2.75rem;' +
    'padding:0 .75rem;background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius)}',
  '.pager [aria-current]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:700}',
  '.pager-gap{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .25rem;color:var(--muted)}',

  // Facets (the boxes themselves are shell.ts's `.facet`) and the active filters.
  '.facets>h2{margin:0 0 .75rem;font-size:1.125rem}',
  '.facet-label{min-width:0;overflow-wrap:anywhere}',
  '.facet-more summary{display:flex;align-items:center;min-height:2.75rem;color:var(--accent);font-weight:600;cursor:pointer}',
  '.facet-hint{display:block;margin:.25rem 0 0;color:var(--muted);font-size:.875rem}',
  '.facets>.facet-hint{margin:0 0 1rem}',
  '.filters-active{margin:0 0 1rem;padding:.75rem;background:var(--facet-bg);border:1px solid var(--accent);border-radius:var(--radius)}',
  '.filters-active h3{margin:0 0 .5rem;font-size:1rem}',
  '.filters-active ul{margin:0;padding:0;list-style:none}',
  '.filters-active a{display:flex;align-items:center;min-height:2.75rem}',
  '.filters-clear{margin:.5rem 0 0}',

  // Wide screens: the facets on the left, the jump link no longer needed.
  '@media (min-width:60rem){.search-layout{grid-template-columns:17rem minmax(0,1fr);align-items:start}' +
    '.facets{grid-column:1;grid-row:1}.search-results{grid-column:2}.filter-jump{display:none}}',
].join('\n');
