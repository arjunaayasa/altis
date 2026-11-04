import fsp from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import {
  EXPOSURE_FETCH_TIMEOUT_MS,
  EXPOSURE_MAX_BYTES,
  exposureCandidates,
  exposureJob,
  fetchBounded,
  type ExposureFetch,
  type ExposurePayload,
} from '../../src/diagnostics/exposure.js';
import type { JobContext, JobHandler, JobOutcome } from '../../src/jobs/types.js';
import { readSettings } from '../../src/settings/service.js';

// The daily exposure check (spec §11 "uji paparan DATA_DIR harian"; decision C21; preflight S26, M6) on the engine
// picked by ALTIS_TEST_DB: a probe file the job writes under DATA_DIR/tmp, app.js and altis-data-dir.txt are fetched
// through baseUrl at every suffix of their real paths below $HOME; a 200 with the file's bytes means the folder is
// served by the web server (`system.exposure = {ok: false, url}`, one `exposure_failed` notification); otherwise
// `ok: true`. Each slice fetches candidates only while its budget allows one more, and continues with the rest.

const ctx = testDbContext();
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 9, 27, 2, 47, 0);
const WINDOW = { windowStart: NOW - 86_400_000, windowEnd: NOW };

describe('exposureCandidates (decision C21)', () => {
  it('the probe file /home/u/altis-data/app/tmp/<id> with home /home/u → its four suffixes below home', () => {
    const id = newId();
    const all = exposureCandidates({ dataDir: '/home/u/altis-data/app', appRoot: '/home/u/app', home: '/home/u', probeId: id });
    expect(all.filter((c) => c.kind === 'probe').map((c) => c.path)).toEqual([
      `/${id}`,
      `/tmp/${id}`,
      `/app/tmp/${id}`,
      `/altis-data/app/tmp/${id}`,
    ]);
    expect(all.filter((c) => c.kind === 'app').map((c) => c.path)).toEqual(['/app.js', '/app/app.js']);
    expect(all.filter((c) => c.kind === 'pointer').map((c) => c.path)).toEqual(['/altis-data-dir.txt', '/app/altis-data-dir.txt']);
  });

  it('outside home: up to the file system root, at most 8 levels; Windows paths and names that need escaping', () => {
    const deep = exposureCandidates({ dataDir: '/a/b/c/d/e/f/g/h/i', appRoot: '/srv/app', home: '/home/u', probeId: 'p' });
    const probe = deep.filter((c) => c.kind === 'probe').map((c) => c.path);
    expect(probe).toHaveLength(8);
    expect(probe.at(-1)).toBe('/d/e/f/g/h/i/tmp/p');
    const win = exposureCandidates({ dataDir: 'C:\\Users\\Ani\\altis data', appRoot: 'C:\\Users\\Ani\\app', home: 'c:\\users\\ani', probeId: 'p' });
    expect(win.filter((c) => c.kind === 'probe').map((c) => c.path)).toEqual(['/p', '/tmp/p', '/altis%20data/tmp/p']);
  });
});

