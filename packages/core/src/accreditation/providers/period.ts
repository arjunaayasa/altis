// Stub: replaced by a later change in this milestone.
// The `period` metric provider: the period's own inputs (population, facilities, services, the profile). Its id and metrics are final; it answers no value until it is written.
import { metricsOfProvider } from '../metric-ids.js';
import type { AccredMetricProvider } from '../types.js';

export const periodProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'period',
  metrics: metricsOfProvider('period'),
  compute: async () => ({ done: true, values: new Map() }),
});
