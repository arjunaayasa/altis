import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __setSlimsSourceFactory,
  __setSlimsStages,
  createJobRegistry,
  requestCancel,
  slimsJobs,
  startSlimsMigration,
  txCtx,
  type CatalogJobDeps,
} from '@altis/core';
import { withTx, type DbHandle } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeCountingStage, fakeSlimsFactory, type FakeSlimsFactory } from '../../../../packages/core/test/fixtures/slims-fake.js';
import { runCli } from '../../src/cli/index.js';
import { loadConfig } from '../../src/config.js';
import { captureIo, openInstalled, writeInput, type CapturedIo } from '../cli-support.js';
import { bootContext } from '../support.js';

// `node app.js slims:import` (Phase 2 spec §11, §12.6; plan Task 23, preflight M15) on SQLite in a temp DATA_DIR
// installed once, with the source factory seam's fake source and a fake middle stage: the password never comes through
// the arguments, a dump is copied in and migrated to its end through the runner's claim path in this process, a
// migration a server queued is joined (one job row), and `--json` prints the run's summary.

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };

let root: string;
let dataDir: string;
let home: string;
let h: DbHandle;
let factory: FakeSlimsFactory;

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-import-')));
  dataDir = path.join(root, 'altis-data');
  home = path.join(root, 'home');
  await fsp.mkdir(home);
  const input = await writeInput(path.join(root, 'input'), {
    baseUrl: 'https://perpus.example.sch.id',
    db: { dialect: 'sqlite' },
    admin: ADMIN,
    library: { name: 'Perpustakaan Nusantara' },
  });
  const io = captureIo({ HOME: home }, { hostPanels: () => [] });
  const code = await runCli(['install', '--config', input], bootContext(dataDir), io);
  if (code !== 0) throw new Error(`install failed: ${io.err}`);
  h = await openInstalled(dataDir);
}, 60_000);

afterAll(async () => {
  __setSlimsSourceFactory(null);
  __setSlimsStages(null);
  await h?.close();
  if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  factory = fakeSlimsFactory();
  __setSlimsSourceFactory(factory);
  __setSlimsStages([fakeCountingStage('records', 'biblio')]);
  for (const table of ['jobs', 'locks', 'catalog_runs', 'migration_map'] as const) await h.db.deleteFrom(table).execute();
});

afterEach(() => {
  __setSlimsSourceFactory(null);
  __setSlimsStages(null);
});

async function slimsImport(argv: string[], o: { env?: Record<string, string>; secret?: string | null; answer?: string | null } = {}): Promise<{ code: number; io: CapturedIo }> {
  const io = captureIo({ HOME: home, ...o.env });
  io.promptSecret = async () => o.secret ?? null;
  io.prompt = async () => o.answer ?? null;
  const code = await runCli(['slims:import', ...argv], bootContext(dataDir), io);
  return { code, io };
}

