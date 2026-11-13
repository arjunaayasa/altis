// Stub: replaced by a later change in this milestone.
// The `collection` metric provider: the collection's stock, additions, fiction, processing and annex tables. Its id and metrics are final; it answers no value until it is written.
import { metricsOfProvider } from '../metric-ids.js';
import type { AccredMetricProvider } from '../types.js';

export const collectionProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'collection',
  metrics: metricsOfProvider('collection'),
  compute: async () => ({ done: true, values: new Map() }),
});
