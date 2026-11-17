import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { PERMISSIONS, newId, normalizeKey, type Permission } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { Grants } from '../../src/authz/grants.js';
import { deskDashboard, libraryDashboard } from '../../src/dashboard/home.js';
import { masterId, seedBranch, seedCopy, seedHold, seedLoan, seedMember } from '../support/circulation-seed.js';

// Beranda's library figures on a small library seen at noon of 15 March 2026 in Asia/Jakarta (05:00 UTC), worked out
// by hand: today's loans and returns at the desk's branch per local hour (a voided loan and another branch's loans not
// counted, a return just after local midnight in hour 0), the same weekday a week before, the overdue loans and their
// members, the hold shelf; the library sections only for their readers, the loans by class and the most borrowed
// titles over 30 days.

const ctx = testDbContext();
const NOW = Date.parse('2026-03-15T05:00:00Z');

const grantsOf = (permissions: readonly Permission[]): Grants => ({ global: new Set(permissions), branches: new Map(), superAdmin: false, roleMfaRequired: false });

describe.skipIf(!ctx.available)(`Beranda's library figures [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let ut: string;
  let cb: string;
  const records: Record<string, string> = {};

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-dashboard-home-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    const db = h.db;
    ut = await seedBranch(db, 'UT');
    cb = await seedBranch(db, 'CB');
    // Members: two borrowers; one ending within 14 days, one ending in 20 days, one expired, one suspended, one archived;
    // two of them joined this month.
    const ana = await seedMember(db, { no: 'S-001', name: 'Ana', joinedOn: '2026-03-02' });
    const budi = await seedMember(db, { no: 'S-002', name: 'Budi', joinedOn: '2026-03-15', expiresOn: '2026-03-29' });
    await seedMember(db, { no: 'S-003', name: 'Cici', expiresOn: '2026-04-04' });
    await seedMember(db, { no: 'S-004', name: 'Dodi', expiresOn: '2026-03-14' });
    await seedMember(db, { no: 'S-005', name: 'Eka', status: 'suspended' });
    await seedMember(db, { no: 'S-006', name: 'Fajar', archived: true, joinedOn: '2026-03-03' });
    await seedMember(db, { no: 'S-007', name: 'Gita', expiresOn: '2026-03-15' });
    const copy = async (key: string, title: string, classification: string, branchId = ut) => {
      const c = await seedCopy(db, { branchId, title, barcode: `B-${key}`, classification });
      records[key] = c.recordId;
      return c;
    };
    const novel = await copy('novel', 'Laskar Pelangi', '899');
    const bio = await copy('bio', 'Biologi Dasar', '570');
    const atlas = await copy('atlas', 'Atlas Dunia', '912');
    const tafsir = await copy('tafsir', 'Tafsir Ringkas', '2X1');
    const other = await copy('other', 'Kamus Besar', '403', cb);
    // A second copy of a title (one open loan per copy).
    const second = async (c: { recordId: string; itemId: string }, branchId = ut) => {
      const itemId = newId();
      const barcode = `B-${itemId.slice(-8)}`;
      await db
        .insertInto('items')
        .values({
          id: itemId,
          record_id: c.recordId,
          branch_id: branchId,
          barcode_display: barcode,
          barcode_key: normalizeKey(barcode),
          location_id: null,
          collection_type_id: await masterId(db, 'collection_types', 'UMUM'),
          status: 'available',
          price: null,
          currency: 'IDR',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      return { recordId: c.recordId, itemId };
    };
    const lend = (c: { recordId: string; itemId: string }, o: Partial<Parameters<typeof seedLoan>[1]> & { loanedOn: string }) =>
      seedLoan(db, { ...c, memberId: ana, branchId: ut, dueOn: '2026-03-22', statDdc: null, ...o });
    // Today at UT: three loans (07.30, 08.10, 08.50 local), one voided; another branch's loan.
    await lend(novel, { loanedOn: '2026-03-15', loanedAt: Date.parse('2026-03-15T00:30:00Z'), statDdc: '890' });
    await lend(await second(novel), { loanedOn: '2026-03-15', loanedAt: Date.parse('2026-03-15T01:10:00Z'), statDdc: '890' });
    await lend(bio, { loanedOn: '2026-03-15', loanedAt: Date.parse('2026-03-15T01:50:00Z'), statDdc: '570', memberId: budi });
    await lend(bio, { loanedOn: '2026-03-15', loanedAt: Date.parse('2026-03-15T02:00:00Z'), statDdc: '570', outcome: 'voided', returnedOn: '2026-03-15' });
    await lend(other, { loanedOn: '2026-03-15', branchId: cb, statDdc: '400' });
    // Returned today at UT: at 10.20 local, and at 00.30 local (17.30 UTC the day before).
    const r1 = await lend(atlas, { loanedOn: '2026-03-10', dueOn: '2026-03-17', returnedOn: '2026-03-15', statDdc: '910' });
    const r2 = await lend(tafsir, { loanedOn: '2026-03-09', dueOn: '2026-03-16', returnedOn: '2026-03-15', statDdc: '2X' });
    await db.updateTable('loans').set({ returned_at: Date.parse('2026-03-15T03:20:00Z') }).where('id', '=', r1).execute();
    await db.updateTable('loans').set({ returned_at: Date.parse('2026-03-14T17:30:00Z') }).where('id', '=', r2).execute();
    // A week before (8 March): two loans at UT, one return.
    await lend(atlas, { loanedOn: '2026-03-08', dueOn: '2026-03-15', returnedOn: '2026-03-08', statDdc: '910' });
    await lend(tafsir, { loanedOn: '2026-03-08', dueOn: '2026-03-09', returnedOn: '2026-03-09', statDdc: null });
    // Open and overdue at UT: two of Ana's (one more than 14 days late), one of Budi's; one at CB 20 days late.
    await lend(atlas, { loanedOn: '2026-02-20', dueOn: '2026-02-27', statDdc: '910' });
    await lend(tafsir, { loanedOn: '2026-03-07', dueOn: '2026-03-14', statDdc: '2X' });
    await lend(await second(bio), { loanedOn: '2026-03-01', dueOn: '2026-03-01', memberId: budi, statDdc: '570' });
    await lend(await second(other, cb), { loanedOn: '2026-02-01', dueOn: '2026-02-23', branchId: cb, statDdc: '400' });
    // Lent 30 days ago and 31 days ago: the first is in the window, the second not.
    await lend(novel, { loanedOn: '2026-02-14', dueOn: '2026-02-21', returnedOn: '2026-02-20', statDdc: '890' });
    await lend(novel, { loanedOn: '2026-02-13', dueOn: '2026-02-20', returnedOn: '2026-02-19', statDdc: '890' });
    // The hold shelf of UT: two ready (one past its pickup date), one expired still on the shelf, one expired and
    // cleared, one cancelled that never reached the shelf.
    await seedHold(db, { recordId: novel.recordId, memberId: ana, branchId: ut, placedOn: '2026-03-01', status: 'ready', pickupUntil: '2026-03-14' });
    await seedHold(db, { recordId: bio.recordId, memberId: ana, branchId: ut, placedOn: '2026-03-01', status: 'ready', pickupUntil: '2026-03-16' });
    const expired = await seedHold(db, { recordId: atlas.recordId, memberId: budi, branchId: ut, placedOn: '2026-03-01', status: 'expired' });
    const cleared = await seedHold(db, { recordId: tafsir.recordId, memberId: budi, branchId: ut, placedOn: '2026-03-01', status: 'expired' });
    await seedHold(db, { recordId: bio.recordId, memberId: budi, branchId: ut, placedOn: '2026-03-01', status: 'cancelled' });
    await db.updateTable('holds').set({ ready_at: NOW - 86_400_000 }).where('id', 'in', [expired, cleared]).execute();
    await db.updateTable('holds').set({ shelf_cleared_at: NOW }).where('id', '=', cleared).execute();
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('today at the desk: counts, the hours they fall in, a week before, overdue and the hold shelf', async () => {
    const d = await deskDashboard(h.db, ut, NOW);
    expect(d).toMatchObject({
      branchId: ut,
      on: '2026-03-15',
      timeZone: 'Asia/Jakarta',
      weekAgo: '2026-03-08',
      loaned: 3,
      returned: 2,
      loanedWeekAgo: 2,
      returnedWeekAgo: 1,
      overdue: 3,
      overdueMembers: 2,
      holdsReady: 2,
      holdsToClear: 2,
    });
    expect(d.hours).toHaveLength(24);
    expect(d.hours.filter((x) => x.loans + x.returns > 0)).toEqual([
      { hour: 0, loans: 0, returns: 1 },
      { hour: 7, loans: 1, returns: 0 },
      { hour: 8, loans: 2, returns: 0 },
      { hour: 10, loans: 0, returns: 1 },
    ]);
    expect(d.hours.reduce((a, x) => a + x.loans, 0)).toBe(d.loaned);
    expect(d.hours.reduce((a, x) => a + x.returns, 0)).toBe(d.returned);
  });

  it('another branch has its own day', async () => {
    const d = await deskDashboard(h.db, cb, NOW);
    expect(d).toMatchObject({ loaned: 1, returned: 0, overdue: 1, overdueMembers: 1, holdsReady: 0, holdsToClear: 0 });
    expect(d.hours.filter((x) => x.loans > 0)).toEqual([{ hour: 10, loans: 1, returns: 0 }]);
  });

  it('the library sections, each only for its readers', async () => {
    expect(await libraryDashboard(h.db, grantsOf([]), NOW)).toEqual({ today: '2026-03-15', members: null, loans: null, usage: null });
    const all = await libraryDashboard(h.db, grantsOf(['members.records.read', 'circulation.records.read', 'reports.statistics.read']), NOW);
    // Valid today: Ana, Budi, Cici, Gita (Dodi expired, Eka suspended, Fajar archived); ending by 29 March: Budi, Gita.
    expect(all.members).toEqual({ active: 4, joinedThisMonth: 2, expiringSoon: 2 });
    // More than 14 days late: due 27 Feb (UT, 16 days) and 23 Feb (CB); not 1 March (14 days) nor 14 March.
    expect(all.loans).toEqual({ longOverdue: 2 });
    expect(all.usage).toEqual({
      from: '2026-02-14',
      to: '2026-03-15',
      // Most first, ties in class order; a loan without a class is "NON"; the voided loan and the loans lent before
      // 14 February not counted.
      bySubject: [
        { main: '800', loans: 3 },
        { main: '900', loans: 3 },
        { main: '500', loans: 2 },
        { main: '2X', loans: 2 },
        { main: '400', loans: 1 },
        { main: 'NON', loans: 1 },
      ],
      // Most first, ties by title.
      topTitles: [
        { recordId: records['atlas'], title: 'Atlas Dunia', loans: 3 },
        { recordId: records['novel'], title: 'Laskar Pelangi', loans: 3 },
        { recordId: records['tafsir'], title: 'Tafsir Ringkas', loans: 3 },
        { recordId: records['bio'], title: 'Biologi Dasar', loans: 2 },
        { recordId: records['other'], title: 'Kamus Besar', loans: 1 },
      ],
    });
  });

  it('a super admin’s grants (every permission) read every section', async () => {
    const all = await libraryDashboard(h.db, grantsOf(PERMISSIONS), NOW);
    expect([all.members !== null, all.loans !== null, all.usage !== null]).toEqual([true, true, true]);
  });
});
