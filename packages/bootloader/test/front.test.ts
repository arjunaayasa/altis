import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRON_HOLD_MAX,
  CRON_HOLD_MS,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  openFront,
  startingHandler,
  type Front,
} from '../src/front.js';
import { createLog } from '../src/log.js';
import { freePort } from './helpers/harness.js';

// front.ts in this process (fixNow 3): app.js's one http.Server, which cannot be changed once the first public release
// has shipped app.js. `listening` must settle whichever way the host's loader reports the listen, and a handler that
// fails must never cut a response it already finished.

const fronts: Front[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    fronts.splice(0).map(
      (front) =>
        new Promise<void>((resolve) => {
          if (!front.server.listening) return resolve();
          front.server.close(() => resolve());
          front.server.closeAllConnections();
        }),
    ),
  );
});

const silentLog = (): ReturnType<typeof createLog> => {
  const log = createLog();
  for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
  return log;
};

async function open(
  handler?: http.RequestListener,
  o?: { cronHoldMs?: number },
): Promise<{ front: Front; port: number; log: ReturnType<typeof createLog> }> {
  const port = await freePort();
  const log = silentLog();
  const front = openFront(port, log, o);
  fronts.push(front);
  await front.listening;
  if (handler !== undefined) void front.use(handler);
  return { front, port, log };
}

interface Reply {
  status: number;
  body: string;
  reusedSocket: boolean;
}

function get(port: number, urlPath: string, agent: http.Agent | false = false): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, reusedSocket: req.reusedSocket }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** A request with `method` and `body` on a connection of its own; `onRequest` gets the client request (to abort it). */
function send(port: number, method: string, urlPath: string, body?: string, onRequest?: (req: http.ClientRequest) => void): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, reusedSocket: false }));
      res.on('error', reject);
    });
    req.on('error', reject);
    onRequest?.(req);
    req.end(body);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `p` is still pending after `ms`. */
async function pendingAfter(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => false, () => false), sleep(ms).then(() => true)]);
}

