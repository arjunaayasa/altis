import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SCHEDULES,
  claimById,
  createJobRegistry,
  createSettingsCache,
  enqueue,
  runSlice,
  type JobHandler,
  type JobRegistry,
  type KeyringEntry,
  type Mailer,
  type OpsMachine,
} from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { ACCREDITATION_ROUTES } from '../../src/api/accreditation/index.js';
import { CIRCULATION_ROUTES } from '../../src/api/circulation/index.js';
import { MEMBERS_ROUTES } from '../../src/api/members/index.js';
import { REPORTS_ROUTES } from '../../src/api/reports/index.js';
import { defineRoutes } from '../../src/http/route.js';
import { komunitasJobDeps, komunitasJobHandlers } from '../../src/jobs/komunitas.js';
import { bindJobHandlers, jobHandlers } from '../../src/jobs/runtime.js';
import { ALL_ROUTES, KOMUNITAS_ROUTES } from '../../src/routes.js';
import { K1_PENDING_ALLOWED, KOMUNITAS_AUDIT_SCRIPTS } from '../audit/komunitas.js';
import { KOMUNITAS_MATRIX, KOMUNITAS_SYSTEM_ROUTES } from '../matrix/komunitas.js';
import { EXPECTED_MAINTENANCE, EXPECTED_SYSTEM_ROUTES, MATRIX_FIXTURES } from '../matrix-fixtures.js';
import { sampleConfig } from '../support.js';

// The community scaffolding on the server (reports and accreditation): the route lists of every area are joined into
// ALL_ROUTES right after the catalog API (empty until their changes fill them), the matrix and audit area files merge
// and are spread into the shared maps, and the four community job handlers are in the job runtime with the reports'
// daily schedule; bound to a process, each of them (not written yet) runs to its end.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const CONFIG = { ...sampleConfig({ db: { dialect: 'sqlite' } }), keyring };
const silentMailer: Mailer = { send: async () => {} };
const silent = { info() {}, warn() {}, error() {} };
const K1_JOB_TYPES = ['reports.export', 'reports.housekeeping', 'accreditation.evaluate', 'accreditation.import_slims_usage'];

describe('the community routes in ALL_ROUTES', () => {
  it('ALL_ROUTES still validates and holds every route of the community lists, the reports first', () => {
    expect(() => defineRoutes([...ALL_ROUTES])).not.toThrow();
    expect(KOMUNITAS_ROUTES).toEqual([...REPORTS_ROUTES, ...ACCREDITATION_ROUTES, ...MEMBERS_ROUTES, ...CIRCULATION_ROUTES]);
    for (const route of KOMUNITAS_ROUTES) expect(ALL_ROUTES).toContain(route);
  });

  it('routes.ts spreads KOMUNITAS_ROUTES right after CATALOG_ROUTES and before INSTALL_ROUTES', async () => {
    const text = await fsp.readFile(new URL('../../src/routes.ts', import.meta.url), 'utf8');
    const all = text.slice(text.indexOf('export const ALL_ROUTES'));
    const spreads = [...all.matchAll(/^\s*\.\.\.([A-Z_]+)|^\s*\.\.\.(testOnlyRoutes)\(\)/gm)].map((m) => m[1] ?? m[2]);
    expect(spreads.indexOf('KOMUNITAS_ROUTES')).toBe(spreads.indexOf('CATALOG_ROUTES') + 1);
    expect(spreads.indexOf('INSTALL_ROUTES')).toBe(spreads.indexOf('KOMUNITAS_ROUTES') + 1);
  });
});

