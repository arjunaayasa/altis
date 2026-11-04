// The catalog domain of Phase 2 ("Katalog & Jelajah"). Created by Task 3 (plan decision P2-02): one barrel per area,
// each filled by the task that owns the area, so that no later task edits this file or src/index.ts. A barrel exports
// only the names its task's Interfaces list, generic ones with their module's prefix (M14), since src/index.ts joins
// the barrels with `export *` and packages/core/test/barrels.test.ts refuses a name exported twice.
//
// `data/` (Task 1) and `lib/` (Task 5) have barrels of their own, joined by src/index.ts directly, not here.

export * from './masters/index.js';
export * from './authorities/index.js';
export * from './locations/index.js';
export * from './records/index.js';
export * from './items/index.js';
export * from './attachments/index.js';
export * from './runs/index.js';
export * from './csv/index.js';
export * from './render/index.js';
export * from './exchange/index.js';
export * from './copy/index.js';
export * from './labels/index.js';

// Task 3: the daily housekeeping job and its steps' context, the deps every catalog job is built with, and the job
// lists of the runs (Task 19) and exchange (Task 31) areas, which apps/server/src/jobs/catalog.ts joins.
export { CATALOG_HOUSEKEEPING_CURSOR_MAX, CATALOG_HOUSEKEEPING_STEPS, catalogHousekeepingJob, catalogHousekeepingPayload } from './housekeeping.js';
export type { CatalogHousekeepingPayload, CatalogHousekeepingStep, HousekeepingStepContext } from './housekeeping.js';
export type { CatalogJobDeps } from './jobs-deps.js';
export { catalogRunJobs } from './runs/jobs.js';
export { exchangeJobs } from './exchange/jobs.js';
