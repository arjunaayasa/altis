import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRAIN_MS } from '../src/restart.js';
import { healthJson, httpGet, pidAlive, useHarness, waitFor, waitForHttp } from './helpers/harness.js';

// ctx.requestRestart(reason) per runtime (P14): Passenger/LiteSpeed touch <appRoot>/tmp/restart.txt and keep
// running; PM2/Docker/service drain and exit 75; standalone exits 75 to its supervisor, which forks a new child.

const h = useHarness();

describe('requestRestart', { timeout: 30_000 }, () => {
  it.each(['passenger', 'litespeed'])('%s: touches tmp/restart.txt, updates its mtime, does not exit', async (runtime) => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { env: { ALTIS_RUNTIME: runtime } });
    await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    const restartFile = path.join(sb.appRoot, 'tmp', 'restart.txt');
    await expect(fsp.stat(restartFile)).rejects.toThrow();

    expect((await httpGet(sb.port, '/__restart')).status).toBe(202);
    expect((await fsp.stat(restartFile)).isFile()).toBe(true);

    const past = new Date('2001-01-01T00:00:00Z');
    await fsp.utimes(restartFile, past, past);
    const before = Date.now();
    expect((await httpGet(sb.port, '/__restart')).status).toBe(202);
    expect((await fsp.stat(restartFile)).mtimeMs).toBeGreaterThanOrEqual(before - 2000);

    await new Promise((resolve) => setTimeout(resolve, DRAIN_MS + 500));
    const health = await httpGet(sb.port, '/_health');
    expect(health.status).toBe(200);
    expect(healthJson(health)['pid']).toBe(app.pid);
    expect(app.exitedAt()).toBeUndefined();
  });

  it.each(['pm2', 'docker', 'service'])('%s: keeps serving while it drains, then exits with 75', async (runtime) => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { env: { ALTIS_RUNTIME: runtime } });
    await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    const asked = performance.now();
    expect((await httpGet(sb.port, '/__restart')).status).toBe(202);
    expect((await httpGet(sb.port, '/_health')).status).toBe(200);
    const exit = await app.exited;
    expect(exit).toEqual({ code: 75, signal: null });
    expect((app.exitedAt() as number) - asked).toBeGreaterThanOrEqual(DRAIN_MS - 50);
  });

  it('standalone: the supervised child exits 75 after the drain and a new child takes over', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { env: { ALTIS_RUNTIME: undefined } });
    const first = healthJson(await waitForHttp(sb.port, '/_health', (r) => r.status === 200))['pid'] as number;
    h.track(first);
    expect((await httpGet(sb.port, '/__restart')).status).toBe(202);
    const second = healthJson(
      await waitForHttp(sb.port, '/_health', (r) => r.status === 200 && healthJson(r)['pid'] !== first, DRAIN_MS + 10_000),
    )['pid'] as number;
    h.track(second);
    await waitFor(() => !pidAlive(first), 'the first child to be gone');
    expect(app.exitedAt()).toBeUndefined();
  });
});
