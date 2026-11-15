import type { AccredMetricProvider } from '../types.js';
import { collectionProvider } from './collection.js';
import { periodProvider } from './period.js';
import { registersProvider } from './registers.js';
import { stocktakeProvider } from './stocktake.js';
import { systemProvider } from './system.js';
import { usageProvider } from './usage.js';

// The metric providers (spec §10.4), in the order the evaluation runs them; append-only: each milestone appends the
// providers of its modules in a block of its own.

export const ACCRED_METRIC_PROVIDERS: readonly AccredMetricProvider[] = Object.freeze([
  // ---- Komunitas K1 (providers) ----
  collectionProvider,
  registersProvider,
  periodProvider,
  systemProvider,
  usageProvider,
  // ---- Komunitas K4 (stocktake) ----
  stocktakeProvider,
]);
