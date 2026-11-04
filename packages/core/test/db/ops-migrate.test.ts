import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, connect, countRows, type AltisMigration, type DbHandle } from '@altis/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyDatabase, engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import { installMigrateKind } from '../../src/ops/kinds/install-migrate.js';
import { migrateKind } from '../../src/ops/kinds/migrate.js';
import { resetKind } from '../../src/ops/kinds/reset.js';
import { readMaintenance, readOpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpsMachine, type OpsMachineOptions } from '../../src/ops/machine.js';

// The `migrate` and `install-migrate` op kinds (S21, P9, M6): each handler step applies exactly one migration with
// migrateUpOne, so `step(1)` moves the database one migration on and the last one ends the op `done`. On the engine
// picked by ALTIS_TEST_DB, from an empty database. The number of migrations comes from the registry.

const ctx = testDbContext();
const NAMES = Object.keys(PHASE1_MIGRATIONS).sort();
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const deps = { appVersion: '0.1.0', migrations: PHASE1_MIGRATIONS };

describe.skipIf(!ctx.available)(`migrate op kinds [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let machines: OpsMachine[];

  beforeAll(async () => {
    h = await testDb();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await emptyDatabase(h);
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-ops-migrate-'));
    machines = [];
  });

  afterEach(async () => {
    for (const m of machines) await m.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  function machine(over: Partial<OpsMachineOptions> = {}): OpsMachine {
    const m = createOpsMachine({
      dataDir,
      kinds: [migrateKind(deps), installMigrateKind(deps), resetKind()],
      db: () => h,
      connect: () => Promise.reject(new Error('the live handle is used here')),
      keyring: () => [],
      clock: () => Date.now(),
      log: silent,
      snapshotBackupRunning: async () => false,
      appVersion: '0.1.0',
      ...over,
    });
    machines.push(m);
    return m;
  }

  async function applied(): Promise<number> {
    const tables = await h.db.introspection.getTables();
    if (!tables.some((t) => t.name === 'schema_migrations')) return 0;
    return countRows(h.db.selectFrom('schema_migrations'));
  }

  it('migrate: each step(1) applies exactly one migration, the last one ends the op done', async () => {
    const m = machine();
    const handle = await m.begin('migrate', { type: 'cli', id: null }, {});
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'migrate', opId: handle.opId });
    expect(await applied()).toBe(0);
    for (let i = 1; i <= NAMES.length; i += 1) {
      const status = await m.step(1);
      expect(await applied()).toBe(i);
      expect(status).toMatchObject({ opId: handle.opId, message: NAMES[i - 1] });
      if (i < NAMES.length) {
        expect(status).toMatchObject({ state: 'running', terminal: false });
        expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);
      } else {
        expect(status).toMatchObject({ state: 'done', terminal: true, progress: 100 });
      }
    }
    const op = await readOpFile(dataDir);
    expect(op).toMatchObject({ state: 'done', params: { applied: NAMES } });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await m.step(1)).toMatchObject({ state: 'done' });
    expect(await applied()).toBe(NAMES.length);
  });

  it('install-migrate: the same one-migration step under the install maintenance reason', async () => {
    const m = machine();
    const handle = await m.begin('install-migrate', { type: 'install', id: null }, {});
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'install', opId: handle.opId });
    expect(await m.step(1)).toMatchObject({ state: 'running', message: NAMES[0] });
    expect(await applied()).toBe(1);
    expect(await m.step(20_000)).toMatchObject({ state: 'done' });
    expect(await applied()).toBe(NAMES.length);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('without a live handle (a process waiting for the op, B4) the step uses the op connection, closed at the end', async () => {
    const opened: DbHandle[] = [];
    let closed = 0;
    const m = machine({
      db: () => undefined,
      connect: async (purpose) => {
        const c = await connect(h.config, { runtime: 'standalone', purpose, dataDir: h.dataDir });
        opened.push(c);
        return {
          ...c,
          close: async () => {
            closed += 1;
            await c.close();
          },
        };
      },
    });
    await m.begin('migrate', { type: 'cli', id: null }, {});
    await m.step(1);
    expect(await applied()).toBe(1);
    expect(opened).toHaveLength(1);
    expect(closed).toBe(0);
    expect(await m.step(20_000)).toMatchObject({ state: 'done' });
    expect(opened).toHaveLength(1);
    expect(closed).toBe(1);
  });

  it('a failing migration ends the op failed, naming the migration, and lowers maintenance', async () => {
    const broken: Record<string, AltisMigration> = {
      [NAMES[0]!]: PHASE1_MIGRATIONS[NAMES[0]!]!,
      '0002_broken': {
        up: async () => {
          throw new Error('boom');
        },
      },
    };
    const m = machine({ kinds: [migrateKind({ appVersion: '0.1.0', migrations: broken })] });
    await m.begin('migrate', { type: 'cli', id: null }, {});
    const status = await m.step(20_000);
    expect(status).toMatchObject({
      state: 'failed',
      terminal: true,
      error: { code: 'INTERNAL', detail: 'Migrasi 0002_broken gagal / Migration 0002_broken failed' },
    });
    expect(await applied()).toBe(1);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('reset: raises the reset maintenance reason and ends done', async () => {
    const m = machine();
    const handle = await m.begin('reset', { type: 'cli', id: null }, {});
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'reset', opId: handle.opId });
    expect(await m.step(20_000)).toMatchObject({ state: 'done' });
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('reset --wipe-db passes its point of no return before the wipe: a cancel is refused and maintenance stays (ops minor)', async () => {
    const m = machine();
    const kept = await m.begin('reset', { type: 'cli', id: null }, { wipeDb: false });
    expect(await m.step(1)).toMatchObject({ pointOfNoReturn: false }); // nothing is dropped: still cancellable
    expect(await m.cancel({ type: 'cli', id: null })).toMatchObject({ opId: kept.opId, state: 'failed' });

    const handle = await m.begin('reset', { type: 'cli', id: null }, { wipeDb: true });
    expect(await m.step(1)).toMatchObject({ state: 'running', pointOfNoReturn: true });
    expect(await readOpFile(dataDir)).toMatchObject({ params: { stage: 'wipe' } });
    await expect(m.cancel({ type: 'cli', id: null })).rejects.toMatchObject({ code: 'OPS_POINT_OF_NO_RETURN' });
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);
  });
});
