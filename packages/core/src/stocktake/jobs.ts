import { withTx, type DB, type DbHandle } from '@altis/db';
import { dataPath, readBytes, removeTree } from '@altis/platform';
import { ddcClassOf, STOCKTAKE_ITEM_STATUSES, type ItemStatus } from '@altis/shared';
import { STOCKTAKE_UPLOAD_MAX_LINES } from '@altis/shared/api/stocktake';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { bulkUpdateItems } from '../catalog/items/bulk.js';
import { lockItemRecords, lockItemRows } from '../catalog/items/service.js';
import { cancelLostCharges } from '../circulation/charges.js';
import { locking, lockMemberRow } from '../circulation/desk.js';
import { txCtx, type Actor, type TxCtx } from '../context.js';
import type { StorageDriver } from '../files/serve.js';
import type { JobHandler, JobOutcome } from '../jobs/types.js';
import { lockSession, matchesClass, parseScope, withDescendants } from './common.js';
import { closeStocktakeFinish } from './minutes.js';
import { scanLocked } from './scan.js';

// The three stocktake jobs, each sliced within its budget, idempotent and resumable after a crash:
//
// - `stocktake.prepare`: lists the copies of the session's scope (live copies of the branch whose status is one a
//   stocktake takes in, matching every filter given: location or one below it, collection type, material type, class
//   prefix of the class key or the call number) as `pending` rows, or `on_loan` with an open loan, with a snapshot of
//   their location, status, class and collection type; 1 000 copies per transaction, the cursor the last copy id. A
//   batch run again after a crash replaces its own rows. At the end `total` and `on_loan` are counted from the rows and
//   the session becomes `active`.
// - `stocktake.apply_codes`: scans the codes of an uploaded list (one per line; a CSV line's first field) in the
//   uploader's name, 100 codes per transaction under the session's lock; the cursor is the next line. A session that is
//   no longer active ends it; the staged file is removed at the end.
// - `stocktake.finish`: 500 rows per transaction, the rows whose `result` is still empty (so a run again continues
//   where it stopped): a pending copy on loan now becomes `on_loan`; a pending one, when the finish marks missing
//   copies, becomes `missing` when its status may change that way and it is not kept on the hold shelf for a ready
//   hold, else its status is kept (`status_kept`); a found or misplaced copy that is `missing` or `lost`, when the
//   finish restores found copies, becomes `available` unless its status changed or it was lent after the scan (then
//   `status_kept`), and a lost one has what is left of its last loan's lost charge cancelled ("found during a
//   stocktake"). The batch's rows are read with a locking read, so the first plain read of the transaction (which
//   fixes a MySQL/MariaDB snapshot) comes after the copies' locks and sees a loan committed meanwhile. Status changes go
//   through bulkUpdateItems (the item lifecycle, the item → record lock order, the history rows with `via:
//   stocktake`). At the end the session is `finished`, its branch free for the next one, and its minutes stored as a
//   file (minutes.ts closeStocktakeFinish).

const PREPARE_BATCH = 1000;
const INSERT_CHUNK = 250;
const CODES_BATCH = 100;
const FINISH_BATCH = 500;
/** Below this much budget left, no further batch starts in this slice (the first one always runs). */
const MARGIN_MS = 2000;

const SYSTEM: Actor = { type: 'system', id: null, ip: null };

function staff(id: string | null): Actor {
  return id === null ? SYSTEM : { type: 'staff', id, ip: null };
}

async function statusOf(db: DbHandle['db'], id: string): Promise<{ status: string; branch_id: string; scope: string; options: string | null; finished_by: string | null } | null> {
  return (await db.selectFrom('stocktakes').select(['status', 'branch_id', 'scope', 'options', 'finished_by']).where('id', '=', id).executeTakeFirst()) ?? null;
}

// ---- prepare -----------------------------------------------------------------------------------------------------------

export const preparePayload = z.strictObject({ stocktakeId: z.string().length(26), after: z.string().length(26).nullable() });

export type PreparePayload = z.infer<typeof preparePayload>;

