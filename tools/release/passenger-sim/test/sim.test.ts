import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UsageError, parseCliArgs, startSim, type Sim, type SimOptions, type SimStats } from '../sim.js';

// Real child processes are spawned (Node start-up per worker), so the default 5 s test timeout is too tight for CI.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const SIM_TS = path.resolve(HERE, '..', 'sim.ts');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

type EchoReply = {
  pid: number;
  method: string;
  url: string;
  host: string;
  body: string;
  remoteAddress?: string;
  remoteFamily?: string;
  xff?: string;
  xfp?: string;
  inPassenger?: string;
  appEnv?: string;
  nodeEnv?: string;
  passengerGlobal: string;
  simSocketInEnv: boolean;
  address: unknown;
  cwd: string;
};

const request = (
  port: number,
  opts: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: string; host?: string } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.host ?? '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: opts.headers,
        agent: false, // one socket per request: nothing lingers after the test
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });

const echo = async (port: number, opts: Parameters<typeof request>[1] = {}): Promise<EchoReply> => {
  const reply = await request(port, opts);
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body) as EchoReply;
};

const getStats = async (port: number): Promise<SimStats> => {
  const reply = await request(port, { path: '/__sim/stats' });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body) as SimStats;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns a truthy value (generous timeout: CI machines are slow). */
const waitFor = async <T>(check: () => T | Promise<T>, timeoutMs = 15_000): Promise<NonNullable<T>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await sleep(25);
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Fixture apps and sim lifecycle (every sim is closed after each test; no child process may survive close())
// ---------------------------------------------------------------------------------------------------------------

let root: string;
let appCounter = 0;
const sims: Sim[] = [];
const logs: string[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'altis-sim-test-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  const open = sims.splice(0);
  for (const sim of open) {
    const pids = sim.stats().workers.map((w) => w.pid);
    await sim.close();
    for (const pid of pids) expect(isAlive(pid), `worker ${pid} survived close()`).toBe(false);
    if (sim.tmpDir) expect(fs.existsSync(sim.tmpDir), 'socket dir not removed').toBe(false);
  }
  logs.length = 0;
});

