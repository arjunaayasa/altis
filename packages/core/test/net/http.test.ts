import net from 'node:net';
import { dirname, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { isDomainError } from '@altis/shared';
import { ESLint } from 'eslint';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import {
  OUTBOUND_CONNECT_MS,
  OUTBOUND_MAX_BYTES,
  OUTBOUND_MAX_REDIRECTS,
  OUTBOUND_TOTAL_MS,
  httpRequest,
  type OutboundRequest,
} from '../../src/net/index.js';
import type { LookupFn } from '../../src/net/http.js';
import { TEST_TLS } from '../fake-smtp.js';
import { startFakeSru, type FakeSru } from '../support/fake-sru.js';

// The outbound HTTP client (spec §6.1, S8, K7) against the local fake SRU server: limits, the SSRF guard on every
// resolved address and every redirect hop, the original Host and SNI, no compression, and the test-only resolver.

/** The DomainError `httpRequest(req, deps)` rejects with, as `{code, reason?}` (`reason` from meta). */
async function failure(req: OutboundRequest, deps?: Parameters<typeof httpRequest>[1]): Promise<{ code: string; reason?: unknown; status?: unknown }> {
  try {
    await httpRequest(req, deps);
  } catch (e) {
    if (!isDomainError(e)) throw e;
    const out: { code: string; reason?: unknown; status?: unknown } = { code: e.code };
    if (e.meta?.['reason'] !== undefined) out.reason = e.meta['reason'];
    if (e.meta?.['status'] !== undefined) out.status = e.meta['status'];
    return out;
  }
  throw new Error('httpRequest did not fail');
}

const BLOCKED = { code: 'CATALOG_OUTBOUND_BLOCKED' };
const failed = (reason: string): { code: string; reason: string } => ({ code: 'CATALOG_OUTBOUND_FAILED', reason });

/** A resolver for the names of `map` (each to one or more addresses); any other name is not found. */
function fakeLookup(map: Record<string, string[]>): Mock<LookupFn> {
  return vi.fn<LookupFn>(async (hostname) => {
    const addresses = map[hostname];
    if (addresses === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: net.isIP(address) }));
  });
}

let fake: FakeSru;
let port: number;

beforeAll(async () => {
  fake = await startFakeSru();
  port = Number(new URL(fake.url).port);
});

