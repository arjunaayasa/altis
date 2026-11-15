// The reports barrel (spec §4.15): the definition types, the registry, the personal-data rule, the runs, the export job
// and the housekeeping. Each area's names come through here only, so no later change edits packages/core/src/index.ts;
// names carry a `report` prefix where a generic one could meet another barrel's (packages/core/test/barrels.test.ts).
export type { DocumentCtx, DocumentReport, DocumentResume, DocumentStep, ReportColumn, ReportCtx, ReportDefinition, ReportRow, TableReport } from './types.js';
export { REPORTS, reportById } from './registry.js';
export { columnShapes, columnsOf, showsPersonalColumn } from './personal.js';
export {
  getReportRun,
  listReportRuns,
  openReportRunDownload,
  previewReport,
  reportBranchOf,
  reportCatalogEntry,
  startReportRun,
  visibleReports,
} from './runs/index.js';
export type { ReportRunViewer } from './runs/index.js';
export * from './export/index.js';
export {
  DATE_JOBS_POSTPONED,
  REPORTS_HOUSEKEEPING_CURSOR_MAX,
  REPORTS_HOUSEKEEPING_STEPS,
  reportsHousekeepingJob,
  reportsHousekeepingPayload,
} from './housekeeping/index.js';
export type { ReportsHousekeepingPayload, ReportsHousekeepingStep } from './housekeeping/index.js';
