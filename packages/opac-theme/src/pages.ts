// The `pages` module of @altis/opac-theme (S16), Halaman & Berita: page and news bodies and the news list (spec §9.5).
// Owned by Task 20, which writes its CSS here and in no other module. index.ts joins the modules in a fixed order; the
// tokens (colours, spacing, radius) come from base.ts as custom properties, so both colour schemes and every accent
// apply. Mobile first, nothing fetched (no @import, font or url()), targets at least 2.75 rem high.
//
// - `.page-article` is a page or a news post; `.page-body` holds its sanitized body (the allowlist of §9.5: headings
//   h2-h4, lists, quotes, tables, code, figures, images from /files), styled here so that no body needs a style of
//   its own. Wide tables and code scroll inside the body, never the page.
// - `.page-note` is the note above Indonesian content on an English page; `.page-meta` a date line; `.page-lead` a
//   news post's summary; `.page-cover` its cover.
// - `.news-index` is the list of `/berita`, `.news-pager` its newer/older links, `.news-feed` the RSS link.

/** The CSS of Halaman & Berita. */
export const PAGES_CSS: string = [
  // One page or news post: a column of 720 px in the middle of the page.
  '.article{max-width:45rem;margin:0 auto}',
  '.page-article{display:block;min-width:0}',
  '.page-article h1{margin:.25rem 0 .75rem;font-size:2rem;line-height:1.2;letter-spacing:-.01em}',
  '.page-note{padding:.75rem 1rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius);font-size:.9375rem}',
  '.page-back{margin:2rem 0 0;padding-top:1rem;border-top:1px solid var(--border);text-align:right;font-weight:600;font-size:.9375rem}',
  '.page-meta{margin:0 0 .25rem;color:var(--muted);font-size:.84375rem}',
  '.page-lead{font-size:1.125rem}',
  '.page-cover{display:block;width:100%;max-width:100%;height:auto;margin:1.5rem 0;border-radius:var(--radius)}',
  // The event a post announces: when and where, in a box with the accent's line on its left.
  '.eventbox{border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius-sm);padding:1rem 1.25rem;margin:0 0 1.5rem}',

  // The body: what the sanitizer lets through, readable on a phone.
  '.page-body{overflow-wrap:anywhere}',
  '.page-body h2,.page-body h3,.page-body h4{margin:1.75rem 0 .5rem;line-height:1.3}',
  '.page-body h3{font-size:1.125rem}',
  '.page-body h4{font-size:1rem}',
  '.page-body ul,.page-body ol{margin:0 0 1rem;padding-left:1.5rem}',
  '.page-body li{margin:.25rem 0}',
  '.page-body blockquote{margin:0 0 1rem;padding:.25rem 0 .25rem 1rem;border-left:4px solid var(--border);color:var(--muted)}',
  '.page-body img{max-width:100%;height:auto}',
  '.page-body figure{margin:0 0 1rem}',
  '.page-body figcaption{color:var(--muted);font-size:.875rem}',
  '.page-body hr{margin:2rem 0;border:0;border-top:1px solid var(--border)}',
  '.page-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9375em}',
  '.page-body pre{max-width:100%;overflow-x:auto;margin:0 0 1rem;padding:.75rem;background:var(--layer);' +
    'border:1px solid var(--border);border-radius:var(--radius)}',
  '.page-body table{display:block;max-width:100%;overflow-x:auto;margin:0 0 1rem;border-collapse:collapse}',
  '.page-body th,.page-body td{padding:.5rem;border:1px solid var(--border);text-align:left;vertical-align:top}',
  '.page-body th{background:var(--layer)}',


  // The news list: text tabs for the kinds of news, the rows (home.ts draws them), beside them boxes for the agenda and
  // the opening hours.
  '.newslist{display:grid;grid-template-columns:minmax(0,1fr) 20rem;gap:3.5rem;align-items:start}',
  '.newslist-1{grid-template-columns:minmax(0,1fr)}',
  '.newslist h2{margin:0 0 .25rem;font-size:1.125rem}',
  '.newslist h2 a{color:var(--text)}',
  '.newslist h2 a::after{content:"";position:absolute;inset:0}',
  '.newslist .newsrow:hover h2 a{color:var(--accent);text-decoration:underline}',
  '.texttabs{display:flex;flex-wrap:wrap;gap:0 1.5rem;border-bottom:1px solid var(--border);margin:0 0 1.5rem}',
  '.texttabs a{padding:.5rem 0;color:var(--text);font-size:.9375rem;border-bottom:2px solid transparent;margin-bottom:-1px}',
  '.texttabs a:hover{text-decoration:none;color:var(--accent)}',
  '.texttabs a[aria-current]{border-bottom-color:var(--accent);color:var(--accent);font-weight:600}',
  '.texttabs .news-feed{margin-left:auto;color:var(--accent)}',
  '.news-pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem;margin-top:1.5rem;font-size:.9375rem;' +
    'color:var(--muted)}',
  '.box{border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;min-width:0}',
  '.box h2,.box h3{margin:0 0 .75rem;font-size:1.0625rem}',
  '.box .agenda li:first-child{border-top:0;padding-top:0}',
  '.box-stack{display:grid;gap:1.5rem}',

  // A page with a navigation of its own beside the content (the profile, the member area): a list with a line on its
  // left, the current entry marked by the accent.
  '.withnav{display:grid;grid-template-columns:13.75rem minmax(0,1fr);gap:3.5rem;align-items:start;padding-top:.5rem}',
  '.sidenav{position:sticky;top:1.5rem;border-left:1px solid var(--border);display:flex;flex-direction:column;margin:0;padding:0;list-style:none}',
  '.sidenav a{display:flex;justify-content:space-between;gap:.5rem;padding:.4375rem 1rem;margin-left:-1px;border-left:2px solid transparent;' +
    'color:var(--text);font-size:.9375rem}',
  '.sidenav a:hover{text-decoration:none;color:var(--accent)}',
  '.sidenav a[aria-current]{border-left-color:var(--accent);color:var(--accent);font-weight:600}',

  // The profile's sections.
  '.psec+.psec{margin-top:3rem;padding-top:2.5rem;border-top:1px solid var(--border)}',
  '.psec h2{margin:0 0 .75rem;font-size:1.5rem}',
  '.psec>p{margin:0;max-width:68ch;white-space:pre-line}',
  '.psec>p+p{margin-top:.75rem}',
  '.timeline{margin:1.5rem 0 0;padding:0;list-style:none}',
  '.timeline li{display:grid;grid-template-columns:4.5rem minmax(0,1fr);gap:1rem;padding:.75rem 0;border-top:1px solid var(--border)}',
  '.timeline-year{font-weight:700;font-variant-numeric:tabular-nums}',
  '.timeline p{margin:0;font-size:.9375rem;color:var(--muted)}',
  '.vision{margin:0;border-left:3px solid var(--accent);padding:.25rem 0 .25rem 1.25rem;font-size:1.25rem;line-height:1.4;font-weight:600;max-width:36em}',
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
  '.profile-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:0}',
  '.gallery-page{gap:1.5rem 1rem}',

  '@media (max-width:53.74rem){.newslist,.withnav{grid-template-columns:minmax(0,1fr);gap:2rem}.sidenav{position:static}' +
    '.mission,.people{grid-template-columns:minmax(0,1fr)}.page-article h1{font-size:1.625rem}.psec h2{font-size:1.375rem}}',
].join('\n');
