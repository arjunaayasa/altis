import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import {
  SCHEDULES,
  acceptChunk,
  base32Decode,
  base32Encode,
  beginTotpSetup,
  completeUpload,
  createPasswordHasher,
  createUpload,
  ensureSystemRoles,
  generateTotpSecret,
  hotp,
  openAltisbakWriter,
  randomToken,
  sealValue,
  secretAad,
  seedSchedules,
  sha256hex,
  startPasswordReset,
  totpStep,
  txCtx,
  uploadContext,
  uploadOwner,
  writeSettings,
  type KeyringEntry,
} from '@altis/core';
import { withTx, type DbHandle } from '@altis/db';
import { dataPath } from '@altis/platform';
import { OP_KIND_PERMISSION, newId, normalizeKey, permissionCatalog, systemRolePermissions, type Permission } from '@altis/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { cookieName, isSecureBase } from '../src/http/cookies.js';
import { csrfKey, opsCsrfToken, preSessionCsrfToken } from '../src/http/csrf.js';
import type { RouteDecl } from '../src/http/route.js';
import { createAgent, type AgentReply } from './agent.js';
import { CATALOG_MATRIX } from './matrix/catalog.js';
import { KOMUNITAS_MATRIX, KOMUNITAS_SYSTEM_ROUTES } from './matrix/komunitas.js';
import { removeOp, writeOp } from './ops-support.js';
import { sessionCookieFor, sessionCsrfFor } from './support-auth.js';
import { releasePackage, stagedUpdateUpload } from './update-support.js';

// The permission matrix (spec §7.2 "Deny by default", acceptance A4; 1b decision D43, B7; 1c Task 33 with M38): who may
// pass the declarative gate (step 9) of every route in ALL_ROUTES.
//
// - A persona is one kind of caller. `anonymous` has no session; `ops_cookie` has no session either, only the
//   `altis_ops` cookie of the current op (an active fake op the matrix makes for its call, opsCookieOp); `partial_mfa`
//   is a pre-2FA session of a user with TOTP enabled (stage `mfa`), `partial_setup` one of a user whose role requires
//   2FA and who has not enrolled (stage `mfa_setup`); `none` a full session without any role; `admin` and
//   `super_admin` the system roles; `perm:P` a custom role holding P alone, assigned globally. Both partial personas
//   are as powerful as a super admin once they pass their second factor, so the matrix shows the stage gate refusing
//   them before any permission is looked at. Every full session was re-authenticated at the request's time (§7.3);
//   every persona sends a valid CSRF token (the session's, the op's on an ops route for `ops_cookie`, or the
//   pre-session double submit) and the Origin of baseUrl, so step 8 never decides the outcome.
// - MATRIX_FIXTURES gives, per route id and in the order of the route catalog, what to send: the path parameters, the
//   query, the body and any header of the route's own (the bearer token of `/_cron`). A fixture creates the harmless
//   targets it needs (a role-less user, an unheld custom role, a non-default branch), reads `version` fields first so
//   that PATCH bodies pass Zod (S13), and shapes the call for the persona making it so that an allowed persona's call
//   can succeed (a valid TOTP code of its own secret, its own password). The audit-once test calls every audited route
//   that way as a fresh super admin. A fixture that makes an op current says whose permission its kind needs (`op`).
// - The outcome is read from the middleware, not from the status (B7): under the test profile a step-9 denial carries
//   `X-Altis-Test-Gate: <code>` (AUTH_REQUIRED and, M38, OPS_AUTH_REQUIRED → unauthenticated, AUTH_MFA_REQUIRED → mfa,
//   AUTHZ_DENIED → denied), the install gate's 404 carries `NOT_FOUND` (→ gone, M38), and a request that passed the
//   gate carries `X-Altis-Test-Gate: PASSED`, whatever the handler answered then. A response without the header never
//   reached the gate (a 404 of a wrong path, a 405, a 429 of step 6, a 503, a refusal at step 8): `gate:missing`,
//   never `allowed` (T31).

/** The personas of the matrix besides `perm:<P>` (see the top of this file). */
export const BASE_PERSONAS = Object.freeze(['anonymous', 'ops_cookie', 'partial_mfa', 'partial_setup', 'none', 'admin', 'super_admin'] as const);

export type Persona = (typeof BASE_PERSONAS)[number] | `perm:${Permission}`;

/** What the gate decided for one call; `gone` is the install gate's 404 once installed (1c Task 10, M38). */
export type Outcome = 'allowed' | 'unauthenticated' | 'mfa' | 'denied' | 'gone';

/** Every persona: the base ones, then `perm:P` for each permission of the catalog (test profile: the test one too). */
export function allPersonas(): Persona[] {
  return [...BASE_PERSONAS, ...permissionCatalog().map((def): Persona => `perm:${def.key}`)];
}

export function isPartial(p: Persona): p is 'partial_mfa' | 'partial_setup' {
  return p === 'partial_mfa' || p === 'partial_setup';
}

/** Whether `p` calls without any session (`anonymous`, and `ops_cookie`, whose only credential is `altis_ops`). */
export function sessionless(p: Persona): p is 'anonymous' | 'ops_cookie' {
  return p === 'anonymous' || p === 'ops_cookie';
}

/** Whether a full session of `p` holds `permission` (`super_admin` all, `admin` the admin set, `perm:P` only P). */
export function holds(p: Persona, permission: Permission): boolean {
  if (p === 'super_admin' || p === 'admin') return systemRolePermissions(p).includes(permission);
  if (p.startsWith('perm:')) return p.slice('perm:'.length) === permission;
  return false;
}

/**
 * The permissions of the op kinds (spec §9.4 `ops/takeover`: `update`/`rollback` → `system.update.run`, `restore` →
 * `system.backup.restore`, `backup` → `system.backup.create`), any of which opens an `opsAuth` route to a session when no
 * op is current. Written out here, not read from the code under test (http/ops-auth.ts OPS_ANY_PERMISSIONS, which the
 * matrix test pins to this list).
 */
export const OPS_KIND_PERMISSIONS: readonly Permission[] = Object.freeze(['system.update.run', 'system.backup.restore', 'system.backup.create']);

