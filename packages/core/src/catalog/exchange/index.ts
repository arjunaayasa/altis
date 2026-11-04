// The catalog's `exchange` barrel (Phase 2 Task 31): import and export jobs, how they start, the format detection and
// the MARC of one record. Only the names of the task's interface, prefixed (M14; packages/core/test/barrels.test.ts);
// `exchangeJobs` is exported by catalog/index.ts (Task 3). The readers, batches and writers stay internal.
export { detectImportFormat } from './detect.js';
export { CATALOG_IMPORT_JOB, importFormatBeforeStart, importJob, importJobPayload, placeImportWork, startCatalogImport } from './import-job.js';
export type { ImportJobPayload } from './import-job.js';
export { CATALOG_EXPORT_JOB, exportJob, exportJobPayload, startCatalogExport } from './export-job.js';
export type { ExportJobPayload } from './export-job.js';
export { recordMarcFile } from './marc-download.js';
export type { RecordMarcFile } from './marc-download.js';
