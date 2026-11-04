// The pure catalog library (Phase 2 Task 5): identifiers, the title key, barcodes, slugs, class numbers, title
// similarity and names. No database, no I/O. Only the names of the task's interface are exported (M14); helpers such
// as foldForKey stay internal.

export { identifierQuery, isValidIsbn13Barcode, normalizeDoi, parseIsbn, parseIssn, splitIdentifierText } from './identifiers.js';
export { titleKey } from './title-key.js';
export { barcodeProblem, normalizeBarcode } from './barcode.js';
export { recordSlug, recordUrlPath } from './slug.js';
export { classInRange, classNumberKey } from './class-number.js';
export { diceCoefficient } from './similarity.js';
export { uninvertName } from './names.js';