/** The release's handler of these tests: echoes the method, the URL and the body it read. */
const echo: http.RequestListener = (req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => (body += chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${req.method} ${req.url} ${body}`);
  });
};

describe('openFront: a POST /_cron while no release serves (ruling R1c-14)', () => {
  it('is held, then handed with its body to the handler use() installs; other requests get "starting" at once', async () => {
    expect(CRON_HOLD_MS).toBe(15_000);
    const { front, port } = await open();
    const cron = send(port, 'POST', '/_cron', 'ping');
    expect(await pendingAfter(cron, 200)).toBe(true);
    expect((await get(port, '/catalog')).status).toBe(503);
    expect((await get(port, '/_cron')).status).toBe(503); // only a POST is held
    expect((await send(port, 'POST', '/api/v1/auth/login', '{}')).status).toBe(503);
    void front.use(echo);
    expect(await cron).toMatchObject({ status: 200, body: 'POST /_cron ping' });
  });

  it('a starting handler put in place again (a release whose start() failed) keeps holding it', async () => {
    const { front, port } = await open();
    const cron = send(port, 'POST', '/_cron?x=1');
    expect(await pendingAfter(cron, 100)).toBe(true);
    void front.use(startingHandler());
    expect(await pendingAfter(cron, 100)).toBe(true);
    void front.use(echo);
    expect(await cron).toMatchObject({ status: 200, body: 'POST /_cron?x=1 ' });
  });

  it('when no release serves within the hold time: the "starting" page', async () => {
    const { port } = await open(undefined, { cronHoldMs: 300 });
    const t0 = performance.now();
    const reply = await send(port, 'POST', '/_cron');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
    expect(reply.status).toBe(503);
    expect(reply.body).toContain('ALTIS is starting');
  });

  it(`holds at most ${CRON_HOLD_MAX} at once: one more is answered "starting" at once`, async () => {
    const { front, port } = await open();
    const held = [];
    for (let i = 0; i < CRON_HOLD_MAX; i += 1) held.push(send(port, 'POST', `/_cron?n=${i}`));
    await sleep(200);
    const extra = await send(port, 'POST', '/_cron?n=extra');
    expect(extra.status).toBe(503);
    for (const p of held) expect(await pendingAfter(p, 0)).toBe(true);
    void front.use(echo);
    expect((await Promise.all(held)).map((r) => r.status)).toEqual(Array.from({ length: CRON_HOLD_MAX }, () => 200));
  });

  it('a held request whose client went away never reaches the handler', async () => {
    const { front, port } = await open();
    let client: http.ClientRequest | undefined;
    const cron = send(port, 'POST', '/_cron', undefined, (req) => (client = req));
    await sleep(150);
    client!.destroy();
    await expect(cron).rejects.toThrow();
    await sleep(100);
    const handler = vi.fn(echo);
    void front.use(handler);
    expect((await send(port, 'POST', '/_cron')).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('openFront: listening', () => {
  it('settles on the listening event when the loader drops the callback of listen()', async () => {
    const original = http.Server.prototype.listen;
    vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: unknown[]) {
      if (typeof args[args.length - 1] === 'function') args.pop();
      return original.apply(this, args as Parameters<typeof original>);
    });
    const port = await freePort();
    const front = openFront(port, silentLog());
    fronts.push(front);
    const outcome = await Promise.race([
      front.listening.then(() => 'listening'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 2000)),
    ]);
    expect(outcome).toBe('listening');
    expect((await get(port, '/_health')).status).toBe(503); // "starting"
  });

  it('rejects with the error of listen() when the port is taken', async () => {
    const { port } = await open();
    const second = openFront(port, silentLog());
    fronts.push(second);
    await expect(second.listening).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('openFront: keep-alive timeouts (1d Task 22, deferred item 14)', () => {
  it('the one server keeps an idle keep-alive connection 65 s, and waits 66 s for request headers', async () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
    expect(HEADERS_TIMEOUT_MS).toBe(66_000);
    const { front } = await open();
    expect(front.server.keepAliveTimeout).toBe(65000);
    expect(front.server.headersTimeout).toBe(66000);
    expect(front.server.headersTimeout).toBeGreaterThan(front.server.keepAliveTimeout);
  });

  // Node's default is 5 s (plus, from Node 24, a 1 s `keepAliveTimeoutBuffer`): 7 s of idling outlasts both.
  it("a keep-alive connection idle longer than Node's default is reused, not closed under the client", { timeout: 20_000 }, async () => {
    const { port } = await open((_req, res) => {
      res.end('ok');
    });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect(await get(port, '/first', agent)).toEqual({ status: 200, body: 'ok', reusedSocket: false });
      await sleep(7000);
      expect(await get(port, '/second', agent)).toEqual({ status: 200, body: 'ok', reusedSocket: true });
    } finally {
      agent.destroy();
    }
  });
});

describe('openFront: a handler that fails', () => {
  const BIG = 'x'.repeat(8 * 1024 * 1024);

  it('after it ended its response: the whole body arrives, the keep-alive connection stays usable, it is logged', async () => {
    const { port, log } = await open((req, res) => {
      if (req.url === '/end-then-reject') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(BIG.length) });
        res.end(BIG);
        return Promise.reject(new Error('failed after the end')) as unknown as void;
      }
      res.end('second');
    });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await get(port, '/end-then-reject', agent);
      expect(first.status).toBe(200);
      expect(first.body.length).toBe(BIG.length);
      const second = await get(port, '/next', agent);
      expect(second).toEqual({ status: 200, body: 'second', reusedSocket: true });
    } finally {
      agent.destroy();
    }
    expect(log.error).toHaveBeenCalledWith('request handler failed', expect.objectContaining({ err: expect.any(Error) }));
  });

  it('after it sent headers but not the end: the connection is cut', async () => {
    const { port } = await open((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
      res.write('partial');
      throw new Error('failed half way');
    });
    await expect(get(port, '/')).rejects.toThrow();
  });

  it('before anything was sent: 500 with a bilingual text', async () => {
    const { port } = await open(() => {
      throw new Error('failed at once');
    });
    const reply = await get(port, '/');
    expect(reply.status).toBe(500);
    expect(reply.body).toContain('internal error');
  });
});
