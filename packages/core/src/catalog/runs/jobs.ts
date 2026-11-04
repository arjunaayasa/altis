import type { JobHandler } from '../../jobs/types.js';
import type { CatalogJobDeps } from '../jobs-deps.js';
import { dedupeScanJob } from './dedupe-scan.js';

/**
 * The jobs of catalog runs (Task 19: `catalog.dedupe_scan`), joined into the server's handlers by
 * apps/server/src/jobs/catalog.ts and into the housekeeping steps' registry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function catalogRunJobs(deps: () => CatalogJobDeps): JobHandler<any>[] {
  return [dedupeScanJob(deps)];
}
