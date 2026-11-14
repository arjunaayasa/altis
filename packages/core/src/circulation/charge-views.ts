import type { DB } from '@altis/db';
import { diffDays, type ChargeAdjustmentKind, type ChargeKind, type ChargeSource, type ChargeStatus, type MemberBlockReason, type PaymentMethod } from '@altis/shared';
import type {
  ChargeAdjustmentView,
  ChargeMemberRef,
  ChargeView,
  DeskChargesView,
  MemberChargesQuery,
  MemberChargesResponse,
  OpenBalancesQuery,
  OpenBalancesResponse,
  PaymentListQuery,
  PaymentListResponse,
  PaymentSummaryQuery,
  PaymentSummaryResponse,
  PaymentTotals,
  PaymentView,
} from '@altis/shared/api/charges';
import type { Selectable } from 'kysely';
import { formatPrice } from '../catalog/items/service.js';
import { libraryToday, memberNotFound, memberValidationFailed, type Db } from '../members/common.js';
import { readSettings } from '../settings/service.js';

// Reading charges and payments: the views staff see, a member's balance, the block a balance or an overdue loan puts on
// a member, and the lists (a member's charges, the open balances, the payments and their daily cash summary).
//
// A charge's balance is `amount − paid − waived`; a member's is the sum over the open charges. Money leaves this module
// as decimal strings (formatPrice); it is minor units everywhere below.

type ChargeRow = Selectable<DB['charges']>;
type PaymentRow = Selectable<DB['payments']>;

const ok = (n: number | string | bigint | null | undefined): number => Number(n ?? 0);

/** What is left to pay of a charge row (minor units). */
export function chargeLeft(row: Pick<ChargeRow, 'amount_minor' | 'paid_minor' | 'waived_minor'>): number {
  return ok(row.amount_minor) - ok(row.paid_minor) - ok(row.waived_minor);
}

/** The library's currency (`catalog.currency`). */
export async function libraryCurrency(db: Db): Promise<string> {
  return (await readSettings(db, ['catalog.currency'], []))['catalog.currency'] as string;
}

// ---- views -----------------------------------------------------------------------------------------------------------

/** The views of charge rows, with the barcode and title of the item each names. */
export async function chargeViews(db: Db, rows: readonly ChargeRow[]): Promise<ChargeView[]> {
  const itemIds = [...new Set(rows.map((r) => r.item_id).filter((id): id is string => id !== null))];
  const items = new Map<string, { barcode: string; title: string | null }>();
  for (let k = 0; k < itemIds.length; k += 500) {
    const found = await db
      .selectFrom('items as i')
      .leftJoin('records as r', 'r.id', 'i.record_id')
      .select(['i.id', 'i.barcode_display', 'r.title'])
      .where('i.id', 'in', itemIds.slice(k, k + 500))
      .execute();
    for (const f of found) items.set(f.id, { barcode: f.barcode_display, title: f.title ?? null });
  }
  return rows.map((r) => {
    const item = r.item_id === null ? undefined : items.get(r.item_id);
    return {
      id: r.id,
      version: ok(r.version),
      memberId: r.member_id,
      branchId: r.branch_id,
      loanId: r.loan_id,
      kind: r.kind as ChargeKind,
      description: r.description,
      amount: formatPrice(ok(r.amount_minor)),
      paid: formatPrice(ok(r.paid_minor)),
      waived: formatPrice(ok(r.waived_minor)),
      balance: formatPrice(chargeLeft(r)),
      currency: r.currency,
      status: r.status as ChargeStatus,
      chargedOn: r.charged_on,
      dateUnknown: ok(r.date_unknown) === 1,
      source: r.source as ChargeSource,
      item: r.item_id === null ? null : { id: r.item_id, barcode: item?.barcode ?? '', title: item?.title ?? null },
    };
  });
}