/** A throwaway app directory whose app.js is the given fixture (package.json says commonjs, like the real zip). */
const makeApp = (fixture: string): string => {
  const dir = path.join(root, `app-${appCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), path.join(dir, 'app.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  return dir;
};

const startApp = async (
  fixture: string,
  options: Partial<SimOptions> = {},
): Promise<{ sim: Sim; dir: string; port: number }> => {
  const dir = makeApp(fixture);
  // idleMs defaults to a minute so that no test sees a worker disappear for the wrong reason.
  const sim = await startSim({ app: dir, port: 0, idleMs: 60_000, log: (line) => logs.push(line), ...options });
  sims.push(sim);
  return { sim, dir, port: sim.port };
};

// ---------------------------------------------------------------------------------------------------------------
// The brief's behaviours
// ---------------------------------------------------------------------------------------------------------------

describe('passenger-sim: second listen()', () => {
  it('logs "passenger-sim: second listen()" and answers 503 to the first request', async () => {
    const { port } = await startApp('two-listen.cjs');

    const reply = await request(port);

    expect(reply.status).toBe(503);
    await waitFor(() => logs.some((line) => line.includes('passenger-sim: second listen()')));
    // The crashed worker is gone and nothing is left to serve.
    await waitFor(async () => (await getStats(port)).workers.length === 0);
  });
});

describe('passenger-sim: forwarding', () => {
  it('forces the peer to 127.0.0.1 and appends the client address to X-Forwarded-For', async () => {
    const { port } = await startApp('echo.cjs');

    const plain = await echo(port);
    expect(plain.remoteAddress).toBe('127.0.0.1');
    expect(plain.remoteFamily).toBe('IPv4');
    expect(plain.xff).toBe('127.0.0.1');
    expect(plain.xfp).toBe('http');

    const chained = await echo(port, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(chained.xff).toBe('203.0.113.9, 127.0.0.1');
    expect(chained.xff?.endsWith('127.0.0.1')).toBe(true);
  });

  it('fills X-Forwarded-Proto but keeps one that the client (a TLS-terminating front) already sent', async () => {
    const { port } = await startApp('echo.cjs');

    expect((await echo(port)).xfp).toBe('http');
    expect((await echo(port, { headers: { 'x-forwarded-proto': 'https' } })).xfp).toBe('https');
  });

  it('forwards method, path, query, host and body unchanged', async () => {
    const { port } = await startApp('echo.cjs');

    const reply = await echo(port, {
      method: 'POST',
      path: '/a/b?x=1&y=%C3%A9',
      headers: { host: 'library.example.test', 'content-type': 'text/plain' },
      body: 'hello perpustakaan',
    });

    expect(reply.method).toBe('POST');
    expect(reply.url).toBe('/a/b?x=1&y=%C3%A9');
    expect(reply.host).toBe('library.example.test');
    expect(reply.body).toBe('hello perpustakaan');
  });

  it('gives the app the Passenger environment, the PhusionPassenger global, a socket address and its own cwd', async () => {
    const { port, dir } = await startApp('echo.cjs');

    const reply = await echo(port);

    expect(reply.inPassenger).toBe('1');
    expect(reply.appEnv).toBe('production');
    expect(reply.passengerGlobal).toBe('object');
    // listen(0, '127.0.0.1') was redirected: the server sits on a socket path, not on a TCP port.
    expect(typeof reply.address).toBe('string');
    expect(fs.realpathSync(reply.cwd)).toBe(fs.realpathSync(dir));
    // SIM_SOCKET is consumed by the shim so that processes forked by the app do not inherit it.
    expect(reply.simSocketInEnv).toBe(false);
  });

  it('passes every Set-Cookie header and streamed (chunked) bodies through', async () => {
    const { port } = await startApp('echo.cjs');

    const cookies = await request(port, { path: '/cookies' });
    expect(cookies.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);

    const chunks = await request(port, { path: '/chunks' });
    expect(chunks.status).toBe(200);
    expect(chunks.body).toBe('first,second');
  });

  it('leaves a process forked by the app alone (the shim is inert outside the worker)', async () => {
    const { port } = await startApp('forker.cjs');

    const reply = await request(port);
    expect(reply.status).toBe(200);
    // The helper may still be starting on the very first request: poll until it reported its address.
    const address = await waitFor(async () => {
      const body = JSON.parse((await request(port)).body) as { helperAddress: { port: number } | null };
      return body.helperAddress;
    });
    expect(typeof address.port).toBe('number');
    const helper = await request(address.port);
    expect(helper.body).toBe('helper');
  });
});

describe('passenger-sim: worker environment', () => {
  it('sets NODE_ENV from PASSENGER_APP_ENV (production) whatever the supervisor runs with', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const { port } = await startApp('echo.cjs');
      const reply = await echo(port); // the worker is spawned here, while the stub is in place
      expect(reply.appEnv).toBe('production');
      expect(reply.nodeEnv).toBe('production');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('passenger-sim: streaming and early responses', () => {
  /** Resolves with the time (ms) between sending the request and receiving the response head; then hangs up. */
  const timeToHead = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const req = http.request({ host: '127.0.0.1', port, path: '/events', agent: false }, (res) => {
        const elapsed = Date.now() - started;
        res.on('error', () => {});
        req.destroy();
        resolve(elapsed);
      });
      req.on('error', (err) => {
        if (!req.destroyed) reject(err);
      });
      req.end();
    });

  it('sends the response head as soon as the app flushes it (server-sent events do not wait for a body)', async () => {
    const { port } = await startApp('sse.cjs');
    await timeToHead(port); // cold: includes spawning the worker
    await waitFor(async () => (await getStats(port)).workers.every((w) => !w.busy));

    expect(await timeToHead(port)).toBeLessThan(500);
  });

  type Upload = { status: number; body: string; error: Error | undefined };

  /** POSTs `megabytes` MiB with a plain Node client and reports what it saw once the request is fully over. */
  const upload = (port: number, megabytes: number): Promise<Upload> =>
    new Promise((resolve) => {
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/upload',
        headers: { 'content-length': megabytes * chunk.length },
        agent: false,
      });
      let status = 0;
      let body = '';
      let error: Error | undefined;
      req.on('error', (err) => (error ??= err));
      req.on('response', (res) => {
        status = res.statusCode ?? 0;
        res.on('data', (data: Buffer) => (body += data.toString('utf8')));
        res.on('error', (err) => (error ??= err));
      });
      req.on('close', () => resolve({ status, body, error }));
      let sent = 0;
      const writeMore = (): void => {
        while (sent < megabytes) {
          sent += 1;
          if (!req.write(chunk)) {
            req.once('drain', writeMore);
            return;
          }
        }
        req.end();
      };
      writeMore();
    });

  it.each([1, 5, 30])(
    'delivers the 413 of an app that refuses a %i MB upload unread, every time (no 502, no reset)',
    async (megabytes) => {
      const { port } = await startApp('reject-upload.cjs');

      for (let run = 1; run <= 20; run++) {
        const result = await upload(port, megabytes);
        expect(result, `${megabytes} MB upload, run ${run}`).toEqual({ status: 413, body: 'payload too large', error: undefined });
      }
      expect((await getStats(port)).workers).toHaveLength(1); // the same worker served every run
    },
  );

  it('does not leave upstream sockets open after the app refused uploads unread', async () => {
    const { port } = await startApp('reject-upload.cjs');
    for (let run = 1; run <= 10; run++) {
      expect((await upload(port, 5)).status, `run ${run}`).toBe(413);
    }

    // Only the probing request itself may still be connected to the app.
    const connections = async (): Promise<number> => Number((await request(port, { path: '/connections' })).body);
    await waitFor(async () => (await connections()) === 1, 3000);
  });

  it('lets an app that flushes its head first read the whole upload before it answers', async () => {
    const { port } = await startApp('progress-upload.cjs');

    expect(await upload(port, 5)).toEqual({ status: 200, body: 'got 5242880', error: undefined });
  });

  it('delivers its own 503 (queue full) to a client that is still sending a large upload', async () => {
    const { port } = await startApp('echo.cjs', { maxPool: 1, maxQueue: 1 });
    // One request running on the only worker, one waiting in the queue: the pool is saturated.
    const hold = [1, 2].map(() => {
      const req = http.request({ host: '127.0.0.1', port, path: '/slow?ms=20000', agent: false });
      req.on('error', () => {}); // destroyed at the end of the test
      req.end();
      return req;
    });
    await waitFor(async () => (await getStats(port)).queued === 1);

    for (let run = 1; run <= 10; run++) {
      const result = await upload(port, 5);
      expect(result.error, `run ${run}`).toBeUndefined();
      expect(result.status, `run ${run}`).toBe(503);
      expect(result.body, `run ${run}`).toContain('queue is full');
    }

    for (const req of hold) req.destroy();
  });
});

describe('passenger-sim: pool lifecycle', () => {
  it('spawns a worker on demand, and only then', async () => {
    const { port } = await startApp('echo.cjs');
    expect((await getStats(port)).workers).toEqual([]);

    const before = Date.now();
    const reply = await echo(port);

    const stats = await getStats(port);
    expect(stats.queued).toBe(0);
    expect(stats.workers).toHaveLength(1);
    expect(stats.workers[0]?.pid).toBe(reply.pid);
    expect(stats.workers[0]?.busy).toBe(false);
    expect(stats.workers[0]?.startedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(stats.workers[0]?.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it('kills a worker that has been idle for idle-ms, and spawns a fresh one for the next request', async () => {
    const { port } = await startApp('echo.cjs', { idleMs: 300 });
    const first = await echo(port);
    expect((await getStats(port)).workers).toHaveLength(1);

    await waitFor(async () => (await getStats(port)).workers.length === 0);
    expect(isAlive(first.pid)).toBe(false);

    const second = await echo(port);
    expect(second.pid).not.toBe(first.pid);
  });

  it('serves the next request from a new pid after tmp/restart.txt is touched, and only once per touch', async () => {
    const { port, dir } = await startApp('echo.cjs');
    const first = await echo(port);
    expect((await echo(port)).pid).toBe(first.pid);

    fs.mkdirSync(path.join(dir, 'tmp'));
    const restartFile = path.join(dir, 'tmp', 'restart.txt');
    fs.writeFileSync(restartFile, '');
    const second = await echo(port);
    expect(second.pid).not.toBe(first.pid);
    expect((await echo(port)).pid).toBe(second.pid); // no restart loop
    await waitFor(async () => !(await getStats(port)).workers.some((w) => w.pid === first.pid));
    expect(isAlive(first.pid)).toBe(false);

    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(restartFile, later, later); // `touch`
    const third = await echo(port);
    expect(third.pid).not.toBe(second.pid);
  });

  it('lets an in-flight request finish on the old worker when restart.txt is touched meanwhile', async () => {
    const { port, dir } = await startApp('echo.cjs');
    const warm = await echo(port);

    const slow = echo(port, { path: '/slow?ms=800' });
    await waitFor(async () => (await getStats(port)).workers.some((w) => w.busy));
    fs.mkdirSync(path.join(dir, 'tmp'));
    fs.writeFileSync(path.join(dir, 'tmp', 'restart.txt'), '');

    const fresh = await echo(port);
    expect(fresh.pid).not.toBe(warm.pid);
    expect((await slow).pid).toBe(warm.pid);
    await waitFor(async () => !(await getStats(port)).workers.some((w) => w.pid === warm.pid));
  });

  it('restarts within a full pool: the request waits for the old worker to leave, then gets a new one', async () => {
    const { port, dir } = await startApp('echo.cjs', { maxPool: 1 });
    const first = await echo(port);

    fs.mkdirSync(path.join(dir, 'tmp'));
    fs.writeFileSync(path.join(dir, 'tmp', 'restart.txt'), '');
    const second = await echo(port);

    expect(second.pid).not.toBe(first.pid);
    expect(isAlive(first.pid)).toBe(false);
    expect((await getStats(port)).workers).toHaveLength(1);
  });

  it('runs one request per worker and spawns up to max-pool workers for concurrent requests', async () => {
    const { port } = await startApp('echo.cjs', { maxPool: 2, maxQueue: 5 });

    const replies = await Promise.all([1, 2, 3].map(() => echo(port, { path: '/slow?ms=800' })));

    expect(new Set(replies.map((r) => r.pid)).size).toBe(2);
    expect((await getStats(port)).workers).toHaveLength(2);
  });

  it('answers 503 to exactly the request that overflows max-queue', async () => {
    const { port } = await startApp('echo.cjs', { maxPool: 1, maxQueue: 1 });

    const replies = Promise.all([1, 2, 3].map(() => request(port, { path: '/slow?ms=1000' })));

    // One request runs on the only worker, one waits in the queue.
    await waitFor(async () => (await getStats(port)).queued === 1);
    const settled = await replies;
    expect(settled.map((r) => r.status).sort()).toEqual([200, 200, 503]);
    expect((await getStats(port)).queued).toBe(0);
  });

  it('drops a queued request whose client goes away, without disturbing the running one', async () => {
    const { port } = await startApp('echo.cjs', { maxPool: 1, maxQueue: 5 });
    await echo(port); // warm

    const running = request(port, { path: '/slow?ms=600' });
    await waitFor(async () => (await getStats(port)).workers.some((w) => w.busy));
    const queued = http.request({ host: '127.0.0.1', port, path: '/', agent: false });
    queued.on('error', () => {}); // the abort below surfaces as ECONNRESET
    queued.end();
    await waitFor(async () => (await getStats(port)).queued === 1);

    queued.destroy();

    await waitFor(async () => (await getStats(port)).queued === 0);
    expect((await running).status).toBe(200);
    const stats = await getStats(port);
    expect(stats.workers).toHaveLength(1);
    expect(stats.queued).toBe(0);
  });

  it('answers 503 at once when the app simply ends without listening (and relays its output)', async () => {
    const { port } = await startApp('exit-early.cjs');

    expect((await request(port)).status).toBe(503);

    await waitFor(() => logs.some((line) => line.includes('exit-early: nothing to serve')));
    await waitFor(() => logs.some((line) => line.includes('exited before listening')));
    expect((await getStats(port)).workers).toEqual([]);
  });

  it('answers 503 and kills the worker when it does not listen within start-timeout-ms', async () => {
    const { port } = await startApp('never-listen.cjs', { startTimeoutMs: 500 });

    const reply = request(port);
    const worker = await waitFor(async () => (await getStats(port)).workers[0]);
    expect((await reply).status).toBe(503);

    await waitFor(() => logs.some((line) => line.includes('did not listen within 500 ms')));
    await waitFor(async () => (await getStats(port)).workers.length === 0);
    expect(isAlive(worker.pid)).toBe(false);
  });
});

describe('passenger-sim: kill-random', () => {
  it('POST /__sim/kill-random kills a worker; the next request is served by a new pid', async () => {
    const { port } = await startApp('echo.cjs');
    const first = await echo(port);

    const kill = await request(port, { method: 'POST', path: '/__sim/kill-random' });
    expect(kill.status).toBe(200);
    expect(JSON.parse(kill.body)).toEqual({ killed: first.pid });
    expect(isAlive(first.pid)).toBe(false);
    expect((await getStats(port)).workers).toEqual([]);

    const second = await echo(port);
    expect(second.pid).not.toBe(first.pid);
  });

  it('reports {killed: null} when there is no worker', async () => {
    const { port } = await startApp('echo.cjs');
    const kill = await request(port, { method: 'POST', path: '/__sim/kill-random' });
    expect(JSON.parse(kill.body)).toEqual({ killed: null });
  });

  it('answers 502 to a request whose worker dies while serving it', async () => {
    const { port } = await startApp('echo.cjs');
    await echo(port); // warm: the worker is listening before the slow request arrives

    const slow = request(port, { path: '/slow?ms=10000' });
    await waitFor(async () => (await getStats(port)).workers.some((w) => w.busy));
    await request(port, { method: 'POST', path: '/__sim/kill-random' });

    expect((await slow).status).toBe(502);
  });
});

describe('passenger-sim: control endpoints and shutdown', () => {
  it('rejects wrong methods and unknown control paths instead of forwarding them to the app', async () => {
    const { port } = await startApp('echo.cjs');

    const post = await request(port, { method: 'POST', path: '/__sim/stats' });
    expect(post.status).toBe(405);
    expect(post.headers['allow']).toBe('GET');
    const get = await request(port, { path: '/__sim/kill-random' });
    expect(get.status).toBe(405);
    expect(get.headers['allow']).toBe('POST');
    expect((await request(port, { path: '/__sim/nope' })).status).toBe(404);
    expect((await getStats(port)).workers).toEqual([]); // none of the above reached (or spawned) the app
  });

  it('binds 127.0.0.1 by default, and serves /__sim/* to loopback peers only even when bound wider', async (ctx) => {
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address;
    const { sim, port } = await startApp('echo.cjs');
    expect(sim.host).toBe('127.0.0.1');
    if (!external) ctx.skip('no non-loopback IPv4 interface on this machine');

    await expect(request(port, { host: external })).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    const wide = await startApp('echo.cjs', { host: '0.0.0.0' });
    expect((await request(wide.port, { host: external, path: '/__sim/stats' })).status).toBe(403);
    expect(
      (await request(wide.port, { host: external, method: 'POST', path: '/__sim/kill-random' })).status,
    ).toBe(403);
    expect((await request(wide.port, { host: '127.0.0.1', path: '/__sim/stats' })).status).toBe(200);
    expect((await request(wide.port, { host: external })).status).toBe(200); // the app itself is reachable
  });

  it.skipIf(process.platform === 'win32')(
    'keeps worker sockets in a private (0700) temp dir that close() removes',
    async () => {
      const { sim, port } = await startApp('echo.cjs');
      const tmpDir = sim.tmpDir;
      if (!tmpDir) throw new Error('POSIX sims have a socket dir');
      expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700);

      await echo(port);
      expect(fs.readdirSync(tmpDir).filter((name) => name.endsWith('.sock'))).toHaveLength(1);

      await sim.close();
      expect(fs.existsSync(tmpDir)).toBe(false);
    },
  );

  // Windows has no catchable SIGTERM: terminating a process there is always forceful.
  it.skipIf(process.platform === 'win32')(
    'close() escalates to SIGKILL for a worker that ignores SIGTERM, then refuses new requests',
    async () => {
      const { sim, port } = await startApp('stubborn.cjs', { killGraceMs: 300 });
      const pid = Number((await request(port)).body);
      expect(isAlive(pid)).toBe(true);

      const started = Date.now();
      await sim.close();

      expect(isAlive(pid)).toBe(false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(logs.some((line) => line.includes('SIGKILL'))).toBe(true);
      await expect(request(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    },
  );

  it('refuses to start when the app directory has no app.js', async () => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    await expect(startSim({ app: empty, port: 0, log: () => {} })).rejects.toThrow(/app\.js/);
  });
});

describe('passenger-sim: shim.cjs', () => {
  // The shim must parse on any Node a worker may run on, like app.js: eslint.config.js lints it as ES2017.
  const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.js') });
  const shimPath = path.join(HERE, '..', 'shim.cjs');
  const lint = async (code: string) => {
    const [result] = await eslint.lintText(code, { filePath: shimPath });
    if (!result) throw new Error('no lint result');
    return result.messages;
  };

  it('is clean ES2017 CommonJS', async () => {
    expect(await lint(fs.readFileSync(shimPath, 'utf8'))).toEqual([]);
  });

  it.each([
    ['nullish coalescing', 'var a = process.env.X ?? 1;\n'],
    ['optional chaining', 'var b = process.env?.X;\n'],
  ])('rejects %s', async (_name, code) => {
    const messages = await lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('Parsing error');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

describe('passenger-sim CLI: argument parsing', () => {
  it('requires --app and --port and leaves every other option to the defaults', () => {
    expect(parseCliArgs(['--app', 'x', '--port', '8080'])).toEqual({ app: 'x', port: 8080 });
  });

  it('reads every documented option', () => {
    expect(
      parseCliArgs([
        '--app', 'dir',
        '--port', '0',
        '--max-pool', '6',
        '--idle-ms', '300',
        '--start-timeout-ms', '1000',
        '--max-queue', '7',
        '--host', '127.0.0.2',
      ]),
    ).toEqual({
      app: 'dir',
      port: 0,
      maxPool: 6,
      idleMs: 300,
      startTimeoutMs: 1000,
      maxQueue: 7,
      host: '127.0.0.2',
    });
  });

  it.each([
    [[], /--app/],
    [['--app', 'x'], /--port/],
    [['--app', 'x', '--port', 'abc'], /--port/],
    [['--app', 'x', '--port', '70000'], /--port/],
    [['--app', 'x', '--port', '1', '--max-pool', '0'], /--max-pool/],
    [['--app', 'x', '--port', '1', '--idle-ms', '-5'], /--idle-ms/],
    [['--app', 'x', '--port', '1', '--max-queue', '1.5'], /--max-queue/],
    [['--app', 'x', '--port', '1', '--start-timeout-ms', ''], /--start-timeout-ms/],
    [['--app', 'x', '--port', '1', '--bogus'], /--bogus/],
    [['--app', 'x', '--port', '1', 'extra'], /extra/],
  ])('rejects %j with a usage error', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

describe('passenger-sim CLI: as a process (sim.ts under tsx)', () => {
  type Run = { child: ChildProcess; stdout: () => string; stderr: () => string; exited: Promise<number | null> };
  const running: ChildProcess[] = [];
  const workerPids: number[] = [];
  // A supervisor that is SIGKILLed cannot remove its socket dir, so the CLI runs with a private (short: unix socket
  // paths are limited to ~104 bytes) TMPDIR that this suite deletes.
  let cliTmp: string;

  beforeAll(() => {
    cliTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asim-'));
  });

  afterAll(() => {
    fs.rmSync(cliTmp, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const child of running.splice(0)) child.kill('SIGKILL');
    for (const pid of workerPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  /** Socket dirs in the private TMPDIR (tsx keeps its own cache dir there too). */
  const socketDirs = (): string[] => fs.readdirSync(cliTmp).filter((name) => name.startsWith('altis-sim-'));

  const runSim = (args: string[]): Run => {
    const child = spawn(process.execPath, ['--import', 'tsx', SIM_TS, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: cliTmp, TMP: cliTmp, TEMP: cliTmp },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    return { child, stdout: () => stdout, stderr: () => stderr, exited };
  };

  const startCli = async (): Promise<Run & { port: number }> => {
    const run = runSim(['--app', makeApp('echo.cjs'), '--port', '0', '--idle-ms', '60000']);
    const match = await waitFor(() => /passenger-sim: listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(run.stdout()));
    const port = Number(match[1]);
    expect(port).toBeGreaterThan(0);
    return { ...run, port };
  };

  it.skipIf(process.platform === 'win32')(
    'prints the listening address, serves requests, and on SIGTERM stops its workers and exits 0',
    async () => {
      const before = socketDirs();
      const cli = await startCli();
      expect(socketDirs()).toHaveLength(before.length + 1);
      const reply = await echo(cli.port);
      workerPids.push(reply.pid);
      expect((await getStats(cli.port)).workers.map((w) => w.pid)).toEqual([reply.pid]);

      cli.child.kill('SIGTERM');

      expect(await cli.exited).toBe(0);
      expect(isAlive(reply.pid)).toBe(false);
      expect(socketDirs()).toEqual(before); // the socket dir is gone
      // stderr is the log: supervisor lines and relayed worker output only, no warnings or stack traces.
      const lines = cli.stderr().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toMatch(/^(passenger-sim: |\[worker \d+\] )/);
      expect(cli.stderr()).not.toMatch(/error|warning/i);
    },
  );

  it('leaves no orphan worker behind when the supervisor is killed outright', async () => {
    const before = socketDirs();
    const cli = await startCli();
    const reply = await echo(cli.port);
    workerPids.push(reply.pid);

    cli.child.kill('SIGKILL');
    await cli.exited;

    await waitFor(() => !isAlive(reply.pid)); // the worker exits when the IPC channel to its parent closes
    expect(socketDirs()).toHaveLength(before.length + 1); // what a SIGKILLed supervisor cannot clean up
  });

  it('exits 2 with the usage text on a bad command line', async () => {
    const run = runSim(['--port', '1']);

    expect(await run.exited).toBe(2);
    expect(run.stderr()).toContain('--app');
    expect(run.stderr()).toContain('Usage');
  });

  it('exits 1 when the port is taken', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const before = socketDirs();
    try {
      const { port } = blocker.address() as AddressInfo;
      const run = runSim(['--app', makeApp('echo.cjs'), '--port', String(port)]);

      expect(await run.exited).toBe(1);
      expect(run.stderr()).toContain('EADDRINUSE');
      expect(socketDirs()).toEqual(before); // a failed start does not leave its socket dir behind
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
