import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_TYP, signDetached, type KeysetDoc, type TrustedKey } from '@altis/crypto';
import { connect, dropRegisteredTables, readTableColumns, releaseMigrations, runMigrations, withTx, type DbHandle } from '@altis/db';
import { dataPath, readCurrentState, updateCurrentState, withFileLock } from '@altis/platform';
import { DomainError, newId } from '@altis/shared';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { base32Decode, hotp, matchTotp, totpStep } from '../../src/auth/totp.js';
import { auditHeadOf, insertBackupRow, schemaVersionOf } from '../../src/backup/create-job.js';
import { createExporter, type ExportCheckpoint } from '../../src/backup/exporter.js';
import { readManifest, type BackupManifest } from '../../src/backup/manifest.js';
import { openValue, secretAad } from '../../src/crypto/secret-box.js';
import { notify } from '../../src/notifications/service.js';
import { opBootPlan } from '../../src/ops/boot-plan.js';
import { readMaintenance, readOpFile, writeMaintenance, writeOpFile, type OpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpStatus, type OpsMachine } from '../../src/ops/machine.js';
import { createRestoreRunner, type RestoreKindDeps } from '../../src/restore/runner.js';
import { updateKind, type BootHooks, type UpdateKindDeps } from '../../src/updates/kind.js';
import { insertReleaseLog } from '../../src/updates/releases-log.js';
import { schemaCompat } from '../../src/updates/revert.js';
import type { UpdateSource } from '../../src/updates/source.js';
import { KEYRING, SESSION_KEY, loadedChecksums, manifestChecksums, seedInstallation, silent, type Seeded } from '../fixtures/restore-support.js';

// The `update` op after its point of no return (spec §9.3, §9.6 step 6, §9.7; plan Task 25; decisions D1d-17, D1d-21,
// D1d-42, D1d-44; preflight B8, S3, S21, 1D-02, 1D-07) on the engine picked by ALTIS_TEST_DB: the target booting it
// with fake boot hooks (`switched → booting → migrating → verifying → done`, `releaseMigrations(2)` against a level-1
// database), its failures (`migration`, `health`) and its waits (the database), the steps of other releases (S3), and
// the revert by the release the update left: the pointer alone on a database it accepts (`rolled_back`), the
// "terlalu lama" restore of the `pre_update` backup (`restoring → restored`, A7) or `restore_failed` without one.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});
// The next migrateUpOne of the update kind throws this instead of migrating (a lost migrate.lock), when set.
const migrateFault = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  return {
    ...actual,
    migrateUpOne: async (...args: Parameters<typeof actual.migrateUpOne>) => {
      const fault = migrateFault.next;
      migrateFault.next = null;
      if (fault !== null) throw fault;
      return actual.migrateUpOne(...args);
    },
  };
});

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const DEV_KEYS = path.join(REPO_ROOT, 'tools', 'keys', 'dev');
const readDev = (name: string): unknown => JSON.parse(readFileSync(path.join(DEV_KEYS, name), 'utf8')) as unknown;
const ROOTS = readDev('roots.json') as TrustedKey[];
const DEV_KEYSET = readDev('keyset.json') as KeysetDoc[];

function devKey(kid: string): KeyObject {
  const file = readDev(`${kid}.key.json`) as { pkcs8: string };
  return createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
}

/** A dev-root-1 document revoking dev-rel-2 (1D-07: the revocation a release carries). */
const REVOKE_REL_2: KeysetDoc = (() => {
  const payload = { seq: 2, keys: [], revokedKids: ['dev-rel-2'] };
  return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid: 'dev-root-1', privateKey: devKey('dev-root-1') }) };
})();

const ctx = testDbContext();
const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const V3 = '0.3.0-test';
const LEVEL: Readonly<Record<string, 1 | 2 | 3>> = { [V1]: 1, [V2]: 2, [V3]: 3 };
const INSTALL_ID = newId();
const SYSTEM = { type: 'system', id: null } as const;
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The boot hooks start() hands the target in its `update_boot` plan, as spies. */
interface FakeHooks extends BootHooks {
  marker: { phase: Mock<(p: 'importing' | 'listening' | 'migrating') => void>; progress: Mock<() => void>; waiting: Mock<(r: 'db_unavailable' | 'migration_lock') => void> };
  health: Mock<() => Promise<boolean>>;
  markHealthy: Mock<() => Promise<void>>;
}

