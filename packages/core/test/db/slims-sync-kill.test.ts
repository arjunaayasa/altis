import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type Actor, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { retryDelayMs } from '../../src/jobs/types.js';
import { __setSlimsSourceFactory, __setSlimsStages } from '../../src/migration/slims/factory.js';
import { startSlimsMigration, type SlimsStartInput } from '../../src/migration/slims/job.js';
import { slimsJobs } from '../../src/migration/slims/jobs.js';
import { __setSlimsStageBatch } from '../../src/migration/slims/stages/stage-a-kit.js';
import { __setSlimsStageBBatch } from '../../src/migration/slims/stages/stage-b-kit.js';
import { writeSettings } from '../../src/settings/service.js';
import { wipeCatalog } from '../support/search-corpus.js';
import { slimsFixtureBytes } from '../support/slims-fixture/index.js';

// A SLiMS catalogue re-sync killed in the middle and resumed (on the engine picked by ALTIS_TEST_DB): a child process
// runs the sync of the changed fixture one batch per slice and is SIGKILLed right after an `items` batch that rewrote
// copies committed, before its slice saved the counts; this process resumes the run to its end. The legacy map and the
// rows of `records`, `items` and `item_events` then equal those of the same sync never killed, from the same first run
// (each compared without its random ids: an id is named by the legacy key that maps to it).

const ctx = testDbContext();
const ROOT = path.resolve(import.meta.dirname, '../../../..');
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
/** In the past: an audit entry may not be dated ahead of the real clock. Every run's clock stands here. */
const NOW = Date.UTC(2026, 10, 3, 9, 0, 0);
const LIBRARY = 'Perpustakaan Tangguh';
/** Rows per batch of both stage kits in the stepped runs (one batch per slice). */
const STEP_BATCH = 100;
/** A ULID inside a text. */
const ULID_IN_TEXT = /[0-9A-HJKMNP-TV-Z]{26}/g;

