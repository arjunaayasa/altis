import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SCHEDULES,
  claimById,
  createJobRegistry,
  enqueue,
  runSlice,
  type JobHandler,
  type JobRegistry,
  type KeyringEntry,
  type Mailer,
  type OpsMachine,
} from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { createSettingsCache } from '@altis/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { CATALOG_ROUTES } from '../../src/api/catalog/index.js';
import { runCli, USAGE } from '../../src/cli/index.js';
import { writeConfig } from '../../src/config.js';
import { defineRoutes } from '../../src/http/route.js';
import { start } from '../../src/index.js';
import { catalogJobDeps, catalogJobHandlers } from '../../src/jobs/catalog.js';
import { bindJobHandlers, jobHandlers } from '../../src/jobs/runtime.js';
import { OPAC_CATALOG_ROUTES } from '../../src/opac/catalog/index.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { captureIo } from '../cli-support.js';
import { CATALOG_MATRIX, mergeAreaMatrices, type AreaMatrix } from '../matrix/catalog.js';
import { EXPECTED_MAINTENANCE, MATRIX_FIXTURES } from '../matrix-fixtures.js';
import { bootContext, closeTestServers, httpRequest, sampleConfig, serverLog, useDataDir } from '../support.js';

// The Phase 2 scaffolding of Task 3 on the server: the route lists of every area are joined into ALL_ROUTES (empty in
// Wave 0), the matrix area files merge without overlap, the catalog job handlers are wired into the job runtime (the
// housekeeping job and the reindex stub, bound to the process like the backup jobs), the boot hook runs after the
// migrations and never fails the boot, and the two CLI commands answer "not available yet".

const boot = vi.hoisted(() => ({ calls: [] as { registryTypes: string[]; keyring: unknown; now: unknown }[], fail: false }));
vi.mock('../../src/catalog-boot.js', () => ({
  catalogBoot: vi.fn(async (_h: unknown, rt: { registry: JobRegistry; keyring: unknown; now: unknown }) => {
    boot.calls.push({ registryTypes: rt.registry.types(), keyring: rt.keyring, now: rt.now });
    if (boot.fail) throw new Error('catalog boot exploded');
  }),
}));

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const CONFIG = { ...sampleConfig({ db: { dialect: 'sqlite' } }), keyring };
const silentMailer: Mailer = { send: async () => {} };
const silent = { info() {}, warn() {}, error() {} };

describe('the catalog routes in ALL_ROUTES (Wave 0)', () => {
  it('ALL_ROUTES still validates and holds every route of the catalog lists (filled by the Wave 1 tasks)', () => {
    expect(() => defineRoutes([...ALL_ROUTES])).not.toThrow();
    for (const route of [...CATALOG_ROUTES, ...OPAC_CATALOG_ROUTES]) expect(ALL_ROUTES).toContain(route);
  });

  it('routes.ts spreads CATALOG_ROUTES before INSTALL_ROUTES (only the community routes between), and OPAC_CATALOG_ROUTES before OPAC_ROUTES (only the guestbook station between)', async () => {
    const text = await fsp.readFile(new URL('../../src/routes.ts', import.meta.url), 'utf8');
    const spreads = [...text.matchAll(/^\s*\.\.\.([A-Z_]+)|^\s*\.\.\.(testOnlyRoutes)\(\)/gm)].map((m) => m[1] ?? m[2]);
    expect(spreads.indexOf('CATALOG_ROUTES')).toBeGreaterThan(spreads.indexOf('DIAGNOSTICS_ROUTES'));
    expect(spreads.slice(spreads.indexOf('CATALOG_ROUTES'), spreads.indexOf('INSTALL_ROUTES') + 1)).toEqual([
      'CATALOG_ROUTES',
      'KOMUNITAS_ROUTES',
      'INSTALL_ROUTES',
    ]);
    expect(spreads.slice(spreads.indexOf('OPAC_CATALOG_ROUTES'), spreads.indexOf('OPAC_ROUTES') + 1)).toEqual([
      'OPAC_CATALOG_ROUTES',
      'VISIT_STATION_ROUTES', // Komunitas K2: the guestbook station's pages (`/kunjungan`), before the OPAC's own
      'OPAC_ROUTES',
    ]);
  });
});