/** The names of the staff users `ids` (an id that is not a staff user has none). */
async function staffNames(db: Db, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const out = new Map<string, string>();
  for (let k = 0; k < wanted.length; k += 500) {
    const rows = await db.selectFrom('staff_users').select(['id', 'name']).where('id', 'in', wanted.slice(k, k + 500)).execute();
    for (const r of rows) out.set(r.id, r.name);
  }
  return out;
}

/** The views of payment rows, with their allocations and the names of the staff who took them. */
export async function paymentViews(db: Db, rows: readonly PaymentRow[]): Promise<PaymentView[]> {
  const ids = rows.map((r) => r.id);
  const allocations = new Map<string, PaymentView['allocations']>();
  for (let k = 0; k < ids.length; k += 500) {
    const found = await db
      .selectFrom('payment_allocations as a')
      .innerJoin('charges as c', 'c.id', 'a.charge_id')
      .select(['a.payment_id', 'a.charge_id', 'a.amount_minor', 'c.kind', 'c.description'])
      .where('a.payment_id', 'in', ids.slice(k, k + 500))
      .orderBy('a.payment_id')
      .orderBy('a.charge_id')
      .execute();
    for (const a of found) {
      const list = allocations.get(a.payment_id) ?? [];
      list.push({ chargeId: a.charge_id, amount: formatPrice(ok(a.amount_minor)), kind: a.kind as ChargeKind, description: a.description });
      allocations.set(a.payment_id, list);
    }
  }
  const names = await staffNames(
    db,
    rows.map((r) => r.received_by),
  );
  return rows.map((r) => ({
    id: r.id,
    version: ok(r.version),
    memberId: r.member_id,
    branchId: r.branch_id,
    receiptNo: r.receipt_no,
    amount: formatPrice(ok(r.amount_minor)),
    currency: r.currency,
    method: r.method as PaymentMethod,
    paidOn: r.paid_on,
    paidAt: ok(r.paid_at),
    receivedBy: r.received_by === null ? null : (names.get(r.received_by) ?? null),
    note: r.note,
    voided: r.voided_at !== null,
    voidedAt: r.voided_at === null ? null : ok(r.voided_at),
    voidReason: r.void_reason,
    allocations: allocations.get(r.id) ?? [],
  }));
}

// ---- balances and blocks ---------------------------------------------------------------------------------------------

/** The unpaid balance (minor units) of each of `memberIds` that has one. */
export async function memberBalances(db: Db, memberIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(memberIds)];
  for (let k = 0; k < ids.length; k += 500) {
    const rows = await db
      .selectFrom('charges')
      .select(['member_id', 'amount_minor', 'paid_minor', 'waived_minor'])
      .where('member_id', 'in', ids.slice(k, k + 500))
      .where('status', '=', 'open')
      .execute();
    for (const r of rows) {
      const left = chargeLeft(r);
      if (left > 0) out.set(r.member_id, (out.get(r.member_id) ?? 0) + left);
    }
  }
  return out;
}

/** The library's optional blocks (`circulation.block.*`; both off by default). */
export async function blockSettings(db: Db): Promise<{ unpaidOverMinor: number | null; overdue: boolean }> {
  const s = await readSettings(db, ['circulation.block.unpaidOverMinor', 'circulation.block.overdue'], []);
  const limit = s['circulation.block.unpaidOverMinor'];
  return { unpaidOverMinor: typeof limit === 'number' ? limit : null, overdue: s['circulation.block.overdue'] === true };
}

/**
 * The block that refuses the member `memberId` a loan (or, with `renewal`, a renewal) at `today`: an unpaid balance
 * above `circulation.block.unpaidOverMinor` (`unpaid`, loans and renewals), else an open loan due before today with
 * `circulation.block.overdue` (`overdue`, loans only); null when neither applies.
 */
