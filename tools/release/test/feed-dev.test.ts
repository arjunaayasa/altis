import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FEED_DEV_PORT, parseFeedDevArgs, startFeedDev, type FeedDev, type FeedDevOptions } from '../feed/serve.js';

// Task 17 (spec §12.6): feed-dev is a static server on 127.0.0.1 only, with Range (206) support and the test knobs the
// download tests of Tasks 20 and 24 need: throttling, ignoring Range (200) and dropping the connection mid-body.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SERVE_TS = path.join(REPO_ROOT, 'tools', 'release', 'feed', 'serve.ts');
const FEED_TEXT = '{"v":1,"channel":"stable","releases":[],"keyset":[]}';

let tmp: string;
let dir: string;
let pkg: Buffer;
const running: FeedDev[] = [];
const children: ChildProcess[] = [];

beforeAll(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-feed-dev-')));
  dir = path.join(tmp, 'feed');
  await fsp.mkdir(path.join(dir, 'stable'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'packages'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'stable', 'feed.json'), FEED_TEXT);
  pkg = randomBytes(5000);
  await fsp.writeFile(path.join(dir, 'packages', 'altis-0.2.0-test.zip'), pkg);
  await fsp.writeFile(path.join(dir, 'packages', '.hidden'), 'secret');
  await fsp.writeFile(path.join(tmp, 'outside.txt'), 'outside the served folder');
  await fsp.symlink(path.join(tmp, 'outside.txt'), path.join(dir, 'packages', 'link.txt'));
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const server of running.splice(0)) await server.close();
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function serve(o: Partial<FeedDevOptions> = {}): Promise<FeedDev> {
  const server = await startFeedDev({ dir, ...o });
  running.push(server);
  return server;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** The whole body arrived (false: the connection closed before Content-Length bytes). */
  complete: boolean;
  ms: number;
}

