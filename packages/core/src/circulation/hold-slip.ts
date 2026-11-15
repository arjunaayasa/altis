import { DomainError, t, type Locale } from '@altis/shared';
import type { ReceiptPaper } from '@altis/shared/api/charges';
import type { Db } from '../members/common.js';
import { PdfLayout } from '../print/layout.js';
import { readSettings } from '../settings/service.js';

// The hold shelf slip: the paper put in a copy kept on the hold shelf for a member (a return that kept it, or "mark
// ready" at the shelf). A 58 or 80 mm roll like the receipts and the transaction slip (`circulation.receipt.paperMm`
// unless the request names one), the page cut to its content, in the library's language: the member number large (the
// shelf is sorted by it), the member's name, the pickup deadline, the copy's barcode and the title. Only a hold that
// is ready at the branch in the path has a slip; any other is 404, as one that does not exist. Nothing is written.

/** What a hold shelf slip prints. */
export interface HoldSlipData {
  library: { name: string };
  branchName: string;
  memberNo: string;
  memberName: string;
  pickupUntil: string;
  barcode: string;
  title: string;
  locale: Locale;
  paper: ReceiptPaper;
}

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Reservasi siap diambil tidak ditemukan di cabang ini / No hold ready for pickup at this branch' });
}

/**
 * The slip of the hold `holdId`, ready for pickup at the branch `branchId` (`paper` default
 * `circulation.receipt.paperMm`).
 *
 * @throws DomainError NOT_FOUND (no such hold ready at this branch)
 */
export async function holdSlipData(db: Db, i: { branchId: string; holdId: string; paper?: ReceiptPaper }): Promise<HoldSlipData> {
  const hold = await db
    .selectFrom('holds as h')
    .innerJoin('members as m', 'm.id', 'h.member_id')
    .leftJoin('items as it', 'it.id', 'h.trap_item_id')
    .leftJoin('records as r', 'r.id', 'h.record_id')
    .select(['h.pickup_branch_id', 'h.status', 'h.pickup_until', 'm.member_no_display', 'm.name', 'it.barcode_display', 'r.title'])
    .where('h.id', '=', i.holdId)
    .executeTakeFirst();
  if (hold === undefined || hold.pickup_branch_id !== i.branchId || hold.status !== 'ready') throw notFound();
  const s = await readSettings(db, ['library.name', 'library.locale', 'circulation.receipt.paperMm'], []);
  const branch = await db.selectFrom('branches').select(['name', 'code_display']).where('id', '=', i.branchId).executeTakeFirst();
  return {
    library: { name: s['library.name'] as string },
    branchName: branch === undefined ? '' : `${branch.name} (${branch.code_display})`,
    memberNo: hold.member_no_display,
    memberName: hold.name,
    pickupUntil: hold.pickup_until ?? '',
    barcode: hold.barcode_display ?? '',
    title: hold.title ?? '',
    locale: s['library.locale'] === 'en' ? 'en' : 'id',
    paper: i.paper ?? (String(s['circulation.receipt.paperMm']) === '58' ? '58' : '80'),
  };
}

/** The hold shelf slip PDF of `d`: one page of a 58 or 80 mm roll, as long as its content. */
export function buildHoldSlipPdf(d: HoldSlipData): Uint8Array {
  const tr = (key: Parameters<typeof t>[1]): string => t(d.locale, key);
  const narrow = d.paper === '58';
  const pdf = new PdfLayout({
    paper: narrow ? 'Roll58' : 'Roll80',
    orientation: 'portrait',
    marginsMm: { top: 4, right: 3, bottom: 4, left: 3 },
    title: tr('hold_slip.title'),
    header: null,
    footer: () => '',
    nonLatinNote: tr('receipt.non_latin'),
  });
  pdf.paragraph(d.library.name, { bold: true, align: 'center', size: narrow ? 9 : 10 });
  pdf.paragraph(tr('hold_slip.title'), { bold: true, align: 'center', size: narrow ? 9 : 10 });
  pdf.paragraph(d.memberNo, { bold: true, align: 'center', size: narrow ? 16 : 20 });
  pdf.keyValues([
    [tr('hold_slip.for'), d.memberName],
    [tr('hold_slip.until'), d.pickupUntil],
    [tr('hold_slip.item'), d.barcode],
    [tr('receipt.branch'), d.branchName],
  ]);
  pdf.paragraph(d.title, { size: narrow ? 7 : 8 });
  return pdf.toBytes();
}