export async function memberBlock(db: Db, i: { memberId: string; today: string; renewal?: boolean; balanceMinor?: number }): Promise<MemberBlockReason | null> {
  const s = await blockSettings(db);
  if (s.unpaidOverMinor !== null) {
    const balance = i.balanceMinor ?? (await memberBalances(db, [i.memberId])).get(i.memberId) ?? 0;
    if (balance > s.unpaidOverMinor) return 'unpaid';
  }
  if (i.renewal !== true && s.overdue) {
    const late = await db
      .selectFrom('loans')
      .select('id')
      .where('member_id', '=', i.memberId)
      .where('open_item_id', 'is not', null)
      .where('due_on', '<', i.today)
      .limit(1)
      .executeTakeFirst();
    if (late !== undefined) return 'overdue';
  }
  return null;
}

// ---- the desk --------------------------------------------------------------------------------------------------------

/** What the desk panel shows of the member's money at `today` (see DeskChargesView). */
export async function deskCharges(db: Db, memberId: string, today: string): Promise<DeskChargesView> {
  const rows = await db
    .selectFrom('charges')
    .selectAll()
    .where('member_id', '=', memberId)
    .where('status', '=', 'open')
    .orderBy('charged_at')
    .orderBy('id')
    .limit(500)
    .execute();
  const payments = await db.selectFrom('payments').selectAll().where('member_id', '=', memberId).orderBy('paid_at', 'desc').orderBy('id', 'desc').limit(10).execute();
  const balance = rows.reduce((sum, r) => sum + chargeLeft(r), 0);
  return {
    balance: formatPrice(balance),
    currency: rows[0]?.currency ?? (await libraryCurrency(db)),
    charges: await chargeViews(db, rows),
    payments: await paymentViews(db, payments),
    blocked: await memberBlock(db, { memberId, today, balanceMinor: balance }),
  };
}

// ---- records ---------------------------------------------------------------------------------------------------------

/**
 * Every charge (at most 500), adjustment and payment (at most 200) of the member `memberId`, newest first.
 *
 * @throws DomainError NOT_FOUND (no such member)
 */
export async function memberCharges(db: Db, memberId: string, q: MemberChargesQuery): Promise<MemberChargesResponse> {
  const member = await db.selectFrom('members').select('id').where('id', '=', memberId).executeTakeFirst();
  if (member === undefined) throw memberNotFound();
  let cq = db.selectFrom('charges').selectAll().where('member_id', '=', memberId);
  if (q.status === 'open') cq = cq.where('status', '=', 'open');
  const rows = await cq.orderBy('charged_at', 'desc').orderBy('id', 'desc').limit(500).execute();
  const ids = rows.map((r) => r.id);
  const adjustments: ChargeAdjustmentView[] = [];
  for (let k = 0; k < ids.length; k += 500) {
    const found = await db.selectFrom('charge_adjustments').selectAll().where('charge_id', 'in', ids.slice(k, k + 500)).orderBy('at', 'desc').orderBy('id', 'desc').execute();
    const names = await staffNames(
      db,
      found.map((a) => a.by),
    );
    for (const a of found) {
      adjustments.push({
        id: a.id,
        chargeId: a.charge_id,
        kind: a.kind as ChargeAdjustmentKind,
        amount: formatPrice(ok(a.amount_minor)),
        reason: a.reason_text,
        at: ok(a.at),
        by: a.by === null ? null : (names.get(a.by) ?? null),
      });
    }
  }
  const payments = await db.selectFrom('payments').selectAll().where('member_id', '=', memberId).orderBy('paid_at', 'desc').orderBy('id', 'desc').limit(200).execute();
  const balance = (await memberBalances(db, [memberId])).get(memberId) ?? 0;
  return {
    memberId,
    balance: formatPrice(balance),
    currency: rows[0]?.currency ?? (await libraryCurrency(db)),
    charges: await chargeViews(db, rows),
    adjustments,
    payments: await paymentViews(db, payments),
  };
}

/** The most members the open balances list. */
export const OPEN_BALANCES_MAX = 500;

