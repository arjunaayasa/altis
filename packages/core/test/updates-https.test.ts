import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FETCH_MAX_REDIRECTS, fetchRange, fetchText, redirectTarget, updateUrl } from '../src/updates/https.js';

// The feed client's outbound requests (spec §9.6, P18; plan Task 20): node:https only (plain http only to 127.0.0.1,
// ::1 and localhost, and only under the test profile when the caller allows it), a timeout and a size limit, at most
// 3 redirects and never from https to anything else. Feed files fail with FEED_UNREACHABLE, package bytes with
// UPDATE_DOWNLOAD_FAILED, each with its reason (network, status, timeout, too_large, insecure).

// feed-dev (tools/release/feed/serve.ts, Task 17) is loaded at run time: packages/core's TypeScript project cannot
// reference tools/release, which references apps/server (through the bootloader), which references packages/core.
interface FeedDev {
  url: string;
  requests: { path: string; range: string | null }[];
  close(): Promise<void>;
}
type StartFeedDev = (o: { dir: string; throttleBytesPerSec?: number; ignoreRange?: boolean; dropAfterBytes?: number }) => Promise<FeedDev>;
const FEED_DEV_MODULE = path.resolve(import.meta.dirname, '..', '..', '..', 'tools', 'release', 'feed', 'serve.ts');

let startFeedDev: StartFeedDev;
let tmp: string;
let dir: string;
let pkg: Buffer;
const PKG_PATH = '/packages/altis-0.2.0-test.zip';
const servers: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  ({ startFeedDev } = (await import(FEED_DEV_MODULE)) as { startFeedDev: StartFeedDev });
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-updates-https-')));
  dir = path.join(tmp, 'feed');
  await fsp.mkdir(path.join(dir, 'packages'), { recursive: true });
  pkg = randomBytes(256 * 1024);
  await fsp.writeFile(path.join(dir, 'packages', 'altis-0.2.0-test.zip'), pkg);
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function feedDev(o: { throttleBytesPerSec?: number; ignoreRange?: boolean; dropAfterBytes?: number } = {}): Promise<FeedDev> {
  const server = await startFeedDev({ dir, ...o });
  servers.push(server);
  return server;
}

/** A local http server answering every request with `handler`; its base URL. */
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A port nothing listens on (taken, then released). */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; reason: unknown; meta: Record<string, unknown> | undefined }> {
  try {
    await promise;
  } catch (error) {
    if (!isDomainError(error)) throw error;
    return { code: error.code, reason: error.meta?.['reason'], meta: error.meta };
  }
  throw new Error('expected a DomainError, the call resolved');
}

const loopback = { allowLoopbackHttp: true } as const;

describe('updateUrl and redirectTarget (P18: https, plain http only to loopback under the test profile)', () => {
  it('takes https URLs, and http only to 127.0.0.1, ::1 or localhost when the caller allows it', () => {
    expect(updateUrl('https://feed.example.com/altis', false)?.href).toBe('https://feed.example.com/altis');
    expect(updateUrl('http://127.0.0.1:8790/stable/feed.json', true)?.host).toBe('127.0.0.1:8790');
    expect(updateUrl('http://[::1]:8790/x', true)?.hostname).toBe('[::1]');
    expect(updateUrl('http://localhost/x', true)?.hostname).toBe('localhost');
    expect(updateUrl('http://127.0.0.1:8790/x', false)).toBeNull();
    expect(updateUrl('http://example.com/feed', true)).toBeNull();
    expect(updateUrl('http://10.0.0.1/feed', true)).toBeNull();
    expect(updateUrl('ftp://127.0.0.1/feed', true)).toBeNull();
    expect(updateUrl('file:///etc/passwd', true)).toBeNull();
    expect(updateUrl('https://user:secret@feed.example.com/', false)).toBeNull();
    expect(updateUrl('not a url', true)).toBeNull();
  });

  it('follows https to https only; a relative Location resolves against the current URL', () => {
    const from = new URL('https://feed.example.com/altis/stable/feed.json');
    expect(redirectTarget(from, 'https://mirror.example.net/f.json', false)?.href).toBe('https://mirror.example.net/f.json');
    expect(redirectTarget(from, '../beta/feed.json', false)?.href).toBe('https://feed.example.com/altis/beta/feed.json');
    expect(redirectTarget(from, 'http://feed.example.com/x', true)).toBeNull();
    expect(redirectTarget(from, 'http://127.0.0.1:8790/x', true)).toBeNull(); // never down from https, loopback or not
    expect(redirectTarget(new URL('http://127.0.0.1:1/a'), 'https://feed.example.com/b', true)?.protocol).toBe('https:');
    expect(redirectTarget(new URL('http://127.0.0.1:1/a'), 'http://example.com/b', true)).toBeNull();
  });
});

