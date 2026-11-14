import { addDays } from '@altis/shared';
import type { MemberBody } from '@altis/shared/api/members';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { getItem, listItems, updateItem } from '../../src/catalog/items/index.js';
import { recordDetail } from '../../src/catalog/records/index.js';
import {
  archiveMember,
  archivePolicy,
  createMember,
  createMemberType,
  createPolicy,
  extendMember,
  getMember,
  lendItem,
  listLoans,
  lookupMember,
  renewAllLoans,
  renewLoan,
  returnItem,
  runMemberImport,
  searchMembers,
  updateMember,
} from '../../src/index.js';
import { DAY, NOW, failure, fieldErrors, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Members and desk circulation on the engine picked by ALTIS_TEST_DB: member numbers (normalised, unique), expiry and
// suspension, the loan rules, lend/return/renew with their refusals, the one-open-loan key, the catalogue's view of an
// item out on loan, the overdue list, the archive guard and the CSV member import.

const ctx = testDbContext();

/** NOW in Jakarta. */
const TODAY = '2026-09-02';

describe.skipIf(!ctx.available)(`members and circulation [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let siswa: string;
  let guru: string;

  const typeId = async (code: string): Promise<string> =>
    (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', code).executeTakeFirstOrThrow()).id;

  let seq = 0;
  /** A new member of `type` (default SISWA); its id. */
  async function member(o: Partial<MemberBody> = {}): Promise<string> {
    seq += 1;
    const body = { memberNo: `T-${seq}`, memberTypeId: siswa, name: `Anggota ${seq}`, ...o } as MemberBody;
    return (await db.run((tx) => createMember(tx, body))).id;
  }

  /** An available item of a new record in the test branch (or `branchId`); its barcode and record id. */
  async function item(o: { status?: string; branchId?: string } = {}): Promise<{ barcode: string; recordId: string; id: string }> {
    seq += 1;
    const recordId = await seedRecord(db, { title: `Judul ${seq}` });
    const barcode = `BK-${seq}`;
    const id = await seedItem(db, recordId, { barcode, ...o });
    return { barcode, recordId, id };
  }

  const lend = (memberId: string, barcode: string, now = NOW, branchId = db.branchId) => db.run((tx) => lendItem(tx, { branchId, memberId, barcode }), now);
  const giveBack = (barcode: string, now = NOW) => db.run((tx) => returnItem(tx, { branchId: db.branchId, barcode }), now);
  const renew = (loanId: string, now: number) => db.run((tx) => renewLoan(tx, { branchId: db.branchId, loanId }), now);
  const available = async (recordId: string): Promise<boolean> =>
    (await db.h.db.selectFrom('search_facet').select('record_id').where('record_id', '=', recordId).where('facet', '=', 'av').executeTakeFirst()) !== undefined;

  beforeAll(async () => {
    db = await openItemsDb('circ');
    siswa = await typeId('SISWA');
    guru = await typeId('GURU');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('a member number is normalised like a barcode: `b 001` and ` B  001 ` are one number, `B001` another', async () => {
    const first = await member({ memberNo: 'b 001' });
    expect((await getMember(db.h.db, first, NOW)).memberNo).toBe('B 001');
    expect(await fieldErrors(member({ memberNo: ' B  001 ' }))).toEqual([{ path: 'memberNo', code: 'taken' }]);
    const other = await member({ memberNo: 'B001' });
    expect(other).not.toBe(first);
    expect((await lookupMember(db.h.db, 'b\t 001', NOW)).id).toBe(first);
    expect(await fieldErrors(member({ memberNo: 'Ä-1' }))).toEqual([{ path: 'memberNo', code: 'invalid' }]);
    const found = await searchMembers(db.h.db, { q: 'b 00', limit: 50 }, NOW);
    expect(found.items.map((m) => m.id)).toEqual([first]);
  });

  it('expiry follows the type; a suspension needs a note; extend moves the expiry; the history records each step', async () => {
    const id = await member();
    const m = await getMember(db.h.db, id, NOW);
    expect([m.joinedOn, m.expiresOn, m.status]).toEqual([TODAY, addDays(TODAY, 365), 'active']);
    expect(await fieldErrors(db.run((tx) => updateMember(tx, id, { version: 0, status: 'suspended' })))).toEqual([{ path: 'statusNote', code: 'required' }]);
    await db.run((tx) => updateMember(tx, id, { version: 0, status: 'suspended', statusNote: 'Buku rusak' }));
    expect((await getMember(db.h.db, id, NOW)).status).toBe('suspended');
    await db.run((tx) => updateMember(tx, id, { version: 1, status: 'active' }));
    await db.run((tx) => extendMember(tx, id, { version: 2, from: 'today', days: 30 }));
    const after = await getMember(db.h.db, id, NOW);
    expect([after.status, after.statusNote, after.expiresOn, after.joinedOn]).toEqual(['active', null, addDays(TODAY, 30), TODAY]);
    const events = await db.h.db.selectFrom('member_events').select(['type', 'meta']).where('member_id', '=', id).orderBy('id').execute();
    expect(events.map((e) => e.type)).toEqual(['created', 'suspended', 'reactivated', 'extended']);
    expect(JSON.parse(events[3]!.meta)).toEqual({ from: addDays(TODAY, 365), to: addDays(TODAY, 30) });
  });

  it('lend, return and renew: dates, the open-loan key, the availability facet, the renewal checks', async () => {
    const reader = await member();
    const other = await member();
    const book = await item();
    const loan = await lend(reader, book.barcode.toLowerCase());
    expect([loan.dueOn, loan.item.barcode, loan.record.title]).toEqual([addDays(TODAY, 7), book.barcode, expect.stringMatching(/^Judul /)]);
    expect(await available(book.recordId)).toBe(false);
    // One open loan per item: the checks, then the unique key itself.
    expect(await failure(lend(other, book.barcode))).toMatchObject({ code: 'CIRC_ITEM_ON_LOAN', meta: { sameMember: false } });
    expect(await failure(lend(reader, book.barcode))).toMatchObject({ code: 'CIRC_ITEM_ON_LOAN', meta: { sameMember: true } });
    const row = await db.h.db.selectFrom('loans').selectAll().where('id', '=', loan.id).executeTakeFirstOrThrow();
    expect(await failure(db.h.db.insertInto('loans').values({ ...row, id: `${row.id.slice(0, 25)}Z` }).execute())).toMatchObject({ code: 'UNIQUE_VIOLATION' });
    // The catalogue keeps an item on loan as it is.
    expect(await failure(db.run((tx) => updateItem(tx, db.branchId, book.id, { version: 0, status: 'repair' })))).toMatchObject({ code: 'CIRC_ITEM_ON_LOAN' });

    expect(await failure(renew(loan.id, NOW))).toMatchObject({ code: 'CIRC_RENEW_REFUSED', meta: { reason: 'same_day' } });
    const renewed = await renew(loan.id, NOW + DAY);
    expect([renewed.dueOn, renewed.renewals, renewed.renewLimit]).toEqual([addDays(TODAY, 8), 1, 1]);
    expect(await failure(renew(loan.id, NOW + 2 * DAY))).toMatchObject({ code: 'CIRC_RENEW_REFUSED', meta: { reason: 'limit' } });

    const back = await giveBack(book.barcode, NOW + 10 * DAY);
    expect([back.id, back.returnedOn, back.daysLate, back.memberId]).toEqual([loan.id, addDays(TODAY, 10), 2, reader]);
    expect(await available(book.recordId)).toBe(true);
    expect(await failure(giveBack(book.barcode))).toMatchObject({ code: 'CIRC_LOAN_NOT_OPEN' });
    expect((await lend(other, book.barcode, NOW + 10 * DAY)).dueOn).toBe(addDays(TODAY, 17));
  });

  it('the catalogue shows an item out on loan: its view and list row say on_loan with the due date, its record counts it not available', async () => {
    const reader = await member();
    const book = await item();
    seq += 1;
    const shelved = await seedItem(db, book.recordId, { barcode: `BK-${seq}` });
    const loan = await lend(reader, book.barcode);
    const out = { state: 'on_loan', dueOn: loan.dueOn, loanId: loan.id };
    expect(await getItem(db.h.db, book.id)).toMatchObject({ status: 'available', circulation: out });
    expect((await getItem(db.h.db, shelved)).circulation).toEqual({ state: null });
    const rows = (await listItems(db.h.db, { recordId: book.recordId, limit: 50 })).items;
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.circulation]]))).toEqual({
      [book.id]: ['available', out],
      [shelved]: ['available', { state: null }],
    });
    expect((await recordDetail(db.h.db, book.recordId)).itemCounts).toEqual({ total: 2, available: 1 });

    await giveBack(book.barcode);
    expect((await getItem(db.h.db, book.id)).circulation).toEqual({ state: null });
    expect((await recordDetail(db.h.db, book.recordId)).itemCounts).toEqual({ total: 2, available: 2 });
  });

  it('the loan refusals, in order: member, item, branch, status, limits, rule', async () => {
    const book = await item();
    const suspended = await member();
    await db.run((tx) => updateMember(tx, suspended, { version: 0, status: 'suspended', statusNote: 'Catatan' }));
    expect(await failure(lend(suspended, book.barcode))).toMatchObject({ code: 'MEMBER_SUSPENDED' });
    const expired = await member({ joinedOn: '2025-01-01', expiresOn: '2025-12-31' });
    expect(await failure(lend(expired, book.barcode))).toMatchObject({ code: 'MEMBER_EXPIRED', meta: { expiresOn: '2025-12-31' } });

    const reader = await member({ memberNo: 'KARTU-77' });
    expect(await failure(lend(reader, 'kartu-77'))).toMatchObject({ code: 'NOT_FOUND', meta: { hint: 'member_no' } });
    expect(await failure(lend(reader, '9786020000008'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    const far = await item({ branchId: db.otherBranchId });
    expect(await failure(lend(reader, far.barcode))).toMatchObject({ code: 'CIRC_OTHER_BRANCH', meta: { branchCode: 'UTARA' } });
    const broken = await item({ status: 'repair' });
    expect(await failure(lend(reader, broken.barcode))).toMatchObject({ code: 'CIRC_NOT_LOANABLE', meta: { reason: 'status', status: 'repair' } });

    // The type's limit: a type that may borrow one item.
    const one = (await db.run((tx) => createMemberType(tx, { code: 'SATU', nameId: 'Satu', accredGroup: 'public', membershipDays: null, loanLimit: 1 } as never))).id;
    const limited = await member({ memberTypeId: one });
    expect((await getMember(db.h.db, limited, NOW)).expiresOn).toBeNull();
    await lend(limited, book.barcode);
    expect(await failure(lend(limited, (await item()).barcode))).toMatchObject({ code: 'CIRC_LIMIT_REACHED', meta: { scope: 'member_type', limit: 1 } });
    // An archive of a member with an open loan is refused.
    expect(await failure(db.run((tx) => archiveMember(tx, limited, 0)))).toMatchObject({ code: 'MEMBER_IN_USE', meta: { openLoans: 1, balanceMinor: 0 } });

    // The member type's own rule wins over the general rule; the rule's limit counts its own loans.
    const rule = await db.run((tx) => createPolicy(tx, { code: 'GURU-14', name: 'Guru', memberTypeId: guru, loanDays: 14, loanLimit: 1, renewLimit: 2 } as never));
    expect(await fieldErrors(db.run((tx) => createPolicy(tx, { code: 'GURU-2', name: 'Guru 2', memberTypeId: guru, loanDays: 3, loanLimit: null } as never)))).toEqual([
      { path: 'memberTypeId', code: 'taken' },
    ]);
    const teacher = await member({ memberTypeId: guru });
    expect((await lend(teacher, (await item()).barcode)).dueOn).toBe(addDays(TODAY, 14));
    expect(await failure(lend(teacher, (await item()).barcode))).toMatchObject({ code: 'CIRC_LIMIT_REACHED', meta: { scope: 'policy', limit: 1 } });
    // Without the general rule a pupil's loan has no rule at all.
    const general = await db.h.db.selectFrom('policies').select(['id', 'version']).where('code_key', '=', 'DEFAULT').executeTakeFirstOrThrow();
    await db.run((tx) => archivePolicy(tx, general.id, Number(general.version)));
    expect(await failure(lend(reader, (await item()).barcode))).toMatchObject({ code: 'CIRC_NO_POLICY' });
    await db.run((tx) => archivePolicy(tx, rule.id, 0));
    await db.run((tx) =>
      createPolicy(tx, { code: 'UMUM-7', name: 'Aturan umum baru', memberTypeId: null, loanDays: 7, loanLimit: null, renewLimit: 1 } as never),
    );
  });

  it('the overdue list and renew-all: days late in the branch time zone, an overdue loan renews from today', async () => {
    const reader = await member();
    const a = await item();
    const b = await item();
    const first = await lend(reader, a.barcode);
    await lend(reader, b.barcode, NOW + DAY);
    const later = NOW + 10 * DAY;
    const overdue = await listLoans(db.h.db, { state: 'overdue', memberId: reader, limit: 50 }, later);
    expect(overdue.items.map((l) => [l.id, l.daysLate, l.overdue])).toEqual([[first.id, 3, true], [expect.any(String), 2, true]]);
    expect((await listLoans(db.h.db, { state: 'overdue', memberId: reader, minDaysLate: 3, limit: 50 }, later)).items).toHaveLength(1);
    const all = await db.run((tx) => renewAllLoans(tx, { branchId: db.branchId, memberId: reader }), later);
    expect(all.renewed.map((r) => r.dueOn)).toEqual([addDays(TODAY, 17), addDays(TODAY, 17)]);
    expect(all.refused).toEqual([]);
    expect((await listLoans(db.h.db, { state: 'overdue', memberId: reader, limit: 50 }, later)).items).toEqual([]);
    const audits = await db.h.db.selectFrom('audit_log').select('entity_id').where('action', '=', 'circulation.loan.renew').execute();
    expect(audits.map((x) => x.entity_id)).toEqual(expect.arrayContaining(all.renewed.map((r) => r.id)));
  });

  it('the CSV import: an Excel cp1252 file with `;`, unknown types and repeated numbers refused, counts, dry run writes nothing', async () => {
    const csv = Buffer.from(
      'Member_No;Name;Member_Type;Class_Name;Gender;Birth_Date\r\n' +
        'IMP-1;Andi;siswa;7A;L;01/02/2012\r\n' +
        'IMP-2;Bu\xe9di;GURU;;P;\r\n' +
        'IMP-3;Citra;ALIEN;;;\r\n' +
        'imp-1;Andi lagi;SISWA;;;\r\n' +
        'IMP-4;Dewi;SISWA;;X;\r\n' +
        ';Tanpa Nomor;SISWA;;;\r\n',
      'latin1',
    );
    const dry = await db.run((tx) => runMemberImport(tx, { bytes: csv, mode: 'create_only', dryRun: true }));
    expect(dry.counts).toEqual({
      rows: 6,
      inserted: 3,
      updated: 0,
      unchanged: 0,
      refused: 3,
      refusedBy: { unknown_member_type: 1, duplicate_in_file: 1, missing_member_no: 1 },
      warnings: { gender_unknown: 1 },
    });
    expect(dry.refused.map((r) => [r.line, r.reason])).toEqual([
      [4, 'unknown_member_type'],
      [5, 'duplicate_in_file'],
      [7, 'missing_member_no'],
    ]);
    expect(await db.h.db.selectFrom('members').select('id').where('member_no_key', 'like', 'IMP-%').execute()).toEqual([]);

    const real = await db.run((tx) => runMemberImport(tx, { bytes: csv, mode: 'create_only', dryRun: false }));
    expect(real.counts.inserted).toBe(3);
    const budi = await lookupMember(db.h.db, 'imp-2', NOW);
    expect([budi.name, budi.gender, budi.type.code, budi.source]).toEqual(['Buédi', 'female', 'GURU', `import:${real.runId}`]);
    expect((await lookupMember(db.h.db, 'IMP-1', NOW)).birthDate).toBe('2012-02-01');

    const again = await db.run((tx) => runMemberImport(tx, { bytes: Buffer.from('member_no,name,member_type,class_name\nIMP-1,,,8A\nIMP-2,,,\n', 'utf8'), mode: 'upsert', dryRun: false }));
    expect([again.counts.updated, again.counts.unchanged]).toEqual([1, 1]);
    expect((await lookupMember(db.h.db, 'IMP-1', NOW)).className).toBe('8A');
    expect(await failure(db.run((tx) => runMemberImport(tx, { bytes: Buffer.from('nomor;nama\n1;A\n'), mode: 'create_only', dryRun: true })))).toMatchObject({
      code: 'MEMBER_IMPORT_FORMAT',
      meta: { reason: 'header' },
    });
  });
});