/** The members with an unpaid balance (at `branchId`'s charges, or every branch's), the largest balance first. */
export async function openBalances(db: Db, q: OpenBalancesQuery): Promise<OpenBalancesResponse> {
  let query = db
    .selectFrom('charges as c')
    .innerJoin('members as m', 'm.id', 'c.member_id')
    .select(['c.member_id', 'c.amount_minor', 'c.paid_minor', 'c.waived_minor', 'c.charged_on', 'm.member_no_display', 'm.name', 'm.class_name'])
    .where('c.status', '=', 'open');
  if (q.branchId !== undefined) query = query.where('c.branch_id', '=', q.branchId);
  const rows = await query.execute();
  const by = new Map<string, { member: ChargeMemberRef; balance: number; openCharges: number; oldestChargedOn: string }>();
  for (const r of rows) {
    const left = chargeLeft(r);
    if (left <= 0) continue;
    const entry = by.get(r.member_id) ?? {
      member: { id: r.member_id, memberNo: r.member_no_display, name: r.name, className: r.class_name },
      balance: 0,
      openCharges: 0,
      oldestChargedOn: r.charged_on,
    };
    entry.balance += left;
    entry.openCharges += 1;
    if (r.charged_on < entry.oldestChargedOn) entry.oldestChargedOn = r.charged_on;
    by.set(r.member_id, entry);
  }
  const all = [...by.values()].sort((a, b) => b.balance - a.balance || a.member.memberNo.localeCompare(b.member.memberNo));
  const shown = all.slice(0, OPEN_BALANCES_MAX);
  return {
    currency: await libraryCurrency(db),
    items: shown.map((e) => ({ member: e.member, balance: formatPrice(e.balance), openCharges: e.openCharges, oldestChargedOn: e.oldestChargedOn })),
    total: formatPrice(all.reduce((sum, e) => sum + e.balance, 0)),
    truncated: all.length > shown.length,
  };
}

/** A payment list cursor: `<paid_at>.<id>`. */
function decodePaymentCursor(cursor: string | undefined): { at: number; id: string } | null {
  if (cursor === undefined) return null;
  const m = /^(\d{1,16})\.([0-9A-HJKMNP-TV-Z]{26})$/.exec(cursor);
  if (m === null) throw memberValidationFailed([{ path: 'cursor', code: 'invalid' }]);
  return { at: Number(m[1]), id: m[2]! };
}

/** The payments of the query, newest first (see PaymentListQuery). */
export async function listPayments(db: Db, q: PaymentListQuery): Promise<PaymentListResponse> {
  let query = db.selectFrom('payments').selectAll();
  if (q.branchId !== undefined) query = query.where('branch_id', '=', q.branchId);
  if (q.memberId !== undefined) query = query.where('member_id', '=', q.memberId);
  if (q.method !== undefined) query = query.where('method', '=', q.method);
  if (q.from !== undefined) query = query.where('paid_on', '>=', q.from);
  if (q.to !== undefined) query = query.where('paid_on', '<=', q.to);
  const after = decodePaymentCursor(q.cursor);
  if (after !== null) query = query.where((eb) => eb.or([eb('paid_at', '<', after.at), eb.and([eb('paid_at', '=', after.at), eb('id', '<', after.id)])]));
  const rows = await query.orderBy('paid_at', 'desc').orderBy('id', 'desc').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const views = await paymentViews(db, page);
  const memberIds = [...new Set(page.map((r) => r.member_id))];
  const members = new Map<string, ChargeMemberRef>();
  for (let k = 0; k < memberIds.length; k += 500) {
    const found = await db.selectFrom('members').select(['id', 'member_no_display', 'name', 'class_name']).where('id', 'in', memberIds.slice(k, k + 500)).execute();
    for (const m of found) members.set(m.id, { id: m.id, memberNo: m.member_no_display, name: m.name, className: m.class_name });
  }
  const last = page[page.length - 1];
  return {
    items: views.map((v) => ({ ...v, member: members.get(v.memberId) ?? null })),
    nextCursor: rows.length > q.limit && last !== undefined ? `${ok(last.paid_at)}.${last.id}` : null,
  };
}

