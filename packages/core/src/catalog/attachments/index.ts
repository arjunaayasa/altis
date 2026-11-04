// The catalog's `attachments` barrel (Phase 2 Task 18): the attachments of records, who `/files/:id` serves a catalog
// file to, and the orphan-upload step of `catalog.housekeeping`. Only the names of the task's interface (M14;
// packages/core/test/barrels.test.ts).
export { archiveAttachment, createAttachment, incrementReadCount, listAttachments, updateAttachment } from './service.js';
export { catalogFileAccess } from './access.js';
export type { CatalogFileAccess } from './access.js';
export { orphanUploadsStep } from './housekeeping.js';
