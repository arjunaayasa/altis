// Stub: replaced by a later change in this milestone.
// `accreditation.import_slims_usage`: reads the monthly usage aggregates of a SLiMS database or dump across slices and
// replaces the imported rows of the usage table at its end. The payload and the handler's declaration are final; the
// run ends at once until the import is written.
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import type { JobHandler } from '../../jobs/types.js';
import type { ReportJobDeps } from '../../reports/export/job.js';

/** The import's payload: its run and, between slices, the phase, the phase's cursor and its state. */
export const importSlimsUsagePayload = z.strictObject({
  runId: ulidField,
  phase: z.string().min(1).max(32).optional(),
  cursor: z.string().max(32_000).nullable().optional(),
  state: z.unknown().optional(),
});

export type ImportSlimsUsagePayload = z.infer<typeof importSlimsUsagePayload>;

/**
 * `accreditation.import_slims_usage`: interactive (the wizard drives it), long and CPU-heavy, retried only by its own
 * process (its source may be a database that only this process reaches).
 */
export function importSlimsUsageJob(deps: () => ReportJobDeps): JobHandler<ImportSlimsUsagePayload> {
  void deps;
  return {
    type: 'accreditation.import_slims_usage',
    permission: 'accreditation.workspace.manage',
    retryable: 'origin-only',
    interactive: true,
    longRunning: true,
    cpuHeavy: true,
    payload: importSlimsUsagePayload,
    run: async () => ({ done: true }),
  };
}