describe.skipIf(!ctx.available)(`SLiMS catalogue re-sync killed and resumed [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let branchId: string;
  let staff: Actor;
  let plain: ReturnType<typeof slimsFixtureBytes>;
  let mutated: ReturnType<typeof slimsFixtureBytes>;
  let seeds: Record<'material_types' | 'languages' | 'collection_types', string[]>;
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-sync-kill-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    seeds = {
      material_types: (await h.db.selectFrom('material_types').select('id').execute()).map((r) => r.id),
      languages: (await h.db.selectFrom('languages').select('id').execute()).map((r) => r.id),
      collection_types: (await h.db.selectFrom('collection_types').select('id').execute()).map((r) => r.id),
    };
    branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'TANGGUH', code_display: 'TANGGUH', name: LIBRARY, timezone: 'Asia/Jakarta', is_default: 0, created_at: NOW, updated_at: NOW })
      .execute();
    const staffId = newId(NOW);
    await h.db
      .insertInto('staff_users')
      .values({ id: staffId, username_key: 'TANGGUH', username_display: 'tangguh', name: 'tangguh', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
    staff = { type: 'staff', id: staffId, ip: null };
    await withTx(h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 1, 'library.name': LIBRARY }, { now: NOW, actorId: null, keyring: [] }));
    plain = slimsFixtureBytes();
    mutated = slimsFixtureBytes(undefined, { mutateCatalog: true });
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
  }, 120_000);

  afterEach(() => {
    __setSlimsStageBatch(null);
    __setSlimsStageBBatch(null);
  });

  afterAll(async () => {
    if (h !== undefined) {
      await wipe();
      await h.close();
    }
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  async function wipe(): Promise<void> {
    await h.db.deleteFrom('page_translations').execute();
    await h.db.deleteFrom('pages').execute();
    await wipeCatalog(h);
    for (const table of ['migration_map', 'migration_archive', 'catalog_runs', 'suppliers', 'jobs', 'locks'] as const) await h.db.deleteFrom(table).execute();
    for (const table of ['material_types', 'languages', 'collection_types'] as const) await h.db.deleteFrom(table).where('id', 'not in', seeds[table]).execute();
    await h.db.deleteFrom('settings').where('key', 'in', ['catalog.sru.servers', 'catalog.barcode.patterns']).execute();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.mkdir(dataDir, { recursive: true });
  }

  async function staged(bytes: Buffer): Promise<string> {
    const id = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', id), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', id, 'upload.bin'), bytes);
    return id;
  }

  async function start(fixture: ReturnType<typeof slimsFixtureBytes>, sync: boolean): Promise<{ runId: string; jobId: string }> {
    const input: SlimsStartInput = {
      dryRun: false,
      sourceKind: 'dump',
      db: null,
      password: null,
      dumpStagingId: await staged(fixture.dump),
      files: 'zip',
      filesStagingId: await staged(fixture.filesZip),
      filesDir: null,
      branchId,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: sync,
      confirmLibraryName: sync ? LIBRARY : null,
      fromRunId: null,
      ...(sync ? { catalogMode: 'sync' as const } : {}),
    };
    return withTx(h, (trx) => startSlimsMigration(txCtx(trx, NOW, staff), registry, input, { keyring }));
  }

  /** Runs job `id` slice by slice until it ends: the split and analyze slices get 20 s, every other `budgetMs`. */
  async function runToEnd(id: string, budgetMs = 20_000): Promise<string> {
    for (let slices = 1; slices <= 3000; slices += 1) {
      const payload = JSON.parse((await h.db.selectFrom('jobs').select('payload').where('id', '=', id).executeTakeFirstOrThrow()).payload) as { stage: number };
      const job = await claimById(h, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: payload.stage < 2 ? 20_000 : budgetMs, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error('no end after 3000 slices');
  }

  async function summaryOf(runId: string): Promise<MigrationSummary> {
    const run = await h.db.selectFrom('catalog_runs').select(['status', 'summary']).where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    return JSON.parse(run.summary) as MigrationSummary;
  }

  /**
   * The legacy map and the rows of `records`, `items` and `item_events` without their random ids: every id named by the
   * first legacy key that maps to it (`biblio:7`, `item:12`, ...), or for a seeded master by its code; a run by its mode.
   */
  async function snapshot(): Promise<Record<string, string[]>> {
    const names = new Map<string, string>();
    const maps = (await h.db.selectFrom('migration_map').select(['source', 'entity', 'legacy_key', 'target_id', 'run_id']).execute()).sort((a, b) => {
      const x = `${a.entity}\u0000${a.legacy_key}`;
      const y = `${b.entity}\u0000${b.legacy_key}`;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const m of maps) if (!names.has(m.target_id)) names.set(m.target_id, `${m.entity}:${m.legacy_key}`);
    for (const t of ['material_types', 'languages', 'collection_types', 'suppliers', 'locations'] as const) {
      for (const r of await h.db.selectFrom(t).select(['id', 'code_key']).execute()) if (!names.has(r.id)) names.set(r.id, `${t}:${r.code_key}`);
    }
    // Two runs made at the same instant of the standing clock: named by their catalogue mode, not by their ids.
    for (const r of await h.db.selectFrom('catalog_runs').select(['id', 'options']).execute()) {
      names.set(r.id, `run:${(JSON.parse(r.options) as { catalogMode?: string }).catalogMode ?? 'append'}`);
    }
    names.set(branchId, 'branch');
    const name = (v: unknown): unknown => {
      if (typeof v === 'string') return names.get(v) ?? v.replace(ULID_IN_TEXT, (u) => names.get(u) ?? u);
      if (typeof v === 'bigint') return Number(v);
      return v;
    };
    const canon = (row: Record<string, unknown>, drop: readonly string[]): string =>
      JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, name(v)])));
    const out: Record<string, string[]> = {};
    out['migration_map'] = maps.map((m) => `${m.source}|${m.entity}|${m.legacy_key}|${String(name(m.target_id))}|${String(name(m.run_id))}`);
    out['records'] = ((await h.db.selectFrom('records').selectAll().execute()) as unknown as Record<string, unknown>[]).map((r) => canon(r, ['id'])).sort();
    out['items'] = ((await h.db.selectFrom('items').selectAll().execute()) as unknown as Record<string, unknown>[]).map((r) => canon(r, ['id'])).sort();
    out['item_events'] = ((await h.db.selectFrom('item_events').selectAll().execute()) as unknown as Record<string, unknown>[]).map((r) => canon(r, ['id'])).sort();
    return out;
  }

  it('a sync SIGKILLed after an items batch committed, resumed → the same legacy map, records, items and history as the sync never killed', async () => {
    // The same sync never killed: the same batches, one per slice, after the same first run.
    await wipe();
    const first = await start(plain, false);
    expect(await runToEnd(first.jobId)).toBe('succeeded');
    __setSlimsStageBatch(STEP_BATCH);
    __setSlimsStageBBatch(STEP_BATCH);
    const steadyRun = await start(mutated, true);
    expect(await runToEnd(steadyRun.jobId, 2_000)).toBe('succeeded');
    const steady = { snapshot: await snapshot(), summary: await summaryOf(steadyRun.runId) };
    expect(steady.summary.reconciliation?.ok).toBe(true);
    // The sync rewrote copies (the changed ones lie in the first batch of `items`), and wrote their history.
    expect(steady.snapshot['item_events']!.filter((e) => e.includes('"via\\":\\"sync\\"')).length).toBeGreaterThan(5);

    await wipe();
    __setSlimsStageBatch(null);
    __setSlimsStageBBatch(null);
    const again = await start(plain, false);
    expect(await runToEnd(again.jobId)).toBe('succeeded');
    const { runId, jobId } = await start(mutated, true);
    // A migrated item is written with version 0; the sync's rewrite makes it 1.
    const rewritten = async (): Promise<number> =>
      Number((await h.db.selectFrom('items').select((eb) => eb.fn.countAll<number>().as('n')).where('version', '>', 0).executeTakeFirstOrThrow()).n);
    const counted = async (): Promise<number> => {
      const summary = JSON.parse((await h.db.selectFrom('catalog_runs').select('summary').where('id', '=', runId).executeTakeFirstOrThrow()).summary) as Partial<MigrationSummary>;
      return summary.tables?.['item']?.migrated ?? 0;
    };
    await killedChild(jobId, 'items', async () => (await rewritten()) > 0);
    // Killed with copies rewritten and not counted.
    expect(await rewritten()).toBeGreaterThan(0);
    expect(await counted()).toBe(0);
    await leaseRunsOut(jobId);
    __setSlimsStageBatch(STEP_BATCH);
    __setSlimsStageBBatch(STEP_BATCH);
    expect(await runToEnd(jobId, 2_000)).toBe('succeeded');
    const resumed = { snapshot: await snapshot(), summary: await summaryOf(runId) };
    for (const table of Object.keys(steady.snapshot)) expect(resumed.snapshot[table], table).toEqual(steady.snapshot[table]);
    expect(resumed.summary.tables).toEqual(steady.summary.tables);
    expect(resumed.summary.reconciliation).toEqual(steady.summary.reconciliation);
  }, 900_000);

  /**
   * Runs job `jobId` in a child process (slims-sync-child.mjs, the stepped batches) and SIGKILLs it as soon as `until()`
   * holds: the child waits before the save of each slice that ran a batch of `stage`.
   */
  async function killedChild(jobId: string, stage: string, until: () => Promise<boolean>): Promise<void> {
    const child = fork(
      path.join(import.meta.dirname, '../fixtures/slims-sync-child.mjs'),
      [JSON.stringify({ config: h.config, dbDataDir: h.dataDir, dataDir, jobId, now: NOW, batch: STEP_BATCH, pauseStage: stage, pauseMs: 10_000 })],
      { cwd: ROOT, env: process.env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    );
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', (m) => (m === 'ready' ? resolve() : reject(new Error(`unexpected ${String(m)}`))));
        child.once('exit', (code) => reject(new Error(`the child exited (${String(code)}) before it was ready`)));
      });
      child.send('go');
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline && child.exitCode === null) {
        if (await until()) {
          child.kill('SIGKILL');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
  }

  /** The dead child's lease and its `jobs:heavy` lock run out (moved back: the clock of the runs stands still). */
  async function leaseRunsOut(jobId: string): Promise<void> {
    const job = await h.db.selectFrom('jobs').select(['status', 'attempts']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('running');
    await h.db
      .updateTable('jobs')
      .set({ locked_until: NOW - retryDelayMs(Number(job.attempts)) - 1_000 })
      .where('id', '=', jobId)
      .execute();
    await h.db.updateTable('locks').set({ until: NOW - 1_000 }).where('name', '=', 'jobs:heavy').execute();
  }
});