afterAll(async () => {
  await fake.close();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the limits (§6.1)', () => {
  it('connect 5 s, total 10 s, 5 MB, 3 redirects', () => {
    expect(OUTBOUND_CONNECT_MS).toBe(5000);
    expect(OUTBOUND_TOTAL_MS).toBe(10_000);
    expect(OUTBOUND_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(OUTBOUND_MAX_REDIRECTS).toBe(3);
  });
});

describe('httpRequest: an answer', () => {
  it('returns the status, lower-case headers, the body and the final URL', async () => {
    const res = await httpRequest({ url: `${fake.url}/redirect/0`, allowPrivate: true });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['x-fake']).toBe('arrived');
    expect(res.body.toString('utf8')).toBe('arrived');
    expect(res.finalUrl).toBe(`${fake.url}/redirect/0`);
  });

  it('sends no Accept-Encoding, even when the caller asks for one, and a POST body with its length', async () => {
    const res = await httpRequest({
      url: `${fake.url}/echo`,
      method: 'POST',
      headers: { 'Accept-Encoding': 'gzip, br', 'Content-Type': 'text/plain', 'X-Test': 'yes' },
      body: new TextEncoder().encode('halo'),
      allowPrivate: true,
    });
    const echo = JSON.parse(res.body.toString('utf8')) as { method: string; headers: Record<string, string>; body: string };
    expect(echo.method).toBe('POST');
    expect(echo.body).toBe('halo');
    expect(echo.headers['content-length']).toBe('4');
    expect(echo.headers['x-test']).toBe('yes');
    expect(echo.headers).not.toHaveProperty('accept-encoding');
    expect(echo.headers['host']).toBe(`127.0.0.1:${port}`);
  });

  it('connects to the checked address only, with Host set to the original name (no second resolution)', async () => {
    const lookup = fakeLookup({ 'a.test': ['127.0.0.1'] });
    const res = await httpRequest(
      { url: `http://a.test:${port}/echo?x=1`, allowPrivate: false },
      { lookup, blocked: (ip) => ip === '10.0.0.1' },
    );
    const echo = JSON.parse(res.body.toString('utf8')) as { path: string; headers: Record<string, string> };
    expect(echo.path).toBe('/echo?x=1');
    expect(echo.headers['host']).toBe(`a.test:${port}`);
    expect(echo.headers).not.toHaveProperty('accept-encoding');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('a.test', { all: true });
    expect(res.finalUrl).toBe(`http://a.test:${port}/echo?x=1`);
  });

  it('refuses a Content-Encoding answer (gzip) with reason encoding', async () => {
    expect(await failure({ url: `${fake.url}/gzip`, allowPrivate: true })).toEqual(failed('encoding'));
  });

  it('a non-2xx answer is reason status, with the status in meta', async () => {
    expect(await failure({ url: `${fake.url}/status/500`, allowPrivate: true })).toEqual({ ...failed('status'), status: 500 });
    expect(await failure({ url: `${fake.url}/status/404`, allowPrivate: true })).toEqual({ ...failed('status'), status: 404 });
    // A redirect status without a Location is no redirect.
    expect(await failure({ url: `${fake.url}/status/302`, allowPrivate: true })).toEqual({ ...failed('status'), status: 302 });
  });
});

describe('httpRequest: the SSRF guard (S8)', () => {
  it('refuses a name when any of its addresses is blocked, before connecting', async () => {
    const lookup = fakeLookup({ 'mixed.test': ['8.8.8.8', '10.0.0.1'] });
    const before = fake.requests.length;
    expect(await failure({ url: 'http://mixed.test/sru', allowPrivate: false }, { lookup })).toEqual(BLOCKED);
    expect(fake.requests.length).toBe(before);
  });

  it('checks every redirect hop again: a.test redirecting to b.test (10.0.0.1) is refused', async () => {
    const lookup = fakeLookup({ 'a.test': ['127.0.0.1'], 'b.test': ['10.0.0.1'] });
    const blocked = (ip: string): boolean => ip === '10.0.0.1';
    const target = encodeURIComponent(`http://b.test:${port}/echo`);
    expect(await failure({ url: `http://a.test:${port}/goto?url=${target}`, allowPrivate: false }, { lookup, blocked })).toEqual(BLOCKED);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenLastCalledWith('b.test', { all: true });
  });

  it('refuses plain 127.0.0.1 (and loopback in IPv6 forms) without allowPrivate', async () => {
    const before = fake.requests.length;
    expect(await failure({ url: `${fake.url}/echo`, allowPrivate: false })).toEqual(BLOCKED);
    expect(await failure({ url: `http://[::1]:${port}/echo`, allowPrivate: false })).toEqual(BLOCKED);
    expect(await failure({ url: `http://[::ffff:127.0.0.1]:${port}/echo`, allowPrivate: false })).toEqual(BLOCKED);
    // WHATWG URL normalises other IPv4 spellings (decimal, short) to dotted form before the check.
    expect(await failure({ url: `http://2130706433:${port}/echo`, allowPrivate: false })).toEqual(BLOCKED);
    expect(await failure({ url: `http://127.1:${port}/echo`, allowPrivate: false })).toEqual(BLOCKED);
    expect(fake.requests.length).toBe(before);
  });

  it('with allowPrivate, a private address passes but cloud metadata and link-local are still refused', async () => {
    expect((await httpRequest({ url: `${fake.url}/redirect/0`, allowPrivate: true })).status).toBe(200);
    expect(await failure({ url: 'http://169.254.169.254/latest/meta-data/', allowPrivate: true })).toEqual(BLOCKED);
    expect(await failure({ url: 'http://[fd00:ec2::254]/', allowPrivate: true })).toEqual(BLOCKED);
    expect(await failure({ url: 'http://metadata.test/', allowPrivate: true }, { lookup: fakeLookup({ 'metadata.test': ['10.0.0.5', '169.254.169.254'] }) })).toEqual(
      BLOCKED,
    );
  });

  it('a name that does not resolve, or an empty answer, is reason network', async () => {
    expect(await failure({ url: 'http://nowhere.test/', allowPrivate: false }, { lookup: fakeLookup({}) })).toEqual(failed('network'));
    expect(await failure({ url: 'http://empty.test/', allowPrivate: false }, { lookup: fakeLookup({ 'empty.test': [] }) })).toEqual(failed('network'));
  });

  it('a refused connection is reason network', async () => {
    const closed = net.createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', () => done()));
    const freePort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((done) => closed.close(() => done()));
    expect(await failure({ url: `http://127.0.0.1:${freePort}/`, allowPrivate: true })).toEqual(failed('network'));
  });

  it('in the production profile deps.lookup and deps.blocked are ignored (R57)', async () => {
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    const lookup = fakeLookup({ localhost: ['127.0.0.1'] });
    const blocked = vi.fn(() => false);
    const before = fake.requests.length;
    expect(await failure({ url: `${fake.url}/echo`, allowPrivate: false }, { lookup, blocked })).toEqual(BLOCKED);
    // The system resolver answers localhost from the hosts file (loopback, so BLOCKED; a host without any configured
    // address may say "not found" instead): what matters is that the fake resolver is not asked and nothing connects.
    await expect(httpRequest({ url: `http://localhost:${port}/echo`, allowPrivate: false }, { lookup, blocked })).rejects.toSatisfy(isDomainError);
    expect(lookup).not.toHaveBeenCalled();
    expect(blocked).not.toHaveBeenCalled();
    expect(fake.requests.length).toBe(before);
  });
});

