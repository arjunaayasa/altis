import {
  base32Encode,
  createPasswordHasher,
  createSession,
  ensureSystemRoles,
  generateTotpSecret,
  randomToken,
  readSettings,
  sealValue,
  secretAad,
  sha256hex,
  type KeyringEntry,
} from '@altis/core';
import { withTx, type DbHandle } from '@altis/db';
import { newId, normalizeKey, type Permission, type SystemRoleKey } from '@altis/shared';
import type { Config } from '../src/config.js';
import { csrfKey, sessionCsrfToken } from '../src/http/csrf.js';

// Staff users and sessions for the HTTP tests (Task 13), written straight into the database: no route runs, so a
// test can seed exactly the account state it needs (a role at one branch, 2FA enabled, a pending password change).
//
// seedStaff hashes the password with the real hasher (scrypt, so about 0.1 s per user). A TOTP secret is sealed with
// TEST_KEYRING unless a keyring is given: an app that must open it (2FA routes) runs on a config with that keyring.

/** A keyring for the tests whose app opens a sealed TOTP secret: `sampleConfig({keyring: TEST_KEYRING})`. */
export const TEST_KEYRING: readonly KeyringEntry[] = Object.freeze([
  Object.freeze({ kid: 'TESTKEY0000001', key: Buffer.alloc(32, 7).toString('base64url'), active: true }),
]);

/** One role assignment of {@link seedStaff}. */
export interface SeedRole {
  /** A system role (`super_admin`, `admin`); otherwise a new custom role holding `permissions`. */
  key?: SystemRoleKey;
  /** The permissions of the new custom role (ignored with `key`). */
  permissions?: Permission[];
  /** The branch of the assignment; null or absent for a global one. */
  branchId?: string | null;
  /** The new custom role requires 2FA (`roles.mfa_required`; ignored with `key`). */
  mfaRequired?: boolean;
}

export interface SeedStaffOptions {
  username: string;
  /** Default: a random one (returned). */
  password?: string;
  roles?: SeedRole[];
  /** 2FA enabled: a new secret sealed in `totp_secret_enc` (its plaintext the base32 text), `totp_enabled = 1`. */
  totp?: boolean;
  /** `staff_users.mfa_required`. */
  mfaRequired?: boolean;
  /** `staff_users.must_change_password`. */
  mustChangePassword?: boolean;
  /** `staff_users.totp_reenroll`. */
  totpReenroll?: boolean;
  /** Default `active`. */
  status?: string;
  /** What seals the TOTP secret; default {@link TEST_KEYRING}. */
  keyring?: readonly KeyringEntry[];
  /** `created_at` of the rows; default `Date.now()`. */
  now?: number;
}

export interface SeededStaff {
  id: string;
  password: string;
  /** The raw TOTP secret (20 bytes) with `totp: true`. */
  totpSecret?: Uint8Array;
}

const hasher = createPasswordHasher();

/**
 * A staff user with the given account state and role assignments: `username_key` is `normalizeKey(username)`, the
 * name is the username. A system role row is created first when missing (ensureSystemRoles); every other entry gets
 * a custom role of its own (key `t_<ulid>`) with `permissions` in role_permissions.
 */
export async function seedStaff(h: DbHandle, o: SeedStaffOptions): Promise<SeededStaff> {
  const now = o.now ?? Date.now();
  const id = newId();
  const password = o.password ?? `pw-${randomToken(12)}`;
  const passwordHash = await hasher.hash(password);
  const totpSecret = o.totp === true ? generateTotpSecret() : undefined;
  const flag = (b: boolean | undefined): number => (b === true ? 1 : 0);

  await withTx(h, async (trx) => {
    await trx
      .insertInto('staff_users')
      .values({
        id,
        username_key: normalizeKey(o.username),
        username_display: o.username,
        name: o.username,
        password_hash: passwordHash,
        status: o.status ?? 'active',
        totp_secret_enc:
          totpSecret === undefined
            ? null
            : sealValue(o.keyring ?? TEST_KEYRING, secretAad('staff_users', 'totp_secret_enc', id), base32Encode(totpSecret)),
        totp_enabled: flag(o.totp),
        totp_reenroll: flag(o.totpReenroll),
        mfa_required: flag(o.mfaRequired),
        must_change_password: flag(o.mustChangePassword),
        created_at: now,
        updated_at: now,
      })
      .execute();

    for (const role of o.roles ?? []) {
      let roleId: string;
      if (role.key !== undefined) {
        await ensureSystemRoles(trx, now);
        roleId = (await trx.selectFrom('roles').select('id').where('key', '=', role.key).executeTakeFirstOrThrow()).id;
      } else {
        roleId = newId();
        await trx
          .insertInto('roles')
          .values({ id: roleId, key: `t_${roleId}`, name: `Peran ${roleId}`, mfa_required: flag(role.mfaRequired), created_at: now, updated_at: now })
          .execute();
        const permissions = [...new Set(role.permissions ?? [])];
        if (permissions.length > 0) {
          await trx
            .insertInto('role_permissions')
            .values(permissions.map((permission) => ({ role_id: roleId, permission })))
            .execute();
        }
      }
      const branchId = role.branchId ?? null;
      await trx
        .insertInto('user_roles')
        .values({ id: newId(), user_id: id, role_id: roleId, branch_id: branchId, scope_key: branchId ?? '', created_at: now })
        .execute();
    }
  });

  return totpSecret === undefined ? { id, password } : { id, password, totpSecret };
}

export interface SessionCookieOptions {
  /** Default true (a full session); false makes a pre-2FA one. */
  mfaPassed?: boolean;
  /** Default null. */
  reauthAt?: number | null;
  /** Creation time; default `Date.now()`. */
  now?: number;
  /** Default: the stored `security.session_idle_minutes` (30 when unset) × 60 000. */
  idleMs?: number;
}

/**
 * A new session of staff user `userId` at the user's current `authz_version`, and its token: the value of the
 * `altis_sid` cookie (named `__Host-altis_sid` under an https baseUrl). {@link sessionCsrfFor} gives its CSRF token.
 */
export async function sessionCookieFor(h: DbHandle, userId: string, o: SessionCookieOptions = {}): Promise<string> {
  const user = await h.db.selectFrom('staff_users').select('authz_version').where('id', '=', userId).executeTakeFirstOrThrow();
  const idleMs =
    o.idleMs ?? Number((await readSettings(h.db, ['security.session_idle_minutes'], []))['security.session_idle_minutes']) * 60_000;
  const session = await withTx(h, (trx) =>
    createSession(trx, {
      subjectId: userId,
      mfaPassed: o.mfaPassed ?? true,
      authzVersion: Number(user.authz_version),
      ip: null,
      userAgent: null,
      now: o.now ?? Date.now(),
      idleMs,
      reauthAt: o.reauthAt ?? null,
    }),
  );
  return session.token;
}

/** The `X-CSRF-Token` of the session whose token is `token`, under `config`'s sessionKey. */
export function sessionCsrfFor(config: Config, token: string): string {
  return sessionCsrfToken(csrfKey(config), sha256hex(token));
}
