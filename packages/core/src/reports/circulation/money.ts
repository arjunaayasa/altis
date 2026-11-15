import { countGrouped, countRows, sumGrouped } from '@altis/db';
import { CHARGE_STATUSES, PAYMENT_METHODS, type MessageKey } from '@altis/shared';
import { z } from 'zod';
import { decodeCursor, encodeCursor, label, moneyCell, offsetPage, rangeParam, textParam, vocabLabel } from '../collection/common.js';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportColumn, ReportCtx, ReportRow, TableReport } from '../types.js';
import { closedRange, memberMatchSql } from './common.js';

// The money of circulation (personal data), in minor units in the database and major units in the cells:
//
// - `circulation.charges`: every charge by member (by name, then the member, then the day it was charged): its day,
//   kind, description, amount, what was paid and waived and what is left; filtered by member, member type, status,
//   the days charged and branch. Ends with the totals.
// - `circulation.payments_daily`: the cash book of a date range (by default the 30 days up to today): per day, method
//   and staff member who took them, the number of payments and their sum (a voided payment left out), ending with
//   the total; or the receipts themselves, voided ones marked. It names staff members, so it is personal too.

const chargeKeyset = z.tuple([z.string().max(400), z.string().max(26), z.string().max(10), z.string().min(1).max(26)]);

function chargesFiltered(ctx: ReportCtx) {
  let q = ctx.db.selectFrom('charges as c').innerJoin('members as m', 'm.id', 'c.member_id');
  const member = textParam(ctx, 'member');
  if (member !== null) q = q.where(memberMatchSql(member));
  const memberTypeId = textParam(ctx, 'memberTypeId');
  if (memberTypeId !== null) q = q.where('m.member_type_id', '=', memberTypeId);
  const status = textParam(ctx, 'chargeStatus');
  if (status !== null) q = q.where('c.status', '=', status);
  const charged = rangeParam(ctx, 'charged');
  if (charged.from !== null) q = q.where('c.charged_on', '>=', charged.from);
  if (charged.to !== null) q = q.where('c.charged_on', '<=', charged.to);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('c.branch_id', '=', branchId);
  return q;
}

const left = (r: { amount_minor: number | string; paid_minor: number | string; waived_minor: number | string }): number =>
  Number(r.amount_minor) - Number(r.paid_minor) - Number(r.waived_minor);

