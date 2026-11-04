import { withTx, type DbHandle } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { errorFields, type CoreLogger } from '../context.js';
import { notify } from '../notifications/service.js';

// A full disk or an exhausted quota (P21, Review Focus 3): "di operasi mana pun" the partial files go, then a
// notification and a Diagnostik warning (`disk.lowAt`, S25, read from the newest `notification.disk_low`). Every
// operation that writes much (a backup, a prepared download, an upload, a restore) tells such a failure apart with
// {@link isDiskQuota} and reports it with {@link notifyDiskLow}.
//
// The file system says ENOSPC or EDQUOT; the platform helpers turn that into DomainError `DISK_QUOTA`. A database
// writing its own files says it in its own words, which packages/db leaves as they are:
// - SQLite (node:sqlite `errcode`, the extended result code): SQLITE_FULL (13, the primary code in the low byte), and
//   SQLITE_IOERR_WRITE (778), which the unix VFS returns for a write refused with EDQUOT (only ENOSPC becomes
//   SQLITE_FULL there), so on a cPanel quota it is the usual answer;
// - MySQL/MariaDB (mysql2 `errno`): ER_DISK_FULL (1021), ER_RECORD_FILE_FULL (1114, "The table is full"), and a write
//   error (EE_WRITE 3, ER_ERROR_ON_WRITE 1026) whose text names OS errno 28 (ENOSPC) or 122 (EDQUOT);
// - PostgreSQL (pg `code`, the SQLSTATE): 53100 disk_full (PostgreSQL reports ENOSPC and EDQUOT so).
// An error wrapping one of these as its `cause` counts too (a few levels deep): a failed migration is a MigrationError
// whose cause is packages/db's safe copy of the driver error (`{code, errno, sqlState}`, node:sqlite's errcode as errno).

/** SQLite primary result code SQLITE_FULL. */
const SQLITE_FULL = 13;
/** SQLite extended result code SQLITE_IOERR_WRITE. */
const SQLITE_IOERR_WRITE = 778;
/** MySQL/MariaDB errnos of a full disk or table. */
const MYSQL_FULL: ReadonlySet<number> = new Set([1021, 1114]);
/** MySQL/MariaDB errnos of a failed write whose text carries the OS errno. */
const MYSQL_WRITE: ReadonlySet<number> = new Set([3, 1026]);
/** "OS errno 28 - No space left on device", "Errcode: 122 - Disk quota exceeded". */
const OS_NO_SPACE = /\b(?:errno|errcode):?\s*(?:28|122)\b/i;
/** PostgreSQL SQLSTATE disk_full. */
const PG_DISK_FULL = '53100';
/** How many `cause` links are followed. */
const CAUSE_DEPTH = 4;

interface ErrorShape {
  code?: unknown;
  errno?: unknown;
  errcode?: unknown;
  severity?: unknown;
  sqlMessage?: unknown;
  message?: unknown;
  cause?: unknown;
}

function fullDisk(s: ErrorShape): boolean {
  const code = s.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return true;
  if (code === 'ERR_SQLITE_ERROR') {
    // packages/db's safe copy of a driver error (a MigrationError's cause) reports node:sqlite's `errcode` as `errno`.
    const errcode = typeof s.errcode === 'number' ? s.errcode : s.errno;
    return typeof errcode === 'number' && ((errcode & 0xff) === SQLITE_FULL || errcode === SQLITE_IOERR_WRITE);
  }
  if (code === PG_DISK_FULL) return true;
  if (typeof s.errno === 'number' && typeof code === 'string' && code.startsWith('E')) {
    if (MYSQL_FULL.has(s.errno)) return true;
    if (MYSQL_WRITE.has(s.errno)) {
      const text = typeof s.sqlMessage === 'string' ? s.sqlMessage : typeof s.message === 'string' ? s.message : '';
      return OS_NO_SPACE.test(text);
    }
  }
  return false;
}

/**
 * Whether `error` is a full disk or an exhausted quota (P21): DomainError `DISK_QUOTA`, the file system's ENOSPC or
 * EDQUOT, or a database driver's own report of it (see the top of this file), also as the `cause` of another error.
 * Any other DomainError is not, whatever its cause.
 */
export function isDiskQuota(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH && typeof e === 'object' && e !== null; depth += 1) {
    if (isDomainError(e)) return e.code === 'DISK_QUOTA';
    const s = e as ErrorShape;
    if (fullDisk(s)) return true;
    e = s.cause;
  }
  return false;
}

/**
 * `notification.disk_low` to the holders of `system.diagnostics.read` (the warning Diagnostik and the dashboard show),
 * in a transaction of its own. Best effort: a failure is logged, never thrown, so the caller's own error comes out.
 */
export async function notifyDiskLow(h: DbHandle, now: number, log?: CoreLogger): Promise<void> {
  try {
    await withTx(h, (trx) =>
      notify(trx, { audience: { permission: 'system.diagnostics.read' }, type: 'disk.low', titleKey: 'notification.disk_low.title', link: '/admin/diagnostics' }, now),
    );
  } catch (error) {
    log?.warn('the disk_low notification failed', errorFields(error));
  }
}

/**
 * Runs `fn`; a full disk it fails with ({@link isDiskQuota}) is reported with {@link notifyDiskLow} before the error
 * goes on, unchanged. For operations that are not a transaction themselves (no `withTx` around the call: R37).
 */
export async function reportingDiskLow<T>(h: DbHandle, now: number, fn: () => Promise<T>, log?: CoreLogger): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isDiskQuota(error)) await notifyDiskLow(h, now, log);
    throw error;
  }
}
