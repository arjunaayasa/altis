import { metricsOfProvider } from '../metric-ids.js';
import type { AccredMetricProvider } from '../types.js';
import { computeRegisterMetrics } from './registers-metrics.js';

// The `registers` metric provider: the activities, documents, staff and their trainings, partnerships and budgets of
// the library (the definitions are in registers-metrics.ts). Every read is bounded by the size of its register, so a
// call answers every metric it is asked for at once.

export const registersProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'registers',
  metrics: metricsOfProvider('registers'),
  compute: async (ctx, ids) => ({ done: true, values: await computeRegisterMetrics(ctx, ids) }),
});