/** The charges by member (see the top of this file). */
export const circulationChargesReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.charges',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.charges.title',
  permission: 'circulation.records.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('member', 'text'),
    reportParam('memberTypeId', 'memberType'),
    reportParam('chargeStatus', 'status', { options: CHARGE_STATUSES, optionLabelPrefix: 'vocab.charge_status.' }),
    reportParam('charged', 'dateRange'),
    reportParam('branchId', 'branch'),
  ],
  paramsSchema: z.strictObject({
    member: z.string().trim().min(1).max(191).optional(),
    memberTypeId: reportIdField.optional(),
    chargeStatus: z.enum(CHARGE_STATUSES).optional(),
    charged: reportDateRangeField.optional(),
    branchId: reportIdField.optional(),
  }),
  columns: [
    reportColumn('member_no', 'text', { widthChars: 14 }),
    reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 24 }),
    reportColumn('charged_on', 'date'),
    reportColumn('kind', 'text', { widthChars: 12 }),
    reportColumn('description', 'text', { source: { table: 'charges', column: 'description' }, widthChars: 28 }),
    reportColumn('amount', 'money'),
    reportColumn('paid', 'money'),
    reportColumn('waived', 'money'),
    reportColumn('balance', 'money'),
  ],
  async rows(ctx, cursor, limit) {
    let q = chargesFiltered(ctx).select([
      'c.id',
      'c.member_id',
      'c.charged_on',
      'c.kind',
      'c.description',
      'c.amount_minor',
      'c.paid_minor',
      'c.waived_minor',
      'm.name_key',
      'm.member_no_display',
      'm.name',
    ]);
    if (cursor !== null) {
      const [nameKey, memberId, chargedOn, id] = decodeCursor(cursor, chargeKeyset);
      q = q.where((eb) =>
        eb.or([
          eb('m.name_key', '>', nameKey),
          eb.and([eb('m.name_key', '=', nameKey), eb('c.member_id', '>', memberId)]),
          eb.and([eb('m.name_key', '=', nameKey), eb('c.member_id', '=', memberId), eb('c.charged_on', '>', chargedOn)]),
          eb.and([eb('m.name_key', '=', nameKey), eb('c.member_id', '=', memberId), eb('c.charged_on', '=', chargedOn), eb('c.id', '>', id)]),
        ]),
      );
    }
    const found = await q.orderBy('m.name_key').orderBy('c.member_id').orderBy('c.charged_on').orderBy('c.id').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const rows: ReportRow[] = page.map((r) => [
      r.member_no_display,
      r.name,
      r.charged_on,
      vocabLabel(ctx, 'charge_kind', r.kind),
      r.description === '' ? null : r.description,
      moneyCell(r.amount_minor),
      moneyCell(r.paid_minor),
      moneyCell(r.waived_minor),
      moneyCell(left(r)),
    ]);
    const last = page[page.length - 1];
    return {
      rows,
      nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.name_key, last.member_id, last.charged_on, last.id]) : null,
    };
  },
  async totals(ctx) {
    const sums = await Promise.all(['c.amount_minor', 'c.paid_minor', 'c.waived_minor'].map(async (col) => (await sumGrouped(chargesFiltered(ctx), {}, col))[0]?.sum ?? 0));
    const [amount, paid, waived] = sums as [number, number, number];
    return [label(ctx, 'report.row.total' as MessageKey), null, null, null, null, moneyCell(amount), moneyCell(paid), moneyCell(waived), moneyCell(amount - paid - waived)];
  },
  async count(ctx) {
    return countRows(chargesFiltered(ctx));
  },
});

/** What the cash book shows. */
export const PAYMENT_VIEWS = Object.freeze(['days', 'receipts'] as const);

const staffColumn = reportColumn('staff', 'text', { source: { table: 'staff_users', column: 'name' }, widthChars: 22 });

const DAY_COLUMNS: readonly ReportColumn[] = [
  reportColumn('paid_on', 'date'),
  reportColumn('method', 'text', { widthChars: 12 }),
  staffColumn,
  reportColumn('payments', 'int'),
  reportColumn('amount', 'money'),
];

const RECEIPT_COLUMNS: readonly ReportColumn[] = [
  reportColumn('paid_on', 'date'),
  reportColumn('receipt_no', 'text', { widthChars: 18 }),
  reportColumn('member_no', 'text', { widthChars: 14 }),
  reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 24 }),
  reportColumn('method', 'text', { widthChars: 12 }),
  staffColumn,
  reportColumn('amount', 'money'),
  reportColumn('voided', 'text', { widthChars: 10 }),
];

function paymentsFiltered(ctx: ReportCtx) {
  const range = closedRange(ctx, 'range', 30);
  let q = ctx.db.selectFrom('payments as p').where('p.paid_on', '>=', range.from).where('p.paid_on', '<=', range.to);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('p.branch_id', '=', branchId);
  const method = textParam(ctx, 'method');
  if (method !== null) q = q.where('p.method', '=', method);
  return q;
}

