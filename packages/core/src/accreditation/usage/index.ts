// The monthly usage table (spec §10.7): its grid, the manual cells, the member-type mapping and the resolution of a
// cell from its sources (resolve.ts). The usage metrics and the two usage annexes read it through `resolveUsage`.
import type { DB } from '@altis/db';
import type { AccredGroup, UsageMetric } from '@altis/shared';
import type { Kysely } from 'kysely';
import type { AccredSettings } from '../../settings/accreditation.js';
import { loadUsageTable } from './resolve.js';

export { putUsageCells } from './cells.js';
export { getUsageGrid } from './grid.js';
export { getUsageGroups, putUsageGroups } from './groups.js';

/**
 * One resolved cell: its value (null: no data), where it comes from, and the end of its span: the period's end for a
 * span metric, the last day of a month cell that stops before the month ends (a cut-over month), else null.
 */
export interface ResolvedCell {
  value: number | null;
  source: 'manual' | 'slims' | 'none';
  spanTo: string | null;
}

/** The usage of a span, resolved cell by cell (a manual cell wins over a live source, a live source over SLiMS). */
export interface ResolvedUsage {
  /** The months of the span, `YYYY-MM`. */
  months: readonly string[];
  cell(metric: UsageMetric, month: string, group: AccredGroup | 'guest' | 'unmapped' | 'total'): ResolvedCell;
  spanValue(metric: UsageMetric, span: { from: string; to: string }, group?: AccredGroup | 'total'): ResolvedCell;
  /** The months of the span with at least one cell of `metric`. */
  monthsWithData(metric: UsageMetric): number;
  /** The rows counted through the mapping of members a source no longer has. */
  memberUnknown(metric: UsageMetric): number;
}

/**
 * The usage of `span` (its months, and the span rows inside it), resolved with the member-type mapping as it is now;
 * the visits of a SLiMS row are its visits without repeats while `settings.dedupeLegacy` is on.
 */
export async function resolveUsage(db: Kysely<DB>, span: { from: string; to: string }, settings: AccredSettings): Promise<ResolvedUsage> {
  return loadUsageTable(db, span, settings);
}
