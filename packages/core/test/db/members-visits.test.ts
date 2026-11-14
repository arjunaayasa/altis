import { PERSONAL_COLUMNS } from '@altis/db';
import type { MemberBody } from '@altis/shared/api/members';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  activateStation,
  anonymizeMember,
  archiveMember,
  bulkMembers,
  checkIn,
  createManualVisit,
  createMember,
  createCustomField,
  createStation,
  exportMemberData,
  getMember,
  lendItem,
  newStationCode,
  recordMemberDayVisit,
  restoreMember,
  revokeStation,
  stationByToken,
  visitSummary,
  voidVisit,
} from '../../src/index.js';
import { DAY, NOW, failure, fieldErrors, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// The member tools and visits on the engine picked by ALTIS_TEST_DB: guestbook stations (a one-time code, pairing,
// revocation), check-ins with the repeat window, the desk's one visit per member and day, manual and class visits,
// voiding, the bulk actions (the class promotion moves each class one step), restore, and the personal-data export and
// anonymisation with their effects.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`member tools and visits [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let siswa: string;
  let seq = 0;

  async function member(o: Partial<MemberBody> = {}): Promise<{ id: string; no: string }> {
    seq += 1;
    const no = `V-${seq}`;
    const body = { memberNo: no, memberTypeId: siswa, name: `Budi Anggota ${seq}`, ...o } as MemberBody;
    return { id: (await db.run((tx) => createMember(tx, body))).id, no: body.memberNo };
  }

  beforeAll(async () => {
    db = await openItemsDb('mvis');
    siswa = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
  });
  afterAll(async () => {
    await db?.close();
  });

  it('a station: its code pairs one device once, within 10 minutes; a new code or a revocation ends the pairing', async () => {
    const created = await db.run((tx) => createStation(tx, db.branchId, { name: 'Pintu depan' }));
    expect(created.code).toMatch(/^[A-Z2-7]{8}$/);
    // Typed in lower case with a dash: still the code.
    const paired = await db.run((tx) => activateStation(tx, `${created.code.slice(0, 4).toLowerCase()}-${created.code.slice(4)}`));
    expect(paired.stationId).toBe(created.id);
    expect((await stationByToken(db.h.db, paired.token))?.branchId).toBe(db.branchId);
    expect(await failure(db.run((tx) => activateStation(tx, created.code)))).toMatchObject({ code: 'VISIT_ACTIVATION_INVALID' });

    const next = await db.run((tx) => newStationCode(tx, db.branchId, created.id));
    expect(await stationByToken(db.h.db, paired.token)).toBeNull();
    expect(await failure(db.run((tx) => activateStation(tx, next.code), NOW + 11 * 60_000))).toMatchObject({ code: 'VISIT_ACTIVATION_INVALID' });
    const again = await db.run((tx) => activateStation(tx, next.code));
    await db.run((tx) => revokeStation(tx, db.branchId, created.id));
    expect(await stationByToken(db.h.db, again.token)).toBeNull();
    // Another branch's station is not found.
    expect(await failure(db.run((tx) => revokeStation(tx, db.otherBranchId, created.id)))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('check-ins: a member is recorded with the type, group and class of the day; a repeat within the window is greeted, not counted', async () => {
    const m = await member({ className: 'VII-A', expiresOn: '2026-01-31' });
    const first = await db.run((tx) => checkIn(tx, { branchId: db.branchId, source: 'station', memberNo: m.no.toLowerCase() }));
    expect([first.outcome, first.firstName, first.expired]).toEqual(['recorded', 'Budi', true]);
    const row = await db.h.db.selectFrom('visits').selectAll().where('id', '=', first.visitId!).executeTakeFirstOrThrow();
    expect([row.member_type_id, row.accred_group, row.class_name, row.visited_on]).toEqual([siswa, 'student', 'VII-A', '2026-09-02']);
    const repeat = await db.run((tx) => checkIn(tx, { branchId: db.branchId, source: 'station', memberNo: m.no }), NOW + 30 * 60_000);
    expect([repeat.outcome, repeat.visitId]).toEqual(['repeat', null]);
    const later = await db.run((tx) => checkIn(tx, { branchId: db.branchId, source: 'station', memberNo: m.no }), NOW + 61 * 60_000);
    expect(later.outcome).toBe('recorded');
    expect((await db.run((tx) => checkIn(tx, { branchId: db.branchId, source: 'station', memberNo: 'NOPE-1' }))).outcome).toBe('unknown');
    const guest = { name: 'Siti Tamu', institution: 'SD Tetangga' };
    for (let i = 0; i < 2; i += 1) expect((await db.run((tx) => checkIn(tx, { branchId: db.branchId, source: 'station', guest }))).outcome).toBe('recorded');
  });

  it("the desk's visit: one per member, branch and day, none when the member visited already that day", async () => {
    const m = await member();
    expect(await db.run((tx) => recordMemberDayVisit(tx, { source: 'desk', memberId: m.id, branchId: db.branchId }))).toBe(true);
    expect(await db.run((tx) => recordMemberDayVisit(tx, { source: 'desk', memberId: m.id, branchId: db.branchId }))).toBe(false);
    expect(await db.run((tx) => recordMemberDayVisit(tx, { source: 'desk', memberId: m.id, branchId: db.branchId }), NOW + DAY)).toBe(true);
    const other = await member();
    await db.run((tx) => checkIn(tx, { branchId: db.branchId, source: 'station', memberNo: other.no }));
    expect(await db.run((tx) => recordMemberDayVisit(tx, { source: 'desk', memberId: other.id, branchId: db.branchId }))).toBe(false);
    const rows = await db.h.db.selectFrom('visits').select(['source', 'day_key']).where('member_id', '=', m.id).orderBy('visited_at').execute();
    expect(rows.map((r) => r.source)).toEqual(['desk', 'desk']);
    expect(rows[0]!.day_key).toBe(`desk:${m.id}:${db.branchId}:2026-09-02`);
  });

  it('a class visit counts its head count and says how many of the class checked in already; a voided visit is left out of the counts', async () => {
    const pupil = await member({ className: 'IX-Z' });
    await db.run((tx) => checkIn(tx, { branchId: db.branchId, source: 'station', memberNo: pupil.no }));
    const before = await visitSummary(db.h.db, { branchId: db.branchId, on: '2026-09-02' }, NOW);
    const visit = await db.run((tx) => createManualVisit(tx, db.branchId, { className: 'IX-Z', headcount: 30 }));
    expect(visit.classCheckedIn).toBe(1);
    const after = await visitSummary(db.h.db, { branchId: db.branchId, on: '2026-09-02' }, NOW);
    expect(after.total - before.total).toBe(30);
    await db.run((tx) => voidVisit(tx, db.branchId, visit.id));
    expect((await visitSummary(db.h.db, { branchId: db.branchId, on: '2026-09-02' }, NOW)).total).toBe(before.total);
    expect(await fieldErrors(db.run((tx) => createManualVisit(tx, db.branchId, { guest: { name: 'A', institution: 'B' }, headcount: 1, visitedOn: '2026-09-03' })))).toEqual([
      { path: 'visitedOn', code: 'future' },
    ]);
  });

  it('bulk: the class promotion moves each class one step; an archive with an open loan is refused for that member only; restore', async () => {
    const seven = await member({ className: 'VII-P' });
    const eight = await member({ className: 'VIII-P' });
    const done = await db.run((tx) =>
      bulkMembers(tx, {
        action: 'promote',
        classMap: [
          { from: 'VII-P', to: 'VIII-P' },
          { from: 'VIII-P', to: 'IX-P' },
        ],
      }),
    );
    expect(done).toEqual({ done: 2, refused: [] });
    const classes = await db.h.db.selectFrom('members').select(['id', 'class_name']).where('id', 'in', [seven.id, eight.id]).execute();
    expect(Object.fromEntries(classes.map((c) => [c.id, c.class_name]))).toEqual({ [seven.id]: 'VIII-P', [eight.id]: 'IX-P' });

    const borrower = await member();
    const free = await member();
    const recordId = await seedRecord(db, { title: 'Buku Massal' });
    await seedItem(db, recordId, { barcode: 'MASSAL-1' });
    await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId: borrower.id, barcode: 'MASSAL-1' }));
    // The loan was the member's first desk action of the day: one desk visit.
    expect(await db.h.db.selectFrom('visits').select('source').where('member_id', '=', borrower.id).execute()).toEqual([{ source: 'desk' }]);
    const archived = await db.run((tx) => bulkMembers(tx, { action: 'archive', ids: [borrower.id, free.id] }));
    expect(archived).toEqual({ done: 1, refused: [{ id: borrower.id, reason: 'in_use' }] });
    const restored = await db.run((tx) => restoreMember(tx, free.id, 1));
    expect(restored.version).toBe(2);
    expect(await failure(db.run((tx) => restoreMember(tx, free.id, 2)))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('custom fields of members: never public; a member keeps its values, shows and exports them; anonymisation deletes them', async () => {
    const base = { entity: 'members' as const, type: 'text' as const, labelId: 'Nama wali', required: false, sortOrder: 0, isSearchable: false };
    expect(await fieldErrors(db.run((tx) => createCustomField(tx, { ...base, code: 'wali', isPublic: true })))).toEqual([{ path: 'isPublic', code: 'not_allowed_for_members' }]);
    await db.run((tx) => createCustomField(tx, { ...base, code: 'wali', isPublic: false }));
    const m = await member({ custom: { wali: 'Ibu Sri' } });
    expect((await getMember(db.h.db, m.id, NOW)).custom).toEqual({ wali: 'Ibu Sri' });
    expect((await exportMemberData(db.h.db, m.id, NOW)).custom).toEqual({ wali: 'Ibu Sri' });
    expect(await fieldErrors(member({ custom: { nope: 'x' } }))).toEqual([{ path: 'custom', code: 'unknown_field' }]);
    await db.run((tx) => anonymizeMember(tx, m.id));
    expect(await db.h.db.selectFrom('custom_values').select('value').where('entity_id', '=', m.id).execute()).toEqual([]);
  });

  it('anonymisation: refused with an open loan; empties every personal column, visit notes and day keys; the counts stay; the export first holds everything', async () => {
    const m = await member({ className: 'X-A', email: 'budi@contoh.test', phone: '0812', notes: 'Catatan pribadi', identityNo: '99887766' });
    await db.run((tx) => recordMemberDayVisit(tx, { source: 'desk', memberId: m.id, branchId: db.branchId }));
    await db.h.db.updateTable('visits').set({ note: 'Datang bersama ibu' }).where('member_id', '=', m.id).execute();
    const data = await exportMemberData(db.h.db, m.id, NOW);
    expect(data.member).toMatchObject({ name: expect.stringContaining('Budi'), email: 'budi@contoh.test', class_name: 'X-A' });
    expect(data.member).not.toHaveProperty('password_hash');
    expect(data.sections['visits']).toHaveLength(1);

    const recordId = await seedRecord(db, { title: 'Buku Anonim' });
    await seedItem(db, recordId, { barcode: 'ANON-1' });
    const borrower = await member();
    await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId: borrower.id, barcode: 'ANON-1' }));
    expect(await failure(db.run((tx) => anonymizeMember(tx, borrower.id, { confirmMemberNo: borrower.no })))).toMatchObject({ code: 'MEMBER_IN_USE' });
    expect(await fieldErrors(db.run((tx) => anonymizeMember(tx, m.id, { confirmMemberNo: 'SALAH' })))).toEqual([{ path: 'confirmMemberNo', code: 'mismatch' }]);

    const before = await visitSummary(db.h.db, { branchId: db.branchId, on: '2026-09-02' }, NOW);
    await db.run((tx) => anonymizeMember(tx, m.id, { confirmMemberNo: m.no.toLowerCase(), version: 0 }));
    const row = await db.h.db.selectFrom('members').selectAll().where('id', '=', m.id).executeTakeFirstOrThrow();
    for (const p of PERSONAL_COLUMNS.members ?? []) {
      if (p.column === 'name' || p.column === 'name_key') continue;
      expect({ column: p.column, value: row[p.column as keyof typeof row] }).toEqual({ column: p.column, value: null });
    }
    expect([row.name, row.member_no_display, row.anonymized_at !== null, row.archived_at !== null, row.session_version]).toEqual([
      'Anggota dianonimkan',
      `ANON-${m.id}`,
      true,
      true,
      1,
    ]);
    const visits = await db.h.db.selectFrom('visits').select(['note', 'day_key', 'class_name']).where('member_id', '=', m.id).execute();
    expect(visits).toEqual([{ note: null, day_key: null, class_name: 'X-A' }]);
    expect(await visitSummary(db.h.db, { branchId: db.branchId, on: '2026-09-02' }, NOW)).toEqual(before);
    expect(await failure(db.run((tx) => anonymizeMember(tx, m.id)))).toMatchObject({ code: 'MEMBER_ANONYMIZED' });
    // Nothing of the member's values is left in its row.
    const text = JSON.stringify(row);
    for (const value of ['budi@contoh.test', '0812', 'Catatan pribadi', '99887766', m.no]) expect(text).not.toContain(value);
    // An anonymised member cannot be archived or exported again.
    expect(await failure(db.run((tx) => archiveMember(tx, m.id, 1)))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await failure(exportMemberData(db.h.db, m.id, NOW))).toMatchObject({ code: 'NOT_FOUND' });
  });
});
