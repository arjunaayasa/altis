import { assertOutsideTx, countGrouped, withTx, type DB, type DbHandle } from '@altis/db';
import { DomainError, isDomainError, newId, t, type ClearancePurpose, type ClearanceRefusal, type Locale } from '@altis/shared';
import type { ClearanceCheckResponse, ClearanceCheckRow, ClearanceListQuery, ClearanceListResponse, ClearancePaper, ClearanceView } from '@altis/shared/api/circulation';
import type { ClearanceProfile } from '@altis/shared/api/settings';
import type { Selectable, Transaction } from 'kysely';
import { LOCK_FOREVER } from '../catalog/items/patterns.js';
import type { TxCtx } from '../context.js';
import { lockLiveMember, memberNotFound, memberValidationFailed, writeMemberEvents, type Db } from '../members/common.js';
import { PdfLayout, type PaperSize } from '../print/layout.js';
import { dateInWords } from '../reports/export/describe.js';
import { readSettings } from '../settings/service.js';
import { chargeSeam, holdSeam } from './seams.js';

// Numbered clearance letters (surat bebas pustaka): a letter that says a member has no open loan, no unpaid balance
// and no hold waiting on the hold shelf, for graduation or a move.
//
// - Numbering without gaps or repeats: the number is `<prefix>/<year>/<seq, 4 digits>`, `seq` the next of the library's
//   year (the highest of that year + 1, read under a lock; no counter table). The lock is the `locks` row
//   `members.clearance:<year>`, made beforehand outside the transaction (ensureClearanceLockRow, LOCK_FOREVER, like the
//   barcode patterns' rows) and taken by an UPDATE as the transaction's first statement, so two desks numbering at once
//   wait for each other, and the snapshot of MySQL/MariaDB starts after the lock. A unique violation that still happens
//   on (year, seq) is TX_CONFLICT. A voided letter keeps its number; a reprint never makes a new one.
// - The members are locked next (each live member's row, by id order), and only then are their open loans, balances
//   (charges module) and ready holds (holds module) read; a member that fails gets no letter and is listed with the
//   reasons, the others get theirs in the order sent.
// - The PDF (buildClearancePdf) is one letter per page on A4 or A5, or on a 58 or 80 mm receipt roll, in the library's
//   language: the library's name and address, the number, the member (name, number, class, institution), the statement,
//   the place and date, and the signature block of the letter profile (`members.clearance.profile`); then a page of the
//   members refused. Built outside any transaction.

/** `locks.owner` of the clearance lock rows (never claimed). */
const LOCK_OWNER = 'members.clearance';

/** The name of the lock row of the clearance numbers of `year`. */
export function clearanceLockName(year: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new TypeError(`clearance year ${String(year)} is not a year`);
  return `members.clearance:${year}`;
}

/**
 * Makes sure the lock row of the clearance numbers of `year` exists with `until = LOCK_FOREVER`, in a short transaction
 * of its own outside any other (the issuing route, before its transaction). A unique violation means another request
 * made it first.
 *
 * @throws TypeError inside a withTx callback
 */
export async function ensureClearanceLockRow(h: DbHandle, year: number): Promise<void> {
  assertOutsideTx('ensureClearanceLockRow');
  const name = clearanceLockName(year);
  try {
    await withTx(h, async (trx) => {
      const row = await trx.selectFrom('locks').select('until').where('name', '=', name).executeTakeFirst();
      if (row === undefined) await trx.insertInto('locks').values({ name, owner: LOCK_OWNER, until: LOCK_FOREVER }).execute();
      else if (Number(row.until) !== LOCK_FOREVER) await trx.updateTable('locks').set({ until: LOCK_FOREVER }).where('name', '=', name).execute();
    });
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') return;
    throw error;
  }
}

