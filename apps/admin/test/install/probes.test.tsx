import { webcrypto } from 'node:crypto';
import { XFF_PROBE_FORGED } from '@altis/shared/api/diagnostics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBrowserProbes, type BrowserProbeOptions } from '@/lib/probes';
import { ORIGIN, PROBE_CONTENT, PROBE_ID, checks, fakeInstall, healthyProbes, htmlPage, json, problem, sha256, type FakeInstall } from './fake-install';

// The browser test (Task 30; spec §9.5 step 1, §11, P10, P15; decisions C22, C35), shared by the wizard and Diagnostik
// (Task 32): polling, SSE (three ticks spread over time, not one buffered burst), the real methods, the largest chunk
// the host lets through (5 MiB halving down to 256 KiB on 413/403), the forged X-Forwarded-For poll, and in the wizard
// the exposure candidates (SHA-256 by WebCrypto, reported with POST exposure) and the base URL proof (GET probe/<nonce>).

const KIB = 1024;
const MIB = 1024 * KIB;

const fetchMock = vi.fn<typeof fetch>();
let server: FakeInstall;

/** An EventSource the test drives, with the clock the probe reads. */
class FakeEventSource extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown): void {
    if (this.closed) return;
    this.readyState = 1;
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  fail(): void {
    if (this.closed) return;
    this.readyState = 2;
    this.dispatchEvent(new Event('error'));
  }
}

let clock = 0;
let streams: FakeEventSource[] = [];

/** A stream that sends `ticks` events `gapMs` apart (on the fake clock), then `done`. */
function ticking(ticks: number, gapMs: number): BrowserProbeOptions['openStream'] {
  return (url) => {
    const es = new FakeEventSource(url);
    streams.push(es);
    setTimeout(() => {
      for (let n = 1; n <= ticks; n += 1) {
        if (n > 1) clock += gapMs;
        es.emit('tick', { n });
      }
      es.emit('done', { ticks });
    }, 0);
    return es as unknown as EventSource;
  };
}

function options(o: Partial<BrowserProbeOptions> = {}): BrowserProbeOptions {
  return {
    base: '/install/api/probe',
    csrf: () => 'csrf-w',
    exposure: checks().exposure.candidates,
    openStream: ticking(3, 1000),
    now: () => clock,
    ...o,
  };
}

