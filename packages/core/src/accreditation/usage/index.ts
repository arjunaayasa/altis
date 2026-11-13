// Stub: replaced by a later change in this milestone.
// The monthly usage table: its grid, the manual cells, the member-type mapping and the resolution of a cell from its
// sources. The signatures and the resolved types are final; every body throws until the table is written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signatures are not read yet */
import type { DB } from '@altis/db';
import type { AccredGroup, UsageMetric } from '@altis/shared';
import type { UsageGridView, UsageGroupsPutBody, UsageGroupsView, UsagePutBody } from '@altis/shared/api/accreditation';
import type { Kysely } from 'kysely';
import type { TxCtx } from '../../context.js';
import type { AccredSettings } from '../../settings/accreditation.js';

/** One resolved cell: its value (null: no data), where it comes from, and the end of its span for a span metric. */
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

function notImplemented(): never {
  throw new Error('not implemented yet');
}

/** The grid of a period: its months, metrics, groups and cells. */
export async function getUsageGrid(db: Kysely<DB>, periodId: string, settings: AccredSettings): Promise<UsageGridView> {
  return notImplemented();
}

/** Writes manual cells of a period (the period lock first). */
export async function putUsageCells(tx: TxCtx, periodId: string, body: UsagePutBody, now: number): Promise<void> {
  return notImplemented();
}

/** The member-type mapping. */
export async function getUsageGroups(db: Kysely<DB>): Promise<UsageGroupsView> {
  return notImplemented();
}

/** Writes the member-type mapping. */
export async function putUsageGroups(tx: TxCtx, body: UsageGroupsPutBody, now: number): Promise<void> {
  return notImplemented();
}

/** The usage of `span`, resolved. */
export async function resolveUsage(db: Kysely<DB>, span: { from: string; to: string }, settings: AccredSettings): Promise<ResolvedUsage> {
  return notImplemented();
}
