import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MaintenanceFlag, OpFile } from '@altis/core';
import { jakartaDate } from '@altis/crypto/feed';
import { type DbHandle } from '@altis/db';
import { readCurrentState, resetTestFaults, updateCurrentState } from '@altis/platform';
import { newId, t } from '@altis/shared';
import type { UpdateStatusView } from '@altis/shared/api/updates';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_ROOTS, writeSignedRelease } from '../../../../packages/core/test/helpers/signed-release.js';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { writeConfig } from '../../src/config.js';
import { start, type BootContext } from '../../src/index.js';
import { flagOf, readOpJson, writeFlag, writeOp } from '../ops-support.js';
import { seedStaff, sessionCookieFor } from '../support-auth.js';
import { bootContext, closeTestServers, httpRequest, sampleConfig, serverLog, useDataDir, type TestBootContext } from '../support.js';

// §9.8 row 3, `schemaHold` (plan Task 27; decision D1d-24; preflight S12, 1D-04): a bundled release newer than
// `active`, whose folder is missing (a new Docker image, a zip uploaded again), boots in `schemaHold`. start() opens the
// database without migrating (phase `updating`), refuses a second attempt at a version that failed before, runs the
// prechecks against the database, then runs its own `update` op (source `self`) from `verified`: freeze, the
// `pre_update` backup with the generic exporter (columns from the catalog), the point of no return (current.json
// active = the bundled release, previous null), the migrations, the verification, `done`, a restart. A failure after
// the point of no return ends `restore_failed` (UPDATE_SCHEMA_HOLD_FAILED naming the backup), active set back; every
// failure keeps maintenance and never reaches runMigrations.
//
// This server is release 0.2.0-test: its migrations are fixture level 2 (+ 9001_test_expand).

const seen = vi.hoisted(() => ({ runMigrations: 0 }));
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  return {
    ...actual,
    releaseMigrations: (level?: Parameters<typeof actual.releaseMigrations>[0]) => actual.releaseMigrations(level ?? 2),
    runMigrations: vi.fn(async (...args: Parameters<typeof actual.runMigrations>) => {
      seen.runMigrations += 1;
      return actual.runMigrations(...args);
    }),
  };
});
const actualDb = await vi.importActual<typeof import('@altis/db')>('@altis/db');

const engine = testDbContext();
const dirs = useDataDir();
const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const TODAY = jakartaDate(Date.now());
/** sampleConfig's baseUrl is https: the session cookie carries the `__Host-` prefix. */
const SID_COOKIE = '__Host-altis_sid';
const handles: DbHandle[] = [];

beforeEach(async () => {
  if (engine.available) await (await testDb()).close(); // an empty database
  vi.stubGlobal('__TRUSTED_KEYS__', DEV_ROOTS);
  seen.runMigrations = 0;
  resetTestFaults();
});

afterEach(async () => {
  await closeTestServers();
  await Promise.all(handles.splice(0).map((h) => h.close()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetTestFaults();
});

async function ownHandle(): Promise<DbHandle> {
  const h = await actualDb.connect(testDbConfig(engine), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
  handles.push(h);
  return h;
}

const appRoot = (): string => path.join(dirs.root, 'app');
const bundledDir = (): string => path.join(appRoot(), 'bundled-release', V2);

/**
 * 0.1.0-test's installation as a Docker image left it: its database at fixture level 1 with data (three branches),
 * current.json active {0.1.0-test, bundled}, and no folder of 0.1.0-test anywhere; the new image's bundled 0.2.0-test
 * (schema 9001, released today) beside app.js.
 */
async function imageOfV1(o: { minNode?: string } = {}): Promise<void> {
  await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
  const h = await ownHandle();
  await actualDb.runMigrations(h, { appVersion: V1, dataDir: dirs.dataDir, migrations: actualDb.releaseMigrations(1) });
  const now = Date.now();
  for (const n of [1, 2, 3]) {
    const id = newId(now + n);
    await h.db
      .insertInto('branches')
      .values({ id, code_key: `c${n}`, code_display: `C${n}`, name: `Cabang ${n}`, timezone: 'Asia/Jakarta', created_at: now, updated_at: now })
      .execute();
  }
  await readCurrentState(dirs.dataDir, V1);
  await writeSignedRelease(bundledDir(), V2, { meta: { schemaLatest: '9001', releasedAt: TODAY, ...(o.minNode === undefined ? {} : { minNode: o.minNode }) } });
}

/** The context app.js hands the bundled 0.2.0-test booted in schemaHold. */
function holdContext(): TestBootContext {
  const ctx = bootContext(dirs.dataDir, { version: V2 });
  ctx.release = { version: V2, dir: bundledDir(), source: 'bundled' };
  ctx.bootMode = 'schemaHold';
  return ctx;
}

/** SHA-256 of the rows of `branches`, in key order (the old table the update must leave as it was). */
async function branchesChecksum(): Promise<string> {
  const h = await ownHandle();
  const rows = await h.db.selectFrom('branches').selectAll().orderBy('id').execute();
  const canonical = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' || typeof v === 'number' ? Number(v) : v])));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function migrationNames(): Promise<string[]> {
  const h = await ownHandle();
  return (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name);
}

async function systemRoles(): Promise<string[]> {
  const h = await ownHandle();
  return (await h.db.selectFrom('roles').select('key').where('is_system', '=', 1).execute()).map((r) => String(r.key)).sort();
}

async function bundledBlockedSetting(): Promise<unknown> {
  const h = await ownHandle();
  const row = await h.db.selectFrom('settings').select('value').where('key', '=', 'update.bundled_blocked').executeTakeFirst();
  return row?.value == null ? null : (JSON.parse(row.value) as unknown);
}

async function backupRows(): Promise<{ id: string; kind: string }[]> {
  const h = await ownHandle();
  return h.db.selectFrom('backups').select(['id', 'kind']).execute();
}

async function flag(): Promise<MaintenanceFlag | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(dirs.dataDir, 'ops', 'maintenance.json'), 'utf8')) as MaintenanceFlag;
  } catch {
    return null;
  }
}

