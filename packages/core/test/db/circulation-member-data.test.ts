import { randomBytes } from 'node:crypto';
import { withTx } from '@altis/db';
import { addDays } from '@altis/shared';
import type { MemberBody } from '@altis/shared/api/members';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { liveCirculationCount } from '../../src/migration/slims/stages/circulation.js';
import {
  anonymizeMember,
  bulkMembers,
  cancelHold,
  checkClearances,
  createCharge,
  createMember,
  createMemberSession,
  ensureReceiptLockRow,
  exportMemberData,
  lendItem,
  markLoanLost,
  memberDataExport,
  placeHold,
  privacyAnonymizeJob,
  returnItem,
  takePayment,
  voidLoan,
  waiveCharge,
} from '../../src/index.js';
import { writeSettings } from '../../src/settings/service.js';
import { DAY, NOW, failure, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// What the circulation modules plug into the members' personal-data actions and into the desk, on the engine picked
// by ALTIS_TEST_DB: a voided loan gives back the hold it fulfilled, a ready hold holds a clearance letter back, a
// balance keeps a member from being anonymised or archived in bulk, both close the member's holds, anonymising empties
// the free text of charges, waives and payments and deletes bookmarks, the staff export and the member's own download
// carry the same sections, the daily history anonymisation unlinks settled charges and closed holds, and what keeps a
// SLiMS migration from replacing the migrated circulation counts ALTIS's changes to migrated rows and the "serve" mark.

const ctx = testDbContext();

/** NOW in Jakarta. */
const TODAY = '2026-09-02';
const YEAR = 365 * DAY;

const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

describe.skipIf(!ctx.available)(`circulation and the member's data [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let siswa: string;
  let seq = 0;

  async function member(o: Partial<MemberBody> = {}): Promise<string> {
    seq += 1;
    const body = { memberNo: `MD-${seq}`, memberTypeId: siswa, name: `Anggota Data ${seq}`, ...o } as MemberBody;
    return (await db.run((tx) => createMember(tx, body))).id;
  }
  /** A title with one copy in the test branch. */
  async function title(): Promise<{ recordId: string; id: string; barcode: string }> {
    seq += 1;
    const recordId = await seedRecord(db, { title: `Judul Data ${seq}` });
    const barcode = `MD-B-${seq}`;
    return { recordId, id: await seedItem(db, recordId, { barcode }), barcode };
  }
  const lend = (memberId: string, barcode: string, now = NOW) => db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId, barcode }), now);
  const giveBack = (barcode: string, now = NOW) => db.run((tx) => returnItem(tx, { branchId: db.branchId, barcode }), now);
  const place = (memberId: string, recordId: string, now = NOW, allowAvailable = false) =>
    db.run((tx) => placeHold(tx, { memberId, recordId, pickupBranchId: db.branchId, source: 'desk', allowAvailable }), now);
  const hold = (id: string) => db.h.db.selectFrom('holds').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  async function pay(memberId: string, amount: string, note?: string) {
    await ensureReceiptLockRow(db.h, db.branchId, 2026);
    return db.run((tx) => takePayment(tx, { branchId: db.branchId, memberId, amount, method: 'cash', timeZone: 'Asia/Jakarta', year: 2026, ...(note === undefined ? {} : { note }) }));
  }

  beforeAll(async () => {
    db = await openItemsDb('mdata');
    siswa = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
  });
  afterAll(async () => {
    await db?.close();
  });

  it('voiding the loan that fulfilled a ready hold gives the hold back, with its copy and pickup day; a clearance letter waits for it', async () => {
    const book = await title();
    const borrower = await member();
    const reader = await member();
    const other = await member();
    await lend(borrower, book.barcode);
    const h = await place(reader, book.recordId);
    await giveBack(book.barcode, NOW + 1000);
    const ready = await hold(h.id);
    expect([ready.status, ready.trap_item_id, ready.pickup_until]).toEqual(['ready', book.id, addDays(TODAY, 3)]);

    const loan = await lend(reader, book.barcode, NOW + 2000);
    expect(await hold(h.id)).toMatchObject({ status: 'fulfilled', loan_id: loan.id, trap_item_id: null, active_key: null });
    await db.run((tx) => voidLoan(tx, { branchId: db.branchId, loanId: loan.id, mayOverride: false }), NOW + 3000);
    expect(await hold(h.id)).toMatchObject({
      status: 'ready',
      item_id: book.id,
      trap_item_id: book.id,
      pickup_until: addDays(TODAY, 3),
      active_key: `${reader}:${book.recordId}`,
      loan_id: null,
      closed_at: null,
      close_reason: null,
    });
    const audit = await db.h.db.selectFrom('audit_log').select('meta').where('action', '=', 'circulation.loan.void').where('entity_id', '=', loan.id).executeTakeFirstOrThrow();
    expect(JSON.parse(audit.meta)).toMatchObject({ holdRestored: true });
    // The copy is still kept for the reader: no one else may borrow it.
    expect(await failure(lend(other, book.barcode, NOW + 4000))).toMatchObject({ code: 'CIRC_ITEM_ON_HOLD' });
    // A clearance letter is refused while the copy waits on the hold shelf.
    expect((await checkClearances(db.h.db, [reader])).items[0]?.refusals).toContain('ready_hold');

    // A hold that was still waiting when its member borrowed a copy from the shelf waits again, in its place.
    const shelf = await title();
    const waiter = await member();
    const w = await place(waiter, shelf.recordId, NOW, true);
    const own = await lend(waiter, shelf.barcode, NOW + 5000);
    expect((await hold(w.id)).status).toBe('fulfilled');
    await db.run((tx) => voidLoan(tx, { branchId: db.branchId, loanId: own.id, mayOverride: false }), NOW + 6000);
    expect(await hold(w.id)).toMatchObject({ status: 'waiting', trap_item_id: null, active_key: `${waiter}:${shelf.recordId}`, loan_id: null });
  });

  it('a balance keeps a member from being anonymised or archived in bulk', async () => {
    const owes = await member();
    await db.run((tx) => createCharge(tx, { branchId: db.branchId, memberId: owes, kind: 'damage', amount: '15000', description: 'Sampul sobek' }));
    expect(await failure(db.run((tx) => anonymizeMember(tx, owes)))).toMatchObject({ code: 'MEMBER_IN_USE', meta: { openLoans: 0, balanceMinor: 1_500_000 } });
    expect(await db.run((tx) => bulkMembers(tx, { action: 'archive', ids: [owes] }))).toEqual({ done: 0, refused: [{ id: owes, reason: 'in_use' }] });
    const row = await db.h.db.selectFrom('members').select(['archived_at', 'anonymized_at']).where('id', '=', owes).executeTakeFirstOrThrow();
    expect(row).toEqual({ archived_at: null, anonymized_at: null });
  });

  it('archiving in bulk and anonymising close the member\'s holds: a kept copy goes to the next in the queue', async () => {
    const book = await title();
    const borrower = await member();
    await lend(borrower, book.barcode);
    const [first, second] = [await member(), await member()];
    const h1 = await place(first, book.recordId, NOW);
    const h2 = await place(second, book.recordId, NOW + 1000);
    const elsewhere = await title();
    await lend(borrower, elsewhere.barcode);
    const h3 = await place(first, elsewhere.recordId, NOW + 2000);
    await giveBack(book.barcode, NOW + 3000);
    expect((await hold(h1.id)).status).toBe('ready');
    await withTx(db.h, (trx) => createMemberSession(trx, { memberId: first, sessionVersion: 0, ip: null, userAgent: null, now: NOW, idleMs: DAY, absoluteMs: DAY }));
    expect(await db.h.db.selectFrom('sessions').select('id').where('subject_id', '=', first).execute()).toHaveLength(1);

    expect(await db.run((tx) => bulkMembers(tx, { action: 'archive', ids: [first] }), NOW + 4000)).toEqual({ done: 1, refused: [] });
    expect(await hold(h1.id)).toMatchObject({ status: 'cancelled', close_reason: 'member_archived', active_key: null, trap_item_id: null });
    expect(await hold(h3.id)).toMatchObject({ status: 'cancelled', close_reason: 'member_archived', active_key: null });
    expect(await hold(h2.id)).toMatchObject({ status: 'ready', trap_item_id: book.id });
    expect(await db.h.db.selectFrom('sessions').select('id').where('subject_id', '=', first).execute()).toEqual([]);

    // Anonymising the next one (no loan, nothing owed) closes their ready hold the same way.
    await db.run((tx) => anonymizeMember(tx, second), NOW + 5000);
    expect(await hold(h2.id)).toMatchObject({ status: 'cancelled', close_reason: 'member_archived', active_key: null, trap_item_id: null });
  });

  it('anonymising empties the free text of charges, waives and payments and deletes bookmarks; both exports held them first, in the same sections', async () => {
    const m = await member({ name: 'Budi Rahasia' });
    const book = await title();
    const charge = await db.run((tx) => createCharge(tx, { branchId: db.branchId, memberId: m, kind: 'card', amount: '10000', description: 'Kartu Budi Rahasia hilang' }));
    await db.run((tx) => waiveCharge(tx, { branchId: db.branchId, chargeId: charge.id, amount: '4000', reason: 'Keringanan untuk Budi Rahasia' }));
    await pay(m, '6000', 'Dibayar ibu Budi Rahasia');
    await db.h.db.insertInto('member_bookmarks').values({ member_id: m, record_id: book.recordId, created_at: NOW }).execute();
    const out = await title();
    await lend(await member(), out.barcode);
    await place(m, out.recordId);

    const staff = await exportMemberData(db.h.db, m, NOW);
    for (const name of ['events', 'loans', 'visits', 'holds', 'charges', 'payments', 'clearances', 'bookmarks', 'notices']) expect(Object.keys(staff.sections)).toContain(name);
    expect(staff.sections['charges']).toEqual([
      expect.objectContaining({ kind: 'card', description: 'Kartu Budi Rahasia hilang', amountMinor: 1_000_000, status: 'settled', adjustments: [expect.objectContaining({ kind: 'waive', reason: 'Keringanan untuk Budi Rahasia' })] }),
    ]);
    expect(staff.sections['payments']).toEqual([expect.objectContaining({ amountMinor: 600_000, note: 'Dibayar ibu Budi Rahasia' })]);
    expect(staff.sections['holds']).toEqual([expect.objectContaining({ status: 'waiting' })]);
    expect(staff.sections['bookmarks']).toEqual([expect.objectContaining({ recordId: book.recordId })]);
    // The member's own download carries the same sections.
    const own = await memberDataExport(db.h.db, m, NOW);
    for (const [name, rows] of Object.entries(staff.sections)) expect({ name, rows: own[name] }).toEqual({ name, rows });

    await db.run((tx) => anonymizeMember(tx, m));
    expect(await db.h.db.selectFrom('member_bookmarks').select('record_id').where('member_id', '=', m).execute()).toEqual([]);
    expect(await db.h.db.selectFrom('holds').select(['status', 'close_reason']).where('member_id', '=', m).execute()).toEqual([{ status: 'cancelled', close_reason: 'member_archived' }]);
    const charges = await db.h.db.selectFrom('charges').select(['description', 'amount_minor', 'status']).where('member_id', '=', m).execute();
    expect(charges.map((c) => [c.description, Number(c.amount_minor), c.status])).toEqual([['', 1_000_000, 'settled']]);
    // Nothing the staff typed about the member is left on their circulation rows.
    const rows = [
      await db.h.db.selectFrom('charges').selectAll().where('member_id', '=', m).execute(),
      await db.h.db.selectFrom('charge_adjustments').selectAll().where('charge_id', '=', charge.id).execute(),
      await db.h.db.selectFrom('payments').selectAll().where('member_id', '=', m).execute(),
      await db.h.db.selectFrom('holds').selectAll().where('member_id', '=', m).execute(),
    ];
    expect(JSON.stringify(rows)).not.toContain('Budi');
    expect(rows[1]).toHaveLength(1);
  });

  it('a replace of the migrated circulation: a migrated loan ALTIS returned counts as circulation of its own, and so does the "serve" mark', async () => {
    const book = await title();
    const loan = await lend(await member(), book.barcode);
    const base = await liveCirculationCount(db.h.db);
    // The loan as the migration writes it: migrated, never changed since.
    await db.h.db.updateTable('loans').set({ source: 'migrated', version: 0 }).where('id', '=', loan.id).execute();
    expect(await liveCirculationCount(db.h.db)).toBe(base - 1);
    await giveBack(book.barcode);
    expect(await liveCirculationCount(db.h.db)).toBe(base);
    await db.run((tx) => tx.audit({ action: 'catalog.migration.cutover', entity: 'slims_cutover', entityId: 'serve', meta: { step: 'serve' } }));
    expect(await liveCirculationCount(db.h.db)).toBe(base + 1);
  });

  it('the daily history anonymisation: a settled charge of an anonymised loan loses its loan, item and line; closed holds as old lose their member', async () => {
    const reader = await member();
    const lost = await title();
    const loan = await lend(reader, lost.barcode);
    await db.run((tx) => markLoanLost(tx, { branchId: db.branchId, loanId: loan.id, replacement: '50000' }));
    await pay(reader, '50000');
    const stillOwed = await title();
    const owedLoan = await lend(reader, stillOwed.barcode);
    await db.run((tx) => markLoanLost(tx, { branchId: db.branchId, loanId: owedLoan.id, replacement: '20000' }));
    const wanted = await title();
    await lend(await member(), wanted.barcode);
    const h = await place(reader, wanted.recordId);
    await db.run((tx) => cancelHold(tx, { holdId: h.id, by: 'member', memberId: reader }));
    // Two years have passed since.
    await db.h.db.updateTable('loans').set({ returned_at: NOW - 2 * YEAR }).where('id', 'in', [loan.id, owedLoan.id]).execute();
    await db.h.db.updateTable('holds').set({ closed_at: NOW - 2 * YEAR }).where('id', '=', h.id).execute();
    await withTx(db.h, (trx) => writeSettings(trx, { 'privacy.loans.anonymizeAfterYears': 1 }, { keyring: [], now: NOW, actorId: null }));

    const registry = createJobRegistry([privacyAnonymizeJob(() => ({ storage: localStorageDriver(db.dataDir) })) as never]);
    const { id } = await withTx(db.h, (trx) => enqueue(trx, registry, { type: 'privacy.anonymize', payload: { windowStart: NOW, windowEnd: NOW + 60_000 } }, { now: NOW, keyring }));
    for (let slices = 0; slices < 20; slices += 1) {
      const claimed = await claimById(db.h, registry, id, { worker: 'test', now: NOW });
      if (claimed === null) break;
      const r = await runSlice(db.h, registry, claimed, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') {
        expect(r.outcome).toBe('succeeded');
        break;
      }
    }

    const loans = await db.h.db.selectFrom('loans').select(['id', 'member_id']).where('id', 'in', [loan.id, owedLoan.id]).execute();
    expect(loans.every((l) => l.member_id === null)).toBe(true);
    const charges = await db.h.db.selectFrom('charges').select(['loan_id', 'item_id', 'description', 'status', 'amount_minor', 'member_id']).where('member_id', '=', reader).orderBy('amount_minor').execute();
    expect(charges.map((c) => [c.loan_id, c.item_id, c.description, c.status, Number(c.amount_minor)])).toEqual([
      // Still owed: it keeps its loan until it is settled.
      [owedLoan.id, stillOwed.id, expect.stringContaining(stillOwed.barcode), 'open', 2_000_000],
      [null, null, '', 'settled', 5_000_000],
    ]);
    expect(await hold(h.id)).toMatchObject({ status: 'cancelled', member_id: null });
  });
});
