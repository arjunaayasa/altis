import type { PrerequisitesView } from '@altis/shared/api/accreditation';
import type { AccredMetricId } from '../metric-ids.js';
import type { AccredMetricValue } from '../types.js';

// The registration prerequisites of an accreditation: at least 1 000 titles in the collection at the snapshot date,
// the library's number (NPP) on its profile, and its founding decree in the Documents register. All three are needed;
// while one fails the estimate is shown as a practice estimate, without a predicate.

/** The fewest titles a library may register with. */
export const PREREQUISITE_MIN_TITLES = 1000;

/** The metrics of the three prerequisites: the titles, the library number and the founding decree. */
export const PREREQUISITE_METRICS: readonly AccredMetricId[] = Object.freeze([
  'collection.titles',
  'period.npp_present',
  'registers.founding_decree_registered',
] satisfies AccredMetricId[]);

/** The registration prerequisites at `D`. */
export function evaluatePrerequisites(v: {
  titles: AccredMetricValue;
  npp: AccredMetricValue;
  foundingDecree: AccredMetricValue;
  D: string;
}): PrerequisitesView {
  const count = v.titles.value ?? 0;
  const titles = { pass: v.titles.value !== null && count >= PREREQUISITE_MIN_TITLES, count, asOf: v.D };
  const npp = { pass: v.npp.value !== null && v.npp.value >= 1 };
  const foundingDecree = { pass: v.foundingDecree.value !== null && v.foundingDecree.value >= 1 };
  return { titles, npp, foundingDecree, met: titles.pass && npp.pass && foundingDecree.pass };
}