/** The longest span of a payment summary, in days. */
export const PAYMENT_SUMMARY_MAX_DAYS = 366;

/** Empty sums. */
function zeroTotals(): { count: number; total: number; byMethod: Record<PaymentMethod, number> } {
  return { count: 0, total: 0, byMethod: { cash: 0, transfer: 0, other: 0 } };
}

function totalsView(t: { count: number; total: number; byMethod: Record<PaymentMethod, number> }): PaymentTotals {
  return {
    count: t.count,
    total: formatPrice(t.total),
    byMethod: { cash: formatPrice(t.byMethod.cash), transfer: formatPrice(t.byMethod.transfer), other: formatPrice(t.byMethod.other) },
  };
}

/**
 * The daily cash summary of the days `from`…`to` (default: the library's today): per day and in all, the sums and
 * counts per method and per staff member, voided payments left out and counted apart.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'to', code: 'range_too_long'}` (more than 366 days), `{path: 'to',
 *   code: 'before_from'}`
 */
export async function paymentSummary(db: Db, q: PaymentSummaryQuery, now: number): Promise<PaymentSummaryResponse> {
  const today = await libraryToday(db, now);
  const to = q.to ?? today;
  const from = q.from ?? to;
  if (to < from) throw memberValidationFailed([{ path: 'to', code: 'before_from' }]);
  if (diffDays(from, to) >= PAYMENT_SUMMARY_MAX_DAYS) throw memberValidationFailed([{ path: 'to', code: 'range_too_long' }]);
  let query = db
    .selectFrom('payments')
    .select(['id', 'paid_on', 'amount_minor', 'method', 'received_by', 'voided_at'])
    .where('paid_on', '>=', from)
    .where('paid_on', '<=', to);
  if (q.branchId !== undefined) query = query.where('branch_id', '=', q.branchId);
  if (q.method !== undefined) query = query.where('method', '=', q.method);
  const rows = await query.orderBy('paid_on').orderBy('id').execute();
  const names = await staffNames(
    db,
    rows.map((r) => r.received_by),
  );
  type Sums = ReturnType<typeof zeroTotals>;
  const add = (t: Sums, method: PaymentMethod, amount: number): void => {
    t.count += 1;
    t.total += amount;
    t.byMethod[method] += amount;
  };
  const all = zeroTotals();
  const voided = { count: 0, total: 0 };
  const days = new Map<string, { sums: Sums; staff: Map<string, Sums> }>();
  const staff = new Map<string, Sums>();
  for (const r of rows) {
    const amount = ok(r.amount_minor);
    if (r.voided_at !== null) {
      voided.count += 1;
      voided.total += amount;
      continue;
    }
    const method = r.method as PaymentMethod;
    const staffKey = r.received_by ?? '';
    const day = days.get(r.paid_on) ?? { sums: zeroTotals(), staff: new Map<string, Sums>() };
    days.set(r.paid_on, day);
    const dayStaff = day.staff.get(staffKey) ?? zeroTotals();
    day.staff.set(staffKey, dayStaff);
    const allStaff = staff.get(staffKey) ?? zeroTotals();
    staff.set(staffKey, allStaff);
    for (const t of [all, day.sums, dayStaff, allStaff]) add(t, method, amount);
  }
  const staffRows = (m: Map<string, Sums>) =>
    [...m.entries()]
      .map(([key, t]) => ({ ...totalsView(t), staffId: key === '' ? null : key, name: key === '' ? null : (names.get(key) ?? null) }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.staffId ?? '').localeCompare(b.staffId ?? ''));
  return {
    from,
    to,
    currency: await libraryCurrency(db),
    days: [...days.entries()].map(([day, d]) => ({ day, ...totalsView(d.sums), byStaff: staffRows(d.staff) })),
    all: totalsView(all),
    byStaff: staffRows(staff),
    voided: { count: voided.count, total: formatPrice(voided.total) },
  };
}
