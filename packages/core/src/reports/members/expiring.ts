import { countRows } from '@altis/db';
import { addDays, diffDays } from '@altis/shared';
import { z } from 'zod';
import { decodeCursor, encodeCursor, textParam } from '../collection/common.js';
import { reportColumn, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { boolParam, intParam, typeName } from '../circulation/common.js';

// The members whose membership has ended or ends within N days of today (30 by default), for a reminder or a mass
// extension: live members (neither archived nor anonymised) with a valid-until date up to today + N, the days left
// (negative once it has passed) and their contact. Filtered by member type and class, and, with `activeOnly`, to the
// active members whose membership has not ended yet (valid until today or later: the ones Beranda counts as ending
// soon). By that date, then name.

function filtered(ctx: ReportCtx) {
  const until = addDays(ctx.today, intParam(ctx, 'days', 30));
  let q = ctx.db
    .selectFrom('members as m')
    .where('m.archived_at', 'is', null)
    .where('m.anonymized_at', 'is', null)
    .where('m.expires_on', 'is not', null)
    .where('m.expires_on', '<=', until);
  const memberTypeId = textParam(ctx, 'memberTypeId');
  if (memberTypeId !== null) q = q.where('m.member_type_id', '=', memberTypeId);
  const className = textParam(ctx, 'className');
  if (className !== null) q = q.where('m.class_name', '=', className);
  if (boolParam(ctx, 'activeOnly')) q = q.where('m.status', '=', 'active').where('m.expires_on', '>=', ctx.today);
  return q;
}

const keyset = z.tuple([z.string().max(10), z.string().max(400), z.string().min(1).max(26)]);

/** The members expiring (see the top of this file). */
export const membersExpiringReport: TableReport = Object.freeze<TableReport>({
  id: 'members.expiring',
  module: 'members',
  kind: 'table',
  titleKey: 'report.members.expiring.title',
  permission: 'members.records.read',
  exportPermission: 'members.export.run',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('days', 'int', { min: 0, max: 366 }),
    reportParam('memberTypeId', 'memberType'),
    reportParam('className', 'className'),
    reportParam('activeOnly', 'bool'),
  ],
  paramsSchema: z.strictObject({
    days: z.int().min(0).max(366).optional(),
    memberTypeId: reportIdField.optional(),
    className: z.string().trim().min(1).max(64).optional(),
    activeOnly: z.boolean().optional(),
  }),
  columns: [
    reportColumn('member_no', 'text', { widthChars: 16 }),
    reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 28 }),
    reportColumn('member_type', 'text', { widthChars: 16 }),
    reportColumn('class', 'text', { source: { table: 'members', column: 'class_name' }, widthChars: 10 }),
    reportColumn('expires_on', 'date'),
    reportColumn('days_left', 'int'),
    reportColumn('phone', 'text', { source: { table: 'members', column: 'phone' }, widthChars: 14 }),
    reportColumn('email', 'text', { source: { table: 'members', column: 'email' }, widthChars: 24 }),
  ],
  async rows(ctx, cursor, limit) {
    let q = filtered(ctx)
      .leftJoin('member_types as t', 't.id', 'm.member_type_id')
      .select(['m.id', 'm.member_no_display', 'm.name', 'm.name_key', 'm.class_name', 'm.expires_on', 'm.phone', 'm.email', 't.name_id', 't.name_en']);
    if (cursor !== null) {
      const [on, nameKey, id] = decodeCursor(cursor, keyset);
      q = q.where((eb) =>
        eb.or([
          eb('m.expires_on', '>', on),
          eb.and([eb('m.expires_on', '=', on), eb('m.name_key', '>', nameKey)]),
          eb.and([eb('m.expires_on', '=', on), eb('m.name_key', '=', nameKey), eb('m.id', '>', id)]),
        ]),
      );
    }
    const found = await q.orderBy('m.expires_on').orderBy('m.name_key').orderBy('m.id').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const rows: ReportRow[] = page.map((m) => [
      m.member_no_display,
      m.name,
      typeName(ctx, m),
      m.class_name,
      m.expires_on,
      m.expires_on === null ? null : diffDays(ctx.today, m.expires_on),
      m.phone,
      m.email,
    ]);
    const last = page[page.length - 1];
    return { rows, nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.expires_on ?? '', last.name_key, last.id]) : null };
  },
  async count(ctx) {
    return countRows(filtered(ctx));
  },
});