/** The display number of letter `seq` of `year`. */
export function clearanceNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}/${year}/${String(seq).padStart(4, '0')}`;
}

/** What each of `memberIds` would be refused for now (empty: none), read through `db` (after the locks, in a write). */
async function refusalsOf(db: Db, memberIds: readonly string[]): Promise<Map<string, ClearanceRefusal[]>> {
  const out = new Map<string, ClearanceRefusal[]>(memberIds.map((id) => [id, []]));
  if (memberIds.length === 0) return out;
  const open = await countGrouped(db.selectFrom('loans').where('member_id', 'in', [...memberIds]).where('open_item_id', 'is not', null), { m: 'member_id' });
  for (const row of open) if (row.count > 0) out.get(String(row.m))?.push('open_loans');
  for (const [id, balance] of await chargeSeam().balances(db, memberIds)) if (balance > 0) out.get(id)?.push('balance');
  for (const id of await holdSeam().membersWithReadyHolds(db, memberIds)) out.get(id)?.push('ready_hold');
  return out;
}

/** The live members among `memberIds`, by id. */
async function liveMembers(db: Db, memberIds: readonly string[]): Promise<Map<string, Selectable<DB['members']>>> {
  if (memberIds.length === 0) return new Map();
  const rows = await db.selectFrom('members').selectAll().where('id', 'in', [...memberIds]).where('archived_at', 'is', null).where('anonymized_at', 'is', null).execute();
  return new Map(rows.map((r) => [r.id, r]));
}

/** The field error of the ids among `memberIds` that name no live member. */
function unknownMembers(memberIds: readonly string[], live: ReadonlyMap<string, unknown>): DomainError | null {
  const errors = memberIds.flatMap((id, i) => (live.has(id) ? [] : [{ path: `memberIds.${i}`, code: 'not_found' }]));
  return errors.length === 0 ? null : memberValidationFailed(errors);
}

/**
 * Who of `memberIds` may get a letter now, in the order sent.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'memberIds.<i>', code: 'not_found'}`
 */
export async function checkClearances(db: Db, memberIds: readonly string[]): Promise<ClearanceCheckResponse> {
  const live = await liveMembers(db, memberIds);
  const unknown = unknownMembers(memberIds, live);
  if (unknown !== null) throw unknown;
  const refusals = await refusalsOf(db, memberIds);
  const items: ClearanceCheckRow[] = memberIds.map((id) => {
    const m = live.get(id)!;
    return { memberId: id, memberNo: m.member_no_display, name: m.name, className: m.class_name, refusals: refusals.get(id) ?? [] };
  });
  return { items };
}

/** One letter to print. */
export interface ClearanceLetter {
  id: string;
  number: string;
  issuedOn: string;
  purpose: ClearancePurpose;
  memberNo: string;
  name: string;
  className: string | null;
  institution: string | null;
  voided: boolean;
}

/** What issueClearances answers: the letters made, in the order sent, and the members refused. */
export interface ClearanceIssue {
  letters: ClearanceLetter[];
  refused: ClearanceCheckRow[];
}

/**
 * Issues the next numbered letters of the library's year of `issuedOn` to the members of `memberIds` who pass the
 * check (see the top of this file), writes a `clearance` history row for each and audits `members.clearance.issue`
 * once (`meta {count, refused}`). The lock row of the year must exist (ensureClearanceLockRow).
 *
 * @throws DomainError VALIDATION_FAILED (`memberIds.<i>`: `not_found`); TX_CONFLICT (a number taken meanwhile)
 * @throws TypeError when the year's lock row is absent
 */
