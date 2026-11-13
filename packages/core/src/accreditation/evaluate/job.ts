// Stub: replaced by a later change in this milestone.
// `accreditation.evaluate`: computes a period's metrics provider by provider across slices and stores each indicator's,
// standard's and the prerequisites' results. The payload and the handler's declaration are final; the run ends at once
// until the evaluation is written.
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import type { JobHandler } from '../../jobs/types.js';
import type { ReportJobDeps } from '../../reports/export/job.js';
import type { AccredMetricProvider } from '../types.js';

/** The evaluation's payload: its period and, between slices, its start, the provider it is at and where it stopped. */
export const evaluatePayload = z.strictObject({
  periodId: ulidField,
  startedAt: z.number().int().min(0).optional(),
  providerIndex: z.int().min(0).max(63).optional(),
  resume: z.strictObject({ cursor: z.string().max(32_000), state: z.unknown() }).nullable().optional(),
});

export type EvaluatePayload = z.infer<typeof evaluatePayload>;

/**
 * `accreditation.evaluate`: interactive (the workspace drives it), one live job per period.
 *
 * @param o.providers the metric providers, in order (default the registry's; tests pass their own)
 */
export function evaluateJob(deps: () => ReportJobDeps, o: { providers?: readonly AccredMetricProvider[] } = {}): JobHandler<EvaluatePayload> {
  void deps;
  void o;
  return {
    type: 'accreditation.evaluate',
    permission: 'accreditation.workspace.read',
    retryable: 'api',
    interactive: true,
    payload: evaluatePayload,
    run: async () => ({ done: true }),
  };
}
