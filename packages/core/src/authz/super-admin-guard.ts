import { countRows, type DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Transaction } from 'kysely';

// Anti-escalation rule 6 (spec §7.2): "minimal 1 super admin aktif", checked in the same transaction as the change,
// with the lock order of controller ruling B4 / decision D14.
//
// Two transactions that each disable a different one of the last two super admins must not both commit. Each takes
// the guard row first: `UPDATE roles SET updated_at = updated_at WHERE key = 'super_admin'` is a locking write (an
// exclusive row lock on MySQL/MariaDB and PostgreSQL, without FOR UPDATE and so without a dialect branch; SQLite is
// already serialized by BEGIN IMMEDIATE), so the second waits there until the first has committed or rolled back.
// Only then come the caller's reads and writes and, last, the count.
//
// The order matters on MySQL/MariaDB REPEATABLE READ: the read view of a transaction is created by its first plain
// SELECT, and every later plain SELECT (the count included) reads that snapshot. A transaction that read anything
// before it took the lock would count from a snapshot older than the other transaction's commit and miss its disable.
// Taking the lock as the very first statement means the snapshot is created after the previous holder committed.
// PostgreSQL READ COMMITTED takes a new snapshot per statement, so the count sees the commit there in any case.

/**
 * Runs `fn` (the reads and writes that may remove an active super admin: a disable, a role replacement, the test
 * branch route) between the guard-row lock and the rule 6 count, in `trx`:
 *
 * 1. `UPDATE roles SET updated_at = updated_at WHERE key = 'super_admin'`, the guard-row lock;
 * 2. `fn()`;
 * 3. the number of active staff users (`status = 'active'`) with a global assignment of the system role
 *    `super_admin`; below 1 → DomainError `LAST_SUPER_ADMIN` (409), and the caller's transaction rolls back.
 *
 * **Call it as the first statement of the transaction**, before any other read or write (code review item: Kysely
 * cannot tell whether a statement ran before; the concurrent test in super-admin-guard.test.ts fails when the order
 * is broken on MySQL/MariaDB). The HTTP framework runs nothing in a handler's transaction before the handler (Task 7).
 *
 * @returns what `fn` returned
 * @throws DomainError LAST_SUPER_ADMIN; whatever `fn` throws, unchanged (the count is then not run); TypeError when
 *   `trx` is not a transaction
 */
export async function guardSuperAdmins<T>(trx: Transaction<DB>, fn: () => Promise<T>): Promise<T> {
  if ((trx as { isTransaction?: unknown }).isTransaction !== true) {
    throw new TypeError('guardSuperAdmins() runs inside the caller\'s transaction: pass the trx of withTx(), not a database handle');
  }
  await trx
    .updateTable('roles')
    .set((eb) => ({ updated_at: eb.ref('updated_at') }))
    .where('key', '=', 'super_admin')
    .execute();
  const result = await fn();
  const active = await countRows(
    trx
      .selectFrom('staff_users as u')
      .innerJoin('user_roles as ur', 'ur.user_id', 'u.id')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .where('r.key', '=', 'super_admin')
      .where('r.is_system', '=', 1)
      .where('ur.scope_key', '=', '')
      .where('u.status', '=', 'active'),
  );
  if (active < 1) {
    throw new DomainError('LAST_SUPER_ADMIN', {
      detail:
        'Perubahan ini akan meninggalkan instans tanpa super admin aktif / ' +
        'This change would leave the instance without an active super admin',
    });
  }
  return result;
}
