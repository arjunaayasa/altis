import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  cancelStocktake,
  createJobRegistry,
  createMember,
  createStocktake,
  finishStocktake,
  getStocktake,
  lendItem,
  markLoanLost,
  scanStocktake,
  stocktakeCodesJob,
  stocktakeFinishJob,
  stocktakeMinutesPdf,
  stocktakePrepareJob,
  txCtx,
  undoStocktakeScan,
  type JobContext,
  type JobHandler,
  type StocktakeJobDeps,
} from '../../src/index.js';
import { checkPdf } from '../support/pdf-check.js';
import { NOW, failure, openItemsDb, seedItem, seedLocation, seedRecord, type ItemsDb } from './catalog-items-support.js';

// Stocktake on the engine picked by ALTIS_TEST_DB: one live session per branch; the preparation lists the scope (copies
// on loan as such); scans by several officers at once keep the session's counters equal to what its rows say (the same
// copy, two unknown codes, the same unexpected copy); undoing a scan; the finish never marks a copy on loan missing,
// keeps a status that may not become missing (`status_kept`), restores a lost copy found and cancels its lost charge;
// a finish waits for code lists still being applied; and the minutes PDF.

const ctx = testDbContext();

/** Runs a job handler's slices to the end with a budget that never runs out. */
async function runJob<P>(db: ItemsDb, handler: JobHandler<P>, payload: P): Promise<string | undefined> {
  let p = payload;
  for (let n = 0; n < 100; n += 1) {
    const jc = {
      jobId: newId(),
      handle: db.h,
      db: db.h.db,
      now: () => NOW,
      budgetLeftMs: () => 60_000,
      cancelled: () => false,
      heartbeat: async () => undefined,
      audit: async () => undefined,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as JobContext;
    const out = await handler.run(jc, p);
    if ('done' in out) return out.message;
    if ('continueWith' in out) p = out.continueWith;
  }
  throw new Error('the job did not end');
}

describe.skipIf(!ctx.available)(`stocktake [${engineLabel()}]`, () => {
  let db: ItemsDb;
  let deps: StocktakeJobDeps;
  let seq = 0;
  const OTHER = { type: 'staff' as const, id: newId(NOW - 1000), ip: null };

  async function copy(o: { status?: string; locationId?: string | null; branchId?: string; classification?: string } = {}): Promise<{ id: string; barcode: string }> {
    seq += 1;
    const recordId = await seedRecord(db, { title: `Buku ${seq}`, callNumber: '500 BUK' });
    const barcode = `ST-${seq}`;
    const id = await seedItem(db, recordId, { barcode, ...(o.status === undefined ? {} : { status: o.status }), ...(o.locationId === undefined ? {} : { locationId: o.locationId }), ...(o.branchId === undefined ? {} : { branchId: o.branchId }) });
    return { id, barcode };
  }
  const prepare = (id: string) => runJob(db, stocktakePrepareJob(), { stocktakeId: id, after: null });
  const scan = (id: string, barcode: string, o: { locationId?: string; actor?: typeof OTHER } = {}) =>
    withTx(db.h, (trx) => scanStocktake(txCtx(trx, NOW, o.actor ?? { type: 'staff', id: newId(NOW - 2000), ip: null }), { branchId: db.branchId, id, barcode, ...(o.locationId === undefined ? {} : { locationId: o.locationId }) }));
  async function aggregates(id: string) {
    const rows = await db.h.db.selectFrom('stocktake_items').select(['state', 'expected']).where('stocktake_id', '=', id).execute();
    const n = (f: (r: { state: string; expected: number }) => boolean) => rows.filter((r) => f({ state: r.state, expected: Number(r.expected) })).length;
    const unknown = await db.h.db.selectFrom('stocktake_unknown_codes').select('code_key').where('stocktake_id', '=', id).execute();
    return {
      total: n((r) => r.expected === 1),
      found: n((r) => r.state === 'found' || r.state === 'misplaced'),
      misplaced: n((r) => r.state === 'misplaced'),
      onLoan: n((r) => r.state === 'on_loan'),
      unexpected: n((r) => r.state === 'unexpected'),
      unknownCodes: unknown.length,
    };
  }
  async function counts(id: string) {
    const c = (await getStocktake(db.h.db, db.branchId, id)).counts;
    return { total: c.total, found: c.found, misplaced: c.misplaced, onLoan: c.onLoan, unexpected: c.unexpected, unknownCodes: c.unknownCodes };
  }

  beforeAll(async () => {
    db = await openItemsDb('stocktake');
    deps = { registry: createJobRegistry([stocktakePrepareJob(), stocktakeFinishJob(), stocktakeCodesJob(() => ({ dataDir: db.dataDir }))]), keyring: [] };
  });
  afterAll(async () => {
    await db?.close();
  });

  it('one live session per branch; a cancelled one frees the branch', async () => {
    const first = await db.run((tx) => createStocktake(tx, db.branchId, { name: 'Sesi A', scope: {} }, deps));
    expect(await failure(db.run((tx) => createStocktake(tx, db.branchId, { name: 'Sesi B', scope: {} }, deps)))).toMatchObject({ code: 'STOCKTAKE_ACTIVE' });
    await db.run((tx) => cancelStocktake(tx, db.branchId, first.id));
    expect(await failure(db.run((tx) => cancelStocktake(tx, db.branchId, first.id)))).toMatchObject({ code: 'STOCKTAKE_STATE' });
    expect((await getStocktake(db.h.db, db.branchId, first.id)).status).toBe('cancelled');
  });

  it('scans by several officers at once keep the counters equal to the rows, and the finish keeps what it must', async () => {
    const room = await seedLocation(db, { code: `R${seq}`, kind: 'room' });
    const shelf = await seedLocation(db, { code: `S${seq}`, kind: 'shelf', parentId: room });
    const elsewhere = await seedLocation(db, { code: `E${seq}`, kind: 'room' });
    const onShelf = await copy({ locationId: shelf });
    const misplaced = await copy({ locationId: shelf });
    const lent = await copy({ locationId: shelf });
    const missingOnLoan = await copy({ locationId: shelf });
    const repair = await copy({ locationId: shelf, status: 'repair' });
    const lost = await copy({ locationId: shelf });
    const outside = await copy({ branchId: db.otherBranchId });

    // Loans: one copy stays out on loan; another is lent after the preparation (the finish must leave it alone); a
    // third is declared lost with a replacement charge, then found on the shelf.
    const siswa = (await db.h.db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    const reader = (await db.run((tx) => createMember(tx, { memberNo: `ST-M-${seq}`, memberTypeId: siswa, name: 'Pembaca' } as never))).id;
    await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId: reader, barcode: lent.barcode }));
    const lostLoan = await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId: reader, barcode: lost.barcode }));
    await db.run((tx) => markLoanLost(tx, { branchId: db.branchId, loanId: lostLoan.id, replacement: '50000' }));
    expect((await db.h.db.selectFrom('items').select('status').where('id', '=', lost.id).executeTakeFirstOrThrow()).status).toBe('lost');

    const s = await db.run((tx) => createStocktake(tx, db.branchId, { name: 'Inventarisasi Rak', scope: { locationIds: [room] } }, deps));
    await prepare(s.id);
    const ready = await getStocktake(db.h.db, db.branchId, s.id);
    expect(ready).toMatchObject({ status: 'active', counts: { total: 6, onLoan: 1, found: 0, pending: 5 } });
    await db.run((tx) => lendItem(tx, { branchId: db.branchId, memberId: reader, barcode: missingOnLoan.barcode }));

    // Four officers at once: the same copy twice, two unknown codes (one of them twice), the same unexpected copy twice,
    // a copy at the wrong shelf, a copy on loan, and the lost copy found.
    const results = await Promise.all([
      scan(s.id, onShelf.barcode, { locationId: room }),
      scan(s.id, onShelf.barcode, { locationId: shelf }),
      scan(s.id, 'TIDAK-ADA-1'),
      scan(s.id, 'TIDAK-ADA-2'),
      scan(s.id, 'tidak-ada-1'),
      scan(s.id, outside.barcode),
      scan(s.id, outside.barcode),
      scan(s.id, misplaced.barcode, { locationId: elsewhere }),
      scan(s.id, lent.barcode),
      scan(s.id, lost.barcode, { actor: OTHER }),
    ]);
    const outcomes = results.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'found')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'already_found')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'unknown')).toHaveLength(3);
    expect(outcomes.filter((o) => o === 'unexpected')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'misplaced')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'on_loan')).toHaveLength(1);
    expect(await counts(s.id)).toEqual(await aggregates(s.id));
    expect(await counts(s.id)).toMatchObject({ total: 6, found: 3, misplaced: 1, onLoan: 1, unexpected: 1, unknownCodes: 2 });

    // Undo: one's own scan, then another officer's (refused without the right, audited with it).
    expect(await db.run((tx) => undoStocktakeScan(tx, { branchId: db.branchId, id: s.id, itemId: lost.id, mayUndoOthers: false })).catch((e: unknown) => e)).toMatchObject({ code: 'AUTHZ_DENIED' });
    expect((await withTx(db.h, (trx) => undoStocktakeScan(txCtx(trx, NOW, OTHER), { branchId: db.branchId, id: s.id, itemId: lost.id, mayUndoOthers: false }))).undone).toBe(true);
    expect((await scan(s.id, lost.barcode, { actor: OTHER })).outcome).toBe('found');
    const undoOther = await db.run((tx) => undoStocktakeScan(tx, { branchId: db.branchId, id: s.id, itemId: outside.id, mayUndoOthers: true }));
    expect(undoOther.undone).toBe(true);
    expect((await db.h.db.selectFrom('audit_log').select('action').where('action', '=', 'stocktake.scan.cancel_other').execute()).length).toBe(1);
    expect(await counts(s.id)).toEqual(await aggregates(s.id));

    // A code list still being applied holds the finish back.
    await db.h.db
      .insertInto('jobs')
      .values({ id: newId(), type: 'stocktake.apply_codes', payload: '{}', status: 'queued', run_at: NOW, max_attempts: 5, unique_key: `stocktake.codes:${s.id}:${newId()}`, created_at: NOW, updated_at: NOW } as never)
      .execute();
    expect(await failure(db.run((tx) => finishStocktake(tx, db.branchId, s.id, { confirmName: 'Inventarisasi Rak', markMissing: true, restoreFound: true }, deps)))).toMatchObject({
      code: 'STOCKTAKE_STATE',
      meta: { reason: 'pending_uploads' },
    });
    await db.h.db.updateTable('jobs').set({ status: 'succeeded', unique_key: null } as never).where('type', '=', 'stocktake.apply_codes').execute();
    expect(await failure(db.run((tx) => finishStocktake(tx, db.branchId, s.id, { confirmName: 'Salah', markMissing: true, restoreFound: true }, deps)))).toMatchObject({ code: 'VALIDATION_FAILED' });

    await db.run((tx) => finishStocktake(tx, db.branchId, s.id, { confirmName: 'Inventarisasi Rak', markMissing: true, restoreFound: true }, deps));
    await runJob(db, stocktakeFinishJob(), { stocktakeId: s.id });
    const status = async (id: string) => (await db.h.db.selectFrom('items').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
    const result = async (id: string) =>
      (await db.h.db.selectFrom('stocktake_items').select(['result', 'state']).where('stocktake_id', '=', s.id).where('item_id', '=', id).executeTakeFirstOrThrow());
    expect(await status(missingOnLoan.id)).toBe('available');
    expect(await result(missingOnLoan.id)).toEqual({ result: 'none', state: 'on_loan' });
    expect(await status(repair.id)).toBe('repair');
    expect((await result(repair.id)).result).toBe('status_kept');
    expect(await status(lost.id)).toBe('available');
    expect((await result(lost.id)).result).toBe('restored');
    expect(await status(onShelf.id)).toBe('available');
    const events = await db.h.db.selectFrom('item_events').select(['to_status', 'meta']).where('item_id', '=', lost.id).where('type', '=', 'status').orderBy('at').orderBy('id').execute();
    // Both changes happen at the same instant here: the restore is the change to `available`.
    expect(events.filter((e) => e.to_status === 'available').map((e) => JSON.parse(e.meta).via)).toEqual(['stocktake']);
    const charge = await db.h.db.selectFrom('charges').select(['status', 'waived_minor']).where('loan_id', '=', lostLoan.id).where('kind', '=', 'lost').executeTakeFirstOrThrow();
    expect(charge.status).toBe('cancelled');
    const adj = await db.h.db.selectFrom('charge_adjustments as a').innerJoin('charges as c', 'c.id', 'a.charge_id').select('a.reason_text').where('c.loan_id', '=', lostLoan.id).execute();
    expect(adj.map((a) => a.reason_text)).toContain('Ditemukan saat inventarisasi');
    const done = await getStocktake(db.h.db, db.branchId, s.id);
    expect(done).toMatchObject({ status: 'finished', options: { markMissing: true, restoreFound: true } });
    expect(await counts(s.id)).toEqual(await aggregates(s.id));
    // Run again (a crash after the last batch): nothing changes.
    expect(await runJob(db, stocktakeFinishJob(), { stocktakeId: s.id })).toBe('stocktake_not_finishing');

    const pdf = await stocktakeMinutesPdf(db.h.db, db.branchId, s.id);
    const text = checkPdf(pdf.bytes)
      .pages.flatMap((p) => p.texts.map((t) => t.text))
      .join('\n');
    for (const want of ['Berita Acara Inventarisasi', 'Inventarisasi Rak', 'Per kelas DDC', 'Per tipe koleksi', 'Petugas Inventarisasi', 'Kepala Perpustakaan', lost.barcode]) expect(text).toContain(want);
  });

  it('a pending copy that may become missing is marked missing, with its history row', async () => {
    const book = await copy();
    const s = await db.run((tx) => createStocktake(tx, db.branchId, { name: 'Sesi Hilang', scope: { classPrefixes: ['5*'] } }, deps));
    await prepare(s.id);
    expect((await getStocktake(db.h.db, db.branchId, s.id)).counts.total).toBeGreaterThan(0);
    await db.run((tx) => finishStocktake(tx, db.branchId, s.id, { confirmName: 'Sesi Hilang', markMissing: true, restoreFound: false }, deps));
    await runJob(db, stocktakeFinishJob(), { stocktakeId: s.id });
    expect((await db.h.db.selectFrom('items').select('status').where('id', '=', book.id).executeTakeFirstOrThrow()).status).toBe('missing');
    const ev = await db.h.db.selectFrom('item_events').select(['to_status', 'meta']).where('item_id', '=', book.id).where('type', '=', 'status').execute();
    expect(ev.map((e) => [e.to_status, JSON.parse(e.meta).via])).toEqual([['missing', 'stocktake']]);
  });
});
