// Stylesheet for OPAC static pages, news posts, `/berita` news index, `/profil` library profile, and `/galeri`.

export const PAGES_CSS: string = [
  '.article{max-width:45rem;margin:0 auto}',
  '.page-article{display:block;min-width:0}',
  '.page-article h1{margin:.25rem 0 .75rem;font-size:clamp(1.625rem,2.4vw + .85rem,2.125rem);line-height:1.2;letter-spacing:-.01em}',
  '.page-note{padding:.75rem 1rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius);font-size:.9375rem}',
  '.page-back{margin:2rem 0 0;padding-top:1rem;border-top:1px solid var(--border);text-align:right;font-weight:600;font-size:.9375rem}',
  '.page-meta{margin:0 0 .25rem;color:var(--muted);font-size:.84375rem}',
  '.page-lead{font-size:1.125rem}',
  '.page-cover{display:block;width:100%;max-width:100%;height:auto;margin:1.5rem 0;border-radius:var(--radius);border:1px solid var(--border)}',
  // Event metadata callout uses a warm stone surface instead of a decorative colored left stripe (R-01, R-31).
  '.eventbox{background:var(--layer);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem;margin:0 0 1.5rem}',

  '.page-body{overflow-wrap:anywhere}',
  '.page-body h2,.page-body h3,.page-body h4{margin:1.75rem 0 .5rem;line-height:1.3}',
  '.page-body h3{font-size:1.125rem}',
  '.page-body h4{font-size:1rem}',
  '.page-body ul,.page-body ol{margin:0 0 1rem;padding-left:1.5rem}',
  '.page-body li{margin:.25rem 0}',
  '.page-body blockquote{margin:0 0 1rem;padding:.5rem 1rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--muted)}',
  '.page-body img{max-width:100%;height:auto;border-radius:var(--radius-sm)}',
  '.page-body figure{margin:0 0 1rem}',
  '.page-body figcaption{color:var(--muted);font-size:.875rem;margin-top:.375rem}',
  '.page-body hr{margin:2rem 0;border:0;border-top:1px solid var(--border)}',
  '.page-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9375em}',
  '.page-body pre{max-width:100%;overflow-x:auto;margin:0 0 1rem;padding:.75rem;background:var(--layer);' +
    'border:1px solid var(--border);border-radius:var(--radius)}',
  '.page-body table{display:block;max-width:100%;overflow-x:auto;margin:0 0 1rem;border-collapse:collapse}',
  '.page-body th,.page-body td{padding:.5rem;border:1px solid var(--border);text-align:left;vertical-align:top}',
  '.page-body th{background:var(--layer)}',

  '.newslist{display:grid;grid-template-columns:minmax(0,1fr) 20rem;gap:3.5rem;align-items:start}',
  '.newslist-1{grid-template-columns:minmax(0,1fr)}',
  '.newslist h2{margin:0 0 .25rem;font-size:1.125rem}',
  '.newslist h2 a{color:var(--text)}',
  '.newslist h2 a::after{content:"";position:absolute;inset:0}',
  '.newslist .newsrow:hover h2 a{color:var(--accent);text-decoration:underline}',
  '.texttabs{display:flex;flex-wrap:wrap;gap:0 1.5rem;border-bottom:1px solid var(--border);margin:0 0 1.5rem}',
  '.texttabs a{display:inline-flex;align-items:center;min-height:2.75rem;padding:.5rem 0;color:var(--text);font-size:.9375rem;border-bottom:2px solid transparent;margin-bottom:-1px}',
  '.texttabs a:hover{text-decoration:none;color:var(--accent)}',
  '.texttabs a[aria-current]{border-bottom-color:var(--accent);color:var(--accent);font-weight:600}',
  '.texttabs .news-feed{margin-left:auto;color:var(--accent)}',
  '.news-pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem;margin-top:1.5rem;font-size:.9375rem;' +
    'color:var(--muted)}',
  '.news-pager a{display:inline-flex;align-items:center;min-height:2.75rem}',
  '.box{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;min-width:0}',
  '.box h2,.box h3{margin:0 0 .75rem;font-size:1.0625rem}',
  '.box .agenda li:first-child{border-top:0;padding-top:0}',
  '.box-stack{display:grid;gap:1.5rem}',

  // Side navigation uses a left border only to mark the active section state (`aria-current`), never as idle decoration.
  '.withnav{display:grid;grid-template-columns:13.75rem minmax(0,1fr);gap:3.5rem;align-items:start;padding-top:.5rem}',
  '.sidenav{position:sticky;top:1.5rem;border-left:1px solid var(--border);display:flex;flex-direction:column;margin:0;padding:0;list-style:none}',
  '.sidenav a{display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-height:2.5rem;padding:.4375rem 1rem;margin-left:-1px;border-left:2px solid transparent;' +
    'color:var(--text);font-size:.9375rem}',
  '.sidenav a:hover{text-decoration:none;color:var(--accent)}',
  '.sidenav a[aria-current]{border-left-color:var(--accent);color:var(--accent);font-weight:600}',

  '.psec+.psec{margin-top:3rem;padding-top:2.5rem;border-top:1px solid var(--border)}',
  '.psec h2{margin:0 0 .75rem;font-size:clamp(1.3125rem,1.4vw + .85rem,1.5rem);letter-spacing:-.01em}',
  '.psec>p{margin:0;max-width:68ch;white-space:pre-line}',
  '.psec>p+p{margin-top:.75rem}',
  '.timeline{margin:1.5rem 0 0;padding:0;list-style:none}',
  '.timeline li{display:grid;grid-template-columns:4.5rem minmax(0,1fr);gap:1rem;padding:.75rem 0;border-top:1px solid var(--border)}',
  '.timeline-year{font-weight:700;font-variant-numeric:tabular-nums}',
  '.timeline p{margin:0;font-size:.9375rem;color:var(--muted)}',
  // Editorial vision callout on warm stone paper, avoiding the generic decorative left stripe (R-01, R-31).
  '.vision{margin:0;padding:1.25rem 1.5rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius);' +
    'font-size:clamp(1.125rem,1.2vw + .85rem,1.3125rem);line-height:1.45;font-weight:600;max-width:38em}',
  '.mission{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 2.5rem;margin:1.5rem 0 0;padding:0;list-style:none;counter-reset:m}',
  '.mission li{counter-increment:m;display:grid;grid-template-columns:1.75rem minmax(0,1fr);padding:.75rem 0;border-top:1px solid var(--border)}',
  '.mission li::before{content:counter(m) ".";color:var(--muted);font-weight:600}',
  '.people{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 2.5rem;margin:1rem 0 0;padding:0;list-style:none}',
  '.people li{padding:.75rem 0;border-top:1px solid var(--border)}',
  '.people b{display:block;font-weight:600}',
  '.people span{font-size:.9375rem;color:var(--muted)}',
  '.steps{counter-reset:s;margin:1rem 0 1.25rem;padding:0;list-style:none;max-width:68ch}',
  '.steps li{counter-increment:s;display:grid;grid-template-columns:1.75rem minmax(0,1fr);padding:.375rem 0}',
  '.steps li::before{content:counter(s) ".";font-weight:600}',
  '.rules{width:100%;max-width:36rem;border-collapse:collapse;font-size:.9375rem;margin:0 0 1.25rem}',
  '.rules th,.rules td{padding:.5rem .75rem .5rem 0;border-bottom:1px solid var(--border);text-align:left;font-weight:400;vertical-align:top}',
  '.rules thead th{font-size:.84375rem;font-weight:600;color:var(--muted);border-bottom-color:var(--border-strong)}',
  '.profile-actions{display:flex;flex-wrap:wrap;gap:.625rem;margin:0}',
  '.gallery-page{gap:1.5rem 1.25rem}',

  '@media (max-width:63.99rem){.newslist{grid-template-columns:minmax(0,1fr);gap:2.5rem}}',
  '@media (max-width:53.74rem){.withnav{grid-template-columns:minmax(0,1fr);gap:1.75rem}' +
    '.sidenav{position:static;flex-direction:row;flex-wrap:wrap;gap:.25rem;border-left:0;border-bottom:1px solid var(--border);padding-bottom:.5rem}' +
    '.sidenav a{min-height:2.75rem;margin-left:0;padding:.375rem .75rem;border-left:0;border-radius:var(--radius-sm)}' +
    '.sidenav a[aria-current]{background:var(--accent-soft)}' +
    '.mission,.people{grid-template-columns:minmax(0,1fr)}}',
].join('\n');
