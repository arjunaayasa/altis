import { fork, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  SCHEDULES,
  createExporter,
  createOpsMachine,
  createSqliteSwap,
  ensureSystemRoles,
  loadTables,
  readDataEpoch,
  readManifest,
  readMaintenance,
  readOpFile,
  restoreKind,
  seedSchedules,
  tableChecksumFromDb,
  writeSettings,
  type BackupManifest,
  type ExportCheckpoint,
  type OpsMachine,
} from '@altis/core';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx, type DbConfig, type DbHandle } from '@altis/db';
import { newId } from '@altis/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import type { AppState } from '../../src/app.js';
import { writeConfig } from '../../src/config.js';
import { csrfKey } from '../../src/http/csrf.js';
import { start } from '../../src/index.js';
import { createAppOps } from '../../src/services.js';
import { bootContext, closeTestServers, httpRequest, recordingLogger, sampleConfig, serverLog, useDataDir } from '../support.js';

// A server process that boots while a restore loads (preflight B4, decision C40; Review Focus 2; plan Task 22) on the
// engine picked by ALTIS_TEST_DB: the restore has committed the first part of `staff_users` when a child process runs
// start() on the same DATA_DIR and database. It waits in `ops_wait` (/_health 503 maintenance, no migration, no
// `roles` write) while this process steps the restore to `done`; then every table equals the backup's checksums, the
// roles are the backup's, and the child leaves `ops_wait` by itself (its ops fence, looked at by requests) and answers
// /_health 200.
//
// SQLite (plan Task 25, decision C17) restores on a work file swapped into place, so it has cases of its own below: a
// process booting during `loading` waits in `ops_wait` without ever opening `db/altis.sqlite` (it never records itself
// in `tmp/sqlite-owner.json`), and boots normally on the backup's roles once the restore is done; a server that was
// already serving lets go of its file when its ops fence (looked at by requests) sees `sqliteRelease`, reopens it after
// the data epoch moved, asks for its restart (`data-epoch`, S23) and serves the restored data; a server that steps the
// swap itself and fails after it let go of its file, before the renames, opens its file again and keeps serving
// (R1c-11).

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

/** Arms one failure of the SQLite swap's history copy (2b): its read of `releases_log` on the live file throws once. */
const historyFault = vi.hoisted(() => ({ armed: false }));
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  const readPkBatch: typeof actual.readPkBatch = (db, dialect, table, o) => {
    if (historyFault.armed && table === 'releases_log') {
      historyFault.armed = false;
      return Promise.reject(new Error('armed failure of the history copy'));
    }
    return actual.readPkBatch(db, dialect, table, o);
  };
  return { ...actual, readPkBatch };
});

const engine = testDbContext();
const dirs = useDataDir();
const silent = { info() {}, warn() {}, error() {} };
const children: ChildProcess[] = [];

