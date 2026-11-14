import type { DB } from '@altis/db';
import { ACCRED_GROUPS, USAGE_METRICS, type AccredGroup, type UsageMetric } from '@altis/shared';
import type { UsageGridView } from '@altis/shared/api/accreditation';
import type { Kysely } from 'kysely';
import type { AccredSettings } from '../../settings/accreditation.js';
import { periodNotFound } from '../periods/errors.js';
import { lastUsageImport } from '../periods/last-change.js';
import { loadUsageTable, type UsageGroup } from './resolve.js';

// The grid of a period's monthly usage (spec §10.7, the workspace's "Penggunaan Bulanan"): a cell per month, metric and
// group with its value and its source, and a cell per group for the metrics of the whole period. The grid shows every
// metric as stored (the raw visits of the import beside its visits without repeats); the groups are the keys a manual
// cell is written with, plus `unmapped` while some imported rows count in no group (the member-type mapping decides).

/** The metrics stored per month. */
export const MONTHLY_METRICS: readonly UsageMetric[] = Object.freeze([
  'visits',
  'visits_deduped',
  'visits_online',
  'loans',
  'in_library_uses',
  'distinct_visitors',
  'distinct_borrowers',
]);

/** The metrics stored for the whole period (distinct counts of a period are no sum of months). */
export const SPAN_METRICS: readonly UsageMetric[] = Object.freeze(['titles_used', 'items_used', 'distinct_visitors', 'distinct_borrowers', 'members_active']);

/** A group of the grid: its key, what it resolves, and the population group it is. */
interface GridGroup {
  key: string;
  bucket: UsageGroup | 'total';
  accredGroup: AccredGroup | 'guest' | null;
}

const GRID_GROUPS: readonly GridGroup[] = Object.freeze([
  { key: '', bucket: 'total', accredGroup: null },
  ...ACCRED_GROUPS.map((g): GridGroup => ({ key: `grp:${g}`, bucket: g, accredGroup: g })),
  { key: 'guest', bucket: 'guest', accredGroup: 'guest' },
]);

const UNMAPPED: GridGroup = Object.freeze({ key: 'unmapped', bucket: 'unmapped', accredGroup: null });

/**
 * The grid of the live period `periodId`: its months (`YYYY-MM`), every usage metric, its groups, a cell per month,
 * monthly metric and group and per span metric and group (`month: null`, `spanTo` the period's end), and the last
 * SLiMS usage import.
 *
 * @throws DomainError `NOT_FOUND` for an unknown or archived period
 */
export async function getUsageGrid(db: Kysely<DB>, periodId: string, settings: AccredSettings): Promise<UsageGridView> {
  const p = await db.selectFrom('accred_periods').select(['starts_on', 'ends_on']).where('id', '=', periodId).where('archived_at', 'is', null).executeTakeFirst();
  if (p === undefined) throw periodNotFound();
  const span = { from: p.starts_on, to: p.ends_on };
  const table = await loadUsageTable(db, span, settings, { dedupe: false });
  const groups = table.hasUnmapped ? [...GRID_GROUPS, UNMAPPED] : GRID_GROUPS;
  const cells: UsageGridView['cells'] = [];
  for (const metric of USAGE_METRICS) {
    if (MONTHLY_METRICS.includes(metric)) {
      for (const month of table.months) {
        for (const g of groups) cells.push({ metric, month, groupKey: g.key, ...table.cell(metric, month, g.bucket) });
      }
    }
    if (SPAN_METRICS.includes(metric)) {
      for (const g of groups) cells.push({ metric, month: null, groupKey: g.key, ...table.spanCell(metric, span, g.bucket) });
    }
  }
  return {
    months: [...table.months],
    metrics: [...USAGE_METRICS],
    groups: groups.map((g) => ({ key: g.key, label: null, accredGroup: g.accredGroup })),
    cells,
    lastImport: await lastUsageImport(db),
  };
}