function request(url: string, o: { method?: string; headers?: Record<string, string>; path?: string } = {}): Promise<Reply> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      { host: target.hostname, port: target.port, path: o.path ?? target.pathname, method: o.method ?? 'GET', headers: o.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', () => {}); // a dropped connection: reported through `complete`
        res.on('close', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete, ms: Date.now() - started }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('startFeedDev', () => {
  it('serves the feed folder on 127.0.0.1: GET /stable/feed.json → 200 with the file, and logs every request', async () => {
    const dev = await serve();
    expect(dev.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const reply = await request(`${dev.url}/stable/feed.json`);
    expect(reply).toMatchObject({ status: 200, complete: true });
    expect(reply.body.toString('utf8')).toBe(FEED_TEXT);
    expect(reply.headers['content-type']).toBe('application/json');
    expect(reply.headers['content-length']).toBe(String(Buffer.byteLength(FEED_TEXT)));
    expect(reply.headers['accept-ranges']).toBe('bytes');
    expect(reply.headers['cache-control']).toBe('no-store');

    const zip = await request(`${dev.url}/packages/altis-0.2.0-test.zip`);
    expect(zip).toMatchObject({ status: 200, complete: true });
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.body.equals(pkg)).toBe(true);
    expect(dev.requests).toEqual([
      { path: '/stable/feed.json', range: null },
      { path: '/packages/altis-0.2.0-test.zip', range: null },
    ]);
  });

  it('answers Range: bytes=10- on a package with 206 and the rest of the file; suffix, bounded and unsatisfiable ranges', async () => {
    const dev = await serve();
    const url = `${dev.url}/packages/altis-0.2.0-test.zip`;
    const rest = await request(url, { headers: { Range: 'bytes=10-' } });
    expect(rest).toMatchObject({ status: 206, complete: true });
    expect(rest.headers['content-range']).toBe('bytes 10-4999/5000');
    expect(rest.headers['content-length']).toBe('4990');
    expect(rest.body.equals(pkg.subarray(10))).toBe(true);
    expect(dev.requests).toEqual([{ path: '/packages/altis-0.2.0-test.zip', range: 'bytes=10-' }]);

    const bounded = await request(url, { headers: { Range: 'bytes=100-199' } });
    expect(bounded.status).toBe(206);
    expect(bounded.body.equals(pkg.subarray(100, 200))).toBe(true);
    const past = await request(url, { headers: { Range: 'bytes=4990-9999' } });
    expect(past.headers['content-range']).toBe('bytes 4990-4999/5000');
    expect(past.body.equals(pkg.subarray(4990))).toBe(true);
    const suffix = await request(url, { headers: { Range: 'bytes=-20' } });
    expect(suffix.headers['content-range']).toBe('bytes 4980-4999/5000');
    expect(suffix.body.equals(pkg.subarray(4980))).toBe(true);

    const unsatisfiable = await request(url, { headers: { Range: 'bytes=5000-' } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers['content-range']).toBe('bytes */5000');
    // A range this server does not take (several ranges, another unit, garbage) is ignored: the whole file, 200.
    for (const range of ['bytes=0-1,5-6', 'items=0-1', 'bytes=9-3', 'bytes=x-']) {
      const whole = await request(url, { headers: { Range: range } });
      expect(whole.status, range).toBe(200);
      expect(whole.body.equals(pkg), range).toBe(true);
    }
    // HEAD: the headers of the GET, no body.
    const head = await request(url, { method: 'HEAD', headers: { Range: 'bytes=10-' } });
    expect(head).toMatchObject({ status: 206 });
    expect(head.headers['content-length']).toBe('4990');
    expect(head.body.length).toBe(0);
  });

  it('ignoreRange: the whole file with 200, Range or not', async () => {
    const dev = await serve({ ignoreRange: true });
    const reply = await request(`${dev.url}/packages/altis-0.2.0-test.zip`, { headers: { Range: 'bytes=10-' } });
    expect(reply).toMatchObject({ status: 200, complete: true });
    expect(reply.headers['content-range']).toBeUndefined();
    expect(reply.headers['accept-ranges']).toBe('none');
    expect(reply.body.equals(pkg)).toBe(true);
    expect(dev.requests).toEqual([{ path: '/packages/altis-0.2.0-test.zip', range: 'bytes=10-' }]);
  });

  it('dropAfterBytes: 1000 → the connection closes after exactly 1000 body bytes, whole requests or ranges', async () => {
    const dev = await serve({ dropAfterBytes: 1000 });
    const url = `${dev.url}/packages/altis-0.2.0-test.zip`;
    const reply = await request(url);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-length']).toBe('5000');
    expect(reply.complete).toBe(false);
    expect(reply.body.length).toBe(1000);
    expect(reply.body.equals(pkg.subarray(0, 1000))).toBe(true);

    // A resumed download is cut the same way: from its own first byte.
    const resumed = await request(url, { headers: { Range: 'bytes=1000-' } });
    expect(resumed.status).toBe(206);
    expect(resumed.complete).toBe(false);
    expect(resumed.body.equals(pkg.subarray(1000, 2000))).toBe(true);

    // A body shorter than the limit is sent whole.
    const feed = await request(`${dev.url}/stable/feed.json`);
    expect(feed).toMatchObject({ status: 200, complete: true });
  });

  it('throttleBytesPerSec: the body takes at least size / rate seconds, and arrives whole', async () => {
    const dev = await serve({ throttleBytesPerSec: 10_000 });
    const reply = await request(`${dev.url}/packages/altis-0.2.0-test.zip`);
    expect(reply).toMatchObject({ status: 200, complete: true });
    expect(reply.body.equals(pkg)).toBe(true);
    expect(reply.ms).toBeGreaterThanOrEqual(450); // 5000 bytes at 10 000 bytes/s: 500 ms
    const fast = await serve();
    expect((await request(`${fast.url}/packages/altis-0.2.0-test.zip`)).ms).toBeLessThan(450);
  });

  it('serves nothing outside the folder: traversal, hidden files, symbolic links, folders → 404; other methods → 405', async () => {
    const dev = await serve();
    for (const p of [
      '/missing.json',
      '/stable',
      '/stable/',
      '/../outside.txt',
      '/%2e%2e/outside.txt',
      '/packages/%2e%2e/%2e%2e/outside.txt',
      '/packages/..%2f..%2foutside.txt',
      '/packages/.hidden',
      '/packages/link.txt',
      '/packages/altis-0.2.0-test.zip%00',
      '/packages\\altis-0.2.0-test.zip',
      '//etc/passwd',
    ]) {
      const reply = await request(dev.url, { path: p });
      expect(reply.status, p).toBe(404);
      expect(reply.body.toString('utf8'), p).not.toContain('outside');
    }
    const post = await request(`${dev.url}/stable/feed.json`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers['allow']).toBe('GET, HEAD');
    // The query string is not part of the path.
    expect((await request(dev.url, { path: '/stable/feed.json?seq=3' })).status).toBe(200);
    expect(dev.requests.at(-1)).toEqual({ path: '/stable/feed.json', range: null });
  });

  it('refuses to bind any address other than 127.0.0.1, and checks its options', async () => {
    for (const host of ['0.0.0.0', '::', '::1', 'localhost', '192.168.1.10', '']) {
      await expect(startFeedDev({ dir, host: host as '127.0.0.1' }), host).rejects.toThrow(/^FEED_DEV_HOST:/);
    }
    await expect(startFeedDev({ dir: path.join(tmp, 'missing') })).rejects.toThrow(/^FEED_DEV_DIR:/);
    await expect(startFeedDev({ dir: path.join(dir, 'stable', 'feed.json') })).rejects.toThrow(/^FEED_DEV_DIR:/);
    await expect(startFeedDev({ dir, port: 70_000 })).rejects.toThrow(/^FEED_DEV_PORT:/);
    await expect(startFeedDev({ dir, throttleBytesPerSec: 0 })).rejects.toThrow(/^FEED_DEV_THROTTLE:/);
    await expect(startFeedDev({ dir, dropAfterBytes: -1 })).rejects.toThrow(/^FEED_DEV_DROP:/);
    const explicit = await serve({ host: '127.0.0.1' });
    expect(explicit.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('close() stops the server and ends open connections', async () => {
    const dev = await startFeedDev({ dir, throttleBytesPerSec: 1000 });
    const pending = request(`${dev.url}/packages/altis-0.2.0-test.zip`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await dev.close();
    const reply = await pending;
    expect(reply.complete).toBe(false);
    await expect(request(`${dev.url}/stable/feed.json`)).rejects.toThrow(/ECONNREFUSED/);
    await dev.close(); // twice is fine
  });
});

describe('pnpm feed-dev', () => {
  it('parses --dir (from INIT_CWD), --port (default FEED_DEV_PORT) and the test knobs', () => {
    expect(parseFeedDevArgs(['--dir', 'feed'], { INIT_CWD: '/work' }, '/elsewhere')).toEqual({ dir: '/work/feed', port: FEED_DEV_PORT });
    expect(
      parseFeedDevArgs(['--', '--dir', '/abs', '--port', '0', '--host', '127.0.0.1', '--throttle', '1000', '--ignore-range', '--drop-after', '10'], {}, '/'),
    ).toEqual({ dir: '/abs', port: 0, host: '127.0.0.1', throttleBytesPerSec: 1000, ignoreRange: true, dropAfterBytes: 10 });
    expect(() => parseFeedDevArgs([], {}, '/')).toThrow(/^USAGE:.*--dir/);
    expect(() => parseFeedDevArgs(['--dir', 'x', '--port', 'http'], {}, '/')).toThrow(/^USAGE:.*--port/);
    expect(() => parseFeedDevArgs(['--dir', 'x', '--bogus'], {}, '/')).toThrow(/^USAGE:/);
  });

  it.skipIf(process.platform === 'win32')('runs from the command line, prints its URL, serves, and exits 0 on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', SERVE_TS, '--dir', dir, '--port', '0'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    let match: RegExpExecArray | null = null;
    while (match === null && Date.now() < deadline) {
      match = /feed-dev: serving .* at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match === null) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(match, stderr).not.toBeNull();
    const url = match![1]!;
    const reply = await request(`${url}/stable/feed.json`, { headers: { Range: 'bytes=2-' } });
    expect(reply.status).toBe(206);
    expect(reply.body.toString('utf8')).toBe(FEED_TEXT.slice(2));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(stdout).toContain('GET /stable/feed.json 206 range=bytes=2-');
  }, 30_000);
});
