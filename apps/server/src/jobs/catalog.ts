import {
  catalogHousekeepingJob,
  catalogRunJobs,
  exchangeJobs,
  localStorageDriver,
  searchJobs,
  slimsJobs,
  type CatalogJobDeps,
  type CoreLogger,
  type JobHandler,
} from '@altis/core';
import type { JobRuntimeDeps } from './runtime.js';

// The catalog's job handlers (Phase 2 Task 3), one list, joined into jobHandlers() (jobs/runtime.ts) by one
// `needsRuntime` line: each area's list comes from its own core module (search: Task 15; runs: Task 19; exchange: Task
// 31; the SLiMS migration: Task 23), so no later task edits this file or runtime.ts.

const silent: CoreLogger = { info() {}, warn() {}, error() {} };

/** The catalog job handlers: the daily housekeeping, the reindex, the run jobs, import and export, the migration. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function catalogJobHandlers(deps: () => CatalogJobDeps): JobHandler<any>[] {
  return [catalogHousekeepingJob(deps), ...searchJobs(deps), ...catalogRunJobs(deps), ...exchangeJobs(deps), ...slimsJobs(deps)];
}

/**
 * What the catalog jobs get from the job runtime that runs them, read at every slice: DATA_DIR, config.json's baseUrl
 * and keyring of the moment, the local storage driver (the only one in Phase 2), the runtime's logger.
 *
 * @throws TypeError when no config is loaded (a slice never runs before the boot read config.json)
 */
export function catalogJobDeps(rt: JobRuntimeDeps): CatalogJobDeps {
  const config = rt.config();
  if (config === undefined) throw new TypeError('catalog jobs: no config is loaded');
  return { dataDir: rt.dataDir, baseUrl: config.baseUrl, keyring: config.keyring, storage: localStorageDriver(rt.dataDir), log: rt.log ?? silent };
}
