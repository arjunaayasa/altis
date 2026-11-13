// Stub: replaced by a later change in this milestone.
// The `registers` metric provider: the registers (activities, documents, staff, partnerships, budgets). Its id and metrics are final; it answers no value until it is written.
import { metricsOfProvider } from '../metric-ids.js';
import type { AccredMetricProvider } from '../types.js';

export const registersProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'registers',
  metrics: metricsOfProvider('registers'),
  compute: async () => ({ done: true, values: new Map() }),
});
