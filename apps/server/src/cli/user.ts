import {
  adminResetPassword,
  adminResetTotp,
  createPasswordHasher,
  runnerFor,
  temporaryPassword,
  type Actor,
  type CliActor,
  type TxRunner,
} from '@altis/core';
import { connect, type DbHandle } from '@altis/db';
import type { Env } from '@altis/platform';
import { DomainError, normalizeKey } from '@altis/shared';
import { loadConfig } from '../config.js';
import type { BootContext } from '../index.js';
import { notInstalled } from './migrate.js';

// The emergency recovery commands (spec §7.1 "Pemulihan darurat lewat CLI", §13.6):
//
//   user:reset-password <username>   a new temporary password (xxxx-xxxx-xxxx-xxxx), printed once
//   user:disable-2fa <username>      the user's 2FA removed
//
// Both reuse the users services of Task 19 with the CLI actor `{cli: true}` (decision D44: an operator with shell
// access to the install skips the anti-escalation rules 2-5, never rule 6), so their effects are the admin routes':
// the service locks the user's row before it reads anything, revokes every session and remember-me token of the
// user, and writes the audit entry (`users.password.reset`, `users.2fa.reset`) in the same transaction, with actor
// type `cli`. The user is found by the normalized username (normalizeKey: case, full-width letters and stray spaces
// do not matter); an unknown one is NOT_FOUND (exit 1).
//
// The temporary password is hashed before the transaction opens (S18: on SQLite a transaction holds the process's
// only connection). It is the only secret the CLI ever prints.

/** The users services' actor for the CLI (D44). */
const CLI: CliActor = { cli: true };
/** Who the audit entries name: the CLI, with no staff id and no client IP. */
const CLI_AUDIT_ACTOR: Actor = { type: 'cli', id: null, ip: null };
/** The width of `username_key`, in code points: a longer key names no account. */
const KEY_MAX = 191;

function userNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Pengguna tidak ditemukan / User not found' });
}

/**
 * The database of the installed DATA_DIR, as the server reaches it (config.json with the environment overrides).
 *
 * @throws DomainError `NOT_INSTALLED` (no config.json, or an install that did not finish), or what loadConfig and
 *   connect throw (`DB_UNAVAILABLE`, ...)
 */
async function openDatabase(ctx: BootContext, env: Env): Promise<DbHandle> {
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null || config.installState !== 'complete') throw notInstalled();
  return connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
}

/** The id of the staff user `username` (by its normalized key). @throws DomainError `NOT_FOUND` */
async function userIdOf(h: DbHandle, username: string): Promise<string> {
  const key = normalizeKey(username);
  if (key === '' || Array.from(key).length > KEY_MAX) throw userNotFound();
  const row = await h.db.selectFrom('staff_users').select('id').where('username_key', '=', key).executeTakeFirst();
  if (row === undefined) throw userNotFound();
  return row.id;
}

/** One transaction of the CLI (re-run as a whole on a conflict, R37). */
function cliRunner(h: DbHandle): TxRunner {
  return runnerFor(h, Date.now(), CLI_AUDIT_ACTOR);
}

/**
 * `user:reset-password <username>`: sets a new temporaryPassword() (exempt from the instance's minimum length, M9)
 * with `must_change_password = 1`, revokes every session and remember-me token of the user, deletes their reset
 * tokens, and audits `users.password.reset` (actor `cli`; never the password).
 *
 * @returns the temporary password, for the operator to hand over (shown once; only its hash is stored)
 * @throws DomainError `NOT_INSTALLED`, `NOT_FOUND`, `DB_UNAVAILABLE`, ...
 */
export async function resetUserPassword(ctx: BootContext, env: Env, username: string): Promise<{ temporaryPassword: string }> {
  const h = await openDatabase(ctx, env);
  try {
    const userId = await userIdOf(h, username);
    const password = temporaryPassword();
    const passwordHash = await createPasswordHasher().hash(password); // before the transaction (S18)
    await cliRunner(h)((tx) => adminResetPassword(tx, CLI, userId, { passwordHash }));
    return { temporaryPassword: password };
  } finally {
    await h.close();
  }
}

/**
 * `user:disable-2fa <username>`: removes the user's TOTP secret and recovery codes (`totp_enabled = 0`), revokes every
 * session and remember-me token, and audits `users.2fa.reset` (actor `cli`). When 2FA is still required (the user's
 * flag or a role), the next sign-in enrols again.
 *
 * @throws DomainError `NOT_INSTALLED`, `NOT_FOUND`, `DB_UNAVAILABLE`, ...
 */
export async function disableUserTotp(ctx: BootContext, env: Env, username: string): Promise<void> {
  const h = await openDatabase(ctx, env);
  try {
    const userId = await userIdOf(h, username);
    await cliRunner(h)((tx) => adminResetTotp(tx, CLI, userId));
  } finally {
    await h.close();
  }
}
