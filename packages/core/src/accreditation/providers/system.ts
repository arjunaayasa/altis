// Stub: replaced by a later change in this milestone.
// The `system` metric provider: the installation itself (how reachable it is, its website). Its id and metrics are final; it answers no value until it is written.
import { metricsOfProvider } from '../metric-ids.js';
import type { AccredMetricProvider } from '../types.js';

export const systemProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'system',
  metrics: metricsOfProvider('system'),
  compute: async () => ({ done: true, values: new Map() }),
});
