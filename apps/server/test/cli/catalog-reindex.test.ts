import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SLICE_BUDGET_MS, claimById, createJobRegistry, enqueueReindex, runSlice, searchHealth } from '@altis/core';
import { fullTextClear, fullTextFamily, withTx, type DbHandle } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { jobHandlers } from '../../src/jobs/runtime.js';
import { captureIo, openInstalled, writeInput } from '../cli-support.js';
import { bootContext } from '../support.js';

// `node app.js catalog:reindex [--json]` (Phase 2 spec §12.6, §4.8; plan Task 15, M15) on SQLite in a temp DATA_DIR
// installed once: the command enqueues `catalog.reindex {scope: 'all'}` with its unique key `catalog.reindex:all`
// (joining one already queued, one job row) and drives it through the runner's claim path in this process (so its
// slices hold `jobs:heavy`), waiting while another process runs a slice of it; progress lines without `--json`, `{ok,
// command, docs}` with it; refused under maintenance and before the install; a job that ends otherwise is a failure.

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
const silent = { info() {}, warn() {}, error() {} };

let root: string;
let dataDir: string;
let home: string;
let h: DbHandle;
const registry = createJobRegistry(jobHandlers());

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-catalog-reindex-')));
  dataDir = path.join(root, 'altis-data');
  home = path.join(root, 'home');
  await fsp.mkdir(home);
  const input = await writeInput(path.join(root, 'input'), { baseUrl: 'https://perpus.example.sch.id', db: { dialect: 'sqlite' }, admin: ADMIN });
  const io = captureIo({ HOME: home }, { hostPanels: () => [] });
  const code = await runCli(['install', '--config', input], bootContext(dataDir), io);
  if (code !== 0) throw new Error(`install failed: ${io.err}`);
  h = await openInstalled(dataDir);

  // Three live records and an archived one, none indexed yet.
  const now = Date.now();
  const buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  const row = (i: number) => ({
    id: newId(now),
    material_type_id: buku,
    title: `Babad Tanah ${i}`,
    subtitle: null,
    responsibility: null,
    title_key: `babad tanah ${i}`,
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
    changed_at: now,
    archived_at: i === 3 ? now : null,
    version: 0,
    created_at: now,
    created_by: null,
    updated_at: now,
    updated_by: null,
  });
  await h.db.insertInto('records').values([0, 1, 2, 3].map(row)).execute();
}, 60_000);

afterAll(async () => {
  await h?.close();
  if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await withTx(h, async (trx) => {
    await fullTextClear(trx, fullTextFamily(trx));
    for (const table of ['search_facet', 'search_doc', 'search_term', 'search_state', 'jobs', 'locks'] as const) await trx.deleteFrom(table).execute();
  });
  await fsp.rm(path.join(dataDir, 'ops'), { recursive: true, force: true });
});

async function cli(argv: string[], dir = dataDir) {
  const io = captureIo({ HOME: home });
  const code = await runCli(argv, bootContext(dir), io);
  return { code, io };
}

const reindexJobs = () => h.db.selectFrom('jobs').select(['id', 'status', 'unique_key', 'created_by']).where('type', '=', 'catalog.reindex').execute();
const queue = () => withTx(h, (trx) => enqueueReindex(trx, registry, { scope: 'all' }, { now: Date.now(), keyring: [], createdBy: null })).then((r) => r.jobId);
const heavyLock = () => h.db.selectFrom('locks').select('owner').where('name', '=', 'jobs:heavy').executeTakeFirst();

