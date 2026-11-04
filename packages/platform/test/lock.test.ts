import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, type DomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireFileLock,
  hostIdentity,
  lockHostIdentity,
  processGone,
  processStartMs,
  withFileLock,
  type FileLockOptions,
  type HeldFileLock,
  type HeldFileLockHandle,
} from '../src/lock.js';
import { drive, errno } from './support.js';

let dir: string;
let lock: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-lock-'));
  lock = path.join(dir, 'current.lock');
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
/** Makes the code under test believe it runs on `value`. Undone after every test. */
function fakePlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value });
}

afterEach(async () => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fsp.rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (p: string): Promise<boolean> =>
  fsp.access(p).then(
    () => true,
    () => false,
  );
const readLock = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await fsp.readFile(lock, 'utf8')) as Record<string, unknown>;
const thisProcessStartMs = (): number => Math.round(Date.now() - process.uptime() * 1000);

/** The PID of a process that has already exited. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '0']);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  return pid;
}

/**
 * Writes a lock file by hand, as another (possibly dead) process would have left it: by default a process of this
 * host (`host`: this host's lock identity, R33); `host: null` leaves the field out, like a record written before
 * R25(b).
 */
async function plantLock(content: string | { pid: number; startMs?: number; host?: string | null }, ageMs = 0): Promise<void> {
  const host = typeof content === 'string' || content.host === undefined ? lockHostIdentity() : content.host;
  const text =
    typeof content === 'string'
      ? content
      : JSON.stringify({
          pid: content.pid,
          startMs: content.startMs ?? thisProcessStartMs() - 60_000,
          token: 'planted',
          ...(host === null ? {} : { host }),
        });
  await fsp.writeFile(lock, text);
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    await fsp.utimes(lock, past, past);
  }
}

