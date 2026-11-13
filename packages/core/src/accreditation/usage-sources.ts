import type { UsageSource } from './types.js';

// The live sources of the monthly usage metrics (visits, loans, …), append-only: a module that records usage appends
// its sources in a block of its own. This edition's first milestone has none: its usage comes from manual cells and the
// SLiMS import (`usage_stats`) only.

export const USAGE_SOURCES: readonly UsageSource[] = Object.freeze([
  // ---- Komunitas K1 (usage sources) ----
]);
