// Stylesheet for the OPAC member area (`/akun`) and record member actions.

export const AKUN_CSS: string = [
  '.record-actions{display:grid;gap:.5rem;margin:.75rem 0 0}',
  '.record-actions a{display:flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0 1rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font-weight:600;font-size:.9375rem;text-decoration:none;text-align:center}',
  '.record-actions a:hover{background:var(--layer);border-color:var(--text)}',
  '.record-actions a:first-child{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}',
  '.record-actions a:first-child:hover{background:var(--accent-hover);border-color:var(--accent-hover)}',
  '.attachment-members{color:var(--muted);font-size:.875rem}',

  '.akun{display:grid;grid-template-columns:13.75rem minmax(0,1fr);grid-template-areas:"nav title" "nav body";column-gap:3.5rem;' +
    'align-items:start;min-width:0;padding-top:.5rem}',
  '.akun>h1{grid-area:title;margin:0 0 1rem;font-size:clamp(1.4375rem,1.8vw + .85rem,1.75rem);letter-spacing:-.01em}',
  '.akun-body{grid-area:body;min-width:0}',
  '.akun-body h2{margin:2rem 0 .5rem;font-size:1.25rem}',
  '.akun-nav{grid-area:nav;position:sticky;top:1.5rem;border-left:1px solid var(--border);display:grid}',
  '.akun-nav ul{display:grid;margin:0;padding:0;list-style:none}',
  '.akun-nav a{display:flex;align-items:center;min-height:2.5rem;padding:.25rem 1rem;margin-left:-1px;border-left:2px solid transparent;' +
    'color:var(--text);font-size:.9375rem;text-decoration:none}',
  '.akun-nav a:hover{color:var(--accent)}',
  '.akun-nav a[aria-current]{border-left-color:var(--accent);color:var(--accent);font-weight:600}',
  '.akun-logout{margin:.5rem 1rem 0;padding-top:.5rem;border-top:1px solid var(--border)}',
  '.akun-narrow{display:block;max-width:25rem;margin:1.5rem auto 0;padding:1.75rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}',
  '.akun-narrow h1{font-size:1.5rem;margin:0 0 1rem}',

  '.akun button{min-height:2.75rem;padding:0 1rem;border:1px solid var(--accent);border-radius:var(--radius-sm);background:var(--accent);' +
    'color:var(--accent-ink);font:600 .9375rem var(--font);cursor:pointer}',
  '.akun button:hover{background:var(--accent-hover);border-color:var(--accent-hover)}',
  '.akun-table button,.akun-inline button,.akun-logout button{min-height:2.5rem;padding:0 .75rem;background:var(--surface);border-color:var(--border-strong);' +
    'color:var(--text);font-size:.875rem}',
  '.akun-table button:hover,.akun-inline button:hover,.akun-logout button:hover{background:var(--layer);border-color:var(--text)}',
  '.akun button:focus-visible,.akun input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}',
  '.akun-form{max-width:25rem}',
  '.akun-field{display:flex;flex-direction:column;gap:.25rem}',
  '.akun-field label{font-weight:600;font-size:.9375rem}',
  '.akun-field input{min-height:2.75rem;padding:.375rem .75rem;border:1px solid var(--border-strong);border-radius:var(--radius-sm);' +
    'background:var(--surface);color:var(--text);font:inherit}',
  '.akun-hint{color:var(--muted);font-size:.875rem}',
  '.akun-inline{display:inline;margin:0 0 0 .5rem}',
  '.akun-no{font-family:var(--mono);font-size:.92em;font-variant-numeric:tabular-nums}',

  // Flash notices mark real state (`ok`, `warn`, `error`) paired with status copy.
  '.akun-flash{padding:.75rem 1rem;border:1px solid var(--border);border-left-width:3px;border-radius:var(--radius-sm);background:var(--layer)}',
  '.akun-flash-ok{border-left-color:var(--ok)}',
  '.akun-flash-warn{border-left-color:var(--warn)}',
  '.akun-flash-error{border-left-color:var(--danger)}',

  '.akun-greeting{font-size:1.125rem;font-weight:600}',
  '.akun-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));margin:0 0 1.5rem;border-block:1px solid var(--border)}',
  '.akun-facts div{display:flex;flex-direction:column;padding:.875rem 1rem;min-width:0;border-left:1px solid var(--border);margin-left:-1px}',
  '.akun-facts dt{color:var(--muted);font-size:.875rem}',
  '.akun-facts dd{margin:0;font-weight:600;overflow-wrap:anywhere}',
  '.akun-table{width:100%;border-collapse:collapse;font-size:.9375rem}',
  '.akun-table th,.akun-table td{padding:.625rem .75rem .625rem 0;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}',
  '.akun-table th{padding-top:.5rem;padding-bottom:.5rem;color:var(--muted);font-size:.84375rem;font-weight:600;border-bottom-color:var(--border-strong)}',
  '.akun-table form{margin:0}',
  '.akun-list{margin:0;padding:0;list-style:none}',
  '.akun-list li{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem;min-height:2.75rem;padding:.375rem 0;' +
    'border-bottom:1px solid var(--border)}',
  '.akun-bookmarks input[type=checkbox]{width:1.125rem;height:1.125rem;accent-color:var(--accent)}',
  '@media (max-width:53.74rem){.akun{grid-template-columns:minmax(0,1fr);grid-template-areas:"title" "nav" "body"}' +
    '.akun-nav{position:static;border-left:0;border-bottom:1px solid var(--border);margin:0 0 1.5rem;padding:0 0 .75rem}' +
    '.akun-nav ul{display:flex;flex-wrap:wrap;gap:.25rem}' +
    '.akun-nav a{min-height:2.75rem;border-left:0;border-bottom:2px solid transparent;margin:0;padding:.25rem .625rem}' +
    '.akun-nav a[aria-current]{border-bottom-color:var(--accent)}' +
    '.akun-table button,.akun-inline button,.akun-logout button{min-height:2.75rem}' +
    '.akun-logout{margin:.5rem 0 0;padding:0;border:0}.akun-narrow{padding:1.25rem}}',
  '@media (max-width:47.99rem){' +
    '.akun-stack thead{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);' +
    'white-space:nowrap;border:0}' +
    '.akun-stack,.akun-stack tbody,.akun-stack tr,.akun-stack td{display:block;width:100%}' +
    '.akun-stack tr{margin:0 0 .75rem;padding:.375rem .875rem;border:1px solid var(--card-border);border-radius:var(--radius);' +
    'background:var(--card-bg)}' +
    '.akun-stack td{padding:.375rem 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}' +
    '.akun-stack td:last-child{border-bottom:0}' +
    '.akun-stack td[data-label]::before{content:attr(data-label);display:inline-block;min-width:7.5rem;margin:0 .5rem 0 0;' +
    'color:var(--muted);font-size:.875rem;font-weight:600}' +
    '.akun-stack .akun-stack-main{font-weight:600}' +
    '.akun-stack .akun-stack-action button{width:100%}' +
    '}',
  '.akun-pager{display:flex;flex-wrap:wrap;gap:.75rem 1rem;align-items:center;margin:1rem 0 0}',
  '.akun-pager a{display:inline-flex;align-items:center;min-height:2.75rem}',

  '.akun-card{max-width:24rem;aspect-ratio:85.6/54;display:flex;flex-direction:column;justify-content:space-between;gap:.5rem;' +
    'padding:1rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--surface)}',
  '.akun-card p{margin:0}',
  '.akun-card-library{font-weight:700}',
  '.akun-card-main{display:flex;gap:.75rem;align-items:flex-start}',
  '.akun-card-photo{width:4.5rem;height:6rem;object-fit:cover;border-radius:.25rem;background:var(--border)}',
  '.akun-card-name{font-size:1.125rem;font-weight:700;overflow-wrap:anywhere}',
  '.akun-barcode{display:block;width:100%;height:3rem}',
  '@media print{.topstrip,.site-header,.site-footer,.pagehead,.akun-nav,.akun-hint,.akun h1{display:none}.page{padding:0}.akun{display:block}' +
    '.akun-card{border-color:#000;box-shadow:none}}',
].join('\n');
