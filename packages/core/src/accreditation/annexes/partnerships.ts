import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { ReportCtx, ReportRow, TableReport } from '../../reports/types.js';
import { annexPeriod, keyCursor, parseKeyCursor, periodDates, vocabLabel } from '../providers/registers-metrics.js';
import { resolveWindow } from '../windows.js';

// The partnerships annex of an accreditation period: the live written agreements valid at some time in the period
// (begun by its end, up to the snapshot date, and not ended before it began), by their start, then id.

async function partnershipAnnexRows(ctx: ReportCtx, cursor: string | null, limit: number): Promise<{ rows: ReportRow[]; nextCursor: string | null }> {
  const after = parseKeyCursor(cursor);
  const { period, D } = await annexPeriod(ctx);
  const w = resolveWindow('period', periodDates(period), D);
  let q = ctx.db
    .selectFrom('library_partnerships')
    .select(['id', 'partner', 'kind', 'starts_on', 'ends_on', 'scope'])
    .where('archived_at', 'is', null)
    .where('starts_on', '<=', w.to)
    .where((eb) => eb.or([eb('ends_on', 'is', null), eb('ends_on', '>=', w.from)]));
  if (after !== null) q = q.where((eb) => eb.or([eb('starts_on', '>', after[0]), eb.and([eb('starts_on', '=', after[0]), eb('id', '>', after[1])])]));
  const found = await q
    .orderBy('starts_on')
    .orderBy('id')
    .limit(limit + 1)
    .execute();
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => [r.partner, vocabLabel(ctx.locale, 'partnership_kind', r.kind), r.starts_on, r.ends_on, r.scope]),
    nextCursor: found.length > limit && last !== undefined ? keyCursor(last.starts_on, last.id) : null,
  };
}

/** The written partnerships valid in the period. */
export const annexPartnershipsReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.partnerships',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.partnerships.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    ...['partner', 'kind'].map((key) => reportColumn(key, 'text')),
    ...['starts_on', 'ends_on'].map((key) => reportColumn(key, 'date')),
    reportColumn('scope', 'text'),
  ],
  rows: partnershipAnnexRows,
});