async function opOrNull(): Promise<OpFile | null> {
  try {
    return await readOpJson(dirs.dataDir);
  } catch {
    return null;
  }
}

/** 1d review C16: the session cookie of a super admin seeded into the database as it is now (its token). */
async function superAdminSession(): Promise<string> {
  const h = await ownHandle();
  const { id } = await seedStaff(h, { username: 'kepala', roles: [{ key: 'super_admin' }] });
  return sessionCookieFor(h, id);
}

async function health(ctx: TestBootContext): Promise<number> {
  return (await httpRequest((await ctx.served()).port, '/_health')).status;
}

describe.skipIf(!engine.available)(`schemaHold (§9.8 row 3) [${engineLabel()}]`, () => {
  it(
    'the happy path: phase updating, the pre_update backup with columnsFrom catalog, 9001 applied, done, active {0.2.0-test, bundled}, previous null, a restart, old tables unchanged',
    async () => {
      await imageOfV1();
      const before = await branchesChecksum();
      // Level 1 was made by migrations alone: no system role yet. The `self` verifying step creates them although
      // current.json names the target active from `switched` on (it is not app.js's promotion).
      expect(await systemRoles()).toEqual([]);
      const ctx = holdContext();
      await start(ctx as BootContext);

      const op = await readOpJson(dirs.dataDir);
      expect(op).toMatchObject({ kind: 'update', state: 'done', error: null, pointOfNoReturn: true });
      expect(op.params).toMatchObject({ source: 'self', target: V2, from: V1 });
      expect(op.backupId).not.toBeNull();
      const manifest = JSON.parse(await fsp.readFile(path.join(dirs.dataDir, 'backups', op.backupId!, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest).toMatchObject({ kind: 'pre_update', consistency: 'frozen', columnsFrom: 'catalog' });
      expect(await backupRows()).toEqual([{ id: op.backupId, kind: 'pre_update' }]);
      expect(await migrationNames()).toContain('9001_test_expand');
      const state = await readCurrentState(dirs.dataDir, V1);
      expect(state.active).toEqual({ version: V2, source: 'bundled' });
      expect(state.previous).toBeNull();
      expect(state.pending).toBeNull();
      expect(ctx.requestRestart).toHaveBeenCalledWith('update');
      expect(await branchesChecksum()).toBe(before);
      expect(await systemRoles()).toEqual(['admin', 'super_admin']);
      // The 1c boot path (runMigrations) never ran: the op migrated the database itself.
      expect(seen.runMigrations).toBe(0);
      // Until the restart replaces it, the process stays in maintenance (phase updating).
      expect(await health(ctx)).toBe(503);
      expect(await flag()).toBeNull(); // the op ended done and lowered its flag

      // A process app.js classified as schemaHold before `switched` named 0.2.0-test active, whose start() runs after
      // the op ended done (Passenger spawning during the update): it boots as usual, no precheck against itself, no
      // manual flag, no update.bundled_blocked.
      await closeTestServers();
      const late = holdContext();
      await start(late as BootContext);
      expect(await health(late)).toBe(200);
      expect(await flag()).toBeNull();
      expect(await bundledBlockedSetting()).toBeNull();
      expect(seen.runMigrations).toBe(1); // the normal boot's, with nothing left to apply
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'done' });
    },
    90_000,
  );

  it(
    'health:0.2.0-test → the self verifying step runs the health check: restore_failed (reason health), maintenance kept, active back',
    async () => {
      await imageOfV1();
      vi.stubEnv('ALTIS_TEST_FAULT', `health:${V2}`);
      const ctx = holdContext();
      await start(ctx as BootContext);
      const op = await readOpJson(dirs.dataDir);
      expect(op).toMatchObject({ state: 'restore_failed', error: { code: 'UPDATE_SCHEMA_HOLD_FAILED', reason: 'health' } });
      expect(op.backupId).not.toBeNull();
      expect(op.error?.detail).toContain(op.backupId!);
      expect(await migrationNames()).toContain('9001_test_expand'); // migrated, then found unhealthy
      expect((await readCurrentState(dirs.dataDir, V1)).active).toEqual({ version: V1, source: 'bundled' });
      expect(await flag()).toMatchObject({ reason: 'update' });
      expect(await health(ctx)).toBe(503);
      expect(seen.runMigrations).toBe(0);
      expect(ctx.requestRestart).not.toHaveBeenCalledWith('update');
    },
    90_000,
  );

  it(
    'migrate:9001_test_expand → restore_failed, UPDATE_SCHEMA_HOLD_FAILED naming the backup, maintenance kept, active back to {0.1.0-test, bundled}; the same release again begins nothing (1D-04)',
    async () => {
      await imageOfV1();
      vi.stubEnv('ALTIS_TEST_FAULT', 'migrate:9001_test_expand');
      const ctx = holdContext();
      await start(ctx as BootContext);
      const op = await readOpJson(dirs.dataDir);
      expect(op).toMatchObject({ state: 'restore_failed', error: { code: 'UPDATE_SCHEMA_HOLD_FAILED' } });
      expect(op.backupId).not.toBeNull();
      expect(op.error?.detail).toContain(op.backupId!);
      expect((await readCurrentState(dirs.dataDir, V1)).active).toEqual({ version: V1, source: 'bundled' });
      expect((await readCurrentState(dirs.dataDir, V1)).previous).toBeNull();
      expect(await flag()).toMatchObject({ reason: 'update' });
      expect(await health(ctx)).toBe(503);
      expect(seen.runMigrations).toBe(0);
      expect(ctx.requestRestart).not.toHaveBeenCalledWith('update');
      // 1d review C16: the system's op leaves no browser its altis_ops; a super admin's session opens the page in phase
      // updating, which shows the schemaHold instruction naming the backup.
      const sid = await superAdminSession();
      const page = await httpRequest((await ctx.served()).port, '/admin/_update?lang=en', 'GET', { cookie: `${SID_COOKIE}=${sid}`, accept: 'text/html' });
      expect(page.status, page.body).toBe(200);
      expect(page.body).toContain(t('en', 'ops.page.schema_hold', { backupId: op.backupId! }));

      // The same image started again (a restart policy, a host reboot): no new op, no new backup; the instruction names
      // the first backup.
      await closeTestServers();
      vi.stubEnv('ALTIS_TEST_FAULT', '');
      const again = holdContext();
      await start(again as BootContext);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'restore_failed' });
      expect(await backupRows()).toEqual([{ id: op.backupId, kind: 'pre_update' }]);
      expect(await flag()).toMatchObject({ reason: 'update' });
      expect(await migrationNames()).not.toContain('9001_test_expand');
      expect(seen.runMigrations).toBe(0);
      expect(await health(again)).toBe(503);
      const held = (await serverLog(dirs.dataDir)).filter((l) => l['msg'] === 'schemaHold: this release failed before; nothing is begun again');
      expect(held.length).toBeGreaterThan(0);
      expect(String(held.at(-1)?.['instruction'])).toContain(op.backupId!);
    },
    90_000,
  );

  it('disk-full:backups:1 at frozen → aborted, maintenance kept (a manual update flag), runMigrations never called', async () => {
    await imageOfV1();
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:backups:1');
    const ctx = holdContext();
    await start(ctx as BootContext);
    const op = await readOpJson(dirs.dataDir);
    expect(op).toMatchObject({ state: 'aborted', error: { code: 'DISK_QUOTA' } });
    expect(await flag()).toMatchObject({ reason: 'update', opId: null });
    expect(seen.runMigrations).toBe(0);
    expect(await migrationNames()).not.toContain('9001_test_expand');
    expect((await readCurrentState(dirs.dataDir, V1)).active).toEqual({ version: V1, source: 'bundled' });
    expect(await health(ctx)).toBe(503);

    // The same image again: nothing is begun (1D-04); the database was never changed, so the instruction names no
    // backup to restore (the op abandoned its pre_update backup) and says to switch maintenance off.
    await closeTestServers();
    vi.stubEnv('ALTIS_TEST_FAULT', '');
    const again = holdContext();
    await start(again as BootContext);
    expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'aborted' });
    expect(await flag()).toMatchObject({ reason: 'update', opId: null });
    expect(seen.runMigrations).toBe(0);
    expect(await health(again)).toBe(503);
    const held = (await serverLog(dirs.dataDir)).filter((l) => l['msg'] === 'schemaHold: this release failed before; nothing is begun again');
    expect(held.length).toBeGreaterThan(0);
    const instruction = String(held.at(-1)?.['instruction']);
    expect(instruction).toContain('maintenance:off');
    if (op.backupId !== null) expect(instruction).not.toContain(op.backupId);
  }, 60_000);

  it("failed prechecks (minNode '99.0.0') → no op, update.bundled_blocked, a manual update flag, phase updating", async () => {
    await imageOfV1({ minNode: '99.0.0' });
    const ctx = holdContext();
    await start(ctx as BootContext);
    expect(await opOrNull()).toBeNull();
    const h = await ownHandle();
    const row = await h.db.selectFrom('settings').select('value').where('key', '=', 'update.bundled_blocked').executeTakeFirst();
    expect(JSON.parse(row?.value ?? 'null')).toMatchObject({ version: V2, failures: ['min_node'] });
    expect(await flag()).toMatchObject({ reason: 'update', opId: null });
    expect(await health(ctx)).toBe(503);
    expect(seen.runMigrations).toBe(0);
    expect(await migrationNames()).not.toContain('9001_test_expand');
    // 1d review C16 (plan Task 27: "/admin/_update and GET updates/status show the reasons"): a super admin's session
    // reads them in phase updating, although the release that runs is the blocked one itself.
    const sid = await superAdminSession();
    const status = await httpRequest((await ctx.served()).port, '/api/v1/updates/status', 'GET', { cookie: `${SID_COOKIE}=${sid}` });
    expect(status.status, status.body).toBe(200);
    expect((JSON.parse(status.body) as UpdateStatusView).bundledBlocked).toEqual({ version: V2, failures: ['min_node'] });
    const page = await httpRequest((await ctx.served()).port, '/admin/_update?lang=en', 'GET', { cookie: `${SID_COOKIE}=${sid}`, accept: 'text/html' });
    expect(page.status, page.body).toBe(200);
    expect(page.body).toContain(t('en', 'ops.page.bundled_blocked', { version: V2 }));
  });

  it(
    'a self op killed after its point of no return (current.json already names 0.2.0-test, booted as active) resumes in a normal boot and ends done',
    async () => {
      await imageOfV1();
      // The schemaHold process died in `migrating`, after `switched` named 0.2.0-test active: app.js now boots 0.2.0-test
      // as `active` (its bundled folder is there), no schemaHold.
      const at = Date.now();
      const { op } = await writeOp(dirs.dataDir, {
        kind: 'update',
        state: 'migrating',
        version: V2,
        actor: { type: 'system', id: null },
        pointOfNoReturn: true,
        params: { source: 'self', target: V2, from: V1, entry: null, staging: null, needsBackup: false, schemaLatest: '9001', frozenAt: at - 30_000 },
        progress: 97,
      });
      await writeFlag(dirs.dataDir, flagOf('update', op.opId, at - 30_000));
      await updateCurrentState(dirs.dataDir, () => ({ schema: 1, active: { version: V2, source: 'bundled' }, previous: null, pending: null, pendingSince: null, pinned: null }));
      const normal = bootContext(dirs.dataDir, { version: V2 });
      normal.release = { version: V2, dir: bundledDir(), source: 'bundled' };
      await start(normal as BootContext);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'done' });
      expect(await migrationNames()).toContain('9001_test_expand');
      expect(normal.requestRestart).toHaveBeenCalledWith('update');
      expect(seen.runMigrations).toBe(0);
      expect((await readCurrentState(dirs.dataDir, V1)).active).toEqual({ version: V2, source: 'bundled' });
    },
    60_000,
  );
});