describe.skipIf(!ctx.available)(`the exposure job [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let home: string;
  let dataDir: string;
  let appRoot: string;
  let server: http.Server | undefined;

  /** A static web server whose document root is `docroot` (every other path 404), on 127.0.0.1. */
  async function serve(docroot: string | null): Promise<string> {
    server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const file = docroot === null ? null : path.join(docroot, decodeURIComponent(url.pathname));
        const body = file !== null && file.startsWith(docroot!) ? await fsp.readFile(file).catch(() => null) : null;
        if (body === null) {
          res.writeHead(404, { 'content-type': 'text/html' });
          res.end('<h1>Not Found</h1>');
        } else {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(body);
        }
      })();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  }

  /** A JobContext for one slice on `h` whose clock and budget are `clock` (default the real one, 20 s). */
  function sliceCtx(o: { clock?: () => number; budgetMs?: number; mode?: JobContext['mode'] } = {}): JobContext {
    const clock = o.clock ?? Date.now;
    const started = clock();
    const budget = o.budgetMs ?? 20_000;
    return {
      jobId: newId(),
      mode: o.mode ?? 'worker',
      heartbeat: async () => {},
      cancelled: () => false,
      markPointOfNoReturn: async () => {},
      secretParam: async () => null,
      audit: async () => {},
      session: async () => {
        throw new Error('no session in this test');
      },
      db: h.db,
      handle: h,
      log: silent,
      now: () => NOW + (clock() - started),
      budgetLeftMs: () => Math.max(0, budget - (clock() - started)),
    };
  }

  const exposure = async () => (await readSettings(h.db, ['system.exposure'], []))['system.exposure'];
  const notifications = () => h.db.selectFrom('notifications').select(['title_key', 'params', 'audience_permission', 'link']).execute();
  const tmpFiles = async () => (await fsp.readdir(path.join(dataDir, 'tmp')).catch(() => [] as string[])).filter((n) => !n.startsWith('.'));

  async function runAll(handler: JobHandler<ExposurePayload>, payload: ExposurePayload = WINDOW): Promise<JobOutcome<ExposurePayload>[]> {
    const outcomes: JobOutcome<ExposurePayload>[] = [];
    let p: ExposurePayload = payload;
    for (let i = 0; i < 20; i += 1) {
      const out = await handler.run(sliceCtx(), handler.payload.parse(p));
      outcomes.push(out);
      if (!('continueWith' in out)) return outcomes;
      p = out.continueWith;
    }
    throw new Error('the exposure job did not finish in 20 slices');
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-exposure-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    home = path.join(root, `home-${newId()}`, 'u');
    dataDir = path.join(home, 'altis-data', 'app');
    appRoot = path.join(home, 'app');
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    await fsp.mkdir(appRoot, { recursive: true });
    await fsp.writeFile(path.join(appRoot, 'app.js'), `/* app.js */\n${'x'.repeat(100_000)}\n`);
    await h.db.deleteFrom('notifications').execute();
    await h.db.deleteFrom('settings').where('key', '=', 'system.exposure').execute();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const s = server;
    server = undefined;
    if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it('a web server whose document root is $HOME serves the probe file → ok: false with its URL, one notification', async () => {
    const base = await serve(home);
    const job = exposureJob({ dataDir, appRoot, home, baseUrl: () => base });
    const outcomes = await runAll(job);
    expect(outcomes.at(-1)).toEqual({ done: true });
    const result = (await exposure()) as { at: number; ok: boolean; url: string | null };
    expect(result.ok).toBe(false);
    expect(result.url).toMatch(new RegExp(`^${base}/altis-data/app/tmp/[0-9A-HJKMNP-TV-Z]{26}$`));
    const sent = await notifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title_key: 'notification.exposure_failed.title',
      audience_permission: 'system.diagnostics.read',
      link: '/admin/diagnostics',
    });
    expect(JSON.parse(sent[0]!.params)).toEqual({ url: result.url });
    // The probe file is gone again.
    expect(await tmpFiles()).toEqual([]);
  });

  it('app.js served from the app folder (larger than 64 KiB) counts too: its first 64 KiB are compared', async () => {
    const base = await serve(path.dirname(appRoot)); // the docroot holds `app/`
    const job = exposureJob({ dataDir: path.join(root, 'elsewhere-data'), appRoot, home, baseUrl: () => base });
    await fsp.mkdir(path.join(root, 'elsewhere-data', 'tmp'), { recursive: true });
    await runAll(job);
    const result = (await exposure()) as { ok: boolean; url: string | null };
    expect(result).toMatchObject({ ok: false, url: `${base}/app/app.js` });
  });

  it('a server answering 404 everywhere → ok: true, no notification, the probe file removed', async () => {
    const base = await serve(null);
    const job = exposureJob({ dataDir, appRoot, home, baseUrl: () => base });
    await runAll(job);
    expect(await exposure()).toMatchObject({ ok: true, url: null });
    expect(await notifications()).toEqual([]);
    expect(await tmpFiles()).toEqual([]);
  });

  it('a 200 with other bytes (a soft 404 page) is not exposure', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Halaman tidak ada</h1>');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    await runAll(exposureJob({ dataDir, appRoot, home, baseUrl: () => base }));
    expect(await exposure()).toMatchObject({ ok: true, url: null });
  });

  it('no baseUrl (no config): nothing is fetched or recorded', async () => {
    const fetch = vi.fn<ExposureFetch>();
    const out = await exposureJob({ dataDir, appRoot, home, baseUrl: () => null, fetch }).run(sliceCtx(), WINDOW);
    expect(out).toEqual({ done: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(await exposure()).toBeNull();
  });

  it('S26: each fetch taking 5 s and a 20 s budget → at most 4 fetches per slice, then the rest in continueWith', async () => {
    let fake = 0;
    const fetch = vi.fn<ExposureFetch>(async () => {
      fake += EXPOSURE_FETCH_TIMEOUT_MS;
      return { status: 404, body: Buffer.alloc(0) };
    });
    const job = exposureJob({ dataDir, appRoot, home, baseUrl: () => 'https://perpus.example.test', fetch });
    const first = await job.run(sliceCtx({ clock: () => fake, budgetMs: 20_000 }), WINDOW);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect('continueWith' in first).toBe(true);
    const next = (first as { continueWith: ExposurePayload }).continueWith;
    expect(next).toMatchObject({ ...WINDOW, next: 4 });
    expect(job.payload.safeParse(next).success).toBe(true);
    expect(await tmpFiles()).toEqual([next.probeId]); // the probe file stays for the next slice
    expect(await exposure()).toBeNull(); // nothing recorded until the last candidate
    // The next slice goes on from candidate 4 with the same probe file: the 6 candidates (4 for the probe file below
    // home, 2 for app.js; there is no altis-data-dir.txt) are each fetched once, then `ok: true`.
    const second = await job.run(sliceCtx({ clock: () => fake, budgetMs: 20_000 }), next);
    expect(second).toEqual({ done: true });
    expect(fetch).toHaveBeenCalledTimes(6);
    const urls = fetch.mock.calls.map((call) => call[0]);
    expect(new Set(urls).size).toBe(6);
    expect(urls.filter((u) => u.endsWith(`/${next.probeId}`))).toHaveLength(4);
    expect(urls.every((u) => u.startsWith('https://perpus.example.test/'))).toBe(true);
    expect(await exposure()).toMatchObject({ ok: true });
    expect(await tmpFiles()).toEqual([]);
  });

  it('a piggyback slice (2 s budget, below one 5 s fetch) still fetches one candidate, bounded by its budget, so the job ends', async () => {
    let fake = 0;
    const timeouts: number[] = [];
    // Each fetch uses its whole timeout (no answer): the slice must not outlive its budget for it.
    const fetch = vi.fn<ExposureFetch>(async (_url, o) => {
      timeouts.push(o.timeoutMs);
      fake += o.timeoutMs;
      return { status: 0, body: Buffer.alloc(0) };
    });
    const job = exposureJob({ dataDir, appRoot, home, baseUrl: () => 'https://perpus.example.test', fetch });
    const first = await job.run(sliceCtx({ clock: () => fake, budgetMs: 2000, mode: 'piggyback' }), WINDOW);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect('continueWith' in first && first.continueWith).toMatchObject({ ...WINDOW, next: 1 });
    expect(timeouts[0]).toBeGreaterThanOrEqual(500);
    expect(timeouts[0]).toBeLessThan(2000);
    // Slice after slice, every one advances: the 6 candidates end the job with `ok: true` in 6 piggyback slices.
    let p = (first as { continueWith: ExposurePayload }).continueWith;
    for (let i = 0; i < 10; i += 1) {
      const out = await job.run(sliceCtx({ clock: () => fake, budgetMs: 2000, mode: 'piggyback' }), job.payload.parse(p));
      if (!('continueWith' in out)) break;
      p = out.continueWith;
    }
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(await exposure()).toMatchObject({ ok: true, url: null });
    // A worker slice keeps the full 5 s timeout per fetch.
    timeouts.length = 0;
    await job.run(sliceCtx({ clock: () => fake, budgetMs: 20_000 }), WINDOW);
    expect(timeouts.slice(0, 3)).toEqual([EXPOSURE_FETCH_TIMEOUT_MS, EXPOSURE_FETCH_TIMEOUT_MS, EXPOSURE_FETCH_TIMEOUT_MS]);
  });

  it('fetchBounded: 5 s timeout, at most 64 KiB read, no redirect followed, never throws', async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200);
        res.end(Buffer.alloc(EXPOSURE_MAX_BYTES * 3, 7));
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/big' });
        res.end();
      } else if (req.url === '/slow') {
        res.writeHead(200);
        res.write('x'); // and never ends
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const big = await fetchBounded(`${base}/big`);
    expect(big.status).toBe(200);
    expect(big.body.length).toBe(EXPOSURE_MAX_BYTES);
    expect((await fetchBounded(`${base}/redirect`)).status).toBe(302);
    const slow = await fetchBounded(`${base}/slow`, { timeoutMs: 200 });
    expect(slow.status).toBe(0);
    expect((await fetchBounded('ftp://example.test/x')).status).toBe(0);
    expect((await fetchBounded('http://127.0.0.1:1/x')).status).toBe(0);
  });
});
