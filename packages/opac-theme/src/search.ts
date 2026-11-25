// Stylesheet for catalogue search results (`/cari`) and advanced search (`/cari/lanjutan`).

export const SEARCH_CSS: string = [
  '.search-page{padding-bottom:1rem}',
  '.search-main{max-width:none}',

  '.notice{margin:1rem 0;padding:.75rem 1rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius)}',
  '.notice-warn{border-color:var(--warn)}',
  '.notice-correction em{font-style:normal;font-weight:700}',

  '.search-layout{display:grid;gap:2rem}',
  '.search-results{display:grid;gap:.75rem;align-content:start;min-width:0}',
  '.results-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem}',
  '.results-head h1{margin:0;font-size:1.375rem;line-height:1.3;letter-spacing:0}',
  '.search-summary{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.25rem 1rem;margin:0;padding-bottom:.75rem;' +
    'border-bottom:1px solid var(--border-strong)}',
  '.search-count{margin:0;color:var(--muted);font-size:.9375rem}',
  '.filter-jump{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:600}',

  '.sort-form{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;font-size:.90625rem;color:var(--muted)}',
  '.sort-form select,.year-form input{min-height:2.75rem;padding:0 .625rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font:inherit}',
  '.year-form button{min-height:2.75rem;padding:0 .875rem;border:1px solid var(--border-strong);border-radius:var(--radius-sm);' +
    'background:var(--surface);color:var(--text);font:inherit;font-weight:600;cursor:pointer}',
  '.year-form button:hover{background:var(--layer);border-color:var(--text)}',
  '.year-form label{display:block;margin-bottom:.375rem;font-size:.875rem;font-weight:600}',
  '.year-row{display:flex;gap:.5rem}',
  '.year-row input{flex:1;min-width:0}',

  '.result-list .card{grid-template-columns:4.25rem minmax(0,1fr) auto;gap:1.25rem;padding:1.125rem 0;border-top:0;border-bottom:1px solid var(--border)}',
  '.result-list .card-title{font-size:1.0625rem}',
  '.result-line{color:var(--muted);font-size:.90625rem;overflow-wrap:anywhere}',
  '.result-list .card-meta{font-size:.875rem;margin-top:.25rem}',
  '.result-side{display:grid;gap:.25rem;justify-items:end;align-content:start;font-size:.875rem;text-align:right;max-width:14rem}',
  '.result-call{color:var(--muted)}',
  '.call-number{font-variant-numeric:tabular-nums}',
  '.card-badges{display:flex;flex-wrap:wrap;gap:.25rem .75rem;font-size:.875rem}',
  '.search-empty{display:grid;gap:.5rem;padding:1.5rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius)}',
  '.search-empty p{margin:0}',
  '.search-empty p+p{color:var(--muted)}',
  '.empty-clear{justify-self:start}',
  '.feed-link{margin:1rem 0 0;font-size:.875rem}',

  // Pager controls meet 44x44px (`2.75rem`) tap targets with spacing (R-03).
  '.pager{margin:1.5rem 0 0}',
  '.pager ul{display:flex;flex-wrap:wrap;gap:.375rem;margin:0;padding:0;list-style:none}',
  '.pager a,.pager [aria-current]{display:inline-flex;align-items:center;justify-content:center;min-width:2.75rem;min-height:2.75rem;' +
    'padding:0 .75rem;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font-size:.90625rem;text-decoration:none}',
  '.pager a:hover{background:var(--layer);border-color:var(--text)}',
  '.pager [aria-current]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}',
  '.pager-gap{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .25rem;color:var(--muted)}',

  '.facets>h2{margin:0 0 .75rem;font-size:1rem}',
  '.facets>.facet:first-of-type{border-top:0;padding-top:0}',
  '.facet-label{min-width:0;overflow-wrap:anywhere}',
  '.facet-more summary{display:flex;align-items:center;min-height:2.75rem;color:var(--accent);font-size:.9375rem;font-weight:600;cursor:pointer}',
  '.facet-hint{display:block;margin:.25rem 0 0;color:var(--muted);font-size:.8125rem}',
  '.facets>.facet-hint{margin:0 0 1rem}',
  '.filters-active{margin:0 0 1rem;padding:0 0 1rem;border-bottom:1px solid var(--border)}',
  '.filters-active h3{margin:0 0 .5rem;font-size:.90625rem}',
  '.filters-active ul{display:flex;flex-wrap:wrap;gap:.375rem;margin:0;padding:0;list-style:none}',
  '.filters-active li a{display:inline-flex;align-items:center;min-height:2.25rem;padding:0 .625rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font-size:.875rem}',
  '.filters-active li a:hover{background:var(--layer);border-color:var(--text)}',
  '.filters-clear{margin:.5rem 0 0;font-size:.9375rem}',

  '.advanced-link{font-weight:400}',
  '.filters-remove{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:600;font-size:.9375rem;margin-right:auto}',
  '.search-summary .search-count{margin-right:.5rem}',
  '.advanced-page{max-width:56rem}',
  '.advanced-page h1{margin:0 0 .5rem}',
  '.advanced-intro{color:var(--muted);max-width:68ch}',
  '.advanced-form{display:grid;gap:1.5rem}',
  '.adv-group{display:grid;gap:1rem 1.25rem;margin:0;padding:1.25rem 0 0;border:0;border-top:1px solid var(--border);min-width:0}',
  '.adv-group legend{float:left;grid-column:1/-1;width:100%;margin:0 0 .25rem;padding:0;font-size:1rem;font-weight:700}',
  '.adv-field{display:grid;gap:.375rem;align-content:start;min-width:0}',
  '.adv-field label{font-size:.875rem;font-weight:600}',
  '.adv-field input[type=text],.adv-field select{width:100%;min-height:2.75rem;padding:0 .75rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font:inherit}',
  '.adv-hint{color:var(--muted);font-size:.8125rem}',
  '.adv-check{display:flex;align-items:center;gap:.5rem;min-height:2.75rem;align-self:end}',
  '.adv-check input{width:1.125rem;height:1.125rem;margin:0;accent-color:var(--accent)}',
  '.adv-check label{font-weight:600}',
  '.adv-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.25rem}',
  '.adv-actions button{min-height:2.75rem;padding:0 1.5rem;border:0;border-radius:var(--radius-sm);background:var(--accent);' +
    'color:var(--accent-ink);font:600 .9375rem var(--font);cursor:pointer}',
  '.adv-actions button:hover{background:var(--accent-hover)}',
  '.adv-actions a{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:600}',
  '@media (min-width:40rem){.adv-group{grid-template-columns:repeat(2,minmax(0,1fr))}.adv-wide{grid-column:1/-1}}',
  '@media (min-width:60rem){.adv-group{grid-template-columns:repeat(3,minmax(0,1fr))}}',
  '@media (max-width:53.74rem){.result-list .card{grid-template-columns:3.5rem minmax(0,1fr)}' +
    '.result-side{grid-column:2;justify-items:start;text-align:left;max-width:none}.filters-active li a{min-height:2.75rem}}',

  '@media (min-width:60rem){.search-layout{grid-template-columns:15.5rem minmax(0,1fr);gap:3rem;align-items:start}' +
    '.facets{grid-column:1;grid-row:1}.search-results{grid-column:2}.filter-jump{display:none}}',
].join('\n');
