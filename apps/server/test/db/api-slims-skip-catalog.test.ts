import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __setSlimsSourceFactory,
  __setSlimsStages,
  claimById,
  createJobRegistry,
  localStorageDriver,
  runSlice,
  slimsJobs,
  startSlimsMigration,
  txCtx,
  writeSettings,
  type CatalogJobDeps,
  type CoreLogger,
} from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { slimsFixtureBytes } from '../../../../packages/core/test/support/slims-fixture/index.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// `POST catalog/migrations/slims` with `skipCatalog` (on the engine picked by ALTIS_TEST_DB, the real SLiMS stages and
// the synthetic fixture): a real run that skips the catalogue stages follows a sync dry run (`fromRunId`) that ran them
// and found no change. After a first migration, a sync dry run of the changed source (10 changes) → 422
// MIGRATION_PRECHECK_FAILED with reason `catalog_changed`; a sync dry run of the unchanged source (0) → accepted, the run
// skips the catalogue stages (their rows counted skipped) and no copy is rewritten; no dry run named → 422 with
// `{path: 'skipCatalog', code: 'dry_run_required'}`.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 10, 4, 10, 0, 0);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1/catalog/migrations/slims';
const LIBRARY = 'Perpustakaan Lompat Katalog';
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const DB_SOURCE = { kind: 'db', host: 'slims.internal', port: 3306, user: 'baca', password: 'Rahasia-SLiMS-1', database: 'slims', tls: false };

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

describe.skipIf(!ctx.available)(`SLiMS migration API: skipping the catalogue [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let owner: { userId: string; post(p: string, body?: unknown): Promise<AgentReply> };
  let branchId: string;
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: CONFIG.baseUrl, keyring: CONFIG.keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));
  const plain = slimsFixtureBytes();
  const mutated = slimsFixtureBytes(undefined, { mutateCatalog: true });

  async function staged(bytes: Buffer): Promise<string> {
    const id = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', id), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', id, 'upload.bin'), bytes);
    return id;
  }

  /** Claims and runs job `id` until it ends (as any process would). */
  async function runToEnd(id: string): Promise<string> {
    for (let i = 0; i < 1000; i += 1) {
      const job = await claimById(h, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: 20_000, keyring: CONFIG.keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error('no end');
  }

  /** A migration of `dump` by the owner, run to its end: its run id and summary. */
  async function migrate(dump: Buffer, o: { dryRun: boolean; sync: boolean; later: boolean }): Promise<{ runId: string; summary: MigrationSummary }> {
    const started = await withTx(h, async (trx) =>
      startSlimsMigration(
        txCtx(trx, NOW, { type: 'staff', id: owner.userId, ip: null }),
        registry,
        {
          dryRun: o.dryRun,
          sourceKind: 'dump',
          db: null,
          password: null,
          dumpStagingId: await staged(dump),
          files: 'zip',
          filesStagingId: await staged(plain.filesZip),
          filesDir: null,
          branchId,
          priceMode: 'major',
          sourceName: 'slims',
          allowNonEmpty: o.later,
          confirmLibraryName: o.later ? LIBRARY : null,
          fromRunId: null,
          ...(o.sync ? { catalogMode: 'sync' as const } : {}),
        },
        { keyring: CONFIG.keyring },
      ),
    );
    expect(await runToEnd(started.jobId)).toBe('succeeded');
    return { runId: started.runId, summary: await summaryOf(started.runId) };
  }

  async function summaryOf(runId: string): Promise<MigrationSummary> {
    const run = await h.db.selectFrom('catalog_runs').select(['status', 'summary']).where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    return JSON.parse(run.summary) as MigrationSummary;
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-slims-skip-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'migrations'), migrations: PHASE1_MIGRATIONS });
    branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'LOMPAT', code_display: 'LOMPAT', name: LIBRARY, timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
      .execute();
    await withTx(h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 1, 'library.name': LIBRARY }, { now: NOW, actorId: null, keyring: [] }));
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    const user = await seedStaff(h, { username: 'kepala_lompat', now: NOW, roles: [{ key: 'super_admin' }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    owner = { userId: user.id, post: (p, body) => agent.post(p, body, csrf) };
    // The real sources and stages.
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const skipBody = (o: Record<string, unknown> = {}) => ({
    branchId,
    allowNonEmpty: true,
    confirmLibraryName: LIBRARY,
    dryRun: false,
    catalogMode: 'sync',
    skipCatalog: true,
    ...o,
  });

  it('skipCatalog after a sync dry run that found changes → 422 catalog_changed; after one that found none → accepted, the catalogue untouched; without one → dry_run_required', async () => {
    await migrate(plain.dump, { dryRun: false, sync: false, later: false });
    const changed = await migrate(mutated.dump, { dryRun: true, sync: true, later: true });
    expect(changed.summary.catalogChanges).toBe(10);
    const unchanged = await migrate(plain.dump, { dryRun: true, sync: true, later: true });
    expect(unchanged.summary.catalogChanges).toBe(0);

    const refused = await owner.post(API, skipBody({ fromRunId: changed.runId }));
    expect([refused.status, code(refused), (refused.json as { reason?: string }).reason], refused.text).toEqual([422, 'MIGRATION_PRECHECK_FAILED', 'catalog_changed']);
    expect((refused.json as { detail?: string }).detail).toContain('10');
    // The refused start took nothing over: the dry run can still be followed by a sync.
    expect(JSON.parse((await h.db.selectFrom('catalog_runs').select('options').where('id', '=', changed.runId).executeTakeFirstOrThrow()).options)).not.toHaveProperty('adoptedBy');

    const none = await owner.post(API, skipBody({ source: DB_SOURCE }));
    expect([none.status, errors(none)], none.text).toEqual([422, [{ path: 'skipCatalog', code: 'dry_run_required' }]]);
    // The target guard still applies to a run that skips the catalogue.
    const unconfirmed = await owner.post(API, skipBody({ fromRunId: unchanged.runId, allowNonEmpty: false, confirmLibraryName: undefined }));
    expect([unconfirmed.status, code(unconfirmed)]).toEqual([409, 'MIGRATION_TARGET_NOT_EMPTY']);

    const versions = async () => (await h.db.selectFrom('items').select(['id', 'version']).execute()).map((r) => `${r.id}:${Number(r.version)}`).sort();
    const before = await versions();
    const accepted = await owner.post(API, skipBody({ fromRunId: unchanged.runId }));
    expect(accepted.status, accepted.text).toBe(201);
    const run = accepted.json as { runId: string; jobId: string };
    expect(JSON.parse((await h.db.selectFrom('catalog_runs').select('options').where('id', '=', run.runId).executeTakeFirstOrThrow()).options)).toMatchObject({
      adoptedFrom: unchanged.runId,
      catalogMode: 'sync',
      skipCatalog: true,
    });
    expect(await runToEnd(run.jobId)).toBe('succeeded');
    const s = await summaryOf(run.runId);
    // The catalogue stages were skipped: their tables' rows counted skipped, the run reconciles, no copy rewritten.
    expect(s.reconciliation!.tables.filter((t) => !t.unread && t.diff !== 0)).toEqual([]);
    expect(s.reconciliation?.ok).toBe(true);
    expect(s.tables['item']).toMatchObject({ source: 600, migrated: 0, skipped: { catalog_skipped: 600 } });
    expect(s.tables['biblio']).toMatchObject({ source: 300, migrated: 0, skipped: { catalog_skipped: 300 } });
    expect(await versions()).toEqual(before);
  }, 900_000);
});
