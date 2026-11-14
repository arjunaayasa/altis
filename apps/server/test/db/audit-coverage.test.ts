import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  COMMUNITY_EDITION,
  SCHEDULES,
  base32Decode,
  claimById,
  createGrantsCache,
  createJobRegistry,
  createSettingsCache,
  createUpdateSource,
  enqueue,
  ensureSystemRoles,
  notify,
  purgeAudit,
  runSlice,
  seedSchedules,
  snapshotBackupRunning,
  txCtx,
  writeSettings,
  type Mailer,
  type OpStatus,
  type OpsMachine,
  type UpdateKindDeps,
} from '@altis/core';
import { PHASE1_MIGRATIONS, connect, runMigrations, verifyAuditChain, withTx, type DbHandle } from '@altis/db';
import { readCurrentState, updateCurrentState } from '@altis/platform';
import { AUDIT_ACTIONS, type AuditAction } from '@altis/shared';
import type { InstallChecksResponse, MigrateResponse } from '@altis/shared/api/install';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext, testDbFor, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppEnv, type AppState } from '../../src/app.js';
import { runCli } from '../../src/cli/index.js';
import { writeConfig, type Config } from '../../src/config.js';
import { cookieName, isSecureBase } from '../../src/http/cookies.js';
import { csrfKey } from '../../src/http/csrf.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import type { RouteDecl } from '../../src/http/route.js';
import { start } from '../../src/index.js';
import { createJobRuntime, jobHandlers, opKinds, type JobRuntime } from '../../src/jobs/runtime.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { appPrecheck, createAppOps } from '../../src/services.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { PHASE2_AUDIT_SCRIPTS, PHASE2_PENDING_ALLOWED, type AuditBrowser, type AuditScriptContext } from '../audit/catalog.js';
import { K1_PENDING_ALLOWED, KOMUNITAS_AUDIT_SCRIPTS } from '../audit/komunitas.js';
import { MEMBERS_CIRCULATION_AUDIT_SCRIPTS, MEMBERS_CIRCULATION_PENDING_ALLOWED } from '../audit/members-circulation.js';
import { captureIo } from '../cli-support.js';
import { NEW_PASSWORD, PERSONA_PASSWORD, seedJob, seedUser, stagedArchive, totpCode, type SeedContext } from '../matrix-fixtures.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { bootContext, closeTestServers, recordingLogger, sampleConfig } from '../support.js';
import { DEV_KEYS, DEV_ROOTS, devPackageKeys, releasePackage, stagedUpdateUpload } from '../update-support.js';

// A10 on the engine picked by ALTIS_TEST_DB, in four parts:
//
// - 1b Task 31 (the access actions): a scripted run through the HTTP API, the way the admin SPA drives it (the CSRF
//   token from `auth/me` and from each response's `X-CSRF-Token`, the baseUrl's Origin), produces at least one audit
//   entry of every access action, while two child processes (login-child.mjs, mode `until-stop`) each sign a user in
//   again and again: the script starts once each child's first login has answered, and the children stop only after
//   it. Afterwards `GET audit/verify` answers `{ok: true}`, `audit_log.seq` runs 1..N without a gap, and a child's
//   entry lies between the script's first and last ones (T31: the three processes did append at the same time).
// - 1c Task 33 (the operations actions): a scripted run on an installation whose DATA_DIR the CLI shares (config.json
//   names the test database) produces at least one entry of every 1c action: the API calls of Diagnostik, the jobs and
//   schedules, two frozen backups (one taken over and cancelled from the operations page, one stepped to its end), its
//   download prepared, an archive uploaded (and uploaded again: ruling R1c-10's resend appends nothing and counts as
//   audited), the backup restored (the op writes `backup.restore`, C25), then `maintenance:on|off`, `secrets:rotate`,
//   the audit retention's run (the oldest entries are more than two years old) and `install:reset`. Every audited 1c
//   route appends exactly one entry of its action; afterwards `GET audit/verify` answers `{ok: true}` from the
//   retention anchor and `seq` has no gap.
// - 1d Task 33 (the update actions): a scripted run on an installation of its own (config.json names the test
//   database, so the CLI shares it) produces at least one entry of every 1d action: the update channel, an update
//   package uploaded (a dry run, then begun) and cancelled (the op writes `update.apply`, C25), the manual rollback
//   (`update.rollback`) and `release:unpin`; then the `audit.retention` job handler, run slice by slice through
//   runSlice, purges the oldest entries (`audit.purge`, T33-AUDIT-PURGE-VIA-HANDLER). Every audited 1d route appends
//   exactly one entry of its action and never answers AUDIT_MISSING (B4); `GET audit/verify` answers `{ok: true}` from
//   the retention anchor and `seq` has no gap.
// - 1c Task 33: a wizard run (start(), as app.js boots it) in a DATA_DIR of its own on an empty database: exactly one
//   `install.complete` and no licence entry. The chain verifies with `seq` 1..N.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes 64 MiB per new DATA_DIR (the backups, the restore and the wizard ask for headroom).
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past (an audit entry may not be dated ahead of the real clock); the run moves the clock on from here. */
const NOW = Date.UTC(2026, 9, 26, 10, 0, 5);
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
const ORIGIN = new URL(CONFIG.baseUrl).origin;
const API = '/api/v1';
/** The password `auth/password/reset` sets. */
const THIRD_PASSWORD = 'matriks-kunci-ketiga-9';

/** Every action the access part of A10 lists. */
const COVERED: readonly AuditAction[] = [
  'auth.login.success',
  'auth.login.failed',
  'auth.logout',
  'auth.2fa.enable',
  'auth.2fa.disable',
  'auth.password.reset',
  'auth.password.change',
  'authz.denied',
  'users.create',
  'users.update',
  'users.disable',
  'users.enable',
  'users.password.reset',
  'users.2fa.reset',
  'users.roles.update',
  'roles.create',
  'roles.update',
  'roles.delete',
  'branches.create',
  'branches.update',
  'branches.archive',
  'settings.update',
  'system.config.update',
  'system.config.email_test',
  'system.config.cron_token_rotate',
  'audit.export',
];

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A browser as the SPA uses it: its cookies, and the CSRF token it was last given. */
interface Browser {
  send(method: Method, url: string, body?: unknown): Promise<AgentReply>;
}

interface LoginReport {
  results: { status: number; code: string | null; stage: string | null }[];
}

/** How one child ended: its exit code and its report. */
interface ChildEnd {
  code: number | null;
  report: LoginReport | undefined;
}

/**
 * A fork of login-child.mjs per entry of `options`, each told to start once all report 'ready'. `started` settles once
 * every child's first login has answered; `stop()` tells them to finish (mode `until-stop`).
 */