afterEach(async () => {
  historyFault.armed = false;
  await closeTestServers();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.disconnect();
    await exited;
  }
  vi.unstubAllEnvs();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The schema version as the backups row and the manifest record it (the last migration's name). */
const SCHEMA_VERSION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;

describe.skipIf(!engine.available || engine.engine === 'sqlite')(`a server booting during a restore [${engineLabel()}]`, () => {
  it('waits in ops_wait while the restore loads; boots by itself on the backup’s data and roles once it is done', async () => {
    const dataDir = dirs.dataDir;
    await fsp.mkdir(dataDir, { recursive: true });
    const dbConfig: DbConfig = engine.engine === 'sqlite' ? { dialect: 'sqlite' } : testDbConfig(engine);
    if (engine.engine !== 'sqlite') await (await testDb()).close(); // an empty database
    const config = sampleConfig({ db: dbConfig });
    await writeConfig(dataDir, config);
    const open = (): Promise<DbHandle> => connect(dbConfig, { runtime: 'standalone', purpose: 'cli', dataDir });
    const h = await open();
    let ops: OpsMachine | undefined;
    try {
      // The installation: migrated, system roles, schedules, five staff users, a branch, its install id.
      await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
      const now = Date.now();
      await withTx(h, async (trx) => {
        await ensureSystemRoles(trx, now);
        await seedSchedules(trx, now, 'Asia/Jakarta', SCHEDULES);
        for (let i = 0; i < 5; i += 1) {
          await trx
            .insertInto('staff_users')
            .values({ id: newId(now), username_key: `staf_${i}`, username_display: `staf_${i}`, name: `Staf ${i}`, password_hash: 'x', status: 'active', created_at: now, updated_at: now })
            .execute();
        }
        await trx
          .insertInto('branches')
          .values({ id: newId(now), code_key: 'PUSAT', code_display: 'PUSAT', name: 'Pusat', timezone: 'Asia/Jakarta', is_default: 1, version: 1, created_at: now, updated_at: now })
          .execute();
        await trx.updateTable('schema_meta').set({ install_id: config.install.id }).where('id', '=', 1).execute();
      });
      const archivedRoles = await h.db.selectFrom('roles').selectAll().orderBy('id').execute();

      // A backup of one row per part (staff_users in five parts).
      vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '1');
      const backupId = newId();
      const exporter = createExporter({
        read: h.db,
        dialect: h.dialect,
        dataDir,
        backupId,
        kind: 'manual',
        includeFiles: false,
        consistency: 'frozen',
        appVersion: '0.1.0',
        schemaVersion: SCHEMA_VERSION,
        installId: config.install.id,
        sessionKey: csrfKey(config),
        kids: config.keyring.map((k) => k.kid),
        auditHead: { seq: 0, hash: '0'.repeat(64) },
        clock: () => now,
      });
      let cp: ExportCheckpoint | null = null;
      for (;;) {
        const r = await exporter.step(cp, { deadline: Date.now() + 60_000 });
        cp = r.checkpoint;
        if (r.done) break;
      }
      vi.unstubAllEnvs();
      const manifest = (await readManifest(dataDir, backupId))!;
      await h.db
        .insertInto('backups')
        .values({ id: backupId, kind: 'manual', size: 1, sha256: null, schema_version: SCHEMA_VERSION, app_version: '0.1.0', dialect: h.dialect, consistency: 'frozen', status: 'ok', created_at: now })
        .execute();
      await h.db.updateTable('branches').set({ name: 'Diubah' }).execute();

      // The restore, stepped here until the first part of staff_users is committed.
      let offset = 0;
      ops = createOpsMachine({
        dataDir,
        kinds: [
          restoreKind({
            dataDir,
            appVersion: '0.1.0',
            migrations: PHASE1_MIGRATIONS,
            sessionKey: () => csrfKey(config),
            keyring: () => config.keyring,
            installId: config.install.id,
            requestRestart: async () => {},
            sqliteSwap: null,
          }),
        ],
        db: () => undefined,
        connect: open,
        keyring: () => config.keyring,
        clock: () => Date.now() + offset,
        log: silent,
        snapshotBackupRunning: async () => false,
      });
      vi.stubEnv('ALTIS_TEST_RESTORE_TX_ROWS', '1');
      await ops.begin('restore', { type: 'system', id: null }, { backupId, source: 'server', withoutFiles: false, confirmed: false, targetSchema: 'latest' });
      offset = 4000;
      const staffIndex = loadTables(manifest).indexOf('staff_users');
      const loadOf = async () => {
        const op = await readOpFile(dataDir);
        if (op === null || op === 'corrupt') throw new Error('no op.json');
        return { state: op.state, load: op.params['load'] as { table: number; part: number } | undefined };
      };
      for (let i = 0; i < 2000; i += 1) {
        await ops.step(1);
        const { state, load } = await loadOf();
        if (state === 'loading' && load !== undefined && load.table === staffIndex && load.part >= 2) break;
      }
      expect(await loadOf()).toMatchObject({ state: 'loading', load: { table: staffIndex } });
      const rolesWhileLoading = await h.db.selectFrom('roles').selectAll().orderBy('id').execute();
      const migrationsWhileLoading = await h.db.selectFrom('schema_migrations').select('name').execute();

      // A server process boots now.
      const child = fork(
        path.join(import.meta.dirname, '../fixtures/boot-child.mjs'),
        [JSON.stringify({ dataDir, appRoot: path.join(dirs.root, 'app'), runtime: 'standalone' })],
        {
          cwd: path.resolve(import.meta.dirname, '../../../..'),
          env: { ...process.env, ALTIS_RUNNER: 'off' },
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        },
      );
      children.push(child);
      const messages: unknown[] = [];
      child.on('message', (m) => messages.push(m));
      const port = await new Promise<number>((resolve, reject) => {
        child.once('message', (m) => resolve((m as { port: number }).port));
        child.once('exit', (c, s) => reject(new Error(`boot child exited (${String(c ?? s)})`)));
      });
      await vi.waitFor(
        async () => {
          const reply = await httpRequest(port, '/_health');
          expect({ status: reply.status, body: JSON.parse(reply.body) as unknown }).toMatchObject({ status: 503, body: { status: 'maintenance' } });
        },
        { timeout: 15_000, interval: 100 },
      );
      await sleep(2500); // past a fence interval: the child had every chance to boot, migrate or seed
      expect(await h.db.selectFrom('roles').selectAll().orderBy('id').execute()).toEqual(rolesWhileLoading);
      expect(await h.db.selectFrom('schema_migrations').select('name').execute()).toEqual(migrationsWhileLoading);
      expect(messages).not.toContainEqual({ started: true });

      // The restore goes on to done.
      let status = null;
      for (let i = 0; i < 1000; i += 1) {
        status = await ops.step(20_000);
        if (status === null || status.terminal || status.needsAttention) break;
      }
      expect(status).toMatchObject({ state: 'done' });
      for (const table of loadTables(manifest)) {
        if (table === 'notifications') continue;
        expect(await tableChecksumFromDb(h.db, h.dialect, table, { schemaVersion: manifest.schemaVersion }), table).toBe(manifest.tables[table]!.checksum);
      }
      expect(await h.db.selectFrom('roles').selectAll().orderBy('id').execute()).toEqual(archivedRoles);

      // The child leaves ops_wait by itself (requests make its fence look) and serves.
      await vi.waitFor(
        async () => {
          const reply = await httpRequest(port, '/_health');
          expect(reply.status).toBe(200);
        },
        { timeout: 30_000, interval: 250 },
      );
      expect(await h.db.selectFrom('roles').selectAll().orderBy('id').execute()).toEqual(archivedRoles);
    } finally {
      await ops?.close();
      await h.close();
    }
  }, 120_000);
});

describe.skipIf(!engine.available || engine.engine !== 'sqlite')(`SQLite: server processes during a restore’s swap [${engineLabel()}]`, () => {
  const DB: DbConfig = { dialect: 'sqlite' };
  const ownerFile = (): string => path.join(dirs.dataDir, 'tmp', 'sqlite-owner.json');
  const open = (): Promise<DbHandle> => connect(DB, { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });

  /** Runs `fn` on a handle of its own on the live file, closed afterwards (nothing of the test stays on the file). */
  async function withLive<T>(fn: (h: DbHandle) => Promise<T>): Promise<T> {
    const h = await open();
    try {
      return await fn(h);
    } finally {
      await h.close();
    }
  }

  /**
   * The installation of `config` (migrated, system roles, schedules, five staff users, a branch, `library.name`, its
   * install id), a server backup of it (`partRows` rows per part), then changed (the branch and the library renamed).
   */
  async function install(config: ReturnType<typeof sampleConfig>, partRows?: number): Promise<{ backupId: string; manifest: BackupManifest; roles: unknown[] }> {
    const dataDir = dirs.dataDir;
    await fsp.mkdir(dataDir, { recursive: true });
    await writeConfig(dataDir, config);
    return withLive(async (h) => {
      await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
      const now = Date.now();
      await withTx(h, async (trx) => {
        await ensureSystemRoles(trx, now);
        await seedSchedules(trx, now, 'Asia/Jakarta', SCHEDULES);
        await writeSettings(trx, { 'library.name': 'Perpustakaan Cadangan' }, { keyring: config.keyring, now, actorId: null });
        for (let i = 0; i < 5; i += 1) {
          await trx
            .insertInto('staff_users')
            .values({ id: newId(now), username_key: `staf_${i}`, username_display: `staf_${i}`, name: `Staf ${i}`, password_hash: 'x', status: 'active', created_at: now, updated_at: now })
            .execute();
        }
        await trx
          .insertInto('branches')
          .values({ id: newId(now), code_key: 'PUSAT', code_display: 'PUSAT', name: 'Pusat', timezone: 'Asia/Jakarta', is_default: 1, version: 1, created_at: now, updated_at: now })
          .execute();
        await trx.updateTable('schema_meta').set({ install_id: config.install.id }).where('id', '=', 1).execute();
      });
      const roles = await h.db.selectFrom('roles').selectAll().orderBy('id').execute();
      if (partRows !== undefined) vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', String(partRows));
      const backupId = newId();
      const exporter = createExporter({
        read: h.db,
        dialect: h.dialect,
        dataDir,
        backupId,
        kind: 'manual',
        includeFiles: false,
        consistency: 'frozen',
        appVersion: '0.1.0',
        schemaVersion: SCHEMA_VERSION,
        installId: config.install.id,
        sessionKey: csrfKey(config),
        kids: config.keyring.map((k) => k.kid),
        auditHead: { seq: 0, hash: '0'.repeat(64) },
        clock: () => now,
      });
      let cp: ExportCheckpoint | null = null;
      for (;;) {
        const r = await exporter.step(cp, { deadline: Date.now() + 60_000 });
        cp = r.checkpoint;
        if (r.done) break;
      }
      vi.unstubAllEnvs();
      await h.db
        .insertInto('backups')
        .values({ id: backupId, kind: 'manual', size: 1, sha256: null, schema_version: SCHEMA_VERSION, app_version: '0.1.0', dialect: h.dialect, consistency: 'frozen', status: 'ok', created_at: now })
        .execute();
      await h.db.updateTable('branches').set({ name: 'Diubah' }).execute();
      await withTx(h, (trx) => writeSettings(trx, { 'library.name': 'Perpustakaan Diubah' }, { keyring: config.keyring, now, actorId: null }));
      return { backupId, manifest: (await readManifest(dataDir, backupId))!, roles };
    });
  }

  /**
   * This process's restore machine on SQLite: the work file swap, no live handle of its own (the op's connections).
   * `closeWork()` closes the work file handles its restore kind opened, for a test that leaves the swap to another
   * machine (a work handle left open keeps that machine's swap waiting).
   */
  function restoreMachine(config: ReturnType<typeof sampleConfig>): { ops: OpsMachine; advance(ms: number): void; closeWork(): Promise<void> } {
    let offset = 0;
    const swap = createSqliteSwap({ dataDir: dirs.dataDir, log: silent });
    const works: DbHandle[] = [];
    const ops: OpsMachine = createOpsMachine({
      dataDir: dirs.dataDir,
      kinds: [
        restoreKind({
          dataDir: dirs.dataDir,
          appVersion: '0.1.0',
          migrations: PHASE1_MIGRATIONS,
          sessionKey: () => csrfKey(config),
          keyring: () => config.keyring,
          installId: config.install.id,
          requestRestart: async () => {},
          sqliteSwap: {
            ...swap,
            async openWork(opId) {
              const h = await swap.openWork(opId);
              works.push(h);
              return h;
            },
          },
          sqliteOwn: { close: () => ops.close(), reopen: async () => {} },
        }),
      ],
      db: () => undefined,
      connect: open,
      keyring: () => config.keyring,
      clock: () => Date.now() + offset,
      log: silent,
      snapshotBackupRunning: async () => false,
    });
    return {
      ops,
      advance(ms) {
        offset += ms;
      },
      async closeWork() {
        for (const h of works.splice(0)) await h.close().catch(() => {});
      },
    };
  }

  /**
   * A server process (boot-child.mjs, runner off: requests make its fence look) on the test's DATA_DIR. tsx reads the
   * server's tsconfig, whose JSX options the OPAC page needs.
   */
  async function bootChild(): Promise<{ child: ChildProcess; port: number; messages: unknown[] }> {
    const child = fork(
      path.join(import.meta.dirname, '../fixtures/boot-child.mjs'),
      [JSON.stringify({ dataDir: dirs.dataDir, appRoot: path.join(dirs.root, 'app'), runtime: 'standalone' })],
      {
        cwd: path.resolve(import.meta.dirname, '../../../..'),
        env: { ...process.env, ALTIS_RUNNER: 'off', TSX_TSCONFIG_PATH: path.resolve(import.meta.dirname, '../../tsconfig.json') },
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    );
    children.push(child);
    const messages: unknown[] = [];
    child.on('message', (m) => messages.push(m));
    const port = await new Promise<number>((resolve, reject) => {
      child.once('message', (m) => resolve((m as { port: number }).port));
      child.once('exit', (c, s) => reject(new Error(`boot child exited (${String(c ?? s)})`)));
    });
    return { child, port, messages };
  }

  const stateOf = async (): Promise<{ state: string; params: Record<string, unknown> }> => {
    const op = await readOpFile(dirs.dataDir);
    if (op === null || op === 'corrupt') throw new Error('no op.json');
    return op;
  };

  async function stepToEnd(ops: OpsMachine): Promise<unknown> {
    let status = null;
    for (let i = 0; i < 1000; i += 1) {
      status = await ops.step(20_000);
      if (status === null || status.terminal || status.needsAttention) break;
    }
    return status;
  }

  /** Requests to the child every 200 ms while `fn` runs: they make its ops fence look (runner off). */
  async function whilePolling<T>(port: number, fn: () => Promise<T>): Promise<T> {
    let polling = true;
    const poller = (async () => {
      while (polling) {
        await httpRequest(port, '/_health').catch(() => null);
        await sleep(200);
      }
    })();
    try {
      return await fn();
    } finally {
      polling = false;
      await poller;
    }
  }

  async function expectArchived(manifest: BackupManifest, roles: unknown[]): Promise<void> {
    await withLive(async (h) => {
      for (const table of loadTables(manifest)) {
        if (table === 'notifications') continue;
        expect(await tableChecksumFromDb(h.db, h.dialect, table, { schemaVersion: manifest.schemaVersion }), table).toBe(manifest.tables[table]!.checksum);
      }
      expect(await h.db.selectFrom('roles').selectAll().orderBy('id').execute()).toEqual(roles);
    });
  }

  it('B4: a process booting during loading waits in ops_wait without opening altis.sqlite; it boots on the backup’s roles once done', async () => {
    const config = sampleConfig({ db: DB });
    const { backupId, manifest, roles } = await install(config, 1);
    const m = restoreMachine(config);
    try {
      vi.stubEnv('ALTIS_TEST_RESTORE_TX_ROWS', '1');
      await m.ops.begin('restore', { type: 'system', id: null }, { backupId, source: 'server', withoutFiles: false, confirmed: false, targetSchema: 'latest' });
      m.advance(4000);
      const staffIndex = loadTables(manifest).indexOf('staff_users');
      for (let i = 0; i < 2000; i += 1) {
        await m.ops.step(1);
        const { state, params } = await stateOf();
        const load = params['load'] as { table: number; part: number } | undefined;
        if (state === 'loading' && load !== undefined && load.table === staffIndex && load.part >= 2) break;
      }
      expect(await stateOf()).toMatchObject({ state: 'loading', params: { load: { table: staffIndex } } });
      const rolesWhileLoading = await withLive((h) => h.db.selectFrom('roles').selectAll().orderBy('id').execute());

      // A server process boots now: ops_wait, its fence driven by these requests.
      const { child, port, messages } = await bootChild();
      await vi.waitFor(
        async () => {
          const reply = await httpRequest(port, '/_health');
          expect({ status: reply.status, body: JSON.parse(reply.body) as unknown }).toMatchObject({ status: 503, body: { status: 'maintenance' } });
        },
        { timeout: 15_000, interval: 100 },
      );
      await sleep(2500); // past a fence interval: the child had every chance to connect, migrate or seed
      await expect(fsp.stat(ownerFile())).rejects.toMatchObject({ code: 'ENOENT' }); // it never opened the file
      expect(await withLive((h) => h.db.selectFrom('roles').selectAll().orderBy('id').execute())).toEqual(rolesWhileLoading);
      expect(messages).not.toContainEqual({ started: true });

      // The restore goes on to done while the child's fence keeps looking (it sees the swap's flag too).
      expect(await whilePolling(port, () => stepToEnd(m.ops))).toMatchObject({ state: 'done' });
      await expectArchived(manifest, roles);

      // The child leaves ops_wait by itself and boots on the restored file.
      await vi.waitFor(
        async () => {
          const reply = await httpRequest(port, '/_health');
          expect(reply.status).toBe(200);
        },
        { timeout: 30_000, interval: 250 },
      );
      expect(JSON.parse(await fsp.readFile(ownerFile(), 'utf8'))).toMatchObject({ pid: child.pid });
      expect(await withLive((h) => h.db.selectFrom('roles').selectAll().orderBy('id').execute())).toEqual(roles);
    } finally {
      await m.ops.close();
    }
  }, 120_000);

  it('a process whose restore kind has no SQLite swap (a command made with the default kinds) leaves a SQLite restore alone', async () => {
    const config = sampleConfig({ db: DB });
    const { backupId } = await install(config);
    const m = restoreMachine(config);
    const cli = await open();
    try {
      await m.ops.begin('restore', { type: 'system', id: null }, { backupId, source: 'server', withoutFiles: false, confirmed: false, targetSchema: 'latest' });
      m.advance(4000);
      for (let i = 0; i < 2000 && (await stateOf()).state !== 'loading'; i += 1) await m.ops.step(1);
      await m.ops.step(1); // the load's first sub-step: the work file exists
      const before = (await readOpFile(dirs.dataDir)) as { opId: string; state: string };
      expect(before.state).toBe('loading');

      // A command's machine: createAppOps with the default kinds, its own CLI handle as the live one.
      const state: AppState = { phase: 'ready', db: cli, config };
      const command = createAppOps(state, { dataDir: dirs.dataDir, version: '0.1.0', log: recordingLogger(), clock: () => Date.now() + 4000 });
      expect(await command.step(20_000)).toMatchObject({ state: 'loading', terminal: false });
      await command.close();
      expect({ ...(await stateOf()), heartbeatAt: 0 }).toEqual({ ...before, heartbeatAt: 0 });
      // Nothing was loaded into the live file: its branch is still the renamed one (the work file has the load).
      expect(await withLive((h) => h.db.selectFrom('branches').select('name').execute())).toEqual([{ name: 'Diubah' }]);
      await expect(fsp.stat(path.join(dirs.dataDir, 'db', before.opId, 'restore.sqlite'))).resolves.toBeTruthy();
    } finally {
      await cli.close();
      await m.ops.close();
    }
  }, 120_000);

  it('a serving process lets go of its file when its fence sees sqliteRelease, reopens after the epoch moved, restarts and serves the restored data', async () => {
    const config = sampleConfig({ db: DB });
    const { backupId, manifest, roles } = await install(config);
    const epoch = await readDataEpoch(dirs.dataDir);

    // A server process, ready on the live file before the restore begins.
    const { child, port, messages } = await bootChild();
    await vi.waitFor(() => expect(messages).toContainEqual({ started: true }), { timeout: 30_000, interval: 100 });
    expect((await httpRequest(port, '/_health')).status).toBe(200);
    expect(JSON.parse(await fsp.readFile(ownerFile(), 'utf8'))).toMatchObject({ pid: child.pid });
    const home = await httpRequest(port, '/', 'GET', { accept: 'text/html' });
    expect({ status: home.status, headers: home.headers }).toMatchObject({ status: 200 });
    expect(home.body).toContain('Perpustakaan Diubah');

    const m = restoreMachine(config);
    try {
      await m.ops.begin('restore', { type: 'system', id: null }, { backupId, source: 'server', withoutFiles: false, confirmed: false, targetSchema: 'latest' });
      m.advance(4000);
      for (let i = 0; i < 5000; i += 1) {
        await m.ops.step(1);
        const { params } = await stateOf();
        if ((params['final'] as { step?: string } | undefined)?.step === 'swap') break;
      }
      expect(JSON.parse(await fsp.readFile(ownerFile(), 'utf8'))).toMatchObject({ pid: child.pid });

      // The swap step waits for the child, whose fence the requests make look; its record goes with its handle.
      const ownedAfterSwap = await whilePolling(port, async () => {
        // One handler step at a time (R1c-11: each waits for the owner no longer than its own deadline).
        for (let i = 0; i < 5000; i += 1) {
          if (((await stateOf()).params['final'] as { step?: string } | undefined)?.step !== 'swap') break;
          await m.ops.step(1);
        }
        expect((await stateOf()).params['final']).toMatchObject({ step: 'volatile' });
        return fsp.stat(ownerFile()).then(
          () => true,
          () => false,
        );
      });
      expect(ownedAfterSwap).toBe(false);
      expect(await whilePolling(port, () => stepToEnd(m.ops))).toMatchObject({ state: 'done' });
      expect(await readMaintenance(dirs.dataDir)).toBeNull();
      expect(await readDataEpoch(dirs.dataDir)).toBe(epoch + 1);
      await expectArchived(manifest, roles);

      // Requests make the child look again: it reopens on the restored file, asks for its restart and serves it.
      await vi.waitFor(
        async () => {
          const reply = await httpRequest(port, '/', 'GET', { accept: 'text/html' });
          expect(reply.status).toBe(200);
          expect(reply.body).toContain('Perpustakaan Cadangan');
        },
        { timeout: 30_000, interval: 250 },
      );
      expect(messages).toContainEqual({ restart: 'data-epoch' });
      expect(JSON.parse(await fsp.readFile(ownerFile(), 'utf8'))).toMatchObject({ pid: child.pid });
      expect((await httpRequest(port, '/_health')).status).toBe(200);
    } finally {
      await m.ops.close();
    }
  }, 120_000);

  it('a serving process that steps the swap itself: a failure after it let go of its file and before the renames reopens it, and it keeps serving (R1c-11)', async () => {
    const config = sampleConfig({ db: DB });
    const { backupId } = await install(config);
    vi.stubEnv('ALTIS_RUNNER', 'off'); // after install(), which unstubs: only POST /_cron steps the op here, no worker loop

    // This process serves the live file (real start(), the stand-in of app.js's server).
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    const { port } = await ctx.served();
    await vi.waitFor(async () => expect(await serverLog(dirs.dataDir)).toContainEqual(expect.objectContaining({ msg: 'job runtime started', mode: 'external' })), {
      timeout: 5000,
      interval: 50,
    });
    expect((await httpRequest(port, '/', 'GET', { accept: 'text/html' })).body).toContain('Perpustakaan Diubah');
    expect(JSON.parse(await fsp.readFile(ownerFile(), 'utf8'))).toMatchObject({ pid: process.pid });

    // The restore is loaded on its work file up to the swap; the server's own ops machine steps the swap.
    const m = restoreMachine(config);
    let opId: string;
    try {
      ({ opId } = await m.ops.begin('restore', { type: 'system', id: null }, { backupId, source: 'server', withoutFiles: false, confirmed: false, targetSchema: 'latest' }));
      m.advance(4000);
      for (let i = 0; i < 5000; i += 1) {
        await m.ops.step(1);
        const { params } = await stateOf();
        if ((params['final'] as { step?: string } | undefined)?.step === 'swap') break;
      }
      expect((await stateOf()).params['final']).toMatchObject({ step: 'swap' });
    } finally {
      await m.closeWork();
      await m.ops.close();
    }

    // The swap's history copy fails once, after this process closed its handle and before any rename.
    historyFault.armed = true;
    const cron = await httpRequest(port, '/_cron', 'POST', { authorization: `Bearer ${config.secrets.cronToken}` });
    expect(cron.status).toBe(200);
    expect(historyFault.armed).toBe(false);
    expect(await stateOf()).toMatchObject({ state: 'failed', pointOfNoReturn: true });
    expect(await readMaintenance(dirs.dataDir)).toBeNull();
    await expect(fsp.stat(path.join(dirs.dataDir, 'db', opId, 'restore.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Its own handle is open again (its owner record is back) and it keeps serving the data it had.
    expect(JSON.parse(await fsp.readFile(ownerFile(), 'utf8'))).toMatchObject({ pid: process.pid });
    await vi.waitFor(
      async () => {
        const home = await httpRequest(port, '/', 'GET', { accept: 'text/html' });
        expect(home.status).toBe(200);
        expect(home.body).toContain('Perpustakaan Diubah');
      },
      { timeout: 10_000, interval: 250 },
    );
    expect((await httpRequest(port, '/_health')).status).toBe(200);

    await closeTestServers(); // retires the handler, which closes the handle (and so removes the owner record)
    await vi.waitFor(() => expect(fsp.stat(ownerFile())).rejects.toMatchObject({ code: 'ENOENT' }), { timeout: 10_000, interval: 50 });
  }, 120_000);
});
