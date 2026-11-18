// The `detail` module of @altis/opac-theme (S16), the record detail (Phase 2 Task 34; spec §9.3, §9.8): the record's
// header (cover or substitute cover, title, agents), its sections and description list, subjects, relations, attachments,
// the citations, the shelf map's highlight, and the attachment viewer. The availability table, the status labels, the
// shelf map's frame and `.table-scroll` are the shell's shared components (shell.ts); this module adds only what is the
// detail's own. Mobile first (one column; the cover beside the title from 40 rem), every colour from base.ts's tokens,
// targets at least 2.75 rem high, no url() and no @import.

/** The CSS of the record detail. */
export const DETAIL_CSS: string = [
  // The page's two articles: the record and the attachment viewer.
  '.record,.viewer{display:block;min-width:0}',

  // The record: the cover in a narrow column, the record itself, and a box beside it with the call number, what the
  // copies allow now and the member's actions.
  '.record{display:grid;grid-template-columns:minmax(0,1fr);gap:1.5rem;align-items:start}',
  '.record-cover-col{width:9rem}',
  '.record-main{min-width:0}',
  '.record-header{display:block;margin:0 0 1rem}',
  '.record-cover{display:block;width:100%;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:2px;background:var(--layer-2)}',
  '.record-heading{display:grid;gap:.25rem;min-width:0}',
  '.record-heading h1{margin:0;font-size:1.75rem;line-height:1.2;letter-spacing:-.01em;overflow-wrap:anywhere}',
  '.record-subtitle{font-weight:400}',
  '.record-type{margin:0;color:var(--muted);font-size:.9375rem}',
  '.record-shelf{margin:.75rem 0 .5rem;font-size:.875rem}',
  '.record-responsibility{margin:0;color:var(--muted)}',
  '.record-agents{display:flex;flex-wrap:wrap;gap:0 1rem;margin:0;padding:0;list-style:none}',
  '.record-agents li{display:inline-flex;align-items:center;flex-wrap:wrap;min-height:2rem}',
  '.record-agents a{font-weight:600}',
  '.record-role,.record-dates{color:var(--muted);font-weight:400}',
  '.record-side{display:grid;gap:0}',
  '.shelf-mark{margin:0}',
  '.shelf-mark small{display:block;font-size:.84375rem;color:var(--muted)}',
  '.shelf-mark b{font:600 1.1875rem var(--mono);overflow-wrap:anywhere}',

  // The sections and the description list (one column; label beside value from 40 rem).
  '.record-section{margin:2rem 0 0}',
  '.record-section h2{margin:0 0 .5rem;font-size:1.25rem}',
  '.record-text{max-width:var(--measure);white-space:pre-line;overflow-wrap:anywhere}',
  '.record-fields{display:grid;margin:0;font-size:.9375rem;border-bottom:1px solid var(--border)}',
  '.record-fields dt{color:var(--muted)}',
  '.record-fields dt{padding:.5rem 0 0;border-top:1px solid var(--border)}',
  '.record-fields dd{margin:0;padding:0 0 .5rem;overflow-wrap:anywhere}',
  '.record-subjects{display:flex;flex-wrap:wrap;gap:.5rem;margin:0;padding:0;list-style:none}',
  '.record-subjects a{display:inline-flex;align-items:center;min-height:2rem;padding:0 .625rem;background:var(--bg);' +
    'border:1px solid var(--border-strong);border-radius:var(--radius-sm);color:var(--text);font-size:.9375rem;text-decoration:none}',
  '.record-subjects a:hover{border-color:var(--accent);color:var(--accent)}',
  '.record-relations,.attachment-list,.download-list{display:grid;gap:.25rem;margin:0;padding:0;list-style:none}',
  '.record-relations li,.attachment-list li,.download-list li{display:flex;flex-wrap:wrap;align-items:center;gap:0 .5rem;min-height:2.75rem}',
  '.relation-type,.attachment-kind,.attachment-note{color:var(--muted);font-size:.875rem}',
  '.attachment-title{overflow-wrap:anywhere}',

  // The availability: its summary line, the shelf hint under the place, the shelf map's summary and highlight.
  '.availability-summary,.availability-more{margin:0 0 .75rem;color:var(--muted)}',
  '.shelf-hint{display:block;color:var(--muted);font-size:.875rem}',
  '.shelf-map summary{display:flex;align-items:center;min-height:2.75rem;cursor:pointer;font-weight:600}',
  '.shelf-map .shelf-here{fill-opacity:.45;stroke:var(--map-highlight);stroke-width:6}',

  // The citations.
  '.citations summary{display:flex;align-items:center;min-height:2.75rem;cursor:pointer}',
  // A summary drawn as a flex row has no marker of its own: a chevron (one 2 px line) says it opens, and turns when open.
  '.citations summary,.shelf-map summary{list-style:none}',
  '.citations summary::-webkit-details-marker,.shelf-map summary::-webkit-details-marker{display:none}',
  '.citations summary::after,.shelf-map summary::after{content:"";flex:none;width:.5rem;height:.5rem;margin:0 .25rem 0 .875rem;' +
    'border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-.1875rem) rotate(45deg)}',
  '.citations[open] summary::after,.shelf-map[open] summary::after{transform:translateY(.125rem) rotate(225deg)}',
  '.citations summary h2{display:inline;margin:0}',
  '.citation-list{display:grid;gap:.25rem;margin:1rem 0}',
  '.citation-list dt{color:var(--muted);font-weight:600}',
  '.citation{margin:0 0 .75rem;padding:.75rem;background:var(--layer);border:1px solid var(--border);border-radius:var(--radius);' +
    'overflow-wrap:anywhere}',
  '.downloads{margin:1rem 0 .25rem}',

  // The attachment viewer.
  '.viewer-back{margin:0 0 1rem}',
  '.viewer h1{margin:0 0 .25rem;overflow-wrap:anywhere}',
  '.viewer-kind{margin:0 0 1rem;color:var(--muted)}',
  '.viewer-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:1rem 0}',
  '.button{display:inline-flex;align-items:center;justify-content:center;min-height:2.5rem;padding:0 1rem;border:1px solid var(--border-strong);' +
    'border-radius:var(--radius-sm);color:var(--text);font-weight:600;font-size:.9375rem;text-decoration:none}',
  '.button-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}',
  '.viewer-hint{color:var(--muted);font-size:.875rem}',
  '.viewer-media{display:block;width:100%;max-width:48rem;margin:1rem 0}',
  '.viewer-image{margin:1rem 0}',
  '.viewer-image img{display:block;max-width:100%;height:auto;border-radius:var(--radius)}',
  '.viewer-image figcaption{margin-top:.5rem}',
  '.leaving{max-width:var(--measure);margin:1rem 0;padding:1rem;background:var(--layer);border:1px solid var(--warn);border-radius:var(--radius)}',
  '.leaving h2{margin:0 0 .5rem;font-size:1.125rem}',
  '.viewer-url{color:var(--muted);font-size:.875rem;overflow-wrap:anywhere}',

  // Wider screens: the cover beside the record, the description's label beside its value; wide: the box as a third column.
  '@media (min-width:44rem){.record{grid-template-columns:10rem minmax(0,1fr);gap:2rem}.record-cover-col{width:auto}' +
    '.record-side{grid-column:1/-1}' +
    '.record-fields{grid-template-columns:8.75rem minmax(0,1fr)}.record-fields dt,.record-fields dd{padding:.5rem 0;border-top:1px solid var(--border)}}',
  '@media (min-width:68.75rem){.record{grid-template-columns:12.5rem minmax(0,1fr) 17.5rem;gap:2.5rem}.record-side{grid-column:auto}}',
].join('\n');
