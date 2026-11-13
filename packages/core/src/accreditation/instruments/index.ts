import type { AccredInstrument } from '../types.js';
import { GENERAL_STATS_HEADER, SCH_SD_2025_HEADER, SCH_SMA_2025_HEADER, SCH_SMP_2025_HEADER, type AccredInstrumentHeader } from './headers.js';
import { TEST_INSTRUMENTS } from './test-instrument.js';

// The instruments of this build, in the order the workspace lists them. The school instruments carry no indicators or
// standards yet (their data arrives with a later change of this milestone; the headers are final). The test build
// profile adds `test-sch` after them; a production build has none.

const withoutIndicators = (header: AccredInstrumentHeader): AccredInstrument => Object.freeze({ ...header, components: Object.freeze([]), snp: Object.freeze([]) });

/** Every instrument of this build. */
export const ACCRED_INSTRUMENTS: readonly AccredInstrument[] = Object.freeze([
  // ---- Komunitas K1 (instruments) ----
  withoutIndicators(SCH_SD_2025_HEADER),
  withoutIndicators(SCH_SMP_2025_HEADER),
  withoutIndicators(SCH_SMA_2025_HEADER),
  withoutIndicators(GENERAL_STATS_HEADER),
  // The test build profile only; the condition stays inline, so a production build drops the spread.
  ...(typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' ? TEST_INSTRUMENTS : []),
]);

const BY_ID: ReadonlyMap<string, AccredInstrument> = new Map(ACCRED_INSTRUMENTS.map((i) => [i.id, i]));

/** The instrument `id`, or null. */
export function instrumentById(id: string): AccredInstrument | null {
  return BY_ID.get(id) ?? null;
}
