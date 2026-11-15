import { countRows } from '@altis/db';
import { HOLD_STATUSES } from '@altis/shared';
import { z } from 'zod';
import { decodeCursor, encodeCursor, rangeParam, textParam, vocabLabel } from '../collection/common.js';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { memberMatchSql, numberIdKeyset, titleMatchSql } from './common.js';

// The holds (personal data): the title, the member (number and name; none once the hold's history was anonymised),
// when it was placed, its status, its place in the queue while it waits (its title's queue at its pickup branch, in
// the order holds are served: placed first, then by id) and the pickup deadline once its copy is kept. Filtered by
// status, pickup branch, words of the title, member, and the days it was placed. Newest first, keyset paged.

function filtered(ctx: ReportCtx) {
  let q = ctx.db.selectFrom('holds as h').leftJoin('members as m', 'm.id', 'h.member_id').leftJoin('records as r', 'r.id', 'h.record_id');
  const statuses = ctx.params['holdStatus'];
  if (Array.isArray(statuses) && statuses.length > 0) q = q.where('h.status', 'in', statuses as string[]);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('h.pickup_branch_id', '=', branchId);
  const title = textParam(ctx, 'titleWords');
  const titleSql = title === null ? null : titleMatchSql(title);
  if (titleSql !== null) q = q.where(titleSql);
  const member = textParam(ctx, 'member');
  if (member !== null) q = q.where(memberMatchSql(member));
  const placed = rangeParam(ctx, 'placed');
  if (placed.from !== null) q = q.where('h.placed_on', '>=', placed.from);
  if (placed.to !== null) q = q.where('h.placed_on', '<=', placed.to);
  return q;
}

/** The holds (see the top of this file). */
export const circulationHoldsReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.holds',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.holds.title',
  permission: 'circulation.records.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('holdStatus', 'status', { options: HOLD_STATUSES, optionLabelPrefix: 'vocab.hold_status.', multiple: true }),
    reportParam('branchId', 'branch'),
    reportParam('titleWords', 'text'),
    reportParam('member', 'text'),
    reportParam('placed', 'dateRange'),
  ],
  paramsSchema: z.strictObject({
    holdStatus: z.array(z.enum(HOLD_STATUSES)).max(HOLD_STATUSES.length).optional(),
    branchId: reportIdField.optional(),
    titleWords: z.string().trim().min(1).max(200).optional(),
    member: z.string().trim().min(1).max(191).optional(),
    placed: reportDateRangeField.optional(),
  }),
  columns: [
    reportColumn('title', 'text', { widthChars: 32 }),
    reportColumn('member_no', 'text', { widthChars: 14 }),
    reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 24 }),
    reportColumn('placed_on', 'date'),
    reportColumn('hold_status', 'text', { widthChars: 12 }),
    reportColumn('queue_position', 'int'),
    reportColumn('pickup_until', 'date'),
  ],
  async rows(ctx, cursor, limit) {
    let q = filtered(ctx).select([
      'h.id',
      'h.record_id',
      'h.pickup_branch_id',
      'h.placed_at',
      'h.placed_on',
      'h.status',
      'h.pickup_until',
      'm.member_no_display',
      'm.name',
      'r.title',
    ]);
    if (cursor !== null) {
      const [at, id] = decodeCursor(cursor, numberIdKeyset);
      q = q.where((eb) => eb.or([eb('h.placed_at', '<', at), eb.and([eb('h.placed_at', '=', at), eb('h.id', '<', id)])]));
    }
    const found = await q.orderBy('h.placed_at', 'desc').orderBy('h.id', 'desc').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const rows: ReportRow[] = [];
    for (const h of page) {
      let position: number | null = null;
      if (h.status === 'waiting') {
        const at = Number(h.placed_at);
        position =
          1 +
          (await countRows(
            ctx.db
              .selectFrom('holds')
              .where('record_id', '=', h.record_id)
              .where('pickup_branch_id', '=', h.pickup_branch_id)
              .where('status', '=', 'waiting')
              .where((eb) => eb.or([eb('placed_at', '<', at), eb.and([eb('placed_at', '=', at), eb('id', '<', h.id)])])),
          ));
      }
      rows.push([h.title, h.member_no_display, h.name, h.placed_on, vocabLabel(ctx, 'hold_status', h.status), position, h.pickup_until]);
    }
    const last = page[page.length - 1];
    return { rows, nextCursor: found.length > limit && last !== undefined ? encodeCursor([Number(last.placed_at), last.id]) : null };
  },
  async count(ctx) {
    return countRows(filtered(ctx));
  },
});
