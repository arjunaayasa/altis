// The catalog's `render` barrel (Phase 2 Task 22): the bibliographic renderers over a stored record's RecordData
// (spec §9.3, §9.4, §10; D2-21, D2-22). Pure. Only the names of the task's interface are exported (M14); the shared
// helpers of names.ts and the DC mapping of dublin-core.ts stay internal.
export { formatCitation } from './citation.js';
export type { CitationPart, CitationStyle } from './citation.js';
export { toRis } from './ris.js';
export { toBibtex } from './bibtex.js';
export { recordJsonLd } from './json-ld.js';
export { dublinCoreMeta } from './dublin-core.js';
export { openGraph } from './open-graph.js';
export { toOaiDc } from './oai-dc.js';
export type { RecordRenderOptions } from './names.js';