beforeEach(() => {
  clock = 1_000_000;
  streams = [];
  vi.stubGlobal('fetch', fetchMock);
  server = fakeInstall(fetchMock, healthyProbes());
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('runBrowserProbes', () => {
  it('a healthy host: polling, SSE, every method, a 5 MiB chunk, the XFF chains, no exposure and the base URL proof', async () => {
    const results = await runBrowserProbes(options());
    expect(results).toMatchObject({
      polling: true,
      sse: true,
      methods: { put: true, patch: true, delete: true },
      chunkBytes: 5 * MIB,
      xff: { cleanXff: ['198.51.100.7'], forgedXff: [XFF_PROBE_FORGED, '198.51.100.7'], forgedDerived: '198.51.100.7' },
      suggestedHops: 1,
      ipAtSuggested: '198.51.100.7',
      exposure: { status: 'ok' },
    });
    // The proof: a fresh nonce sent to GET probe/<nonce>, and the HMAC it answered.
    const proof = results.baseUrlProof!;
    expect(proof.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(proof.hmac).toBe(`hmac-of-${proof.nonce}`);
    expect(server.callsTo(`GET probe/${proof.nonce}`)).toHaveLength(1);
    // The stream is closed once it delivered (EventSource would reconnect otherwise).
    expect(streams).toHaveLength(1);
    expect(streams[0]!.url).toBe('/install/api/probe/sse');
    expect(streams[0]!.closed).toBe(true);
  });

  it('the forged poll carries X-Forwarded-For: 203.0.113.77; the writes carry the CSRF token and their real method', async () => {
    await runBrowserProbes(options());
    const polls = server.callsTo('GET probe/poll');
    expect(polls).toHaveLength(2);
    expect(polls[0]!.headers.get('X-Forwarded-For')).toBeNull();
    expect(polls[1]!.headers.get('X-Forwarded-For')).toBe(XFF_PROBE_FORGED);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const [call] = server.callsTo(`${method} probe/methods`);
      expect(call!.headers.get('X-CSRF-Token'), method).toBe('csrf-w');
      expect(call!.headers.get('X-HTTP-Method-Override'), method).toBeNull();
    }
    expect(server.callsTo('POST probe/chunk')[0]!.headers.get('X-CSRF-Token')).toBe('csrf-w');
  });

  it('PUT answered by a WAF 403 HTML page → methods.put false; the others still pass', async () => {
    server.on('PUT probe/methods', () => htmlPage(403));
    const results = await runBrowserProbes(options());
    expect(results.methods).toEqual({ put: false, patch: true, delete: true });
  });

  it('chunk: 5 MiB → 413, 2.5 MiB → 200 → chunkBytes 2621440', async () => {
    const sizes: number[] = [];
    server.on('POST probe/chunk', (call) => {
      const size = ((call.body as FormData).get('chunk') as Blob).size;
      sizes.push(size);
      return size > 3 * MIB ? htmlPage(413) : json({ bytes: size });
    });
    const results = await runBrowserProbes(options());
    expect(sizes).toEqual([5 * MIB, 2.5 * MIB]);
    expect(results.chunkBytes).toBe(2_621_440);
  });

  it('chunk: halving on 413/403 stops at 256 KiB; nothing passing → null', async () => {
    const sizes: number[] = [];
    server.on('POST probe/chunk', (call) => {
      sizes.push(((call.body as FormData).get('chunk') as Blob).size);
      return sizes.length % 2 === 0 ? htmlPage(403) : problem(413, 'PAYLOAD_TOO_LARGE');
    });
    const results = await runBrowserProbes(options());
    expect(sizes).toEqual([5 * MIB, 2.5 * MIB, 1.25 * MIB, 640 * KIB, 320 * KIB, 256 * KIB]);
    expect(results.chunkBytes).toBeNull();
  });

  it('SSE: three ticks spread over time → true; the same three ticks in one burst (a buffering proxy) → false', async () => {
    expect((await runBrowserProbes(options({ openStream: ticking(3, 1000) }))).sse).toBe(true);
    expect((await runBrowserProbes(options({ openStream: ticking(3, 0) }))).sse).toBe(false);
  });

  it('SSE: fewer than three ticks, an error (a 204 at the stream limit) or no EventSource at all → false', async () => {
    expect((await runBrowserProbes(options({ openStream: ticking(2, 1000) }))).sse).toBe(false);
    const failing: BrowserProbeOptions['openStream'] = (url) => {
      const es = new FakeEventSource(url);
      setTimeout(() => es.fail(), 0);
      return es as unknown as EventSource;
    };
    expect((await runBrowserProbes(options({ openStream: failing }))).sse).toBe(false);
    // The default opener: jsdom has no EventSource.
    const rest = options();
    delete rest.openStream;
    expect((await runBrowserProbes(rest)).sse).toBe(false);
  });

  it('SSE: no three ticks within 6 s → false', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const silent: BrowserProbeOptions['openStream'] = (url) => new FakeEventSource(url) as unknown as EventSource;
      const pending = runBrowserProbes(options({ openStream: silent }));
      await vi.advanceTimersByTimeAsync(6000);
      expect((await pending).sse).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposure: a candidate whose body hashes like the probe file → POST exposure with that digest → exposed', async () => {
    server.on(`GET ${ORIGIN}/tmp/${PROBE_ID}`, () => new Response(PROBE_CONTENT, { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    const results = await runBrowserProbes(options());
    expect(results.exposure).toMatchObject({ status: 'exposed' });

    // Every candidate fetched at location.origin + path, without cache, redirects or cookies.
    for (const candidate of checks().exposure.candidates) {
      const [call] = server.callsTo(`GET ${ORIGIN}${candidate.path}`);
      expect(call, candidate.path).toBeDefined();
      expect(call!.init).toMatchObject({ cache: 'no-store', redirect: 'manual', credentials: 'omit' });
    }
    const [report] = server.callsTo('POST exposure');
    expect(report!.headers.get('X-CSRF-Token')).toBe('csrf-w');
    const { results: sent } = report!.body as { results: { path: string; status: number; sha256: string | null }[] };
    expect(sent).toContainEqual({ path: `/tmp/${PROBE_ID}`, status: 200, sha256: sha256(PROBE_CONTENT) });
    expect(sent).toContainEqual({ path: '/app.js', status: 404, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(sent).toHaveLength(4);
  });

  it('exposure: at most 64 KiB of a body is read and hashed', async () => {
    const big = 'x'.repeat(100 * KIB);
    server.on(`GET ${ORIGIN}/app.js`, () => new Response(big, { status: 200 }));
    await runBrowserProbes(options());
    const { results: sent } = server.callsTo('POST exposure')[0]!.body as { results: { path: string; sha256: string | null }[] };
    expect(sent.find((r) => r.path === '/app.js')!.sha256).toBe(sha256(big.slice(0, 64 * KIB)));
  });

  it('exposure: a page served over http: has no WebCrypto digest; the digest is still computed', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a) });
    server.on(`GET ${ORIGIN}/tmp/${PROBE_ID}`, () => new Response(PROBE_CONTENT, { status: 200 }));
    const results = await runBrowserProbes(options());
    expect(results.exposure).toMatchObject({ status: 'exposed' });
    const { results: sent } = server.callsTo('POST exposure')[0]!.body as { results: { path: string; sha256: string | null }[] };
    expect(sent.find((r) => r.path === `/tmp/${PROBE_ID}`)!.sha256).toBe(sha256(PROBE_CONTENT));
  });

  it('exposure: candidates are fetched 4 at a time (a host that drops paths costs 5 s per 4), reported in their order', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ kind: 'probe' as const, path: `/c${i}/${PROBE_ID}` }));
    let inFlight = 0;
    let most = 0;
    for (const c of candidates) {
      server.on(`GET ${ORIGIN}${c.path}`, async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return htmlPage(404);
      });
    }
    await runBrowserProbes(options({ exposure: candidates }));
    expect(most).toBe(4);
    const { results: sent } = server.callsTo('POST exposure')[0]!.body as { results: { path: string }[] };
    expect(sent.map((r) => r.path)).toEqual(candidates.map((c) => c.path));
  });

  it('exposure: a fetch that fails (network, redirect) reports status 0 and no digest', async () => {
    server.on(`GET ${ORIGIN}/app.js`, () => Promise.reject(new TypeError('Failed to fetch')));
    await runBrowserProbes(options());
    const { results: sent } = server.callsTo('POST exposure')[0]!.body as { results: { path: string; status: number; sha256: string | null }[] };
    expect(sent.find((r) => r.path === '/app.js')).toEqual({ path: '/app.js', status: 0, sha256: null });
  });

  it('a host that cannot be polled → polling false, empty XFF chains, no proof', async () => {
    server.on('GET probe/poll', () => problem(503, 'DB_UNAVAILABLE'));
    server.on('GET probe/:nonce', () => problem(403, 'INSTALL_CLAIM_REQUIRED'));
    const results = await runBrowserProbes(options());
    expect(results).toMatchObject({
      polling: false,
      xff: { cleanXff: [], forgedXff: [], forgedDerived: '' },
      suggestedHops: null,
      ipAtSuggested: null,
      baseUrlProof: null,
    });
  });

  it('Diagnostik: the probes under /api/v1/diagnostics/probe, without the exposure test or the base URL proof', async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/poll')) return json({ now: 1, ip: '198.51.100.7', ipTrust: 'ok', xff: [], peerPrivate: true, suggestedHops: 0, ipAtSuggested: '' });
      if (url.endsWith('/methods')) return json({ method: init?.method });
      if (url.endsWith('/chunk')) return json({ bytes: 1 });
      return problem(404, 'NOT_FOUND');
    });
    const results = await runBrowserProbes(options({ base: '/api/v1/diagnostics/probe', exposure: checks().exposure.candidates }));
    expect(results).toMatchObject({ polling: true, sse: true, chunkBytes: 5 * MIB, exposure: null, baseUrlProof: null });
    expect(calls.every((c) => c.includes(' /api/v1/diagnostics/probe/'))).toBe(true);
    expect(streams[0]!.url).toBe('/api/v1/diagnostics/probe/sse');
  });

  it('an aborted signal rejects with its reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('left the page'));
    await expect(runBrowserProbes(options({ signal: controller.signal }))).rejects.toThrow('left the page');
  });
});
