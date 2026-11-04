import { assertOutsideTx, withTx, type DB, type DbHandle } from '@altis/db';
import { DomainError, isDomainError } from '@altis/shared';
import { BarcodePattern } from '@altis/shared/api/settings';
import type { Transaction } from 'kysely';
import { barcodeProblem } from '../lib/barcode.js';

// Numbering barcodes by a pattern (Phase 2 spec §3.4; decisions P2-25, P2-34; preflight B4, M8): `<prefix><number
// zero-padded to digits><suffix>` from `catalog.barcode.patterns`.
//
// - Serialised per pattern by a row lock **inside** the batch's transaction: the `locks` row
//   `catalog.barcode:<patternId>`, taken by an UPDATE that sets its `until` to LOCK_FOREVER (claimLock cannot run in a
//   transaction, R49; §3.4 wants the numbering in the transaction that inserts). On MySQL/MariaDB (REPEATABLE READ)
//   that UPDATE must come before any plain read of the transaction, so that the snapshot the reads see is taken after
//   the lock, when the previous batch of the pattern has committed: the batch takes it as its first statement.
// - The row is made beforehand, outside the batch's transaction, by ensureBarcodeLockRow (the batch route's `prepare`,
//   on every request, so a row a restore or a purge removed comes back). Its `until` is LOCK_FOREVER, far in the
//   future, so the volatile housekeeping (which deletes rows whose `until` passed an hour ago) never removes it; a
//   clock confirmation (C3) clamps it to now, and the next ensure or batch sets it back. It is never claimed through
//   claimLock.
// - Numbering is stateless (B4): the next number is the highest number among the barcode keys that match
//   `^PREFIX\d{digits}SUFFIX$` exactly, + 1, read under the lock. No counter row, so it stays right after imports and
//   migrations. A manual key above the maximum moves the series on; one below it is never revisited.
// - Each candidate is checked with a SELECT before it is handed out, never by a failing INSERT (a UNIQUE_VIOLATION
//   aborts a PostgreSQL transaction): one found taken (a manual create, which takes no pattern lock, landed after the
//   maximum was read) is reported in `skipped` and the next number is tried. A candidate that is no valid barcode (a
//   valid ISBN-13, §3.2, when the prefix is `978…`) is passed over without a report: it can never be stored.

/** `locks.until` of a pattern's lock row: 9999-12-31T23:59:59.999Z, so that no expiry ever treats it as stale. */
export const LOCK_FOREVER = 253_402_300_799_999;

/** `locks.owner` of the pattern lock rows (they are never claimed, so no holder is compared). */
const LOCK_OWNER = 'catalog.barcode';

/** The most numbers one call hands out (a batch takes at most 100, an import its batch's items). */
const NEXT_MAX = 10_000;

/** Barcode keys read per statement while looking for the maximum. */
const SCAN_BATCH = 200;

/** A pattern id (`settingIdField`): `a-z 0-9 -`, 1-32. */
const PATTERN_ID = /^[a-z0-9-]{1,32}$/;

/** The name of the lock row of pattern `patternId`. */
export function barcodeLockName(patternId: string): string {
  if (typeof patternId !== 'string' || !PATTERN_ID.test(patternId)) throw new TypeError(`barcode pattern id ${JSON.stringify(patternId)} is not a setting id`);
  return `catalog.barcode:${patternId}`;
}

/**
 * Makes sure the lock row of pattern `patternId` exists with `until = LOCK_FOREVER` (M8): in a short transaction of its
 * own on `h`, outside any other (the batch route's `prepare`). Absent → inserted; there with another `until` → set
 * back. A UNIQUE_VIOLATION means a concurrent request inserted it first: only this short transaction is lost (which
 * matters on PostgreSQL, where it aborts), and the row is there.
 *
 * @throws TypeError inside a withTx callback (R49) or for an id that is no setting id
 */
export async function ensureBarcodeLockRow(h: DbHandle, patternId: string): Promise<void> {
  assertOutsideTx('ensureBarcodeLockRow');
  const name = barcodeLockName(patternId);
  try {
    await withTx(h, async (trx) => {
      const row = await trx.selectFrom('locks').select('until').where('name', '=', name).executeTakeFirst();
      if (row === undefined) {
        await trx.insertInto('locks').values({ name, owner: LOCK_OWNER, until: LOCK_FOREVER }).execute();
      } else if (Number(row.until) !== LOCK_FOREVER) {
        await trx.updateTable('locks').set({ until: LOCK_FOREVER }).where('name', '=', name).execute();
      }
    });
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNIQUE_VIOLATION') return;
    throw error;
  }
}

/**
 * Takes the lock row of pattern `patternId` in `trx` (until the transaction ends): the rows the UPDATE matched, 0 when
 * the row is absent. Package-internal: the batch takes it as its first statement, nextBarcodes again.
 */
export async function lockBarcodePattern(trx: Transaction<DB>, patternId: string): Promise<number> {
  const result = await trx.updateTable('locks').set({ until: LOCK_FOREVER }).where('name', '=', barcodeLockName(patternId)).executeTakeFirst();
  // MySQL/MariaDB report matched rows, not only changed ones: mysql2 connects with CLIENT_FOUND_ROWS.
  return Number(result.numUpdatedRows);
}

