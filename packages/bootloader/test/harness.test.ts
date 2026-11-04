import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { freePort, portIsFree, useHarness, waitForHttp } from './helpers/harness.js';

// The black-box harness itself (fixNow 10): ports that parallel workers and outgoing sockets cannot take before
// app.js binds them, and waits that end as soon as the app they wait for has exited.

const h = useHarness();

/** The lowest port of the ephemeral range on Linux (32768–60999); macOS and Windows start at 49152. */
const EPHEMERAL_FLOOR = 32_768;

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

describe('freePort', () => {
  it('hands out distinct, bindable ports below every ephemeral range', async () => {
    const ports = [await freePort(), await freePort(), await freePort()];
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(1024);
      expect(port).toBeLessThan(EPHEMERAL_FLOOR);
      expect(await canBind(port)).toBe(true);
    }
  });

  // macOS lets a server bind `::` (app.js's listen(port)) next to another one on 0.0.0.0 or 127.0.0.1 of the same
  // port; the test's requests to 127.0.0.1 then reach that other server.
  it.each([undefined, '0.0.0.0', '127.0.0.1'])('does not take a port that something already listens on (host %s)', async (host) => {
    const taken = await freePort();
    expect(await portIsFree(taken)).toBe(true);
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen({ port: taken, host }, resolve));
    try {
      expect(await portIsFree(taken)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('waitForHttp', { timeout: 30_000 }, () => {
  it('fails at once, naming the exit code and the stderr, when the app it waits for has exited', async () => {
    const sb = await h.sandbox();
    // A port setting that is not a port: app.js says so and exits 1 without ever listening on sb.port.
    const app = h.spawn(sb, { env: { ALTIS_PORT: '70000' } });
    await app.exited;
    const asked = performance.now();
    const failure = await waitForHttp(sb.port, '/_health').then(
      () => new Error('waitForHttp resolved'),
      (error: unknown) => error as Error,
    );
    expect(performance.now() - asked).toBeLessThan(2000);
    expect(failure.message).toMatch(/exited with code 1/);
    expect(failure.message).toContain('ALTIS_PORT');
  });

  it('names the last status it saw when it times out', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end('not yet');
    });
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, resolve));
    try {
      await expect(waitForHttp(port, '/_health', (r) => r.status === 200, 300)).rejects.toThrow(/last status 503/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