describe('slims:import', () => {
  it('refuses --password: the password never comes through the arguments, and is not echoed', async () => {
    const { code, io } = await slimsImport(['--db', 'slims.internal:3306/slims', '--user', 'baca', '--password', 'Sandi-Q8x7'], { secret: 'x' });
    expect(code).toBe(1);
    expect(io.err).toContain('--password');
    expect(io.err).not.toContain('Sandi-Q8x7');
    expect(io.out).toBe('');
    expect(await h.db.selectFrom('catalog_runs').select('id').execute()).toEqual([]);
  });

  it('--db without ALTIS_SLIMS_DB_PASSWORD and without a terminal → exit 1, nothing started', async () => {
    const { code, io } = await slimsImport(['--db', 'slims.internal:3306/slims', '--user', 'baca', '--dry-run'], { secret: null });
    expect(code).toBe(1);
    expect(io.err).toContain('ALTIS_SLIMS_DB_PASSWORD');
    expect(await h.db.selectFrom('jobs').select('id').execute()).toEqual([]);
  });

  it('--db --dry-run --json with the password from ALTIS_SLIMS_DB_PASSWORD → the run to its end, the summary printed', async () => {
    const { code, io } = await slimsImport(['--db', 'slims.internal:3306/slims', '--user', 'baca', '--dry-run', '--json'], {
      env: { ALTIS_SLIMS_DB_PASSWORD: 'Rahasia-SLiMS-1' },
    });
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const out = JSON.parse(io.out) as { ok: boolean; command: string; runId: string; dryRun: boolean; status: string; joined: boolean; summary: { reconciliation: { ok: boolean } } };
    expect(out).toMatchObject({ ok: true, command: 'slims:import', dryRun: true, status: 'succeeded', joined: false });
    expect(out.summary.reconciliation.ok).toBe(true);
    expect(io.out).not.toContain('Rahasia');
    expect(factory.calls.passwords).toEqual(['Rahasia-SLiMS-1']);
    const run = await h.db.selectFrom('catalog_runs').select(['status', 'created_by', 'options']).where('id', '=', out.runId).executeTakeFirstOrThrow();
    expect([run.status, run.created_by]).toEqual(['succeeded', null]);
    expect(JSON.parse(run.options)).toMatchObject({ sourceKind: 'db', db: { host: 'slims.internal', port: 3306, user: 'baca', database: 'slims', tls: false } });
    const start = await h.db.selectFrom('audit_log').select(['actor_type', 'meta']).where('action', '=', 'catalog.migration.start').where('entity_id', '=', out.runId).execute();
    expect(start.map((e) => e.actor_type)).toEqual(['cli']);
  });

  it('--dump <file> with progress lines: the file is copied in, split and migrated; the operator\'s file stays', async () => {
    const dump = path.join(root, 'slims.sql');
    await fsp.writeFile(dump, '-- MySQL dump\nCREATE TABLE biblio (biblio_id int);\n');
    const { code, io } = await slimsImport(['--dump', dump, '--dry-run', '--price-mode', 'minor']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    // One progress line per slice (the job's message and progress after it); this small dump takes one slice.
    expect(io.out).toMatch(/^slims:import: succeeded 100%$/m);
    expect(io.out.trim().split('\n').at(-1)).toMatch(/^Migrasi SLiMS [0-9A-Z]{26}: succeeded/);
    expect(factory.calls.split).toBe(2);
    expect(await fsp.readFile(dump, 'utf8')).toContain('CREATE TABLE');
    const runs = await h.db.selectFrom('catalog_runs').select(['options', 'status']).execute();
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.options)).toMatchObject({ sourceKind: 'dump', priceMode: 'minor' });
  });

  it('M15: while a server-side migration is queued, slims:import joins it and drives it to its end (one job row)', async () => {
    const config = await loadConfig(dataDir, {});
    if (config === null) throw new Error('no config');
    const staff = (await h.db.selectFrom('staff_users').select('id').executeTakeFirstOrThrow()).id;
    const branchId = (await h.db.selectFrom('branches').select('id').executeTakeFirstOrThrow()).id;
    const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: config.baseUrl, keyring: config.keyring, storage: {} as never, log: { info() {}, warn() {}, error() {} } });
    const queued = await withTx(h, (trx) =>
      startSlimsMigration(
        txCtx(trx, Date.now(), { type: 'staff', id: staff, ip: null }),
        createJobRegistry(slimsJobs(deps)),
        {
          dryRun: true,
          sourceKind: 'db',
          db: { host: 'slims.internal', port: 3306, user: 'baca', database: 'slims', tls: false },
          password: 'Sandi-Server-2',
          dumpStagingId: null,
          files: null,
          filesStagingId: null,
          filesDir: null,
          branchId,
          priceMode: 'major',
          sourceName: 'slims',
          allowNonEmpty: false,
          confirmLibraryName: null,
          fromRunId: null,
        },
        { keyring: config.keyring },
      ),
    );
    const dump = path.join(root, 'lain.sql');
    await fsp.writeFile(dump, '-- another dump\n');
    const { code, io } = await slimsImport(['--dump', dump, '--dry-run', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ ok: true, runId: queued.runId, joined: true, status: 'succeeded' });
    expect(await h.db.selectFrom('jobs').select('id').execute()).toEqual([{ id: queued.jobId }]);
    expect(await h.db.selectFrom('catalog_runs').select('id').execute()).toEqual([{ id: queued.runId }]);
    // The joined run read the server's database with the server's password; nothing of the CLI's dump was kept.
    expect(factory.calls.passwords).toEqual(['Sandi-Server-2']);
    expect(factory.calls.split).toBe(0);
    const tmp = await fsp.readdir(path.join(dataDir, 'tmp')).catch(() => []);
    for (const name of tmp) await expect(fsp.stat(path.join(dataDir, 'tmp', name, 'upload.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('C16/C17: a server-side run whose job was cancelled while queued is ended by slims:import, and its work folder removed', async () => {
    const config = await loadConfig(dataDir, {});
    if (config === null) throw new Error('no config');
    const staff = (await h.db.selectFrom('staff_users').select('id').executeTakeFirstOrThrow()).id;
    const branchId = (await h.db.selectFrom('branches').select('id').executeTakeFirstOrThrow()).id;
    const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: config.baseUrl, keyring: config.keyring, storage: {} as never, log: { info() {}, warn() {}, error() {} } });
    const queued = await withTx(h, (trx) =>
      startSlimsMigration(
        txCtx(trx, Date.now(), { type: 'staff', id: staff, ip: null }),
        createJobRegistry(slimsJobs(deps)),
        {
          dryRun: true,
          sourceKind: 'dump',
          db: null,
          password: null,
          dumpStagingId: null,
          files: null,
          filesStagingId: null,
          filesDir: null,
          branchId,
          priceMode: 'major',
          sourceName: 'slims',
          allowNonEmpty: false,
          confirmLibraryName: null,
          fromRunId: null,
        },
        { keyring: config.keyring },
      ),
    );
    const work = path.join(dataDir, 'tmp', queued.runId);
    await fsp.mkdir(work, { recursive: true });
    await fsp.writeFile(path.join(work, 'dump.bin'), '-- the server-side upload\n');
    await fsp.writeFile(path.join(work, 'biblio.ndjson'), '{"biblio_id":1}\n');
    expect(await withTx(h, (trx) => requestCancel(trx, queued.jobId, Date.now()))).toBe('cancelled');
    const dump = path.join(root, 'baru.sql');
    await fsp.writeFile(dump, '-- MySQL dump\nCREATE TABLE biblio (biblio_id int);\n');
    const { code, io } = await slimsImport(['--dump', dump, '--dry-run', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ ok: true, joined: false, status: 'succeeded' });
    expect((await h.db.selectFrom('catalog_runs').select('status').where('id', '=', queued.runId).executeTakeFirstOrThrow()).status).toBe('cancelled');
    await expect(fsp.stat(work)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('--allow-non-empty asks for the library name: none typed → exit 1; a real run into a catalogue with records needs it', async () => {
    const dump = path.join(root, 'slims.sql');
    await fsp.writeFile(dump, '-- MySQL dump\n');
    const none = await slimsImport(['--dump', dump, '--allow-non-empty'], { answer: null });
    expect(none.code).toBe(1);
    expect(await h.db.selectFrom('catalog_runs').select('id').execute()).toEqual([]);
    const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    await h.db
      .insertInto('records')
      .values({
        id: newId(),
        material_type_id: buku,
        title: 'Hidup',
        subtitle: null,
        responsibility: null,
        title_key: 'hidup',
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: null,
        publication_date_text: null,
        physical_desc: null,
        series: null,
        classification: null,
        call_number: null,
        language_id: null,
        content_type: null,
        media_type: null,
        carrier_type: null,
        summary: null,
        notes: null,
        cover_file_id: null,
        source: 'manual',
        merged_into: null,
        changed_at: Date.now(),
        archived_at: null,
        created_at: Date.now(),
        created_by: null,
        updated_at: Date.now(),
        updated_by: null,
      })
      .execute();
    try {
      const refused = await slimsImport(['--dump', dump, '--json']);
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.io.out)).toMatchObject({ ok: false, code: 'MIGRATION_TARGET_NOT_EMPTY' });
      // The copy of the dump was removed again.
      for (const name of await fsp.readdir(path.join(dataDir, 'tmp')).catch(() => [])) {
        await expect(fsp.stat(path.join(dataDir, 'tmp', name, 'upload.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const confirmed = await slimsImport(['--dump', dump, '--allow-non-empty', '--json'], { answer: 'Perpustakaan Nusantara' });
      expect(confirmed.io.err).toBe('');
      expect(JSON.parse(confirmed.io.out)).toMatchObject({ ok: true, dryRun: false, status: 'succeeded' });
    } finally {
      await h.db.deleteFrom('records').execute();
    }
  });

  it('--files-dir must be a folder (its real path is what the job reads); --branch must name a branch', async () => {
    const dump = path.join(root, 'slims.sql');
    await fsp.writeFile(dump, '-- MySQL dump\n');
    const notDir = await slimsImport(['--dump', dump, '--dry-run', '--files-dir', path.join(root, 'tidak-ada')]);
    expect(notDir.code).toBe(1);
    expect(notDir.io.err).toContain('--files-dir');
    const branch = await slimsImport(['--dump', dump, '--dry-run', '--branch', 'TIDAK-ADA']);
    expect(branch.code).toBe(1);
    expect(branch.io.err).toContain('--branch');
    expect(await h.db.selectFrom('catalog_runs').select('id').execute()).toEqual([]);
    const folder = path.join(root, 'slims-root');
    await fsp.mkdir(folder, { recursive: true });
    await fsp.symlink(folder, path.join(root, 'tautan'));
    const ok = await slimsImport(['--dump', dump, '--dry-run', '--files-dir', path.join(root, 'tautan'), '--json']);
    expect(ok.io.err).toBe('');
    const run = await h.db.selectFrom('catalog_runs').select('options').where('id', '=', (JSON.parse(ok.io.out) as { runId: string }).runId).executeTakeFirstOrThrow();
    expect(JSON.parse(run.options)).toMatchObject({ files: 'dir', filesDir: folder });
    expect(factory.calls.files).toBe(1);
  });
});