describe('catalog:reindex', () => {
  it('M15: with a rebuild already queued, joins it (one job row) and drives it to its end; --json → {ok, command, docs}', async () => {
    const jobId = await queue();
    const { code, io } = await cli(['catalog:reindex', '--json']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toEqual({ ok: true, command: 'catalog:reindex', docs: 4 });
    expect(await reindexJobs()).toEqual([{ id: jobId, status: 'succeeded', unique_key: null, created_by: null }]);
    expect(await searchHealth(h.db)).toMatchObject({ status: 'ready', docs: 3, records: 3, jobId: null });
    expect(await heavyLock()).toBeUndefined();
  });

  it('nothing queued: queues the rebuild itself (by the system); without --json, progress lines, then the human line', async () => {
    const { code, io } = await cli(['catalog:reindex']);
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const lines = io.out.trimEnd().split('\n');
    expect(lines.at(-2)).toBe('catalog:reindex: 100% / 100%');
    expect(lines.slice(0, -1).every((l) => /^catalog:reindex: \d{1,3}% \/ \d{1,3}%$/.test(l))).toBe(true);
    expect(lines.at(-1)).toBe('catalog:reindex: indeks pencarian dibangun ulang, 4 dokumen / search index rebuilt, 4 documents');
    expect(await reindexJobs()).toEqual([{ id: expect.any(String), status: 'succeeded', unique_key: null, created_by: null }]);
  });

  it('a rebuild another process is running is waited for, never run beside it', async () => {
    const jobId = await queue();
    // Another process (a server's runner) claimed it: it holds the lease and jobs:heavy.
    const job = await claimById(h, registry, jobId, { worker: 'server', now: Date.now() });
    expect(job).not.toBeNull();
    const pending = cli(['catalog:reindex']);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await reindexJobs())[0]?.status).toBe('running');
    // That process finishes it; the command then reports it, having run no slice of its own (no progress line).
    const done = await runSlice(h, registry, job!, { mode: 'worker', budgetMs: SLICE_BUDGET_MS, keyring: [], log: silent, clock: Date.now, env: {} });
    expect(done.outcome).toBe('succeeded');
    const { code, io } = await pending;
    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(io.out).toBe('catalog:reindex: indeks pencarian dibangun ulang, 4 dokumen / search index rebuilt, 4 documents\n');
    expect((await reindexJobs()).map((j) => j.id)).toEqual([jobId]);
  });

  it('a job that does not succeed → exit 1, REINDEX_FAILED with its status and code', async () => {
    const jobId = await queue();
    // A payload no handler accepts: the slice fails the job for good.
    await h.db.updateTable('jobs').set({ payload: '{"scope":"none"}' }).where('id', '=', jobId).execute();
    const { code, io } = await cli(['catalog:reindex', '--json']);
    expect(code).toBe(1);
    const out = JSON.parse(io.out) as { ok: boolean; command: string; code: string; detail: string };
    expect(out).toMatchObject({ ok: false, command: 'catalog:reindex', code: 'REINDEX_FAILED' });
    const row = await h.db.selectFrom('jobs').select(['status']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(out.detail).toContain(`(tugas ${row.status}`);
    expect(row.status).not.toBe('succeeded');
  });

  it('under maintenance (maintenance:on) → exit 1, MAINTENANCE, nothing queued', async () => {
    expect((await cli(['maintenance:on', '--json'])).code).toBe(0);
    try {
      const { code, io } = await cli(['catalog:reindex', '--json']);
      expect(code).toBe(1);
      expect(JSON.parse(io.out)).toMatchObject({ ok: false, command: 'catalog:reindex', code: 'MAINTENANCE' });
      expect(await reindexJobs()).toEqual([]);
    } finally {
      expect((await cli(['maintenance:off', '--json'])).code).toBe(0);
    }
  });

  it('before the install: exit 1, NOT_INSTALLED', async () => {
    const fresh = path.join(root, 'fresh-data');
    await fsp.mkdir(fresh, { recursive: true });
    const { code, io } = await cli(['catalog:reindex', '--json'], fresh);
    expect(code).toBe(1);
    expect(JSON.parse(io.out)).toMatchObject({ ok: false, command: 'catalog:reindex', code: 'NOT_INSTALLED' });
  });
});
