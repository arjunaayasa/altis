import { DomainError, t, type Locale } from '@altis/shared';
import type { ReceiptPaper } from '@altis/shared/api/charges';
import { formatPrice } from '../catalog/items/service.js';
import type { Db } from '../members/common.js';
import { PdfLayout } from '../print/layout.js';
import { readSettings } from '../settings/service.js';
import { branchTimeZone } from './dates.js';
import { FinePreviewer } from './fines.js';

// The transaction slip of a visit at the desk (F9): the loans and renewals made, the items returned (with the days late,
// the days their fine counted when those differ, as the desk says it, and the overdue fine each booked) and the
// payments taken, on a 58 or 80 mm roll in the library's language. Every loan
// named must be one of the desk's branch (made there, or returned there), every payment one taken there; anything else
// is 404, as if it did not exist. Nothing is written: the slip only reads.

/** A loan or renewal on the slip. */
interface SlipLoan {
  barcode: string;
  title: string;
  dueOn: string;
  renewed: boolean;
}

/** A returned item on the slip. */
interface SlipReturn {
  barcode: string;
  title: string;
  returnedOn: string;
  /** Calendar days past the due date at the return. */
  daysLate: number;
  /** The days the booked fine counted (fines.ts lateness), when a fine was booked; null otherwise. */
  finedDays: number | null;
  /** The overdue fine booked at the return (decimal), or null. */
  fine: string | null;
}

/** What a slip prints. */
export interface SlipData {
  library: { name: string; address: string | null };
  branchName: string;
  member: { memberNo: string; name: string } | null;
  printedOn: string;
  time: string;
  currency: string;
  loans: SlipLoan[];
  returns: SlipReturn[];
  payments: { receiptNo: string | null; amount: string; method: string; voided: boolean }[];
  locale: Locale;
  paper: ReceiptPaper;
}

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Transaksi tidak ditemukan di cabang ini / Transaction not found at this branch' });
}

/** A title cut to 40 characters. */
const cut = (s: string): string => (s.length <= 40 ? s : `${s.slice(0, 39)}…`);

/**
 * The slip of `loanIds` (lent or renewed), `returnedLoanIds` and `paymentIds` at the desk of `branchId`.
 *
 * @throws DomainError NOT_FOUND (a loan or payment not of this branch)
 */
export async function slipData(
  db: Db,
  i: { branchId: string; loanIds: readonly string[]; returnedLoanIds: readonly string[]; paymentIds: readonly string[]; paper?: ReceiptPaper; now: number },
): Promise<SlipData> {
  const loanIds = [...new Set([...i.loanIds, ...i.returnedLoanIds])];
  const loans =
    loanIds.length === 0
      ? []
      : await db
          .selectFrom('loans as l')
          .leftJoin('items as it', 'it.id', 'l.item_id')
          .leftJoin('records as r', 'r.id', 'l.record_id')
          .select([
            'l.id',
            'l.branch_id',
            'l.return_branch_id',
            'l.member_id',
            'l.due_on',
            'l.renewals',
            'l.returned_on',
            'l.fine_per_day_minor',
            'l.fine_cap_minor',
            'l.grace_days',
            'it.barcode_display',
            'r.title',
          ])
          .where('l.id', 'in', loanIds)
          .execute();
  const byId = new Map(loans.map((l) => [l.id, l]));
  for (const id of loanIds) {
    const l = byId.get(id);
    if (l === undefined || (l.branch_id !== i.branchId && l.return_branch_id !== i.branchId)) throw notFound();
  }
  const payments =
    i.paymentIds.length === 0 ? [] : await db.selectFrom('payments').selectAll().where('id', 'in', [...new Set(i.paymentIds)]).orderBy('paid_at').execute();
  if (payments.length !== new Set(i.paymentIds).size || payments.some((p) => p.branch_id !== i.branchId)) throw notFound();

  const fines = new Map<string, number>();
  if (i.returnedLoanIds.length > 0) {
    const rows = await db.selectFrom('charges').select(['loan_id', 'amount_minor']).where('loan_id', 'in', [...new Set(i.returnedLoanIds)]).where('kind', '=', 'overdue').execute();
    for (const r of rows) if (r.loan_id !== null) fines.set(r.loan_id, (fines.get(r.loan_id) ?? 0) + Number(r.amount_minor));
  }
  const memberIds = new Set([...loans.map((l) => l.member_id), ...payments.map((p) => p.member_id)].filter((id): id is string => id !== null));
  const member =
    memberIds.size === 1 ? await db.selectFrom('members').select(['member_no_display', 'name']).where('id', '=', [...memberIds][0]!).executeTakeFirst() : undefined;
  const s = await readSettings(db, ['library.name', 'library.address', 'library.locale', 'circulation.receipt.paperMm', 'catalog.currency'], []);
  const branch = await db.selectFrom('branches').select(['name', 'code_display']).where('id', '=', i.branchId).executeTakeFirst();
  const zone = await branchTimeZone(db, i.branchId);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(i.now);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // The days late and the days the fine counted, as the return worked them out (one computation: fines.ts lateness).
  const fined = await FinePreviewer.open(db);
  const returns: SlipReturn[] = [];
  for (const id of i.returnedLoanIds) {
    const l = byId.get(id)!;
    const fine = fines.get(id);
    const late =
      l.returned_on === null
        ? { daysLate: 0, finedDays: null }
        : await fined.lateness(
            {
              branchId: l.branch_id,
              dueOn: l.due_on,
              finePerDayMinor: Number(l.fine_per_day_minor),
              fineCapMinor: l.fine_cap_minor === null ? null : Number(l.fine_cap_minor),
              graceDays: Number(l.grace_days),
            },
            l.returned_on,
          );
    returns.push({
      barcode: l.barcode_display ?? '',
      title: cut(l.title ?? ''),
      returnedOn: l.returned_on ?? '',
      daysLate: late.daysLate,
      finedDays: fine === undefined ? null : late.finedDays,
      fine: fine === undefined ? null : formatPrice(fine),
    });
  }
  return {
    library: { name: s['library.name'] as string, address: (s['library.address'] as string | null) ?? null },
    branchName: branch === undefined ? '' : `${branch.name} (${branch.code_display})`,
    member: member === undefined ? null : { memberNo: member.member_no_display, name: member.name },
    printedOn: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
    currency: s['catalog.currency'] as string,
    loans: i.loanIds.map((id) => {
      const l = byId.get(id)!;
      return { barcode: l.barcode_display ?? '', title: cut(l.title ?? ''), dueOn: l.due_on, renewed: Number(l.renewals) > 0 };
    }),
    returns,
    payments: payments.map((p) => ({ receiptNo: p.receipt_no, amount: formatPrice(Number(p.amount_minor)), method: p.method, voided: p.voided_at !== null })),
    locale: s['library.locale'] === 'en' ? 'en' : 'id',
    paper: i.paper ?? (String(s['circulation.receipt.paperMm']) === '58' ? '58' : '80'),
  };
}

