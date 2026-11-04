import type { DB } from '@altis/db';
import { isLocale, type Locale } from '@altis/shared';
import type { SessionStage } from '@altis/shared/api/auth';
import type { Kysely, Transaction } from 'kysely';
import type { Grants } from '../authz/grants.js';
import type { SessionView } from './sessions.js';

// What the access layer knows about a staff user (spec §7.1): the account state that decides whether a session may
// be used and how far it got (S7, decision D39: core code needs it, and core never imports apps/server). The HTTP
// layer re-exports it (apps/server/src/http/auth.ts).

/** A staff user as the session and authorization layers see it; never the password hash or the TOTP secret. */
export interface StaffAuthView {
  id: string;
  /** `normalizeKey(username)`, what logins match on. */
  usernameKey: string;
  /** The username as typed when it was set. */
  username: string;
  name: string;
  email: string | null;
  /** null: the library's language (or a stored value that is not a known locale). */
  locale: Locale | null;
  /** `active` | `disabled` | `locked`. */
  status: string;
  totpEnabled: boolean;
  /** The TOTP secret must be enrolled again (set by a 1c restore): only a recovery code signs in. */
  totpReenroll: boolean;
  /** 2FA required by the user's own flag (a role may require it too: `Grants.roleMfaRequired`). */
  mfaRequired: boolean;
  mustChangePassword: boolean;
  authzVersion: number;
}

/** The staff user `userId` (any status), or null when there is none. */
export async function loadStaffAuthView(db: Kysely<DB> | Transaction<DB>, userId: string): Promise<StaffAuthView | null> {
  const r = await db
    .selectFrom('staff_users')
    .select([
      'id',
      'username_key',
      'username_display',
      'name',
      'email_display',
      'locale',
      'status',
      'totp_enabled',
      'totp_reenroll',
      'mfa_required',
      'must_change_password',
      'authz_version',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (r === undefined) return null;
  return {
    id: r.id,
    usernameKey: r.username_key,
    username: r.username_display,
    name: r.name,
    email: r.email_display,
    locale: r.locale !== null && isLocale(r.locale) ? r.locale : null,
    status: r.status,
    totpEnabled: Number(r.totp_enabled) === 1,
    totpReenroll: Number(r.totp_reenroll) === 1,
    mfaRequired: Number(r.mfa_required) === 1,
    mustChangePassword: Number(r.must_change_password) === 1,
    authzVersion: Number(r.authz_version),
  };
}

/**
 * Whether signing in as `user` needs a second factor (§7.1): TOTP enabled or to be enrolled again, or 2FA required
 * by the user's flag or by a role the user holds (at any scope).
 */
export function mfaNeeded(user: StaffAuthView, grants: Grants): boolean {
  return user.totpEnabled || user.totpReenroll || user.mfaRequired || grants.roleMfaRequired;
}

/**
 * How far `session` got: `full` once the second factor passed (or was not needed); otherwise `recovery` when the
 * TOTP secret must be enrolled again, `mfa` when TOTP is enabled, and `mfa_setup` (2FA required, not enrolled).
 * `grants` is part of the signature so that a later rule can look at the roles; today the stage follows from the
 * session and the user alone (a login that needs no second factor creates a session with 2FA passed).
 */
export function stageOf(user: StaffAuthView, grants: Grants, session: SessionView): SessionStage {
  if (session.mfaPassed) return 'full';
  if (user.totpReenroll) return 'recovery';
  if (user.totpEnabled) return 'mfa';
  return 'mfa_setup';
}

/**
 * Locks the staff user's row in `trx`: a write that changes nothing (`last_login_at = last_login_at`), as login's
 * transaction B and D14's guard. Every transaction that issues or revokes the user's sessions or remember-me tokens
 * runs it as its **first statement**: a password change or reset, a 2FA change or a disable writes the same row, so
 * the two transactions serialize, and on MySQL/MariaDB (REPEATABLE READ) the reads that follow see the latest commit.
 * An unknown id locks nothing.
 */
export async function lockStaffRow(trx: Transaction<DB>, userId: string): Promise<void> {
  await trx
    .updateTable('staff_users')
    .set((eb) => ({ last_login_at: eb.ref('last_login_at') }))
    .where('id', '=', userId)
    .execute();
}
