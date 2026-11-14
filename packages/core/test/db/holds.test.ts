import { addDays } from '@altis/shared';
import type { MemberBody } from '@altis/shared/api/members';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { updateItem } from '../../src/catalog/items/index.js';
import {
  archiveMember,
  cancelHold,
  clearHoldShelf,
  createMember,
  holdShelf,
  lendItem,
  listHolds,
  markHoldReady,
  memberHolds,
  placeHold,
  renewLoan,
  returnItem,
  runHoldExpiry,
} from '../../src/index.js';
import { DAY, NOW, failure, fieldErrors, openItemsDb, seedItem, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Holds and the hold shelf on the engine picked by ALTIS_TEST_DB: the queue per title and pickup branch, the refusals,
// a return keeping the copy for the first in the queue, a kept copy lent only to its member, a renewal held back by
// the queue, the pickup expiry moving the copy on, cancel and "back to the shelf", "mark ready", the catalogue's status
// change and a member's archive letting a kept copy go, and the invariants under concurrent writers.

const ctx = testDbContext();

/** NOW in Jakarta. */
const TODAY = '2026-09-02';

describe.skipIf(!ctx.available)(`holds [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let siswa: string;
  let seq = 0;

  async function member(o: Partial<MemberBody> = {}): Promise<string> {
    seq += 1;
    const body = { memberNo: `H-${seq}`, memberTypeId: siswa, name: `Pemesan ${seq}`, ...o } as MemberBody;
    return (await db.run((tx) => createMember(tx, body))).id;
  }

  /** A title with one copy in the test branch; its record id, copy id and barcode. */
  async function title(): Promise<{ recordId: string; id: string; barcode: string }> {
    seq += 1;
    const recordId = await seedRecord(db, { title: `Judul Reservasi ${seq}` });
    const barcode = `HD-${seq}`;
    return { recordId, id: await seedItem(db, recordId, { barcode }), barcode };
  }

  /** A title whose only copy is lent to a new member; the loan's id and member too. */
  async function outTitle(): Promise<{ recordId: string; id: string; barcode: string; loanId: string; borrower: string }> {
    const t = await title();
    const borrower = await member();
    const loan = await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId: borrower, barcode: t.barcode }));
    return { ...t, loanId: loan.id, borrower };
  }

  const place = (memberId: string, recordId: string, now = NOW, o: { itemId?: string; branchId?: string } = {}) =>
    db.run((tx) => placeHold(tx, { memberId, recordId, pickupBranchId: o.branchId ?? db.branchId, source: 'desk', ...(o.itemId === undefined ? {} : { itemId: o.itemId }) }), now);
  const giveBack = (barcode: string, now = NOW) => db.run((tx) => returnItem(tx, { branchId: db.branchId, barcode }), now);
  const lend = (memberId: string, barcode: string, now = NOW) => db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId, barcode }), now);
  const hold = (id: string) => db.h.db.selectFrom('holds').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const available = async (recordId: string): Promise<boolean> =>
    (await db.h.db.selectFrom('search_facet').select('record_id').where('record_id', '=', recordId).where('facet', '=', 'av').executeTakeFirst()) !== undefined;

  beforeAll(async () => {
    db = await openItemsDb('holds');
    siswa = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
  });
  afterAll(async () => {
    await db?.close();
  });

  it('queues holds per title, refuses what the rules refuse, keeps a returned copy for the first in the queue and lends it only to that member', async () => {
    const book = await outTitle();
    const first = await member();
    const second = await member();
    const a = await place(first, book.recordId, NOW);
    const b = await place(second, book.recordId, NOW + 1000);
    expect([a.status, a.position, b.position]).toEqual(['waiting', 1, 2]);

    // The refusals, in order.
    expect(await failure(place(first, book.recordId))).toMatchObject({ code: 'CIRC_HOLD_REFUSED', meta: { reason: 'duplicate' } });
    expect(await failure(place(book.borrower, book.recordId))).toMatchObject({ code: 'CIRC_HOLD_REFUSED', meta: { reason: 'own_loan' } });
    const onShelf = await title();
    expect(await failure(place(first, onShelf.recordId))).toMatchObject({ code: 'CIRC_HOLD_REFUSED', meta: { reason: 'available' } });
    const noCopy = await seedRecord(db, { title: 'Tanpa Eksemplar' });
    expect(await failure(place(first, noCopy))).toMatchObject({ code: 'CIRC_HOLD_REFUSED', meta: { reason: 'no_copies' } });
    expect(await fieldErrors(place(await member(), book.recordId, NOW, { itemId: onShelf.id }))).toEqual([{ path: 'itemId', code: 'invalid' }]);

    // A renewal waits for the queue.
    expect(await failure(db.run((tx) => renewLoan(tx, { branchId: db.branchId, loanId: book.loanId }), NOW + DAY))).toMatchObject({
      code: 'CIRC_RENEW_REFUSED',
      meta: { reason: 'hold' },
    });

    // The return keeps the copy for the first in the queue, until today + 3 days; the title is not available to others.
    const back = await giveBack(book.barcode, NOW + DAY);
    expect(back.hold).toMatchObject({ holdId: a.id, memberId: first, memberNo: expect.stringMatching(/^H-/), pickupUntil: addDays(TODAY, 4) });
    expect(await hold(a.id)).toMatchObject({ status: 'ready', trap_item_id: book.id, item_id: book.id, pickup_until: addDays(TODAY, 4) });
    expect(await available(book.recordId)).toBe(false);
    expect(await failure(lend(second, book.barcode, NOW + DAY))).toMatchObject({ code: 'CIRC_ITEM_ON_HOLD', meta: { holdId: a.id } });

    // The member it is kept for borrows it: the hold is fulfilled, the next one moves up.
    const loan = await lend(first, book.barcode, NOW + DAY);
    expect(loan.holdFulfilledId).toBe(a.id);
    expect(await hold(a.id)).toMatchObject({ status: 'fulfilled', close_reason: 'loaned', loan_id: loan.id, active_key: null, trap_item_id: null });
    const panel = await memberHolds(db.h.db, second);
    expect(panel.map((h) => [h.id, h.status, h.position])).toEqual([[b.id, 'waiting', 1]]);
    const listed = await listHolds(db.h.db, { status: 'active', recordId: book.recordId, limit: 50 });
    expect(listed.items.map((h) => h.id)).toEqual([b.id]);
  });

  it('a kept copy not picked up in time goes to the next in the queue, else to the "back to the shelf" list until cleared', async () => {
    const book = await outTitle();
    const [m1, m2] = [await member(), await member()];
    const h1 = await place(m1, book.recordId, NOW);
    const h2 = await place(m2, book.recordId, NOW + 1000);
    await giveBack(book.barcode, NOW);
    expect((await hold(h1.id)).pickup_until).toBe(addDays(TODAY, 3));

    // On the last pickup day nothing expires; the day after, the copy moves to the next member.
    expect(await runHoldExpiry(db.h, NOW + 3 * DAY)).toMatchObject({ expiredPickup: 0 });
    expect(await runHoldExpiry(db.h, NOW + 4 * DAY)).toMatchObject({ expiredPickup: 1, keptForNext: 1 });
    expect(await hold(h1.id)).toMatchObject({ status: 'expired', close_reason: 'expired_pickup', trap_item_id: null });
    expect((await hold(h1.id)).shelf_cleared_at).not.toBeNull();
    expect(await hold(h2.id)).toMatchObject({ status: 'ready', trap_item_id: book.id, pickup_until: addDays(TODAY, 7) });

    // No one is left: the copy is listed to go back to the shelf, and is available again.
    expect(await runHoldExpiry(db.h, NOW + 8 * DAY)).toMatchObject({ expiredPickup: 1, keptForNext: 0 });
    const shelf = await holdShelf(db.h.db, { branchId: db.branchId }, NOW + 8 * DAY);
    expect(shelf.toClear.map((h) => [h.id, h.item?.barcode])).toEqual([[h2.id, book.barcode]]);
    expect(await available(book.recordId)).toBe(true);
    await db.run((tx) => clearHoldShelf(tx, { holdId: h2.id, branchId: db.branchId }), NOW + 8 * DAY);
    expect((await holdShelf(db.h.db, { branchId: db.branchId }, NOW + 8 * DAY)).toClear).toEqual([]);
    expect(await failure(db.run((tx) => clearHoldShelf(tx, { holdId: h2.id, branchId: db.branchId })))).toMatchObject({
      code: 'CIRC_HOLD_REFUSED',
      meta: { reason: 'not_on_shelf' },
    });
  });

  it('cancel, "mark ready", a status change of the kept copy and a member archive', async () => {
    const book = await outTitle();
    const [m1, m2, m3] = [await member(), await member(), await member()];
    const h1 = await place(m1, book.recordId, NOW);
    const h2 = await place(m2, book.recordId, NOW + 1000);
    const h3 = await place(m3, book.recordId, NOW + 2000);
    // Another member cannot cancel it; another branch's desk does not see it.
    expect(await failure(db.run((tx) => cancelHold(tx, { holdId: h1.id, by: 'member', memberId: m2 })))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await failure(db.run((tx) => cancelHold(tx, { holdId: h1.id, by: 'staff', branchId: db.otherBranchId })))).toMatchObject({ code: 'NOT_FOUND' });

    // Cancelling the ready hold keeps the copy for the next one.
    await giveBack(book.barcode, NOW);
    await db.run((tx) => cancelHold(tx, { holdId: h1.id, by: 'member', memberId: m1 }));
    expect(await hold(h1.id)).toMatchObject({ status: 'cancelled', close_reason: 'cancelled_member', active_key: null });
    expect(await hold(h2.id)).toMatchObject({ status: 'ready', trap_item_id: book.id });

    // The kept copy goes to repair: its hold goes back to the queue, first again.
    const item = await db.h.db.selectFrom('items').select('version').where('id', '=', book.id).executeTakeFirstOrThrow();
    await db.run((tx) => updateItem(tx, db.branchId, book.id, { version: Number(item.version), status: 'repair' }));
    expect(await hold(h2.id)).toMatchObject({ status: 'waiting', trap_item_id: null, ready_at: null });
    expect((await memberHolds(db.h.db, m2))[0]?.position).toBe(1);

    // "Tandai siap": staff scan a second copy on the shelf.
    const copy2 = `HD-${(seq += 1)}`;
    const second = await seedItem(db, book.recordId, { barcode: copy2 });
    const other = await title();
    expect(await fieldErrors(db.run((tx) => markHoldReady(tx, { holdId: h2.id, branchId: db.branchId, barcode: other.barcode })))).toEqual([
      { path: 'barcode', code: 'other_record' },
    ]);
    const ready = await db.run((tx) => markHoldReady(tx, { holdId: h2.id, branchId: db.branchId, barcode: copy2.toLowerCase() }));
    expect([ready.status, ready.pickupUntil]).toEqual(['ready', addDays(TODAY, 3)]);
    expect(await hold(h2.id)).toMatchObject({ trap_item_id: second });

    // The member is archived: the hold is cancelled and the copy is kept for the next one.
    const m2row = await db.h.db.selectFrom('members').select('version').where('id', '=', m2).executeTakeFirstOrThrow();
    await db.run((tx) => archiveMember(tx, m2, Number(m2row.version)));
    expect(await hold(h2.id)).toMatchObject({ status: 'cancelled', close_reason: 'member_archived', active_key: null, trap_item_id: null });
    expect(await hold(h3.id)).toMatchObject({ status: 'ready', trap_item_id: second });
  });

  it('a member type limit and two writers at once: never more active holds than the limit, never a waiting hold beside a free copy', async () => {
    // Two titles out, one member at the limit minus one: two holds at once, exactly one placed.
    await db.h.db.updateTable('member_types').set({ holds_limit: 1 }).where('id', '=', siswa).execute();
    try {
      const [t1, t2] = [await outTitle(), await outTitle()];
      const m = await member();
      const both = await Promise.allSettled([place(m, t1.recordId), place(m, t2.recordId)]);
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(await failure(Promise.reject(refused.reason))).toMatchObject({ code: 'CIRC_HOLD_REFUSED', meta: { reason: 'limit' } });
    } finally {
      await db.h.db.updateTable('member_types').set({ holds_limit: 2 }).where('id', '=', siswa).execute();
    }

    // A hold placed while the last copy comes back: either the copy is kept for it, or the hold is refused.
    const book = await outTitle();
    const m = await member();
    await Promise.allSettled([place(m, book.recordId), giveBack(book.barcode)]);
    const active = await db.h.db.selectFrom('holds').select(['status', 'trap_item_id']).where('record_id', '=', book.recordId).execute();
    if (active.length === 1) expect(active[0]).toEqual({ status: 'ready', trap_item_id: book.id });
    else expect(active).toEqual([]);
  });
});