export async function issueClearances(tx: TxCtx, input: { memberIds: readonly string[]; purpose: ClearancePurpose; issuedOn: string }): Promise<ClearanceIssue> {
  const { trx } = tx;
  const year = Number(input.issuedOn.slice(0, 4));
  const name = clearanceLockName(year);
  const lock = await trx.updateTable('locks').set({ until: LOCK_FOREVER }).where('name', '=', name).executeTakeFirst();
  // MySQL/MariaDB report matched rows, not only changed ones: mysql2 connects with CLIENT_FOUND_ROWS.
  if (Number(lock.numUpdatedRows) !== 1) throw new TypeError(`issueClearances(): the lock row ${name} is absent; call ensureClearanceLockRow() first`);
  for (const id of [...new Set(input.memberIds)].sort()) await lockLiveMember(trx, id);

  const live = await liveMembers(trx, input.memberIds);
  const unknown = unknownMembers(input.memberIds, live);
  if (unknown !== null) throw unknown;
  const refusals = await refusalsOf(trx, input.memberIds);
  const prefix = (await readSettings(trx, ['members.clearance.prefix'], []))['members.clearance.prefix'] as string;
  const top = await trx.selectFrom('member_clearances').select('seq').where('year', '=', year).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  let seq = top === undefined ? 0 : Number(top.seq);

  const letters: ClearanceLetter[] = [];
  const refused: ClearanceCheckRow[] = [];
  for (const memberId of input.memberIds) {
    const m = live.get(memberId)!;
    const reasons = refusals.get(memberId) ?? [];
    if (reasons.length > 0) {
      refused.push({ memberId, memberNo: m.member_no_display, name: m.name, className: m.class_name, refusals: reasons });
      continue;
    }
    seq += 1;
    const id = newId(tx.now);
    const number = clearanceNumber(prefix, year, seq);
    try {
      await trx
        .insertInto('member_clearances')
        .values({
          id,
          member_id: memberId,
          year,
          seq,
          number_display: number,
          issued_on: input.issuedOn,
          issued_at: tx.now,
          issued_by: tx.actor.id ?? '',
          purpose: input.purpose,
          voided_at: null,
          voided_by: null,
          void_reason: null,
        })
        .execute();
    } catch (error) {
      if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') {
        throw new DomainError('TX_CONFLICT', { detail: 'Nomor surat baru saja dipakai; coba lagi / The letter number was just taken; try again' });
      }
      throw error;
    }
    await writeMemberEvents(tx, memberId, [{ type: 'clearance', meta: { purpose: input.purpose, year, seq } }]);
    letters.push({
      id,
      number,
      issuedOn: input.issuedOn,
      purpose: input.purpose,
      memberNo: m.member_no_display,
      name: m.name,
      className: m.class_name,
      institution: m.institution,
      voided: false,
    });
  }
  await tx.audit({ action: 'members.clearance.issue', entity: 'member_clearances', entityId: null, meta: { count: letters.length, refused: refused.length } });
  return { letters, refused };
}

function clearanceNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Surat bebas pustaka tidak ditemukan / Clearance letter not found' });
}

/**
 * The letter `clearanceId` of the member `memberId`, to print again (same number; a voided one says so).
 *
 * @throws DomainError NOT_FOUND
 */
export async function clearanceLetter(db: Db, memberId: string, clearanceId: string): Promise<ClearanceLetter> {
  const row = await db
    .selectFrom('member_clearances as c')
    .innerJoin('members as m', 'm.id', 'c.member_id')
    .select(['c.id', 'c.number_display', 'c.issued_on', 'c.purpose', 'c.voided_at', 'm.member_no_display', 'm.name', 'm.class_name', 'm.institution', 'm.anonymized_at'])
    .where('c.id', '=', clearanceId)
    .where('c.member_id', '=', memberId)
    .executeTakeFirst();
  if (row === undefined || row.anonymized_at !== null) throw clearanceNotFound();
  return {
    id: row.id,
    number: row.number_display,
    issuedOn: row.issued_on,
    purpose: row.purpose as ClearancePurpose,
    memberNo: row.member_no_display,
    name: row.name,
    className: row.class_name,
    institution: row.institution,
    voided: row.voided_at !== null,
  };
}

/**
 * Voids the letter `clearanceId` of the member `memberId` (its number is never used again) and audits
 * `members.clearance.void`. One voided already is answered as it is (`meta.alreadyVoided`).
 *
 * @throws DomainError NOT_FOUND
 */
