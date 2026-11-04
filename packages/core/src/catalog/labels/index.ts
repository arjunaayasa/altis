// The catalog's `labels` barrel (Phase 2): created empty by Task 3, filled by the task that owns the area. It exports
// only the names its task's Interfaces list, generic ones with a prefix (M14; packages/core/test/barrels.test.ts).
// Task 36: the data of a label print (`POST catalog/labels` builds the PDF with print/buildLabelPdf).
export { labelDataFor } from './data.js';
