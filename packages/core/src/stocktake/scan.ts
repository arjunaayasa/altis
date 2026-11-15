import { increment, type DB } from '@altis/db';
import { DomainError, type StocktakeScanOutcome } from '@altis/shared';
import type { StocktakeScanItem, StocktakeScanResponse, StocktakeUndoResponse } from '@altis/shared/api/stocktake';
import type { Transaction } from 'kysely';
import { barcodeProblem, normalizeBarcode } from '../catalog/lib/barcode.js';
import type { TxCtx } from '../context.js';
import { lockSession, readCounts, withAncestors } from './common.js';

// Scanning a session (inventarisasi). Several officers scan the same session at once; every scan is one short
// transaction whose first statement is the session's lock (a write that changes nothing, matching only while the
// session is `active`), so the scans of one session run one after another and the session's counters always equal
// what its rows say:
//
// - the code is resolved to a live copy (normalised like a stored barcode); none → `unknown`: the code's row in
//   stocktake_unknown_codes is counted up (`seen + 1`, created on its first scan), and the session's `unknown_codes`
//   only when the row was created;
// - a `pending` row of the copy: `found`, or `misplaced` when the officer named the shelf being checked and it is
//   neither the copy's own location nor one above it; the write is conditional (`state = 'pending'`) and the counters
//   move only when it changed one row. A copy with an open loan now stays as it is (`on_loan`);
// - an `on_loan` row: still on loan → `on_loan` (the copy is on the shelf but recorded on loan); its loan has been
//   closed since the preparation → found like a pending one;
// - a `found`, `misplaced` or `unexpected` row: `already_found`;
// - no row (a live copy outside the scope or of another branch): an `unexpected` row is added and counted.
//
// A scan is not audited (it is a count, not a change of the library's data); undoing another officer's scan is.

/** The live copy of the normalised barcode `key`, with what a scan answer shows. */
async function copyOf(trx: Transaction<DB>, key: string): Promise<(StocktakeScanItem & { locationId: string | null }) | null> {
  const row = await trx
    .selectFrom('items as i')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .leftJoin('locations as l', 'l.id', 'i.location_id')
    .select(['i.id', 'i.barcode_display', 'i.call_number', 'r.call_number as record_call_number', 'r.title', 'i.location_id', 'l.name as location_name'])
    .where('i.barcode_key', '=', key)
    .where('i.archived_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    id: row.id,
    barcode: row.barcode_display,
    title: row.title,
    callNumber: row.call_number ?? row.record_call_number,
    location: row.location_id === null ? null : { id: row.location_id, name: row.location_name ?? '?' },
    locationId: row.location_id,
  };
}

async function hasOpenLoan(trx: Transaction<DB>, itemId: string): Promise<boolean> {
  return (await trx.selectFrom('loans').select('id').where('open_item_id', '=', itemId).executeTakeFirst()) !== undefined;
}

/** Whether the officer's shelf `scannedAt` is the copy's location `expected` or above it. */
async function inPlace(trx: Transaction<DB>, branchId: string, expected: string | null, scannedAt: string | undefined): Promise<boolean> {
  if (scannedAt === undefined || expected === null) return true;
  if (scannedAt === expected) return true;
  const rows = await trx.selectFrom('locations').select(['id', 'parent_id']).where('branch_id', '=', branchId).execute();
  return withAncestors(rows, expected).has(scannedAt);
}

/** Adds `delta` to counters of the session `id` (each SET reads only its own column). */
async function bump(trx: Transaction<DB>, id: string, delta: Partial<Record<'found' | 'misplaced' | 'on_loan' | 'unexpected' | 'unknown_codes', number>>): Promise<void> {
  const entries = Object.entries(delta).filter(([, n]) => n !== 0) as ['found' | 'misplaced' | 'on_loan' | 'unexpected' | 'unknown_codes', number][];
  if (entries.length === 0) return;
  await trx
    .updateTable('stocktakes')
    .set((eb) => Object.fromEntries(entries.map(([col, n]) => [col, eb(col, '+', n)])))
    .where('id', '=', id)
    .execute();
}

/** The code as shown back: trimmed, at most 64 characters. */
function displayOf(raw: string): string {
  return raw.replace(/[\r\n\t]/g, ' ').trim().slice(0, 64);
}

/**
 * One scan inside a transaction that already holds the session's lock (see the top of this file); the outcome and the
 * copy. A code that cannot be a barcode (an ISBN, a bad charset) is `unknown`.
 */