/** One batch of the preparation from the copy after `after`; the last copy id read, or null at the end. */
export async function prepareBatch(h: DbHandle, id: string, after: string | null, now: number): Promise<string | null | 'gone'> {
  const s = await statusOf(h.db, id);
  if (s === null || s.status !== 'preparing') return 'gone';
  const scope = parseScope(s.scope);
  let locations: string[] | null = null;
  if (scope.locationIds !== undefined && scope.locationIds.length > 0) {
    const rows = await h.db.selectFrom('locations').select(['id', 'parent_id']).where('branch_id', '=', s.branch_id).execute();
    locations = [...withDescendants(rows, scope.locationIds)];
  }
  let q = h.db
    .selectFrom('items as i')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .select(['i.id', 'i.location_id', 'i.status', 'i.collection_type_id', 'i.call_number', 'r.classification', 'r.call_number as record_call_number'])
    .where('i.branch_id', '=', s.branch_id)
    .where('i.archived_at', 'is', null)
    .where('i.status', 'in', [...STOCKTAKE_ITEM_STATUSES]);
  if (locations !== null) q = q.where('i.location_id', 'in', locations);
  if (scope.collectionTypeIds !== undefined && scope.collectionTypeIds.length > 0) q = q.where('i.collection_type_id', 'in', scope.collectionTypeIds);
  if (scope.materialTypeIds !== undefined && scope.materialTypeIds.length > 0) q = q.where('r.material_type_id', 'in', scope.materialTypeIds);
  if (after !== null) q = q.where('i.id', '>', after);
  const batch = await q.orderBy('i.id').limit(PREPARE_BATCH).execute();
  const prefixes = scope.classPrefixes ?? [];
  const rows = batch.flatMap((c) => {
    const call = c.call_number ?? c.record_call_number;
    const ddc = ddcClassOf(c.classification, call);
    const key = ddc.main === 'NON' ? null : (ddc.division ?? ddc.main);
    if (!matchesClass(prefixes, key, call)) return [];
    return [{ id: c.id, location_id: c.location_id, status: c.status, collection_type_id: c.collection_type_id, stat_ddc: key }];
  });
  await withTx(h, async (trx) => {
    await lockSession(trx, s.branch_id, id, 'preparing');
    const ids = rows.map((r) => r.id);
    const onLoan = new Set<string>();
    for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
      const chunk = ids.slice(i, i + INSERT_CHUNK);
      await trx.deleteFrom('stocktake_items').where('stocktake_id', '=', id).where('item_id', 'in', chunk).execute();
      for (const l of await trx.selectFrom('loans').select('open_item_id').where('open_item_id', 'in', chunk).execute()) {
        if (l.open_item_id !== null) onLoan.add(l.open_item_id);
      }
    }
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await trx
        .insertInto('stocktake_items')
        .values(
          rows.slice(i, i + INSERT_CHUNK).map((r) => ({
            stocktake_id: id,
            item_id: r.id,
            expected: 1,
            state: onLoan.has(r.id) ? 'on_loan' : 'pending',
            expected_location_id: r.location_id,
            expected_status: r.status,
            stat_ddc: r.stat_ddc,
            collection_type_id: r.collection_type_id,
            scanned_at: null,
            scanned_by: null,
            scanned_by_name: null,
            scanned_location_id: null,
            result: null,
          })),
        )
        .execute();
    }
    void now;
  });
  if (batch.length < PREPARE_BATCH) return null;
  return batch[batch.length - 1]!.id;
}

