import type { JobHandler } from '../../jobs/types.js';
import type { CatalogJobDeps } from '../jobs-deps.js';
import { exportJob } from './export-job.js';
import { importJob } from './import-job.js';

/**
 * The import and export jobs (Task 31: `catalog.import`, `catalog.export`), joined into the server's handlers by
 * apps/server/src/jobs/catalog.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function exchangeJobs(deps: () => CatalogJobDeps): JobHandler<any>[] {
  return [importJob(deps), exportJob(deps)];
}