/**
 * The gate outcome `decl` must give `p`, with `op` the permission of the current op's kind when the call's fixture made
 * one current (an `opsAuth` route), in this order:
 *
 * 1. a wizard route answers 404 to everyone once installed (the matrix app is): `gone` (M38; Tasks 10 and 27 test the
 *    claimed path);
 * 2. a public route without a required session is open to everyone (`cron.run` too: it checks its bearer token
 *    after the gate);
 * 3. an `opsAuth` route opens to `ops_cookie`, the cookie of the current op, except a `reauth` one (`ops/cancel`,
 *    `ops/takeover`), which the cookie alone never opens (§9.4: reauth and the op kind's permission);
 * 4. without a session (`anonymous`, `ops_cookie`): `unauthenticated` (OPS_AUTH_REQUIRED on an ops route counts so, M38);
 * 5. a pre-2FA session outside `partialAuth`: `mfa`;
 * 6. a permission route: whether `p` holds the permission;
 * 7. an `opsAuth` route: whether `p` holds `op`, or without a current op any of the three op permissions (§9.4; `admin`
 *    holds `system.backup.create`);
 * 8. any other route needs a session only: `allowed`.
 */
export function expected(decl: RouteDecl, p: Persona, op?: Permission): Outcome {
  if (decl.install !== undefined) return 'gone';
  if (decl.public === true && (decl.session ?? 'optional') !== 'required') return 'allowed';
  if (decl.opsAuth === true && p === 'ops_cookie') return decl.reauth === true ? 'unauthenticated' : 'allowed';
  if (sessionless(p)) return 'unauthenticated';
  if (isPartial(p) && decl.partialAuth !== true) return 'mfa';
  if (decl.permission !== undefined) return holds(p, decl.permission) ? 'allowed' : 'denied';
  if (decl.opsAuth === true) return (op === undefined ? OPS_KIND_PERMISSIONS : [op]).some((perm) => holds(p, perm)) ? 'allowed' : 'denied';
  return 'allowed';
}