async function startChildren(options: object[]): Promise<{ done: Promise<ChildEnd[]>; started: Promise<void>; stop(): void; kill(): void }> {
  const children: ChildProcess[] = [];
  const kill = (): void => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  try {
    const runs = options.map((o) => {
      const child = fork(path.join(import.meta.dirname, '../fixtures/login-child.mjs'), [JSON.stringify(o)], {
        cwd: path.resolve(import.meta.dirname, '../../../..'),
        env: process.env,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let report: LoginReport | undefined;
      let first!: () => void;
      const started = new Promise<void>((resolve, reject) => {
        first = resolve;
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before its first login answered`)));
      });
      started.catch(() => {}); // awaited below; a child that fails before it started is reported there
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else if (message === 'first') first();
          else report = message as LoginReport;
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
      });
      // 'close' comes after every IPC message has been delivered.
      const exited = new Promise<ChildEnd>((resolve) =>
        child.once('close', (code) => resolve({ code, report })),
      );
      return { child, ready, exited, started };
    });
    await Promise.all(runs.map((r) => r.ready));
    for (const r of runs) r.child.send('go');
    return {
      done: Promise.all(runs.map((r) => r.exited)),
      started: Promise.all(runs.map((r) => r.started)).then(() => undefined),
      stop: () => {
        for (const r of runs) if (r.child.connected) r.child.send('stop');
      },
      kill,
    };
  } catch (error) {
    kill();
    throw error;
  }
}

describe.skipIf(!ctx.available)(`audit coverage of the access actions [${engineLabel()}]`, () => {
  let root: string;
  let app: ReturnType<typeof createApp>;
  let runtime: JobRuntime | undefined;
  const clock = { now: NOW };
  const mails: { to: string; text: string }[] = [];
  let peerSerial = 0;

  const seed = (): SeedContext => ({ h, now: NOW, keyring: CONFIG.keyring });

  /** A new browser at a peer address of its own. */
  function browser(): Browser {
    peerSerial += 1;
    const agent = createAgent(app, { peer: `198.51.100.${peerSerial}`, headers: { origin: ORIGIN } });
    let csrf: string | undefined;
    return {
      async send(method, url, body) {
        if (csrf === undefined && method !== 'get') {
          // The SPA's first request: the pre-session token (D20).
          csrf = ((await agent.get(`${API}/auth/me`)).json as { csrfToken: string }).csrfToken;
        }
        const res = await agent[method](url, body, csrf === undefined ? {} : { 'x-csrf-token': csrf });
        csrf = res.headers.get('x-csrf-token') ?? csrf;
        return res;
      },
    };
  }

  /** A browser signed in as `username` (with a TOTP code of `secret` when 2FA asks for one), at stage `full`. */
  async function signIn(username: string, password: string, secret?: Uint8Array): Promise<Browser> {
    const b = browser();
    const res = await b.send('post', `${API}/auth/login`, { username, password });
    expect(res.status, res.text).toBe(200);
    if ((res.json as { stage: string }).stage === 'mfa') {
      if (secret === undefined) throw new Error(`${username} has 2FA on: signIn needs its secret`);
      const verified = await b.send('post', `${API}/auth/2fa/verify`, { code: totpCode(secret, clock.now) });
      expect(verified.status, verified.text).toBe(200);
    }
    const me = await b.send('get', `${API}/auth/me`);
    expect((me.json as { stage: string }).stage).toBe('full');
    return b;
  }

  /** `res` as JSON with the expected status. */
  function ok<T>(res: AgentReply, status = 200): T {
    expect(res.status, res.text).toBe(status);
    return res.json as T;
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-audit-coverage-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    const dataDir = path.join(root, 'data');
    await writeConfig(dataDir, CONFIG);
    const mailer: Mailer = {
      send: async (m) => {
        mails.push({ to: m.to, text: m.text });
      },
    };
    const state: AppState = { phase: 'ready', db: h, config: CONFIG };
    const log = recordingLogger();
    // 1c Task 18: the reset mail goes through the job queue; a passenger process drives it after the answer.
    runtime = createJobRuntime({
      state,
      runtime: 'passenger',
      env: {},
      dataDir,
      log,
      clock: () => clock.now,
      ops: createAppOps(state, { dataDir, version: '0.1.0', log, clock: () => clock.now }),
      handlers: jobHandlers({
        housekeeping: { dataDir, mailer, baseUrl: () => CONFIG.baseUrl, settings: createSettingsCache({ ttlMs: 0 }) },
      }),
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: '0.1.0',
    });
    state.jobs = runtime;
    app = createApp({
      state,
      version: '0.1.0',
      buildId: 'audit-coverage',
      log,
      clock: () => clock.now,
      env: {},
      dataDir,
      services: { mailer, emailTestMailer: { send: async () => {} } },
    });
  });

  afterAll(async () => {
    await runtime?.stop();
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('a scripted run writes every access action; with two processes signing in meanwhile the chain verifies, seq 1..N', async () => {
    const superAdminRole = await withTx(h, async (trx) => {
      await ensureSystemRoles(trx, NOW);
      return (await trx.selectFrom('roles').select('id').where('key', '=', 'super_admin').executeTakeFirstOrThrow()).id;
    });
    const sa = await seedUser(seed(), { prefix: 'kepala', roles: [{ roleId: superAdminRole, branchId: null }] });
    const budi = await seedUser(seed(), { prefix: 'budi', email: true });
    const runners = [await seedUser(seed(), { prefix: 'kilat' }), await seedUser(seed(), { prefix: 'kilat' })];

    const children = await startChildren(
      runners.map((u, i) => ({
        db: h.config,
        dataDir: h.dataDir,
        config: CONFIG,
        count: 10,
        username: u.username,
        password: u.password,
        peer: `203.0.113.${50 + i}`,
        now: NOW,
        mode: 'until-stop',
      })),
    );
    try {
      await children.started;
      // auth.login.failed
      const failed = await browser().send('post', `${API}/auth/login`, { username: budi.username, password: 'bukan-sandi-budi' });
      expect(failed.status).toBe(401);

      // auth.login.success, then 2FA switched on (auth.2fa.enable ends every session of budi, S11)
      const b1 = await signIn(budi.username, PERSONA_PASSWORD);
      const setup = ok<{ secret: string }>(await b1.send('post', `${API}/auth/2fa/setup`));
      const secret = base32Decode(setup.secret);
      ok(await b1.send('post', `${API}/auth/2fa/enable`, { code: totpCode(secret, clock.now) }));

      // A sign-in with the second factor, then 2FA switched off (auth.2fa.disable): each code from a later step.
      clock.now += 60_000;
      const b2 = await signIn(budi.username, PERSONA_PASSWORD, secret);
      clock.now += 60_000;
      ok(await b2.send('post', `${API}/auth/2fa/disable`, { password: PERSONA_PASSWORD, code: totpCode(secret, clock.now) }), 204);

      // auth.password.change, auth.logout
      const b3 = await signIn(budi.username, PERSONA_PASSWORD);
      ok(await b3.send('post', `${API}/auth/password/change`, { current: PERSONA_PASSWORD, next: NEW_PASSWORD }));
      ok(await b3.send('post', `${API}/auth/logout`), 204);

      // auth.password.reset through the mail's link
      ok(await browser().send('post', `${API}/auth/password/forgot`, { email: budi.email }), 202);
      // The mail goes out after the answer (D18).
      const mail = await vi.waitFor(
        () => {
          const sent = mails.find((m) => m.to === budi.email);
          if (sent === undefined) throw new Error('no reset mail yet');
          return sent;
        },
        { timeout: 10_000 },
      );
      const token = /#token=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
      expect(token).toBeDefined();
      ok(await browser().send('post', `${API}/auth/password/reset`, { token, password: THIRD_PASSWORD }));

      // authz.denied: budi holds no role
      const b4 = await signIn(budi.username, THIRD_PASSWORD);
      expect((await b4.send('get', `${API}/system/config`)).status).toBe(403);

      // The super admin, re-authenticated (§7.3)
      const admin = await signIn(sa.username, PERSONA_PASSWORD);
      ok(await admin.send('post', `${API}/auth/reauth`, { password: PERSONA_PASSWORD }));

      const user = ok<{ id: string; version: number }>(
        await admin.send('post', `${API}/users`, { username: 'petugas_baru', name: 'Petugas Baru', password: NEW_PASSWORD }),
        201,
      );
      ok(await admin.send('patch', `${API}/users/${user.id}`, { version: user.version, name: 'Petugas Sirkulasi' }));
      ok(await admin.send('post', `${API}/users/${user.id}/disable`));
      ok(await admin.send('post', `${API}/users/${user.id}/enable`));
      ok(await admin.send('post', `${API}/users/${user.id}/reset-password`));
      ok(await admin.send('post', `${API}/users/${user.id}/reset-2fa`));

      const role = ok<{ id: string; version: number }>(
        await admin.send('post', `${API}/roles`, { name: 'Petugas Sirkulasi', permissions: ['system.users.read'] }),
        201,
      );
      ok(await admin.send('put', `${API}/users/${user.id}/roles`, { assignments: [{ roleId: role.id, branchId: null }] }));
      ok(await admin.send('patch', `${API}/roles/${role.id}`, { version: role.version, description: 'Melayani peminjaman' }));
      const spare = ok<{ id: string }>(await admin.send('post', `${API}/roles`, { name: 'Peran Sementara', permissions: [] }), 201);
      ok(await admin.send('delete', `${API}/roles/${spare.id}`));

      const branch = ok<{ id: string; version: number }>(
        await admin.send('post', `${API}/branches`, { code: 'CAB-UTARA', name: 'Cabang Utara', timezone: 'Asia/Jakarta' }),
        201,
      );
      ok(await admin.send('patch', `${API}/branches/${branch.id}`, { version: branch.version, name: 'Cabang Utara Baru' }));
      ok(await admin.send('delete', `${API}/branches/${branch.id}`));

      ok(await admin.send('put', `${API}/settings/library`, { name: 'Perpustakaan Matriks' }));
      ok(
        await admin.send('put', `${API}/system/config`, {
          smtp: { host: 'smtp.example.test', port: 587, security: 'starttls', from: 'perpus@example.test' },
        }),
      );
      ok(await admin.send('post', `${API}/system/config/email-test`, { to: 'uji@example.test' }));
      ok(await admin.send('post', `${API}/system/cron-token/rotate`));
      ok(await admin.send('get', `${API}/audit/export`));

      children.stop();
      const ran = await children.done;
      expect(ran.map((r) => r.code)).toEqual([0, 0]);
      for (const r of ran) {
        const results = r.report?.results ?? [];
        expect(results.length).toBeGreaterThan(0);
        expect(results.filter((one) => one.status !== 200 || one.code !== null || one.stage !== 'full')).toEqual([]);
      }

      const rows = await h.db.selectFrom('audit_log').select(['seq', 'action', 'actor_id']).orderBy('seq').execute();
      const actions = new Set(rows.map((r) => r.action));
      expect(COVERED.filter((a) => !actions.has(a))).toEqual([]);
      runners.forEach((u, i) => {
        expect(rows.filter((r) => r.action === 'auth.login.success' && r.actor_id === u.id)).toHaveLength(ran[i]!.report!.results.length);
      });
      // The writers overlapped: a child's entry lies strictly between the script's first and last entries.
      const runnerIds = new Set(runners.map((u) => u.id));
      const fromChildren = (r: (typeof rows)[number]) => r.action === 'auth.login.success' && r.actor_id !== null && runnerIds.has(r.actor_id);
      const scripted = rows.filter((r) => !fromChildren(r)).map((r) => Number(r.seq));
      const [firstScripted, lastScripted] = [Math.min(...scripted), Math.max(...scripted)];
      expect(rows.filter(fromChildren).some((r) => Number(r.seq) > firstScripted && Number(r.seq) < lastScripted)).toBe(true);

      const verified = ok<{ ok: boolean; head: number }>(await admin.send('get', `${API}/audit/verify`));
      expect(verified).toEqual({ ok: true, head: rows.length });
      expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
    } finally {
      children.kill();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------
// 1c (Task 33): the operations actions, then the wizard's `install.complete`

/** Every action the 1c share of A10 lists, besides the wizard's `install.complete` (a DATA_DIR of its own, below). */
const COVERED_1C: readonly AuditAction[] = [
  'backup.create',
  'backup.download',
  'backup.upload',
  'backup.restore',
  'jobs.retry',
  'jobs.cancel',
  'schedules.update',
  'ops.cancel',
  'ops.takeover',
  'diagnostics.clock_confirm',
  'diagnostics.realtime',
  'diagnostics.probe_result',
  'maintenance.on',
  'maintenance.off',
  'system.secrets_rotate',
  'install.reset',
  'audit.purge',
];

/** The routes 1c added (the 1c catalog's ids, its test-profile route included). */
const PHASE_1C = /^(?:cron|jobs|schedules|ops|events|notifications|dashboard|files|backups|diagnostics|install|test\.jobs)\./;

const DAY_MS = 86_400_000;
const silentMailer: Mailer = { send: async () => {} };

/** A clean browser-test result (Diagnostik's and the wizard's probes): nothing spoofable, every method through. */
const PROBE_RESULTS = {
  polling: true,
  sse: false,
  methods: { put: true, patch: true, delete: true },
  chunkBytes: null,
  xff: { cleanXff: [], forgedXff: ['203.0.113.77'], forgedDerived: '198.18.0.1' },
};

function routeOf(id: string): RouteDecl {
  const decl = ALL_ROUTES.find((d) => d.id === id);
  if (decl === undefined) throw new Error(`no route ${id}`);
  return decl;
}

describe.skipIf(!ctx.available)(`audit coverage of the 1c actions [${engineLabel()}]`, () => {
  let root: string;
  let dataDir: string;
  let config: Config;
  let state: AppState;
  let ops: OpsMachine;
  let app: ReturnType<typeof createApp>;
  let superAdmin: string;
  /** How far the ops machine's clock runs ahead of the real one: the 3 s a freeze settles, skipped (restore-matrix). */
  let offset = 0;
  const log = recordingLogger();
  /** The audited 1c routes the run called, each checked to append exactly one entry of its action. */
  const exercised = new Set<string>();

  /** The live handle (on SQLite the restore swaps the file: the handle is closed and opened again). */
  const db = (): DbHandle => {
    if (state.db === undefined) throw new Error('the app has no live handle');
    return state.db;
  };
  const lastSeq = async (): Promise<number> =>
    Number((await db().db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);
  const actionsAfter = async (seq: number): Promise<string[]> =>
    (await db().db.selectFrom('audit_log').select('action').where('seq', '>', seq).orderBy('seq').execute()).map((r) => r.action);
  const seed = (): SeedContext => ({ h: db(), now: Date.now(), keyring: config.keyring, dataDir });

  beforeAll(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-audit-1c-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(path.join(root, 'home'));
    // The installation's own database (on SQLite its file lives in this DATA_DIR), which config.json names, so the CLI
    // commands of the run reach it too.
    const first = await testDbFor(ctx.engine, { dataDir });
    await runMigrations(first, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    config = sampleConfig({ db: first.config });
    await writeConfig(dataDir, config);
    // The oldest entries of the log are more than two years old: what the audit retention purges (a prefix by seq).
    const old = Date.now() - 3 * 365 * DAY_MS;
    await withTx(first, async (trx) => {
      for (let i = 0; i < 3; i += 1) {
        await txCtx(trx, old + i, { type: 'system', id: null, ip: null }).audit({ action: 'settings.update', entity: 'settings', entityId: null, meta: { seed: i } });
      }
      await writeSettings(trx, { 'library.name': 'Perpustakaan Audit' }, { keyring: config.keyring, now: Date.now(), actorId: null });
      await trx.updateTable('schema_meta').set({ install_id: config.install.id }).where('id', '=', 1).execute();
    });
    superAdmin = (await seedStaff(first, { username: 'kepala', password: PERSONA_PASSWORD, roles: [{ key: 'super_admin' }], keyring: config.keyring })).id;

    // The app as start() builds it on SQLite too (restore-matrix.test.ts): its ops machine with the restore's work file
    // and swap, which closes this process's handle before the swap and opens it again after; a fence that looks on
    // every request and drops the caches when the restore moves the data epoch.
    state = { phase: 'ready', db: first, config };
    let released = false;
    const own = {
      async close(): Promise<void> {
        await ops.close();
        const h = state.db;
        state.db = undefined;
        if (h === undefined) return;
        released = true;
        await h.close();
      },
      async reopen(): Promise<void> {
        if (!released || state.db !== undefined) return;
        state.db = await connect(first.config, { runtime: 'standalone', purpose: 'server', dataDir });
        released = false;
      },
    };
    ops = createAppOps(state, {
      dataDir,
      version: '0.1.0',
      log,
      clock: () => Date.now() + offset,
      runtime: 'standalone',
      kinds: opKinds({ appVersion: '0.1.0', config: () => state.config, dataDir, sqlite: { log, own } }),
    });
    const settings = createSettingsCache({ clock: () => Date.now() });
    const grants = createGrantsCache();
    const opsFence = createOpsFence({
      dataDir,
      intervalMs: 0,
      clock: () => Date.now(),
      onEpoch() {
        settings.invalidate();
        grants.clear();
      },
      onOpEnded() {},
    });
    app = createApp({
      state,
      version: '0.1.0',
      buildId: 'audit-1c',
      log,
      clock: () => Date.now(),
      env: {},
      dataDir,
      runtime: 'standalone',
      services: { ops, opsFence, settings, grants, mailer: silentMailer, emailTestMailer: silentMailer },
    });
  }, 120_000);

  afterAll(async () => {
    await ops?.close();
    await state?.db?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The super admin's browser: a session re-authenticated just now, its CSRF token kept from each response. */
  async function browser(): Promise<Browser> {
    const token = await sessionCookieFor(db(), superAdmin, { reauthAt: Date.now() });
    const agent = createAgent(app, { peer: '203.0.113.40', headers: { origin: new URL(config.baseUrl).origin } });
    agent.setCookie(cookieName('altis_sid', isSecureBase(config.baseUrl)), token);
    let csrf = sessionCsrfFor(config, token);
    return {
      async send(method, url, body) {
        const res = await agent[method](url, body, { 'x-csrf-token': csrf });
        csrf = res.headers.get('x-csrf-token') ?? csrf;
        return res;
      },
    };
  }

  /** The route `id` called at `url`: it must succeed and append exactly one entry of its declared action. */
  async function audited(b: Browser, id: string, url: string, body?: unknown): Promise<AgentReply> {
    const decl = routeOf(id);
    const before = await lastSeq();
    const res = await b.send(decl.method.toLowerCase() as Method, url, body);
    expect(res.status, `${id}: ${res.text}`).toBeLessThan(300);
    expect(
      (await actionsAfter(before)).filter((a) => a === decl.audit),
      id,
    ).toHaveLength(1);
    exercised.add(id);
    return res;
  }

  /** Steps the current op (the worker or `/_cron` would) until it ends; it must end `done`. */
  async function stepToEnd(opId: string): Promise<OpStatus> {
    offset += 4000;
    let status: OpStatus | null = null;
    for (let i = 0; i < 2000; i += 1) {
      status = await ops.step(20_000);
      if (status === null || status.terminal || status.needsAttention) break;
    }
    expect(status).toMatchObject({ opId, state: 'done' });
    return status!;
  }

  /** A CLI command on this DATA_DIR, as `node app.js <argv>` runs it; it must exit 0. */
  async function cli(argv: string[]): Promise<void> {
    const io = captureIo({ HOME: path.join(root, 'home') }, { hostPanels: () => [] });
    const code = await runCli(argv, bootContext(dataDir), io);
    expect(code, `${argv.join(' ')}: ${io.err}`).toBe(0);
  }

  it(
    'a scripted run writes every 1c action, each audited 1c route exactly once; the chain verifies, seq without a gap',
    async () => {
      const b = await browser();

      // Diagnostik.
      await audited(b, 'diagnostics.realtime', `${API}/diagnostics/realtime`, { sse: null });
      await audited(b, 'diagnostics.probe_result', `${API}/diagnostics/probe-result`, PROBE_RESULTS);
      await audited(b, 'diagnostics.clock_confirm', `${API}/diagnostics/clock-confirm`);

      // Jobs and schedules: a dead job retried, a queued one cancelled, a schedule switched on.
      await audited(b, 'jobs.retry', `${API}/jobs/${await seedJob(seed(), 'dead')}/retry`);
      await audited(b, 'jobs.cancel', `${API}/jobs/${await seedJob(seed(), 'queued')}/cancel`);
      await withTx(db(), (trx) => seedSchedules(trx, Date.now(), 'Asia/Jakarta', SCHEDULES));
      await audited(b, 'schedules.update', `${API}/schedules/retention.events`, { enabled: true });

      // A manual backup (no runner ran: frozen, maintenance `backup`), taken over and cancelled from the operations page.
      const cancelled = await audited(b, 'backups.create', `${API}/backups`, {});
      expect(cancelled.json).toEqual({ consistency: 'frozen', opId: expect.any(String) });
      await audited(b, 'ops.takeover', `${API}/ops/takeover`);
      const cancel = await audited(b, 'ops.cancel', `${API}/ops/cancel`);
      expect(cancel.json).toMatchObject({ opId: (cancelled.json as { opId: string }).opId, kind: 'backup', state: 'aborted' });

      // Another, stepped to its end: a backup of this installation (its id is the op's).
      const made = await audited(b, 'backups.create', `${API}/backups`, {});
      const backupId = (made.json as { opId: string }).opId;
      await stepToEnd(backupId);
      expect(await db().db.selectFrom('backups').select('status').where('id', '=', backupId).executeTakeFirstOrThrow()).toEqual({ status: 'ok' });

      // Its download prepared (unencrypted: no passphrase to derive), an archive uploaded, and uploaded again: the
      // uploader's resend of a write that committed appends nothing and stands for its one entry (R1c-10).
      await audited(b, 'backups.prepare_download', `${API}/backups/${backupId}/prepare-download`, { unencrypted: true });
      const uploadId = await stagedArchive(seed(), superAdmin);
      const uploaded = await audited(b, 'backups.upload', `${API}/backups/upload`, { uploadId });
      const beforeResend = await lastSeq();
      const resent = await b.send('post', `${API}/backups/upload`, { uploadId });
      expect(resent.status, resent.text).toBeLessThan(300);
      expect(resent.json).toEqual(uploaded.json);
      expect(await actionsAfter(beforeResend)).toEqual([]);

      // The backup restored: the route begins the op (audit null), the op writes `backup.restore` when it ends (C25).
      const begun = await b.send('post', `${API}/backups/${backupId}/restore`, {});
      expect(begun.status, begun.text).toBe(202);
      const { opId } = begun.json as { opId: string };
      await stepToEnd(opId);
      const restored = await db().db.selectFrom('audit_log').select(['entity_id', 'meta']).where('action', '=', 'backup.restore').execute();
      expect(restored).toHaveLength(1);
      expect(restored[0]!.entity_id).toBe(backupId);
      expect(JSON.parse(restored[0]!.meta)).toMatchObject({ outcome: 'done' });

      // The CLI on the same DATA_DIR: maintenance on and off, a new secrets key.
      await cli(['maintenance:on', '--reason', 'uji audit']);
      await cli(['maintenance:off']);
      await cli(['secrets:rotate']);
      // The daily audit retention: the three entries older than two years go (at most 10 % of the log per run).
      const purged = await purgeAudit(db(), { now: Date.now(), from: null });
      expect(purged.deleted).toBeGreaterThan(0);
      // Last, the installation reset (DATA_DIR only, the database kept).
      await cli(['install:reset']);

      const rows = await db().db.selectFrom('audit_log').select(['seq', 'action']).orderBy('seq').execute();
      const actions = new Set(rows.map((r) => r.action));
      expect(COVERED_1C.filter((a) => !actions.has(a))).toEqual([]);
      // Every 1c route with an audit action was called and appended exactly one entry of it (the wizard's below).
      const audited1c = ALL_ROUTES.filter((d) => PHASE_1C.test(d.id) && d.audit !== null && d.install === undefined).map((d) => d.id);
      expect([...exercised].sort()).toEqual(audited1c.sort());

      // The restore emptied the sessions: the super admin signs in again, and the chain verifies from the anchor.
      const after = await browser();
      const verified = await after.send('get', `${API}/audit/verify`);
      expect(verified.status, verified.text).toBe(200);
      expect(verified.json).toEqual({ ok: true, head: Number(rows.at(-1)!.seq) });
      const seqs = rows.map((r) => Number(r.seq));
      expect(seqs[0]).toBeGreaterThan(1); // the purge took the oldest
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => seqs[0]! + i));
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// 1d (Task 33): the update actions, and the audit retention through its job handler

/** Every action the 1d share of A10 lists, and `audit.purge` from the `audit.retention` handler (T33-AUDIT-PURGE-VIA-HANDLER). */
const COVERED_1D: readonly AuditAction[] = ['update.apply', 'update.rollback', 'update.upload', 'update.channel', 'release.unpin', 'audit.purge'];

/** The routes 1d added (the 1d route catalog: the updates group). */
const PHASE_1D = /^updates\./;

describe.skipIf(!ctx.available)(`audit coverage of the 1d actions [${engineLabel()}]`, () => {
  /** The running release, and the one before it that the manual rollback goes back to. */
  const ACTIVE = '0.1.0-test';
  const PREVIOUS = '0.0.1-test';
  let root: string;
  let dataDir: string;
  let config: Config;
  let state: AppState;
  let ops: OpsMachine;
  let app: ReturnType<typeof createApp>;
  let superAdmin: string;
  const log = recordingLogger();
  const restarts: string[] = [];
  /** The audited 1d routes the run called, each checked to append exactly one entry of its action. */
  const exercised = new Set<string>();

  const db = (): DbHandle => {
    if (state.db === undefined) throw new Error('the app has no live handle');
    return state.db;
  };
  const lastSeq = async (): Promise<number> =>
    Number((await db().db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);
  const actionsAfter = async (seq: number): Promise<string[]> =>
    (await db().db.selectFrom('audit_log').select('action').where('seq', '>', seq).orderBy('seq').execute()).map((r) => r.action);
  const codeOf = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

  beforeAll(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-audit-1d-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(path.join(root, 'home'));
    // The running release's folder (bootContext's `app/release`) ships the dev keyset, as a test build does.
    await fsp.mkdir(path.join(root, 'app', 'release'), { recursive: true });
    await fsp.copyFile(path.join(DEV_KEYS, 'keyset.json'), path.join(root, 'app', 'release', 'keyset.json'));
    // The installation's own database, which config.json names, so the CLI commands of the run reach it too.
    const first = await testDbFor(ctx.engine, { dataDir });
    await runMigrations(first, { appVersion: ACTIVE, dataDir, migrations: PHASE1_MIGRATIONS });
    config = sampleConfig({ db: first.config });
    await writeConfig(dataDir, config);
    // The oldest entries of the log are more than two years old: what the audit retention purges (a prefix by seq).
    const old = Date.now() - 3 * 365 * DAY_MS;
    await withTx(first, async (trx) => {
      for (let i = 0; i < 3; i += 1) {
        await txCtx(trx, old + i, { type: 'system', id: null, ip: null }).audit({ action: 'settings.update', entity: 'settings', entityId: null, meta: { seed: i } });
      }
      await trx.updateTable('schema_meta').set({ install_id: config.install.id }).where('id', '=', 1).execute();
    });
    superAdmin = (await seedStaff(first, { username: 'kepala', password: PERSONA_PASSWORD, roles: [{ key: 'super_admin' }], keyring: config.keyring })).id;
    // releases/current.json: ACTIVE running (bundled), PREVIOUS kept in DATA_DIR (the manual rollback's target).
    await readCurrentState(dataDir, ACTIVE);
    await fsp.mkdir(path.join(dataDir, 'releases', PREVIOUS), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'releases', PREVIOUS, '.complete'), '');
    await updateCurrentState(dataDir, (s) => ({ ...s, previous: { version: PREVIOUS, source: 'data' } }));

    // The app as start() builds it on passenger, with the update and rollback kinds over the dev root (a server.mjs
    // that the release build did not bundle embeds no root keys) and the community edition; no feed (the update comes
    // as an uploaded package).
    state = { phase: 'ready', db: first, config };
    const source = createUpdateSource({
      feedBase: () => null,
      dataDir,
      roots: DEV_ROOTS,
      sources: async () => [],
      refuseDevKids: false,
      allowLoopbackHttp: false,
      clock: () => Date.now(),
      log,
      persistKeysets: async () => {},
      onSignedTime: async () => {},
      env: {},
    });
    const deps = (): UpdateKindDeps => ({
      dataDir,
      appRoot: path.join(root, 'app'),
      appVersion: ACTIVE,
      source,
      precheck: (c) => appPrecheck({ dataDir, h: db(), edition: { check: async () => COMMUNITY_EDITION }, version: ACTIVE }, c),
      roots: DEV_ROOTS,
      sources: async () => [],
      refuseDevKids: false,
      backup: { dataDir, installId: config.install.id, appVersion: ACTIVE, sessionKey: csrfKey(config), kids: config.keyring.map((k) => k.kid) },
      migrations: PHASE1_MIGRATIONS,
      restore: null,
      requestRestart: async (why) => {
        restarts.push(why);
      },
      boot: () => null,
      snapshotBackupRunning: () => snapshotBackupRunning(db(), Date.now()),
      notify,
      log,
    });
    ops = createAppOps(state, {
      dataDir,
      version: ACTIVE,
      log,
      clock: () => Date.now(),
      runtime: 'standalone',
      kinds: opKinds({ appVersion: ACTIVE, config: () => state.config, update: deps }),
    });
    const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => Date.now(), onEpoch() {}, onOpEnded() {} });
    app = createApp({
      state,
      version: ACTIVE,
      buildId: 'audit-1d',
      log,
      clock: () => Date.now(),
      env: {},
      dataDir,
      runtime: 'passenger',
      services: { ops, opsFence, mailer: silentMailer, emailTestMailer: silentMailer, updates: { source, packageKeys: devPackageKeys } },
    });
  }, 120_000);

  afterAll(async () => {
    await ops?.close();
    await state?.db?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The super admin's browser: a session re-authenticated just now, its CSRF token kept from each response. */
  async function browser(): Promise<Browser> {
    const token = await sessionCookieFor(db(), superAdmin, { reauthAt: Date.now() });
    const agent = createAgent(app, { peer: '203.0.113.41', headers: { origin: new URL(config.baseUrl).origin } });
    agent.setCookie(cookieName('altis_sid', isSecureBase(config.baseUrl)), token);
    let csrf = sessionCsrfFor(config, token);
    return {
      async send(method, url, body) {
        const res = await agent[method](url, body, { 'x-csrf-token': csrf });
        csrf = res.headers.get('x-csrf-token') ?? csrf;
        return res;
      },
    };
  }

  /**
   * The route `id` called at `url`: it must succeed (never 500 AUDIT_MISSING, B4) and append exactly one entry of its
   * declared action.
   */
  async function audited(b: Browser, id: string, url: string, body?: unknown): Promise<AgentReply> {
    const decl = routeOf(id);
    const before = await lastSeq();
    const res = await b.send(decl.method.toLowerCase() as Method, url, body);
    expect(codeOf(res), `${id}: ${res.text}`).not.toBe('AUDIT_MISSING');
    expect(res.status, `${id}: ${res.text}`).toBeLessThan(300);
    expect(
      (await actionsAfter(before)).filter((a) => a === decl.audit),
      id,
    ).toHaveLength(1);
    exercised.add(id);
    return res;
  }

  /** A CLI command on this DATA_DIR, as `node app.js <argv>` runs it (the dev root as its root keys); its JSON line. */
  async function cli(argv: string[]): Promise<Record<string, unknown>> {
    const io = captureIo({ HOME: path.join(root, 'home') }, { hostPanels: () => [], rootKeys: DEV_ROOTS });
    const code = await runCli([...argv, '--json'], bootContext(dataDir, { version: ACTIVE }), io);
    expect(code, `${argv.join(' ')}: ${io.err}${io.out}`).toBe(0);
    return JSON.parse(io.out.trim()) as Record<string, unknown>;
  }

  /** `action`'s entries since the run began. */
  const entriesOf = async (action: string) =>
    (await db().db.selectFrom('audit_log').select(['actor_type', 'entity_id', 'meta']).where('action', '=', action).orderBy('seq').execute()).map((r) => ({
      actor_type: r.actor_type,
      entity_id: r.entity_id,
      meta: JSON.parse(r.meta) as Record<string, unknown>,
    }));

  it(
    'a scripted run writes every 1d action, each audited 1d route exactly once; audit.purge from the audit.retention handler; the chain verifies, seq without a gap',
    async () => {
      const b = await browser();

      // The update channel.
      await audited(b, 'updates.channel', `${API}/updates/channel`, { channel: 'beta' });

      // An update package uploaded: checked (a dry run), then begun, then cancelled before its point of no return: the
      // op writes `update.apply` with the outcome `aborted` when it ends (C25).
      const uploadId = await stagedUpdateUpload({ h: db(), dataDir, now: Date.now() }, superAdmin, (await releasePackage()).zip);
      const dry = await audited(b, 'updates.upload', `${API}/updates/upload`, { uploadId, dryRun: true });
      expect(dry.json).toMatchObject({ version: '0.2.0-test', precheck: { ok: true } });
      const begun = await audited(b, 'updates.upload', `${API}/updates/upload`, { uploadId });
      const { opId: updateOp } = begun.json as { opId: string };
      const cancelled = await b.send('post', `${API}/ops/cancel`);
      expect(cancelled.status, cancelled.text).toBe(200);
      expect(cancelled.json).toMatchObject({ opId: updateOp, kind: 'update', state: 'aborted' });
      expect(await entriesOf('update.apply')).toEqual([
        { actor_type: 'staff', entity_id: updateOp, meta: expect.objectContaining({ outcome: 'aborted', target: '0.2.0-test', from: ACTIVE }) },
      ]);

      // The manual rollback to PREVIOUS (the op writes `update.rollback`), which pins ACTIVE; `release:unpin` (CLI)
      // removes the pin.
      const rolled = await b.send('post', `${API}/updates/rollback`);
      expect(rolled.status, rolled.text).toBe(200);
      const { opId: rollbackOp } = rolled.json as { opId: string };
      expect(await entriesOf('update.rollback')).toEqual([
        { actor_type: 'staff', entity_id: rollbackOp, meta: { from: ACTIVE, to: PREVIOUS } },
      ]);
      expect((await readCurrentState(dataDir, ACTIVE)).pinned).toBe(ACTIVE);
      expect(await cli(['release:unpin'])).toMatchObject({ ok: true, unpinned: ACTIVE, audited: true });
      expect(await entriesOf('release.unpin')).toEqual([{ actor_type: 'cli', entity_id: null, meta: { version: ACTIVE } }]);

      // The daily audit retention, as the scheduler queues it and a runner runs it: the `audit.retention` handler,
      // slice by slice through runSlice, purges the entries older than two years and writes `audit.purge`.
      const registry = createJobRegistry(
        jobHandlers({ housekeeping: { dataDir, mailer: silentMailer, baseUrl: () => config.baseUrl, settings: createSettingsCache({ ttlMs: 0 }) } }),
      );
      const now = Date.now();
      const job = await withTx(db(), (trx) =>
        enqueue(trx, registry, { type: 'audit.retention', payload: { windowStart: now - 60_000, windowEnd: now } }, { now, keyring: config.keyring }),
      );
      let outcome: string | undefined;
      for (let i = 0; i < 50 && outcome !== 'succeeded'; i += 1) {
        const claimed = await claimById(db(), registry, job.id, { worker: 'audit-1d', now: Date.now() });
        if (claimed === null) break;
        outcome = (await runSlice(db(), registry, claimed, { mode: 'cron_cli', budgetMs: 20_000, keyring: config.keyring, log, clock: () => Date.now(), env: {} })).outcome;
      }
      expect(outcome).toBe('succeeded');
      const purges = await entriesOf('audit.purge');
      expect(purges.length).toBeGreaterThan(0); // one per slice that deleted entries
      expect(purges.map((e) => e.actor_type)).toEqual(purges.map(() => 'system'));

      const rows = await db().db.selectFrom('audit_log').select(['seq', 'action']).orderBy('seq').execute();
      const actions = new Set(rows.map((r) => r.action));
      expect(COVERED_1D.filter((a) => !actions.has(a))).toEqual([]);
      expect([...actions].filter((a) => a.startsWith('license.'))).toEqual([]);
      // Every 1d route with an audit action was called and appended exactly one entry of it (the wizard's below).
      const audited1d = ALL_ROUTES.filter((d) => PHASE_1D.test(d.id) && d.audit !== null && d.install === undefined).map((d) => d.id);
      expect([...exercised].sort()).toEqual(audited1d.sort());

      // The chain verifies from the retention's anchor (read-only now: `GET audit/verify` is a read route).
      const verified = await b.send('get', `${API}/audit/verify`);
      expect(verified.status, verified.text).toBe(200);
      expect(verified.json).toEqual({ ok: true, head: Number(rows.at(-1)!.seq) });
      const seqs = rows.map((r) => Number(r.seq));
      expect(seqs[0]).toBeGreaterThan(1); // the purge took the oldest
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => seqs[0]! + i));
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// ---- Phase 2 (catalog): Task 2 ----
// The catalog actions (Phase 2 spec §12.4), one script per area (../audit/catalog.ts, each filled by its owning task).
// Every script whose `run` is set runs on one installation of its own, in PHASE2_AUDIT_SCRIPTS order, as a super admin,
// and must append at least one entry of each action it owns (each audited route appends exactly one, or the route
// runtime answers 500 AUDIT_MISSING); afterwards the chain verifies, seq 1..N. A script still null lists its actions as
// pending (it.todo) while PHASE2_PENDING_ALLOWED; Task 39 sets it to false, and they must all be covered then.

/**
 * The Phase 2 actions: AUDIT_ACTIONS from the first catalog action up to the first action of reports and accreditation,
 * which the community milestones append after them.
 */
const PHASE2_ACTIONS: readonly AuditAction[] = AUDIT_ACTIONS.slice(AUDIT_ACTIONS.indexOf('catalog.record.create'), AUDIT_ACTIONS.indexOf('reports.run.start'));

describe('audit coverage: the Phase 2 scripts own every Phase 2 action, once', () => {
  it('the ten areas list the 30 actions of §12.4 between them, each in exactly one', () => {
    expect(PHASE2_ACTIONS).toHaveLength(30);
    expect(Object.keys(PHASE2_AUDIT_SCRIPTS)).toEqual([
      'masters',
      'authorities',
      'records',
      'attachments',
      'items',
      'search',
      'runs',
      'exchange',
      'migration',
      'pages',
    ]);
    const owned = Object.values(PHASE2_AUDIT_SCRIPTS).flatMap((s) => [...s.actions]);
    expect(new Set(owned).size).toBe(owned.length);
    expect([...owned].sort()).toEqual([...PHASE2_ACTIONS].sort());
  });
});

// ---- Komunitas K1 (reports and accreditation) ----
// The community actions, one script per area (../audit/komunitas.ts), run after the catalogue's on the same
// installation with the same checks; a script still null lists its actions as pending while K1_PENDING_ALLOWED.

/** The community actions: AUDIT_ACTIONS from the first action of reports and accreditation to the members' first. */
const K1_ACTIONS: readonly AuditAction[] = AUDIT_ACTIONS.slice(AUDIT_ACTIONS.indexOf('reports.run.start'), AUDIT_ACTIONS.indexOf('members.member.create'));

// ---- Komunitas (members and circulation) ----
/** The members and circulation actions: AUDIT_ACTIONS from the first member action to the end. */
const MEMBERS_CIRCULATION_ACTIONS: readonly AuditAction[] = AUDIT_ACTIONS.slice(AUDIT_ACTIONS.indexOf('members.member.create'));

/** Every script the installation runs: the catalogue's, the community's, then the members and circulation scripts. */
const AUDIT_SCRIPTS = { ...PHASE2_AUDIT_SCRIPTS, ...KOMUNITAS_AUDIT_SCRIPTS, ...MEMBERS_CIRCULATION_AUDIT_SCRIPTS };

/** Whether the null script of `area` may list its actions as pending. */
const pendingAllowed = (area: string): boolean => {
  if (Object.hasOwn(MEMBERS_CIRCULATION_AUDIT_SCRIPTS, area)) return MEMBERS_CIRCULATION_PENDING_ALLOWED;
  return Object.hasOwn(KOMUNITAS_AUDIT_SCRIPTS, area) ? K1_PENDING_ALLOWED : PHASE2_PENDING_ALLOWED;
};

describe('audit coverage: the community scripts own every community action, once', () => {
  it('the seven areas list the 18 actions between them, each in exactly one, under names of their own', () => {
    expect(K1_ACTIONS).toHaveLength(18);
    expect(Object.keys(KOMUNITAS_AUDIT_SCRIPTS)).toEqual(['reports', 'periods', 'registers', 'usage', 'results', 'slims-usage', 'catalog']);
    expect(Object.keys(KOMUNITAS_AUDIT_SCRIPTS).filter((area) => Object.hasOwn(PHASE2_AUDIT_SCRIPTS, area))).toEqual([]);
    const owned = Object.values(KOMUNITAS_AUDIT_SCRIPTS).flatMap((s) => [...s.actions]);
    expect(new Set(owned).size).toBe(owned.length);
    expect([...owned].sort()).toEqual([...K1_ACTIONS].sort());
  });
});

describe('audit coverage: the members and circulation scripts own every members and circulation action, once', () => {
  it('the three areas list the 23 actions between them, each in exactly one, under names of their own', () => {
    // Members and circulation (15), then the circulation core (8).
    expect(MEMBERS_CIRCULATION_ACTIONS).toHaveLength(23);
    expect(Object.keys(MEMBERS_CIRCULATION_AUDIT_SCRIPTS)).toEqual(['members', 'circulation', 'circ-core']);
    const others = { ...PHASE2_AUDIT_SCRIPTS, ...KOMUNITAS_AUDIT_SCRIPTS };
    expect(Object.keys(MEMBERS_CIRCULATION_AUDIT_SCRIPTS).filter((area) => Object.hasOwn(others, area))).toEqual([]);
    const owned = Object.values(MEMBERS_CIRCULATION_AUDIT_SCRIPTS).flatMap((s) => [...s.actions]);
    expect(new Set(owned).size).toBe(owned.length);
    expect([...owned].sort()).toEqual([...MEMBERS_CIRCULATION_ACTIONS].sort());
  });
});

describe.skipIf(!ctx.available)(`audit coverage of the Phase 2 and community actions [${engineLabel()}]`, () => {
  const ready = Object.values(AUDIT_SCRIPTS).some((s) => s.run !== null);
  /** Six hours behind the real clock: room for a script to move it on, an entry never dated ahead of the real one. */
  const clock = { now: Date.now() - 6 * 3_600_000 };
  let root: string;
  let dataDir: string;
  let db: TestDbHandle;
  let config: Config;
  let app: ReturnType<typeof createApp>;
  let runtime: JobRuntime | undefined;
  let context: AuditScriptContext;
  let peer = 0;

  const lastSeq = async (): Promise<number> =>
    Number((await db.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);
  const actionsAfter = async (seq: number): Promise<string[]> =>
    (await db.db.selectFrom('audit_log').select('action').where('seq', '>', seq).orderBy('seq').execute()).map((r) => r.action);

  /** A browser of staff user `userId` (password `password`): a session re-authenticated at `clock.now`, the SPA's headers. */
  async function browserOf(userId: string, password: string): Promise<AuditBrowser> {
    const token = await sessionCookieFor(db, userId, { now: clock.now, reauthAt: clock.now });
    const origin = new URL(config.baseUrl).origin;
    peer += 1;
    const remote = `198.51.100.${100 + peer}`;
    const agent = createAgent(app, { peer: remote, headers: { origin } });
    agent.setCookie(cookieName('altis_sid', isSecureBase(config.baseUrl)), token);
    let csrf = sessionCsrfFor(config, token);
    const send: AuditBrowser['send'] = async (method, url, body, headers = {}) => {
      const res = await agent[method](url, body, { 'x-csrf-token': csrf, ...headers });
      csrf = res.headers.get('x-csrf-token') ?? csrf;
      return res;
    };
    const multipart: AuditBrowser['multipart'] = async (url, form) => {
      const cookie = [...agent.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await app.request(url, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrf }, body: form }, { incoming: { socket: { remoteAddress: remote } } });
      csrf = res.headers.get('x-csrf-token') ?? csrf;
      const text = await res.text();
      let json: unknown;
      try {
        json = text === '' ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, json, text, headers: res.headers };
    };
    const upload: AuditBrowser['upload'] = async (uploadContext, data, originalName) => {
      const sha256 = createHash('sha256').update(data).digest('hex');
      const declared = await send('post', `${API}/files/uploads`, { context: uploadContext, size: data.byteLength, sha256, chunkBytes: 256 * 1024 });
      expect(declared.status, `upload ${uploadContext}: ${declared.text}`).toBe(201);
      const s = declared.json as { id: string; chunkSize: number };
      for (let n = 0; n * s.chunkSize < data.byteLength; n += 1) {
        const form = new FormData();
        form.append('chunk', new Blob([data.subarray(n * s.chunkSize, (n + 1) * s.chunkSize)]), 'blob');
        const chunk = await multipart(`${API}/files/uploads/${s.id}/chunks/${n}`, form);
        expect(chunk.status, `upload ${uploadContext} chunk ${n}: ${chunk.text}`).toBe(200);
      }
      const done = await send('post', `${API}/files/uploads/${s.id}/complete`, originalName === undefined ? {} : { originalName });
      expect(done.status, `upload ${uploadContext} complete: ${done.text}`).toBe(200);
      return done.json as { uploadId: string } | { fileId: string };
    };
    return { userId, password, send, multipart, upload };
  }

  beforeAll(async () => {
    if (!ready) return; // nothing to run: no installation is made
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-audit-phase2-')));
    dataDir = path.join(root, 'data');
    db = await testDbFor(ctx.engine, { dataDir });
    await runMigrations(db, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    config = sampleConfig({ db: db.config });
    await writeConfig(dataDir, config);
    const state: AppState = { phase: 'ready', db, config };
    const log = recordingLogger();
    runtime = createJobRuntime({
      state,
      runtime: 'passenger',
      env: {},
      dataDir,
      log,
      clock: () => clock.now,
      ops: createAppOps(state, { dataDir, version: '0.1.0', log, clock: () => clock.now }),
      handlers: jobHandlers({
        housekeeping: { dataDir, mailer: silentMailer, baseUrl: () => config.baseUrl, settings: createSettingsCache({ ttlMs: 0 }) },
      }),
      requestRestart: async () => {},
      installId: config.install.id,
      appVersion: '0.1.0',
    });
    state.jobs = runtime;
    app = createApp({
      state,
      version: '0.1.0',
      buildId: 'audit-phase2',
      log,
      clock: () => clock.now,
      env: {},
      dataDir,
      services: { mailer: silentMailer, emailTestMailer: silentMailer },
    });
    const head = await seedStaff(db, { username: 'kepala_katalog', password: PERSONA_PASSWORD, now: clock.now, roles: [{ key: 'super_admin' }], keyring: config.keyring });
    let serial = 0;
    context = {
      admin: await browserOf(head.id, PERSONA_PASSWORD),
      signIn: async (permissions) => {
        serial += 1;
        const user = await seedStaff(db, { username: `staf_katalog_${serial}`, password: PERSONA_PASSWORD, now: clock.now, roles: [{ permissions: [...permissions] }], keyring: config.keyring });
        return browserOf(user.id, PERSONA_PASSWORD);
      },
      db,
      clock,
      app,
      config,
      dataDir,
      jobs: runtime,
    };
  }, 120_000);

  afterAll(async () => {
    await runtime?.stop();
    await db?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  for (const [area, script] of Object.entries(AUDIT_SCRIPTS)) {
    const run = script.run;
    if (run === null) {
      for (const action of script.actions) {
        if (pendingAllowed(area)) it.todo(`${area}: ${action} (its script is not written yet)`);
        else it(`${area}: ${action}`, () => expect.fail(`the ${area} audit script is still null, so ${action} is not covered (A10)`));
      }
      continue;
    }
    it(
      `${area}: its script appends ${script.actions.join(', ')}`,
      async () => {
        const before = await lastSeq();
        await run(context);
        const appended = new Set(await actionsAfter(before));
        expect(script.actions.filter((action) => !appended.has(action)), area).toEqual([]);
      },
      120_000,
    );
  }

  it.skipIf(!ready)('after the scripts the chain verifies, seq 1..N', async () => {
    const rows = await db.db.selectFrom('audit_log').select('seq').orderBy('seq').execute();
    expect(await verifyAuditChain(db)).toEqual({ ok: true, head: rows.length });
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
  });
});

describe.skipIf(!ctx.available)(`audit coverage: the wizard run (install.complete) [${engineLabel()}]`, () => {
  const ADMIN = { username: 'admin', name: 'Admin Perpustakaan', email: 'admin@perpus.example.sch.id', password: 'kuda-lumping-biru' };
  let root: string;

  beforeAll(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-audit-wizard-')));
  });

  afterEach(async () => {
    await closeTestServers();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /**
   * A DATA_DIR of its own under `root/<name>`, with what app.js leaves for the wizard beside it (bootContext's appRoot):
   * its page, the exposure candidates and, as a test build ships it, the dev keyset. The wizard needs an empty database: a server engine's is the worker's one, emptied here (SQLite: a file in this DATA_DIR).
   */
  async function wizardDir(name: string): Promise<string> {
    const dir = path.join(root, name, 'altis-data');
    await fsp.mkdir(dir, { recursive: true });
    const appRoot = path.join(root, name, 'app');
    await fsp.mkdir(path.join(appRoot, 'release', 'public', 'admin'), { recursive: true });
    await fsp.writeFile(path.join(appRoot, 'release', 'public', 'admin', 'install.html'), '<!doctype html><title>wizard</title>');
    await fsp.copyFile(path.join(DEV_KEYS, 'keyset.json'), path.join(appRoot, 'release', 'keyset.json'));
    await fsp.writeFile(path.join(appRoot, 'app.js'), '// the bootloader\n');
    await fsp.writeFile(path.join(appRoot, 'altis-data-dir.txt'), `${dir}\n`);
    if (ctx.engine !== 'sqlite') await (await testDb()).close();
    return dir;
  }

  /** `app.request(...)` over a real socket to the server start() serves (node:http, no global fetch, P18). */
  function overHttp(port: number): Hono<AppEnv> {
    const request = (urlPath: string, init: RequestInit = {}): Promise<Response> => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const body = typeof init.body === 'string' ? init.body : undefined;
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: init.method ?? 'GET', headers, agent: false }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            const h = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) for (const v of value) h.append(name, v);
              else if (value !== undefined) h.set(name, value);
            }
            const status = res.statusCode ?? 0;
            resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: h }));
          });
        });
        req.on('error', reject);
        req.end(body);
      });
    };
    return { request } as unknown as Hono<AppEnv>;
  }

  /**
   * The whole wizard in `dir` (start(), as app.js boots it, under `runtime`): the super admin step goes on to the
   * scheduler (no licence step); then the audit log of its database: every entry, the chain verified.
   */
  async function wizardRun(dir: string, o: { runtime: 'standalone' | 'docker' }) {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true); // start() and GET /install print the install code
    const boot = bootContext(dir, { runtime: o.runtime });
    await start(boot);
    const { port } = await boot.served();
    const origin = `http://127.0.0.1:${port}`;
    const agent: Agent = createAgent(overHttp(port), { headers: { origin } });
    let csrf = '';
    const post = (urlPath: string, body?: unknown): Promise<AgentReply> => agent.post(urlPath, body, { 'x-csrf-token': csrf });
    const step = async (urlPath: string, body: unknown, installState: string): Promise<void> => {
      const res = await post(urlPath, body);
      expect(res.status, `${urlPath}: ${res.text}`).toBe(200);
      expect(res.json).toEqual({ installState });
    };

    expect((await agent.get('/install')).status).toBe(200);
    const code = String((JSON.parse(await fsp.readFile(path.join(dir, 'install-code.txt'), 'utf8')) as { code: string }).code);
    const claimed = await agent.post('/install/api/claim', { code });
    expect(claimed.status, claimed.text).toBe(200);
    csrf = String((claimed.json as { csrfToken: string }).csrfToken);
    const checks = (await agent.get('/install/api/checks')).json as InstallChecksResponse;
    const exposure = await post('/install/api/exposure', { results: checks.exposure.candidates.map((x) => ({ path: x.path, status: 404, sha256: null })) });
    expect(exposure.status, exposure.text).toBe(200);
    const nonce = randomBytes(18).toString('base64url');
    const probe = await agent.get(`/install/api/probe/${nonce}`);
    expect(probe.status, probe.text).toBe(200);
    const hmac = String((probe.json as { hmac: string }).hmac);
    await step('/install/api/config', { baseUrl: origin, db: testDbConfig(), trustProxy: { hops: 0 }, probe: { nonce, hmac, results: PROBE_RESULTS } }, 'migrate');
    for (let i = 0; i <= Object.keys(PHASE1_MIGRATIONS).length; i += 1) {
      const migrated = await post('/install/api/migrate');
      expect(migrated.status, migrated.text).toBe(200);
      if ((migrated.json as MigrateResponse).done) break;
    }
    await step('/install/api/profile', { library: { name: 'Perpustakaan Wizard', timezone: 'Asia/Jakarta', locale: 'id' }, branch: {} }, 'admin');
    await step('/install/api/admin', ADMIN, 'cron');
    expect((await post('/install/api/cron/test')).status).toBe(200);
    const finished = await post('/install/api/finish');
    expect(finished.status, finished.text).toBe(200);

    const h = await connect(testDbConfig(), { runtime: 'standalone', purpose: 'cli', dataDir: dir });
    try {
      const rows = await h.db.selectFrom('audit_log').select(['seq', 'action', 'entity', 'entity_id', 'actor_type', 'meta']).orderBy('seq').execute();
      return { rows, verified: await verifyAuditChain(h) };
    } finally {
      await h.close();
    }
  }

  it(
    'the whole wizard → one install.complete entry, no licence entry; the chain verifies, seq 1..N',
    async () => {
      const { rows, verified } = await wizardRun(await wizardDir('wizard'), { runtime: 'standalone' });
      expect(rows.filter((r) => r.action === 'install.complete').map(({ action, entity }) => ({ action, entity }))).toEqual([
        { action: 'install.complete', entity: 'install' },
      ]);
      expect(rows.filter((r) => r.action === 'install.complete')[0]!.entity_id).toEqual(expect.any(String));
      expect(rows.filter((r) => r.action.startsWith('license.')).map((r) => r.action)).toEqual([]);
      expect(verified).toEqual({ ok: true, head: rows.length });
      expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
    },
    120_000,
  );

});
