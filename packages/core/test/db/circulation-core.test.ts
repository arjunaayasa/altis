import { addDays } from '@altis/shared';
import type { MemberBody } from '@altis/shared/api/members';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  archiveCalendarRule,
  changeLoanDue,
  checkClearances,
  createCalendarRule,
  createMember,
  createPolicy,
  ensureClearanceLockRow,
  explainPolicy,
  issueClearances,
  lendItem,
  listCalendar,
  listClearances,
  markLoanLost,
  recordInLibraryUse,
  registerCirculationChargeSeam,
  renewLoan,
  returnItem,
  voidClearance,
  voidLoan,
  type CirculationChargeSeam,
  type LendInput,
} from '../../src/index.js';
import { DAY, NOW, STAFF, failure, fieldErrors, itemEvents, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// The circulation core on the engine picked by ALTIS_TEST_DB: the rule matrix (most specific rule, the dimension order,
// a rule that forbids the loan and forcing it, limits counted per stored rule, the "which rule applies" tool), the
// library calendar in due dates, backdated loans, voiding the last loan, a loan declared lost and its item coming back,
// a due date changed by hand, reading in place, and clearance letters numbered without gaps or repeats.

const ctx = testDbContext();

/** NOW in Jakarta: a Wednesday. */
const TODAY = '2026-09-02';

describe.skipIf(!ctx.available)(`the circulation core [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let siswa: string;
  let guru: string;
  let buku: string;

  let seq = 0;
  /** A new member, of type GURU (no rule of its own: the general rule's 7 days) unless `o` says otherwise. */
  async function member(o: Partial<MemberBody> = {}): Promise<string> {
    seq += 1;
    const body = { memberNo: `CC-${seq}`, memberTypeId: guru, name: `Anggota ${seq}`, ...o } as MemberBody;
    return (await db.run((tx) => createMember(tx, body))).id;
  }
  async function item(o: { collectionTypeCode?: string; status?: string } = {}): Promise<{ barcode: string; recordId: string; id: string }> {
    seq += 1;
    const recordId = await seedRecord(db, { title: `Buku ${seq}` });
    const barcode = `CC-B-${seq}`;
    const id = await seedItem(db, recordId, { barcode, ...o });
    return { barcode, recordId, id };
  }
  const lend = (memberId: string, barcode: string, o: Partial<LendInput> = {}, now = NOW) =>
    db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId, barcode, ...o }), now);
  const loanRow = (id: string) => db.h.db.selectFrom('loans').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const closed = async (o: { kind: 'weekly' | 'dates' | 'yearly'; weekday?: number; dateFrom?: string; dateTo?: string; monthDayFrom?: string; monthDayTo?: string }) =>
    (await db.run((tx) => createCalendarRule(tx, { name: 'Tutup', ...o }))).id;
  const reopen = (id: string) => db.run((tx) => archiveCalendarRule(tx, id, 0));

  beforeAll(async () => {
    db = await openItemsDb('circ-core');
    siswa = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    guru = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'GURU').executeTakeFirstOrThrow()).id;
    buku = (await db.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  });
  afterAll(async () => {
    await db?.close();
  });
  afterEach(() => registerCirculationChargeSeam(null));

  it('the rule matrix: the most specific rule wins, a tie goes to the earlier dimension, a scope is taken once', async () => {
    const fiksi = await db.collectionTypeId('FIKSI');
    const byType = await db.run((tx) => createPolicy(tx, { code: 'M-SISWA', name: 'Siswa', memberTypeId: siswa, loanDays: 5, loanLimit: null } as never));
    const byCollection = await db.run((tx) =>
      createPolicy(tx, { code: 'C-FIKSI', name: 'Fiksi', memberTypeId: null, collectionTypeId: fiksi, loanDays: 3, loanLimit: null } as never),
    );
    const both = await db.run((tx) =>
      createPolicy(tx, { code: 'MC', name: 'Siswa fiksi', memberTypeId: siswa, collectionTypeId: fiksi, loanDays: 10, loanLimit: null, finePerDay: '500', fineCap: '5000.50', graceDays: 2 } as never),
    );
    expect(await fieldErrors(db.run((tx) => createPolicy(tx, { code: 'MC-2', name: 'Lagi', memberTypeId: siswa, collectionTypeId: fiksi, loanDays: 1, loanLimit: null } as never)))).toEqual([
      { path: 'scope', code: 'taken' },
    ]);
    const reader = await member({ memberTypeId: siswa });
    // A pupil and a novel: the rule naming both; a pupil and a general book: the member type's rule.
    const novel = await lend(reader, (await item({ collectionTypeCode: 'FIKSI' })).barcode);
    expect(novel.dueOn).toBe(addDays(TODAY, 10));
    expect(await loanRow(novel.id)).toMatchObject({ policy_id: both.id, fine_per_day_minor: 50_000, fine_cap_minor: 500_050, grace_days: 2 });
    expect((await lend(reader, (await item()).barcode)).dueOn).toBe(addDays(TODAY, 5));

    const explained = await explainPolicy(db.h.db, { memberTypeId: siswa, collectionTypeId: fiksi, materialTypeId: buku });
    expect(explained.winner?.id).toBe(both.id);
    expect(explained.candidates.map((c) => [c.policy.code, c.rank, c.reason])).toEqual([
      ['MC', 1, 'more_specific'],
      ['M-SISWA', 2, 'less_specific'],
      ['C-FIKSI', 3, 'later_dimension'],
      ['DEFAULT', 4, 'less_specific'],
    ]);
    expect((await explainPolicy(db.h.db, { collectionTypeId: fiksi })).candidates.map((c) => [c.policy.id, c.reason])).toEqual([
      [byCollection.id, 'more_specific'],
      [expect.any(String), 'less_specific'],
    ]);
    expect(byType.id).toBeTruthy();
  });

  it('a rule that forbids the loan is forced with its reason and a note; a limit counts the loans made under the stored rule', async () => {
    const ref = await db.collectionTypeId('REF');
    await db.h.db.updateTable('collection_types').set({ loanable: 1 }).where('id', '=', ref).execute();
    const rule = await db.run((tx) =>
      createPolicy(tx, { code: 'REF-NO', name: 'Referensi', memberTypeId: null, collectionTypeId: ref, loanable: false, loanDays: 0, loanLimit: 1 } as never),
    );
    const reader = await member();
    const atlas = await item({ collectionTypeCode: 'REF' });
    expect(await failure(lend(reader, atlas.barcode))).toMatchObject({ code: 'CIRC_NOT_LOANABLE', meta: { reason: 'policy' } });
    const forced = await lend(reader, atlas.barcode, { override: { reasons: ['policy', 'limit'], note: 'Untuk lomba' } });
    // Forced with the rule's own terms: 0 days is due the same day. Only the reason that occurred is recorded.
    expect([forced.dueOn, forced.overrides]).toEqual([TODAY, ['policy']]);
    expect(await loanRow(forced.id)).toMatchObject({ overrides: 'policy', override_note: 'Untuk lomba', policy_id: rule.id });
    // The rule's limit of 1 is reached by that loan: the next one is refused, or forced as `limit`.
    const second = await item({ collectionTypeCode: 'REF' });
    expect(await failure(lend(reader, second.barcode, { override: { reasons: ['policy'], note: 'x' } }))).toMatchObject({
      code: 'CIRC_LIMIT_REACHED',
      meta: { scope: 'policy', limit: 1 },
    });
    const both = await lend(reader, second.barcode, { override: { reasons: ['policy', 'limit'], note: 'Lomba' } });
    expect(both.overrides).toEqual(['policy', 'limit']);
    await db.h.db.updateTable('collection_types').set({ loanable: 0 }).where('id', '=', ref).execute();
  });

  it('due dates skip closed days, are cut at the expiry and step back to an open day; a closed year is CIRC_CALENDAR_CLOSED', async () => {
    const reader = await member();
    // 7 days after Wednesday 2 September is Wednesday 9 September: closed weekly, and 10 September closed by a range.
    const wednesday = await closed({ kind: 'weekly', weekday: 3 });
    const range = await closed({ kind: 'dates', dateFrom: '2026-09-10', dateTo: '2026-09-10' });
    const yearly = await closed({ kind: 'yearly', monthDayFrom: '09-11', monthDayTo: '09-11' });
    const moved = await lend(reader, (await item()).barcode);
    expect([moved.dueOn, moved.warnings]).toEqual(['2026-09-12', [{ code: 'due_moved_closed' }]]);
    expect((await listCalendar(db.h.db, { from: '2026-09-08', to: '2026-09-12' })).closed).toEqual(['2026-09-09', '2026-09-10', '2026-09-11']);

    // A membership ending on the 10th: cut there, then back past the closed 10th and 9th to the 8th.
    const short = await member({ joinedOn: '2025-09-11', expiresOn: '2026-09-10' });
    const capped = await lend(short, (await item()).barcode);
    expect(capped.dueOn).toBe('2026-09-08');
    expect(capped.warnings?.map((w) => w.code)).toContain('due_capped_by_expiry');

    // A renewal moves the same way.
    const renewed = await db.run((tx) => renewLoan(tx, { branchId: db.branchId, loanId: moved.id }), NOW + DAY);
    expect(renewed.dueOn).toBe('2026-09-12');
    for (const id of [wednesday, range, yearly]) await reopen(id);

    // More than a year of closed days after the due date.
    const year = await closed({ kind: 'dates', dateFrom: '2026-09-09', dateTo: '2027-09-09' });
    const more = await closed({ kind: 'dates', dateFrom: '2027-09-10', dateTo: '2027-12-31' });
    expect(await failure(lend(reader, (await item()).barcode))).toMatchObject({ code: 'CIRC_CALENDAR_CLOSED' });
    await reopen(year);
    await reopen(more);

    // At most six closed weekdays; a range of at most 366 days; yearly days within one year.
    const six = [];
    for (let day = 1; day <= 6; day++) six.push(await closed({ kind: 'weekly', weekday: day }));
    expect(await fieldErrors(closed({ kind: 'weekly', weekday: 7 }))).toEqual([{ path: 'weekday', code: 'too_many_closed' }]);
    for (const id of six) await reopen(id);
    expect(await fieldErrors(closed({ kind: 'dates', dateFrom: '2026-01-01', dateTo: '2027-01-02' }))).toEqual([{ path: 'dateTo', code: 'range_too_long' }]);
    expect(await fieldErrors(closed({ kind: 'yearly', monthDayFrom: '12-30', monthDayTo: '01-02' }))).toEqual([{ path: 'monthDayTo', code: 'crosses_year' }]);
    expect(await fieldErrors(closed({ kind: 'weekly', weekday: 1, dateFrom: '2026-01-01' }))).toEqual([{ path: 'dateFrom', code: 'not_allowed' }]);
  });

  it('a backdated loan counts from its own day, records `backdated` and needs a note; at most 30 days back', async () => {
    const reader = await member();
    const book = await item();
    expect(await fieldErrors(lend(reader, book.barcode, { loanedOn: addDays(TODAY, -3) }))).toEqual([{ path: 'override.note', code: 'required' }]);
    expect(await fieldErrors(lend(reader, book.barcode, { loanedOn: addDays(TODAY, -31), override: { reasons: [], note: 'x' } }))).toEqual([
      { path: 'loanedOn', code: 'backdate_out_of_range' },
    ]);
    expect(await fieldErrors(lend(reader, book.barcode, { loanedOn: addDays(TODAY, 1), override: { reasons: [], note: 'x' } }))).toEqual([
      { path: 'loanedOn', code: 'backdate_out_of_range' },
    ]);
    const loan = await lend(reader, book.barcode, { loanedOn: addDays(TODAY, -3), override: { reasons: [], note: 'Listrik padam' } });
    expect([loan.dueOn, loan.overrides]).toEqual([addDays(TODAY, 4), ['backdated']]);
    expect(await loanRow(loan.id)).toMatchObject({ loaned_on: addDays(TODAY, -3), overrides: 'backdated', override_note: 'Listrik padam' });
    const audit = await db.h.db.selectFrom('audit_log').select('meta').where('entity_id', '=', loan.id).executeTakeFirstOrThrow();
    expect(JSON.parse(audit.meta)).toMatchObject({ overrides: ['backdated'], backdated: true });
  });

  it('voiding the last loan: within the window, unrenewed, uncharged, by its own staff (or with the override)', async () => {
    const reader = await member();
    const book = await item();
    const loan = await lend(reader, book.barcode);
    const voided = await db.run((tx) => voidLoan(tx, { branchId: db.branchId, loanId: loan.id, mayOverride: false }), NOW + 60_000);
    expect(voided.id).toBe(loan.id);
    expect(await loanRow(loan.id)).toMatchObject({ outcome: 'voided', open_item_id: null, returned_by: STAFF });
    expect(await failure(db.run((tx) => voidLoan(tx, { branchId: db.branchId, loanId: loan.id, mayOverride: false })))).toMatchObject({ code: 'CIRC_LOAN_NOT_OPEN' });

    const late = await lend(reader, book.barcode);
    expect(await failure(db.run((tx) => voidLoan(tx, { branchId: db.branchId, loanId: late.id, mayOverride: false }), NOW + 11 * 60_000))).toMatchObject({
      code: 'CIRC_VOID_REFUSED',
      meta: { reason: 'too_late' },
    });
    expect(await failure(db.run((tx) => voidLoan(tx, { branchId: db.otherBranchId, loanId: late.id, mayOverride: true })))).toMatchObject({ code: 'NOT_FOUND' });
    await db.h.db.updateTable('loans').set({ loaned_by: null }).where('id', '=', late.id).execute();
    expect(await failure(db.run((tx) => voidLoan(tx, { branchId: db.branchId, loanId: late.id, mayOverride: false })))).toMatchObject({
      code: 'CIRC_VOID_REFUSED',
      meta: { reason: 'other_staff' },
    });
    registerCirculationChargeSeam({ ...noCharges(), loanHasCharges: async () => true });
    expect(await failure(db.run((tx) => voidLoan(tx, { branchId: db.branchId, loanId: late.id, mayOverride: true })))).toMatchObject({
      code: 'CIRC_VOID_REFUSED',
      meta: { reason: 'charged' },
    });
    registerCirculationChargeSeam(null);
    await db.run((tx) => voidLoan(tx, { branchId: db.branchId, loanId: late.id, mayOverride: true }));
    const renewed = await lend(reader, book.barcode);
    await db.run((tx) => renewLoan(tx, { branchId: db.branchId, loanId: renewed.id }), NOW + DAY);
    expect(await failure(db.run((tx) => voidLoan(tx, { branchId: db.branchId, loanId: renewed.id, mayOverride: true }), NOW + DAY))).toMatchObject({
      code: 'CIRC_VOID_REFUSED',
      meta: { reason: 'renewed' },
    });
  });

  it('a loan declared lost: the replacement charge is asked, the loan closes, the item becomes lost; back at the desk it is available again', async () => {
    const calls: string[] = [];
    registerCirculationChargeSeam({
      ...noCharges(),
      bookOverdue: async (_tx, i) => void calls.push(`overdue:${i.until}`),
      bookLost: async (_tx, i) => void calls.push(`lost:${i.replacementMinor}:${i.processingFeeMinor}`),
      cancelLost: async (_tx, i) => void calls.push(`cancel:${i.reason}`),
    });
    const reader = await member();
    const book = await item();
    const loan = await lend(reader, book.barcode);
    const later = NOW + 20 * DAY;
    expect(await fieldErrors(db.run((tx) => markLoanLost(tx, { branchId: db.branchId, loanId: loan.id }), later))).toEqual([{ path: 'replacement', code: 'required' }]);
    await db.h.db.updateTable('items').set({ price: 8_500_000, currency: 'IDR' }).where('id', '=', book.id).execute();
    const lost = await db.run((tx) => markLoanLost(tx, { branchId: db.branchId, loanId: loan.id }), later);
    expect(lost).toMatchObject({ itemStatus: 'lost', replacement: '85000.00', currency: 'IDR', charged: true });
    expect(calls).toEqual([`overdue:${addDays(TODAY, 20)}`, 'lost:8500000:0']);
    expect(await loanRow(loan.id)).toMatchObject({ outcome: 'lost', open_item_id: null, returned_on: addDays(TODAY, 20) });
    expect((await itemEvents(db, book.id)).at(-1)).toMatchObject({ type: 'status', from_status: 'available', to_status: 'lost' });

    const giveBack = (foundLost: boolean) => db.run((tx) => returnItem(tx, { branchId: db.branchId, barcode: book.barcode, foundLost }), later + DAY);
    expect(await failure(giveBack(false))).toMatchObject({ code: 'CIRC_LOAN_NOT_OPEN', meta: { lostItem: true } });
    const back = await giveBack(true);
    expect([back.id, back.foundLost, back.daysLate]).toEqual([loan.id, true, 0]);
    expect(calls.at(-1)).toBe('cancel:item_returned');
    expect((await db.h.db.selectFrom('items').select('status').where('id', '=', book.id).executeTakeFirstOrThrow()).status).toBe('available');
    expect(await failure(giveBack(true))).toMatchObject({ code: 'CIRC_LOAN_NOT_OPEN' });
  });

  it('a due date changed by hand: never before the loan, a closed day only warns, the note is kept', async () => {
    const reader = await member();
    const loan = await lend(reader, (await item()).barcode);
    const change = (dueOn: string) => db.run((tx) => changeLoanDue(tx, { branchId: db.branchId, loanId: loan.id, dueOn, note: 'Ujian' }));
    expect(await fieldErrors(change(addDays(TODAY, -1)))).toEqual([{ path: 'dueOn', code: 'before_loan' }]);
    const sunday = await closed({ kind: 'weekly', weekday: 7 });
    const done = await change('2026-09-20');
    expect([done.dueOn, done.warnings]).toEqual(['2026-09-20', [{ code: 'due_on_closed_day' }]]);
    expect(await loanRow(loan.id)).toMatchObject({ due_on: '2026-09-20', override_note: 'Ujian' });
    await reopen(sunday);
  });

  it('reading in place: one anonymous row per scan at the desk branch; an item on loan or recorded lost still counts and warns', async () => {
    const book = await item();
    const first = await db.run((tx) => recordInLibraryUse(tx, { branchId: db.branchId, barcode: book.barcode.toLowerCase() }));
    expect([first.item.id, first.warnings]).toEqual([book.id, undefined]);
    await lend(await member(), book.barcode);
    const again = await db.run((tx) => recordInLibraryUse(tx, { branchId: db.otherBranchId, barcode: book.barcode }));
    expect(again.warnings).toEqual([{ code: 'item_on_loan' }]);
    const rows = await db.h.db.selectFrom('item_uses').selectAll().where('item_id', '=', book.id).orderBy('used_at').execute();
    expect(rows.map((r) => [r.branch_id, r.used_on, r.member_id, r.source, r.record_id])).toEqual([
      [db.branchId, TODAY, null, 'desk', book.recordId],
      [db.otherBranchId, TODAY, null, 'desk', book.recordId],
    ]);
    expect(await failure(db.run((tx) => recordInLibraryUse(tx, { branchId: db.branchId, barcode: 'TIDAK-ADA' })))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('clearance letters: refused while a loan is open; numbered per year without gaps or repeats, also when issued at once; void keeps the number', async () => {
    const issuedOn = '2026-11-02';
    await ensureClearanceLockRow(db.h, 2026);
    const issue = (memberIds: string[], on = issuedOn) => db.run((tx) => issueClearances(tx, { memberIds, purpose: 'graduation', issuedOn: on }));
    const a = await member();
    const b = await member();
    const borrower = await member();
    await lend(borrower, (await item()).barcode);
    expect((await checkClearances(db.h.db, [a, borrower])).items.map((r) => r.refusals)).toEqual([[], ['open_loans']]);
    const first = await issue([a, borrower, b]);
    expect(first.letters.map((l) => l.number)).toEqual(['BP/2026/0001', 'BP/2026/0002']);
    expect(first.refused.map((r) => [r.memberId, r.refusals])).toEqual([[borrower, ['open_loans']]]);
    await db.run((tx) => voidClearance(tx, { memberId: a, clearanceId: first.letters[0]!.id, reason: 'Salah nama' }));

    // Two issues at once: each number once, none skipped (the lock row serialises them).
    const c = await member();
    const d = await member();
    const both = await Promise.all([issue([c]), issue([d])]);
    expect(both.flatMap((x) => x.letters.map((l) => l.number)).sort()).toEqual(['BP/2026/0003', 'BP/2026/0004']);
    // A new year starts again at 1.
    await ensureClearanceLockRow(db.h, 2027);
    expect((await issue([a], '2027-01-04')).letters.map((l) => l.number)).toEqual(['BP/2027/0001']);

    const listed = await listClearances(db.h.db, { year: 2026, limit: 2 });
    expect(listed.items.map((l) => [l.seq, l.voided])).toEqual([
      [4, false],
      [3, false],
    ]);
    const rest = await listClearances(db.h.db, { year: 2026, limit: 10, cursor: listed.nextCursor! });
    expect(rest.items.map((l) => [l.number, l.voided])).toEqual([
      ['BP/2026/0002', false],
      ['BP/2026/0001', true],
    ]);
    const events = await db.h.db.selectFrom('member_events').select(['type', 'meta']).where('member_id', '=', b).where('type', '=', 'clearance').execute();
    expect(events.map((e) => JSON.parse(e.meta))).toEqual([{ purpose: 'graduation', year: 2026, seq: 2 }]);
  });
});

/** A charges stand-in that books nothing (each test overrides what it watches). */
function noCharges(): CirculationChargeSeam {
  return {
    bookOverdue: async () => undefined,
    bookLost: async () => undefined,
    cancelLost: async () => undefined,
    loanHasCharges: async () => false,
    balances: async () => new Map(),
  };
}
