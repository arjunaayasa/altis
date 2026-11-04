import type { CatalogJobDeps } from '../../catalog/jobs-deps.js';
import type { JobHandler } from '../../jobs/types.js';
import { migrateSlimsJob } from './job.js';

/**
 * The SLiMS migration job (Task 23: `catalog.migrate_slims`), joined into the server's handlers by
 * apps/server/src/jobs/catalog.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function slimsJobs(deps: () => CatalogJobDeps): JobHandler<any>[] {
  return [migrateSlimsJob(deps)];
}
