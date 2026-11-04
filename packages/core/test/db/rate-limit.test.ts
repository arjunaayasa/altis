import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { BUCKETS, bucketKey, clearBucket, hit, refund, type BucketName, type Hit } from '../../src/auth/rate-limit.js';

// The DB rate limiter (spec §7.1, D11): a sliding-window counter over two fixed windows, incremented before the
// decision, so concurrent callers can never all pass. On the engine picked by ALTIS_TEST_DB; the atomicity case runs
// in child processes, one connection each (SQLite too, B5).

const ctx = testDbContext();

const MIN = 60_000;
/** 2026-01-01T00:00:00Z: a multiple of every window length below (1 min ... 24 h). */
const T = 1_767_225_600_000;
const W15 = 15 * MIN;

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('BUCKETS', () => {
  it('is the table of the plan, verbatim', () => {
    expect(BUCKETS).toEqual({
      'login:user-ip': { limit: 5, windowMs: 15 * MIN },
      'login:ip': { limit: 20, windowMs: 15 * MIN },
      'login:user': { limit: 50, windowMs: 60 * MIN },
      'login:dev': { limit: 10, windowMs: 15 * MIN },
      '2fa:session': { limit: 5, windowMs: 15 * MIN },
      '2fa:user': { limit: 10, windowMs: 15 * MIN },
      'recovery:user': { limit: 5, windowMs: 60 * MIN },
      'reauth:session': { limit: 5, windowMs: 15 * MIN },
      'forgot:email:5m': { limit: 1, windowMs: 5 * MIN },
      'forgot:email:1d': { limit: 5, windowMs: 24 * 60 * MIN },
      'forgot:ip': { limit: 10, windowMs: 60 * MIN },
      'reset:ip': { limit: 20, windowMs: 60 * MIN },
      'authz-denied': { limit: 1, windowMs: MIN },
      // Phase 2 (its spec §9.1, §6; decision P2-29): per IP for the OPAC search and OAI-PMH, per user for copy lookups.
      opac_search: { limit: 120, windowMs: MIN },
      oai: { limit: 60, windowMs: MIN },
      catalog_lookup: { limit: 30, windowMs: MIN },
    });
    expect(Object.isFrozen(BUCKETS)).toBe(true);
    expect(Object.isFrozen(BUCKETS['login:ip'])).toBe(true);
    // T is a window start for every bucket, so the cases below can place `now` exactly.
    for (const b of Object.values(BUCKETS)) expect(T % b.windowMs).toBe(0);
  });

  it('bucketKey is sha256hex(name + ":" + subject)', () => {
    expect(bucketKey('login:ip', '203.0.113.9')).toBe(sha256('login:ip:203.0.113.9'));
    expect(bucketKey('login:user-ip', 'budi:203.0.113.9')).toBe(sha256('login:user-ip:budi:203.0.113.9'));
  });
});

