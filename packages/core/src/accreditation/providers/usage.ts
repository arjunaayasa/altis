// Stub: replaced by a later change in this milestone.
// The `usage` metric provider: the monthly usage table. Its id and metrics are final; it answers no value until it is written.
import { metricsOfProvider } from '../metric-ids.js';
import type { AccredMetricProvider } from '../types.js';

export const usageProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'usage',
  metrics: metricsOfProvider('usage'),
  compute: async () => ({ done: true, values: new Map() }),
});
