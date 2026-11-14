import { ACTIVITY_KINDS } from '@altis/shared';
import type { Expression, SqlBool } from 'kysely';
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField, reportParam } from '../../reports/params.js';
import type { ReportCtx, ReportRow, TableReport } from '../../reports/types.js';
import { EXTERNAL_LITERACY_KIND, LEARNING_KIND, annexPeriod, keyCursor, parseKeyCursor, periodDates, vocabLabel } from '../providers/registers-metrics.js';
import { resolveWindow } from '../windows.js';

// The activities annex of an accreditation period: the live activities held in the period, or in the three periods
// (`window`), by date, then id. The filters add up: the kinds chosen (`kinds`), the activities that count for the
// learning item (`learning`: learning sessions and any activity held with the library's facilities) and those that
// count for the outside-literacy item (`externalLiteracy`: outside-literacy activities and any activity with an outside
// speaker); with none of them, every activity is listed.

/** The span an activity list covers: the period, or the three periods ending with it. */
export const ANNEX_WINDOWS = Object.freeze(['period', 'three_periods'] as const);

async function activityAnnexRows(ctx: ReportCtx, cursor: string | null, limit: number): Promise<{ rows: ReportRow[]; nextCursor: string | null }> {
  const after = parseKeyCursor(cursor);
  const { period, D } = await annexPeriod(ctx);
  const w = resolveWindow(ctx.params['window'] === 'three_periods' ? 'three_periods' : 'period', periodDates(period), D);
  const kinds = Array.isArray(ctx.params['kinds']) ? (ctx.params['kinds'] as string[]) : [];
  const learning = ctx.params['learning'] === true;
  const externalLiteracy = ctx.params['externalLiteracy'] === true;

  let q = ctx.db
    .selectFrom('library_activities')
    .select(['id', 'kind', 'title', 'held_on', 'participants', 'partner'])
    .where('archived_at', 'is', null)
    .where('held_on', '>=', w.from)
    .where('held_on', '<=', w.to);
  if (kinds.length > 0 || learning || externalLiteracy) {
    q = q.where((eb) => {
      const any: Expression<SqlBool>[] = [];
      if (kinds.length > 0) any.push(eb('kind', 'in', kinds));
      if (learning) any.push(eb.or([eb('kind', '=', LEARNING_KIND), eb('uses_library_facility', '=', 1)]));
      if (externalLiteracy) any.push(eb.or([eb('kind', '=', EXTERNAL_LITERACY_KIND), eb('external_speaker', '=', 1)]));
      return eb.or(any);
    });
  }
  if (after !== null) q = q.where((eb) => eb.or([eb('held_on', '>', after[0]), eb.and([eb('held_on', '=', after[0]), eb('id', '>', after[1])])]));
  const found = await q
    .orderBy('held_on')
    .orderBy('id')
    .limit(limit + 1)
    .execute();
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => [vocabLabel(ctx.locale, 'activity_kind', r.kind), r.title, r.held_on, r.participants === null ? null : Number(r.participants), r.partner]),
    nextCursor: found.length > limit && last !== undefined ? keyCursor(last.held_on, last.id) : null,
  };
}

/** The activities of the period (or the three periods), filtered by kind. */
export const annexActivitiesReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.activities',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.activities.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [
    PERIOD_PARAM,
    reportParam('kinds', 'status', { multiple: true, options: ACTIVITY_KINDS, optionLabelPrefix: 'vocab.activity_kind.' }),
    reportParam('window', 'status', { options: ANNEX_WINDOWS }),
    reportParam('learning', 'bool'),
    reportParam('externalLiteracy', 'bool'),
  ],
  paramsSchema: z.strictObject({
    periodId: reportIdField,
    kinds: z.array(z.enum(ACTIVITY_KINDS)).min(1).max(ACTIVITY_KINDS.length).optional(),
    window: z.enum(ANNEX_WINDOWS).default('period'),
    learning: z.boolean().optional(),
    externalLiteracy: z.boolean().optional(),
  }),
  columns: [
    ...['kind', 'title'].map((key) => reportColumn(key, 'text')),
    reportColumn('held_on', 'date'),
    reportColumn('participants', 'int'),
    reportColumn('partner', 'text'),
  ],
  rows: activityAnnexRows,
});