/** A fork of `fixture` per entry of `options`; each starts its work once all report 'ready' (as packages/db's runChildren). */
async function runChildren<R>(fixture: string, options: object[], timeoutMs = 25_000): Promise<{ codes: (number | null)[]; reports: (R | undefined)[] }> {
  const children: ChildProcess[] = [];
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const runs = options.map((o) => {
      const child = fork(path.join(import.meta.dirname, '../fixtures', fixture), [JSON.stringify(o)], {
        cwd: path.resolve(import.meta.dirname, '../../../..'),
        env: process.env,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let report: R | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else report = message as R;
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
      });
      // 'close' comes after every IPC message has been delivered.
      const exited = new Promise<{ code: number | null; report: R | undefined }>((resolve) =>
        child.once('close', (code) => resolve({ code, report })),
      );
      return { child, ready, exited };
    });
    await Promise.all(runs.map((r) => r.ready));
    for (const r of runs) r.child.send('go');
    const done = await Promise.all(runs.map((r) => r.exited));
    return { codes: done.map((d) => d.code), reports: done.map((d) => d.report) };
  } finally {
    clearTimeout(timer);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

describe.skipIf(!ctx.available)(`hit / refund / clearBucket (spec §7.1, D11) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-rate-limit-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('rate_limits').execute();
  });

  const once = (name: BucketName, subject: string, now: number): Promise<Hit> => withTx(h, (trx) => hit(trx, name, subject, now));

  async function hits(n: number, name: BucketName, subject: string, now: number): Promise<Hit[]> {
    const out: Hit[] = [];
    for (let i = 0; i < n; i += 1) out.push(await once(name, subject, now));
    return out;
  }

  const stored = () =>
    h.db.selectFrom('rate_limits').select(['bucket', 'window_start', 'bucket_name', 'count']).orderBy('window_start').execute();

  it('within one window: hits 1-5 pass, the 6th is refused with the seconds left in the window', async () => {
    const now = T + MIN + 500; // 1 min 0.5 s into the window: 839.5 s left, rounded up
    const first = await hits(5, 'login:user-ip', 'budi:203.0.113.9', now);
    expect(first.map((x) => [x.count, x.allowed, x.retryAfterS])).toEqual([
      [1, true, 0],
      [2, true, 0],
      [3, true, 0],
      [4, true, 0],
      [5, true, 0],
    ]);
    const sixth = await once('login:user-ip', 'budi:203.0.113.9', now);
    expect(sixth).toEqual({
      name: 'login:user-ip',
      subject: 'budi:203.0.113.9',
      bucket: sha256('login:user-ip:budi:203.0.113.9'),
      windowStart: T,
      count: 6,
      allowed: false,
      retryAfterS: 840,
    });
    // The last millisecond of the window: 1 ms left is 1 s.
    expect((await once('login:user-ip', 'budi:203.0.113.9', T + W15 - 1)).retryAfterS).toBe(1);
  });

  it('another subject or another bucket name counts on its own', async () => {
    await hits(5, 'login:user-ip', 'budi:203.0.113.9', T);
    expect((await once('login:user-ip', 'budi:203.0.113.9', T)).allowed).toBe(false);
    expect(await once('login:user-ip', 'siti:203.0.113.9', T)).toMatchObject({ count: 1, allowed: true });
    expect(await once('login:ip', 'budi:203.0.113.9', T)).toMatchObject({ count: 1, allowed: true });
  });

  it('sliding: 5 in the previous window, half-way through this one → floor(5 × 0.5) = 2, so 3 pass and the 4th is refused', async () => {
    const before = await hits(5, 'login:user-ip', 'budi:203.0.113.9', T - W15 + 3 * MIN);
    expect(before.every((x) => x.allowed && x.windowStart === T - W15)).toBe(true);
    const now = T + W15 / 2;
    const after = await hits(4, 'login:user-ip', 'budi:203.0.113.9', now);
    expect(after.map((x) => [x.windowStart, x.count, x.allowed])).toEqual([
      [T, 1, true],
      [T, 2, true],
      [T, 3, true],
      [T, 4, false],
    ]);
    expect(after[3]?.retryAfterS).toBe(W15 / 2 / 1000);
  });

  it('sliding: the previous window weighs less as the current one goes on, and a window two back not at all', async () => {
    await hits(5, 'login:user-ip', 'budi:203.0.113.9', T - W15);
    // 0.9 of the window gone: floor(5 × 0.1) = 0, so 5 pass.
    const late = await hits(6, 'login:user-ip', 'budi:203.0.113.9', T + 0.9 * W15);
    expect(late.map((x) => x.allowed)).toEqual([true, true, true, true, true, false]);
    await h.db.deleteFrom('rate_limits').execute();
    await hits(5, 'login:user-ip', 'budi:203.0.113.9', T - 2 * W15);
    // At the very start of a window the previous one counts whole; two windows back, nothing.
    expect((await hits(6, 'login:user-ip', 'budi:203.0.113.9', T)).map((x) => x.allowed)).toEqual([true, true, true, true, true, false]);
  });

  it('stores bucket = sha256hex(name:subject) and bucket_name = name:subject (TEXT, R43)', async () => {
    await once('login:ip', '203.0.113.9', T + 7);
    expect(await stored()).toEqual([
      { bucket: sha256('login:ip:203.0.113.9'), window_start: T, bucket_name: 'login:ip:203.0.113.9', count: 1 },
    ]);
  });

  it('refund brings count from 3 to 2, and never below 0', async () => {
    const three = await hits(3, 'login:user', 'budi', T);
    await withTx(h, (trx) => refund(trx, three[2] as Hit));
    expect((await stored()).map((r) => r.count)).toEqual([2]);
    await withTx(h, (trx) => refund(trx, three[2] as Hit));
    await withTx(h, (trx) => refund(trx, three[2] as Hit));
    expect((await stored()).map((r) => r.count)).toEqual([0]);
    await withTx(h, (trx) => refund(trx, three[2] as Hit));
    expect((await stored()).map((r) => r.count)).toEqual([0]);
    // A refunded slot can be used again.
    expect(await once('login:user', 'budi', T)).toMatchObject({ count: 1, allowed: true });
  });

  it('refund touches only the window of its hit', async () => {
    const old = await once('login:user', 'budi', T - 60 * MIN);
    await hits(2, 'login:user', 'budi', T);
    await withTx(h, (trx) => refund(trx, old));
    expect((await stored()).map((r) => [r.window_start, r.count])).toEqual([
      [T - 60 * MIN, 0],
      [T, 2],
    ]);
  });

  it('clearBucket removes both windows of the bucket and nothing else', async () => {
    await hits(2, 'login:user-ip', 'budi:203.0.113.9', T - W15);
    await hits(2, 'login:user-ip', 'budi:203.0.113.9', T);
    await once('login:user-ip', 'siti:203.0.113.9', T);
    await once('login:ip', '203.0.113.9', T);
    await withTx(h, (trx) => clearBucket(trx, 'login:user-ip', 'budi:203.0.113.9'));
    expect((await stored()).map((r) => r.bucket_name).sort()).toEqual(['login:ip:203.0.113.9', 'login:user-ip:siti:203.0.113.9']);
  });

  it('a refused hit rolls back with its transaction (the caller decides what to commit)', async () => {
    await expect(
      withTx(h, async (trx) => {
        await hit(trx, 'login:dev', 'dev-1', T);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await stored()).toEqual([]);
  });

  it('refuses bad arguments with a TypeError before anything is written', async () => {
    await expect(withTx(h, (trx) => hit(trx, 'login:nope' as BucketName, 'x', T))).rejects.toThrow(TypeError);
    await expect(withTx(h, (trx) => hit(trx, 'toString' as BucketName, 'x', T))).rejects.toThrow(TypeError);
    await expect(withTx(h, (trx) => hit(trx, 'login:ip', '', T))).rejects.toThrow(TypeError);
    await expect(withTx(h, (trx) => hit(trx, 'login:ip', 'a\u0000b', T))).rejects.toThrow(TypeError);
    await expect(withTx(h, (trx) => hit(trx, 'login:ip', '\ud800', T))).rejects.toThrow(TypeError);
    await expect(withTx(h, (trx) => hit(trx, 'login:ip', 7 as unknown as string, T))).rejects.toThrow(TypeError);
    for (const now of [T + 0.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1' as unknown as number]) {
      await expect(withTx(h, (trx) => hit(trx, 'login:ip', 'x', now))).rejects.toThrow(TypeError);
    }
    await expect(withTx(h, (trx) => clearBucket(trx, 'nope' as BucketName, 'x'))).rejects.toThrow(TypeError);
    // Outside a transaction: the handle is refused, as by the db primitives.
    await expect(hit(h.db as never, 'login:ip', 'x', T)).rejects.toThrow(TypeError);
    await expect(refund(h.db as never, { bucket: sha256('login:ip:x'), windowStart: T } as Hit)).rejects.toThrow(TypeError);
    await expect(clearBucket(h.db as never, 'login:ip', 'x')).rejects.toThrow(TypeError);
    expect(await stored()).toEqual([]);
  });

  it('3 processes × 17 concurrent hits on one subject at one fixed now: exactly 5 pass, counts 1..51', async () => {
    const now = T + MIN; // 1 minute into the window: no boundary can split the run (M26)
    const subject = 'budi:198.51.100.7';
    const run = await runChildren<{ results: { allowed: boolean; count: number }[] }>(
      'limit-child.mjs',
      [0, 1, 2].map(() => ({ config: h.config, dataDir: h.dataDir, count: 17, name: 'login:user-ip', subject, now })),
    );
    expect(run.codes).toEqual([0, 0, 0]);
    const results = run.reports.flatMap((r) => r?.results ?? []);
    expect(results).toHaveLength(51);
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    expect(results.filter((r) => r.allowed).map((r) => r.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(await stored()).toEqual([
      { bucket: sha256(`login:user-ip:${subject}`), window_start: T, bucket_name: `login:user-ip:${subject}`, count: 51 },
    ]);
  });
});