export async function scanLocked(
  tx: TxCtx,
  i: { branchId: string; id: string; barcode: string; locationId?: string },
): Promise<{ outcome: StocktakeScanOutcome; code: string; item: StocktakeScanItem | null }> {
  const { trx } = tx;
  const code = displayOf(i.barcode);
  const key = normalizeBarcode(i.barcode);
  const copy = key === '' || barcodeProblem(key) !== null ? null : await copyOf(trx, key);
  if (copy === null) {
    const codeKey = (key === '' ? code : key).slice(0, 191);
    if (codeKey === '') return { outcome: 'unknown', code, item: null };
    const seen = await increment(trx, 'stocktake_unknown_codes', { stocktake_id: i.id, code_key: codeKey }, 'seen', {
      code_display: code === '' ? codeKey.slice(0, 64) : code,
      first_at: tx.now,
      last_at: tx.now,
      scanned_by: tx.actor.id,
    });
    if (seen === 1) await bump(trx, i.id, { unknown_codes: 1 });
    else await trx.updateTable('stocktake_unknown_codes').set({ last_at: tx.now }).where('stocktake_id', '=', i.id).where('code_key', '=', codeKey).execute();
    return { outcome: 'unknown', code, item: null };
  }
  const { locationId: _l, ...item } = copy;
  void _l;
  const row = await trx.selectFrom('stocktake_items').select(['state', 'expected_location_id']).where('stocktake_id', '=', i.id).where('item_id', '=', copy.id).executeTakeFirst();
  if (row === undefined) {
    await trx
      .insertInto('stocktake_items')
      .values({
        stocktake_id: i.id,
        item_id: copy.id,
        expected: 0,
        state: 'unexpected',
        expected_location_id: copy.locationId,
        expected_status: null,
        stat_ddc: null,
        collection_type_id: null,
        scanned_at: tx.now,
        scanned_by: tx.actor.id,
        scanned_by_name: null,
        scanned_location_id: i.locationId ?? null,
        result: null,
      })
      .execute();
    await bump(trx, i.id, { unexpected: 1 });
    return { outcome: 'unexpected', code, item };
  }
  if (row.state === 'found' || row.state === 'misplaced' || row.state === 'unexpected') return { outcome: 'already_found', code, item };
  if (await hasOpenLoan(trx, copy.id)) return { outcome: 'on_loan', code, item };
  const misplaced = !(await inPlace(trx, i.branchId, row.expected_location_id, i.locationId));
  const changed = await trx
    .updateTable('stocktake_items')
    .set({ state: misplaced ? 'misplaced' : 'found', scanned_at: tx.now, scanned_by: tx.actor.id, scanned_location_id: i.locationId ?? null })
    .where('stocktake_id', '=', i.id)
    .where('item_id', '=', copy.id)
    .where('state', '=', row.state)
    .executeTakeFirst();
  if (Number(changed.numUpdatedRows) !== 1) return { outcome: 'already_found', code, item };
  await bump(trx, i.id, { found: 1, misplaced: misplaced ? 1 : 0, on_loan: row.state === 'on_loan' ? -1 : 0 });
  return { outcome: misplaced ? 'misplaced' : 'found', code, item };
}

/**
 * Scans `barcode` in the active session `id` of `branchId` (see the top of this file).
 *
 * @throws DomainError NOT_FOUND (the session), STOCKTAKE_STATE (not active), VALIDATION_FAILED `{path: 'locationId',
 *   code: 'not_found'}`
 */
export async function scanStocktake(tx: TxCtx, i: { branchId: string; id: string; barcode: string; locationId?: string }): Promise<StocktakeScanResponse> {
  await lockSession(tx.trx, i.branchId, i.id, 'active');
  if (i.locationId !== undefined) {
    const loc = await tx.trx.selectFrom('locations').select('id').where('id', '=', i.locationId).where('branch_id', '=', i.branchId).executeTakeFirst();
    if (loc === undefined) {
      throw new DomainError('VALIDATION_FAILED', { detail: 'Lokasi tidak ditemukan / Location not found', meta: { errors: [{ path: 'locationId', code: 'not_found' }] } });
    }
  }
  const r = await scanLocked(tx, i);
  return { ...r, counts: await readCounts(tx.trx, i.id) };
}

/**
 * Undoes the scan of the copy `itemId` in the active session `id`: a found or misplaced copy is pending again, an
 * unexpected one leaves the session; the counters move only when the conditional write changed one row. Another
 * officer's scan may be undone only with `mayUndoOthers` (and is audited `stocktake.scan.cancel_other` then).
 *
 * @throws DomainError NOT_FOUND (the session), STOCKTAKE_STATE, AUTHZ_DENIED (another officer's scan without
 *   `mayUndoOthers`)
 */
export async function undoStocktakeScan(tx: TxCtx, i: { branchId: string; id: string; itemId: string; mayUndoOthers: boolean }): Promise<StocktakeUndoResponse> {
  const { trx } = tx;
  await lockSession(trx, i.branchId, i.id, 'active');
  const row = await trx.selectFrom('stocktake_items').select(['state', 'scanned_by']).where('stocktake_id', '=', i.id).where('item_id', '=', i.itemId).executeTakeFirst();
  if (row === undefined || (row.state !== 'found' && row.state !== 'misplaced' && row.state !== 'unexpected')) {
    return { undone: false, counts: await readCounts(trx, i.id) };
  }
  const other = row.scanned_by !== tx.actor.id;
  if (other && !i.mayUndoOthers) {
    throw new DomainError('AUTHZ_DENIED', { detail: 'Hanya pemindai atau pengelola sesi yang dapat membatalkan pindaian ini / Only the officer or a session manager may undo this scan' });
  }
  let undone: boolean;
  if (row.state === 'unexpected') {
    const gone = await trx.deleteFrom('stocktake_items').where('stocktake_id', '=', i.id).where('item_id', '=', i.itemId).where('state', '=', 'unexpected').executeTakeFirst();
    undone = Number(gone.numDeletedRows) === 1;
    if (undone) await bump(trx, i.id, { unexpected: -1 });
  } else {
    const back = await trx
      .updateTable('stocktake_items')
      .set({ state: 'pending', scanned_at: null, scanned_by: null, scanned_location_id: null })
      .where('stocktake_id', '=', i.id)
      .where('item_id', '=', i.itemId)
      .where('state', '=', row.state)
      .executeTakeFirst();
    undone = Number(back.numUpdatedRows) === 1;
    if (undone) await bump(trx, i.id, { found: -1, misplaced: row.state === 'misplaced' ? -1 : 0 });
  }
  if (undone && other) {
    await tx.audit({ action: 'stocktake.scan.cancel_other', entity: 'stocktakes', entityId: i.id, branchId: i.branchId, meta: { state: row.state } });
  }
  return { undone, counts: await readCounts(trx, i.id) };
}

