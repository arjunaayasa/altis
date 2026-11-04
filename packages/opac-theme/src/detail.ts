// The `detail` module of @altis/opac-theme (S16), the record detail (Phase 2 Task 34; spec §9.3, §9.8): the record's
// header (cover or type icon, title, agents), its sections and description list, subjects, relations, attachments,
// the citations, the shelf map's highlight, and the attachment viewer. The availability table, the status labels, the
// shelf map's frame and `.table-scroll` are the shell's shared components (shell.ts); this module adds only what is the
// detail's own. Mobile first (one column; the cover beside the title from 40 rem), every colour from base.ts's tokens,
// targets at least 2.75 rem high, no url() and no @import.

/** The CSS of the record detail. */
export const DETAIL_CSS: string = [
  // The page's two articles: the record and the attachment viewer.
  '.record,.viewer{display:block;min-width:0}',

  // The record's header: the cover (or the material type's icon) and the heading.
  '.record-header{display:grid;gap:1rem;align-items:start;margin:0 0 1.5rem}',
  '.record-cover{display:block;width:8rem;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:var(--radius);background:var(--border)}',
  '.record-icon{display:flex;align-items:center;justify-content:center;color:var(--muted);background:var(--surface);' +
    'border:1px solid var(--card-border)}',
  '.record-icon svg{width:60%;height:auto;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
  '.record-heading{min-width:0}',
  '.record-heading h1{margin:0 0 .5rem;line-height:1.25;overflow-wrap:anywhere}',
  '.record-subtitle{font-weight:400}',
  '.record-type{margin:0 0 .25rem;color:var(--muted);font-size:.875rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}',
  '.record-responsibility{margin:0 0 .5rem;color:var(--muted)}',
  '.record-agents{display:flex;flex-wrap:wrap;gap:0 1rem;margin:0;padding:0;list-style:none}',
  '.record-agents li{display:inline-flex;align-items:center;flex-wrap:wrap;min-height:2.75rem}',
  '.record-agents a{font-weight:600}',
  '.record-role,.record-dates{color:var(--muted);font-weight:400}',

  // The sections and the description list (one column; label beside value from 40 rem).
  '.record-section{margin:2rem 0 0}',
  '.record-section h2{margin:0 0 .75rem;font-size:1.25rem}',
  '.record-text{max-width:var(--measure);white-space:pre-line;overflow-wrap:anywhere}',
  '.record-fields{display:grid;gap:.25rem 1.5rem;margin:0}',
  '.record-fields dt{color:var(--muted);font-weight:600}',
  '.record-fields dd{margin:0 0 .5rem;overflow-wrap:anywhere}',
  '.record-subjects{display:flex;flex-wrap:wrap;gap:.5rem;margin:0;padding:0;list-style:none}',
  '.record-subjects a{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 .875rem;background:var(--facet-bg);' +
    'border:1px solid var(--card-border);border-radius:999px;color:var(--text);text-decoration:none}',
  '.record-subjects a:hover{text-decoration:underline}',
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
  '.citations summary h2{display:inline;margin:0}',
  '.citation-list{display:grid;gap:.25rem;margin:1rem 0}',
  '.citation-list dt{color:var(--muted);font-weight:600}',
  '.citation{margin:0 0 .75rem;padding:.75rem;background:var(--surface);border:1px solid var(--card-border);border-radius:var(--radius);' +
    'overflow-wrap:anywhere}',
  '.downloads{margin:1rem 0 .25rem}',

  // The attachment viewer.
  '.viewer-back{margin:0 0 1rem}',
  '.viewer h1{margin:0 0 .25rem;overflow-wrap:anywhere}',
  '.viewer-kind{margin:0 0 1rem;color:var(--muted)}',
  '.viewer-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:1rem 0}',
  '.button{display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0 1.25rem;border:1px solid var(--accent);' +
    'border-radius:var(--radius);color:var(--accent);font-weight:700;text-decoration:none}',
  '.button-primary{background:var(--accent);color:var(--accent-ink)}',
  '.viewer-hint{color:var(--muted);font-size:.875rem}',
  '.viewer-media{display:block;width:100%;max-width:48rem;margin:1rem 0}',
  '.viewer-image{margin:1rem 0}',
  '.viewer-image img{display:block;max-width:100%;height:auto;border-radius:var(--radius)}',
  '.viewer-image figcaption{margin-top:.5rem}',
  '.leaving{max-width:var(--measure);margin:1rem 0;padding:1rem;background:var(--surface);border:1px solid var(--card-border);' +
    'border-left:4px solid var(--warn);border-radius:var(--radius)}',
  '.leaving h2{margin:0 0 .5rem;font-size:1.125rem}',
  '.viewer-url{color:var(--muted);font-size:.875rem;overflow-wrap:anywhere}',

  // Wider screens: the cover beside the heading, the description in two columns.
  '@media (min-width:40rem){.record-header{grid-template-columns:auto 1fr;gap:1.5rem}.record-cover{width:10rem}' +
    '.record-fields{grid-template-columns:minmax(9rem,max-content) 1fr}.record-fields dd{margin:0}}',
].join('\n');
