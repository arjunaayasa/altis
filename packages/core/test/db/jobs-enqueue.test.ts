import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError, newId } from '@altis/shared';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { claimNext } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { EnqueueInput, JobHandler } from '../../src/jobs/types.js';
import { runJobChildren } from '../fixtures/job-children.js';

// enqueue (spec §10.1 "enqueue dengan unique_key milik tugas yang masih hidup mengembalikan tugas yang sudah ada"):
// payload checked by the handler's schema, the unique key of a live job, the secret sealed into secret_param.

const ctx = testDbContext();
const T = 1_767_225_600_000;
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent = { info() {}, warn() {}, error() {} };

const seen: { secret: Uint8Array | null }[] = [];
const echo: JobHandler<{ n: number }> = {
  type: 'test.echo',
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: z.strictObject({ n: z.number().int() }),
  async run(c) {
    seen.push({ secret: await c.secretParam() });
    return { done: true };
  },
};
const light: JobHandler<Record<string, never>> = {
  type: 'test.light',
  permission: 'system.jobs.manage',
  retryable: 'api',
  maxAttempts: 3,
  payload: z.strictObject({}),
  run: () => Promise.resolve({ done: true }),
};
const blob: JobHandler<{ s: string }> = { ...light, type: 'test.blob', payload: z.strictObject({ s: z.string() }) } as never;
const reg = createJobRegistry([echo, light, blob]);

