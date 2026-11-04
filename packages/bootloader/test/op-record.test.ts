import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lockHostIdentity, processStartMs } from '@altis/platform';
import { OP_STATES, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STEP_LOCK_WAIT_MS, readUpdateOpFor, recordPendingFailure, touchOpHeartbeat } from '../src/op-record.js';

// app.js and op.json (decision D1d-18, preflight B8, S3, 1D-02): the record of a failed pending boot under
// ops/step.lock, the lock-free look before importing a pending release, and the holder's heartbeat. op.json is read
// as plain JSON and every field app.js does not know is written back as it was (opSchema 1 is shared with every later
// release).

const V = '0.2.0-test';
const NOW = Date.now();
const FAILURE = { code: 'UPDATE_BOOT_FAILED', detail: 'start' } as const;

let dataDir: string;

beforeEach(async () => {
  dataDir = path.join(await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-op-record-'))), 'data');
  await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
});

afterEach(async () => {
  await fsp.rm(path.dirname(dataDir), { recursive: true, force: true });
});

function opPath(): string {
  return path.join(dataDir, 'ops', 'op.json');
}

/** An `update` op as the server writes it, with fields app.js does not know (top level and in params). */
function updateOp(state: string, o: { target?: string; kind?: string; stateBefore?: string; pointOfNoReturn?: boolean; error?: unknown } = {}): Record<string, unknown> {
  const target = o.target ?? V;
  const op: Record<string, unknown> = {
    opSchema: 1,
    opId: newId(),
    kind: o.kind ?? 'update',
    actor: { type: 'staff', id: newId() },
    state,
    version: target,
    backupId: null,
    heartbeatAt: NOW - 60_000,
    startedAt: NOW - 600_000,
    finishedAt: null,
    error: o.error ?? null,
    opsTokenHash: 'a'.repeat(64),
    pointOfNoReturn: o.pointOfNoReturn ?? true,
    params: { target, source: 'feed', from: '0.1.0-test', pendingWritten: true, futureParam: { kept: [1, 2] } },
    progress: 60,
    message: null,
    futureField: 'kept',
  };
  if (o.stateBefore !== undefined) op['stateBefore'] = o.stateBefore;
  return op;
}

async function writeOp(op: Record<string, unknown>): Promise<string> {
  const text = `${JSON.stringify(op, null, 2)}\n`;
  await fsp.writeFile(opPath(), text);
  return text;
}

async function readOp(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(opPath(), 'utf8')) as Record<string, unknown>;
}

/** ops/step.lock held by a live process (this one) and fresh: a waiter never takes it. */
async function holdStepLock(): Promise<void> {
  await fsp.writeFile(
    path.join(dataDir, 'ops', 'step.lock'),
    JSON.stringify({ pid: process.pid, startMs: processStartMs(), token: 'held-by-the-test', host: lockHostIdentity() }),
  );
}