/** The outcome a response's `X-Altis-Test-Gate` names; any other gate code comes back as `gate:<code>`. */
export function outcomeOf(gate: string | null): Outcome | `gate:${string}` {
  switch (gate) {
    case 'PASSED':
      return 'allowed';
    case null:
      return 'gate:missing';
    case 'AUTH_REQUIRED':
    case 'OPS_AUTH_REQUIRED': // M38: an ops route without a session or an altis_ops cookie
      return 'unauthenticated';
    case 'AUTH_MFA_REQUIRED':
      return 'mfa';
    case 'AUTHZ_DENIED':
      return 'denied';
    case 'NOT_FOUND':
      return 'gone';
    default:
      return `gate:${gate}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Seeding

/** The password of every persona and target (its hash is computed once per process). */
export const PERSONA_PASSWORD = 'matriks-kunci-pintu-7';
/** A password that passes the policy, for the routes that set one. */
export const NEW_PASSWORD = 'matriks-kunci-baru-8';

const hasher = createPasswordHasher();
let passwordHash: Promise<string> | undefined;

/** The hash of {@link PERSONA_PASSWORD}: scrypt once, then shared by every seeded user. */
function personaPasswordHash(): Promise<string> {
  passwordHash ??= hasher.hash(PERSONA_PASSWORD);
  return passwordHash;
}

/** A staff user seeded for a persona: its credentials, and the raw TOTP secret when 2FA is enabled. */
export interface PersonaUser {
  id: string;
  username: string;
  password: string;
  totpSecret?: Uint8Array;
}

/** What every seeding helper takes: the database, the time of the rows, and the keyring that seals TOTP secrets. */
export interface SeedContext {
  h: DbHandle;
  now: number;
  keyring: readonly KeyringEntry[];
  /** The app's DATA_DIR: the ops fixtures write its ops/op.json, the upload fixtures stage files there. */
  dataDir?: string;
}

/** The TOTP code of `secret` at `now`. */
export function totpCode(secret: Uint8Array, now: number): string {
  return hotp(secret, totpStep(now), 6);
}

/** `secret` sealed as `staff_users.totp_secret_enc` of `userId` (its base32 text, as auth/2fa/setup stores it). */
function sealTotp(s: SeedContext, userId: string, secret: Uint8Array): string {
  return sealValue(s.keyring, secretAad('staff_users', 'totp_secret_enc', userId), base32Encode(secret));
}

/** The id of the system role `key`, created first when missing. */
async function systemRoleId(h: DbHandle, key: 'super_admin' | 'admin', now: number): Promise<string> {
  return withTx(h, async (trx) => {
    await ensureSystemRoles(trx, now);
    return (await trx.selectFrom('roles').select('id').where('key', '=', key).executeTakeFirstOrThrow()).id;
  });
}

/** A custom role holding `permissions` (none by default), nobody holding it; its id and `version`. */
export async function seedRole(
  s: SeedContext,
  o: { permissions?: readonly Permission[]; mfaRequired?: boolean } = {},
): Promise<{ id: string; version: number }> {
  const id = newId();
  const name = `Peran Matriks ${id.slice(-10)}`;
  await withTx(s.h, async (trx) => {
    await trx
      .insertInto('roles')
      .values({ id, key: normalizeKey(name), name, mfa_required: o.mfaRequired === true ? 1 : 0, created_at: s.now, updated_at: s.now })
      .execute();
    const permissions = [...new Set(o.permissions ?? [])];
    if (permissions.length > 0) {
      await trx.insertInto('role_permissions').values(permissions.map((permission) => ({ role_id: id, permission }))).execute();
    }
  });
  const row = await s.h.db.selectFrom('roles').select('version').where('id', '=', id).executeTakeFirstOrThrow();
  return { id, version: Number(row.version) };
}

/** A non-default, active branch; its id and `version`. */
export async function seedBranch(s: SeedContext): Promise<{ id: string; version: number }> {
  const id = newId();
  const code = `M${id.slice(-12)}`;
  await s.h.db
    .insertInto('branches')
    .values({
      id,
      code_key: normalizeKey(code),
      code_display: code,
      name: `Cabang ${code}`,
      timezone: 'Asia/Jakarta',
      created_at: s.now,
      updated_at: s.now,
    })
    .execute();
  const row = await s.h.db.selectFrom('branches').select('version').where('id', '=', id).executeTakeFirstOrThrow();
  return { id, version: Number(row.version) };
}

/** One role assignment of a seeded user: the role, globally (`branchId` null) or at a branch. */
export interface SeedAssignment {
  roleId: string;
  branchId: string | null;
}

/**
 * A staff user with {@link PERSONA_PASSWORD}: `active` unless told otherwise, an e-mail address when asked for, TOTP
 * enabled with a new secret when asked for, and the given role assignments. Its id, username, address and `version`.
 */
export async function seedUser(
  s: SeedContext,
  o: { prefix?: string; status?: 'active' | 'disabled'; email?: boolean; totp?: boolean; roles?: readonly SeedAssignment[] } = {},
): Promise<PersonaUser & { email: string | null; version: number }> {
  const id = newId();
  const username = `${o.prefix ?? 'm'}_${id.slice(-10).toLowerCase()}`;
  const email = o.email === true ? `${username}@example.test` : null;
  const totpSecret = o.totp === true ? generateTotpSecret() : undefined;
  const hash = await personaPasswordHash();
  await withTx(s.h, async (trx) => {
    await trx
      .insertInto('staff_users')
      .values({
        id,
        username_key: normalizeKey(username),
        username_display: username,
        name: username,
        email_key: email === null ? null : normalizeKey(email),
        email_display: email,
        password_hash: hash,
        status: o.status ?? 'active',
        totp_secret_enc: totpSecret === undefined ? null : sealTotp(s, id, totpSecret),
        totp_enabled: totpSecret === undefined ? 0 : 1,
        created_at: s.now,
        updated_at: s.now,
      })
      .execute();
    for (const a of o.roles ?? []) {
      await trx
        .insertInto('user_roles')
        .values({ id: newId(), user_id: id, role_id: a.roleId, branch_id: a.branchId, scope_key: a.branchId ?? '', created_at: s.now })
        .execute();
    }
  });
  const row = await s.h.db.selectFrom('staff_users').select('version').where('id', '=', id).executeTakeFirstOrThrow();
  const version = Number(row.version);
  return { id, username, password: PERSONA_PASSWORD, email, version, ...(totpSecret === undefined ? {} : { totpSecret }) };
}

/** The staff user of persona `p` (see the top of this file); null for the sessionless `anonymous` and `ops_cookie`. */
export async function seedPersona(s: SeedContext, p: Persona): Promise<PersonaUser | null> {
  const prefix = `m_${p.replace(/[^A-Za-z0-9]/g, '_')}`.slice(0, 40);
  switch (p) {
    case 'anonymous':
    case 'ops_cookie':
      return null;
    case 'none':
      return seedUser(s, { prefix });
    case 'admin':
    case 'super_admin':
      return seedUser(s, { prefix, roles: [{ roleId: await systemRoleId(s.h, p, s.now), branchId: null }] });
    case 'partial_mfa': {
      const superAdmin = await systemRoleId(s.h, 'super_admin', s.now);
      return seedUser(s, { prefix, totp: true, roles: [{ roleId: superAdmin, branchId: null }] });
    }
    case 'partial_setup': {
      const role = await seedRole(s, { permissions: permissionCatalog().map((def) => def.key), mfaRequired: true });
      return seedUser(s, { prefix, roles: [{ roleId: role.id, branchId: null }] });
    }
    default: {
      const role = await seedRole(s, { permissions: [p.slice('perm:'.length) as Permission] });
      return seedUser(s, { prefix, roles: [{ roleId: role.id, branchId: null }] });
    }
  }
}

/** The account columns a route can change on its caller (a password, 2FA, the profile), as seeded. */
export type UserSnapshot = Awaited<ReturnType<typeof snapshotUsers>>;

/** The columns of `ids` that {@link restoreUsers} puts back. */
export async function snapshotUsers(h: DbHandle, ids: readonly string[]) {
  return h.db
    .selectFrom('staff_users')
    .select([
      'id',
      'name',
      'locale',
      'email_key',
      'email_display',
      'password_hash',
      'status',
      'totp_secret_enc',
      'totp_enabled',
      'totp_last_step',
      'totp_reenroll',
      'mfa_required',
      'must_change_password',
    ])
    .where('id', 'in', [...ids])
    .execute();
}

/**
 * Puts the snapshot's columns back and deletes the users' recovery codes: what one route did to its callers (a new
 * password, 2FA switched on or off) does not carry over to the next route.
 */
export async function restoreUsers(h: DbHandle, snapshot: UserSnapshot): Promise<void> {
  await withTx(h, async (trx) => {
    for (const { id, ...columns } of snapshot) await trx.updateTable('staff_users').set(columns).where('id', '=', id).execute();
    if (snapshot.length > 0) {
      await trx
        .deleteFrom('staff_recovery_codes')
        .where(
          'user_id',
          'in',
          snapshot.map((row) => row.id),
        )
        .execute();
    }
  });
}

/** Switches TOTP on for `userId` with a new secret (no code of it used yet); the raw secret. */
async function enableTotpFor(s: SeedContext, userId: string): Promise<Uint8Array> {
  const secret = generateTotpSecret();
  await s.h.db
    .updateTable('staff_users')
    .set({
      totp_secret_enc: sealTotp(s, userId, secret),
      totp_enabled: 1,
      totp_last_step: 0,
      totp_reenroll: 0,
    })
    .where('id', '=', userId)
    .execute();
  return secret;
}

/** The DATA_DIR of `s` (the ops and upload fixtures need the app's). */
function dataDirOf(s: SeedContext): string {
  if (s.dataDir === undefined) throw new Error('this fixture needs the SeedContext dataDir of the app');
  return s.dataDir;
}

/** A `test.slices` job (test profile) in `status`, created by nobody; its id. */
export async function seedJob(s: SeedContext, status: 'queued' | 'dead'): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('jobs')
    .values({
      id,
      type: 'test.slices',
      payload: JSON.stringify({ slices: 1, k: 1 }),
      status,
      run_at: s.now,
      attempts: status === 'dead' ? 5 : 0,
      max_attempts: 5,
      last_error: status === 'dead' ? 'INTERNAL' : null,
      created_by: null,
      created_at: s.now,
      updated_at: s.now,
      finished_at: status === 'dead' ? s.now : null,
    })
    .execute();
  return id;
}

/** An `ok` backup row (no files: the preparation route only queues its job); its id. */
export async function seedOkBackup(s: SeedContext): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('backups')
    .values({ id, kind: 'manual', size: 1, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: s.h.dialect, consistency: 'frozen', status: 'ok', created_at: s.now })
    .execute();
  return id;
}

/**
 * A completed upload (context `backup`) of `userId` holding an `.altisbak` of another installation (its header and a
 * manifest entry), staged in the app's DATA_DIR for `POST backups/upload`; the upload id.
 */
export async function stagedArchive(s: SeedContext, userId: string): Promise<string> {
  const dataDir = dataDirOf(s);
  const folder = newId();
  const file = dataPath(dataDir, 'tmp', folder, 'archive.altisbak');
  const writer = await openAltisbakWriter(file, {
    header: {
      format: 'altis-backup/1',
      backupId: newId(),
      appVersion: '0.1.0',
      schemaVersion: '0009_ops_jobs',
      dialect: 'mysql',
      consistency: 'snapshot',
      secrets: 'keyring',
      encryption: null,
    },
    dek: null,
    checkpoint: null,
  });
  const manifest = Buffer.from('{}');
  await writer.writeEntry(
    'manifest.json',
    manifest.byteLength,
    async function* (from) {
      yield manifest.subarray(from);
    },
    { deadline: Number.POSITIVE_INFINITY },
  );
  await writer.finish();
  const bytes = await fsp.readFile(file);
  await fsp.rm(dataPath(dataDir, 'tmp', folder), { recursive: true, force: true });
  const owner = uploadOwner(userId);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const context = uploadContext('backup')!;
  const { id } = await withTx(s.h, (trx) => createUpload(trx, { owner, context, size: bytes.byteLength, sha256, now: s.now, dataDir }));
  await acceptChunk(s.h, { id, owner, n: 0, data: bytes, now: s.now, dataDir });
  await completeUpload(s.h, { id, owner, now: s.now, dataDir });
  return id;
}

/** What the `ops_cookie` persona holds: the `altis_ops` token of the current op, and that op's id. */
export interface OpsCookie {
  token: string;
  opId: string;
}

/**
 * Makes an active op current in `dataDir` for the `ops_cookie` persona; its cookie. The op is an `update` in
 * `needs_attention` that left `checking` (1d T33-OPS-COOKIE-OP-UPDATE-KIND, decision D1d-34): this release steps
 * updates now, but no step (`ops/drive` without `resume`, `/_cron`) moves an op that needs attention, and one that left
 * `checking` holds no maintenance flag (judged by its `stateBefore`, S4), so none is written or raised: every route keeps
 * answering as without maintenance. Remove it (removeOp) after the call.
 */
export async function opsCookieOp(dataDir: string, now: number): Promise<OpsCookie> {
  const { op, token } = await writeOp(dataDir, { kind: 'update', state: 'needs_attention', stateBefore: 'checking', at: now });
  return { token, opId: op.opId };
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

/** What a fixture is given: where to seed, and who calls (the caller's session already exists). */
export interface MatrixSeed extends SeedContext {
  persona: Persona;
  /** The caller's account; null for `anonymous` and `ops_cookie`. */
  user: PersonaUser | null;
}

/** What to send for one call. */
export interface MatrixCall {
  /** The values of the path's `:name` parameters, and `*` for a trailing wildcard. */
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  /** Headers of the route's own (`/_cron`'s bearer token); they win over the persona's. */
  headers?: Record<string, string>;
  /** The permission of the kind of the op the fixture made current: what expected() then asks of a session. */
  op?: Permission;
}

export type MatrixFixture = (seed: MatrixSeed) => Promise<MatrixCall>;

const none: MatrixFixture = async () => ({});

/** A code no seeded secret is checked against: for callers whose call cannot pass a second factor anyway. */
const WRONG_CODE = '000000';

/**
 * The caller's TOTP code at `now`: a full persona without 2FA gets it switched on first, with a new secret (put back
 * before the next route); a partial persona or a sessionless one gets {@link WRONG_CODE} (the gate stops them first).
 */
async function ownTotpCode(s: MatrixSeed): Promise<string> {
  if (s.user === null || isPartial(s.persona)) return WRONG_CODE;
  return totpCode(s.user.totpSecret ?? (await enableTotpFor(s, s.user.id)), s.now);
}

/** A role-less user to act on, as `:id`. */
const targetUser =
  (o: { status?: 'active' | 'disabled'; totp?: boolean } = {}): MatrixFixture =>
  async (s) => ({ params: { id: (await seedUser(s, { prefix: 'sasaran', ...o })).id } });

/** A unique suffix for names and codes the routes create. */
const unique = (): string => newId().slice(-10).toLowerCase();

/** `fixture` with no op at all in the app's DATA_DIR. */
const withoutOp =
  (fixture: MatrixFixture): MatrixFixture =>
  async (s) => {
    await removeOp(dataDirOf(s));
    return fixture(s);
  };

/** A frozen backup op is current: a session needs its kind's permission, `system.backup.create`. */
const withBackupOp: MatrixFixture = async (s) => {
  await writeOp(dataDirOf(s), { kind: 'backup', state: 'exporting', at: s.now });
  return { op: OP_KIND_PERMISSION.backup };
};

/**
 * The fixture of every route, by route id, in the order of the route catalog: the 1b catalog's API routes, the 1c
 * catalog, the 1b catalog's pages, then the test-profile routes (1b's, 1c's). One per entry of ALL_ROUTES.
 */

export const MATRIX_FIXTURES: Record<string, MatrixFixture> = {
  health: none,

  // ---- 1b: auth ----
  'auth.login': async (s) => ({
    body:
      s.user === null
        ? { username: 'tamu_tak_dikenal', password: 'bukan-sandi-siapa-pun' }
        : { username: s.user.username, password: s.user.password },
  }),
  'auth.2fa.verify': async (s) => ({
    // partial_mfa completes its sign-in; a full session has nothing to verify; mfa_setup is refused by the handler.
    body: { code: s.user?.totpSecret === undefined ? WRONG_CODE : totpCode(s.user.totpSecret, s.now) },
  }),
  'auth.logout': none,
  'auth.me': none,
  'auth.me.update': async () => ({ body: { name: 'Nama Matriks', locale: 'en' } }),
  'auth.password.change': async (s) => ({ body: { current: s.user?.password ?? PERSONA_PASSWORD, next: NEW_PASSWORD } }),
  // An address of its own per call: `forgot:email` allows one request per address in 5 minutes.
  'auth.password.forgot': async () => ({ body: { email: `tak-terdaftar-${unique()}@example.test` } }),
  'auth.password.reset': async (s) => {
    const target = await seedUser(s, { prefix: 'lupa', email: true });
    const started = await withTx(s.h, (trx) => startPasswordReset(trx, { email: target.email!, now: s.now }));
    if (started === null) throw new Error('fixture auth.password.reset: the reset did not start');
    return { body: { token: started.token, password: NEW_PASSWORD } };
  },
  'auth.2fa.setup': none,
  'auth.2fa.enable': async (s) => {
    const user = s.user;
    if (user === null || user.totpSecret !== undefined) return { body: { code: WRONG_CODE } };
    // What POST auth/2fa/setup does, then the code of that secret (partial_mfa, already enrolled, is refused by stage).
    const actor = { type: 'staff', id: user.id, ip: null } as const;
    const setup = await withTx(s.h, (trx) =>
      beginTotpSetup(txCtx(trx, s.now, actor), user.id, { keyring: s.keyring, issuer: 'Perpustakaan Matriks' }),
    );
    return { body: { code: totpCode(base32Decode(setup.secret), s.now) } };
  },
  'auth.2fa.disable': async (s) => ({ body: { password: s.user?.password ?? PERSONA_PASSWORD, code: await ownTotpCode(s) } }),
  'auth.2fa.recovery_codes': async (s) => {
    await ownTotpCode(s); // new codes need 2FA enabled
    return {};
  },
  'auth.sessions.list': none,
  'auth.sessions.revoke': async (s) => {
    if (s.user === null) return { params: { id: sha256hex(randomToken(32)) } };
    // Another sign-in of the caller (the one on another device it ends).
    return { params: { id: sha256hex(await personaSession(s.h, s.user, { now: s.now })) } };
  },
  'auth.reauth': async (s) => ({ body: { password: s.user?.password ?? PERSONA_PASSWORD } }),

  // ---- 1b: users, permissions and roles ----
  'permissions.list': none,
  'users.list': async () => ({ query: { q: 'sasaran', pageSize: '10' } }),
  'users.get': targetUser(),
  'users.create': async () => ({ body: { username: `baru_${unique()}`, name: 'Pengguna Baru', password: NEW_PASSWORD } }),
  'users.update': async (s) => {
    const target = await seedUser(s, { prefix: 'sasaran' });
    return { params: { id: target.id }, body: { version: target.version, name: 'Nama Diubah' } };
  },
  'users.disable': targetUser(),
  'users.enable': targetUser({ status: 'disabled' }),
  'users.password.reset': targetUser(),
  'users.2fa.reset': targetUser({ totp: true }),
  'users.roles.put': async (s) => {
    const target = await seedUser(s, { prefix: 'sasaran' });
    const role = await seedRole(s);
    return { params: { id: target.id }, body: { assignments: [{ roleId: role.id, branchId: null }] } };
  },
  'roles.list': none,
  'roles.get': async (s) => ({ params: { id: (await seedRole(s, { permissions: ['system.users.read'] })).id } }),
  'roles.create': async () => ({ body: { name: `Peran Baru ${unique()}`, permissions: [] } }),
  'roles.update': async (s) => {
    const role = await seedRole(s);
    return { params: { id: role.id }, body: { version: role.version, description: 'Diubah oleh matriks' } };
  },
  'roles.delete': async (s) => ({ params: { id: (await seedRole(s)).id } }),

  // ---- 1b: branches ----
  'branches.list': async () => ({ query: { includeArchived: 'true' } }),
  'branches.create': async () => ({ body: { code: `B-${unique()}`, name: 'Cabang Baru', timezone: 'Asia/Jakarta' } }),
  'branches.update': async (s) => {
    const branch = await seedBranch(s);
    return { params: { id: branch.id }, body: { version: branch.version, name: 'Cabang Diubah' } };
  },
  'branches.archive': async (s) => ({ params: { id: (await seedBranch(s)).id } }),

  // ---- 1b: settings and system configuration: bodies that change nothing (the audit entry is still written) ----
  'settings.get': async () => ({ params: { group: 'library' } }),
  'settings.security.put': async () => ({ body: {} }),
  'settings.library.put': async () => ({ body: {} }),
  'settings.email.put': async () => ({ body: {} }),
  'settings.opac.put': async () => ({ body: {} }),
  // ---- Phase 2 (catalog): Task 2 ----
  'settings.catalog.put': async () => ({ body: {} }),
  'catalog.config': none,
  // ---- Komunitas K1 (settings) ----
  'settings.accreditation.put': async () => ({ body: {} }),
  // ---- Komunitas (circulation core) ----
  'settings.circulation.put': async () => ({ body: {} }),
  'settings.members.put': async () => ({ body: {} }),
  'system.config.get': none,
  'system.config.put': async () => ({ body: {} }),
  'system.config.email_test': async () => ({ body: { to: 'uji@example.test' } }),
  'system.cron_token.rotate': none,

  // ---- 1b: audit ----
  'audit.list': async () => ({ query: { limit: '10' } }),
  'audit.verify': none,
  'audit.export': async () => ({ query: { action: 'audit.export' } }),

  // ---- 1c: the cron call ----
  // Public at the gate (`auth: 'bearer'`: no cookie read); every persona sends config.json's current token (the
  // cron-token rotation above changed it): the first call runs a pass (no op, no runtime), the others are 202 busy.
  'cron.run': async (s) => {
    const config = await loadConfig(dataDirOf(s), {});
    if (config === null) throw new Error('fixture cron.run: no config.json in the app DATA_DIR');
    return { headers: { authorization: `Bearer ${config.secrets.cronToken}` } };
  },

  // ---- 1c: jobs and schedules ----
  // get and drive name an unknown job (404 after the gate); retry gets a dead and cancel a queued `test.slices` job
  // (handler permission `system.jobs.manage`), so an allowed super admin's call succeeds (the audit-once test); the
  // schedule update switches the seeded `retention.events` on (no change).
  'jobs.list': async () => ({ query: { limit: '10' } }),
  'jobs.get': async () => ({ params: { id: newId() } }),
  'jobs.retry': async (s) => ({ params: { id: await seedJob(s, 'dead') } }),
  'jobs.cancel': async (s) => ({ params: { id: await seedJob(s, 'queued') } }),
  'jobs.drive': async () => ({ params: { id: newId() } }),
  'schedules.list': none,
  'schedules.update': async (s) => {
    await withTx(s.h, (trx) => seedSchedules(trx, s.now, 'Asia/Jakarta', SCHEDULES));
    return { params: { name: 'retention.events' }, body: { enabled: true } };
  },

  // ---- 1c: ops ----
  // Without an op every session that passes the gate gets 404 OPS_NONE after it (the operations page: "no
  // operation"); cancel and takeover (reauth: every persona session is re-authenticated) get an active frozen backup,
  // so they need `system.backup.create` and an allowed super admin's call succeeds (the audit-once test). The
  // `ops_cookie` persona's own op replaces either for its call (the matrix makes it).
  'ops.current': withoutOp(none),
  'ops.drive': withoutOp(async () => ({ body: {} })),
  'ops.cancel': withBackupOp,
  'ops.takeover': withBackupOp,
  'ops.report': withoutOp(none),
  'ops.update_page': withoutOp(none),

  // ---- 1c: events and notifications ----
  // A poll of `system.status`, which every staff user may read; the stream gets a malformed cursor, so it answers
  // `event: expired` at once and ends (a stream that ran would hold the call open for 25 s). An unknown notification id
  // passes the gate and is then 404 to everyone.
  'events.poll': async () => ({ query: { channels: 'system.status' } }),
  'events.stream': async () => ({ query: { channels: 'system.status', cursor: 'x' } }),
  'notifications.list': async () => ({ query: { limit: '10' } }),
  'notifications.read': async () => ({ params: { id: newId() } }),
  'notifications.read_all': none,

  // ---- 1c: the system dashboard: every signed-in persona gets its own sections ----
  'dashboard.get': none,

  // ---- 1c: uploads and stored files ----
  // A 1-byte test-context declaration; the other calls name an upload or file nobody has (404 after the gate), and the
  // chunk route gets no multipart body (415 after the gate).
  'files.uploads.create': async () => ({ body: { context: 'test', size: 1, sha256: '0'.repeat(64) } }),
  'files.uploads.chunk': async () => ({ params: { id: newId(), n: '0' } }),
  'files.uploads.complete': async () => ({ params: { id: newId() }, body: {} }),
  'files.uploads.delete': async () => ({ params: { id: newId() } }),
  'files.get': async () => ({ params: { id: newId() } }),

  // ---- 1c: backups ----
  // The create: a worker run recorded at the matrix's clock makes it a snapshot backup, one queued job for every caller
  // (`uniqueKey 'backup:manual'`), so no op and no maintenance flag is left for the routes after it. The preparation
  // names an `ok` backup and asks for an unencrypted archive (no scrypt per persona), so an allowed super admin's call
  // queues its job; the download names a backup nobody prepared (409 after the gate); a caller holding
  // `system.backup.restore` uploads a completed staged `.altisbak` of its own, so a super admin's call registers it (the
  // others name an upload nobody has); the restore names a backup nobody has: a caller the gate lets through gets 404,
  // and no op (whose maintenance flag would close the routes after it) is ever begun.
  'backups.list': none,
  'backups.create': async (s) => {
    await withTx(s.h, (trx) => writeSettings(trx, { 'system.run.worker': s.now }, { keyring: [], now: s.now, actorId: null }));
    return { body: {} };
  },
  'backups.prepare_download': async (s) => ({ params: { id: await seedOkBackup(s) }, body: { unencrypted: true } }),
  'backups.download': async () => ({ params: { id: newId() } }),
  'backups.upload': async (s) => ({
    body: {
      uploadId: s.user !== null && !isPartial(s.persona) && holds(s.persona, 'system.backup.restore') ? await stagedArchive(s, s.user.id) : newId(),
    },
  }),
  'backups.restore': async () => ({ params: { id: newId() }, body: {} }),

  // ---- 1c: Diagnostik ----
  // The report; SSE left automatic (no probe needed, any runtime); a clock confirmation (every persona session is
  // re-authenticated); a clean browser-test result; the probes, whose SSE stream runs its 2 s for each allowed persona,
  // and whose chunk route gets no multipart body (415 after the gate).
  'diagnostics.get': none,
  'diagnostics.realtime': async () => ({ body: { sse: null } }),
  'diagnostics.clock_confirm': none,
  'diagnostics.probe_result': async () => ({
    body: {
      polling: true,
      sse: false,
      methods: { put: true, patch: true, delete: true },
      chunkBytes: null,
      xff: { cleanXff: [], forgedXff: ['203.0.113.77'], forgedDerived: '198.18.0.1' },
    },
  }),
  'diagnostics.probe.poll': none,
  'diagnostics.probe.sse': none,
  'diagnostics.probe.hmac': async () => ({ params: { nonce: 'Matrix_nonce-0123456789' } }),
  'diagnostics.probe.methods.post': none,
  'diagnostics.probe.methods.put': none,
  'diagnostics.probe.methods.patch': none,
  'diagnostics.probe.methods.delete': none,
  'diagnostics.probe.chunk': none,

  // ---- 1d: updates (Task 28) ----
  // No check has stored a release (the matrix app runs no job), so an allowed apply is 404 UPDATE_NONE and no op is ever
  // begun; the check only queues its job; without releases/current.json an allowed rollback is 409 ROLLBACK_UNAVAILABLE.
  // A caller holding `system.update.run` dry-runs an `update` upload of its own (a package signed with the dev key, which
  // matrix.test.ts gives the app as its package keys, declaring a Node.js no server runs, so the prechecks fail and no
  // headroom is proven): a super admin's call audits `update.upload` and changes nothing (the others name an upload
  // nobody has). The channel is set to what it is.
  'updates.get': none,
  'updates.check': none,
  'updates.apply': async () => ({ body: { version: '0.2.0-test' } }),
  'updates.status': withoutOp(none),
  'updates.upload': async (s) => ({
    body: {
      uploadId:
        s.user !== null && !isPartial(s.persona) && holds(s.persona, 'system.update.run')
          ? await stagedUpdateUpload({ h: s.h, dataDir: dataDirOf(s), now: s.now }, s.user.id, (await releasePackage({ meta: { minNode: '99.0.0' } })).zip)
          : newId(),
      dryRun: true,
    },
  }),
  'updates.rollback': none,
  'updates.channel': async () => ({ body: { channel: 'stable' } }),
  'updates.history': async () => ({ query: { limit: '10' } }),

  // ---- 1c: the install wizard: the matrix app is installed, so every persona gets the gate's 404 (`gone`) before
  // the body is looked at ----
  'install.page': none,
  'install.claim': async () => ({ body: { code: 'ABCDE-FGHJK-MNPQR-STVWX-YZ0123' } }),
  'install.checks': none,
  'install.exposure': async () => ({ body: { results: [] } }),
  'install.probe.poll': none,
  'install.probe.sse': none,
  'install.probe.hmac': async () => ({ params: { nonce: 'Matrix_nonce-0123456789' } }),
  'install.probe.methods.post': none,
  'install.probe.methods.put': none,
  'install.probe.methods.patch': none,
  'install.probe.methods.delete': none,
  'install.probe.chunk': none,
  'install.db_test': async () => ({ body: { db: { dialect: 'sqlite' } } }),
  'install.config': none,
  'install.migrate': none,
  'install.progress': none,
  'install.profile': none,
  'install.admin': none,
  'install.cron_test': none,
  'install.finish': none,

  // ---- 1b: pages (`session: 'none'`, never behind the gate) ----
  'admin.assets': async () => ({ params: { file: 'tidak-ada.js' } }),
  'admin.root': none,
  'admin.index': async () => ({ params: { '*': 'pengguna' } }),
  'legal.notices': none,
  'opac.assets': async () => ({ params: { file: 'tidak-ada.css' } }),
  'opac.home': none,

  // ---- test profile only ----
  // 1b (S14): a role without permissions, given at the branch of the path.
  'test.branch.user_roles': async (s) => {
    const branch = await seedBranch(s);
    const target = await seedUser(s, { prefix: 'sasaran' });
    const role = await seedRole(s);
    const assignments = [{ roleId: role.id, branchId: branch.id }];
    return { params: { branchId: branch.id }, body: { userId: target.id, assignments } };
  },
  // 1c (Task 13): queues a one-slice test job.
  'test.jobs.enqueue': async () => ({ body: { type: 'test.slices', payload: { slices: 1, k: 1 } } }),
  // ---- Phase 2 (catalog): Task 3 ----
  // The catalog routes' fixtures, one file per area (matrix/catalog-<area>.ts), at the place of their rows in CATALOG.
  ...CATALOG_MATRIX.fixtures,
  // ---- Komunitas K1 (reports and accreditation) ----
  // The community routes' fixtures, one file per area (matrix/komunitas-<area>.ts), at the place of their rows in CATALOG.
  ...KOMUNITAS_MATRIX.fixtures,
};

// ---------------------------------------------------------------------------------------------------------------
// The maintenance allowlist

/**
 * The `maintenance` of every route that is not `deny`, by route id: spec §9.4's allowlists as decision C20 and ruling
 * R1c-9 read them (maintenance-allowlist.test.ts holds every declaration to `EXPECTED_MAINTENANCE[id] ?? 'deny'`):
 * - `restore-allow`, open during a normal maintenance and during a restore: every `opsAuth` route (`/admin/_update`
 *   among them), `/_health` (which answers 503 `maintenance` itself during a restore), `POST /_cron` (it steps the op),
 *   and `auth/reauth` (R1c-9: the operations page re-authenticates through it; 409 OPS_POINT_OF_NO_RETURN past a
 *   restore's point of no return);
 * - `allow`, open during a normal maintenance only: `GET auth/me`, `POST auth/login|2fa/verify|logout`, `GET events*`,
 *   the admin and OPAC assets, the OPAC home, the admin shell (R1c-9: a signed-out admin reaches the sign-in screen),
 *   every wizard route (§9.4: `/install/api/*` during `install-migrate`; once installed they answer 404 anyway), and
 *   from Phase 2 `GET /files/:id` (what the OPAC pages embed) and every OPAC route;
 * - `deny` for everything else: R1c-12 keeps `diagnostics.get` and `dashboard.get` there.
 */
export const EXPECTED_MAINTENANCE: Readonly<Record<string, 'allow' | 'deny' | 'restore-allow'>> = Object.freeze({
  health: 'restore-allow',
  'cron.run': 'restore-allow',
  'ops.current': 'restore-allow',
  'ops.drive': 'restore-allow',
  'ops.cancel': 'restore-allow',
  'ops.takeover': 'restore-allow',
  'ops.report': 'restore-allow',
  'ops.update_page': 'restore-allow',
  'updates.status': 'restore-allow', // 1d Task 28: app.js's page and the server's follow an update through it
  'auth.reauth': 'restore-allow',
  'auth.me': 'allow',
  'auth.login': 'allow',
  'auth.2fa.verify': 'allow',
  'auth.logout': 'allow',
  'events.poll': 'allow',
  'events.stream': 'allow',
  'admin.assets': 'allow',
  'admin.root': 'allow',
  'admin.index': 'allow',
  'opac.assets': 'allow',
  'opac.home': 'allow',
  'install.page': 'allow',
  'install.claim': 'allow',
  'install.checks': 'allow',
  'install.exposure': 'allow',
  'install.probe.poll': 'allow',
  'install.probe.sse': 'allow',
  'install.probe.hmac': 'allow',
  'install.probe.methods.post': 'allow',
  'install.probe.methods.put': 'allow',
  'install.probe.methods.patch': 'allow',
  'install.probe.methods.delete': 'allow',
  'install.probe.chunk': 'allow',
  'install.db_test': 'allow',
  'install.config': 'allow',
  'install.migrate': 'allow',
  'install.progress': 'allow',
  'install.profile': 'allow',
  'install.admin': 'allow',
  'install.cron_test': 'allow',
  'install.finish': 'allow',
  // ---- Phase 2 ----
  // L10: `/files/:id` serves what the OPAC pages embed (covers, page images, floor plans, the viewer's media), and every
  // OPAC route is `allow` (spec §12.3).
  'files.get': 'allow',
  // ---- Phase 2 (catalog): Task 3 ----
  // The catalog routes that are not `deny` (every OPAC page, feed and OAI route is `allow`), from their area files.
  ...CATALOG_MATRIX.maintenance,
  // ---- Komunitas K1 (reports and accreditation) ----
  ...KOMUNITAS_MATRIX.maintenance,
});

// ---------------------------------------------------------------------------------------------------------------
// The `system` routes (an edition's gate keeps them open)

/**
 * Every route id declared `mode: 'system'` (1d Task 33, preflight 1D-13; matrix.test.ts holds the declared set equal
 * to this list, no more and no less). The edition gate (step 10, http/edition-gate.ts) sees `decl.mode`: a commercial
 * edition's gate may refuse `write` routes and must keep `system` ones open, so a write route declared `system` by
 * mistake would slip past it, and adding a `system` route needs a deliberate edit here. The list is spec §8.6's
 * Phase 1 `system` list mapped to route ids, line by line, plus the documented exceptions at the end; decision D1d-41
 * takes §8.6's list as exhaustive, so the other security routes (`users.password.reset`, `users.2fa.reset`,
 * `system.cron_token.rotate`, `system.config.put`) stay `write`.
 */
export const EXPECTED_SYSTEM_ROUTES: readonly string[] = Object.freeze([
  // §8.6 "semua `auth/*` (termasuk `PATCH auth/me`)"
  'auth.login',
  'auth.2fa.verify',
  'auth.logout',
  'auth.me',
  'auth.me.update',
  'auth.password.change',
  'auth.password.forgot',
  'auth.password.reset',
  'auth.2fa.setup',
  'auth.2fa.enable',
  'auth.2fa.disable',
  'auth.2fa.recovery_codes',
  'auth.sessions.list',
  'auth.sessions.revoke',
  'auth.reauth',
  // §8.6 "`POST backups`, `prepare-download`, `download`, `upload`, `restore`" (`GET backups` is `read`)
  'backups.create',
  'backups.prepare_download',
  'backups.download',
  'backups.upload',
  'backups.restore',
  // §8.6 "`GET audit/export`"
  'audit.export',
  // §8.6 "`diagnostics/*`"
  'diagnostics.get',
  'diagnostics.realtime',
  'diagnostics.clock_confirm',
  'diagnostics.probe_result',
  'diagnostics.probe.poll',
  'diagnostics.probe.sse',
  'diagnostics.probe.hmac',
  'diagnostics.probe.methods.post',
  'diagnostics.probe.methods.put',
  'diagnostics.probe.methods.patch',
  'diagnostics.probe.methods.delete',
  'diagnostics.probe.chunk',
  // §8.6 "`events`, `notifications` (baca/tandai dibaca)"
  'events.poll',
  'events.stream',
  'notifications.list',
  'notifications.read',
  'notifications.read_all',
  // §8.6 "`jobs/:id/drive`, `ops/*`, `POST /_cron`" (`/admin/_update` is an ops route: §9.2 step 6, `opsAuth`)
  'jobs.drive',
  'ops.current',
  'ops.drive',
  'ops.cancel',
  'ops.takeover',
  'ops.report',
  'ops.update_page',
  'cron.run',
  // §8.6 "menonaktifkan pengguna dan mencabut peran (tanpa membuat yang baru)": D36/M32
  'users.disable',
  'users.roles.put',
  // §8.6 "`system/config/email-test`"
  'system.config.email_test',
  // §8.6 "`updates/*` (hak update §8.5)"
  'updates.get',
  'updates.check',
  'updates.apply',
  'updates.status',
  'updates.upload',
  'updates.rollback',
  'updates.channel',
  'updates.history',
  // ---- Phase 2 (catalog): its spec §12.3 "`mode: system`" (D2-15: an edition never locks the data): an export, its
  // download and report, and the search index's rebuild stay open; every other catalog write is `write`.
  'catalog.exports.create',
  'catalog.runs.download',
  'catalog.runs.report',
  'catalog.search.reindex',
  // ---- Komunitas K1 (reports and accreditation) ----
  // §8.6 "Fase 3 dan seterusnya: tindakan PDP, ekspor data, dan laporan": the report runs, their download, and the
  // accreditation documents and a snapshot's dossier, from the area files' `systemRoutes`.
  ...KOMUNITAS_SYSTEM_ROUTES,
  // Exception: the upload routes. 1d's `backup` and `update` upload contexts (C7) serve the `system` uses above; Phase
  // 2's catalog contexts (an import file, a SLiMS dump and its files, an attachment) are only used by `write` routes,
  // which a gate refusing writes refuses too, so a file uploaded then serves nothing. The test context exists under the
  // test profile only.
  'files.uploads.create',
  'files.uploads.chunk',
  'files.uploads.complete',
  'files.uploads.delete',
  // Exception: the wizard. It runs before the installation is complete, and once installed the install gate answers 404
  // to every wizard route before the permission gate (1c Task 10, M38), so the edition gate (step 10) never decides one.
  'install.page',
  'install.claim',
  'install.checks',
  'install.exposure',
  'install.probe.poll',
  'install.probe.sse',
  'install.probe.hmac',
  'install.probe.methods.post',
  'install.probe.methods.put',
  'install.probe.methods.patch',
  'install.probe.methods.delete',
  'install.probe.chunk',
  'install.db_test',
  'install.config',
  'install.migrate',
  'install.progress',
  'install.profile',
  'install.admin',
  'install.cron_test',
  'install.finish',
  // Exception: the test-profile routes (never in a production build, S28).
  'test.branch.user_roles',
  'test.jobs.enqueue',
]);

// ---------------------------------------------------------------------------------------------------------------
// Calls

/** The URL of `decl` with the call's parameters and query. */
export function routeUrl(decl: RouteDecl, call: MatrixCall): string {
  // A parameter's own pattern (`:nonce{[A-Za-z0-9_-]{16,64}}`, 1c Task 27) goes with it.
  let path = decl.path.replace(/:([A-Za-z0-9_]+)(\{[^/]*\})?/g, (_, name: string) => {
    const value = call.params?.[name];
    if (value === undefined) throw new Error(`fixture ${decl.id}: no value for :${name}`);
    return encodeURIComponent(value);
  });
  if (path.endsWith('*')) path = `${path.slice(0, -1)}${call.params?.['*'] ?? ''}`;
  const query = new URLSearchParams(call.query ?? {}).toString();
  return query === '' ? path : `${path}?${query}`;
}

/**
 * Sends `call` to `decl` as a new browser at the peer address `o.peer`, holding the session `o.token` (`altis_sid`) or,
 * without one, a pre-session `altis_csrf` cookie, and with `o.ops` the `altis_ops` cookie of an op: with the CSRF token
 * that matches (on an ops route the op's own token for a sessionless caller, as /admin/_update sends it), `Origin` =
 * the origin of `config.baseUrl`, and the call's own headers over these.
 */
export async function sendCall(
  app: Hono<AppEnv>,
  config: Config,
  decl: RouteDecl,
  call: MatrixCall,
  o: { token: string | null; peer: string; ops?: OpsCookie | null },
): Promise<AgentReply> {
  const secure = isSecureBase(config.baseUrl);
  const agent = createAgent(app, { peer: o.peer, headers: { origin: new URL(config.baseUrl).origin } });
  let csrf: string;
  if (o.token === null) {
    const value = randomToken(32);
    agent.setCookie(cookieName('altis_csrf', secure), value);
    csrf = preSessionCsrfToken(csrfKey(config), value);
  } else {
    agent.setCookie(cookieName('altis_sid', secure), o.token);
    csrf = sessionCsrfFor(config, o.token);
  }
  if (o.ops !== undefined && o.ops !== null) {
    agent.setCookie(cookieName('altis_ops', secure), o.ops.token);
    if (o.token === null && decl.opsAuth === true) csrf = opsCsrfToken(csrfKey(config), o.ops.opId);
  }
  const url = routeUrl(decl, call);
  const headers = { 'x-csrf-token': csrf, ...call.headers };
  switch (decl.method) {
    case 'GET':
      return agent.get(url, undefined, headers);
    case 'POST':
      return agent.post(url, call.body, headers);
    case 'PUT':
      return agent.put(url, call.body, headers);
    case 'PATCH':
      return agent.patch(url, call.body, headers);
    case 'DELETE':
      return agent.delete(url, call.body, headers);
  }
}

/**
 * A new session of `user` created at `now`: a full one re-authenticated at `now`, or a pre-2FA one (`partial`, the
 * sessions of the partial personas). Its token (the `altis_sid` value).
 */
export async function personaSession(h: DbHandle, user: PersonaUser, o: { now: number; partial?: boolean }): Promise<string> {
  const partial = o.partial === true;
  return sessionCookieFor(h, user.id, { now: o.now, mfaPassed: !partial, reauthAt: partial ? null : o.now });
}
