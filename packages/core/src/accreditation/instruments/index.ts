import type { AccredMetricId } from '../metric-ids.js';
import { PREREQUISITE_METRICS } from '../scoring/prerequisites.js';
import type { AccredInstrument } from '../types.js';
import { GENERAL_STATS, GENERAL_STATS_METRICS } from './general-stats.js';
import { SCH_SD_2025 } from './sch-sd-2025.js';
import { SCH_SMA_2025 } from './sch-sma-2025.js';
import { SCH_SMP_2025 } from './sch-smp-2025.js';
import { TEST_INSTRUMENTS } from './test-instrument.js';

// The instruments of this build, in the order the workspace lists them: the three school instruments of 2025 and the
// statistics mode. The test build profile adds `test-sch` after them; a production build has none.

/** Every instrument of this build. */
export const ACCRED_INSTRUMENTS: readonly AccredInstrument[] = Object.freeze([
  // ---- Komunitas K1 (instruments) ----
  SCH_SD_2025,
  SCH_SMP_2025,
  SCH_SMA_2025,
  GENERAL_STATS,
  // The test build profile only; the condition stays inline, so a production build drops the spread.
  ...(typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' ? TEST_INSTRUMENTS : []),
]);

const BY_ID: ReadonlyMap<string, AccredInstrument> = new Map(ACCRED_INSTRUMENTS.map((i) => [i.id, i]));

/** The instrument `id`, or null. */
export function instrumentById(id: string): AccredInstrument | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Every metric an evaluation of `instr` computes, once each: for a scored instrument the metrics of its indicators and
 * the size metrics of the sized ones, the metrics of its standards with their size metrics and the period's class
 * count for the class-based ones, then the prerequisites; for the statistics mode its own list.
 */
export function instrumentMetricIds(instr: AccredInstrument): AccredMetricId[] {
  if (!instr.scored) return [...GENERAL_STATS_METRICS];
  const ids = new Set<AccredMetricId>();
  for (const c of instr.components) {
    for (const i of c.indicators) {
      if (i.metric !== undefined) ids.add(i.metric);
      if (i.band.kind === 'sized_range') ids.add(i.band.sizeMetric);
    }
  }
  for (const s of instr.snp) {
    if (s.metric !== null) ids.add(s.metric);
    if (s.rule.kind === 'min_by_size') ids.add(s.rule.sizeMetric);
    if (s.rule.kind === 'min_by_classes' || s.rule.kind === 'staff_by_classes') ids.add('period.classes');
  }
  for (const id of PREREQUISITE_METRICS) ids.add(id);
  return [...ids];
}