describe('httpRequest: time, size, redirects and schemes', () => {
  it('a server that never answers is reason timeout after timeoutMs', async () => {
    const started = Date.now();
    expect(await failure({ url: `${fake.url}/hang`, allowPrivate: true, timeoutMs: 300 })).toEqual(failed('timeout'));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
  });

  it('the default total is 10 000 ms, and the connect timer stops once connected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const marker = `/hang?default=${Date.now()}`;
    let outcome: unknown = 'pending';
    const pending = httpRequest({ url: `${fake.url}${marker}`, allowPrivate: true }).then(
      () => (outcome = 'answered'),
      (e: unknown) => (outcome = e),
    );
    await fake.waitForRequest(marker);
    await vi.advanceTimersByTimeAsync(OUTBOUND_TOTAL_MS - 1);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(isDomainError(outcome) && outcome.code === 'CATALOG_OUTBOUND_FAILED' && outcome.meta?.['reason'] === 'timeout').toBe(true);
  });

  it('a caller abort ends the request as reason timeout', async () => {
    const controller = new AbortController();
    const marker = `/hang?abort=${Date.now()}`;
    const pending = failure({ url: `${fake.url}${marker}`, allowPrivate: true, signal: controller.signal });
    await fake.waitForRequest(marker);
    controller.abort();
    expect(await pending).toEqual(failed('timeout'));
    const aborted = AbortSignal.abort();
    expect(await failure({ url: `${fake.url}/redirect/0`, allowPrivate: true, signal: aborted })).toEqual(failed('timeout'));
  });

  it('a body above maxBytes is reason too_large, with or without a Content-Length; exactly maxBytes passes', async () => {
    expect(await failure({ url: `${fake.url}/huge`, allowPrivate: true })).toEqual(failed('too_large'));
    expect(await failure({ url: `${fake.url}/huge?declared=1`, allowPrivate: true })).toEqual(failed('too_large'));
    expect(await failure({ url: `${fake.url}/huge?bytes=1001`, allowPrivate: true, maxBytes: 1000 })).toEqual(failed('too_large'));
    const exact = await httpRequest({ url: `${fake.url}/huge?bytes=1000&declared=1`, allowPrivate: true, maxBytes: 1000 });
    expect(exact.body.length).toBe(1000);
    // A larger maxBytes than the 5 MB limit is held to the limit.
    expect(await failure({ url: `${fake.url}/huge`, allowPrivate: true, maxBytes: 10 * 1024 * 1024 })).toEqual(failed('too_large'));
  });

  it('follows 3 redirects and refuses the 4th', async () => {
    const res = await httpRequest({ url: `${fake.url}/redirect/3`, allowPrivate: true });
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe(`${fake.url}/redirect/0`);
    expect(await failure({ url: `${fake.url}/redirect/4`, allowPrivate: true })).toEqual(failed('redirect'));
  });

  it('a 303 turns a POST into a GET without its body', async () => {
    const res = await httpRequest({
      url: `${fake.url}/goto?status=303&url=${encodeURIComponent('/echo')}`,
      method: 'POST',
      body: new TextEncoder().encode('weg'),
      allowPrivate: true,
    });
    const echo = JSON.parse(res.body.toString('utf8')) as { method: string; body: string; headers: Record<string, string> };
    expect(echo.method).toBe('GET');
    expect(echo.body).toBe('');
    expect(echo.headers).not.toHaveProperty('content-length');
  });

  it('a redirect to another origin drops Authorization and Cookie, and keeps the other headers', async () => {
    const lookup = fakeLookup({ 'a.test': ['127.0.0.1'] });
    const target = encodeURIComponent(`http://a.test:${port}/echo`);
    const res = await httpRequest(
      { url: `${fake.url}/goto?url=${target}`, headers: { Authorization: 'Bearer x', Cookie: 'k=v', 'X-Keep': 'yes' }, allowPrivate: true },
      { lookup },
    );
    const echo = JSON.parse(res.body.toString('utf8')) as { headers: Record<string, string> };
    expect(echo.headers['host']).toBe(`a.test:${port}`);
    expect(echo.headers['x-keep']).toBe('yes');
    expect(echo.headers).not.toHaveProperty('authorization');
    expect(echo.headers).not.toHaveProperty('cookie');
    // The same origin keeps them.
    const same = await httpRequest({ url: `${fake.url}/goto?url=${encodeURIComponent('/echo')}`, headers: { Authorization: 'Bearer x' }, allowPrivate: true });
    expect((JSON.parse(same.body.toString('utf8')) as { headers: Record<string, string> }).headers['authorization']).toBe('Bearer x');
  });

  it('only http and https: other schemes, also as a redirect target, are reason scheme', async () => {
    expect(await failure({ url: 'ftp://x', allowPrivate: true })).toEqual(failed('scheme'));
    expect(await failure({ url: 'file:///etc/passwd', allowPrivate: true })).toEqual(failed('scheme'));
    expect(await failure({ url: 'not a url', allowPrivate: true })).toEqual(failed('scheme'));
    expect(await failure({ url: `${fake.url}/goto?url=${encodeURIComponent('ftp://x/')}`, allowPrivate: true })).toEqual(failed('scheme'));
    expect(await failure({ url: `${fake.url}/goto?url=${encodeURIComponent('gopher://127.0.0.1:70/')}`, allowPrivate: true })).toEqual(failed('scheme'));
  });

  it('refuses a timeoutMs or maxBytes that is not a positive integer', async () => {
    await expect(httpRequest({ url: `${fake.url}/redirect/0`, allowPrivate: true, timeoutMs: 0 })).rejects.toThrow(RangeError);
    await expect(httpRequest({ url: `${fake.url}/redirect/0`, allowPrivate: true, maxBytes: 1.5 })).rejects.toThrow(RangeError);
  });
});