/** The days late of a return as the desk says them (with the days its fine counted when they differ), and its fine. */
function slipLateText(d: SlipData, r: SlipReturn): string {
  if (r.daysLate === 0) return '-';
  const days = r.finedDays !== null && r.finedDays !== r.daysLate ? t(d.locale, 'slip.late_fined', { days: r.daysLate, fined: r.finedDays }) : String(r.daysLate);
  return r.fine === null ? days : `${days} · ${d.currency} ${r.fine}`;
}

/** The slip PDF of `d`: a 58 or 80 mm roll. */
export function buildSlipPdf(d: SlipData): Uint8Array {
  const tr = (key: Parameters<typeof t>[1], params?: Record<string, string | number>): string => t(d.locale, key, params);
  const narrow = d.paper === '58';
  const pdf = new PdfLayout({
    paper: narrow ? 'Roll58' : 'Roll80',
    orientation: 'portrait',
    marginsMm: { top: 4, right: 3, bottom: 4, left: 3 },
    title: tr('slip.title'),
    header: null,
    footer: () => '',
    nonLatinNote: tr('receipt.non_latin'),
  });
  const size = narrow ? 7 : 8;
  pdf.paragraph(d.library.name, { bold: true, align: 'center', size: narrow ? 9 : 10 });
  pdf.paragraph(tr('slip.title'), { bold: true, align: 'center', size: narrow ? 9 : 10 });
  pdf.keyValues([
    [tr('receipt.date'), `${d.printedOn} ${d.time}`],
    [tr('receipt.branch'), d.branchName],
    ...(d.member === null ? [] : ([[tr('receipt.member'), `${d.member.memberNo} ${d.member.name}`]] as [string, string][])),
  ]);
  if (d.loans.length > 0) {
    pdf.paragraph(tr('slip.loans'), { bold: true, size });
    pdf.table(
      [{ header: tr('slip.item'), weight: narrow ? 2 : 3 }, { header: tr('slip.due') }],
      d.loans.map((l) => [`${l.barcode} ${l.title}`, l.renewed ? `${l.dueOn} (${tr('slip.renewed')})` : l.dueOn]),
    );
  }
  if (d.returns.length > 0) {
    pdf.paragraph(tr('slip.returns'), { bold: true, size });
    pdf.table(
      [{ header: tr('slip.item'), weight: narrow ? 2 : 3 }, { header: tr('slip.late'), align: 'right' }],
      d.returns.map((r) => [`${r.barcode} ${r.title}`, slipLateText(d, r)]),
    );
  }
  if (d.payments.length > 0) {
    pdf.paragraph(tr('slip.payments'), { bold: true, size });
    pdf.table(
      [{ header: tr('receipt.number'), weight: 2 }, { header: d.currency, align: 'right' }],
      d.payments.map((p) => [`${p.receiptNo ?? '-'}${p.voided ? ` (${tr('receipt.voided')})` : ''}`, p.amount]),
    );
  }
  return pdf.toBytes();
}
