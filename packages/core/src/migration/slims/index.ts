// The SLiMS catalogue migration (spec §11; Phase 2). Task 3 created the seams: the source and stage shapes, the source
// stubs (source/index.ts, Task 10's), the stage stubs (stages/*.ts, Tasks 37 and 38) and the job list (jobs.ts, Task
// 23's). The source constructors and the stages stay inside core (the framework reaches them through its factory);
// this barrel exports the shapes and the job list. Task 23 adds its own names here.

export { SlimsFileTooLargeError } from './source/types.js';
export type { SlimsDbConfig, SlimsFilesSource, SlimsRow, SlimsSource, SlimsTableInfo, SlimsVersionInfo, SplitCheckpoint } from './source/types.js';
export type {
  SlimsCounters,
  SlimsFixKind,
  SlimsReportRow,
  SlimsRunOptions,
  SlimsStage,
  SlimsStageContext,
  SlimsStageName,
} from './stage.js';
export { slimsJobs } from './jobs.js';

// ---- Task 23: the migration framework ----
// The source factory seam (B1; the two setters work in the test build profile only, R57), the job and how a migration
// starts (the route and the CLI), the counters, the reconciliation and the target guard (prefixed here, M14).
export { __setSlimsSourceFactory, __setSlimsStages, slimsSources } from './factory.js';
export type { SlimsSourceFactory } from './factory.js';
export {
  SLIMS_MIGRATION_UNIQUE_KEY,
  SLIMS_STAGES,
  checkSlimsAdoption,
  liveSlimsMigration,
  migrateSlimsJob,
  releaseEndedRunWork,
  startSlimsMigration,
} from './job.js';
export type { SlimsStartInput } from './job.js';
export { SLIMS_MIGRATION_JOB, migrateSlimsPayload, placeSlimsWork } from './pipeline.js';
export type { MigrateSlimsPayload } from './pipeline.js';
export { parseSlimsRunSettings } from './options.js';
export type { SlimsDbTarget, SlimsRunSettings } from './options.js';
export { createCounters as createSlimsCounters } from './counters.js';
export { reconcile as reconcileSlimsMigration } from './reconcile.js';
export { assertTargetEmpty as assertSlimsTargetEmpty } from './guard.js';