/** Counts the prepared rows and opens the session for scanning. */
async function finishPreparation(h: DbHandle, id: string, now: number): Promise<void> {
  await withTx(h, async (trx) => {
    const s = await trx.selectFrom('stocktakes').select('branch_id').where('id', '=', id).executeTakeFirstOrThrow();
    await lockSession(trx, s.branch_id, id, 'preparing');
    const counts = await trx
      .selectFrom('stocktake_items')
      .select(['state'])
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('stocktake_id', '=', id)
      .where('expected', '=', 1)
      .groupBy('state')
      .execute();
    let total = 0;
    let onLoan = 0;
    for (const c of counts) {
      total += Number(c.n);
      if (c.state === 'on_loan') onLoan += Number(c.n);
    }
    await trx
      .updateTable('stocktakes')
      .set((eb) => ({ status: 'active', total, on_loan: onLoan, updated_at: now, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('status', '=', 'preparing')
      .execute();
  });
}

/** `stocktake.prepare`: the session's creator may drive it. */
export function stocktakePrepareJob(): JobHandler<PreparePayload> {
  return {
    type: 'stocktake.prepare',
    permission: 'system.jobs.manage',
    retryable: 'api',
    interactive: true,
    cpuHeavy: true,
    payload: preparePayload,
    async run(ctx, p): Promise<JobOutcome<PreparePayload>> {
      let after = p.after;
      let first = true;
      while (first || ctx.budgetLeftMs() > MARGIN_MS) {
        first = false;
        const next = await prepareBatch(ctx.handle, p.stocktakeId, after, ctx.now());
        if (next === 'gone') return { done: true, message: 'stocktake_not_preparing' };
        if (next === null) {
          await finishPreparation(ctx.handle, p.stocktakeId, ctx.now());
          return { done: true };
        }
        after = next;
        if (ctx.cancelled()) return { done: true };
      }
      return { continueWith: { stocktakeId: p.stocktakeId, after }, progress: 50 };
    },
  };
}

// ---- apply codes -------------------------------------------------------------------------------------------------------

export const codesPayload = z.strictObject({
  stocktakeId: z.string().length(26),
  branchId: z.string().length(26),
  uploadId: z.string().length(26),
  line: z.int().min(0),
  locationId: z.string().length(26).nullable(),
  by: z.string().length(26),
  applied: z.int().min(0),
});

export type CodesPayload = z.infer<typeof codesPayload>;

/** The codes of a list: one per line, a CSV line's first field, blanks left out, at most the line limit. */
export function codesOf(bytes: Uint8Array): string[] {
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
  const out: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const first = (line.split(/[,;\t]/)[0] ?? '').replace(/^"(.*)"$/, '$1').trim();
    if (first !== '') out.push(first);
    if (out.length >= STOCKTAKE_UPLOAD_MAX_LINES) break;
  }
  return out;
}

/** `stocktake.apply_codes`: the uploader may drive it. */
export function stocktakeCodesJob(deps: () => { dataDir: string }): JobHandler<CodesPayload> {
  return {
    type: 'stocktake.apply_codes',
    permission: 'system.jobs.manage',
    retryable: 'api',
    interactive: true,
    cpuHeavy: true,
    payload: codesPayload,
    async run(ctx, p): Promise<JobOutcome<CodesPayload>> {
      const dataDir = deps().dataDir;
      const folder = dataPath(dataDir, 'tmp', p.uploadId);
      const s = await statusOf(ctx.db, p.stocktakeId);
      const bytes = s === null || s.status !== 'active' ? null : await readBytes(dataPath(dataDir, 'tmp', p.uploadId, 'upload.bin'), 11 * 1024 * 1024).catch(() => null);
      if (bytes === null) {
        await removeTree(folder).catch(() => undefined);
        return { done: true, message: s === null || s.status !== 'active' ? 'stocktake_not_active' : 'upload_missing' };
      }
      const codes = codesOf(bytes);
      let line = p.line;
      let applied = p.applied;
      let first = true;
      while (line < codes.length && (first || ctx.budgetLeftMs() > MARGIN_MS)) {
        first = false;
        const slice = codes.slice(line, line + CODES_BATCH);
        const ok = await withTx(ctx.handle, async (trx) => {
          const tx = txCtx(trx, ctx.now(), staff(p.by));
          try {
            await lockSession(trx, p.branchId, p.stocktakeId, 'active');
          } catch {
            return false;
          }
          for (const code of slice) await scanLocked(tx, { branchId: p.branchId, id: p.stocktakeId, barcode: code, ...(p.locationId === null ? {} : { locationId: p.locationId }) });
          return true;
        });
        if (!ok) break;
        line += slice.length;
        applied += slice.length;
      }
      if (line >= codes.length || ctx.cancelled()) {
        await removeTree(folder).catch(() => undefined);
        return { done: true, message: `applied:${applied}` };
      }
      return { continueWith: { ...p, line, applied }, progress: Math.min(99, Math.floor((line / codes.length) * 100)) };
    },
  };
}

// ---- finish ------------------------------------------------------------------------------------------------------------

export const finishPayload = z.strictObject({ stocktakeId: z.string().length(26) });

export type FinishPayload = z.infer<typeof finishPayload>;

/** The last loan of each lost copy of `ids` (its lost charge is the one to cancel). */
async function lastLoans(trx: Transaction<DB>, ids: readonly string[]): Promise<Map<string, { id: string; member_id: string | null }>> {
  const out = new Map<string, { id: string; member_id: string | null }>();
  for (const itemId of ids) {
    const loan = await trx.selectFrom('loans').select(['id', 'member_id']).where('item_id', '=', itemId).orderBy('loaned_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (loan !== undefined) out.set(itemId, loan);
  }
  return out;
}

/** One batch of the finish (see the top of this file); false when no row was left. */
export async function finishBatch(tx: TxCtx, branchId: string, id: string, o: { markMissing: boolean; restoreFound: boolean }): Promise<boolean> {
  const { trx } = tx;
  const read = trx
    .selectFrom('stocktake_items')
    .select(['item_id', 'state', 'expected', 'scanned_at'])
    .where('stocktake_id', '=', id)
    .where('result', 'is', null)
    .orderBy('item_id')
    .limit(FINISH_BATCH);
  const rows = await (locking(trx) ? read.forUpdate() : read).execute();
  if (rows.length === 0) return false;
  const candidates = rows.filter((r) => r.state === 'pending' || r.state === 'found' || r.state === 'misplaced').map((r) => r.item_id);
  // Items first, then their records (the order every item writer takes), before anything is read.
  await lockItemRows(trx, branchId, candidates);
  await lockItemRecords(trx, branchId, candidates);
  const status = new Map<string, string>();
  const loaned = new Set<string>();
  const held = new Set<string>();
  for (let i = 0; i < candidates.length; i += FINISH_BATCH) {
    const chunk = candidates.slice(i, i + FINISH_BATCH);
    for (const it of await trx.selectFrom('items').select(['id', 'status']).where('id', 'in', chunk).where('branch_id', '=', branchId).where('archived_at', 'is', null).execute()) {
      status.set(it.id, it.status);
    }
    for (const l of await trx.selectFrom('loans').select('open_item_id').where('open_item_id', 'in', chunk).execute()) if (l.open_item_id !== null) loaned.add(l.open_item_id);
    for (const h of await trx.selectFrom('holds').select('trap_item_id').where('trap_item_id', 'in', chunk).where('status', '=', 'ready').execute()) if (h.trap_item_id !== null) held.add(h.trap_item_id);
  }
  // A found copy whose status changed, or that was lent, after its scan: the scan does not speak for that status.
  const scannedAt = new Map(rows.filter((r) => r.scanned_at !== null && (r.state === 'found' || r.state === 'misplaced')).map((r) => [r.item_id, Number(r.scanned_at)]));
  const changedSince = new Set<string>();
  if (o.restoreFound) {
    const restorable = [...scannedAt.keys()].filter((itemId) => status.get(itemId) === 'missing' || status.get(itemId) === 'lost');
    for (let i = 0; i < restorable.length; i += FINISH_BATCH) {
      const chunk = restorable.slice(i, i + FINISH_BATCH);
      const events = await trx.selectFrom('item_events').select('item_id').select((eb) => eb.fn.max('at').as('at')).where('item_id', 'in', chunk).where('type', '=', 'status').groupBy('item_id').execute();
      const loans = await trx.selectFrom('loans').select('item_id').select((eb) => eb.fn.max('loaned_at').as('at')).where('item_id', 'in', chunk).groupBy('item_id').execute();
      for (const e of [...events, ...loans]) if (e.item_id !== null && e.at !== null && Number(e.at) > (scannedAt.get(e.item_id) ?? Infinity)) changedSince.add(e.item_id);
    }
  }
  const result = new Map<string, 'marked_missing' | 'restored' | 'status_kept' | 'none'>();
  const nowOnLoan: string[] = [];
  const toMissing: string[] = [];
  const toAvailable: string[] = [];
  for (const r of rows) {
    const st = status.get(r.item_id);
    if (r.state === 'pending') {
      if (loaned.has(r.item_id)) {
        nowOnLoan.push(r.item_id);
        result.set(r.item_id, 'none');
      } else if (!o.markMissing) result.set(r.item_id, 'none');
      else if (!held.has(r.item_id) && (st === 'available' || st === 'not_for_loan')) toMissing.push(r.item_id);
      else result.set(r.item_id, 'status_kept');
    } else if ((r.state === 'found' || r.state === 'misplaced') && o.restoreFound && (st === 'missing' || st === 'lost')) {
      if (changedSince.has(r.item_id)) result.set(r.item_id, 'status_kept');
      else toAvailable.push(r.item_id);
    } else result.set(r.item_id, 'none');
  }
  if (toMissing.length > 0) {
    const r = await bulkUpdateItems(tx, branchId, { ids: toMissing, set: { status: 'missing' as ItemStatus } }, { via: 'stocktake', audit: false, publish: false });
    const refused = new Set(r.refused.map((x) => x.id));
    for (const itemId of toMissing) result.set(itemId, refused.has(itemId) ? 'status_kept' : 'marked_missing');
  }
  if (toAvailable.length > 0) {
    const lost = toAvailable.filter((itemId) => status.get(itemId) === 'lost');
    const r = await bulkUpdateItems(tx, branchId, { ids: toAvailable, set: { status: 'available' as ItemStatus } }, { via: 'stocktake', audit: false, publish: false });
    const refused = new Set(r.refused.map((x) => x.id));
    for (const itemId of toAvailable) result.set(itemId, refused.has(itemId) ? 'status_kept' : 'restored');
    const loans = await lastLoans(
      trx,
      lost.filter((itemId) => !refused.has(itemId)),
    );
    // Members, then their charges (the global order after items and records).
    const members = [...new Set([...loans.values()].map((l) => l.member_id).filter((m): m is string => m !== null))].sort();
    for (const m of members) await lockMemberRow(trx, m);
    for (const loan of loans.values()) await cancelLostCharges(tx, { loanId: loan.id, reason: 'stocktake_found' });
  }
  const groups = new Map<string, string[]>();
  for (const [itemId, res] of result) groups.set(res, [...(groups.get(res) ?? []), itemId]);
  for (const [res, ids] of groups) {
    for (let i = 0; i < ids.length; i += FINISH_BATCH) {
      await trx.updateTable('stocktake_items').set({ result: res }).where('stocktake_id', '=', id).where('item_id', 'in', ids.slice(i, i + FINISH_BATCH)).execute();
    }
  }
  if (nowOnLoan.length > 0) {
    await trx.updateTable('stocktake_items').set({ state: 'on_loan' }).where('stocktake_id', '=', id).where('item_id', 'in', nowOnLoan).where('state', '=', 'pending').execute();
    await trx
      .updateTable('stocktakes')
      .set((eb) => ({ on_loan: eb('on_loan', '+', nowOnLoan.length) }))
      .where('id', '=', id)
      .execute();
  }
  return true;
}

/**
 * `stocktake.finish`: the staff member who asked for the finish may drive it; the copies change in that name. With
 * `deps`, the minutes are stored through its storage driver when the session is finished.
 */
export function stocktakeFinishJob(deps?: () => { storage: StorageDriver }): JobHandler<FinishPayload> {
  return {
    type: 'stocktake.finish',
    permission: 'system.jobs.manage',
    retryable: 'api',
    interactive: true,
    cpuHeavy: true,
    payload: finishPayload,
    async run(ctx, p): Promise<JobOutcome<FinishPayload>> {
      const s = await statusOf(ctx.db, p.stocktakeId);
      if (s === null || s.status !== 'finishing') return { done: true, message: 'stocktake_not_finishing' };
      let options = { markMissing: false, restoreFound: false };
      try {
        const o = JSON.parse(s.options ?? '{}') as { markMissing?: unknown; restoreFound?: unknown };
        options = { markMissing: o.markMissing === true, restoreFound: o.restoreFound === true };
      } catch {
        // an unreadable option is "no"
      }
      let first = true;
      while (first || ctx.budgetLeftMs() > MARGIN_MS) {
        first = false;
        const more = await withTx(ctx.handle, (trx) => finishBatch(txCtx(trx, ctx.now(), staff(s.finished_by)), s.branch_id, p.stocktakeId, options));
        if (!more) {
          await closeStocktakeFinish(ctx.handle, deps?.().storage ?? null, s.branch_id, p.stocktakeId, ctx.now());
          return { done: true };
        }
      }
      return { continueWith: p, progress: 50 };
    },
  };
}