describe('the matrix area files', () => {
  it('merge into rows, fixtures and maintenance entries of their own, spread into the matrix maps', () => {
    expect(Object.keys(CATALOG_MATRIX).sort()).toEqual(['fixtures', 'maintenance', 'rows']);
    for (const id of Object.keys(CATALOG_MATRIX.fixtures)) expect(MATRIX_FIXTURES[id]).toBe(CATALOG_MATRIX.fixtures[id]);
    for (const [id, m] of Object.entries(CATALOG_MATRIX.maintenance)) expect(EXPECTED_MAINTENANCE[id]).toBe(m);
  });

  const fixture = async () => ({});
  const area = (o: Partial<AreaMatrix>): AreaMatrix => ({ rows: {}, fixtures: {}, maintenance: {}, ...o });

  it('keeps the areas in order and refuses a route id two areas claim', () => {
    const a = area({ rows: { 'x.a': 'GET /a' }, fixtures: { 'x.a': fixture } });
    const b = area({ rows: { 'x.b': 'GET /b' }, fixtures: { 'x.b': fixture }, maintenance: { 'x.b': 'allow' } });
    expect(mergeAreaMatrices({ a, b })).toEqual({
      rows: { 'x.a': 'GET /a', 'x.b': 'GET /b' },
      fixtures: { 'x.a': fixture, 'x.b': fixture },
      maintenance: { 'x.b': 'allow' },
    });
    expect(Object.keys(mergeAreaMatrices({ b, a }).rows)).toEqual(['x.b', 'x.a']);
    expect(() => mergeAreaMatrices({ a, b: area({ rows: { 'x.a': 'GET /a' }, fixtures: { 'x.a': fixture } }) })).toThrow(/x\.a/);
  });

  it('refuses an area whose rows and fixtures differ, or a maintenance entry without its row', () => {
    expect(() => mergeAreaMatrices({ a: area({ rows: { 'x.a': 'GET /a' } }) })).toThrow(/x\.a/);
    expect(() => mergeAreaMatrices({ a: area({ fixtures: { 'x.a': fixture } }) })).toThrow(/x\.a/);
    expect(() => mergeAreaMatrices({ a: area({ maintenance: { 'x.a': 'allow' } }) })).toThrow(/x\.a/);
  });
});

describe('the catalog job handlers', () => {
  it('jobHandlers() has catalog.housekeeping and catalog.reindex (the Wave 1 tasks add theirs)', () => {
    const types = jobHandlers().map((h) => h.type);
    expect(types).toContain('catalog.housekeeping');
    expect(types).toContain('catalog.reindex');
    expect(catalogJobHandlers(() => catalogJobDeps({} as never)).map((h) => h.type)).toEqual(
      expect.arrayContaining(['catalog.housekeeping', 'catalog.reindex']),
    );
  });

  it('every job type of SCHEDULES has a handler in a server process (one with its housekeeping, Diagnostik and update-check deps)', () => {
    const types = new Set(
      jobHandlers({
        diagnostics: { dataDir: '/data', appRoot: '/app', baseUrl: () => null },
        housekeeping: { dataDir: '/data', mailer: silentMailer, baseUrl: () => CONFIG.baseUrl, settings: createSettingsCache({ clock: Date.now }) },
        // 1d Task 28: start() passes the feed client of the daily `update.check` (never called here).
        updateCheck: { source: () => ({}) as never },
      }).map((h) => h.type),
    );
    expect(SCHEDULES.map((d) => d.jobType).filter((t) => !types.has(t))).toEqual([]);
  });

  it('catalogJobDeps: DATA_DIR, the baseUrl and keyring of the config of the moment, the local storage, the logger', () => {
    const d = catalogJobDeps({ dataDir: '/data', runtime: 'standalone', installId: 'i', appVersion: '0.1.0', ops: {} as OpsMachine, config: () => CONFIG, log: silent });
    expect(d).toMatchObject({ dataDir: '/data', baseUrl: CONFIG.baseUrl, keyring, log: silent });
    expect(typeof d.storage.put).toBe('function');
    expect(() => catalogJobDeps({ dataDir: '/data', runtime: 'standalone', installId: 'i', appVersion: '0.1.0', ops: {} as OpsMachine, config: () => undefined })).toThrow(TypeError);
  });

  describe.skipIf(!ctx.available)(`run by a job runtime [${engineLabel()}]`, () => {
    let h: TestDbHandle;
    let root: string;
    const NOW = Date.UTC(2026, 9, 30, 20, 40);

    beforeAll(async () => {
      h = await testDb();
      root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-catalog-scaffold-'));
      await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    });

    afterAll(async () => {
      await h?.close();
      if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
    });

    /** Enqueues `type` and runs its slices with `reg` until it ends; its last outcome. */
    async function runJob(reg: JobRegistry, type: string, payload: unknown): Promise<string> {
      const { id } = await withTx(h, (trx) => enqueue(trx, reg, { type, payload, maxAttempts: 1 }, { now: NOW, keyring }));
      for (let i = 0; i < 20; i += 1) {
        const job = await claimById(h, reg, id, { worker: 'test', now: NOW });
        if (job === null) throw new Error('not claimable');
        const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => NOW, env: {} });
        if (r.outcome !== 'continued') return r.outcome;
      }
      throw new Error('no end');
    }

    it('bound to the runtime (needsRuntime), catalog.housekeeping and the reindex stub succeed', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bound: JobHandler<any>[] = bindJobHandlers(jobHandlers(), {
        dataDir: root,
        runtime: 'standalone',
        installId: CONFIG.install.id,
        appVersion: '0.1.0',
        ops: {} as OpsMachine,
        config: () => CONFIG,
        log: silent,
      });
      const reg = createJobRegistry(bound);
      expect(await runJob(reg, 'catalog.housekeeping', { windowStart: NOW - 86_400_000, windowEnd: NOW })).toBe('succeeded');
      expect(await runJob(reg, 'catalog.reindex', { scope: 'all' })).toBe('succeeded');
    });

    it('unbound (a registry that only enqueues), the housekeeping slice fails: it has no process to run in', async () => {
      const reg = createJobRegistry(jobHandlers());
      expect(await runJob(reg, 'catalog.housekeeping', { windowStart: NOW - 1, windowEnd: NOW })).toBe('dead');
    });
  });
});

