// The `akun` module of @altis/opac-theme (S16), the OPAC member area (`/akun`): the account menu, the notices, the
// forms, the tables of loans and holds, the bookmarks, the member card (printable on its own), and the member links of
// the public pages. Mobile first, every colour from base.ts's tokens, targets at least 2.75 rem high, no url() and no
// @import.

/** The CSS of the member area. */
export const AKUN_CSS: string = [
  // The header's link to the member area and the record's member actions.
  '.akun-link{display:inline-flex;align-items:center;min-height:2.75rem;font-weight:600}',
  '.record-actions{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;margin:.75rem 0 0}',
  '.record-actions a{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 1rem;border:1px solid var(--accent);' +
    'border-radius:var(--radius);font-weight:600;text-decoration:none}',
  '.record-actions a:hover{text-decoration:underline}',
  '.attachment-members{color:var(--muted);font-size:.875rem}',

  // The frame: the heading, the account menu (wraps on a phone), the sign-out button.
  '.akun{display:block;min-width:0}',
  '.akun-narrow{max-width:28rem}',
  '.akun-nav{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:space-between;margin:0 0 1.5rem;' +
    'padding:0 0 .75rem;border-bottom:1px solid var(--border)}',
  '.akun-nav ul{display:flex;flex-wrap:wrap;gap:.25rem .5rem;margin:0;padding:0;list-style:none}',
  '.akun-nav a{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .75rem;border-radius:var(--radius);text-decoration:none}',
  '.akun-nav a[aria-current]{background:var(--accent);color:var(--accent-ink);font-weight:600}',
  '.akun-nav a:hover{text-decoration:underline}',
  '.akun-logout{margin:0}',

  // Buttons and fields.
  '.akun button{min-height:2.75rem;padding:0 1rem;border:1px solid var(--accent);border-radius:var(--radius);background:var(--accent);' +
    'color:var(--accent-ink);font:inherit;font-weight:600;cursor:pointer}',
  '.akun-table button,.akun-inline button,.akun-logout button{background:transparent;color:var(--accent)}',
  '.akun button:focus-visible,.akun input:focus-visible{outline:3px solid var(--focus);outline-offset:2px}',
  '.akun-form{max-width:28rem}',
  '.akun-field{display:flex;flex-direction:column;gap:.25rem}',
  '.akun-field label{font-weight:600}',
  '.akun-field input{min-height:2.75rem;padding:.5rem .75rem;border:1px solid var(--border);border-radius:var(--radius);' +
    'background:var(--surface);color:var(--text);font:inherit}',
  '.akun-hint{color:var(--muted);font-size:.875rem}',
  '.akun-inline{display:inline;margin:0 0 0 .5rem}',
  '.akun-no{font-variant-numeric:tabular-nums;letter-spacing:.02em}',

  // Notices.
  '.akun-flash{padding:.75rem 1rem;border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:var(--radius);' +
    'background:var(--surface)}',
  '.akun-flash-ok{border-left-color:var(--ok)}',
  '.akun-flash-warn{border-left-color:var(--warn)}',
  '.akun-flash-error{border-left-color:var(--danger)}',

  // The member's facts, the tables and lists, the pager.
  '.akun-greeting{font-size:1.125rem;font-weight:600}',
  '.akun-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.75rem;margin:0 0 1.5rem}',
  '.akun-facts div{padding:.75rem;border:1px solid var(--card-border);border-radius:var(--radius);background:var(--card-bg)}',
  '.akun-facts dt{color:var(--muted);font-size:.875rem}',
  '.akun-facts dd{margin:0;font-weight:600;overflow-wrap:anywhere}',
  '.akun-table{width:100%;border-collapse:collapse}',
  '.akun-table th,.akun-table td{padding:.5rem;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}',
  '.akun-table th{color:var(--muted);font-size:.875rem;font-weight:600}',
  '.akun-table form{margin:0}',
  '.akun-list{margin:0;padding:0;list-style:none}',
  '.akun-list li{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem;min-height:2.75rem;padding:.25rem 0;' +
    'border-bottom:1px solid var(--border)}',
  '.akun-bookmarks input[type=checkbox]{width:1.25rem;height:1.25rem}',
  // Below the shell's 48 rem a table of loans or holds (`.akun-stack`) becomes one card per row, so a phone shows the due
  // date and the button without a sideways scroll: the header row stays for screen readers only, the title heads the
  // card, each other cell carries its column's name (`data-label`), and the action's button spans the card.
  '@media (max-width:47.99rem){' +
    '.akun-stack thead{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);' +
    'white-space:nowrap;border:0}' +
    '.akun-stack,.akun-stack tbody,.akun-stack tr,.akun-stack td{display:block;width:100%}' +
    '.akun-stack tr{margin:0 0 .75rem;padding:.25rem .75rem;border:1px solid var(--card-border);border-radius:var(--radius);' +
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

  // The member card: ID-1 proportions, printed alone.
  '.akun-card{max-width:24rem;aspect-ratio:85.6/54;display:flex;flex-direction:column;justify-content:space-between;gap:.5rem;' +
    'padding:1rem;border:1px solid var(--border);border-top:6px solid var(--accent);border-radius:var(--radius);background:var(--surface)}',
  '.akun-card p{margin:0}',
  '.akun-card-library{font-weight:700}',
  '.akun-card-main{display:flex;gap:.75rem;align-items:flex-start}',
  '.akun-card-photo{width:4.5rem;height:6rem;object-fit:cover;border-radius:.25rem;background:var(--border)}',
  '.akun-card-name{font-size:1.125rem;font-weight:700;overflow-wrap:anywhere}',
  '.akun-barcode{display:block;width:100%;height:3rem}',
  '@media print{.site-header,.site-footer,.akun-nav,.akun-hint,.akun h1{display:none}main{padding:0}' +
    '.akun-card{border-color:#000;box-shadow:none}}',
].join('\n');
