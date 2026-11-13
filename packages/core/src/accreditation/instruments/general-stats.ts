import type { AccredMetricId } from '../metric-ids.js';
import type { AccredInstrument } from '../types.js';
import { GENERAL_STATS_HEADER } from './headers.js';
import { deepFreeze } from './shared.js';

// The statistics mode, for every library whose instrument ALTIS does not have yet (and a school that wants another
// span): no indicators, no score, no gap list and no standards; it measures the statistics the profile, the register
// lists and the statistical annexes print, and the registration prerequisites, shown for information.

export const GENERAL_STATS: AccredInstrument = deepFreeze<AccredInstrument>({ ...GENERAL_STATS_HEADER, components: [], snp: [] });

/**
 * The metrics the statistics mode evaluates: the stock, its kinds and classes, the additions over three calendar years
 * (their table, never banded), the copies without an acquisition date, the monthly usage and its averages, the active
 * members, the staff and the profile counts and budget, the school population (a school only fills it), and the
 * prerequisites (the stock, the library number and the founding decree).
 */
export const GENERAL_STATS_METRICS: readonly AccredMetricId[] = deepFreeze<AccredMetricId[]>([
  'collection.titles',
  'collection.profile_matrix',
  'collection.ddc_printed_recap',
  'collection.title_additions_3y_pct',
  'collection.undated_items',
  'usage.monthly_series',
  'usage.profile_averages',
  'usage.members_active',
  'registers.active_staff',
  'registers.profile_staff',
  'registers.profile_counts',
  'registers.profile_budget',
  'period.population',
  'period.npp_present',
  'registers.founding_decree_registered',
]);
