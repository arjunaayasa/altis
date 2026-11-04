import fsp from 'node:fs/promises';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, type DbHandle } from '@altis/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { writeConfig } from '../../src/config.js';
import { start } from '../../src/index.js';
import { flagOf, writeFlag, writeOp } from '../ops-support.js';
import { bootContext, closeTestServers, httpRequest, sampleConfig, useDataDir, type ServedServer } from '../support.js';

// A process that boots while an exclusive op holds the ops lock (preflight B4, decision C40; plan Task 15) on the engine
// picked by ALTIS_TEST_DB: start() asks for the op before it connects, and while the op runs it serves `ops_wait`
// without a single statement on the database (no migration, no system roles, no health check, no markHealthy); once
// the op file is terminal and the fence sees it, the normal boot runs (migrations, roles, ready, markHealthy once),
// without a restart. And §9.4 "atau boot": an op active once the app is ready gets exactly one step from the boot.

// Every connection start() opens (the real connect underneath), and every step of the app's ops machine.
const seen = vi.hoisted(() => ({ connects: 0, handles: [] as unknown[], steps: [] as string[] }));
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  return {
    ...actual,
    connect: vi.fn(async (...args: Parameters<typeof actual.connect>) => {
      seen.connects += 1;
      const handle = await actual.connect(...args);
      seen.handles.push(handle);
      return handle;
    }),
  };
});
vi.mock('@altis/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/core')>();
  return {
    ...actual,
    createOpsMachine: (o: Parameters<typeof actual.createOpsMachine>[0]) => {
      const machine = actual.createOpsMachine(o);
      return {
        ...machine,
        step: (budgetMs: number) => {
          seen.steps.push('step');
          return machine.step(budgetMs);
        },
      };
    },
  };
});
const { connect } = await import('@altis/db');
const actualDb = await vi.importActual<typeof import('@altis/db')>('@altis/db');

const engine = testDbContext();
const dirs = useDataDir();
const LAST_MIGRATION = Object.keys(PHASE1_MIGRATIONS).at(-1)!;

beforeEach(async () => {
  if (engine.available) await (await testDb()).close(); // start every test from an empty database
  seen.connects = 0; // testDb() connects through the spy too
  seen.handles.length = 0;
  seen.steps.length = 0;
});

afterEach(async () => {
  await closeTestServers();
  await Promise.all(seen.handles.map((h) => (h as DbHandle).close()));
  vi.unstubAllEnvs();
  vi.mocked(connect).mockClear();
});