export async function voidClearance(tx: TxCtx, input: { memberId: string; clearanceId: string; reason: string }): Promise<{ id: string }> {
  const { trx } = tx;
  await trx
    .updateTable('members')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', input.memberId)
    .execute();
  const row = await trx.selectFrom('member_clearances').select(['id', 'voided_at']).where('id', '=', input.clearanceId).where('member_id', '=', input.memberId).executeTakeFirst();
  if (row === undefined) throw clearanceNotFound();
  if (row.voided_at !== null) {
    await tx.audit({ action: 'members.clearance.void', entity: 'member_clearances', entityId: row.id, meta: { alreadyVoided: true } });
    return { id: row.id };
  }
  await trx
    .updateTable('member_clearances')
    .set({ voided_at: tx.now, voided_by: tx.actor.id, void_reason: input.reason })
    .where('id', '=', row.id)
    .where('voided_at', 'is', null)
    .execute();
  await tx.audit({ action: 'members.clearance.void', entity: 'member_clearances', entityId: row.id, meta: {} });
  return { id: row.id };
}

/**
 * The letters, the highest number first (year, then sequence), a page at a time (cursor `<year>.<seq>`).
 *
 * @throws DomainError VALIDATION_FAILED (`cursor`, `invalid`)
 */
export async function listClearances(db: Db, q: ClearanceListQuery): Promise<ClearanceListResponse> {
  let query = db
    .selectFrom('member_clearances as c')
    .leftJoin('members as m', 'm.id', 'c.member_id')
    .select(['c.id', 'c.member_id', 'c.year', 'c.seq', 'c.number_display', 'c.issued_on', 'c.purpose', 'c.voided_at', 'm.member_no_display', 'm.name', 'm.class_name', 'm.anonymized_at']);
  if (q.memberId !== undefined) query = query.where('c.member_id', '=', q.memberId);
  if (q.year !== undefined) query = query.where('c.year', '=', q.year);
  if (q.cursor !== undefined) {
    const m = /^(\d{4})\.(\d{1,9})$/.exec(q.cursor);
    if (m === null) throw memberValidationFailed([{ path: 'cursor', code: 'invalid' }]);
    const [year, seq] = [Number(m[1]), Number(m[2])];
    query = query.where((eb) => eb.or([eb('c.year', '<', year), eb.and([eb('c.year', '=', year), eb('c.seq', '<', seq)])]));
  }
  const rows = await query.orderBy('c.year', 'desc').orderBy('c.seq', 'desc').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const items: ClearanceView[] = page.map((r) => {
    const shown = r.anonymized_at === null;
    return {
      id: r.id,
      memberId: r.member_id,
      memberNo: shown ? r.member_no_display : null,
      name: shown ? r.name : null,
      className: shown ? r.class_name : null,
      year: Number(r.year),
      seq: Number(r.seq),
      number: r.number_display,
      issuedOn: r.issued_on,
      purpose: r.purpose as ClearancePurpose,
      voided: r.voided_at !== null,
    };
  });
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > q.limit && last !== undefined ? `${Number(last.year)}.${Number(last.seq)}` : null };
}

/** That the member `memberId` is live (the routes under `members/:id`). @throws DomainError NOT_FOUND */
export async function assertLiveMember(db: Db | Transaction<DB>, memberId: string): Promise<void> {
  const m = await db.selectFrom('members').select(['archived_at', 'anonymized_at']).where('id', '=', memberId).executeTakeFirst();
  if (m === undefined || m.anonymized_at !== null) throw memberNotFound();
}

// ---- the PDF -------------------------------------------------------------------------------------------------------------

const PAPER: Record<ClearancePaper, PaperSize> = { A4: 'A4', A5: 'A5', '58': 'R58', '80': 'R80' };