/** The staff names of `ids`. */
async function staffNames(ctx: ReportCtx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.db.selectFrom('staff_users').select(['id', 'name']).where('id', 'in', [...ids]).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The days view, whole (offset paged): per day, method and staff member. */
async function dayRows(ctx: ReportCtx): Promise<ReportRow[]> {
  const groups = await sumGrouped(paymentsFiltered(ctx).where('p.voided_at', 'is', null), { d: 'p.paid_on', m: 'p.method', s: 'p.received_by' }, 'p.amount_minor');
  const counts = await countGrouped(paymentsFiltered(ctx).where('p.voided_at', 'is', null), { d: 'p.paid_on', m: 'p.method', s: 'p.received_by' });
  const key = (g: { d: unknown; m: unknown; s: unknown }): string => `${String(g.d)}|${String(g.m)}|${String(g.s)}`;
  const n = new Map(counts.map((g) => [key(g), g.count]));
  const names = await staffNames(ctx, [...new Set(groups.map((g) => g.s).filter((s): s is string => typeof s === 'string'))]);
  const sorted = [...groups].sort(
    (a, b) =>
      String(a.d).localeCompare(String(b.d)) ||
      PAYMENT_METHODS.indexOf(String(a.m) as never) - PAYMENT_METHODS.indexOf(String(b.m) as never) ||
      String(names.get(String(a.s)) ?? '').localeCompare(String(names.get(String(b.s)) ?? '')),
  );
  return sorted.map((g) => [
    String(g.d),
    vocabLabel(ctx, 'payment_method', String(g.m)),
    g.s === null ? null : (names.get(String(g.s)) ?? null),
    n.get(key(g)) ?? 0,
    moneyCell(g.sum),
  ]);
}

/** The cash book by day, or its receipts (see the top of this file). */
export const circulationPaymentsDailyReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.payments_daily',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.payments_daily.title',
  permission: 'circulation.records.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('range', 'dateRange'),
    reportParam('branchId', 'branch'),
    reportParam('method', 'status', { options: PAYMENT_METHODS, optionLabelPrefix: 'vocab.payment_method.' }),
    reportParam('view', 'status', { options: PAYMENT_VIEWS }),
  ],
  paramsSchema: z.strictObject({
    range: reportDateRangeField.optional(),
    branchId: reportIdField.optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    view: z.enum(PAYMENT_VIEWS).optional(),
  }),
  columns: (params) => (params['view'] === 'receipts' ? RECEIPT_COLUMNS : DAY_COLUMNS),
  async rows(ctx, cursor, limit) {
    if (ctx.params['view'] !== 'receipts') return offsetPage(await dayRows(ctx), cursor, limit);
    let q = paymentsFiltered(ctx)
      .leftJoin('members as m', 'm.id', 'p.member_id')
      .select(['p.id', 'p.paid_on', 'p.receipt_no', 'p.method', 'p.received_by', 'p.amount_minor', 'p.voided_at', 'm.member_no_display', 'm.name']);
    if (cursor !== null) {
      const [paidOn, id] = decodeCursor(cursor, z.tuple([z.string().max(10), z.string().min(1).max(26)]));
      q = q.where((eb) => eb.or([eb('p.paid_on', '>', paidOn), eb.and([eb('p.paid_on', '=', paidOn), eb('p.id', '>', id)])]));
    }
    const found = await q.orderBy('p.paid_on').orderBy('p.id').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const names = await staffNames(ctx, [...new Set(page.map((p) => p.received_by).filter((s): s is string => s !== null))]);
    const voided = label(ctx, 'report.row.circ.voided' as MessageKey);
    const rows: ReportRow[] = page.map((p) => [
      p.paid_on,
      p.receipt_no,
      p.member_no_display,
      p.name,
      vocabLabel(ctx, 'payment_method', p.method),
      p.received_by === null ? null : (names.get(p.received_by) ?? null),
      moneyCell(p.amount_minor),
      p.voided_at === null ? null : voided,
    ]);
    const last = page[page.length - 1];
    return { rows, nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.paid_on, last.id]) : null };
  },
  async totals(ctx) {
    const sum = (await sumGrouped(paymentsFiltered(ctx).where('p.voided_at', 'is', null), {}, 'p.amount_minor'))[0]?.sum ?? 0;
    const total = label(ctx, 'report.row.total' as MessageKey);
    return ctx.params['view'] === 'receipts' ? [total, null, null, null, null, null, moneyCell(sum), null] : [total, null, null, null, moneyCell(sum)];
  },
  async count(ctx) {
    return ctx.params['view'] === 'receipts' ? countRows(paymentsFiltered(ctx)) : null;
  },
});