describe('the boot hook', () => {
  const dirs = useDataDir();

  afterEach(async () => {
    await closeTestServers();
    boot.calls.length = 0;
    boot.fail = false;
  });

  it('runs once after the migrations, with the job runtime registry, the keyring and the clock', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' } }));
    const c = bootContext(dirs.dataDir);
    await start(c);
    const served = await c.served();
    expect((await httpRequest(served.port, '/_health')).status).toBe(200);
    expect(boot.calls).toHaveLength(1);
    expect(boot.calls[0]!.registryTypes).toEqual(expect.arrayContaining(['catalog.housekeeping', 'catalog.reindex']));
    expect(Array.isArray(boot.calls[0]!.keyring)).toBe(true);
    expect(typeof boot.calls[0]!.now).toBe('number');
  });

  it('a failure is logged and the boot goes on: the server is healthy', async () => {
    boot.fail = true;
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' } }));
    const c = bootContext(dirs.dataDir);
    await start(c);
    const served = await c.served();
    expect((await httpRequest(served.port, '/_health')).status).toBe(200);
    expect(c.markHealthy).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const line = (await serverLog(dirs.dataDir)).find((l) => l['msg'] === 'catalog boot hook failed');
      expect(line).toMatchObject({ level: 'error', error: { errorName: 'Error' } });
    });
  });
});

describe('the CLI commands of Wave 0', () => {
  const dirs = useDataDir();

  // Wave 1 (Tasks 15 and 23) replaced the "belum tersedia" stubs: both commands now refuse a DATA_DIR with no install.
  it.each([
    [['catalog:reindex']],
    [['slims:import', '--dump', 'slims.sql', '--dry-run']],
    [['slims:import', '--db', 'db.example:3306/slims', '--user', 'baca', '--files-dir', '/srv/slims', '--branch', 'PUSAT', '--price-mode', 'minor', '--allow-non-empty']],
  ])('%j before the install → exit 1, nothing on stdout, no stub message', async (argv) => {
    const io = captureIo();
    expect(await runCli(argv, bootContext(dirs.dataDir), io)).toBe(1);
    expect(io.err).not.toContain('belum tersedia / not available yet');
    expect(io.out).toBe('');
  });

  it('with --json: one JSON line on stdout, ok false, code NOT_INSTALLED', async () => {
    const io = captureIo();
    expect(await runCli(['catalog:reindex', '--json'], bootContext(dirs.dataDir), io)).toBe(1);
    expect(JSON.parse(io.out)).toMatchObject({ ok: false, command: 'catalog:reindex', code: 'NOT_INSTALLED' });
  });

  it('a password never comes through the arguments: --password is an unknown option, its value is not echoed', async () => {
    const io = captureIo();
    expect(await runCli(['slims:import', '--dump', 'slims.sql', '--password', 'Sandi-9Q7xZ'], bootContext(dirs.dataDir), io)).toBe(1);
    expect(io.err).toContain('USAGE');
    expect(io.err).toContain('--password');
    expect(io.err).not.toContain('Sandi-9Q7xZ');
    expect(io.out).toBe('');
  });

  it.each([
    [['slims:import', '--dump', 'slims.sql', '--price-mode', 'gratis']],
    [['slims:import', '--dump', 'slims.sql', '--branch']],
    [['slims:import']],
    [['slims:import', '--dry-run']],
    [['slims:import', '--db', 'db.example:3306/slims']],
    [['slims:import', '--user', 'baca', '--dump', 'slims.sql']],
    [['slims:import', '--db', 'db.example:3306/slims', '--user', 'baca', '--dump', 'slims.sql']],
    [['slims:import', '--dump', 'slims.sql', '--files-zip', 'f.zip', '--files-dir', '/srv/slims']],
    [['slims:import', '--dump', '\u0007bell']],
    [['catalog:reindex', '--dry-run']],
    [['catalog:reindex', 'extra']],
  ])('%j is a usage error', async (argv) => {
    const io = captureIo();
    expect(await runCli(argv, bootContext(dirs.dataDir), io)).toBe(1);
    expect(io.err).toContain('USAGE');
    expect(io.out).toBe('');
  });

  it('help lists both commands', () => {
    expect(USAGE).toContain('catalog:reindex');
    expect(USAGE).toContain('slims:import');
  });
});
