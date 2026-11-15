import type { DB } from '@altis/db';
import { DomainError, type StocktakeStatus } from '@altis/shared';
import { StocktakeScope, type StocktakeCounts } from '@altis/shared/api/stocktake';
import type { Kysely, Transaction } from 'kysely';

// What the stocktake services share: the session's errors, its lock, its scope and its counts.

export type Db = Kysely<DB> | Transaction<DB>;

/** The unique key of a session's preparation job, finish job and code-list jobs. */
export function prepareKey(id: string): string {
  return `stocktake.prepare:${id}`;
}

export function finishKey(id: string): string {
  return `stocktake.finish:${id}`;
}

export function codesKeyPrefix(id: string): string {
  return `stocktake.codes:${id}:`;
}

export function sessionNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Sesi inventarisasi tidak ditemukan / Stocktake session not found' });
}

/** 409 STOCKTAKE_STATE with the session's status (or `pending_uploads`) as its reason. */
export function wrongState(reason: StocktakeStatus | 'pending_uploads'): DomainError {
  return new DomainError('STOCKTAKE_STATE', {
    detail:
      reason === 'pending_uploads'
        ? 'Daftar kode yang diunggah masih diproses / An uploaded code list is still being applied'
        : 'Status sesi inventarisasi tidak memungkinkan tindakan ini / The stocktake session’s status does not allow this action',
    meta: { reason, status: reason },
  });
}

export function activeSession(stocktakeId: string): DomainError {
  return new DomainError('STOCKTAKE_ACTIVE', {
    detail: 'Cabang ini sudah punya sesi inventarisasi yang berjalan / This branch already has a stocktake session under way',
    meta: { stocktakeId },
  });
}

/**
 * Locks the session `id` of `branchId` while its status is `status` (a write that changes nothing, the first statement
 * of the transaction). 404 for a session that is not of the branch; STOCKTAKE_STATE for another status.
 */
export async function lockSession(trx: Transaction<DB>, branchId: string, id: string, status: StocktakeStatus): Promise<void> {
  const locked = await trx
    .updateTable('stocktakes')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .where('status', '=', status)
    .executeTakeFirst();
  if (Number(locked.numUpdatedRows) === 1) return;
  const row = await trx.selectFrom('stocktakes').select('status').where('id', '=', id).where('branch_id', '=', branchId).executeTakeFirst();
  if (row === undefined) throw sessionNotFound();
  throw wrongState(row.status as StocktakeStatus);
}

/** The stored scope, read back (an unreadable one is empty). */
export function parseScope(text: string): StocktakeScope {
  try {
    const parsed = StocktakeScope.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** A row's counters as {@link StocktakeCounts}. */
export function countsOf(r: { total: number | string; found: number | string; misplaced: number | string; on_loan: number | string; unexpected: number | string; unknown_codes: number | string }): StocktakeCounts {
  const total = Number(r.total);
  const found = Number(r.found);
  const onLoan = Number(r.on_loan);
  return {
    total,
    found,
    misplaced: Number(r.misplaced),
    onLoan,
    pending: Math.max(0, total - found - onLoan),
    unexpected: Number(r.unexpected),
    unknownCodes: Number(r.unknown_codes),
  };
}

/** The counters of the session `id`. */
export async function readCounts(db: Db, id: string): Promise<StocktakeCounts> {
  const row = await db.selectFrom('stocktakes').select(['total', 'found', 'misplaced', 'on_loan', 'unexpected', 'unknown_codes']).where('id', '=', id).executeTakeFirstOrThrow();
  return countsOf(row);
}

/** `id` and every location below it in the tree of the branch's locations. */
export function withDescendants(rows: readonly { id: string; parent_id: string | null }[], ids: readonly string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parent_id === null) continue;
    const list = children.get(r.parent_id) ?? [];
    list.push(r.id);
    children.set(r.parent_id, list);
  }
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

/** `id` and every location above it. */
export function withAncestors(rows: readonly { id: string; parent_id: string | null }[], id: string): Set<string> {
  const parent = new Map(rows.map((r) => [r.id, r.parent_id]));
  const out = new Set<string>();
  for (let at: string | null | undefined = id; at !== null && at !== undefined && !out.has(at); at = parent.get(at)) out.add(at);
  return out;
}

/** Whether `classKey` (a stat_ddc) or `callNumber` starts with one of the class prefixes (a trailing `*` is dropped). */
export function matchesClass(prefixes: readonly string[], classKey: string | null, callNumber: string | null): boolean {
  if (prefixes.length === 0) return true;
  const call = (callNumber ?? '').trim().toUpperCase();
  for (const raw of prefixes) {
    const p = raw.replace(/\*$/, '').toUpperCase();
    if (p === '') return true;
    if (classKey !== null && classKey.toUpperCase().startsWith(p)) return true;
    if (call.startsWith(p)) return true;
  }
  return false;
}