describe('recordPendingFailure', () => {
  it.each(['switched', 'booting', 'migrating', 'verifying'])('an update op of the target in %s moves to reverting: written', async (state) => {
    const before = updateOp(state);
    await writeOp(before);
    expect(await recordPendingFailure(dataDir, V, FAILURE, NOW)).toBe('written');
    const after = await readOp();
    expect(after).toEqual({ ...before, state: 'reverting', stateBefore: state, error: FAILURE, heartbeatAt: NOW });
    // Every unknown field is still there, and the result is a state of opSchema 1.
    expect(after['futureField']).toBe('kept');
    expect((after['params'] as Record<string, unknown>)['futureParam']).toEqual({ kept: [1, 2] });
    expect(OP_STATES.update).toContain(after['state']);
    expect(OP_STATES.update).toContain(after['stateBefore']);
    // Written like every op.json write: atomically, the previous content kept in the .bak.
    expect(JSON.parse(await fsp.readFile(`${opPath()}.bak`, 'utf8'))).toEqual(before);
    await expect(fsp.stat(path.join(dataDir, 'ops', 'step.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('1D-02: an op in needs_attention is judged by its stateBefore (migrating → reverting)', async () => {
    const before = updateOp('needs_attention', { stateBefore: 'migrating', error: { code: 'DB_UNAVAILABLE' } });
    await writeOp(before);
    expect(await recordPendingFailure(dataDir, V, { code: 'UPDATE_BOOT_FAILED', detail: 'repeated' }, NOW)).toBe('written');
    expect(await readOp()).toEqual({
      ...before,
      state: 'reverting',
      stateBefore: 'migrating',
      error: { code: 'UPDATE_BOOT_FAILED', detail: 'repeated' },
      heartbeatAt: NOW,
    });
  });

  it.each([
    ['reverting', undefined],
    ['restoring', undefined],
    ['needs_attention', 'reverting'],
    ['rolled_back', undefined],
    ['done', undefined],
    ['restore_failed', undefined],
  ])('an op of the target already in %s (stateBefore %s) is left as it is: already', async (state, stateBefore) => {
    const text = await writeOp(updateOp(state, stateBefore === undefined ? {} : { stateBefore }));
    expect(await recordPendingFailure(dataDir, V, FAILURE, NOW)).toBe('already');
    expect(await fsp.readFile(opPath(), 'utf8')).toBe(text);
  });

  it('another target, another kind, an op before the point of no return, no op or an unreadable one: none, nothing written', async () => {
    for (const op of [updateOp('migrating', { target: '0.3.0-test' }), updateOp('frozen', { kind: 'backup' }), updateOp('staged'), updateOp('needs_attention', { stateBefore: 'downloading' })]) {
      const text = await writeOp(op);
      expect(await recordPendingFailure(dataDir, V, FAILURE, NOW)).toBe('none');
      expect(await fsp.readFile(opPath(), 'utf8')).toBe(text);
    }
    await fsp.rm(opPath());
    expect(await recordPendingFailure(dataDir, V, FAILURE, NOW)).toBe('none');
    await fsp.writeFile(opPath(), '{"opSchema":');
    await fsp.writeFile(`${opPath()}.bak`, 'garbage');
    expect(await recordPendingFailure(dataDir, V, FAILURE, NOW)).toBe('none');
    expect(await fsp.readFile(opPath(), 'utf8')).toBe('{"opSchema":');
  });

  it('a torn op.json is read from its .bak', async () => {
    await writeOp(updateOp('booting'));
    await fsp.copyFile(opPath(), `${opPath()}.bak`);
    await fsp.writeFile(opPath(), '{"opSchema":1,');
    expect(await recordPendingFailure(dataDir, V, FAILURE, NOW)).toBe('written');
    expect(await readOp()).toMatchObject({ state: 'reverting', stateBefore: 'booting', error: FAILURE });
  });

  it('S3: ops/step.lock busy for the whole wait → busy, nothing written; the wait is 25 s by default', async () => {
    expect(STEP_LOCK_WAIT_MS).toBe(25_000);
    const text = await writeOp(updateOp('switched'));
    await holdStepLock();
    const began = performance.now();
    expect(await recordPendingFailure(dataDir, V, FAILURE, NOW, { waitMs: 300 })).toBe('busy');
    expect(performance.now() - began).toBeGreaterThanOrEqual(250);
    expect(await fsp.readFile(opPath(), 'utf8')).toBe(text);
  });

  it('creates the ops folder when an installation never had an op: none', async () => {
    await fsp.rm(path.join(dataDir, 'ops'), { recursive: true });
    expect(await recordPendingFailure(dataDir, V, FAILURE, NOW)).toBe('none');
  });
});

describe('readUpdateOpFor (B8: read before importing)', () => {
  it('null without an op, for another target or another kind', async () => {
    expect(await readUpdateOpFor(dataDir, V)).toBeNull();
    await writeOp(updateOp('reverting', { target: '0.3.0-test' }));
    expect(await readUpdateOpFor(dataDir, V)).toBeNull();
    await writeOp(updateOp('frozen', { kind: 'backup' }));
    expect(await readUpdateOpFor(dataDir, V)).toBeNull();
    await fsp.writeFile(opPath(), 'garbage');
    expect(await readUpdateOpFor(dataDir, V)).toBeNull();
  });

  it('settled for reverting, restoring and needs_attention after the point of no return; detail = error.detail', async () => {
    await writeOp(updateOp('reverting', { error: { code: 'UPDATE_BOOT_FAILED', detail: 'migration' } }));
    expect(await readUpdateOpFor(dataDir, V)).toEqual({ settled: true, detail: 'migration' });
    await writeOp(updateOp('restoring', { error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' } }));
    expect(await readUpdateOpFor(dataDir, V)).toEqual({ settled: true, detail: 'health' });
    await writeOp(updateOp('needs_attention', { stateBefore: 'migrating' }));
    expect(await readUpdateOpFor(dataDir, V)).toEqual({ settled: true, detail: null });
  });

  it('not settled while the target boots, or for needs_attention before the point of no return', async () => {
    for (const state of ['switched', 'booting', 'migrating', 'verifying']) {
      await writeOp(updateOp(state));
      expect(await readUpdateOpFor(dataDir, V)).toEqual({ settled: false, detail: null });
    }
    await writeOp(updateOp('needs_attention', { stateBefore: 'checking', pointOfNoReturn: false }));
    expect(await readUpdateOpFor(dataDir, V)).toEqual({ settled: false, detail: null });
  });

  it('takes no lock: it answers while ops/step.lock is held', async () => {
    await writeOp(updateOp('reverting'));
    await holdStepLock();
    expect(await readUpdateOpFor(dataDir, V)).toEqual({ settled: true, detail: null });
  });
});

describe('touchOpHeartbeat', () => {
  it('sets heartbeatAt of the update op the holder boots, keeping every other field', async () => {
    const before = updateOp('migrating');
    await writeOp(before);
    await touchOpHeartbeat(dataDir, V, NOW + 10_000);
    expect(await readOp()).toEqual({ ...before, heartbeatAt: NOW + 10_000 });
  });

  it('skips at once while ops/step.lock is busy', async () => {
    const text = await writeOp(updateOp('migrating'));
    await holdStepLock();
    const began = performance.now();
    await touchOpHeartbeat(dataDir, V, NOW + 10_000);
    expect(performance.now() - began).toBeLessThan(1000);
    expect(await fsp.readFile(opPath(), 'utf8')).toBe(text);
  });

  it('never touches another op: another target, an op that ended, one reverting or needing attention', async () => {
    for (const op of [updateOp('migrating', { target: '0.3.0-test' }), updateOp('done'), updateOp('reverting'), updateOp('needs_attention', { stateBefore: 'migrating' })]) {
      const text = await writeOp(op);
      await touchOpHeartbeat(dataDir, V, NOW + 10_000);
      expect(await fsp.readFile(opPath(), 'utf8')).toBe(text);
    }
    await fsp.rm(opPath());
    await touchOpHeartbeat(dataDir, V, NOW + 10_000); // no op: nothing
    await expect(fsp.stat(opPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
