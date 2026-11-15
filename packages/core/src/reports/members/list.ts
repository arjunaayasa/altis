import { countRows } from '@altis/db';
import { GENDERS, MEMBER_STATUSES, t, type Gender, type MemberStatus } from '@altis/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { memberStatusOf, memberStatusWhere } from '../../members/common.js';
import { decodeCursor, encodeCursor } from '../collection/common.js';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportColumn, ReportCtx, ReportRow, TableReport } from '../types.js';

// The member list (personal data): number, name, type, class, gender, status, joined and valid-until dates, and on
// request the contact columns; filtered by type, class, shown status, home branch, the join date and the expiry date.
// Seeing it needs `members.records.read`, exporting it `members.export.run` with a fresh re-authentication (the
// export is audited as every report run). Ordered by name, keyset paged.

const base: readonly ReportColumn[] = [
  reportColumn('member_no', 'text', { widthChars: 16 }),
  reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 30 }),
  reportColumn('member_type', 'text', { widthChars: 16 }),
  reportColumn('class', 'text', { source: { table: 'members', column: 'class_name' }, widthChars: 10 }),
  reportColumn('gender', 'text', { source: { table: 'members', column: 'gender' }, widthChars: 10 }),
  reportColumn('member_status', 'text', { widthChars: 14 }),
  reportColumn('joined_on', 'date'),
  reportColumn('expires_on', 'date'),
];

const contact: readonly ReportColumn[] = [
  reportColumn('email', 'text', { source: { table: 'members', column: 'email' }, widthChars: 24 }),
  reportColumn('phone', 'text', { source: { table: 'members', column: 'phone' }, widthChars: 14 }),
  reportColumn('address', 'text', { source: { table: 'members', column: 'address' }, widthChars: 30 }),
];

function where(ctx: ReportCtx) {
  const p = ctx.params;
  const parts: ReturnType<typeof sql<SqlBool>>[] = [];
  if (typeof p['memberTypeId'] === 'string') parts.push(sql<SqlBool>`m.member_type_id = ${p['memberTypeId']}`);
  if (typeof p['className'] === 'string') parts.push(sql<SqlBool>`m.class_name = ${p['className']}`);
  if (typeof p['homeBranchId'] === 'string') parts.push(sql<SqlBool>`m.home_branch_id = ${p['homeBranchId']}`);
  const status = p['memberStatus'] as MemberStatus | undefined;
  parts.push(status === undefined ? sql<SqlBool>`(m.archived_at is null and m.anonymized_at is null)` : (memberStatusWhere(status, ctx.today) as ReturnType<typeof sql<SqlBool>>));
  const range = (name: string, column: string): void => {
    const r = p[name] as { from?: string; to?: string } | undefined;
    if (r?.from !== undefined) parts.push(sql<SqlBool>`${sql.ref(column)} >= ${r.from}`);
    if (r?.to !== undefined) parts.push(sql<SqlBool>`${sql.ref(column)} <= ${r.to}`);
  };
  range('joined', 'm.joined_on');
  range('expires', 'm.expires_on');
  return sql<SqlBool>`(${sql.join(parts, sql` and `)})`;
}

const keyset = z.tuple([z.string().max(400), z.string().min(1).max(26)]);

/** The member list (see the top of this file). */
export const membersListReport: TableReport = Object.freeze<TableReport>({
  id: 'members.list',
  module: 'members',
  kind: 'table',
  titleKey: 'report.members.list.title',
  permission: 'members.records.read',
  exportPermission: 'members.export.run',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('memberTypeId', 'memberType'),
    reportParam('className', 'className'),
    reportParam('memberStatus', 'status', { options: MEMBER_STATUSES, optionLabelPrefix: 'vocab.member_status.' }),
    reportParam('homeBranchId', 'branch'),
    reportParam('joined', 'dateRange'),
    reportParam('expires', 'dateRange'),
    reportParam('contact', 'bool'),
  ],
  paramsSchema: z.strictObject({
    memberTypeId: reportIdField.optional(),
    className: z.string().trim().min(1).max(64).optional(),
    memberStatus: z.enum(MEMBER_STATUSES).optional(),
    homeBranchId: reportIdField.optional(),
    joined: reportDateRangeField.optional(),
    expires: reportDateRangeField.optional(),
    contact: z.boolean().optional(),
  }),
  columns: (params) => (params['contact'] === true ? [...base, ...contact] : base),
  async rows(ctx, cursor, limit) {
    let q = ctx.db
      .selectFrom('members as m')
      .leftJoin('member_types as t', 't.id', 'm.member_type_id')
      .select([
        'm.id',
        'm.name_key',
        'm.member_no_display',
        'm.name',
        't.name_id',
        't.name_en',
        'm.class_name',
        'm.gender',
        'm.status',
        'm.expires_on',
        'm.archived_at',
        'm.anonymized_at',
        'm.joined_on',
        'm.email',
        'm.phone',
        'm.address',
      ])
      .where(where(ctx));
    if (cursor !== null) {
      const [nameKey, id] = decodeCursor(cursor, keyset);
      q = q.where((eb) => eb.or([eb('m.name_key', '>', nameKey), eb.and([eb('m.name_key', '=', nameKey), eb('m.id', '>', id)])]));
    }
    const found = await q.orderBy('m.name_key').orderBy('m.id').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const withContact = ctx.params['contact'] === true;
    const rows: ReportRow[] = page.map((r) => {
      const shown = memberStatusOf(
        { anonymized_at: r.anonymized_at === null ? null : Number(r.anonymized_at), archived_at: r.archived_at === null ? null : Number(r.archived_at), status: r.status, expires_on: r.expires_on },
        ctx.today,
      );
      const gender = r.gender !== null && (GENDERS as readonly string[]).includes(r.gender) ? t(ctx.locale, `vocab.gender.${r.gender as Gender}`) : null;
      const row: (string | number | null)[] = [
        r.member_no_display,
        r.name,
        (ctx.locale === 'en' ? (r.name_en ?? r.name_id) : r.name_id) ?? null,
        r.class_name,
        gender,
        t(ctx.locale, `vocab.member_status.${shown}`),
        r.joined_on,
        r.expires_on,
      ];
      if (withContact) row.push(r.email, r.phone, r.address);
      return row;
    });
    const last = page[page.length - 1];
    return { rows, nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.name_key, last.id]) : null };
  },
  async count(ctx) {
    return countRows(ctx.db.selectFrom('members as m').where(where(ctx)));
  },
});