/** A handle of the test's own on the database the server will open (outside the connect spy). */
function ownHandle(): Promise<DbHandle> {
  return actualDb.connect(testDbConfig(engine), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
}

/** The database of config.json migrated up to all but the last migration, as an older release left it. */
async function databaseLackingLastMigration(): Promise<void> {
  const h = await ownHandle();
  try {
    const older = Object.fromEntries(Object.entries(PHASE1_MIGRATIONS).slice(0, -1));
    await runMigrations(h, { appVersion: '0.0.9', dataDir: dirs.dataDir, migrations: older });
  } finally {
    await h.close();
  }
}

async function migrationNames(): Promise<string[]> {
  const h = await ownHandle();
  try {
    return (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name);
  } finally {
    await h.close();
  }
}

async function roleCount(): Promise<number> {
  const h = await ownHandle();
  try {
    return (await h.db.selectFrom('roles').select('id').execute()).length;
  } finally {
    await h.close();
  }
}

async function health(served: ServedServer): Promise<{ status: number; body: unknown }> {
  const reply = await httpRequest(served.port, '/_health');
  return { status: reply.status, body: JSON.parse(reply.body) as unknown };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!engine.available)(`start(ctx) while an exclusive op runs [${engineLabel()}]`, () => {
  it(
    'waits in ops_wait without touching the database; boots normally (no restart) once the op file is terminal',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off'); // external mode: only requests look at the ops files
      await databaseLackingLastMigration();
      const rolesBefore = await roleCount();
      await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
      const { op, token } = await writeOp(dirs.dataDir, { kind: 'backup', state: 'exporting' });
      await writeFlag(dirs.dataDir, flagOf('backup', op.opId));

      const ctx = bootContext(dirs.dataDir);
      let settled = false;
      const started = start(ctx).finally(() => {
        settled = true;
      });
      const served = await ctx.served();
      await vi.waitFor(async () => expect(await health(served)).toEqual({ status: 503, body: { status: 'maintenance', version: '0.1.0' } }), {
        timeout: 10_000,
        interval: 50,
      });

      // ops_wait: no statement at all on the database, no markHealthy, start() still pending.
      expect(seen.connects).toBe(0);
      expect(ctx.markHealthy).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      const deny = await httpRequest(served.port, '/api/v1/auth/sessions');
      expect(deny.status).toBe(503);
      expect(JSON.parse(deny.body)).toMatchObject({ code: 'MAINTENANCE', reason: 'backup' });
      expect(deny.headers['retry-after']).toBe('30');
      const page = await httpRequest(served.port, '/', 'GET', { accept: 'text/html' });
      expect(page.status).toBe(503);
      expect(page.headers['content-type']).toMatch(/^text\/html/);
      expect(page.headers['retry-after']).toBe('30');
      const current = await httpRequest(served.port, '/api/v1/ops/current', 'GET', { cookie: `__Host-altis_ops=${token}` });
      expect(current.status, current.body).toBe(200);
      expect(JSON.parse(current.body)).toMatchObject({ opId: op.opId, kind: 'backup', state: 'exporting', mode: 'external' });
      expect((await httpRequest(served.port, '/api/v1/ops/current')).status).toBe(401); // no cookie: no session either
      expect(seen.connects).toBe(0);
      expect(await migrationNames()).not.toContain(LAST_MIGRATION);
      expect(await roleCount()).toBe(rolesBefore);

      // The op ends (another process stepped it to done and lowered its flag); a request ≥ 2 s later sees it.
      await writeOp(dirs.dataDir, { ...op, state: 'done' });
      await writeFlag(dirs.dataDir, null);
      await sleep(2100);
      await httpRequest(served.port, '/_health');
      await vi.waitFor(async () => expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: '0.1.0' } }), {
        timeout: 15_000,
        interval: 100,
      });
      await started;
      expect(seen.connects).toBeGreaterThanOrEqual(1);
      expect(await migrationNames()).toContain(LAST_MIGRATION);
      expect(await roleCount()).toBeGreaterThan(rolesBefore); // ensureSystemRoles ran
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
      expect(ctx.requestRestart).not.toHaveBeenCalled();
      expect((await httpRequest(served.port, '/api/v1/auth/sessions')).status).toBe(401); // served again: no session
    },
    40_000,
  );

  it(
    'an unreadable op.json and .bak count as an op holding the lock (fail closed)',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
      await writeOp(dirs.dataDir, { kind: 'backup', state: 'exporting' });
      await fsp.writeFile(path.join(dirs.dataDir, 'ops', 'op.json'), '{broken');
      const ctx = bootContext(dirs.dataDir);
      void start(ctx);
      const served = await ctx.served();
      await vi.waitFor(async () => expect((await health(served)).body).toEqual({ status: 'maintenance', version: '0.1.0' }), {
        timeout: 10_000,
        interval: 50,
      });
      expect(seen.connects).toBe(0);
      expect(ctx.markHealthy).not.toHaveBeenCalled();
    },
    20_000,
  );

  it(
    'worker mode: the wait loop sees the op end by itself, without any request, and the boot runs',
    async () => {
      // runtime standalone, no ALTIS_RUNNER: worker mode
      await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
      const { op } = await writeOp(dirs.dataDir, { kind: 'backup', state: 'exporting' });
      const ctx = bootContext(dirs.dataDir);
      const started = start(ctx);
      const served = await ctx.served();
      await vi.waitFor(async () => expect((await health(served)).status).toBe(503), { timeout: 10_000, interval: 50 });
      expect(seen.connects).toBe(0);
      await writeOp(dirs.dataDir, { ...op, state: 'done' });
      await started; // no request: the loop's own look ends the wait
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
      expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: '0.1.0' } });
    },
    30_000,
  );

  it('an op that becomes active once the app is ready gets exactly one step from the boot (§9.4 "atau boot")', async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off'); // no worker loop: only the boot steps
    await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
    const ctx = bootContext(dirs.dataDir);
    ctx.markHealthy.mockImplementation(async () => {
      seen.steps.push('ready');
      await writeOp(dirs.dataDir, { kind: 'backup', state: 'exporting' });
    });
    await start(ctx);
    expect(seen.steps).toEqual(['ready', 'step']);
  });
});
