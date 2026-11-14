import { countGrouped, datePrefix } from '@altis/db';
import { ACCRED_GROUPS, addMonths, type MessageKey } from '@altis/shared';
import { dateField } from '@altis/shared/api/catalog/common';
import { z } from 'zod';
import { label, offsetPage, textParam, vocabLabel } from '../collection/common.js';
import { reportColumn, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { rowLabel, sectionLabel, sumOf } from '../circulation/common.js';

// The members at a glance on a day (today by default), at one home branch or all: per member type the members
// registered (joined by the day, neither archived nor anonymised), and of them the active, the expired (valid until
// before the day) and the suspended ones; every live type is listed, also one without members. Then the same per
// accreditation group (the group of each type), and the members who joined in each of the twelve months up to the
// day. A suspension is read as it stands now: the database keeps no history of it.

type Counts = [registered: number, active: number, expired: number, suspended: number];

const zero = (): Counts => [0, 0, 0, 0];

/** The summary's rows and its totals row. */
async function summary(ctx: ReportCtx): Promise<{ rows: ReportRow[]; totals: ReportRow }> {
  const day = typeof ctx.params['asOf'] === 'string' ? (ctx.params['asOf'] as string) : ctx.today;
  const homeBranchId = textParam(ctx, 'homeBranchId');
  const live = () => {
    let q = ctx.db
      .selectFrom('members as m')
      .where('m.archived_at', 'is', null)
      .where('m.anonymized_at', 'is', null)
      .where('m.joined_on', '<=', day);
    if (homeBranchId !== null) q = q.where('m.home_branch_id', '=', homeBranchId);
    return q;
  };
  const byTypeStatus = await countGrouped(live(), { t: 'm.member_type_id', s: 'm.status' });
  const expired = await countGrouped(
    live().where('m.status', '<>', 'suspended').where('m.expires_on', 'is not', null).where('m.expires_on', '<', day),
    { t: 'm.member_type_id' },
  );
  const types = await ctx.db
    .selectFrom('member_types')
    .select(['id', 'name_id', 'name_en', 'accred_group', 'sort_order', 'archived_at'])
    .orderBy('sort_order')
    .orderBy('name_id')
    .execute();
  const counts = new Map<string, Counts>();
  const at = (typeId: string): Counts => {
    let c = counts.get(typeId);
    if (c === undefined) {
      c = zero();
      counts.set(typeId, c);
    }
    return c;
  };
  for (const g of byTypeStatus) {
    const c = at(String(g.t));
    c[0] += g.count;
    if (g.s === 'suspended') c[3] += g.count;
  }
  for (const g of expired) at(String(g.t))[2] += g.count;
  for (const c of counts.values()) c[1] = c[0] - c[2] - c[3];

  const rows: ReportRow[] = [];
  const byType = sectionLabel(ctx, 'members_by_type');
  const groups = new Map<string, Counts>();
  for (const t of types) {
    const c = counts.get(t.id);
    if (t.archived_at !== null && c === undefined) continue;
    const shown = c ?? zero();
    rows.push([byType, ctx.locale === 'en' ? (t.name_en ?? t.name_id) : t.name_id, ...shown]);
    const g = groups.get(t.accred_group) ?? zero();
    groups.set(t.accred_group, [g[0] + shown[0], g[1] + shown[1], g[2] + shown[2], g[3] + shown[3]]);
  }
  const byGroup = sectionLabel(ctx, 'members_by_group');
  for (const group of ACCRED_GROUPS) {
    const g = groups.get(group) ?? zero();
    rows.push([byGroup, vocabLabel(ctx, 'accred_group', group), ...g]);
  }

  const first = `${addMonths(`${day.slice(0, 7)}-01`, -11)}`;
  let joined = ctx.db.selectFrom('members as m').where('m.joined_on', '>=', first).where('m.joined_on', '<=', day);
  if (homeBranchId !== null) joined = joined.where('m.home_branch_id', '=', homeBranchId);
  const perMonth = new Map((await countGrouped(joined, { m: datePrefix('m.joined_on', 'month') })).map((g) => [String(g.m), g.count]));
  const newSection = sectionLabel(ctx, 'members_new');
  for (let k = 0; k < 12; k += 1) {
    const month = addMonths(first, k).slice(0, 7);
    rows.push([newSection, rowLabel(ctx, 'joined_in', { month }), perMonth.get(month) ?? 0, null, null, null]);
  }

  const all = [...counts.values()];
  const totals: ReportRow = [
    label(ctx, 'report.row.total' as MessageKey),
    null,
    sumOf(all.map((c) => c[0])),
    sumOf(all.map((c) => c[1])),
    sumOf(all.map((c) => c[2])),
    sumOf(all.map((c) => c[3])),
  ];
  return { rows, totals };
}

/** The members at a glance (see the top of this file). */
export const membersSummaryReport: TableReport = Object.freeze<TableReport>({
  id: 'members.summary',
  module: 'members',
  kind: 'table',
  titleKey: 'report.members.summary.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('homeBranchId', 'branch'), reportParam('asOf', 'asOf')],
  paramsSchema: z.strictObject({ homeBranchId: reportIdField.optional(), asOf: dateField.optional() }),
  columns: [
    reportColumn('section', 'text'),
    reportColumn('item', 'text'),
    reportColumn('registered', 'int'),
    reportColumn('active', 'int'),
    reportColumn('expired', 'int'),
    reportColumn('suspended', 'int'),
  ],
  async rows(ctx, cursor, limit) {
    return offsetPage((await summary(ctx)).rows, cursor, limit);
  },
  async totals(ctx) {
    return (await summary(ctx)).totals;
  },
});
