import { upsert, type DB } from '@altis/db';
import { DEFAULT_LOCALE, SYSTEM_ROLE_KEYS, newId, t, type SystemRoleKey } from '@altis/shared';
import type { Transaction } from 'kysely';

// The two system roles (spec §7.2, decision D5) are rows seeded by code, at install and at every boot, never by a
// migration: a migration-seeded row of a `data` table would collide with what a 1c restore loads. Their permissions
// are not stored (grants.ts computes them from the catalog); the row carries the key, the fixed name, `is_system = 1`
// and `mfa_required`, the one field an operator may change ("2FA wajib per peran").

/**
 * Makes sure `roles` has a row for each of `super_admin` and `admin`, in the caller's transaction: a missing row is
 * inserted (`is_system = 1`, `mfa_required = 0`, the name `t(DEFAULT_LOCALE, 'role.<key>')`, at `now`); an existing
 * row whose name or `is_system` differs is set back to them (`updated_at = now`, `version + 1`); `mfa_required` of an
 * existing row is never touched, and a row already as it should be is not written at all.
 *
 * Safe when processes boot together: the insert goes through the `upsert` primitive, so a row another transaction
 * inserted first is updated instead.
 *
 * @returns the keys of the rows it inserted, in {@link SYSTEM_ROLE_KEYS} order
 */
export async function ensureSystemRoles(trx: Transaction<DB>, now: number): Promise<{ created: SystemRoleKey[] }> {
  const created: SystemRoleKey[] = [];
  for (const key of SYSTEM_ROLE_KEYS) {
    const name = t(DEFAULT_LOCALE, `role.${key}`);
    const row = await trx.selectFrom('roles').select(['name', 'is_system']).where('key', '=', key).executeTakeFirst();
    if (row === undefined) {
      const outcome = await upsert(
        trx,
        'roles',
        { key },
        { id: newId(), name, description: null, is_system: 1, created_at: now, created_by: null, updated_at: now, updated_by: null },
        { name, is_system: 1 },
      );
      if (outcome === 'inserted') created.push(key);
    } else if (row.name !== name || row.is_system !== 1) {
      await trx
        .updateTable('roles')
        .set((eb) => ({ name, is_system: 1, updated_at: now, updated_by: null, version: eb('version', '+', 1) }))
        .where('key', '=', key)
        .execute();
    }
  }
  return { created };
}
