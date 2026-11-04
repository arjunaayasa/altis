// The catalog's `csv` barrel (Phase 2 Task 11): the CSV reader of the imports (encoding and separator detection,
// byte-offset resume, bounded rows) and the row codecs of the ALTIS `csv-records`/`csv-items` formats and the SLiMS
// (and CDS/ISIS) layouts. Only the names of the task's interface (M14; packages/core/test/barrels.test.ts); the cell
// helpers of multi.ts stay internal.

export { CSV_ROW_MAX_BYTES, createCsvReader } from './reader.js';
export type { CsvEncoding, CsvInfo, CsvReader, CsvReaderState, CsvRow, CsvSeparator } from './reader.js';
export { joinMulti, splitMulti } from './multi.js';
export type { CsvFieldError } from './multi.js';
export { CSV_RECORD_COLUMNS, csvRecordHeader, csvRecordHeaderErrors, csvRecordRow, recordCsvCells } from './records.js';
export type { CsvRecordRead } from './records.js';
export { CSV_ITEM_COLUMNS, csvItemHeader, csvItemHeaderErrors, csvItemRow, itemCsvCells } from './items.js';
export type { ItemCsvRow } from './items.js';
export { SLIMS_ITEM_COLUMNS, SLIMS_RECORD_COLUMNS, isSlimsCsvHeader, slimsCsvItem, slimsCsvRecord } from './slims.js';
export type { SlimsCsvRecordRead, SlimsItemCsvRow } from './slims.js';
