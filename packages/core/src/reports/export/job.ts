// Stub: replaced by a later change in this milestone.
// `reports.export`: writes a run's file across slices (rows, then the file, then the run's end). The payload, the
// dependencies and the handler's declaration are final; the run ends at once until the writer is filled in.
import { REPORT_EXPORT_CURSOR_MAX } from '@altis/shared/api/reports';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import type { CatalogJobDeps } from '../../catalog/jobs-deps.js';
import type { JobHandler } from '../../jobs/types.js';

/** What the report jobs are built with: the catalogue jobs' facts and the running release (printed in the PDFs). */
export type ReportJobDeps = CatalogJobDeps & { appVersion: string };

/** The export job's payload: its run and, between slices, the phase, the report's cursor and the phase's state. */
export const ReportsExportPayload = z.strictObject({
  runId: ulidField,
  phase: z.enum(['rows', 'write', 'finish']).optional(),
  cursor: z.string().max(REPORT_EXPORT_CURSOR_MAX).nullable().optional(),
  state: z.unknown().optional(),
});

export type ReportsExportPayload = z.infer<typeof ReportsExportPayload>;

/** `reports.export`: interactive (its creator's page drives it), retryable from the API. */
export function reportsExportJob(deps: () => ReportJobDeps): JobHandler<ReportsExportPayload> {
  void deps;
  return {
    type: 'reports.export',
    permission: 'system.jobs.manage',
    retryable: 'api',
    interactive: true,
    payload: ReportsExportPayload,
    run: async () => ({ done: true }),
  };
}