/** `s` with every regex metacharacter escaped. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The barcode of number `n` in pattern `p`. */
function barcodeOf(p: BarcodePattern, n: number): string {
  return `${p.prefix}${String(n).padStart(p.digits, '0')}${p.suffix}`;
}

/**
 * The highest number among the keys that match `p` exactly, 0 when none does. Every such key has the same length and
 * lies between `PREFIX0…0` and `PREFIX9…9SUFFIX`, so the keys of that range are read from the top down (the unique
 * index on `barcode_key`, binary on every dialect) and the first one the pattern's regex accepts is the maximum.
 */
async function maxNumber(trx: Transaction<DB>, p: BarcodePattern): Promise<number> {
  const exact = new RegExp(`^${escapeRegex(p.prefix)}(\\d{${p.digits}})${escapeRegex(p.suffix)}$`);
  const low = `${p.prefix}${'0'.repeat(p.digits)}`;
  let high = barcodeOf(p, 10 ** p.digits - 1);
  let inclusive = true;
  for (;;) {
    const rows = await trx
      .selectFrom('items')
      .select('barcode_key')
      .where('barcode_key', '>=', low)
      .where('barcode_key', inclusive ? '<=' : '<', high)
      .orderBy('barcode_key', 'desc')
      .limit(SCAN_BATCH)
      .execute();
    for (const r of rows) {
      const m = exact.exec(r.barcode_key);
      if (m !== null) return Number(m[1]);
    }
    if (rows.length < SCAN_BATCH) return 0;
    high = rows[rows.length - 1]!.barcode_key;
    inclusive = false;
  }
}

/** What the test hook after the maximum read gets. */
export interface AfterMaxRead {
  pattern: BarcodePattern;
  max: number;
}

let afterMaxRead: ((trx: Transaction<DB>, o: AfterMaxRead) => Promise<void>) | null = null;

/**
 * Test hook (ruling R57: test profile only): `fn` runs in the numbering's transaction right after the maximum was read,
 * so a test can land a "concurrent" manual create between the read and the inserts. Null removes it.
 *
 * @throws TypeError outside the test profile
 */
export function __setBarcodeAfterMaxRead(fn: ((trx: Transaction<DB>, o: AfterMaxRead) => Promise<void>) | null): void {
  if (typeof __BUILD_PROFILE__ === 'undefined' || __BUILD_PROFILE__ !== 'test') throw new TypeError('__setBarcodeAfterMaxRead() exists in the test profile only');
  afterMaxRead = fn;
}

/**
 * The next `count` free barcodes of `pattern` (see the top of this file), in `trx`, which must hold the pattern's
 * lock row until it has inserted them: the first statement takes that lock. On MySQL/MariaDB the snapshot of a
 * transaction's reads is fixed by its first plain read, so the lock must come before any: call it before the
 * transaction reads anything (batchCreateItems takes the lock as its own first statement). `skipped` lists the
 * candidates found taken at their check (B4).
 *
 * @throws TypeError when the lock row is absent (ensureBarcodeLockRow was not called first), for a pattern that does
 *   not parse, or a count outside 1-10 000; DomainError VALIDATION_FAILED `{path: 'patternId', code: 'exhausted'}`
 *   when the pattern has no free number left
 */
export async function nextBarcodes(trx: Transaction<DB>, pattern: BarcodePattern, count: number): Promise<{ barcodes: string[]; skipped: string[] }> {
  const parsed = BarcodePattern.safeParse(pattern);
  if (!parsed.success) throw new TypeError('nextBarcodes(): the pattern is not a catalog.barcode.patterns entry');
  const p = parsed.data;
  if (!Number.isInteger(count) || count < 1 || count > NEXT_MAX) throw new TypeError(`nextBarcodes(): count must be an integer in 1-${NEXT_MAX}, got ${count}`);
  if ((await lockBarcodePattern(trx, p.id)) === 0) {
    throw new TypeError(`nextBarcodes(): the lock row ${barcodeLockName(p.id)} is absent; call ensureBarcodeLockRow() before the transaction`);
  }
  const max = await maxNumber(trx, p);
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    if (afterMaxRead !== null) await afterMaxRead(trx, { pattern: p, max });
  }
  const last = 10 ** p.digits - 1;
  const barcodes: string[] = [];
  const skipped: string[] = [];
  for (let n = max + 1; barcodes.length < count; n += 1) {
    if (n > last) {
      throw new DomainError('VALIDATION_FAILED', {
        detail: 'Nomor pola barkod sudah habis / The barcode pattern has no numbers left',
        meta: { errors: [{ path: 'patternId', code: 'exhausted' }] },
      });
    }
    const candidate = barcodeOf(p, n);
    if (barcodeProblem(candidate) !== null) continue;
    const taken = await trx.selectFrom('items').select('id').where('barcode_key', '=', candidate).executeTakeFirst();
    if (taken === undefined) barcodes.push(candidate);
    else skipped.push(candidate);
  }
  return { barcodes, skipped };
}
