import {
  evaluateJob,
  holdsExpiryJob,
  importSlimsUsageJob,
  localStorageDriver,
  noticesBuildJob,
  privacyAnonymizeJob,
  reportsExportJob,
  reportsHousekeepingJob,
  stocktakeCodesJob,
  stocktakeFinishJob,
  stocktakePrepareJob,
  type JobHandler,
  type ReportJobDeps,
} from '@altis/core';
import { catalogJobDeps } from './catalog.js';
import type { JobRuntimeDeps } from './runtime.js';

// The community job handlers (reports and accreditation), one list, joined into jobHandlers() (jobs/runtime.ts) by one
// `needsRuntimeAll` line: the report export and the reports' daily upkeep, the evaluation of a period and the SLiMS
// usage import. Each comes from its own core module, so no later change edits this file or runtime.ts.

/** The community job handlers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function komunitasJobHandlers(deps: () => ReportJobDeps): JobHandler<any>[] {
  return [
    reportsExportJob(deps),
    reportsHousekeepingJob(deps),
    evaluateJob(deps),
    importSlimsUsageJob(deps),
    // ---- Komunitas (holds) ----
    holdsExpiryJob(),
    // ---- Komunitas (notices) ----
    noticesBuildJob(),
    // ---- Komunitas K2 (privacy) ----
    privacyAnonymizeJob(() => ({ storage: localStorageDriver(deps().dataDir) })),
    // ---- Komunitas K4 (stocktake) ----
    stocktakePrepareJob(),
    stocktakeCodesJob(() => ({ dataDir: deps().dataDir })),
    stocktakeFinishJob(),
  ];
}

/**
 * What the community jobs get from the job runtime that runs them, read at every slice: the catalogue jobs' facts and
 * the running release (printed in the documents).
 *
 * @throws TypeError when no config is loaded (a slice never runs before the boot read config.json)
 */
export function komunitasJobDeps(rt: JobRuntimeDeps): ReportJobDeps {
  return { ...catalogJobDeps(rt), appVersion: rt.appVersion };
}