/** A source that is never asked for anything after the point of no return. */
const NO_SOURCE = new Proxy({} as UpdateSource, {
  get: () => () => {
    throw new Error('the update source is not used after the point of no return');
  },
});

describe.skipIf(!ctx.available)(`update op after its point of no return [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let appRoot: string;
  let offset: number;
  let restarts: string[];
  let machines: OpsMachine[];
  /** Every reading moves the clock 5 ms on, so that `ops.step(1)` runs exactly one handler step. */
  let tick = 0;
  const clock = (): number => Date.now() + offset + (tick += 5);

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-update-boot-')));
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const base = await fsp.mkdtemp(path.join(root, 'case-'));
    dataDir = path.join(base, 'data');
    appRoot = path.join(base, 'app');
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.mkdir(appRoot, { recursive: true });
    offset = 0;
    restarts = [];
    machines = [];
    await dropRegisteredTables(h.db, h.dialect);
  });

  afterEach(async () => {
    for (const m of machines.splice(0)) await m.close();
    vi.unstubAllEnvs();
  });

  /** The database at the schema of `version` (its fixture level), as that release migrated it. */
  async function migrateTo(version: string): Promise<void> {
    await runMigrations(h, { appVersion: version, dataDir, migrations: releaseMigrations(LEVEL[version]!) });
  }

  function fakeHooks(version: string, o: { healthy?: boolean } = {}): FakeHooks {
    return {
      version,
      marker: { phase: vi.fn(), progress: vi.fn(), waiting: vi.fn() },
      health: vi.fn(async () => o.healthy ?? true),
      // app.js's promotion: previous = active, active = pending, pending = null.
      markHealthy: vi.fn(async () => {
        await updateCurrentState(dataDir, (s) =>
          s.pending?.version === version ? { ...s, previous: s.active, active: s.pending, pending: null, pendingSince: null } : null,
        );
      }),
    };
  }

  function restoreDeps(version: string): RestoreKindDeps {
    return {
      dataDir,
      appVersion: version,
      migrations: releaseMigrations(LEVEL[version]!),
      sessionKey: () => SESSION_KEY,
      keyring: () => KEYRING,
      installId: INSTALL_ID,
      requestRestart: async () => {},
      sqliteSwap: null,
    };
  }

  /** The update kind's deps of release `version`, with `hooks` when it boots the target. */
  function deps(version: string, hooks: BootHooks | null): UpdateKindDeps {
    return {
      dataDir,
      appRoot,
      appVersion: version,
      source: NO_SOURCE,
      precheck: async () => {
        throw new Error('no precheck after the point of no return');
      },
      roots: ROOTS,
      sources: async () => [],
      refuseDevKids: false,
      backup: { dataDir, installId: INSTALL_ID, appVersion: version, sessionKey: SESSION_KEY, kids: ['k1'] },
      migrations: releaseMigrations(LEVEL[version]!),
      restore: createRestoreRunner(restoreDeps(version)),
      requestRestart: async (reason) => {
        restarts.push(reason);
      },
      boot: () => hooks,
      snapshotBackupRunning: async () => false,
      notify,
      log: silent,
    };
  }

  /** The ops machine of release `version` (its update kind with `hooks`); `db` false: no live handle, no connection. */
  function machineOf(version: string, hooks: BootHooks | null = null, o: { db?: boolean } = {}): OpsMachine {
    const live = o.db ?? true;
    const m = createOpsMachine({
      dataDir,
      kinds: [updateKind(() => deps(version, hooks))],
      db: () => (live ? h : undefined),
      connect: async () => {
        if (!live) throw new DomainError('DB_UNAVAILABLE', { meta: { reason: 'unreachable' } });
        return connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir });
      },
      keyring: () => KEYRING,
      clock,
      log: silent,
      snapshotBackupRunning: async () => false,
      appVersion: version,
    });
    machines.push(m);
    return m;
  }

  /**
   * An update op past its point of no return, as release `from` left it for the target `target`: op.json in `state`
   * (frozen at `verified`, `pending` written), its `releases_log` row `running`, its maintenance flag, and current.json
   * with `pending` = the target unless `pending` says otherwise.
   */
  async function updateOp(o: {
    state: string;
    target: string;
    from: string;
    opId?: string;
    backupId?: string | null;
    error?: OpFile['error'];
    stateBefore?: string;
    params?: Record<string, unknown>;
    pending?: boolean;
  }): Promise<OpFile> {
    const now = clock();
    const opId = o.opId ?? newId(now);
    const op: OpFile = {
      opSchema: 1,
      opId,
      kind: 'update',
      actor: SYSTEM,
      state: o.state,
      version: o.from,
      backupId: o.backupId ?? null,
      heartbeatAt: now,
      startedAt: now - 60_000,
      finishedAt: null,
      error: o.error ?? null,
      opsTokenHash: null,
      pointOfNoReturn: true,
      params: {
        source: 'feed',
        target: o.target,
        from: o.from,
        entry: null,
        staging: null,
        needsBackup: o.backupId !== undefined && o.backupId !== null,
        pendingWritten: true,
        frozenAt: now - 50_000,
        ...o.params,
      },
      progress: 95,
      message: null,
      ...(o.stateBefore === undefined ? {} : { stateBefore: o.stateBefore }),
    };
    await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
    await writeOpFile(dataDir, op);
    await writeMaintenance(dataDir, { reason: 'update', since: now - 50_000, opId, exemptJobIds: [] });
    await withTx(h, (trx) =>
      insertReleaseLog(trx, { id: opId, version: o.target, action: 'update', fromVersion: o.from, startedAt: op.startedAt, backupId: o.backupId ?? null }),
    );
    await readCurrentState(dataDir, o.from); // active = `from` (bundled)
    if (o.pending ?? true) {
      await updateCurrentState(dataDir, (s) => ({ ...s, pending: { version: o.target, source: 'data' }, pendingSince: now - 10_000 }));
    }
    return op;
  }

  const opJson = async (): Promise<OpFile> => {
    const op = await readOpFile(dataDir);
    if (op === null || op === 'corrupt') throw new Error('op.json');
    return op;
  };
  const current = () => updateCurrentState(dataDir, () => null).then((r) => r.state);
  const logRow = (opId: string) => h.db.selectFrom('releases_log').selectAll().where('id', '=', opId).executeTakeFirstOrThrow();
  const applies = async (opId: string) =>
    (await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'update.apply').where('entity_id', '=', opId).execute()).map(
      (r) => JSON.parse(r.meta) as Record<string, unknown>,
    );
  const notificationTypes = async () => (await h.db.selectFrom('notifications').select('type').orderBy('created_at').execute()).map((r) => r.type);
  const migrationNames = async () => (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name).sort();

  /** Steps the op (each call ≤ `budget` ms) until it ends, needs attention, or `until` holds. */
  async function stepUntil(ops: OpsMachine, until: (s: OpStatus) => boolean = () => false, budget = 20_000): Promise<OpStatus> {
    let status: OpStatus | null = null;
    for (let i = 0; i < 500; i += 1) {
      status = await ops.step(budget);
      if (status === null) throw new Error('no op');
      if (status.terminal || status.needsAttention || until(status)) return status;
    }
    if (status === null) throw new Error('no op');
    return status;
  }

  describe('the boot of the target', () => {
    it('switched → done: 9001 applied, health asked, markHealthy once, the flag gone, releases_log done, one update.apply, update_done', async () => {
      await migrateTo(V1);
      const { opId } = await updateOp({ state: 'switched', target: V2, from: V1 });
      const hooks = fakeHooks(V2);
      const status = await stepUntil(machineOf(V2, hooks));
      expect(status).toMatchObject({ opId, state: 'done', terminal: true, error: null, progress: 100 });

      expect(await migrationNames()).toContain('9001_test_expand');
      expect(hooks.marker.phase.mock.calls.map((c) => c[0])).toEqual(['listening', 'migrating']);
      expect(hooks.marker.progress).toHaveBeenCalled();
      expect(hooks.health).toHaveBeenCalledTimes(1);
      expect(hooks.markHealthy).toHaveBeenCalledTimes(1);
      expect(await current()).toMatchObject({ active: { version: V2 }, previous: { version: V1 }, pending: null });
      expect(await readMaintenance(dataDir)).toBeNull();
      expect(await logRow(opId)).toMatchObject({ status: 'done' });
      expect(await applies(opId)).toEqual([expect.objectContaining({ outcome: 'done', target: V2, from: V1 })]);
      expect(await notificationTypes()).toEqual(['update.done']);
      // The system roles of verifying are there.
      expect((await h.db.selectFrom('roles').select('key').where('is_system', '=', 1).execute()).length).toBeGreaterThan(0);
    });

    it('a migration error (migrate:9001_test_expand) → reverting with UPDATE_BOOT_FAILED migration; the target never steps its revert (B8)', async () => {
      vi.stubEnv('ALTIS_TEST_FAULT', 'migrate:9001_test_expand');
      await migrateTo(V1);
      const { opId } = await updateOp({ state: 'switched', target: V2, from: V1 });
      const hooks = fakeHooks(V2);
      const ops = machineOf(V2, hooks);
      const status = await stepUntil(ops, (s) => s.state === 'reverting');
      expect(status).toMatchObject({ opId, state: 'reverting', error: { code: 'UPDATE_BOOT_FAILED', detail: 'migration' } });
      expect(await migrationNames()).not.toContain('9001_test_expand');
      expect(hooks.markHealthy).not.toHaveBeenCalled();
      // B8: the plan of the target is `refuse` (pending boot or not), and a direct step leaves the op as it is.
      const op = await opJson();
      expect(opBootPlan(op, V2, true)).toBe('refuse');
      expect(opBootPlan(op, V2, false)).toBe('refuse');
      expect(opBootPlan(op, V1, false)).toBe('revert');
      expect(await ops.step(20_000)).toMatchObject({ state: 'reverting' });
      expect(await opJson()).toMatchObject({ state: 'reverting', error: { detail: 'migration' } });
      expect((await current()).pending).toEqual({ version: V2, source: 'data' });
      expect(await logRow(opId)).toMatchObject({ status: 'running' });
      expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', opId });
    });

    it('health false → reverting with detail health; nothing promoted', async () => {
      await migrateTo(V1);
      const { opId } = await updateOp({ state: 'switched', target: V2, from: V1 });
      const hooks = fakeHooks(V2, { healthy: false });
      const status = await stepUntil(machineOf(V2, hooks), (s) => s.state === 'reverting');
      expect(status).toMatchObject({ opId, state: 'reverting', error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' } });
      expect(hooks.health).toHaveBeenCalledTimes(1);
      expect(hooks.markHealthy).not.toHaveBeenCalled();
      expect(await current()).toMatchObject({ active: { version: V1 }, pending: { version: V2 } });
    });

    // Review C09 (§9.3 "Bukan alasan revert: … galat konektivitas DB"): health() throwing DB_UNAVAILABLE (updateHealth's
    // ping timed out or lost the connection) is a wait, for a target and for a `self` update alike.
    it.each(['feed', 'self'])('verifying whose health() throws DB_UNAVAILABLE → the op as it was (%s), then done once it answers', async (source) => {
      await migrateTo(V2);
      const { opId } = await updateOp({ state: 'verifying', target: V2, from: V1, params: { source }, pending: source === 'feed' });
      const hooks = fakeHooks(V2);
      hooks.health.mockRejectedValueOnce(new DomainError('DB_UNAVAILABLE', { meta: { reason: 'health_check' } }));
      const ops = machineOf(V2, hooks);
      await expect(ops.step(20_000)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
      expect(await opJson()).toMatchObject({ opId, state: 'verifying', error: null });
      expect(await logRow(opId)).toMatchObject({ status: 'running' });
      expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', opId });
      expect(await stepUntil(ops)).toMatchObject({ opId, state: 'done', error: null });
      expect(hooks.health).toHaveBeenCalledTimes(2);
    });

    it('the database unreachable in switched → the op as it was, marker.waiting(db_unavailable)', async () => {
      await migrateTo(V1);
      const { opId } = await updateOp({ state: 'switched', target: V2, from: V1 });
      const hooks = fakeHooks(V2);
      const status = await machineOf(V2, hooks, { db: false }).step(20_000);
      expect(status).toMatchObject({ opId, state: 'switched', needsAttention: false });
      expect(await opJson()).toMatchObject({ state: 'switched', error: null });
      expect(hooks.marker.phase).toHaveBeenCalledWith('listening');
      expect(hooks.marker.waiting).toHaveBeenCalledWith('db_unavailable');
      expect(hooks.health).not.toHaveBeenCalled();
    });

    it('migrating while another process holds migrate.lock → the op as it was, marker.waiting(migration_lock); then done', async () => {
      await migrateTo(V1);
      const { opId } = await updateOp({ state: 'migrating', target: V2, from: V1 });
      const hooks = fakeHooks(V2);
      const ops = machineOf(V2, hooks);
      await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
      await withFileLock(dataPath(dataDir, 'tmp', 'migrate.lock'), async () => {
        expect(await ops.step(1500)).toMatchObject({ opId, state: 'migrating', needsAttention: false });
      });
      expect(hooks.marker.waiting).toHaveBeenCalledWith('migration_lock');
      expect(await migrationNames()).not.toContain('9001_test_expand');
      expect(await stepUntil(ops)).toMatchObject({ opId, state: 'done' });
      expect(await migrationNames()).toContain('9001_test_expand');
    });

    it('a lost migrate.lock in migrating is no failed migration: the op as it was (no revert), then done', async () => {
      await migrateTo(V1);
      const { opId } = await updateOp({ state: 'migrating', target: V2, from: V1 });
      const hooks = fakeHooks(V2);
      const ops = machineOf(V2, hooks);
      migrateFault.next = new DomainError('STATE_CORRUPT', { meta: { reason: 'lock_lost' } });
      await expect(ops.step(20_000)).rejects.toMatchObject({ code: 'STATE_CORRUPT', meta: { reason: 'lock_lost' } });
      expect(await opJson()).toMatchObject({ opId, state: 'migrating', error: null });
      expect(await stepUntil(ops)).toMatchObject({ opId, state: 'done' });
      expect(await migrationNames()).toContain('9001_test_expand');
    });

    it('verifying whose markHealthy did not promote the target (no pending boot) → needs_attention, never done', async () => {
      await migrateTo(V2);
      const { opId } = await updateOp({ state: 'verifying', target: V2, from: V1 });
      const hooks = fakeHooks(V2);
      hooks.markHealthy.mockImplementation(async () => {}); // app.js's markHealthy of a release booted as `active`
      const status = await stepUntil(machineOf(V2, hooks));
      expect(status).toMatchObject({ opId, needsAttention: true });
      expect(await opJson()).toMatchObject({ state: 'needs_attention', stateBefore: 'verifying' });
      expect(hooks.markHealthy).toHaveBeenCalledTimes(1);
      expect(await logRow(opId)).toMatchObject({ status: 'running' });
      expect(await applies(opId)).toEqual([]);
      expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', opId });
      expect(await current()).toMatchObject({ active: { version: V1 }, pending: { version: V2 } });
    });

    it('a target without the boot hooks (a process that does not boot it) leaves switched..verifying as they are', async () => {
      await migrateTo(V1);
      await updateOp({ state: 'migrating', target: V2, from: V1 });
      expect(await machineOf(V2, null).step(20_000)).toMatchObject({ state: 'migrating' });
      expect(await migrationNames()).not.toContain('9001_test_expand');
    });

    it('verifying after the promotion (finishUpdate not yet written) → done without health or markHealthy again', async () => {
      await migrateTo(V2);
      const { opId } = await updateOp({ state: 'verifying', target: V2, from: V1, pending: false });
      await updateCurrentState(dataDir, (s) => ({ ...s, previous: s.active, active: { version: V2, source: 'data' } }));
      const hooks = fakeHooks(V2, { healthy: false });
      expect(await stepUntil(machineOf(V2, hooks))).toMatchObject({ opId, state: 'done' });
      expect(hooks.health).not.toHaveBeenCalled();
      expect(hooks.markHealthy).not.toHaveBeenCalled();
      expect(await applies(opId)).toEqual([expect.objectContaining({ outcome: 'done' })]);
      expect(await readMaintenance(dataDir)).toBeNull();
    });

    // Review C08 (§9.3, Review Focus 1 and 4): after the point of no return only the target's boot moves the op, and
    // nothing steps it while no process boots it (no request since `switched`, a holder killed mid-migration). Its
    // heartbeat may then be older than the 15-minute stall rule; only §9.3's own rules may revert it.
    it.each(['switched', 'migrating'])('%s whose heartbeat is 16 min old → the target with its boot hooks steps it on to done', async (state) => {
      await migrateTo(V1);
      const op = await updateOp({ state, target: V2, from: V1 });
      await writeOpFile(dataDir, { ...op, heartbeatAt: clock() - 16 * 60_000 });
      const hooks = fakeHooks(V2);
      const status = await stepUntil(machineOf(V2, hooks));
      expect(status).toMatchObject({ opId: op.opId, state: 'done', needsAttention: false, error: null });
      expect(hooks.markHealthy).toHaveBeenCalledTimes(1);
      expect(await migrationNames()).toContain('9001_test_expand');
      expect(await current()).toMatchObject({ active: { version: V2 }, pending: null });
    });
  });

  describe('steps of a release other than the target (S3)', () => {
    it('migrating with pending null → reverting (repeated); with pending = the target → as it was', async () => {
      await migrateTo(V1);
      const { opId } = await updateOp({ state: 'migrating', target: V2, from: V1, pending: true });
      const ops = machineOf(V1);
      expect(await ops.step(20_000)).toMatchObject({ opId, state: 'migrating' });
      expect(await opJson()).toMatchObject({ state: 'migrating', error: null });

      await updateCurrentState(dataDir, (s) => ({ ...s, pending: null, pendingSince: null })); // a revert cleared it, unrecorded
      expect(await ops.step(1)).toMatchObject({ opId, state: 'reverting', error: { code: 'UPDATE_BOOT_FAILED', detail: 'repeated' } });
      // The next step of 0.1 reverts it (the database accepts 0.1).
      expect(await stepUntil(ops)).toMatchObject({ opId, state: 'rolled_back', error: { detail: 'repeated' } });
    });

    it('verifying with the target promoted (active, finishUpdate not yet written) → as it was for 0.1', async () => {
      await migrateTo(V2);
      const { opId } = await updateOp({ state: 'verifying', target: V2, from: V1, pending: false });
      await updateCurrentState(dataDir, (s) => ({ ...s, previous: s.active, active: { version: V2, source: 'data' } }));
      expect(await machineOf(V1).step(20_000)).toMatchObject({ opId, state: 'verifying', error: null });
      expect(await logRow(opId)).toMatchObject({ status: 'running' });
    });

    // Review C08: a step of 0.1 on an op whose heartbeat went stale while it waited for its target's boot leaves it as
    // it was (its holder boots it); needs_attention would make app.js revert the target without importing it (B8).
    it.each(['switched', 'migrating'])('%s whose heartbeat is 16 min old, pending = the target → as it was for 0.1, never needs_attention', async (state) => {
      await migrateTo(V1);
      const op = await updateOp({ state, target: V2, from: V1, pending: true });
      await writeOpFile(dataDir, { ...op, heartbeatAt: clock() - 16 * 60_000 });
      expect(await machineOf(V1).step(20_000)).toMatchObject({ opId: op.opId, state, needsAttention: false, error: null });
      expect(await opJson()).toMatchObject({ state, error: null });
      expect((await current()).pending).toEqual({ version: V2, source: 'data' });
    });
  });

  describe('the revert by the release the update left', () => {
    it('0.1 on a database at 9001 (compatible) → rolled_back: pending null, releases_log rolled_back, update_rolled_back, the flag lowered', async () => {
      await migrateTo(V2);
      expect(await schemaCompat(h.db, V1)).toBe(true);
      const { opId } = await updateOp({
        state: 'reverting',
        stateBefore: 'migrating',
        target: V2,
        from: V1,
        error: { code: 'UPDATE_BOOT_FAILED', detail: 'start' },
        pending: true, // app.js was killed between its op record and its own pending = null
      });
      const status = await stepUntil(machineOf(V1));
      expect(status).toMatchObject({ opId, state: 'rolled_back', terminal: true, error: { code: 'UPDATE_BOOT_FAILED', detail: 'start' } });
      expect(await current()).toMatchObject({ active: { version: V1 }, pending: null, pendingSince: null });
      expect(await logRow(opId)).toMatchObject({ status: 'rolled_back' });
      expect(await applies(opId)).toEqual([expect.objectContaining({ outcome: 'rolled_back', error: 'UPDATE_BOOT_FAILED' })]);
      expect(await notificationTypes()).toEqual(['update.rolled_back']);
      expect(await readMaintenance(dataDir)).toBeNull();
      expect(await migrationNames()).toContain('9001_test_expand'); // the schema stays (§9.7 "skema dibiarkan")
      expect(restarts).toEqual([]);
    });

    it('without a pre_update backup on a database too new → restore_failed, the flag kept, the error naming the CLI steps', async () => {
      await migrateTo(V3);
      expect(await schemaCompat(h.db, V2)).toBe(false);
      const { opId } = await updateOp({
        state: 'reverting',
        stateBefore: 'verifying',
        target: V3,
        from: V2,
        error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' },
      });
      const status = await stepUntil(machineOf(V2));
      expect(status).toMatchObject({ opId, state: 'restore_failed', terminal: true, error: { code: 'SCHEMA_TOO_NEW' } });
      expect(status.error?.detail).toContain('node app.js backup:restore');
      expect(status.error?.detail).toContain('node app.js release:rollback');
      expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', opId });
      expect(await logRow(opId)).toMatchObject({ status: 'restore_failed' });
      expect(await notificationTypes()).toEqual(['update.restore_failed']);
      expect((await current()).pending).toBeNull();
    });

    describe('A7: "rollback dengan restore" (0.2 on a database at 9002)', () => {
      let seeded: Seeded;

      /** A DB-only `pre_update` backup of the database now, its row `ok`. */
      async function preUpdateBackup(): Promise<{ backupId: string; manifest: BackupManifest }> {
        const backupId = newId();
        const now = Date.now();
        const schemaVersion = await schemaVersionOf(h.db);
        await insertBackupRow(h, { id: backupId, kind: 'pre_update', consistency: 'frozen', dialect: h.dialect, schemaVersion, appVersion: V2, now });
        const exporter = createExporter({
          read: h.db,
          dialect: h.dialect,
          dataDir,
          backupId,
          kind: 'pre_update',
          includeFiles: false,
          consistency: 'frozen',
          appVersion: V2,
          schemaVersion,
          installId: INSTALL_ID,
          sessionKey: SESSION_KEY,
          kids: ['k1'],
          auditHead: await auditHeadOf(h.db),
          clock: () => now,
        });
        let cp: ExportCheckpoint | null = null;
        for (;;) {
          const r = await exporter.step(cp, { deadline: Date.now() + 60_000 });
          cp = r.checkpoint;
          if (r.done) break;
        }
        const bytes = await fsp.readFile(path.join(dataDir, 'backups', backupId, 'manifest.json'));
        await h.db.updateTable('backups').set({ status: 'ok', size: bytes.byteLength, sha256: sha256(bytes) }).where('id', '=', backupId).execute();
        return { backupId, manifest: (await readManifest(dataDir, backupId))! };
      }

      async function totpWorks(hd: DbHandle, userId: string, plain: string): Promise<boolean> {
        const row = await hd.db.selectFrom('staff_users').select(['totp_secret_enc', 'totp_last_step']).where('id', '=', userId).executeTakeFirstOrThrow();
        if (row.totp_secret_enc === null) return false;
        const text = openValue(KEYRING, secretAad('staff_users', 'totp_secret_enc', userId), row.totp_secret_enc);
        if (text !== plain) return false;
        const secret = base32Decode(text);
        const now = Date.now();
        return matchTotp(secret, hotp(secret, totpStep(now), 6), now, Number(row.totp_last_step)) !== null;
      }

      beforeEach(async () => {
        await migrateTo(V2);
        seeded = await seedInstallation(h, { dataDir, installId: INSTALL_ID });
        const now = Date.now();
        for (let i = 0; i < 3; i += 1) {
          await h.db.insertInto('test_fixture' as never).values({ id: newId(now), note: `catatan ${i}`, created_at: now + i } as never).execute();
        }
      });

      it('reverting → restoring → restored: 9001 again, the backup data, 2FA intact, requestRestart(restore); unknown fields kept (S21)', { timeout: 180_000 }, async () => {
        const opId = newId(clock());
        const { backupId, manifest } = await preUpdateBackup();
        expect(manifest.schemaVersion).toBe('9001_test_expand');
        // The target 0.3 migrated 9002 (min_code_version 0.3.0-test) and changed rows before it failed.
        await migrateTo(V3);
        await sql`UPDATE test_fixture SET note = ${'diubah'}, extra = ${'tambahan'}`.execute(h.db);
        expect(await schemaCompat(h.db, V2)).toBe(false);
        await updateOp({
          opId,
          state: 'reverting',
          stateBefore: 'verifying',
          target: V3,
          from: V2,
          backupId,
          error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' },
          params: { future: 1 },
        });
        const ops = machineOf(V2);
        expect(await ops.step(1)).toMatchObject({ opId, state: 'restoring' });
        const restoring = await opJson();
        expect(restoring.params['future']).toBe(1);
        expect(restoring.params['restore']).toMatchObject({
          state: 'verifying',
          params: { backupId, source: 'server', targetSchema: 'backup', skipPreRestore: true, secrets: 'a', dropBy: 'schema_tables', confirmed: true, withoutFiles: false },
        });
        expect((await current()).pending).toBeNull();
        // A later release's fields in params.restore (S21) survive the restoring steps.
        await writeOpFile(dataDir, { ...restoring, params: { ...restoring.params, restore: { ...(restoring.params['restore'] as object), future: 2 } } });

        const status = await stepUntil(ops);
        expect(status).toMatchObject({ opId, state: 'restored', terminal: true });
        const op = await opJson();
        expect(op.params['future']).toBe(1);
        expect(op.params['restore']).toMatchObject({ state: 'done', future: 2 });

        // The schema of the backup, its rows, its min_code_version.
        expect((await migrationNames()).at(-1)).toBe('9001_test_expand');
        expect((await readTableColumns(h.db, h.dialect, 'test_fixture')).map((c) => c.name)).toEqual(['id', 'note', 'created_at']);
        expect(await schemaCompat(h.db, V2)).toBe(true);
        expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
        for (const u of seeded.users.filter((x) => x.totp !== null)) expect(await totpWorks(h, u.id, u.totp!)).toBe(true);
        expect(await h.db.selectFrom('backups').select('id').where('kind', '=', 'pre_restore').execute()).toEqual([]);

        expect(restarts).toEqual(['restore']);
        expect(await logRow(opId)).toMatchObject({ status: 'restored', backup_id: backupId });
        expect(await applies(opId)).toEqual([expect.objectContaining({ outcome: 'restored', backupId })]);
        expect(await readMaintenance(dataDir)).toBeNull();
      });
    });
  });

  it('1D-07: a bundled update whose release revokes dev-rel-2 reverts to rolled_back; once its folder is gone the store still revokes it', async () => {
    await migrateTo(V1);
    // <appRoot>/bundled-release/0.2.0-test with a keyset.json carrying the revocation (no schema change: no backup).
    const files: Record<string, Buffer> = {
      'server.mjs': Buffer.from('export const bootProtocol = 1;\nexport async function start() {}\nexport async function runCli() { return 0; }\n'),
      'keyset.json': Buffer.from(`${JSON.stringify([...DEV_KEYSET, REVOKE_REL_2], null, 2)}\n`),
      'public/admin/index.html': Buffer.from('<!doctype html><title>ALTIS</title>\n'),
    };
    const manifest = {
      version: V2,
      buildId: `build-${V2}`,
      bootProtocol: 1,
      releasedAt: '2026-11-01',
      schemaLatest: '0009',
      minCodeVersionAfter: '0.0.0',
      minUpgradeFrom: '0.0.0',
      minNode: '22.16.0',
      minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
      files: Object.keys(files)
        .sort()
        .map((p) => ({ path: p, sha256: sha256(files[p]!), size: files[p]!.byteLength })),
    };
    const dir = path.join(appRoot, 'bundled-release', V2);
    for (const [p, data] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
      await fsp.writeFile(path.join(dir, p), data);
    }
    await fsp.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fsp.writeFile(path.join(dir, 'manifest.sig'), JSON.stringify(signDetached(manifest, { typ: RELEASE_TYP, kid: 'dev-rel-1', privateKey: devKey('dev-rel-1') })));
    await fsp.writeFile(path.join(dir, '.complete'), '');
    await readCurrentState(dataDir, V1);

    const ops = machineOf(V1);
    const { opId } = await ops.begin('update', SYSTEM, { source: 'bundled', target: V2, from: V1, entry: null, staging: null, needsBackup: null }, { state: 'verified' });
    offset += 4000; // the freeze settles
    const switched = await stepUntil(ops, (s) => s.state === 'switched');
    expect(switched).toMatchObject({ opId, state: 'switched' });
    expect((await current()).pending).toEqual({ version: V2, source: 'data' });
    const store = path.join(dataDir, 'releases', 'keyset.json');
    const held = (): Promise<string[]> => fsp.readFile(store, 'utf8').then((t) => (JSON.parse(t) as KeysetDoc[]).map((d) => d.raw));
    expect(await held()).toContain(REVOKE_REL_2.raw);

    // The target failed to start: app.js recorded the op `reverting` and cleared `pending`.
    const op = await opJson();
    await writeOpFile(dataDir, { ...op, state: 'reverting', stateBefore: 'switched', error: { code: 'UPDATE_BOOT_FAILED', detail: 'start' } });
    await updateCurrentState(dataDir, (s) => ({ ...s, pending: null, pendingSince: null }));
    expect(await stepUntil(ops)).toMatchObject({ opId, state: 'rolled_back' });

    // Retention removes the release that is neither active, previous nor pending (Task 27's sweep, done by hand here).
    await fsp.rm(path.join(dataDir, 'releases', V2), { recursive: true, force: true });
    expect(await held()).toContain(REVOKE_REL_2.raw);
  });
});
