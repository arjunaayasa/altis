import { fork } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { healthJson, httpGet, logLines, pidAlive, useHarness, waitFor, waitForHttp } from './helpers/harness.js';

// Runtime `standalone` (P14): app.js forks itself and supervises the child. Exit 75 means "restart me"; a crash
// is restarted after a pause (1/2/4 s; ALTIS_TEST_SUPERVISOR_BACKOFF_MS scales it in test builds); five crashes
// within 60 s stop the supervisor. Signals are forwarded and a child never outlives its supervisor.

const h = useHarness();
/** No ALTIS_RUNTIME and no hosting markers in the clean environment: detectRuntime says `standalone`. */
const STANDALONE = { ALTIS_RUNTIME: undefined };

// Every wait below is for an event (a reply, a pid gone, a log line, an exit), with a deadline far above what it takes
// on an idle machine: under a full parallel suite, forking a child and starting tsx can take well over 10 s.
/** The deadline of one wait for a process event. */
const SLOW = 45_000;
/** The timeout of one test: a few such waits. */
const TEST_TIMEOUT = 120_000;

async function childPid(port: number, other?: number): Promise<number> {
  const reply = await waitForHttp(port, '/_health', (r) => r.status === 200 && healthJson(r)['pid'] !== other, SLOW);
  return healthJson(reply)['pid'] as number;
}

/** `promise`, or a failure naming `what` when it has not settled after `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

describe('standalone supervisor', { timeout: TEST_TIMEOUT }, () => {
  it('runs the server in a child and forks a new one when the child exits with 75', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { env: STANDALONE });
    const first = await childPid(sb.port);
    h.track(first);
    expect(first).not.toBe(app.pid);
    expect(healthJson(await httpGet(sb.port, '/_health'))['runtime']).toBe('standalone');

    await httpGet(sb.port, '/__exit?code=75');
    const second = await childPid(sb.port, first);
    h.track(second);
    expect(second).not.toBe(app.pid);
    await waitFor(() => !pidAlive(first), 'the first child to be gone', SLOW);
    expect(app.exitedAt()).toBeUndefined();
  });

  it('forwards SIGTERM to the child and exits with its code', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { env: STANDALONE });
    const child = await childPid(sb.port);
    h.track(child);
    app.child.kill('SIGTERM');
    expect(await within(app.exited, SLOW, 'the supervisor to exit')).toEqual({ code: 0, signal: null }); // the fixture exits 0 on SIGTERM
    await waitFor(() => !pidAlive(child), 'the child to be gone', SLOW);
  });

  it('leaves no orphan: the child exits when the supervisor dies', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { env: STANDALONE });
    const child = await childPid(sb.port);
    h.track(child);
    app.child.kill('SIGKILL');
    await within(app.exited, SLOW, 'the supervisor to die');
    await waitFor(() => !pidAlive(child), 'the orphaned child to exit', SLOW);
  });

  it('gives up after 5 crashes within 60 s with a bilingual message and exit code 1', async () => {
    const sb = await h.sandbox({ bundled: { startBehaviour: 'crash' } });
    const app = h.spawn(sb, { env: { ...STANDALONE, ALTIS_TEST_SUPERVISOR_BACKOFF_MS: '20' } });
    const exit = await within(app.exited, SLOW, 'the supervisor to give up');
    expect(exit.code).toBe(1);
    const stderr = app.stderr();
    expect(stderr).toContain('5 kali dalam 60 detik');
    expect(stderr).toContain('5 times within 60 seconds');
  });

  it('pauses between crash restarts (1 s, then 2 s by default)', async () => {
    const sb = await h.sandbox({ bundled: { startBehaviour: 'crash' } });
    const app = h.spawn(sb, { env: STANDALONE });
    // The supervisor's own log lines, in order: started, crashed, started (after the pause), crashed, started, …
    const events = (): { msg: string; at: number }[] =>
      logLines(app.stderr())
        .filter((l) => l['msg'] === 'server process started' || l['msg'] === 'server process crashed')
        .map((l) => ({ msg: l['msg'] as string, at: Date.parse(l['time'] as string) }));
    /** The `n`-th (0-based) crash and the start that followed it, once both are logged. */
    const restartAfterCrash = (n: number): { crashedAt: number; startedAt: number } | undefined => {
      const seen = events();
      const crashes = seen.flatMap((e, i) => (e.msg === 'server process crashed' ? [i] : []));
      const crash = crashes[n];
      if (crash === undefined) return undefined;
      const start = seen.findIndex((e, i) => i > crash && e.msg === 'server process started');
      return start === -1 ? undefined : { crashedAt: seen[crash]!.at, startedAt: seen[start]!.at };
    };
    await waitFor(() => restartAfterCrash(1) !== undefined, () => `two crash restarts; log so far:\n${app.stderr()}`, SLOW);

    const first = restartAfterCrash(0)!;
    const second = restartAfterCrash(1)!;
    expect(first.startedAt - first.crashedAt).toBeGreaterThanOrEqual(950);
    expect(second.startedAt - second.crashedAt).toBeGreaterThanOrEqual(1950);
    expect(app.exitedAt()).toBeUndefined();
  });

  it('a child whose port is taken exits 78: the supervisor exits 1 at once, with no crash restart', async () => {
    const sb = await h.sandbox();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(sb.port, resolve));
    try {
      const app = h.spawn(sb, { env: STANDALONE });
      expect((await within(app.exited, SLOW, 'the supervisor to exit')).code).toBe(1);
      const lines = logLines(app.stderr());
      expect(lines.find((l) => l['msg'] === 'server process stopped with a fatal error; not restarting')).toMatchObject({ code: 78 });
      expect(lines.filter((l) => l['msg'] === 'server process crashed')).toEqual([]);
      expect(lines.filter((l) => l['msg'] === 'server process started')).toHaveLength(1);
      expect(app.stderr().split('is in use').length - 1).toBe(1);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('the supervised child and its IPC channel', { timeout: TEST_TIMEOUT }, () => {
  it('a child with nothing left to do exits by itself: the channel to the supervisor does not hold it', async () => {
    const child = fork(path.join(import.meta.dirname, 'fixtures', 'supervised-idle.mjs'), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    try {
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      await within(new Promise<void>((resolve) => child.once('message', () => resolve())), SLOW, "the child's first message");
      // The supervisor (this test) is still connected; the child must still be free to end: its exit is awaited (a
      // child the channel held would never exit, and the deadline names that), not raced against a fixed pause.
      expect(child.connected).toBe(true);
      expect(await within(exited, SLOW, 'the idle child to exit by itself')).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
