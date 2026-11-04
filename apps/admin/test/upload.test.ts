import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The admin's chunked upload (Task 16; spec §5 P10, §7.5; decision C7; Review Focus 5). A file is hashed, declared
// (`POST files/uploads`), sent chunk by chunk as multipart/form-data and completed. A host whose WAF refuses large
// bodies (413) or answers a 403 page makes the client drop the session and start again with half the chunk, never
// below 256 KiB; the size that passed is remembered. Network failures are retried. `fetch` is a fake host: a WAF in
// front of a fake ALTIS server.

type Modules = {
  api: typeof import('@/lib/api');
  upload: typeof import('@/lib/upload');
};

const KIB = 1024;
const MIB = 1024 * KIB;

const fetchMock = vi.fn<typeof fetch>();

async function load(): Promise<Modules> {
  vi.resetModules();
  return { api: await import('@/lib/api'), upload: await import('@/lib/upload') };
}

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

function bytes(length: number, seed = 0x2545f491): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, traceId: '01JTRACE', ...extra }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

const page = (status: number): Response => new Response('<html><body>Blocked</body></html>', { status, headers: { 'Content-Type': 'text/html' } });

/** One upload session of the fake server. */
interface Session {
  id: string;
  context: string;
  size: number;
  sha256: string;
  /** What the client asked for. */
  asked: number | undefined;
  chunkSize: number;
  chunks: number;
  parts: Uint8Array[];
  state: 'open' | 'deleted' | 'complete';
}

interface Host {
  sessions: Session[];
  /** `METHOD path` of every request that reached the server (after the WAF), with the overridden method. */
  log: string[];
  /** Fails the next request matching `when` with a network error (fetch's TypeError). */
  dropNext(when: (method: string, path: string) => boolean, times?: number): void;
  /** Answers the next request matching `when` with `res`. */
  answerNext(when: (method: string, path: string) => boolean, res: () => Response, times?: number): void;
}

/**
 * The fake host. Its WAF answers PUT/PATCH/DELETE with a 403 page and any body over `maxBody` with a 413 page; the
 * server behind it runs the upload routes like ALTIS (C7: the chunk size clamped to 256 KiB-5 MiB, chunks in order,
 * complete checks size and SHA-256).
 */