/** Takes the lock in this process and keeps it until `release()`. */
async function holdLock(opts?: FileLockOptions): Promise<{ release: () => Promise<void> }> {
  let letGo!: () => void;
  const gate = new Promise<void>((resolve) => (letGo = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const done = withFileLock(
    lock,
    async () => {
      entered();
      await gate;
    },
    opts,
  );
  await inside;
  return {
    release: async () => {
      letGo();
      await done;
    },
  };
}

/** Makes `fsp.open(<the lock file>, flags)` reject with `code`, for the first `times` such calls. */
function failOpen(flags: 'r' | 'wx', code: string, times = Number.POSITIVE_INFINITY) {
  const realOpen = fsp.open.bind(fsp);
  let injected = 0;
  let seen = 0;
  vi.spyOn(fsp, 'open').mockImplementation(((...args: Parameters<typeof fsp.open>) => {
    if (args[0] === lock && args[1] === flags) {
      seen += 1;
      if (injected < times) {
        injected += 1;
        return Promise.reject(errno(code));
      }
    }
    return realOpen(...args);
  }) as typeof fsp.open);
  return { injected: () => injected, seen: () => seen };
}

const rejection = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('withFileLock', () => {
  it('runs fn, returns its value and removes the lock file', async () => {
    expect(await withFileLock(lock, async () => 42)).toBe(42);
    expect(await exists(lock)).toBe(false);
  });

  it('writes {pid, startMs, token, host} while the lock is held', async () => {
    const seen = await withFileLock(lock, readLock);
    expect(Object.keys(seen).sort()).toEqual(['host', 'pid', 'startMs', 'token']);
    expect(seen.host).toBe(lockHostIdentity());
    expect(seen.pid).toBe(process.pid);
    expect(seen.token).toMatch(/^[0-9a-f]{32}$/);
    expect(Math.abs((seen.startMs as number) - thisProcessStartMs())).toBeLessThan(2000);
  });

  it('uses a fresh token for every acquisition', async () => {
    const first = await withFileLock(lock, readLock);
    const second = await withFileLock(lock, readLock);
    expect(first.token).not.toBe(second.token);
  });

  it('releases the lock and rethrows when fn fails', async () => {
    const boom = new Error('boom');
    await expect(
      withFileLock(lock, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await exists(lock)).toBe(false);
    expect(await withFileLock(lock, async () => 'again')).toBe('again');
  });

  it('serialises concurrent callers in one process', async () => {
    let active = 0;
    let maxActive = 0;
    let finished = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withFileLock(lock, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(10);
          active -= 1;
          finished += 1;
        }),
      ),
    );
    expect(maxActive).toBe(1);
    expect(finished).toBe(6);
    expect(await exists(lock)).toBe(false);
  });

  it('waits for a held lock and then takes it', async () => {
    const holder = await holdLock();
    const started = Date.now();
    const waiter = withFileLock(lock, async () => Date.now() - started, { waitMs: 5000 });
    await sleep(150);
    await holder.release();
    const enteredAfter = await waiter;
    expect(enteredAfter).toBeGreaterThanOrEqual(140);
    expect(enteredAfter).toBeLessThan(150 + 250 + 500); // backoff never exceeds 250 ms
  });

  it.each([{ waitMs: Number.NaN }, { waitMs: -1 }, { staleMs: 0 }, { staleMs: Number.NaN }])(
    'rejects nonsensical options up front (%j)',
    async (opts) => {
      let ran = false;
      await expect(
        withFileLock(
          lock,
          async () => {
            ran = true;
          },
          opts,
        ),
      ).rejects.toThrow(RangeError);
      expect(ran).toBe(false);
      expect(await exists(lock)).toBe(false);
    },
  );

  describe('timeout', () => {
    it('fails with STATE_CORRUPT {reason: lock_timeout} after waitMs when a live process holds the lock', async () => {
      const holder = await holdLock();
      const started = Date.now();
      const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 300 }));
      const elapsed = Date.now() - started;

      expect(isDomainError(error)).toBe(true);
      expect((error as DomainError).code).toBe('STATE_CORRUPT');
      expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      expect((error as DomainError).message).toContain(lock);
      expect(elapsed).toBeGreaterThanOrEqual(290);
      expect(elapsed).toBeLessThan(1500);

      // The holder is unaffected.
      expect(await exists(lock)).toBe(true);
      await holder.release();
      expect(await exists(lock)).toBe(false);
    });

    it('fails at once with waitMs 0', async () => {
      const holder = await holdLock();
      const started = Date.now();
      const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 0 }));
      expect(Date.now() - started).toBeLessThan(200);
      expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      await holder.release();
    });

    it('does not run fn when it times out', async () => {
      const holder = await holdLock();
      let ran = false;
      await rejection(
        withFileLock(
          lock,
          async () => {
            ran = true;
          },
          { waitMs: 50 },
        ),
      );
      expect(ran).toBe(false);
      await holder.release();
    });
  });

  describe('stale locks', () => {
    it('takes over a lock whose pid is dead and whose mtime is older than 30 s', async () => {
      await plantLock({ pid: deadPid() }, 31_000);
      const started = Date.now();
      expect(await withFileLock(lock, async () => 'taken')).toBe('taken');
      expect(Date.now() - started).toBeLessThan(500);
      expect(await exists(lock)).toBe(false);
    });

    it('takes over a lock whose pid is dead even when its mtime is fresh', async () => {
      await plantLock({ pid: deadPid() });
      const seen = await withFileLock(lock, readLock, { waitMs: 1000 });
      expect(seen.pid).toBe(process.pid);
    });

    it('takes over a lock held by a live pid once its mtime is older than staleMs', async () => {
      await plantLock({ pid: process.ppid }, 31_000);
      const error = await rejection(withFileLock(lock, async () => 'never', { staleMs: 60_000, waitMs: 150 }));
      expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      await plantLock({ pid: process.ppid }, 61_000);
      expect(await withFileLock(lock, async () => 'taken', { staleMs: 60_000, waitMs: 1000 })).toBe('taken');
    });

    it.each([1, 1000, 29_999])(
      'never judges a live holder stale less than 30 s after its last refresh, whatever staleMs is (%i)',
      async (staleMs) => {
        await plantLock({ pid: process.ppid }, 29_000);
        const error = await rejection(withFileLock(lock, async () => 'never', { staleMs, waitMs: 100 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
        await plantLock({ pid: process.ppid }, 31_000);
        expect(await withFileLock(lock, async () => 'taken', { staleMs, waitMs: 1000 })).toBe('taken');
      },
    );

    it('does not take over a lock held by a live pid with a fresh mtime', async () => {
      await plantLock({ pid: process.ppid }, 500);
      const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
      expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      expect((await readLock()).token).toBe('planted');
    });

    it('applies the default staleMs of 30 s', async () => {
      await plantLock({ pid: process.ppid }, 25_000);
      const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 100 }));
      expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      await plantLock({ pid: process.ppid }, 31_000);
      expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
    });

    describe('host identity (R25(b)): pid rules only for a holder on this host', () => {
      it('judges a record from another host by its mtime alone, even when its pid is alive here', async () => {
        await plantLock({ pid: process.ppid, host: 'another-container' }, 31_000);
        expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
      });

      it('does not take over a fresh record from another host whose pid number is dead here', async () => {
        await plantLock({ pid: deadPid(), host: 'another-container' }, 500);
        const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      });

      it("does not apply the own-pid rule to another host's process that happens to have our pid", async () => {
        // In Docker every container's node is PID 1: same pid, other start time, other hostname.
        await plantLock({ pid: process.pid, startMs: thisProcessStartMs() - 60_000, host: 'another-container' }, 500);
        const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      });

      it('names the holder and its host in the timeout error when the holder is on another host', async () => {
        await plantLock({ pid: process.ppid, host: 'another-container/pid:[7]' }, 500);
        const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
        expect((error as DomainError).detail).toContain(`PID ${process.ppid} on another-container/pid:[7]`);
      });

      it('treats a record without a host (written before R25(b)) as from an unknown host: mtime only', async () => {
        await plantLock({ pid: deadPid(), host: null }, 500);
        const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
        await plantLock({ pid: deadPid(), host: null }, 31_000);
        expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
      });
    });

    describe('host identity is the hostname, the boot id and the PID namespace (R33, round 4)', () => {
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      const missing = (): string => {
        throw Object.assign(new Error('no /proc'), { code: 'ENOENT' });
      };

      it('joins the hostname, /proc/sys/kernel/random/boot_id (trimmed) and /proc/self/ns/pid; a part it cannot read is left out', () => {
        const boot = () => '6f1c0d3e-1b7a-4b55-9a7e-3c2f7d0e9b11\n';
        const pidns = () => 'pid:[4026531836]';
        expect(hostIdentity('box', boot, pidns)).toBe('box/6f1c0d3e-1b7a-4b55-9a7e-3c2f7d0e9b11/pid:[4026531836]');
        expect(hostIdentity('box', missing, pidns)).toBe('box/pid:[4026531836]');
        expect(hostIdentity('box', boot, missing)).toBe('box/6f1c0d3e-1b7a-4b55-9a7e-3c2f7d0e9b11');
        expect(hostIdentity('box', () => ' \n', pidns)).toBe('box/pid:[4026531836]'); // empty counts as missing
        expect(hostIdentity('box', missing, missing)).toBe('box');
      });

      it('is what this process records: the hostname first, and the boot id when this OS has one', () => {
        expect(lockHostIdentity().startsWith(os.hostname())).toBe(true);
        let boot = '';
        try {
          boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        } catch {
          // not Linux: no boot id
        }
        if (boot !== '') expect(lockHostIdentity()).toContain(`/${boot}`);
      });

      // ALTIS_TEST_LOCK_BOOTID and ALTIS_TEST_LOCK_PIDNS (test hooks, compiled out of production builds) give this
      // process a boot id and a PID namespace, as on Linux, so the rules are exercised on any OS.
      const BOOT = '6f1c0d3e-1b7a-4b55-9a7e-3c2f7d0e9b11';
      const PIDNS = 'pid:[4026532001]';
      const asLinux = () => {
        vi.stubEnv('ALTIS_TEST_LOCK_BOOTID', BOOT);
        vi.stubEnv('ALTIS_TEST_LOCK_PIDNS', PIDNS);
      };

      it('judges a record with our hostname but another PID namespace by its mtime alone', async () => {
        asLinux();
        // network_mode: host or a shared `hostname:` gives two containers one hostname; their pids still differ.
        await plantLock({ pid: deadPid(), host: `${os.hostname()}/${BOOT}/pid:[4026531836]` }, 500);
        const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      });

      // R36: our hostname and PID namespace with another boot id is this host before its last boot (a power cut
      // mid-migration on a PM2/standalone box in the initial PID namespace): the holder is gone, whatever its pid.
      const OLD_BOOT = '0a6e2a77-90c4-4a8e-8f43-5b8ad4c1e2f0';
      it('takes over at once a record of our hostname and PID namespace with another boot id: written before this host last booted (R36)', async () => {
        asLinux();
        const previousBoot = `${os.hostname()}/${OLD_BOOT}/${PIDNS}`;
        // A pid number that is alive here now (it belonged to another process before the reboot), fresh mtime.
        await plantLock({ pid: process.ppid, host: previousBoot }, 500);
        const started = Date.now();
        expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
        expect(Date.now() - started).toBeLessThan(500);
        // Our own pid (node as PID 1 again after the reboot), fresh mtime.
        await plantLock({ pid: process.pid, startMs: thisProcessStartMs() - 60_000, host: previousBoot }, 500);
        expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
      });

      it.each([
        ['another hostname', `another-box/${OLD_BOOT}/${PIDNS}`],
        ['another PID namespace (a container recreated after the reboot)', `${os.hostname()}/${OLD_BOOT}/pid:[4026531836]`],
        ['a record without a PID namespace', `${os.hostname()}/${OLD_BOOT}`],
      ])('judges a record with another boot id and %s by its mtime alone (R36)', async (_what, host) => {
        asLinux();
        await plantLock({ pid: deadPid(), host }, 500);
        const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
        await plantLock({ pid: deadPid(), host }, 31_000);
        expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
      });

      it('judges a record in the round-3 format (hostname/PID namespace, no boot id) by its mtime alone', async () => {
        asLinux();
        await plantLock({ pid: deadPid(), host: `${os.hostname()}/${PIDNS}` }, 500);
        const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
        await plantLock({ pid: deadPid(), host: `${os.hostname()}/${PIDNS}` }, 31_000);
        expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
      });

      it('judges a record with only our hostname (written before R33) by its mtime alone', async () => {
        asLinux();
        await plantLock({ pid: deadPid(), host: os.hostname() }, 500);
        const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      });

      it('applies the pid rules to a record with exactly our identity', async () => {
        asLinux();
        expect(lockHostIdentity()).toBe(`${os.hostname()}/${BOOT}/${PIDNS}`);
        await plantLock({ pid: deadPid(), host: lockHostIdentity() }, 500);
        expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
        expect((await withFileLock(lock, readLock)).host).toBe(`${os.hostname()}/${BOOT}/${PIDNS}`);
      });
    });

    describe('test hook ALTIS_TEST_LOCK_STALE_MS (compiled out of production builds)', () => {
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('makes a live holder stale after that many ms, and the heartbeat follow at a third of it', async () => {
        vi.stubEnv('ALTIS_TEST_LOCK_STALE_MS', '300');
        await plantLock({ pid: process.ppid }, 400);
        expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
        const distinct = await withFileLock(lock, async () => {
          const seen = new Set<number>();
          for (let i = 0; i < 12; i += 1) {
            seen.add((await fsp.stat(lock)).mtimeMs);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return seen.size;
        });
        expect(distinct).toBeGreaterThan(1);
      });

      it("replaces a caller's own staleMs too (so scaled-down tests also cover callers that pass one)", async () => {
        vi.stubEnv('ALTIS_TEST_LOCK_STALE_MS', '300');
        await plantLock({ pid: process.ppid }, 400);
        expect(await withFileLock(lock, async () => 'taken', { staleMs: 600_000, waitMs: 1000 })).toBe('taken');
      });

      it('keeps the lock fresh while the holder gives the event loop only one turn every 120 ms', async () => {
        // A refresh that needed several turns (open, stat, read, close, utimes) would fall behind here.
        vi.stubEnv('ALTIS_TEST_LOCK_STALE_MS', '600'); // heartbeat every 200 ms
        const oldest = await withFileLock(lock, async () => {
          let worst = 0;
          const until = Date.now() + 2500;
          while (Date.now() < until) {
            const spin = Date.now() + 120;
            while (Date.now() < spin) {
              // synchronous work: no timer or I/O callback can run
            }
            worst = Math.max(worst, Date.now() - (await fsp.stat(lock)).mtimeMs);
            await new Promise<void>((resolve) => setImmediate(resolve)); // one turn
          }
          return worst;
        });
        expect(oldest).toBeLessThan(600);
      });

      it.each(['', 'abc', '0', '-5', '1.5'])('is ignored when unset or invalid (%j): the 30 s floor applies', async (value) => {
        vi.stubEnv('ALTIS_TEST_LOCK_STALE_MS', value);
        await plantLock({ pid: process.ppid }, 400);
        const error = await rejection(withFileLock(lock, async () => 'never', { staleMs: 1, waitMs: 150 }));
        expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
      });
    });

    it('takes over a lock left by an earlier process that had the same pid (container restart)', async () => {
      await plantLock({ pid: process.pid, startMs: thisProcessStartMs() - 60_000 });
      expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');
    });

    it('does not take over a lock whose pid and start time are this process', async () => {
      await plantLock({ pid: process.pid, startMs: thisProcessStartMs() });
      const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
      expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
    });

    it('treats an unreadable lock file by its mtime alone', async () => {
      await plantLock('', 31_000); // created, then the holder died before writing its content
      expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');

      await plantLock('{"pid":', 31_000);
      expect(await withFileLock(lock, async () => 'taken', { waitMs: 1000 })).toBe('taken');

      await plantLock('not json');
      const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 150 }));
      expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
    });

    describe('never signals a bogus pid', () => {
      it.each([0, -1, -1234, 1.5, 2 ** 31, Number.MAX_SAFE_INTEGER, '123', null, true])(
        'process.kill is not called for pid %j',
        async (pid) => {
          const kill = vi.spyOn(process, 'kill');
          // A record of this host, so the pid rules (and their validation) apply.
          await plantLock(JSON.stringify({ pid, startMs: Date.now(), token: 't', host: lockHostIdentity() }));
          const error = await rejection(withFileLock(lock, async () => 'never', { waitMs: 100 }));
          expect((error as DomainError).meta).toEqual({ reason: 'lock_timeout' });
          expect(kill).not.toHaveBeenCalled(); // pid 0 or a negative pid would address a whole process group
        },
      );

      it('does signal (with signal 0) a valid pid, so the spy above can see a call', async () => {
        const kill = vi.spyOn(process, 'kill');
        await plantLock({ pid: process.ppid }, 500);
        await rejection(withFileLock(lock, async () => 'never', { waitMs: 100 }));
        expect(kill).toHaveBeenCalledWith(process.ppid, 0);
      });
    });

    it('lets exactly one of many waiters break the same stale lock', async () => {
      await plantLock({ pid: deadPid() }, 31_000);

      // Widen the gap between "I looked at the lock" and "I act on it" by a random few ms, so that a waiter
      // that merely re-checks and then unlinks would, with high probability, delete a lock created in the gap.
      const probe = await fsp.open(path.join(dir, 'probe'), 'w');
      const handlePrototype = Object.getPrototypeOf(probe) as { readFile: (...args: unknown[]) => Promise<unknown> };
      await probe.close();
      await fsp.rm(path.join(dir, 'probe'));
      const realReadFile = handlePrototype.readFile;
      vi.spyOn(handlePrototype, 'readFile').mockImplementation(async function (this: unknown, ...args: unknown[]) {
        const content = await realReadFile.apply(this, args);
        await sleep(Math.random() * 8);
        return content;
      });

      let active = 0;
      let maxActive = 0;
      let finished = 0;
      await Promise.all(
        Array.from({ length: 12 }, () =>
          withFileLock(
            lock,
            async () => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              await sleep(5);
              active -= 1;
              finished += 1;
            },
            { waitMs: 10_000 },
          ),
        ),
      );
      expect(maxActive).toBe(1);
      expect(finished).toBe(12);
      expect(await fsp.readdir(dir)).toEqual([]); // no lock, no claim files left from the takeover
    });
  });

  describe('ownership', () => {
    it('leaves a lock alone on release when it no longer carries our token (and reports the loss, L11)', async () => {
      const error = await rejection(
        withFileLock(lock, async () => {
          await fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, startMs: 1, token: 'someone-else' }));
        }),
      );
      expect(error).toMatchObject({ code: 'STATE_CORRUPT', meta: { reason: 'lock_lost' } });
      expect((await readLock()).token).toBe('someone-else');
    });

    it('refreshes the lock mtime while fn runs, so that a live holder never looks dead', async () => {
      const { before, after } = await withFileLock(
        lock,
        async () => {
          const first = (await fsp.stat(lock)).mtimeMs;
          await sleep(400);
          return { before: first, after: (await fsp.stat(lock)).mtimeMs };
        },
        { staleMs: 150 }, // beats every 50 ms
      );
      expect(after - before).toBeGreaterThanOrEqual(150);
    });

    it.each([
      [30_000, 10_000],
      [3000, 1000],
      [600_000, 10_000],
      [150, 50],
    ])('beats every min(staleMs / 3, 10 s): staleMs %i gives %i ms', async (staleMs, interval) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        await withFileLock(lock, async () => undefined, { staleMs });
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), interval);
      } finally {
        vi.useRealTimers();
      }
    });

    it('runs one heartbeat timer while the lock is held and none afterwards, even when fn fails', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        expect(await withFileLock(lock, async () => vi.getTimerCount())).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        await rejection(
          withFileLock(lock, async () => {
            throw new Error('boom');
          }),
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('lock loss (L11)', () => {
    /** Replaces the lock file with another holder's record, as a waiter that took the lock over would. */
    const steal = (): Promise<void> =>
      fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, startMs: 1, token: 'thief', host: lockHostIdentity() }));

    const isLockLost = (error: unknown): boolean =>
      isDomainError(error) && error.code === 'STATE_CORRUPT' && (error.meta as { reason?: unknown }).reason === 'lock_lost';

    it('notices within one heartbeat that the lock file carries another token: lost(), assertHeld() and the call all say so', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      let seen: HeldFileLock | undefined;
      const error = await rejection(
        withFileLock(lock, async (held) => {
          seen = held;
          expect(held.lost()).toBe(false);
          held.assertHeld();
          await steal();
          expect(held.lost()).toBe(false); // no heartbeat yet
          vi.advanceTimersByTime(10_000); // one heartbeat at the default staleMs (30 s / 3)
          expect(held.lost()).toBe(true);
          let thrown: unknown;
          try {
            held.assertHeld();
          } catch (e) {
            thrown = e;
          }
          expect(isLockLost(thrown)).toBe(true);
          return 'value';
        }),
      );
      expect(isLockLost(error)).toBe(true);
      expect((error as DomainError).message).toContain(lock);
      expect(seen?.lost()).toBe(true);
      expect((await readLock()).token).toBe('thief'); // the new holder's lock is left alone
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps lost() false and returns the value while the lock stays ours, through many heartbeats', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const value = await withFileLock(lock, async (held) => {
        for (let i = 0; i < 5; i += 1) {
          vi.advanceTimersByTime(10_000);
          expect(held.lost()).toBe(false);
          held.assertHeld();
        }
        return 'value';
      });
      expect(value).toBe('value');
      expect(await exists(lock)).toBe(false);
    });

    it('counts a lock file that disappeared as lost', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const error = await rejection(
        withFileLock(lock, async (held) => {
          await fsp.rm(lock);
          vi.advanceTimersByTime(10_000);
          expect(held.lost()).toBe(true);
          return 'value';
        }),
      );
      expect(isLockLost(error)).toBe(true);
    });

    it('rejects with lock_lost when the lock was taken over after the last heartbeat and fn then returns at once (a stall at the end)', async () => {
      // A long synchronous stretch at the end of fn (VACUUM INTO, a suspended process): a waiter takes the lock over,
      // the stretch ends and fn resolves before the overdue heartbeat gets its turn.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      let seen: HeldFileLock | undefined;
      const error = await rejection(
        withFileLock(lock, async (held) => {
          seen = held;
          await steal();
          return 'value'; // no heartbeat ran, no assertHeld()
        }),
      );
      expect(isLockLost(error)).toBe(true);
      expect(seen?.lost()).toBe(true);
      expect((await readLock()).token).toBe('thief'); // the new holder's lock is left alone
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects with lock_lost when the lock file vanished after the last heartbeat and fn then returns at once', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const error = await rejection(
        withFileLock(lock, async () => {
          await fsp.rm(lock);
          return 'value';
        }),
      );
      expect(isLockLost(error)).toBe(true);
      expect(await exists(lock)).toBe(false);
    });

    it('assertHeld() looks at the lock file itself, so it notices a takeover before the next heartbeat', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const error = await rejection(
        withFileLock(lock, async (held) => {
          await steal();
          held.assertHeld(); // throws: no heartbeat needed
          return 'not reached';
        }),
      );
      expect(isLockLost(error)).toBe(true);
    });

    it("lets fn's own error win when fn fails after the loss", async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const boom = new Error('boom');
      const error = await rejection(
        withFileLock(lock, async () => {
          await steal();
          vi.advanceTimersByTime(10_000);
          throw boom;
        }),
      );
      expect(error).toBe(boom);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'treats a heartbeat read the file system refuses (EACCES for a moment) as no news, not as a loss',
      async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        const value = await withFileLock(lock, async (held) => {
          await fsp.chmod(lock, 0o000);
          try {
            vi.advanceTimersByTime(10_000);
            expect(held.lost()).toBe(false);
            held.assertHeld();
          } finally {
            await fsp.chmod(lock, 0o600);
          }
          return 'value';
        });
        expect(value).toBe('value');
      },
    );

    /**
     * Makes the lock file unreadable (EACCES, as a scanner's EBUSY would be on Windows) until the release reads it:
     * the last look after fn then learns nothing, and only the release's own read can tell whose lock it is.
     */
    async function unreadableUntilRelease(): Promise<void> {
      await fsp.chmod(lock, 0o000);
      const realOpen = fsp.open.bind(fsp);
      vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        if (args[0] === lock && args[1] === 'r') await fsp.chmod(lock, 0o600);
        return realOpen(...args);
      }) as typeof fsp.open);
    }

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'rejects with lock_lost when the last look after fn is refused and the release then finds another holder',
      async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        let seen: HeldFileLock | undefined;
        const error = await rejection(
          withFileLock(lock, async (held) => {
            seen = held;
            await steal();
            await unreadableUntilRelease();
            return 'value';
          }),
        );
        expect(isLockLost(error)).toBe(true);
        expect(seen?.lost()).toBe(true);
        expect((await readLock()).token).toBe('thief'); // the new holder's lock is left alone
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'returns the value and removes the lock when the last look is refused but the lock is still ours',
      async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        const value = await withFileLock(lock, async () => {
          await unreadableUntilRelease();
          return 'value';
        });
        expect(value).toBe('value');
        expect(await exists(lock)).toBe(false);
      },
    );
  });

  describe('file system errors', () => {
    it.each(['EPERM', 'EACCES', 'EBUSY'])(
      'on Windows, a lock file that is briefly unavailable (%s on create, e.g. delete pending) is waited out with backoff',
      async (code) => {
        fakePlatform('win32');
        const refusals = failOpen('wx', code, 2);
        const started = Date.now();
        expect(await withFileLock(lock, async () => 'ok', { waitMs: 5000 })).toBe('ok');
        const elapsed = Date.now() - started;
        expect(refusals.injected()).toBe(2);
        expect(refusals.seen()).toBe(3); // two refusals, then the real create: not a busy loop
        expect(elapsed).toBeGreaterThanOrEqual(50); // 25 ms then 50 ms of backoff, minus up to 25% jitter
        expect(elapsed).toBeLessThan(1000);
        expect(await exists(lock)).toBe(false);
      },
    );

    it.each(['EPERM', 'EACCES', 'EBUSY'])(
      'on Windows, %s while reading a held lock is waited out instead of thrown',
      async (code) => {
        const holder = await holdLock();
        fakePlatform('win32');
        const refusals = failOpen('r', code, 2);
        const waiter = withFileLock(lock, async () => 'ok', { waitMs: 5000 });
        await sleep(300);
        expect(refusals.injected()).toBe(2); // the waiter hit them, backed off, and is still waiting
        await holder.release();
        expect(await waiter).toBe('ok');
      },
    );

    it('keeps waiting through a transient EPERM on a claim file while breaking a stale lock (Windows)', async () => {
      await plantLock({ pid: deadPid() }, 31_000);
      fakePlatform('win32');
      const claimOpen = fsp.open.bind(fsp);
      let refused = 0;
      vi.spyOn(fsp, 'open').mockImplementation(((...args: Parameters<typeof fsp.open>) => {
        if (String(args[0]).includes('.break-') && args[1] === 'wx' && refused < 2) {
          refused += 1;
          return Promise.reject(errno('EPERM'));
        }
        return claimOpen(...args);
      }) as typeof fsp.open);
      expect(await withFileLock(lock, async () => 'ok', { waitMs: 5000 })).toBe('ok');
      expect(refused).toBe(2);
      expect(await fsp.readdir(dir)).toEqual([]);
    });

    it('reports a persistent EACCES on the lock file as STATE_CORRUPT lock_io, not as a timeout', async () => {
      await plantLock({ pid: process.ppid }, 500);
      failOpen('r', 'EACCES');
      const started = Date.now();
      const error = (await rejection(withFileLock(lock, async () => 'never', { waitMs: 300 }))) as DomainError;
      expect(isDomainError(error)).toBe(true);
      expect(error.code).toBe('STATE_CORRUPT');
      expect(error.meta).toEqual({ reason: 'lock_io', code: 'EACCES' });
      expect(error.cause).toMatchObject({ code: 'EACCES' });
      expect(error.message).toContain(lock);
      expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    });

    it('reports a persistent EACCES on creating the lock (read-only directory) as lock_io', async () => {
      failOpen('wx', 'EACCES');
      const error = (await rejection(withFileLock(lock, async () => 'never', { waitMs: 200 }))) as DomainError;
      expect(error.meta).toEqual({ reason: 'lock_io', code: 'EACCES' });
    });

    it('counts only an unbroken run of refusals: a good attempt in between starts the count again', async () => {
      fakePlatform('linux');
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      await plantLock({ pid: process.ppid }, 500); // held by a live process for the whole test
      const realOpen = fsp.open.bind(fsp);
      const start = performance.now();
      vi.spyOn(fsp, 'open').mockImplementation(((...args: Parameters<typeof fsp.open>) => {
        const t = performance.now() - start;
        // 1.6 s of refusals, a 0.6 s pause (longer than any backoff sleep), then 1.6 s of refusals again.
        if (args[0] === lock && args[1] === 'r' && (t < 1600 || (t >= 2200 && t < 3800))) {
          return Promise.reject(errno('EACCES'));
        }
        return realOpen(...args);
      }) as typeof fsp.open);
      const waiting = withFileLock(lock, async () => 'never', { waitMs: 5000 });
      const outcome = rejection(waiting);
      await drive(waiting);
      expect(((await outcome) as DomainError).meta).toEqual({ reason: 'lock_timeout' }); // never 2 s in a row
    });

    it('waits out a refusal to read a claim file that another waiter has just removed (Windows)', async () => {
      await plantLock({ pid: deadPid() }, 31_000);
      // The claim another waiter would hold while breaking exactly this stale lock (see breakStale in lock.ts).
      const staleRaw = await fsp.readFile(lock, 'utf8');
      const { mtimeMs } = await fsp.stat(lock);
      const identity = createHash('sha256').update(`${staleRaw}\0${mtimeMs}`).digest('hex').slice(0, 16);
      const claim = `${lock}.break-${identity}`;
      // Its owner, a process of this host (claims are written like locks, with the host), died.
      await fsp.writeFile(claim, JSON.stringify({ pid: deadPid(), startMs: 1, token: 'dead-breaker', host: lockHostIdentity() }));

      fakePlatform('win32');
      const realOpen = fsp.open.bind(fsp);
      let refused = 0;
      vi.spyOn(fsp, 'open').mockImplementation(((...args: Parameters<typeof fsp.open>) => {
        if (args[0] === claim && args[1] === 'r' && refused < 2) {
          refused += 1;
          return Promise.reject(errno('EPERM'));
        }
        return realOpen(...args);
      }) as typeof fsp.open);

      expect(await withFileLock(lock, async () => 'ok', { waitMs: 5000 })).toBe('ok');
      expect(refused).toBe(2);
      expect(await fsp.readdir(dir)).toEqual([]); // lock released, dead breaker's claim cleaned up
    });

    it('outside Windows, gives up on a persistent EACCES after about 2 s even when waitMs is longer', async () => {
      fakePlatform('linux');
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      failOpen('wx', 'EACCES');
      const start = performance.now();
      const waiting = withFileLock(lock, async () => 'never', { waitMs: 60_000 });
      const outcome = rejection(waiting).then((error) => ({ error: error as DomainError, at: performance.now() - start }));
      await drive(waiting);
      const { error, at } = await outcome;
      expect(error.meta).toEqual({ reason: 'lock_io', code: 'EACCES' });
      expect(at).toBeGreaterThan(2000);
      expect(at).toBeLessThan(2700);
    });

    it('on Windows, keeps waiting for a persistent EPERM for the whole waitMs before reporting it', async () => {
      fakePlatform('win32');
      vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] });
      failOpen('wx', 'EPERM');
      const start = performance.now();
      const waiting = withFileLock(lock, async () => 'never', { waitMs: 5000 });
      const outcome = rejection(waiting).then((error) => ({ error: error as DomainError, at: performance.now() - start }));
      await drive(waiting);
      const { error, at } = await outcome;
      expect(error.meta).toEqual({ reason: 'lock_io', code: 'EPERM' });
      expect(at).toBeGreaterThanOrEqual(5000);
      expect(at).toBeLessThan(5100);
    });

    it('does not mistake other errors for contention: they are thrown as they are', async () => {
      failOpen('wx', 'ENOSPC', 1);
      await expect(withFileLock(lock, async () => 'never', { waitMs: 1000 })).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(await exists(lock)).toBe(false);
    });
  });

  describe('process start time', () => {
    it('is recorded in the lock and is the same in every copy of the module in the process', async () => {
      // app.js and server.mjs each bundle their own copy of this module; they must agree on startMs, or
      // one copy would take a lock held by the other for a lock left by a previous process with the same pid.
      const mine = await withFileLock(lock, readLock);
      expect(Math.abs((mine.startMs as number) - thisProcessStartMs())).toBeLessThan(2000);
      expect(mine.startMs).toBe(processStartMs());

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000); // the second copy loads a minute "later"
      vi.resetModules();
      const other = await import('../src/lock.js');
      vi.restoreAllMocks();

      expect(other.withFileLock).not.toBe(withFileLock); // really a second instance
      expect(other.processStartMs()).toBe(processStartMs());
      expect((await other.withFileLock(lock, readLock)).startMs).toBe(mine.startMs);
    });
  });

  describe('across processes', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const fixture = path.join(import.meta.dirname, 'fixtures', 'lock-child.mjs');
    const children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });

    function startChild(id: string, dataFile: string, count: number | 'hold') {
      // tsx lets the child import the TypeScript sources directly, on every supported Node version.
      const child = fork(fixture, [lock, dataFile, id, String(count)], {
        cwd: root,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', (message) =>
          message === 'ready' ? resolve() : reject(new Error(`unexpected message ${String(message)}`)),
        );
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child ${id} exited with ${String(code)} before it was ready`)));
      });
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      return { child, ready, exited };
    }

    it('serialises two processes appending 50 lines each: 100 well-formed, uninterleaved lines', async () => {
      const dataFile = path.join(dir, 'shared.txt');
      const a = startChild('A', dataFile, 50);
      const b = startChild('B', dataFile, 50);
      await Promise.all([a.ready, b.ready]); // start both only once both are up, so that they really compete
      a.child.send('go');
      b.child.send('go');
      expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);

      const lines = (await fsp.readFile(dataFile, 'utf8')).split('\n');
      expect(lines.pop()).toBe(''); // the file ends with a newline
      expect(lines).toHaveLength(100);
      const payload = 'x'.repeat(120);
      const seen: Record<string, number[]> = { A: [], B: [] };
      for (const line of lines) {
        const [id, n, rest, ...extra] = line.split(':');
        expect(extra).toEqual([]);
        expect(rest).toBe(payload);
        seen[id!]!.push(Number(n));
      }
      const expected = Array.from({ length: 50 }, (_, n) => n);
      expect(seen).toEqual({ A: expected, B: expected });
      expect(await exists(lock)).toBe(false);
    }, 30_000);

    it('a process killed while it holds the lock does not block the others', async () => {
      const victim = startChild('V', path.join(dir, 'unused.txt'), 'hold');
      await victim.ready;
      const held = new Promise<void>((resolve) => victim.child.on('message', (m) => m === 'held' && resolve()));
      victim.child.send('go');
      await held;
      expect((await readLock()).pid).toBe(victim.child.pid);
      victim.child.kill('SIGKILL');
      await victim.exited;
      expect(await exists(lock)).toBe(true); // left behind by the dead process

      const started = Date.now();
      expect(await withFileLock(lock, async () => 'recovered', { waitMs: 5000 })).toBe('recovered');
      expect(Date.now() - started).toBeLessThan(2000); // dead pid: no need to wait for 30 s
    }, 30_000);
  });
});

// 1d Task 2: a lock that is not scoped to one call (releases/boot.lock, spec §9.3): taken without waiting, held across
// requests, refreshed by its heartbeat, released by its own token only.
describe('acquireFileLock', () => {
  const handles: HeldFileLockHandle[] = [];
  /** Takes the lock and remembers the handle, so that afterEach can let it go whatever the test did. */
  async function acquire(opts?: { staleMs?: number }): Promise<HeldFileLockHandle | null> {
    const handle = await acquireFileLock(lock, opts);
    if (handle !== null) handles.push(handle);
    return handle;
  }

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.release().catch(() => undefined);
  });

  it('returns a handle holding the lock: the record {pid, startMs, token, host} with the handle token', async () => {
    const handle = await acquire();
    expect(handle).not.toBeNull();
    const seen = await readLock();
    expect(Object.keys(seen).sort()).toEqual(['host', 'pid', 'startMs', 'token']);
    expect(seen).toMatchObject({ pid: process.pid, token: handle!.token, host: lockHostIdentity() });
    expect(handle!.token).toMatch(/^[0-9a-f]{32}$/);
    expect(handle!.lost()).toBe(false);
    expect(() => handle!.assertHeld()).not.toThrow();
  });

  it('returns null at once while a live holder has it, whether this process or another one', async () => {
    const first = await acquire();
    expect(first).not.toBeNull();
    const started = Date.now();
    expect(await acquire()).toBeNull();
    expect((await readLock()).token).toBe(first!.token);
    await first!.release();

    await plantLock({ pid: process.ppid }, 500);
    expect(await acquire()).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect((await readLock()).token).toBe('planted');
  });

  it('after release() the lock file is gone and a new handle can be taken, with a new token', async () => {
    const first = await acquire();
    expect(await first!.release()).toBe(true);
    expect(await exists(lock)).toBe(false);
    const second = await acquire();
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);
  });

  it('release() is false, and leaves the file alone, once the file carries another token', async () => {
    const handle = await acquire();
    await fsp.writeFile(lock, JSON.stringify({ pid: process.ppid, startMs: 1, token: 'other', host: lockHostIdentity() }));
    expect(await handle!.release()).toBe(false);
    expect((await readLock()).token).toBe('other');
  });

  it('release() is false the second time, and when the file is gone', async () => {
    const handle = await acquire();
    expect(await handle!.release()).toBe(true);
    expect(await handle!.release()).toBe(false);
    const again = await acquire();
    await fsp.rm(lock);
    expect(await again!.release()).toBe(false);
  });

  it('takes over at once a lock naming a dead pid of this host', async () => {
    await plantLock({ pid: deadPid() }, 500);
    const handle = await acquire();
    expect(handle).not.toBeNull();
    expect((await readLock()).token).toBe(handle!.token);
  });

  it("judges another host's lock by its mtime alone: taken at 61 s with staleMs 60 000, not at 59 s", async () => {
    await plantLock({ pid: process.ppid, host: 'another-box/pid:[7]' }, 59_000);
    expect(await acquire({ staleMs: 60_000 })).toBeNull();
    expect((await readLock()).token).toBe('planted');
    await plantLock({ pid: process.ppid, host: 'another-box/pid:[7]' }, 61_000);
    const handle = await acquire({ staleMs: 60_000 });
    expect(handle).not.toBeNull();
    expect((await readLock()).token).toBe(handle!.token);
  });

  it('applies the default staleMs of 30 s, and the 30 s floor', async () => {
    await plantLock({ pid: process.ppid, host: 'another-box' }, 29_000);
    expect(await acquire({ staleMs: 1000 })).toBeNull();
    await plantLock({ pid: process.ppid, host: 'another-box' }, 31_000);
    expect(await acquire()).not.toBeNull();
  });

  it('beats every min(staleMs / 3, 10 s) while held and stops at release()', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const handle = await acquire({ staleMs: 60_000 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(vi.getTimerCount()).toBe(1);
    const past = new Date(Date.now() - 50_000);
    await fsp.utimes(lock, past, past);
    vi.advanceTimersByTime(10_000);
    expect(Date.now() - (await fsp.stat(lock)).mtimeMs).toBeLessThan(5000); // refreshed by the beat
    await handle!.release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('notices a takeover: assertHeld() throws lock_lost at once, lost() turns true at the next beat, and the heartbeat stops', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const thief = JSON.stringify({ pid: process.ppid, startMs: 1, token: 'thief', host: lockHostIdentity() });
    const handle = await acquire();
    await fsp.writeFile(lock, thief);
    expect(() => handle!.assertHeld()).toThrow(expect.objectContaining({ code: 'STATE_CORRUPT', meta: { reason: 'lock_lost' } }));
    expect(handle!.lost()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await fsp.rm(lock);
    const other = await acquire();
    await fsp.writeFile(lock, thief);
    expect(other!.lost()).toBe(false); // no beat yet
    vi.advanceTimersByTime(10_000);
    expect(other!.lost()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect((await readLock()).token).toBe('thief');
  });

  it('outside Windows, reports EACCES on creating the lock as STATE_CORRUPT lock_io', async () => {
    fakePlatform('linux');
    failOpen('wx', 'EACCES');
    await expect(acquireFileLock(lock)).rejects.toMatchObject({ code: 'STATE_CORRUPT', meta: { reason: 'lock_io', code: 'EACCES' } });
  });

  it('on Windows, answers null for a momentary EPERM/EBUSY (a scanner holds the file), so the caller tries later', async () => {
    fakePlatform('win32');
    failOpen('wx', 'EPERM', 1);
    expect(await acquireFileLock(lock)).toBeNull();
    vi.restoreAllMocks();
    failOpen('wx', 'EBUSY', 1);
    expect(await acquireFileLock(lock)).toBeNull();
    vi.restoreAllMocks();
    expect(await acquire()).not.toBeNull();
  });

  // A refusal that never goes away (an ACL change, a quarantined folder) must not look like a held lock forever: once
  // a run of refusals, with no other answer between them, has lasted longer than the stale window, it is lock_io.
  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'on Windows, reports a %s that has lasted longer than the stale window (60 s for boot.lock) as lock_io',
    async (code) => {
      fakePlatform('win32');
      vi.useFakeTimers({ toFake: ['performance'] });
      const refused = failOpen('wx', code);
      expect(await acquireFileLock(lock, { staleMs: 60_000 })).toBeNull();
      vi.advanceTimersByTime(30_000);
      expect(await acquireFileLock(lock, { staleMs: 60_000 })).toBeNull();
      vi.advanceTimersByTime(30_000);
      expect(await acquireFileLock(lock, { staleMs: 60_000 })).toBeNull(); // 60 s: not longer than the window yet
      vi.advanceTimersByTime(1000);
      const error = (await rejection(acquireFileLock(lock, { staleMs: 60_000 }))) as DomainError;
      expect(isDomainError(error)).toBe(true);
      expect(error).toMatchObject({ code: 'STATE_CORRUPT', meta: { reason: 'lock_io', code } });
      expect(error.cause).toMatchObject({ code });
      // Reported on every attempt while it lasts; gone once the file system answers again.
      await expect(acquireFileLock(lock, { staleMs: 60_000 })).rejects.toMatchObject({ meta: { reason: 'lock_io', code } });
      expect(refused.injected()).toBe(5);
      vi.restoreAllMocks();
      expect(await acquire({ staleMs: 60_000 })).not.toBeNull();
    },
  );

  it('on Windows, applies the 30 s floor to that window', async () => {
    fakePlatform('win32');
    vi.useFakeTimers({ toFake: ['performance'] });
    failOpen('wx', 'EPERM');
    expect(await acquireFileLock(lock, { staleMs: 1000 })).toBeNull();
    vi.advanceTimersByTime(29_000);
    expect(await acquireFileLock(lock, { staleMs: 1000 })).toBeNull();
    vi.advanceTimersByTime(2000);
    await expect(acquireFileLock(lock, { staleMs: 1000 })).rejects.toMatchObject({ meta: { reason: 'lock_io', code: 'EPERM' } });
  });

  it('on Windows, any other answer ends a run of refusals: a held lock, a taken one, another error', async () => {
    fakePlatform('win32');
    vi.useFakeTimers({ toFake: ['performance'] });
    failOpen('wx', 'EPERM', 1);
    expect(await acquireFileLock(lock, { staleMs: 60_000 })).toBeNull(); // refused: a run starts at 0 s
    vi.restoreAllMocks();
    vi.advanceTimersByTime(50_000);
    await plantLock({ pid: process.ppid });
    expect(await acquireFileLock(lock, { staleMs: 60_000 })).toBeNull(); // held by a live process: the run ends
    expect((await readLock()).token).toBe('planted');
    await fsp.rm(lock);

    vi.advanceTimersByTime(20_000);
    failOpen('wx', 'EPERM', 1);
    expect(await acquireFileLock(lock, { staleMs: 60_000 })).toBeNull(); // 70 s after the first refusal: a new run
    vi.restoreAllMocks();
    vi.advanceTimersByTime(50_000);
    const handle = await acquire({ staleMs: 60_000 }); // taken: the run ends
    expect(handle).not.toBeNull();
    await handle!.release();

    vi.advanceTimersByTime(20_000);
    failOpen('wx', 'EBUSY', 1);
    expect(await acquireFileLock(lock, { staleMs: 60_000 })).toBeNull(); // a new run
    vi.restoreAllMocks();
    vi.advanceTimersByTime(50_000);
    failOpen('wx', 'EIO', 1);
    await expect(acquireFileLock(lock, { staleMs: 60_000 })).rejects.toMatchObject({ code: 'EIO' }); // ends it too
    vi.restoreAllMocks();
    vi.advanceTimersByTime(20_000);
    failOpen('wx', 'EACCES', 1);
    expect(await acquireFileLock(lock, { staleMs: 60_000 })).toBeNull();
  });

  it('on Windows, keeps a run per lock path', async () => {
    fakePlatform('win32');
    vi.useFakeTimers({ toFake: ['performance'] });
    const other = path.join(dir, 'boot.lock');
    failOpen('wx', 'EPERM');
    expect(await acquireFileLock(lock, { staleMs: 60_000 })).toBeNull();
    vi.advanceTimersByTime(61_000);
    const taken = await acquireFileLock(other, { staleMs: 60_000 }); // another path: not refused, its own answer
    expect(taken).not.toBeNull();
    await taken!.release();
    await expect(acquireFileLock(lock, { staleMs: 60_000 })).rejects.toMatchObject({ meta: { reason: 'lock_io', code: 'EPERM' } });
  });

  it('throws other errors as they are', async () => {
    failOpen('wx', 'EIO');
    await expect(acquireFileLock(lock)).rejects.toMatchObject({ code: 'EIO' });
  });

  it('refuses a staleMs that is not positive', async () => {
    await expect(acquireFileLock(lock, { staleMs: 0 })).rejects.toThrow(RangeError);
    await expect(acquireFileLock(lock, { staleMs: Number.NaN })).rejects.toThrow(RangeError);
  });
});

describe('processGone (R33/R36)', () => {
  it('is true for a dead pid of this host, false for a live one', () => {
    expect(processGone({ pid: deadPid(), startMs: thisProcessStartMs(), host: lockHostIdentity() })).toBe(true);
    expect(processGone({ pid: process.ppid, startMs: 1, host: lockHostIdentity() })).toBe(false);
  });

  it('is true for our own pid with another start time (a reused pid), false for this very process', () => {
    expect(processGone({ pid: process.pid, startMs: processStartMs() - 60_000, host: lockHostIdentity() })).toBe(true);
    expect(processGone({ pid: process.pid, startMs: processStartMs(), host: lockHostIdentity() })).toBe(false);
  });

  it('cannot judge a process of another host identity, nor one without a host: false', () => {
    expect(processGone({ pid: deadPid(), startMs: 1, host: 'another-box' })).toBe(false);
    expect(processGone({ pid: deadPid(), startMs: 1, host: null })).toBe(false);
  });

  it('never signals a bogus pid: false without calling process.kill', () => {
    const kill = vi.spyOn(process, 'kill');
    for (const pid of [0, -1, 1.5, 2 ** 31, Number.NaN]) {
      expect(processGone({ pid, startMs: 1, host: lockHostIdentity() })).toBe(false);
    }
    expect(kill).not.toHaveBeenCalled();
  });
});