describe('the community matrix and audit area files', () => {
  it('merge into rows, fixtures, maintenance and system routes spread into the matrix maps', () => {
    for (const id of Object.keys(KOMUNITAS_MATRIX.fixtures)) expect(MATRIX_FIXTURES[id]).toBe(KOMUNITAS_MATRIX.fixtures[id]);
    for (const [id, m] of Object.entries(KOMUNITAS_MATRIX.maintenance)) expect(EXPECTED_MAINTENANCE[id]).toBe(m);
    for (const id of KOMUNITAS_SYSTEM_ROUTES) expect(EXPECTED_SYSTEM_ROUTES).toContain(id);
    expect(Object.keys(KOMUNITAS_MATRIX.rows)).toEqual(Object.keys(KOMUNITAS_MATRIX.fixtures));
  });

  it('the audit scripts list the 18 community actions, pending while their scripts are not written', () => {
    expect(Object.values(KOMUNITAS_AUDIT_SCRIPTS).flatMap((s) => [...s.actions])).toHaveLength(18);
    const pending = Object.values(KOMUNITAS_AUDIT_SCRIPTS).filter((s) => s.run === null);
    if (pending.length > 0) expect(K1_PENDING_ALLOWED).toBe(true);
  });
});

describe('the community job handlers', () => {
  it('jobHandlers() has the four community job types, declared as their jobs need', () => {
    const types = jobHandlers().map((h) => h.type);
    for (const type of K1_JOB_TYPES) expect(types).toContain(type);
    const declared = Object.fromEntries(
      komunitasJobHandlers(() => komunitasJobDeps({} as never)).map((h) => [
        h.type,
        [h.permission, h.retryable, h.interactive === true, h.longRunning === true, h.cpuHeavy === true],
      ]),
    );
    expect(declared).toEqual({
      'reports.export': ['system.jobs.manage', 'api', true, false, false],
      'reports.housekeeping': ['system.jobs.manage', 'api', false, false, false],
      'accreditation.evaluate': ['accreditation.workspace.read', 'api', true, false, false],
      'accreditation.import_slims_usage': ['accreditation.workspace.manage', 'origin-only', true, true, true],
    });
  });

  it('every job type of SCHEDULES has a handler in a server process, the reports housekeeping included', () => {
    const types = new Set(
      jobHandlers({
        diagnostics: { dataDir: '/data', appRoot: '/app', baseUrl: () => null },
        housekeeping: { dataDir: '/data', mailer: silentMailer, baseUrl: () => CONFIG.baseUrl, settings: createSettingsCache({ clock: Date.now }) },
        updateCheck: { source: () => ({}) as never },
      }).map((h) => h.type),
    );
    expect(SCHEDULES.map((d) => d.jobType).filter((t) => !types.has(t))).toEqual([]);
    expect(SCHEDULES.find((d) => d.name === 'reports.housekeeping')).toMatchObject({ expr: '50 3 * * *', jobType: 'reports.housekeeping', enabledByDefault: true });
  });

  it('komunitasJobDeps: the catalogue jobs facts of the config of the moment, and the running release', () => {
    const rt = { dataDir: '/data', runtime: 'standalone' as const, installId: 'i', appVersion: '0.9.1', ops: {} as OpsMachine, config: () => CONFIG, log: silent };
    expect(komunitasJobDeps(rt)).toMatchObject({ dataDir: '/data', baseUrl: CONFIG.baseUrl, keyring, log: silent, appVersion: '0.9.1' });
    expect(() => komunitasJobDeps({ ...rt, config: () => undefined })).toThrow(TypeError);
  });

  describe.skipIf(!ctx.available)(`run by a job runtime [${engineLabel()}]`, () => {
    let h: TestDbHandle;
    let root: string;
    const NOW = Date.UTC(2026, 10, 14, 20, 50);

    beforeAll(async () => {
      h = await testDb();
      root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-komunitas-scaffold-'));
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

    it('bound to the runtime, the four community jobs (not written yet) run to their end', async () => {
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
      expect(await runJob(reg, 'reports.housekeeping', { windowStart: NOW - 86_400_000, windowEnd: NOW })).toBe('succeeded');
      expect(await runJob(reg, 'reports.export', { runId: newId() })).toBe('succeeded');
      expect(await runJob(reg, 'accreditation.evaluate', { periodId: newId() })).toBe('succeeded');
      expect(await runJob(reg, 'accreditation.import_slims_usage', { runId: newId() })).toBe('succeeded');
    });

    it('unbound (a registry that only enqueues), a community job fails: it has no process to run in', async () => {
      const reg = createJobRegistry(jobHandlers());
      expect(await runJob(reg, 'reports.housekeeping', { windowStart: NOW - 1, windowEnd: NOW })).toBe('dead');
    });
  });
});