function host(o: { maxBody?: number } = {}): Host {
  const maxBody = o.maxBody ?? MIB;
  const sessions: Session[] = [];
  const log: string[] = [];
  const traps: { when: (method: string, path: string) => boolean; res: (() => Response) | 'drop'; times: number }[] = [];

  const bodySize = (body: unknown): number => {
    if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
    if (body instanceof FormData) {
      let size = 0;
      for (const [name, value] of body.entries()) size += 128 + name.length + (typeof value === 'string' ? value.length : value.size);
      return size;
    }
    return 0;
  };

  const route = async (method: string, path: string, body: unknown): Promise<Response> => {
    if (method === 'GET' && path === 'auth/me') {
      return json({ authenticated: true, csrfToken: 'tok', user: { id: 'u1' }, client: { realtime: 'polling', methodOverride: false, chunkBytes: 5 * MIB } });
    }
    if (method === 'POST' && path === 'files/uploads') {
      const b = JSON.parse(body as string) as { context: string; size: number; sha256: string; chunkBytes?: number };
      if (sessions.filter((s) => s.state === 'open').length >= 3) return problem(429, 'UPLOAD_LIMIT');
      const chunkSize = Math.min(5 * MIB, Math.max(256 * KIB, b.chunkBytes ?? 5 * MIB));
      const s: Session = {
        id: `01JUPLOAD${String(sessions.length).padStart(17, '0')}`,
        context: b.context,
        size: b.size,
        sha256: b.sha256,
        asked: b.chunkBytes,
        chunkSize,
        chunks: Math.ceil(b.size / chunkSize),
        parts: [],
        state: 'open',
      };
      sessions.push(s);
      return json({ id: s.id, chunkSize: s.chunkSize, chunks: s.chunks, expiresAt: Date.now() + 86_400_000 }, 201);
    }
    const m = /^files\/uploads\/([0-9A-Z]{26})(?:\/(chunks\/(\d+)|complete))?$/.exec(path);
    const s = m === null ? undefined : sessions.find((x) => x.id === m[1] && x.state !== 'deleted');
    if (m === null) return problem(404, 'NOT_FOUND');
    if (s === undefined) return problem(404, 'NOT_FOUND');
    if (method === 'DELETE' && m[2] === undefined) {
      s.state = 'deleted';
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && m[3] !== undefined) {
      const n = Number(m[3]);
      if (n < s.parts.length) return json({ received: s.parts.reduce((a, p) => a + p.byteLength, 0), complete: false });
      if (n > s.parts.length) return problem(409, 'UPLOAD_CHUNK_INVALID', { reason: 'order' });
      const chunk = (body as FormData).get('chunk');
      if (!(chunk instanceof Blob)) return problem(422, 'VALIDATION_FAILED');
      const data = new Uint8Array(await chunk.arrayBuffer());
      const expected = n === s.chunks - 1 ? s.size - n * s.chunkSize : s.chunkSize;
      if (data.byteLength !== expected) return problem(409, 'UPLOAD_CHUNK_INVALID', { reason: 'size' });
      s.parts.push(data);
      const received = s.parts.reduce((a, p) => a + p.byteLength, 0);
      return json({ received, complete: received === s.size });
    }
    if (method === 'POST' && m[2] === 'complete') {
      const all = new Uint8Array(s.size);
      let at = 0;
      for (const p of s.parts) {
        all.set(p, at);
        at += p.byteLength;
      }
      if (at !== s.size) return problem(409, 'UPLOAD_INCOMPLETE');
      if (sha(all) !== s.sha256) return problem(422, 'UPLOAD_MISMATCH', { reason: 'sha256' });
      s.state = 'complete';
      return json({ uploadId: s.id, size: s.size, sha256: s.sha256, mime: 'application/zip' });
    }
    return problem(404, 'NOT_FOUND');
  };

  fetchMock.mockImplementation(async (input, init) => {
    const raw = init?.method ?? 'GET';
    const path = String(input).replace(/^\/api\/v1\//, '');
    // The WAF.
    if (raw === 'PUT' || raw === 'PATCH' || raw === 'DELETE') return page(403);
    if (bodySize(init?.body) > maxBody) return page(413);
    const override = new Headers(init?.headers).get('x-http-method-override');
    const method = raw === 'POST' && override !== null ? override.toUpperCase() : raw;
    const trap = traps.find((t) => t.times > 0 && t.when(method, path));
    if (trap !== undefined) {
      trap.times -= 1;
      if (trap.res === 'drop') throw new TypeError('Failed to fetch');
      log.push(`${method} ${path}`);
      return trap.res();
    }
    log.push(`${method} ${path}`);
    return route(method, path, init?.body);
  });

  return {
    sessions,
    log,
    dropNext: (when, times = 1) => {
      traps.push({ when, res: 'drop', times });
    },
    answerNext: (when, res, times = 1) => {
      traps.push({ when, res, times });
    },
  };
}

/** Runs `promise` to its end, moving the fake clock along whenever it waits for a timer. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 500 && !done; i += 1) await vi.advanceTimersByTimeAsync(250);
  return promise;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('uploadFile', () => {
  it('a 3 MiB upload behind a WAF that refuses bodies over 1 MiB: 5 MiB, 2.5 MiB, 1.25 MiB, then 640 KiB chunks pass; the size that passed is kept', async () => {
    const { api, upload } = await load();
    const h = host();
    await api.api('GET', 'auth/me'); // client.chunkBytes 5 MiB
    const data = bytes(3 * MIB);
    const progress: [number, number][] = [];
    const result = await settle(upload.uploadFile(new Blob([data]), { context: 'backup', onProgress: (sent, total) => progress.push([sent, total]) }));

    expect(h.sessions.map((s) => s.chunkSize)).toEqual([5 * MIB, 2.5 * MIB, 1.25 * MIB, 640 * KIB]);
    expect(h.sessions.map((s) => s.asked)).toEqual([5 * MIB, 2.5 * MIB, 1.25 * MIB, 640 * KIB]);
    expect(h.sessions.map((s) => s.state)).toEqual(['deleted', 'deleted', 'deleted', 'complete']);
    expect(h.sessions.every((s) => s.sha256 === sha(data) && s.size === data.byteLength && s.context === 'backup')).toBe(true);
    expect(result).toEqual({ uploadId: h.sessions[3]!.id });
    expect(localStorage.getItem('altis.chunk-bytes')).toBe('655360');
    expect(progress.at(-1)).toEqual([3 * MIB, 3 * MIB]);
    expect(progress.map(([sent]) => sent)).toEqual([640 * KIB, 1280 * KIB, 1920 * KIB, 2560 * KIB, 3 * MIB]);
    // The WAF blocks DELETE as well: the first cancel went through the override, and so did the next ones.
    expect(h.log.filter((l) => l.startsWith('DELETE'))).toHaveLength(3);
    expect(sessionStorage.getItem('altis.method-override')).toBe('1');
  });

  it('the next upload starts at the size that passed', async () => {
    const { upload } = await load();
    const h = host();
    localStorage.setItem('altis.chunk-bytes', '655360');
    const data = bytes(MIB + 5);
    await settle(upload.uploadFile(new Blob([data]), { context: 'update' }));
    expect(h.sessions.map((s) => [s.asked, s.state])).toEqual([[655360, 'complete']]);
  });

  it("without a stored size it starts at auth/me's client.chunkBytes, else 5 MiB; a stored value that is not a size is ignored", async () => {
    const { api, upload } = await load();
    const h = host({ maxBody: 64 * MIB });
    localStorage.setItem('altis.chunk-bytes', 'abc');
    await settle(upload.uploadFile(new Blob([bytes(300 * KIB)]), { context: 'backup' }));
    fetchMock.mockClear();
    const before = h.sessions.length;
    // auth/me now says 1 MiB.
    const me = { authenticated: true, csrfToken: 'tok', user: { id: 'u1' }, client: { realtime: 'sse', methodOverride: false, chunkBytes: MIB } };
    h.answerNext((m, p) => m === 'GET' && p === 'auth/me', () => json(me));
    await api.api('GET', 'auth/me');
    await settle(upload.uploadFile(new Blob([bytes(300 * KIB)]), { context: 'backup' }));
    expect(h.sessions.map((s) => s.asked)).toEqual([5 * MIB, MIB]);
    expect(before).toBe(1);
    // A file smaller than the chunk proves nothing about the chunk size: nothing stored.
    expect(localStorage.getItem('altis.chunk-bytes')).toBe('abc');
  });

  it("a stored size yields to auth/me's client.chunkBytes once a newer browser test ran (probedAt); it is kept with the test it was learned under", async () => {
    const { api, upload } = await load();
    const h = host({ maxBody: 64 * MIB });
    const T1 = 1_800_000_400_000;
    const T2 = T1 + 86_400_000;
    const me = (probedAt: number | null) => ({
      authenticated: true,
      csrfToken: 'tok',
      user: { id: 'u1' },
      client: { realtime: 'polling', methodOverride: false, chunkBytes: 5 * MIB, probedAt },
    });
    const signIn = async (probedAt: number | null): Promise<void> => {
      h.answerNext((m, p) => m === 'GET' && p === 'auth/me', () => json(me(probedAt)));
      await api.api('GET', 'auth/me');
    };
    const send = (size: number) => settle(upload.uploadFile(new Blob([bytes(size)]), { context: 'backup' }));
    const stored = () => [localStorage.getItem('altis.chunk-bytes'), localStorage.getItem('altis.chunk-bytes-probed-at')];

    // Learned before any browser test: no newer one has spoken, so it holds.
    localStorage.setItem('altis.chunk-bytes', String(2.5 * MIB));
    await signIn(null);
    await send(3 * MIB);
    expect(stored()).toEqual([String(2.5 * MIB), null]);
    // Diagnostik ran (T1) and saw 5 MiB pass: its hint is newer than what this browser learned.
    await signIn(T1);
    await send(5 * MIB + KIB);
    expect(stored()).toEqual([String(5 * MIB), String(T1)]);
    // A WAF rule on the content refuses one 5 MiB chunk: halved, and learned under the same test, so it holds...
    h.answerNext((m, p) => m === 'POST' && p.endsWith('/chunks/0'), () => page(403));
    await send(5 * MIB + KIB);
    expect(stored()).toEqual([String(2.5 * MIB), String(T1)]);
    await send(3 * MIB);
    // ...until the next browser test (T2).
    await signIn(T2);
    await send(3 * MIB);
    expect(h.sessions.map((s) => s.asked)).toEqual([2.5 * MIB, 5 * MIB, 5 * MIB, 2.5 * MIB, 2.5 * MIB, 5 * MIB]);
    expect(h.sessions.map((s) => s.state)).toEqual(['complete', 'complete', 'deleted', 'complete', 'complete', 'complete']);
    // A 3 MiB file proves nothing about 5 MiB chunks: the stored size stays, and keeps yielding to T2's hint.
    expect(stored()).toEqual([String(2.5 * MIB), String(T1)]);
  });

  it('never below 256 KiB: a WAF limit of 100 KiB ends with its 413 after the 256 KiB session', async () => {
    const { upload } = await load();
    const h = host({ maxBody: 100 * KIB });
    localStorage.setItem('altis.chunk-bytes', String(512 * KIB));
    const run = settle(upload.uploadFile(new Blob([bytes(MIB)]), { context: 'backup' }));
    await expect(run).rejects.toMatchObject({ status: 413, problemJson: false });
    expect(h.sessions.map((s) => [s.chunkSize, s.state])).toEqual([
      [512 * KIB, 'deleted'],
      [256 * KIB, 'deleted'],
    ]);
    expect(localStorage.getItem('altis.chunk-bytes')).toBe(String(512 * KIB));
  });

  it("a 403 page on a chunk halves the chunk too; the server's own 403 does not", async () => {
    const { upload } = await load();
    const h = host({ maxBody: 64 * MIB });
    h.answerNext((m, p) => m === 'POST' && p.endsWith('/chunks/0'), () => page(403));
    await settle(upload.uploadFile(new Blob([bytes(MIB)]), { context: 'backup' }));
    expect(h.sessions.map((s) => [s.chunkSize, s.state])).toEqual([
      [5 * MIB, 'deleted'],
      [2.5 * MIB, 'complete'],
    ]);

    h.answerNext((m, p) => m === 'POST' && p.endsWith('/chunks/0'), () => problem(403, 'AUTHZ_DENIED'));
    await expect(settle(upload.uploadFile(new Blob([bytes(MIB)]), { context: 'backup' }))).rejects.toMatchObject({ code: 'AUTHZ_DENIED' });
    expect(h.sessions).toHaveLength(3);
    expect(h.sessions[2]!.state).toBe('deleted'); // dropped on the way out, so it does not hold one of the three slots
  });

  it('a network failure on chunk 2 is retried (after 1 s) and the upload completes', async () => {
    const { upload } = await load();
    const h = host();
    localStorage.setItem('altis.chunk-bytes', '655360');
    h.dropNext((m, p) => m === 'POST' && p.endsWith('/chunks/2'));
    const data = bytes(3 * MIB);
    const result = await settle(upload.uploadFile(new Blob([data]), { context: 'backup' }));
    expect(result).toEqual({ uploadId: h.sessions[0]!.id });
    expect(h.sessions.map((s) => s.state)).toEqual(['complete']);
    expect(h.log.filter((l) => l.endsWith('/chunks/2'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/chunks/2'))).toHaveLength(2);
  });

  it('network failures are retried 3 times (1, 2, 4 s); a fourth failure is the answer', async () => {
    const { upload } = await load();
    const h = host();
    h.dropNext((m, p) => m === 'POST' && p.endsWith('/chunks/0'), 4);
    const started = Date.now();
    const run = upload.uploadFile(new Blob([bytes(KIB)]), { context: 'backup' });
    await expect(settle(run)).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/chunks/0'))).toHaveLength(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(7000);
    expect(h.sessions[0]!.state).toBe('deleted');
  });

  it('409 TX_CONFLICT upload_busy on complete is retried with a backoff', async () => {
    const { upload } = await load();
    const h = host();
    h.answerNext((m, p) => m === 'POST' && p.endsWith('/complete'), () => problem(409, 'TX_CONFLICT', { reason: 'upload_busy' }), 2);
    const result = await settle(upload.uploadFile(new Blob([bytes(KIB)]), { context: 'backup' }));
    expect(result).toEqual({ uploadId: h.sessions[0]!.id });
    expect(h.log.filter((l) => l.endsWith('/complete'))).toHaveLength(3);
  });

  it('the declaration is retried after a network failure under the same Idempotency-Key', async () => {
    const { upload } = await load();
    const h = host();
    h.dropNext((m, p) => m === 'POST' && p === 'files/uploads');
    await settle(upload.uploadFile(new Blob([bytes(KIB)]), { context: 'backup' }));
    const creates = fetchMock.mock.calls.filter((c) => c[0] === '/api/v1/files/uploads');
    expect(creates).toHaveLength(2);
    const keys = creates.map((c) => new Headers(c[1]?.headers).get('idempotency-key'));
    expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{16,}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('the name of a File is sent with complete', async () => {
    const { upload } = await load();
    const h = host();
    await settle(upload.uploadFile(new File([bytes(KIB)], 'cadangan-2026-10-28.altisbak'), { context: 'backup' }));
    const complete = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/complete'));
    expect(JSON.parse(complete![1]!.body as string)).toEqual({ originalName: 'cadangan-2026-10-28.altisbak' });
    expect(h.sessions[0]!.state).toBe('complete');
  });

  it('an abort stops the upload and drops its session', async () => {
    const { upload } = await load();
    const h = host();
    localStorage.setItem('altis.chunk-bytes', '655360');
    const controller = new AbortController();
    h.answerNext(
      (m, p) => m === 'POST' && p.endsWith('/chunks/1'),
      () => {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        return json({ received: 0, complete: false });
      },
    );
    const run = settle(upload.uploadFile(new Blob([bytes(3 * MIB)]), { context: 'backup', signal: controller.signal }));
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.sessions.map((s) => s.state)).toEqual(['deleted']);
    expect(h.log.some((l) => l.endsWith('/chunks/2'))).toBe(false);
  });
});
