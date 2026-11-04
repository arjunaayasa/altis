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
  '.page-note{margin:0 0 1.5rem;padding:.75rem 1rem;background:var(--surface);border:1px solid var(--border);' +
    'border-left:4px solid var(--accent);border-radius:var(--radius)}',
  '.page-back a,.news-feed a,.news-pager a{display:inline-flex;align-items:center;min-height:2.75rem}',
  '.page-meta{margin:0 0 1rem;color:var(--muted);font-size:.875rem}',
  '.page-lead{font-size:1.125rem}',
  '.page-cover{display:block;max-width:100%;height:auto;margin:0 0 1.5rem;border-radius:var(--radius)}',

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
  '.page-body pre{max-width:100%;overflow-x:auto;margin:0 0 1rem;padding:.75rem;background:var(--surface);' +
    'border:1px solid var(--border);border-radius:var(--radius)}',
  '.page-body table{display:block;max-width:100%;overflow-x:auto;margin:0 0 1rem;border-collapse:collapse}',
  '.page-body th,.page-body td{padding:.5rem;border:1px solid var(--border);text-align:left;vertical-align:top}',
  '.page-body th{background:var(--surface)}',

  // The news list.
  '.news-feed{margin:0 0 1rem}',
  '.news-index{display:grid;gap:1rem;margin:0;padding:0;list-style:none}',
  '.news-index article{padding:1rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}',
  '.news-index h2{margin:0 0 .25rem;font-size:1.125rem;line-height:1.4}',
  '.news-index .page-meta{margin-bottom:.5rem}',
  '.news-index p:last-child{margin-bottom:0}',
  '.news-pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem;margin-top:2rem}',
].join('\n');