/** The margins of a paper, in millimetres: a sheet has room, a receipt roll almost none. */
function marginsOf(paper: ClearancePaper): { top: number; right: number; bottom: number; left: number } {
  if (paper === '58' || paper === '80') return { top: 4, right: 3, bottom: 4, left: 3 };
  if (paper === 'A5') return { top: 12, right: 12, bottom: 12, left: 12 };
  return { top: 20, right: 20, bottom: 20, left: 20 };
}

/** What a clearance PDF prints besides the letters. */
export interface ClearancePdfInput {
  letters: readonly ClearanceLetter[];
  refused: readonly ClearanceCheckRow[];
  paper: ClearancePaper;
  profile: ClearanceProfile;
  library: { name: string; address: string | null };
  locale: Locale;
}

/** The clearance letters as a PDF (see the top of this file). Pure apart from node:zlib. */
export function buildClearancePdf(i: ClearancePdfInput): Uint8Array {
  const tr = (key: Parameters<typeof t>[1], params?: Record<string, string>): string => t(i.locale, key, params);
  const pdf = new PdfLayout({
    paper: PAPER[i.paper],
    orientation: 'portrait',
    marginsMm: marginsOf(i.paper),
    title: tr('clearance.letter.title'),
    header: null,
    footer: () => '',
    nonLatinNote: tr('clearance.letter.non_latin'),
  });
  const roll = i.paper === '58' || i.paper === '80';
  for (const letter of i.letters) {
    pdf.pageBreak();
    pdf.paragraph(i.library.name, { bold: true, align: 'center', size: roll ? 10 : 14 });
    if (i.library.address !== null && i.library.address.trim() !== '') pdf.paragraph(i.library.address, { align: 'center', size: roll ? 8 : 9 });
    pdf.paragraph(tr('clearance.letter.title'), { bold: true, align: 'center', size: roll ? 10 : 13 });
    pdf.paragraph(tr('clearance.letter.number', { number: letter.number }), { align: 'center' });
    if (letter.voided) pdf.paragraph(tr('clearance.letter.voided'), { bold: true, align: 'center' });
    pdf.paragraph(tr('clearance.letter.opening'));
    const rows: [string, string][] = [
      [tr('clearance.letter.name'), letter.name],
      [tr('clearance.letter.member_no'), letter.memberNo],
    ];
    if (letter.className !== null) rows.push([tr('clearance.letter.class'), letter.className]);
    if (letter.institution !== null) rows.push([tr('clearance.letter.institution'), letter.institution]);
    pdf.keyValues(rows);
    const body = i.profile.bodyText.trim();
    pdf.paragraph(body === '' ? tr('clearance.letter.statement', { library: i.library.name }) : body);
    pdf.paragraph(tr('clearance.letter.purpose', { purpose: t(i.locale, `vocab.clearance_purpose.${letter.purpose}`) }));
    pdf.signatureBlocks([
      {
        ...(i.profile.city === '' ? {} : { place: i.profile.city }),
        date: dateInWords(i.locale, letter.issuedOn),
        role: i.profile.signerTitle === '' ? ' ' : i.profile.signerTitle,
        ...(i.profile.signerName === '' ? {} : { name: i.profile.signerName }),
        ...(i.profile.signerId === '' ? {} : { idLine: i.profile.signerId }),
        stamp: !roll,
      },
    ]);
  }
  if (i.refused.length > 0) {
    pdf.pageBreak();
    pdf.heading(tr('clearance.letter.refused_title'), 2);
    pdf.table(
      [{ header: tr('clearance.letter.col_member_no') }, { header: tr('clearance.letter.col_name'), weight: 2 }, { header: tr('clearance.letter.col_reason'), weight: 2 }],
      i.refused.map((r) => [r.memberNo, r.name, r.refusals.map((x) => t(i.locale, `vocab.clearance_refusal.${x}`)).join('; ')]),
    );
  }
  return pdf.toBytes();
}
