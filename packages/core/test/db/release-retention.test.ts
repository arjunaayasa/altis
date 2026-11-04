import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dataPath, readCurrentState, updateCurrentState, withFileLock, type CurrentState } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import type { JobContext } from '../../src/jobs/types.js';
import { stepLockPath, writeOpFile, type OpFile } from '../../src/ops/files.js';
import { releaseRetention, releaseRetentionJob, runReleaseRetention, sweepReleaseStaging } from '../../src/updates/retention.js';

// Release retention and the staging sweep (spec §9.3 "Retensi: simpan active, previous, pending, pinned; sisanya
// dihapus setelah boot sehat. `.tmp-*` dihapus saat boot"; plan Task 27; decisions D1d-16, D1d-23; preflight 1D-20):
// retention keeps the releases current.json names and the target of an update op that has not ended (between
// `backed_up` and `switched` nothing else names it), the sweep keeps the staging folder of such an op. The job reads
// op.json and current.json under ops/step.lock, so no update step runs between its look and its removals.

const ctx = testDbContext();
const V = (minor: number): string => `0.${minor}.0-test`;
const silent = { info() {}, warn() {}, error() {} };

describe.skipIf(!ctx.available)(`release retention and the staging sweep [${engineLabel()}]`, () => {
  let root: string;
  let dataDir: string;
  let op1: string;
  let op2: string;

  afterAll(async () => {
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root ??= await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-retention-')));
    dataDir = path.join(await fsp.mkdtemp(path.join(root, 'case-')), 'data');
    await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
    for (const minor of [1, 2, 3, 4]) {
      await fsp.mkdir(path.join(dataDir, 'releases', V(minor)), { recursive: true });
      await fsp.writeFile(path.join(dataDir, 'releases', V(minor), '.complete'), '');
    }
    op1 = newId(Date.now() - 60_000);
    op2 = newId();
    await fsp.mkdir(path.join(dataDir, 'releases', `.tmp-${V(5)}-${op1}`, 'release'), { recursive: true });
    await fsp.mkdir(path.join(dataDir, 'releases', `.tmp-${V(6)}-${op2}`, 'release'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'releases', `.tmp-${V(6)}-${op2}`, 'package.zip'), 'zip');
    // current.json: active 0.2, previous 0.1, pinned 0.3.
    await readCurrentState(dataDir, V(2));
    await updateCurrentState(dataDir, (s) => ({ ...s, active: { version: V(2), source: 'data' }, previous: { version: V(1), source: 'data' }, pinned: V(3) }));
  });

  const names = async (): Promise<string[]> => (await fsp.readdir(path.join(dataDir, 'releases'))).sort();
  const state = (): Promise<CurrentState> => readCurrentState(dataDir, V(2));

  function updateOp(o: { opId: string; target: string; state: string; stateBefore?: string }): OpFile {
    const at = Date.now();
    return {
      opSchema: 1,
      opId: o.opId,
      kind: 'update',
      actor: { type: 'system', id: null },
      state: o.state,
      ...(o.stateBefore === undefined ? {} : { stateBefore: o.stateBefore }),
      version: o.target,
      backupId: null,
      heartbeatAt: at,
      startedAt: at,
      finishedAt: o.state === 'done' || o.state === 'aborted' ? at : null,
      error: null,
      opsTokenHash: null,
      pointOfNoReturn: false,
      params: { source: 'feed', target: o.target, from: V(2), entry: null, staging: null, needsBackup: null },
      progress: 0,
      message: null,
    };
  }

  it('keeps active, previous, pinned and the active op; removes 0.4 and the ended op staging folder, nothing else', async () => {
    const active = updateOp({ opId: op2, target: V(6), state: 'downloading' });
    expect(await releaseRetention({ dataDir, state: await state(), activeOp: active })).toEqual({ removed: [V(4)] });
    expect(await sweepReleaseStaging(dataDir, active)).toEqual([`.tmp-${V(5)}-${op1}`]);
    const left = await names();
    expect(left).toEqual(expect.arrayContaining([V(1), V(2), V(3), `.tmp-${V(6)}-${op2}`, 'current.json']));
    expect(left).not.toContain(V(4));
    expect(left).not.toContain(`.tmp-${V(5)}-${op1}`);
    // The kept staging folder is whole.
    expect(await fsp.readFile(path.join(dataDir, 'releases', `.tmp-${V(6)}-${op2}`, 'package.zip'), 'utf8')).toBe('zip');
  });

  it('1D-20: an update op that has not ended and targets 0.4 (backed_up: named by nothing else) → 0.4 is kept', async () => {
    const op = updateOp({ opId: op2, target: V(4), state: 'backed_up' });
    expect(await releaseRetention({ dataDir, state: await state(), activeOp: op })).toEqual({ removed: [] });
    expect(await names()).toContain(V(4));
    // So is the target of one stuck in needs_attention (judged by the state it left).
    const stuck = updateOp({ opId: op2, target: V(4), state: 'needs_attention', stateBefore: 'staged' });
    expect(await releaseRetention({ dataDir, state: await state(), activeOp: stuck })).toEqual({ removed: [] });
  });

  it('an op that ended names nothing: its target and its staging folder go; pending is kept', async () => {
    const ended = updateOp({ opId: op1, target: V(4), state: 'aborted' });
    await updateCurrentState(dataDir, (s) => ({ ...s, pending: { version: V(3), source: 'data' }, pendingSince: Date.now(), pinned: null }));
    expect(await releaseRetention({ dataDir, state: await state(), activeOp: ended })).toEqual({ removed: [V(4)] });
    expect((await sweepReleaseStaging(dataDir, ended)).sort()).toEqual([`.tmp-${V(5)}-${op1}`, `.tmp-${V(6)}-${op2}`].sort());
    expect(await names()).toEqual(expect.arrayContaining([V(1), V(2), V(3)]));
  });

  it('the job reads op.json and current.json itself (an op in staged targeting 0.4 keeps it), under ops/step.lock', async () => {
    await writeOpFile(dataDir, updateOp({ opId: op2, target: V(4), state: 'staged' }));
    const job = releaseRetentionJob(() => ({ dataDir }));
    expect(job).toMatchObject({ type: 'release.retention', permission: 'system.update.run', retryable: 'origin-only' });
    const jobCtx = { jobId: 'job', log: silent, now: () => Date.now(), budgetLeftMs: () => 20_000 } as unknown as JobContext;
    expect(await job.run(jobCtx, job.payload.parse({}))).toEqual({ done: true, message: 'removed 0' });
    expect(await names()).toContain(V(4));

    // While another process steps an op (ops/step.lock held), the job waits for a later slice and removes nothing.
    await writeOpFile(dataDir, updateOp({ opId: op2, target: V(6), state: 'aborted' }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = withFileLock(stepLockPath(dataDir), async () => {
      locked();
      await held;
    });
    await isLocked;
    const waited = await runReleaseRetention(dataDir, { log: silent, waitMs: 100 });
    expect(waited).toEqual({ busy: true, removed: [] });
    expect(await names()).toContain(V(4));
    release();
    await holder;
    expect(await job.run(jobCtx, {})).toEqual({ done: true, message: 'removed 1' });
    expect(await names()).not.toContain(V(4));
  });

  it('an op.json that cannot be read removes nothing (fails closed)', async () => {
    await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
    await fsp.writeFile(dataPath(dataDir, 'ops', 'op.json'), '{not json');
    expect(await runReleaseRetention(dataDir, { log: silent })).toEqual({ busy: false, removed: [], unreadable: true });
    expect(await names()).toContain(V(4));
  });
});