describe('fetchText (feed files: FEED_UNREACHABLE)', () => {
  it('http://example.com/feed → FEED_UNREACHABLE reason insecure, with nothing sent', async () => {
    expect(await failure(fetchText('http://example.com/feed', loopback))).toMatchObject({ code: 'FEED_UNREACHABLE', reason: 'insecure' });
    expect(await failure(fetchText('ftp://127.0.0.1/feed', loopback))).toMatchObject({ reason: 'insecure' });
    expect(await failure(fetchText('no url at all', loopback))).toMatchObject({ reason: 'insecure' });
    // Loopback http without the caller's leave is refused before any connection is made.
    const base = await serve((_req, res) => res.end('x'));
    expect(await failure(fetchText(`${base}/feed.json`, { allowLoopbackHttp: false }))).toMatchObject({ reason: 'insecure' });
  });

  it('returns the body of a 200 as UTF-8 text, byte for byte', async () => {
    const text = '{"catatan":"Perpustakaan — ✓"}';
    const base = await serve((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(text));
    expect(await fetchText(`${base}/stable/feed.json`, loopback)).toBe(text);
  });

  it('any status other than 200 → reason status, with the status in meta', async () => {
    const base = await serve((_req, res) => res.writeHead(404).end('not found'));
    expect(await failure(fetchText(`${base}/stable/feed.json`, loopback))).toMatchObject({
      code: 'FEED_UNREACHABLE',
      reason: 'status',
      meta: { status: 404 },
    });
  });

  it('a body larger than maxBytes → reason too_large, whether announced or streamed', async () => {
    const big = Buffer.alloc(5000, 0x61);
    const announced = await serve((_req, res) => res.writeHead(200, { 'Content-Length': String(big.length) }).end(big));
    expect(await failure(fetchText(`${announced}/f`, { ...loopback, maxBytes: 4096 }))).toMatchObject({ reason: 'too_large' });
    const streamed = await serve((_req, res) => {
      res.writeHead(200); // chunked: no Content-Length
      res.write(big.subarray(0, 3000));
      res.end(big.subarray(3000));
    });
    expect(await failure(fetchText(`${streamed}/f`, { ...loopback, maxBytes: 4096 }))).toMatchObject({ reason: 'too_large' });
    expect(await fetchText(`${streamed}/f`, { ...loopback, maxBytes: 5000 })).toBe(big.toString('utf8'));
  });

  it('no answer within timeoutMs → reason timeout', async () => {
    const base = await serve(() => {}); // accepts the request, never answers
    const started = performance.now();
    expect(await failure(fetchText(`${base}/f`, { ...loopback, timeoutMs: 200 }))).toMatchObject({ reason: 'timeout' });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('a connection refused, or a body cut short, → reason network', async () => {
    expect(await failure(fetchText(`http://127.0.0.1:${await closedPort()}/f`, loopback))).toMatchObject({ reason: 'network' });
    const cut = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('only part of it', () => res.destroy());
    });
    expect(await failure(fetchText(`${cut}/f`, loopback))).toMatchObject({ reason: 'network' });
  });

  it(`follows at most ${FETCH_MAX_REDIRECTS} redirects; one more → reason status; a redirect to plain http elsewhere → insecure`, async () => {
    expect(FETCH_MAX_REDIRECTS).toBe(3);
    const base = await serve((req, res) => {
      const m = /^\/hop\/(\d+)$/.exec(req.url ?? '');
      if (m === null) {
        res.writeHead(404).end();
        return;
      }
      const left = Number(m[1]);
      if (left === 0) res.writeHead(200).end('arrived');
      else res.writeHead(left % 2 === 0 ? 302 : 307, { Location: `/hop/${left - 1}` }).end();
    });
    expect(await fetchText(`${base}/hop/3`, loopback)).toBe('arrived');
    expect(await failure(fetchText(`${base}/hop/4`, loopback))).toMatchObject({ reason: 'status' });
    const away = await serve((_req, res) => res.writeHead(301, { Location: 'http://example.com/feed.json' }).end());
    expect(await failure(fetchText(`${away}/f`, loopback))).toMatchObject({ reason: 'insecure' });
    const nowhere = await serve((_req, res) => res.writeHead(302).end()); // no Location
    expect(await failure(fetchText(`${nowhere}/f`, loopback))).toMatchObject({ reason: 'status' });
  });
});

describe('fetchRange (package bytes: UPDATE_DOWNLOAD_FAILED)', () => {
  type Seen = { responses: { status: number; total: number | null }[]; bytes: Buffer };

  function collector(): { seen: Seen; onResponse(r: { status: 200 | 206; total: number | null }): Promise<void>; onChunk(b: Uint8Array): Promise<void> } {
    const seen: Seen = { responses: [], bytes: Buffer.alloc(0) };
    return {
      seen,
      async onResponse(r) {
        seen.responses.push(r);
      },
      async onChunk(b) {
        seen.bytes = Buffer.concat([seen.bytes, b]);
      },
    };
  }

  const far = (): number => Date.now() + 30_000;

  it('start 0: no Range header, 200 with the whole file, total and ended', async () => {
    const dev = await feedDev();
    const c = collector();
    const r = await fetchRange(`${dev.url}${PKG_PATH}`, { start: 0, deadline: far(), ...loopback, onResponse: c.onResponse, onChunk: c.onChunk });
    expect(r).toEqual({ status: 200, total: pkg.length, ended: true });
    expect(c.seen.responses).toEqual([{ status: 200, total: pkg.length }]);
    expect(c.seen.bytes.equals(pkg)).toBe(true);
    expect(dev.requests).toEqual([{ path: PKG_PATH, range: null }]);
  });

  it('start n: Range: bytes=n-, 206 with the rest, total = the whole file', async () => {
    const dev = await feedDev();
    const c = collector();
    const r = await fetchRange(`${dev.url}${PKG_PATH}`, { start: 1000, deadline: far(), ...loopback, onChunk: c.onChunk, onResponse: c.onResponse });
    expect(r).toEqual({ status: 206, total: pkg.length, ended: true });
    expect(c.seen.bytes.equals(pkg.subarray(1000))).toBe(true);
    expect(dev.requests).toEqual([{ path: PKG_PATH, range: 'bytes=1000-' }]);
  });

  it('a server that ignores Range answers 200: onResponse says so before the first byte', async () => {
    const dev = await feedDev({ ignoreRange: true });
    const order: string[] = [];
    const r = await fetchRange(`${dev.url}${PKG_PATH}`, {
      start: 1000,
      deadline: far(),
      ...loopback,
      async onResponse(x) {
        order.push(`response ${x.status}`);
      },
      async onChunk() {
        if (order[order.length - 1] !== 'chunk') order.push('chunk');
      },
    });
    expect(r).toEqual({ status: 200, total: pkg.length, ended: true });
    expect(order).toEqual(['response 200', 'chunk']);
    expect(dev.requests).toEqual([{ path: PKG_PATH, range: 'bytes=1000-' }]);
  });

  it('stops at the deadline with ended: false, after the bytes it was given', async () => {
    const dev = await feedDev({ throttleBytesPerSec: 128 * 1024 });
    const c = collector();
    const started = performance.now();
    const r = await fetchRange(`${dev.url}${PKG_PATH}`, { start: 0, deadline: Date.now() + 400, ...loopback, onChunk: c.onChunk });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(r).toEqual({ status: 200, total: pkg.length, ended: false });
    expect(c.seen.bytes.length).toBeGreaterThan(0);
    expect(c.seen.bytes.length).toBeLessThan(pkg.length);
    expect(c.seen.bytes.equals(pkg.subarray(0, c.seen.bytes.length))).toBe(true);
  });

  it('a connection dropped mid-body → reason network, after the bytes that came', async () => {
    const dev = await feedDev({ dropAfterBytes: 100_000 });
    const c = collector();
    expect(await failure(fetchRange(`${dev.url}${PKG_PATH}`, { start: 0, deadline: far(), ...loopback, onChunk: c.onChunk }))).toMatchObject({
      code: 'UPDATE_DOWNLOAD_FAILED',
      reason: 'network',
    });
    expect(c.seen.bytes.length).toBeLessThanOrEqual(100_000);
    expect(c.seen.bytes.equals(pkg.subarray(0, c.seen.bytes.length))).toBe(true);
  });

  it('404, and a range past the end (416), → reason status; an insecure URL → reason insecure', async () => {
    const dev = await feedDev();
    const onChunk = async (): Promise<void> => {};
    expect(await failure(fetchRange(`${dev.url}/packages/missing.zip`, { start: 0, deadline: far(), ...loopback, onChunk }))).toMatchObject({
      code: 'UPDATE_DOWNLOAD_FAILED',
      reason: 'status',
      meta: { status: 404 },
    });
    expect(await failure(fetchRange(`${dev.url}${PKG_PATH}`, { start: pkg.length, deadline: far(), ...loopback, onChunk }))).toMatchObject({
      reason: 'status',
      meta: { status: 416 },
    });
    expect(await failure(fetchRange('http://example.com/altis.zip', { start: 0, deadline: far(), ...loopback, onChunk }))).toMatchObject({
      code: 'UPDATE_DOWNLOAD_FAILED',
      reason: 'insecure',
    });
  });

  it('a 206 for another range than asked → reason status', async () => {
    const base = await serve((_req, res) => res.writeHead(206, { 'Content-Range': 'bytes 0-9/100', 'Content-Length': '10' }).end('0123456789'));
    expect(await failure(fetchRange(`${base}/p.zip`, { start: 50, deadline: far(), ...loopback, onChunk: async () => {} }))).toMatchObject({
      reason: 'status',
      meta: { status: 206 },
    });
  });

  it('an error thrown by onChunk or onResponse ends the transfer and is thrown as it is', async () => {
    const dev = await feedDev();
    const mine = new Error('stop here');
    await expect(
      fetchRange(`${dev.url}${PKG_PATH}`, {
        start: 0,
        deadline: far(),
        ...loopback,
        onChunk: async () => {
          throw mine;
        },
      }),
    ).rejects.toBe(mine);
    await expect(
      fetchRange(`${dev.url}${PKG_PATH}`, {
        start: 0,
        deadline: far(),
        ...loopback,
        onResponse: async () => {
          throw mine;
        },
        onChunk: async () => {},
      }),
    ).rejects.toBe(mine);
  });

  it('a deadline already past → reason timeout, with nothing sent', async () => {
    const dev = await feedDev();
    expect(await failure(fetchRange(`${dev.url}${PKG_PATH}`, { start: 0, deadline: Date.now() - 1, ...loopback, onChunk: async () => {} }))).toMatchObject({
      reason: 'timeout',
    });
    expect(dev.requests).toEqual([]);
  });
});