describe.skipIf(!ctx.available)(`enqueue [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-jobs-enqueue-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('jobs').execute();
    seen.length = 0;
  });

  const put = (input: EnqueueInput, now = T) => withTx(h, (trx) => enqueue(trx, reg, input, { now, keyring }));
  const row = (id: string) => h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  /** Claims and runs the one due job to its end. */
  async function finishOne(now: number) {
    const job = await claimNext(h, reg, { worker: 'w1', now });
    expect(job).not.toBeNull();
    return runSlice(h, reg, job!, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => now, env: {} });
  }

  it('writes a queued job: payload JSON, run_at, attempts 0, max_attempts from the handler or the default', async () => {
    const a = await put({ type: 'test.echo', payload: { n: 7 }, createdBy: null });
    expect(a.existing).toBe(false);
    expect(await row(a.id)).toMatchObject({
      id: a.id,
      type: 'test.echo',
      payload: '{"n":7}',
      status: 'queued',
      run_at: T,
      attempts: 0,
      max_attempts: 5,
      unique_key: null,
      lock_token: null,
      locked_by: null,
      locked_until: null,
      secret_param: null,
      created_by: null,
      created_at: T,
      updated_at: T,
      finished_at: null,
    });
    const creator = newId();
    const b = await put({ type: 'test.light', payload: {}, runAt: T + 5000, createdBy: creator });
    expect(await row(b.id)).toMatchObject({ run_at: T + 5000, max_attempts: 3, created_by: creator });
    const c = await put({ type: 'test.light', payload: {}, maxAttempts: 9 });
    expect((await row(c.id)).max_attempts).toBe(9);
  });

  it('a live job holding uniqueKey is returned; once it has finished (unique_key NULL) a new job is created', async () => {
    const first = await put({ type: 'test.echo', payload: { n: 1 }, uniqueKey: 'k' });
    const second = await put({ type: 'test.echo', payload: { n: 2 }, uniqueKey: 'k' });
    expect(second).toEqual({ id: first.id, existing: true });
    expect(await h.db.selectFrom('jobs').select('id').execute()).toHaveLength(1);

    expect((await finishOne(T)).outcome).toBe('succeeded');
    expect(await row(first.id)).toMatchObject({ status: 'succeeded', unique_key: null });

    const third = await put({ type: 'test.echo', payload: { n: 3 }, uniqueKey: 'k' });
    expect(third.existing).toBe(false);
    expect(third.id).not.toBe(first.id);
    expect((await row(third.id)).unique_key).toBe('k');
  });

  it('a payload the handler schema refuses → VALIDATION_FAILED with field errors, nothing written', async () => {
    const error = await put({ type: 'test.echo', payload: { n: 'seven' } }).catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('VALIDATION_FAILED');
    expect(isDomainError(error) && error.meta?.['errors']).toEqual([{ path: 'payload.n', code: 'invalid_type' }]);
    const extra = await put({ type: 'test.echo', payload: { n: 1, x: 2 } }).catch((e: unknown) => e);
    expect(isDomainError(extra) && extra.code).toBe('VALIDATION_FAILED');
    expect(await h.db.selectFrom('jobs').select('id').execute()).toEqual([]);
  });

  it('refuses an unknown type and malformed options with a TypeError', async () => {
    await expect(put({ type: 'test.nope', payload: {} })).rejects.toThrow(TypeError);
    await expect(put({ type: 'test.light', payload: {}, uniqueKey: '' })).rejects.toThrow(TypeError);
    await expect(put({ type: 'test.light', payload: {}, uniqueKey: 'k ' })).rejects.toThrow(TypeError);
    await expect(put({ type: 'test.light', payload: {}, uniqueKey: 'x'.repeat(192) })).rejects.toThrow(TypeError);
    await expect(put({ type: 'test.light', payload: {}, maxAttempts: 0 })).rejects.toThrow(TypeError);
    await expect(put({ type: 'test.light', payload: {}, createdBy: 'nobody' })).rejects.toThrow(TypeError);
    await expect(put({ type: 'test.light', payload: {}, runAt: 1.5 })).rejects.toThrow(TypeError);
    // jobs.payload is TEXT (65 535 bytes on MySQL/MariaDB); a secret stays small.
    await expect(put({ type: 'test.blob', payload: { s: '\u00e9'.repeat(32_764) } })).rejects.toThrow(TypeError);
    expect((await put({ type: 'test.blob', payload: { s: 'x'.repeat(65_527) } })).existing).toBe(false);
    await expect(put({ type: 'test.light', payload: {}, secret: new Uint8Array(4097) })).rejects.toThrow(TypeError);
    await expect(withTx(h, () => enqueue(h.db as never, reg, { type: 'test.light', payload: {} }, { now: T, keyring }))).rejects.toThrow(
      TypeError,
    );
  });

  it('seals the secret into secret_param (v1: text, AAD jobs.secret_param.<id>); ctx.secretParam() returns the bytes', async () => {
    const secret = new Uint8Array(randomBytes(48));
    const a = await put({ type: 'test.echo', payload: { n: 1 }, secret });
    const stored = (await row(a.id)).secret_param;
    expect(stored).toMatch(/^v1:k1:/);
    expect(stored).not.toContain(Buffer.from(secret).toString('base64url'));

    expect((await finishOne(T)).outcome).toBe('succeeded');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.secret).toEqual(secret);
    // Cleared on the terminal status.
    expect((await row(a.id)).secret_param).toBeNull();

    // A job without a secret reads null.
    await put({ type: 'test.echo', payload: { n: 2 } });
    await finishOne(T);
    expect(seen[1]?.secret).toBeNull();
  });

  it('enqueues racing from several processes with one uniqueKey → one job, every caller gets its id', async () => {
    const options = Array.from({ length: 4 }, (_, i) => ({
      config: h.config,
      dataDir: h.dataDir,
      action: 'enqueue',
      worker: `w${i}`,
      uniqueKey: 'race',
    }));
    const runs = await runJobChildren<{ id: string; existing: boolean }>(options);
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    const jobs = await h.db.selectFrom('jobs').select(['id', 'unique_key']).execute();
    expect(jobs).toEqual([{ id: jobs[0]!.id, unique_key: 'race' }]);
    expect(runs.map((r) => r.report?.id)).toEqual([jobs[0]!.id, jobs[0]!.id, jobs[0]!.id, jobs[0]!.id]);
    expect(runs.filter((r) => r.report?.existing === false)).toHaveLength(1);
  });
});