describe('httpRequest: TLS', () => {
  let tlsServer: tls.Server;
  let tlsPort: number;
  const sni: string[] = [];
  let connections = 0;

  beforeAll(async () => {
    const context = tls.createSecureContext({ key: TEST_TLS.key, cert: TEST_TLS.cert });
    tlsServer = tls.createServer({
      key: TEST_TLS.key,
      cert: TEST_TLS.cert,
      SNICallback: (name, done) => {
        sni.push(name);
        done(null, context);
      },
    });
    tlsServer.on('connection', () => connections++);
    tlsServer.on('tlsClientError', () => {});
    await new Promise<void>((done) => tlsServer.listen(0, '127.0.0.1', () => done()));
    tlsPort = (tlsServer.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((done) => tlsServer.close(() => done()));
  });

  it('sends the original name as SNI and verifies the certificate (an untrusted one is reason network)', async () => {
    const lookup = fakeLookup({ 'a.test': ['127.0.0.1'] });
    expect(await failure({ url: `https://a.test:${tlsPort}/sru`, allowPrivate: true }, { lookup })).toEqual(failed('network'));
    expect(sni).toEqual(['a.test']);
  });

  it('a TLS handshake that never finishes is reason timeout after the 5 s connect limit, not the 10 s total', async () => {
    const accepted: net.Socket[] = [];
    let onAccept: () => void = () => {};
    const arrived = new Promise<void>((done) => (onAccept = done));
    const stall = net.createServer((socket) => {
      socket.on('error', () => {});
      accepted.push(socket);
      onAccept();
    });
    await new Promise<void>((done) => stall.listen(0, '127.0.0.1', () => done()));
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let outcome: unknown = 'pending';
      const pending = httpRequest({ url: `https://127.0.0.1:${(stall.address() as net.AddressInfo).port}/`, allowPrivate: true }).then(
        () => (outcome = 'answered'),
        (e: unknown) => (outcome = e),
      );
      await arrived;
      await vi.advanceTimersByTimeAsync(OUTBOUND_CONNECT_MS - 1);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(isDomainError(outcome) && outcome.code === 'CATALOG_OUTBOUND_FAILED' && outcome.meta?.['reason'] === 'timeout').toBe(true);
    } finally {
      vi.useRealTimers();
      for (const s of accepted) s.destroy();
      await new Promise<void>((done) => stall.close(() => done()));
    }
  });

  it('sends no SNI for an IP literal', async () => {
    sni.length = 0;
    const before = connections;
    expect(await failure({ url: `https://127.0.0.1:${tlsPort}/sru`, allowPrivate: true })).toEqual(failed('network'));
    expect(connections).toBe(before + 1);
    expect(sni).toEqual([]);
  });
});

describe('no global fetch (P18) over packages/core/src/net', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.js') });

  it('the lint rule covers the folder (a fetch there is reported)', async () => {
    const [result] = await eslint.lintText("export const x = fetch('https://example.org/');\n", { filePath: 'packages/core/src/net/__fixture__.ts' });
    expect(result?.messages.map((m) => m.ruleId)).toEqual(['no-restricted-globals']);
  });

  it('the outbound client and the SRU client lint clean', async () => {
    const results = await eslint.lintFiles(['packages/core/src/net/*.ts', 'packages/core/src/catalog/copy/*.ts']);
    expect(results.map((r) => r.filePath.slice(root.length + 1)).sort()).toEqual(
      expect.arrayContaining(['packages/core/src/catalog/copy/sru-client.ts', 'packages/core/src/net/http.ts', 'packages/core/src/net/ssrf.ts']),
    );
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId ?? ''} ${m.message}`))).toEqual([]);
  });
});
