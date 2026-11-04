// The catalog's `records` barrel (Phase 2 Task 16): bibliographic records. Only the names of the task's interface
// (M14; packages/core/test/barrels.test.ts); the template, identifier, link and relation helpers stay internal.
export { archiveRecord, createRecord, restoreRecord, updateRecord } from './service.js';
export type { RecordSaveOptions, RecordSaveResult } from './service.js';
export { mergeRecord } from './merge.js';
export { setCover } from './cover.js';
export { checkDuplicates } from './duplicates.js';
export { recordBodyFromDraft } from './draft.js';
export { loadRecordData } from './data.js';
export { listRecords } from './list.js';
export { recordDetail } from './detail.js';
