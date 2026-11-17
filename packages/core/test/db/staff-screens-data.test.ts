import { withTx } from '@altis/db';
import { newId, normalizeKey, type Permission } from '@altis/shared';
import { OPAC_HOME_DEFAULT } from '@altis/shared/api/opac-home';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import type { Grants } from '../../src/authz/grants.js';
import { createCalendarRule } from '../../src/circulation/calendars.js';
import { deskItemGlance, deskMemberView, returnItem } from '../../src/circulation/desk.js';
import { loanClassNames, searchLoans } from '../../src/circulation/loans.js';
import { libraryDashboard } from '../../src/dashboard/home.js';
import { getMemberImport, readMemberCsv, runMemberImport } from '../../src/members/import.js';
import { getMember, memberClassNames, searchMembers } from '../../src/members/members.js';
import { listMemberTypes } from '../../src/members/types.js';
import { writeSettings } from '../../src/settings/service.js';
import { masterId, seedLoan, seedMember } from '../support/circulation-seed.js';
import { NOW, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// The data the staff screens show beside their lists, on a small library seen on Wednesday 2 September 2026 (Asia/
// Jakarta), worked out by hand: the overdue and due-soon search (its filters, paging and the phone only when asked
// for), the open and overdue loans of each listed member in one read, the class lists, a member type's general loan
// terms, the desk's loan terms, the borrower's name of a return and what the desk may say about a scanned item, the
// due-soon figure and today's opening hours of Beranda, and the member import with a mapping and a SLiMS export.

const ctx = testDbContext();
const grantsOf = (permissions: readonly Permission[]): Grants => ({ global: new Set(permissions), branches: new Map(), superAdmin: false, roleMfaRequired: false });

describe.skipIf(!ctx.available)(`the staff screens' data [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let ana: string;
  let budi: string;
  let dodi: string;
  const items: Record<string, string> = {};

  beforeAll(async () => {
    db = await openItemsDb('staff-data');
    const k = db.h.db;
    ana = await seedMember(k, { no: 'S-001', name: 'Ana Lestari', className: 'X-1', phone: '0811-111' });
    budi = await seedMember(k, { no: 'S-002', name: 'Budi Santoso', className: 'X-2' });
    await seedMember(k, { no: 'S-003', name: 'Cici', className: 'X-3', archived: true });
    dodi = await seedMember(k, { no: 'G-001', name: 'Dodi', typeCode: 'GURU' });
    const lend = async (key: string, memberId: string, dueOn: string, returnedOn?: string) => {
      const recordId = await seedRecord(db, { title: `Judul ${key}` });
      const itemId = await seedItem(db, recordId, { barcode: `B-${key}` });
      items[key] = itemId;
      await seedLoan(k, { itemId, recordId, memberId, branchId: db.branchId, loanedOn: '2026-08-01', dueOn, ...(returnedOn === undefined ? {} : { returnedOn }) });
    };
    await lend('1', ana, '2026-08-20');
    await lend('2', ana, '2026-09-03');
    await lend('3', budi, '2026-09-01');
    await lend('4', budi, '2026-09-05');
    await lend('5', budi, '2026-09-06');
    await lend('6', dodi, '2026-08-10', '2026-08-09');
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('the overdue search: past due by its branch, narrowed by number, name, class and days late; the phone only when asked', async () => {
    const h = db.h.db;
    const barcodes = (r: { items: { item: { barcode: string } | null }[] }) => r.items.map((i) => i.item?.barcode);
    const all = await searchLoans(h, { tab: 'overdue', limit: 50 }, NOW, { withPhone: false });
    expect(barcodes(all)).toEqual(['B-1', 'B-3']);
    expect(all.items[0]!.daysLate).toBe(13);
    expect(all.items[0]!.member).toEqual({ id: ana, memberNo: 'S-001', name: 'Ana Lestari', className: 'X-1', typeId: await masterId(h, 'member_types', 'SISWA') });
    expect(barcodes(await searchLoans(h, { tab: 'overdue', minDaysLate: 2, limit: 50 }, NOW, { withPhone: false }))).toEqual(['B-1']);
    expect(barcodes(await searchLoans(h, { tab: 'overdue', q: 'budi', limit: 50 }, NOW, { withPhone: false }))).toEqual(['B-3']);
    expect(barcodes(await searchLoans(h, { tab: 'overdue', q: 's-001', limit: 50 }, NOW, { withPhone: false }))).toEqual(['B-1']);
    expect(barcodes(await searchLoans(h, { tab: 'overdue', className: 'X-2', limit: 50 }, NOW, { withPhone: false }))).toEqual(['B-3']);
    const phoned = await searchLoans(h, { tab: 'overdue', limit: 50 }, NOW, { withPhone: true });
    expect(phoned.items.map((i) => i.member?.phone)).toEqual(['0811-111', null]);
    expect(all.items.every((i) => i.member !== null && !('phone' in i.member))).toBe(true);
  });

  it('the due-soon search: open loans due from today to three days ahead, paged by due date', async () => {
    const h = db.h.db;
    const first = await searchLoans(h, { tab: 'due_soon', limit: 1 }, NOW, { withPhone: false });
    expect(first.items.map((i) => [i.item?.barcode, i.daysLate])).toEqual([['B-2', 0]]);
    expect(first.nextCursor).not.toBeNull();
    const second = await searchLoans(h, { tab: 'due_soon', limit: 1, cursor: first.nextCursor! }, NOW, { withPhone: false });
    expect(second.items.map((i) => i.item?.barcode)).toEqual(['B-4']);
    expect(second.nextCursor).toBeNull();
    expect((await searchLoans(h, { tab: 'due_soon', q: 'Ana', limit: 50 }, NOW, { withPhone: false })).items.map((i) => i.item?.barcode)).toEqual(['B-2']);
  });

  it('the class lists: the borrowing members, and the live members', async () => {
    expect(await loanClassNames(db.h.db)).toEqual(['X-1', 'X-2']);
    expect(await memberClassNames(db.h.db)).toEqual(['X-1', 'X-2']);
  });

  it('the member list and the member page count the open and the overdue loans', async () => {
    const page = await searchMembers(db.h.db, { limit: 50 }, NOW);
    const counts = Object.fromEntries(page.items.map((m) => [m.memberNo, [m.openLoans, m.overdueLoans]]));
    expect(counts).toEqual({ 'S-001': [2, 1], 'S-002': [3, 1], 'G-001': [0, 0] });
    const view = await getMember(db.h.db, budi, NOW);
    expect([view.openLoans, view.overdueLoans]).toEqual([3, 1]);
  });

  it("a member type's general loan terms: its own rule, else the general one, and how many rules apply to some loans", async () => {
    const h = db.h.db;
    const terms = async () => Object.fromEntries((await listMemberTypes(h, {})).map((t) => [t.code, t.loanRule && [t.loanRule.code, t.loanRule.loanDays, t.loanRule.renewLimit, t.loanRule.others]]));
    expect((await terms())['SISWA']).toEqual(['DEFAULT', 7, 1, 0]);
    const rule = async (code: string, o: { memberTypeId?: string; collectionTypeId?: string; days: number; renew: number }) =>
      h
        .insertInto('policies')
        .values({
          id: newId(),
          code_display: code,
          code_key: normalizeKey(code),
          name: code,
          member_type_id: o.memberTypeId ?? null,
          collection_type_id: o.collectionTypeId ?? null,
          material_type_id: null,
          branch_id: null,
          scope_key: `${o.memberTypeId ?? '*'}/${o.collectionTypeId ?? '*'}/*/*`,
          loanable: 1,
          loan_days: o.days,
          loan_limit: null,
          renew_limit: o.renew,
          fine_per_day_minor: 0,
          fine_cap_minor: null,
          grace_days: 0,
          currency: 'IDR',
          archived_at: null,
          version: 0,
          created_at: NOW,
          created_by: null,
          updated_at: NOW,
          updated_by: null,
        })
        .execute();
    const guru = await masterId(h, 'member_types', 'GURU');
    await rule('GURU-14', { memberTypeId: guru, days: 14, renew: 2 });
    await rule('GURU-REF', { memberTypeId: guru, collectionTypeId: await db.collectionTypeId('REF'), days: 3, renew: 0 });
    await rule('FIKSI', { collectionTypeId: await db.collectionTypeId('FIKSI'), days: 10, renew: 1 });
    const now = await terms();
    expect(now['GURU']).toEqual(['GURU-14', 14, 2, 2]);
    expect(now['SISWA']).toEqual(['DEFAULT', 7, 1, 1]);
    // The desk panel shows the same terms for the member's type.
    expect((await deskMemberView(h, { branchId: db.branchId, memberId: dodi }, NOW)).loanRule).toMatchObject({ code: 'GURU-14', loanDays: 14, renewLimit: 2 });
  });

  it('what the desk may say about a scanned item names no member; a return names its borrower', async () => {
    const glance = await deskItemGlance(db.h.db, { barcode: 'b-1' });
    expect(glance).toEqual({ barcode: 'B-1', title: 'Judul 1', status: 'available', branchCode: 'PUSAT', dueOn: '2026-08-20', onHoldShelf: false });
    expect((await deskItemGlance(db.h.db, { barcode: 'B-6' })).dueOn).toBeNull();
    await expect(deskItemGlance(db.h.db, { barcode: 'B-404' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const back = await db.run((tx) => returnItem(tx, { branchId: db.branchId, barcode: 'B-3' }));
    expect([back.memberNo, back.memberName, back.daysLate]).toEqual(['S-002', 'Budi Santoso', 1]);
  });

  it("Beranda: the loans due within two days, and today's opening hours as the public home page has them", async () => {
    const h = db.h.db;
    const grants = grantsOf(['circulation.records.read']);
    const before = await libraryDashboard(h, grants, NOW);
    expect(before.loans).toEqual({ longOverdue: 0, dueSoon: 1 });
    expect(before.openToday).toBeNull();
    expect((await libraryDashboard(h, grantsOf([]), NOW)).loans).toBeNull();
    const hours = [
      { days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [1, 2, 3, 4, 5] },
      { days: 'Rabu sore', time: '16.00–18.00', weekdays: [3] },
      { days: 'Sabtu', time: '08.00–12.00', weekdays: [6] },
    ];
    await withTx(db.h, (trx) => writeSettings(trx, { 'opac.home': { ...OPAC_HOME_DEFAULT, hours } }, { keyring: [], now: NOW, actorId: null }));
    expect((await libraryDashboard(h, grantsOf([]), NOW)).openToday).toEqual({ times: ['07.00–15.00', '16.00–18.00'], closed: false });
    await db.run((tx) => createCalendarRule(tx, { kind: 'dates', name: 'Libur', dateFrom: '2026-09-02', dateTo: '2026-09-02' }));
    expect((await libraryDashboard(h, grantsOf([]), NOW)).openToday).toEqual({ times: [], closed: true });
    await withTx(db.h, (trx) =>
      writeSettings(trx, { 'opac.home': { ...OPAC_HOME_DEFAULT, hours, blocks: { ...OPAC_HOME_DEFAULT.blocks, visit: false } } }, { keyring: [], now: NOW, actorId: null }),
    );
    expect((await libraryDashboard(h, grantsOf([]), NOW)).openToday).toBeNull();
  });

  it('the member import with a mapping: the header names are not read, each column feeds the field the admin chose', async () => {
    const csv = new TextEncoder().encode('nomor;nama lengkap;tipe;rombel;catatan\nS-100;Eka Putri;siswa;XI-1;baru\nS-101;Fajar;GURU;;\n');
    expect(() => readMemberCsv(csv)).toThrow();
    const columns = ['member_no', 'name', 'member_type', 'class_name', null] as const;
    const dry = await db.run((tx) => runMemberImport(tx, { bytes: csv, mode: 'create_only', dryRun: true, columns: [...columns] }));
    expect([dry.counts.inserted, dry.counts.refused]).toEqual([2, 0]);
    const view = await getMemberImport(db.h.db, dry.runId, { file: csv, now: NOW });
    expect(view.sample.map((r) => [r.memberNo, r.name, r.memberType, r.className, r.refusal])).toEqual([
      ['S-100', 'Eka Putri', 'siswa', 'XI-1', null],
      ['S-101', 'Fajar', 'GURU', null, null],
    ]);
    // A mapping that names a field twice is refused like a bad header.
    expect(() => readMemberCsv(csv, { columns: ['member_no', 'name', 'member_type', 'name', null] })).toThrow();
  });

  it('a SLiMS member export: 18 columns in order, a header only when present, the type by its name, no date as zeros', async () => {
    const row = (no: string, name: string, type: string, expire: string): string =>
      [no, name, '1', type, '', 'Jl. Mawar', '', 'SMA 1', '0', '', '1234', '0812', '', '2026-07-01', '2026-07-01', expire, '0000-00-00', ''].join(',');
    const bare = new TextEncoder().encode(`${row('S-200', 'Gita', 'Siswa', '2027-07-01')}\n${row('S-201', 'Hadi', 'Pupil', '0000-00-00')}\n${row('S-202', 'Indra', 'Asing', '2027-07-01')}\n`);
    const dry = await db.run((tx) => runMemberImport(tx, { bytes: bare, mode: 'create_only', dryRun: true, format: 'slims-members' }));
    expect([dry.counts.rows, dry.counts.inserted, dry.counts.refusedBy]).toEqual([3, 2, { unknown_member_type: 1 }]);
    const header = 'member_id,member_name,gender,member_type_name,member_email,member_address,postal_code,inst_name,is_new,member_image,pin,member_phone,member_fax,member_since_date,register_date,expire_date,birth_date,member_notes';
    const withHeader = new TextEncoder().encode(`${header}\n${row('S-210', 'Joko', 'Siswa', '2027-07-01')}\n`);
    // The gender column mapped by the admin: 1 is male.
    const columns = ['member_no', 'name', 'gender', 'member_type', null, 'address', null, 'institution', null, null, null, 'phone', null, 'joined_on', null, 'expires_on', 'birth_date', null] as const;
    const real = await db.run((tx) => runMemberImport(tx, { bytes: withHeader, mode: 'create_only', dryRun: false, format: 'slims-members', columns: [...columns] }));
    expect([real.counts.rows, real.counts.inserted]).toEqual([1, 1]);
    const joko = await db.h.db.selectFrom('members').select(['gender', 'phone', 'institution', 'expires_on', 'birth_date']).where('member_no_display', '=', 'S-210').executeTakeFirstOrThrow();
    expect(joko).toEqual({ gender: 'male', phone: '0812', institution: 'SMA 1', expires_on: '2027-07-01', birth_date: null });
  });
});
