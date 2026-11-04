import { fork, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dataPath, ensureDir, withFileLock } from '@altis/platform';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyDatabase, engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { resetDdlFaults } from '../src/ddl.js';
import { PHASE1_MIGRATIONS, releaseMigrations } from '../src/migrations/index.js';
import { migrateUpOne, runMigrations, type AltisMigration, type MigrationOptions, type MigrationProgress } from '../src/migrator.js';
import { listCatalogTables } from '../src/server-check.js';

// Task 9 (spec §12.5, decisions D1d-25, D1d-42; preflight 1D-03, S22): the migrator's progress callback and the
// update faults it serves (`migrate:<name>`, `migrate-slow:<seconds>`, `migrate-ddl:<k>`). A long wait for the
// migration lock and a long statement both count as progress, so only a hung process stalls the pending boot.

type ProgressEvent = { migration: string | null; waiting: boolean; at: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`migration progress and update faults [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  const savedFault = process.env['ALTIS_TEST_FAULT'];

  beforeAll(async () => {
    h = await testDb();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await emptyDatabase(h);
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-mig-hooks-'));
    delete process.env['ALTIS_TEST_FAULT'];
    resetDdlFaults();
  });

  afterEach(async () => {
    if (savedFault === undefined) delete process.env['ALTIS_TEST_FAULT'];
    else process.env['ALTIS_TEST_FAULT'] = savedFault;
    resetDdlFaults();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** Runs `migrations` with an onProgress that records every call and when it came. */
  async function run(o: { appVersion: string; migrations: Record<string, AltisMigration> } & Partial<MigrationOptions>) {
    const events: ProgressEvent[] = [];
    const startedAt = Date.now();
    const outcome = await runMigrations(h, {
      dataDir,
      ...o,
      onProgress: (e) => void events.push({ ...e, at: Date.now() - startedAt }),
    });
    return { outcome, events, ms: Date.now() - startedAt };
  }

  const levelOne = () => runMigrations(h, { appVersion: '0.1.0-test', dataDir, migrations: releaseMigrations(1) });

  it('reports before and after each migration, with its name and waiting false', async () => {
    const { outcome, events } = await run({ appVersion: '0.2.0-test', migrations: releaseMigrations(2) });
    expect(outcome.mode).toBe('migrated');
    const names = Object.keys(releaseMigrations(2)).sort();
    for (const name of names) {
      expect(events.filter((e) => e.migration === name && !e.waiting).length, name).toBeGreaterThanOrEqual(2);
    }
    // In migration order.
    const order = events.filter((e) => e.migration !== null).map((e) => e.migration);
    expect([...new Set(order)]).toEqual(names);
  });

  it('migrateUpOne reports before and after the one migration it applies; a throwing or rejecting callback changes nothing', async () => {
    await levelOne();
    const seen: MigrationProgress[] = [];
    const step = await migrateUpOne(h, {
      appVersion: '0.3.0-test',
      dataDir,
      migrations: releaseMigrations(3),
      onProgress: (e) => void seen.push(e),
    });
    expect(step).toEqual({ done: false, applied: '9001_test_expand' });
    expect(seen.filter((e) => e.migration === '9001_test_expand')).toEqual([
      { migration: '9001_test_expand', waiting: false },
      { migration: '9001_test_expand', waiting: false },
    ]);
    const throwing = await migrateUpOne(h, {
      appVersion: '0.3.0-test',
      dataDir,
      migrations: releaseMigrations(3),
      onProgress: () => {
        throw new Error('a broken progress callback');
      },
    });
    expect(throwing).toEqual({ done: true, applied: '9002_test_contract' });
    await emptyDatabase(h);
    const rejecting = await runMigrations(h, {
      appVersion: '0.1.0-test',
      dataDir,
      migrations: releaseMigrations(1),
      onProgress: () => Promise.reject(new Error('a rejecting progress callback')) as unknown as void,
    });
    expect(rejecting.mode).toBe('migrated');
  });

  it('reports waiting: true at least twice while another holder keeps the migration lock for 12 s', async () => {
    await ensureDir(dataPath(dataDir, 'tmp'));
    let held = false;
    const holder = withFileLock(dataPath(dataDir, 'tmp', 'migrate.lock'), async () => {
      held = true;
      await sleep(12_000);
    });
    while (!held) await sleep(10);
    const { outcome, events, ms } = await run({ appVersion: '0.1.0-test', migrations: releaseMigrations(1), lockWaitMs: 30_000 });
    await holder;
    expect(outcome.mode).toBe('migrated');
    expect(ms).toBeGreaterThanOrEqual(11_000);
    const waiting = events.filter((e) => e.waiting);
    expect(waiting.length).toBeGreaterThanOrEqual(2);
    for (const e of waiting) expect(e.migration).toBeNull();
    // Once the lock is taken, nothing more is reported as waiting.
    const firstMigration = events.findIndex((e) => e.migration !== null);
    expect(events.slice(firstMigration).every((e) => !e.waiting)).toBe(true);
  }, 60_000);

  it('a statement held for 12 s inside a migration is reported at least twice while it runs', async () => {
    await levelOne();
    const slow: AltisMigration = {
      async up(db, dialect) {
        if (dialect === 'mysql' || dialect === 'mariadb') await sql`select sleep(12) as slept`.execute(db);
        else if (dialect === 'postgres') await sql`select pg_sleep(12)`.execute(db);
        else await sleep(12_000); // node:sqlite has no sleep: the statement's wait as the event loop sees it
      },
    };
    const { outcome, events } = await run({ appVersion: '0.2.0-test', migrations: { ...PHASE1_MIGRATIONS, '9100_slow_statement': slow } });
    expect(outcome.applied).toEqual(['9100_slow_statement']);
    const mine = events.filter((e) => e.migration === '9100_slow_statement');
    // before, at least two beats during the statement, after.
    expect(mine.length).toBeGreaterThanOrEqual(4);
    const during = mine.slice(1, -1);
    expect(during.length).toBeGreaterThanOrEqual(2);
    expect(mine.at(-1)!.at - mine[0]!.at).toBeGreaterThanOrEqual(11_000);
  }, 60_000);

  it('ALTIS_TEST_FAULT=migrate:9001_test_expand: the run rejects naming the migration, test_fixture is absent', async () => {
    await levelOne();
    process.env['ALTIS_TEST_FAULT'] = 'migrate:9001_test_expand';
    await expect(runMigrations(h, { appVersion: '0.2.0-test', dataDir, migrations: releaseMigrations(2) })).rejects.toMatchObject({
      meta: { migration: '9001_test_expand' },
    });
    expect(await listCatalogTables(h)).not.toContain('test_fixture');
    delete process.env['ALTIS_TEST_FAULT'];
    expect((await runMigrations(h, { appVersion: '0.2.0-test', dataDir, migrations: releaseMigrations(2) })).applied).toEqual(['9001_test_expand']);
  });

  it('migrate:<another name> leaves the run alone', async () => {
    process.env['ALTIS_TEST_FAULT'] = 'migrate:9002_test_contract';
    expect((await runMigrations(h, { appVersion: '0.2.0-test', dataDir, migrations: releaseMigrations(2) })).mode).toBe('migrated');
  });

  it('ALTIS_TEST_FAULT=migrate-ddl:1: the first DDL statement takes effect, then the run rejects; a run without the fault completes', async () => {
    await levelOne();
    process.env['ALTIS_TEST_FAULT'] = 'migrate-ddl:1';
    await expect(runMigrations(h, { appVersion: '0.2.0-test', dataDir, migrations: releaseMigrations(2) })).rejects.toMatchObject({
      meta: { migration: '9001_test_expand' },
    });
    // The CREATE TABLE ran. PostgreSQL rolls the batch back (transactional DDL); the others keep the statement.
    expect((await listCatalogTables(h)).includes('test_fixture')).toBe(h.dialect !== 'postgres');
    delete process.env['ALTIS_TEST_FAULT'];
    const again = await runMigrations(h, { appVersion: '0.2.0-test', dataDir, migrations: releaseMigrations(2) });
    expect(again).toMatchObject({ mode: 'migrated', applied: ['9001_test_expand'], schemaVersion: '9001' });
    expect(await listCatalogTables(h)).toContain('test_fixture');
  });

  it('migrate-ddl counts the DDL statements of this process from the moment it is armed', async () => {
    await levelOne();
    process.env['ALTIS_TEST_FAULT'] = 'migrate-ddl:2';
    // 9001 is one CREATE TABLE, 9002 one ALTER TABLE: the second statement is 9002's.
    await expect(runMigrations(h, { appVersion: '0.3.0-test', dataDir, migrations: releaseMigrations(3) })).rejects.toMatchObject({
      meta: { migration: '9002_test_contract' },
    });
    delete process.env['ALTIS_TEST_FAULT'];
    const again = await runMigrations(h, { appVersion: '0.3.0-test', dataDir, migrations: releaseMigrations(3) });
    expect(again).toMatchObject({ mode: 'migrated', schemaVersion: '9002', minCodeVersion: '0.3.0-test' });
  });

  it('ALTIS_TEST_FAULT=migrate-slow:12: about 12 s before 9001 is applied, progress at least every 5 s meanwhile', async () => {
    await levelOne();
    process.env['ALTIS_TEST_FAULT'] = 'migrate-slow:12';
    const { outcome, events, ms } = await run({ appVersion: '0.2.0-test', migrations: releaseMigrations(2) });
    expect(outcome.applied).toEqual(['9001_test_expand']);
    expect(ms).toBeGreaterThanOrEqual(11_500);
    expect(ms).toBeLessThan(20_000);
    // At least two beats before 9001 starts (at 5 s and 10 s), none of them waiting.
    expect(events.filter((e) => e.at < 11_000 && !e.waiting).length).toBeGreaterThanOrEqual(2);
    const armed = JSON.parse(await fsp.readFile(dataPath(dataDir, 'tmp', 'fault-migrate-slow.json'), 'utf8')) as { fault: string; armedAt: number };
    expect(armed.fault).toBe('12');
    // The wait is over for good in this DATA_DIR: a later run with the same fault and something to apply does not wait.
    const late = await run({ appVersion: '0.3.0-test', migrations: releaseMigrations(3) });
    expect(late.outcome.applied).toEqual(['9002_test_contract']);
    expect(late.ms).toBeLessThan(5_000);
  }, 60_000);

  it('migrate-slow with nothing to apply does not wait', async () => {
    await levelOne();
    process.env['ALTIS_TEST_FAULT'] = 'migrate-slow:12';
    const { outcome, ms } = await run({ appVersion: '0.1.0-test', migrations: releaseMigrations(1) });
    expect(outcome.mode).toBe('up-to-date');
    expect(ms).toBeLessThan(5_000);
  });

  describe('migrate-slow across processes (preflight S22)', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const fixture = path.join(import.meta.dirname, 'fixtures', 'fixture-level-child.mjs');
    const children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });

    type Report = { outcome: { mode: string; applied: string[] }; startedAt: number; endedAt: number; progress: number };

    function startChild(env: Record<string, string>) {
      const options = { config: h.config, connectDataDir: h.dataDir, migrateDataDir: dataDir, appVersion: '0.2.0-test', level: 2 };
      const child = fork(fixture, [JSON.stringify(options)], {
        cwd: root,
        env: { ...process.env, ...env },
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let report: Report | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else report = message as Report;
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; report: Report | undefined }>((resolve) =>
        child.once('close', (code, signal) => resolve({ code, signal, report })),
      );
      return { child, ready, exited };
    }

    it('a holder killed 8 s into migrate-slow:12 is replaced by one that waits only the remaining ~4 s', async () => {
      await levelOne();
      const env = { ALTIS_TEST_FAULT: 'migrate-slow:12' };
      const first = startChild(env);
      await first.ready;
      first.child.send('go');
      const armedFile = dataPath(dataDir, 'tmp', 'fault-migrate-slow.json');
      let armedAt: number | undefined;
      while (armedAt === undefined) {
        armedAt = await fsp
          .readFile(armedFile, 'utf8')
          .then((text) => (JSON.parse(text) as { armedAt: number }).armedAt)
          .catch(() => undefined);
        if (armedAt === undefined) await sleep(50);
      }
      await sleep(Math.max(0, armedAt + 8_000 - Date.now()));
      first.child.kill('SIGKILL'); // a power cut, or Passenger replacing the worker
      expect((await first.exited).signal).toBe('SIGKILL');
      expect(await listCatalogTables(h)).not.toContain('test_fixture');

      const second = startChild(env);
      await second.ready;
      second.child.send('go');
      const done = await second.exited;
      expect(done.code).toBe(0);
      const report = done.report!;
      expect(report.outcome.applied).toEqual(['9001_test_expand']);
      const waited = report.endedAt - report.startedAt;
      expect(waited).toBeGreaterThanOrEqual(2_000);
      expect(waited).toBeLessThan(8_000);
      expect(report.endedAt - armedAt).toBeGreaterThanOrEqual(11_500);
      expect(await listCatalogTables(h)).toContain('test_fixture');
    }, 60_000);
  });
});
