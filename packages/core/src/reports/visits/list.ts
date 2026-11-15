import { countRows } from '@altis/db';
import { VISIT_SOURCES } from '@altis/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { anyOf, decodeCursor, encodeCursor, rangeParam, textParam, vocabLabel } from '../collection/common.js';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { boolParam, escapeLike, localDateTime, memberMatchSql, numberIdKeyset, rowLabel, typeName } from '../circulation/common.js';
import { nameKeyWords } from '../../members/keys.js';

// The visit list (personal data): when (local date and time), who (a member's number and name, or "Tamu" and the
// guest's name), the member type and class the visit kept, the institution (a guest's own, a member's from the member),
// the room, the source and the purpose. Filtered by member type (or guests only), a member's number or name (a guest's
// name too), an institution, the room, the days and the source. Newest first, keyset paged; a voided visit is not
// listed.

function filtered(ctx: ReportCtx) {
  let q = ctx.db
    .selectFrom('visits as v')
    .leftJoin('members as m', 'm.id', 'v.member_id')
    .leftJoin('member_types as t', 't.id', 'v.member_type_id')
    .leftJoin('locations as loc', 'loc.id', 'v.location_id')
    .where('v.voided_at', 'is', null);
  if (boolParam(ctx, 'guestsOnly')) q = q.where('v.accred_group', '=', 'guest');
  const memberTypeId = textParam(ctx, 'memberTypeId');
  if (memberTypeId !== null) q = q.where('v.member_type_id', '=', memberTypeId);
  const who = textParam(ctx, 'member');
  if (who !== null) {
    const words = nameKeyWords(who);
    const guest = words.map((w) => sql<SqlBool>`lower(v.guest_name) like ${`%${escapeLike(w)}%`} escape '!'`);
    q = q.where(anyOf([memberMatchSql(who), ...(guest.length > 0 ? [sql<SqlBool>`(${sql.join(guest, sql` and `)})`] : [])]));
  }
  const institution = textParam(ctx, 'institution');
  if (institution !== null) {
    const like = `%${escapeLike(institution.toLowerCase())}%`;
    q = q.where(anyOf([sql<SqlBool>`lower(v.guest_institution) like ${like} escape '!'`, sql<SqlBool>`lower(m.institution) like ${like} escape '!'`]));
  }
  const locationId = textParam(ctx, 'locationId');
  if (locationId !== null) q = q.where('v.location_id', '=', locationId);
  const visited = rangeParam(ctx, 'visited');
  if (visited.from !== null) q = q.where('v.visited_on', '>=', visited.from);
  if (visited.to !== null) q = q.where('v.visited_on', '<=', visited.to);
  const source = textParam(ctx, 'source');
  if (source !== null) q = q.where('v.source', '=', source);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('v.branch_id', '=', branchId);
  return q;
}

/** The visit list (see the top of this file). */
export const visitsListReport: TableReport = Object.freeze<TableReport>({
  id: 'visits.list',
  module: 'visits',
  kind: 'table',
  titleKey: 'report.visits.list.title',
  permission: 'visits.records.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('memberTypeId', 'memberType'),
    reportParam('guestsOnly', 'bool'),
    reportParam('member', 'text'),
    reportParam('institution', 'text'),
    reportParam('branchId', 'branch'),
    reportParam('locationId', 'location'),
    reportParam('visited', 'dateRange'),
    reportParam('source', 'status', { options: VISIT_SOURCES, optionLabelPrefix: 'vocab.visit_source.' }),
  ],
  paramsSchema: z.strictObject({
    memberTypeId: reportIdField.optional(),
    guestsOnly: z.boolean().optional(),
    member: z.string().trim().min(1).max(191).optional(),
    institution: z.string().trim().min(1).max(191).optional(),
    branchId: reportIdField.optional(),
    locationId: reportIdField.optional(),
    visited: reportDateRangeField.optional(),
    source: z.enum(VISIT_SOURCES).optional(),
  }),
  columns: [
    reportColumn('visited_at', 'text', { widthChars: 16 }),
    reportColumn('member_no', 'text', { widthChars: 14 }),
    reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 24 }),
    reportColumn('member_type', 'text', { widthChars: 12 }),
    reportColumn('class', 'text', { widthChars: 8 }),
    reportColumn('institution', 'text', { source: { table: 'visits', column: 'guest_institution' }, widthChars: 20 }),
    reportColumn('location', 'text', { widthChars: 14 }),
    reportColumn('source', 'text', { widthChars: 10 }),
    reportColumn('purpose', 'text', { widthChars: 12 }),
  ],
  async rows(ctx, cursor, limit) {
    let q = filtered(ctx).select([
      'v.id',
      'v.visited_at',
      'v.accred_group',
      'v.class_name',
      'v.guest_name',
      'v.guest_institution',
      'v.source',
      'v.purpose',
      'v.headcount',
      'm.member_no_display',
      'm.name',
      'm.institution',
      't.name_id',
      't.name_en',
      'loc.name as location_name',
    ]);
    if (cursor !== null) {
      const [at, id] = decodeCursor(cursor, numberIdKeyset);
      q = q.where((eb) => eb.or([eb('v.visited_at', '<', at), eb.and([eb('v.visited_at', '=', at), eb('v.id', '<', id)])]));
    }
    const found = await q.orderBy('v.visited_at', 'desc').orderBy('v.id', 'desc').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const guest = rowLabel(ctx, 'guest');
    const rows: ReportRow[] = page.map((v) => {
      const isGuest = v.accred_group === 'guest';
      const headcount = Number(v.headcount);
      const name = isGuest ? v.guest_name : v.name;
      return [
        localDateTime(ctx.tz, Number(v.visited_at)),
        isGuest ? guest : v.member_no_display,
        headcount > 1 && name !== null ? `${name} (${headcount})` : headcount > 1 ? String(headcount) : name,
        typeName(ctx, v),
        v.class_name,
        isGuest ? v.guest_institution : v.institution,
        v.location_name,
        vocabLabel(ctx, 'visit_source', v.source),
        vocabLabel(ctx, 'visit_purpose', v.purpose),
      ];
    });
    const last = page[page.length - 1];
    return { rows, nextCursor: found.length > limit && last !== undefined ? encodeCursor([Number(last.visited_at), last.id]) : null };
  },
  async count(ctx) {
    return countRows(filtered(ctx));
  },
});
