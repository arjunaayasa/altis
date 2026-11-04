// The catalog's `runs` barrel (Phase 2 Task 19): the run views, a run's report and export file, the duplicate scan and
// the expired-exports housekeeping step. Only the names of the task's interface (M14; packages/core/test/barrels.test.ts);
// `catalogRunJobs` is exported by catalog/index.ts (Task 3), the scan's helpers stay internal.
export { exportFileExtOf, getRunView, listRuns, runExportFile, runReportFile } from './queries.js';
export type { RunViewer } from './queries.js';
export { DEDUPE_SCAN_JOB, DEDUPE_SCAN_UNIQUE_KEY, dedupeScanJob, dedupeScanPayload, startDedupeScan } from './dedupe-scan.js';
export type { DedupeScanPayload } from './dedupe-scan.js';
export { expiredExportsStep } from './housekeeping.js';
