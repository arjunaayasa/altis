import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeBase64Url } from '@altis/crypto';
import type { DbHandle } from '@altis/db';
import { withFileLock } from '@altis/platform';
import { DomainError, NEEDS_ATTENTION, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreLogger } from '../src/context.js';
import { sha256hex } from '../src/crypto/tokens.js';
import {
  clearMaintenance,
  readMaintenance,
  readOpFile,
  stepLockPath,
  writeControlRequest,
  writeMaintenance,
  writeOpFile,
  type OpFile,
} from '../src/ops/files.js';
import {
  OPS_STALL_MS,
  createOpsMachine,
  type OpKindHandler,
  type OpStatus,
  type OpStepContext,
  type OpsMachine,
  type OpsMachineOptions,
} from '../src/ops/machine.js';

// The OpsMachine (spec §9.4, decisions C8/C9, preflight S1/M21): one op at a time through an O_EXCL `ops/op.json`,
// one stepper at a time through `ops/step.lock`, the maintenance flag kept with the op, `needs_attention` after 15
// minutes without movement, `altis_ops` tokens valid until an hour after the end, cancel only before the point of no
// return, and no op.json write once the step lock was lost (L11). Fake kinds registered under `migrate` and
// `restore`; a fake clock.

const ROOT = path.resolve(import.meta.dirname, '../../..');
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const KEYRING = [{ kid: 'k1', key: encodeBase64Url(randomBytes(32)), active: true }];
const CLI = { type: 'cli', id: null } as const;
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

let dataDir: string;
let now: number;
let machines: OpsMachine[];

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-ops-machine-'));
  now = T0;
  machines = [];
});

afterEach(async () => {
  for (const m of machines) await m.close();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

function machine(kinds: OpKindHandler[], over: Partial<OpsMachineOptions> = {}): OpsMachine {
  const m = createOpsMachine({
    dataDir,
    kinds,
    db: () => undefined,
    connect: () => Promise.reject(new Error('no database in unit tests')),
    keyring: () => KEYRING,
    clock: () => now,
    log: silent,
    snapshotBackupRunning: async () => false,
    appVersion: '0.1.0',
    ...over,
  });
  machines.push(m);
  return m;
}

/** `running → done` in one step, under `migrate`. */
function oneStep(over: Partial<OpKindHandler> = {}): OpKindHandler & { calls: number } {
  const kind = {
    calls: 0,
    kind: 'migrate' as const,
    initialState: 'running',
    maintenance: 'migrate' as const,
    freeze: false,
    async step(_ctx: unknown, op: OpFile): Promise<OpFile> {
      kind.calls += 1;
      return { ...op, state: 'done', progress: 100 };
    },
    ...over,
  };
  return kind;
}

/**
 * Three steps under `migrate`: each raises `params.n` and takes 5 ms of the fake clock; `done` at 3. With `ponrAt`,
 * the step that reaches it also sets the point of no return.
 */
function threeSteps(o: { ponrAt?: number; cancel?: OpKindHandler['cancel'] } = {}): OpKindHandler & { calls: number } {
  const kind = {
    calls: 0,
    kind: 'migrate' as const,
    initialState: 'running',
    maintenance: 'migrate' as const,
    freeze: false,
    async step(_ctx: unknown, op: OpFile): Promise<OpFile> {
      kind.calls += 1;
      now += 5;
      const n = Number(op.params['n'] ?? 0) + 1;
      return {
        ...op,
        params: { ...op.params, n },
        progress: Math.round((n / 3) * 100),
        state: n >= 3 ? 'done' : 'running',
        pointOfNoReturn: op.pointOfNoReturn || (o.ponrAt !== undefined && n >= o.ponrAt),
      };
    },
    ...(o.cancel === undefined ? {} : { cancel: o.cancel }),
  };
  return kind;
}

const opJson = (): string => path.join(dataDir, 'ops', 'op.json');

async function readOp(): Promise<OpFile> {
  const op = await readOpFile(dataDir);
  if (op === null || op === 'corrupt') throw new Error(`no readable op.json: ${String(op)}`);
  return op;
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await p;
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error('expected a DomainError');
}

interface ChildReport {
  ok: boolean;
  opId?: string | null;
  state?: string | null;
  code?: string;
  handlerCalls: number;
}

/** Starts one ops-child.mjs per entry, sends 'go' to all once every one is ready, and returns their reports. */
async function runChildren(options: object[]): Promise<ChildReport[]> {
  const children: ChildProcess[] = [];
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 25_000);
  try {
    const runs = options.map((o) => {
      const child = fork(path.join(import.meta.dirname, 'fixtures/ops-child.mjs'), [JSON.stringify({ dataDir, ...o })], {
        cwd: ROOT,
        env: process.env,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let report: ChildReport | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else report = message as ChildReport;
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited with ${String(code)} before it was ready`)));
      });
      const exited = new Promise<{ code: number | null; report: ChildReport | undefined }>((resolve) =>
        child.once('close', (code) => resolve({ code, report })),
      );
      return { child, ready, exited };
    });
    await Promise.all(runs.map((r) => r.ready));
    for (const r of runs) r.child.send('go');
    const done = await Promise.all(runs.map((r) => r.exited));
    for (const d of done) expect(d.code).toBe(0);
    return done.map((d) => d.report!);
  } finally {
    clearTimeout(timer);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

describe('begin', () => {
  it('creates op.json (opSchema 1, the token hash) and the maintenance flag; a second begin is 409 OPS_IN_PROGRESS', async () => {
    const m = machine([oneStep()]);
    const handle = await m.begin('migrate', CLI, { reason: 'test' });
    const op = await readOp();
    expect(op).toMatchObject({
      opSchema: 1,
      opId: handle.opId,
      kind: 'migrate',
      actor: CLI,
      state: 'running',
      version: '0.1.0',
      heartbeatAt: T0,
      startedAt: T0,
      finishedAt: null,
      pointOfNoReturn: false,
      params: { reason: 'test' },
    });
    expect(op.opsTokenHash).toBe(sha256hex(handle.opsToken));
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'migrate', since: T0, opId: handle.opId, exemptJobIds: [] });

    expect(await codeOf(m.begin('migrate', CLI, {}))).toEqual({ code: 'OPS_IN_PROGRESS', status: 409 });
    expect((await readOp()).opId).toBe(handle.opId);
  });

  it('refuses an op of a freezing kind while a snapshot backup runs, before writing anything', async () => {
    const restore = { ...oneStep(), kind: 'restore' as const, initialState: 'verifying', maintenance: 'restore' as const, freeze: true };
    const m = machine([restore], { snapshotBackupRunning: async () => true });
    expect(await codeOf(m.begin('restore', CLI, {}))).toEqual({ code: 'OPS_BLOCKED_BY_BACKUP', status: 409 });
    expect(await readOpFile(dataDir)).toBeNull();
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('moves a finished op to ops/<opId>/op.json and leaves no .bak of it behind (S1)', async () => {
    const m = machine([threeSteps()]);
    const first = await m.begin('migrate', CLI, {});
    expect((await m.step(20_000))?.state).toBe('done');
    const second = await m.begin('migrate', CLI, {});
    expect((await readOp()).opId).toBe(second.opId);
    const archived = JSON.parse(await fsp.readFile(path.join(dataDir, 'ops', first.opId, 'op.json'), 'utf8')) as OpFile;
    expect(archived).toMatchObject({ opId: first.opId, state: 'done' });
    // The .bak of the new op.json, if any, is not the old op (its unfinished version would come back from it).
    const bak = await fsp.readFile(`${opJson()}.bak`, 'utf8').catch(() => null);
    if (bak !== null) expect((JSON.parse(bak) as OpFile).opId).toBe(second.opId);
  });

  it('two processes beginning at once: exactly one succeeds', { timeout: 30_000 }, async () => {
    const reports = await runChildren([
      { action: 'begin', delayMs: 0 },
      { action: 'begin', delayMs: 0 },
    ]);
    const won = reports.filter((r) => r.ok);
    expect(won).toHaveLength(1);
    expect(reports.filter((r) => !r.ok).map((r) => r.code)).toEqual(['OPS_IN_PROGRESS']);
    expect((await readOp()).opId).toBe(won[0]!.opId);
  });

  it('S1: after a finished op, two processes beginning at once: one wins, op.json names it, the old op is archived', { timeout: 30_000 }, async () => {
    const m = machine([oneStep()]);
    now = Date.now();
    const old = await m.begin('migrate', CLI, {});
    expect((await m.step(20_000))?.state).toBe('done');

    const reports = await runChildren([
      { action: 'begin', delayMs: 0 },
      { action: 'begin', delayMs: 0 },
    ]);
    const won = reports.filter((r) => r.ok);
    expect(won).toHaveLength(1);
    expect(reports.filter((r) => !r.ok).map((r) => r.code)).toEqual(['OPS_IN_PROGRESS']);
    expect((await readOp()).opId).toBe(won[0]!.opId);
    const archived = JSON.parse(await fsp.readFile(path.join(dataDir, 'ops', old.opId, 'op.json'), 'utf8')) as OpFile;
    expect(archived).toMatchObject({ opId: old.opId, state: 'done' });
  });

  it('seals a secret into op.json, hands it to the steps and removes it when the op ends', async () => {
    const secret = randomBytes(32);
    let seen: Uint8Array | null = null;
    const kind = oneStep({
      async step(ctx, op) {
        seen = ctx.secret();
        return { ...op, state: 'done' };
      },
    });
    const m = machine([kind]);
    await m.begin('migrate', CLI, {}, { secret });
    const op = await readOp();
    expect(op.secretParam).toMatch(/^v1:k1:/);
    expect(await fsp.readFile(opJson(), 'utf8')).not.toContain(secret.toString('base64url'));
    await m.step(20_000);
    expect(Buffer.from(seen!)).toEqual(secret);
    expect((await readOp()).secretParam).toBeUndefined();
    // No copy of the sealed secret stays behind either: the .bak holds the ended op too.
    expect(await fsp.readFile(`${opJson()}.bak`, 'utf8')).not.toContain('secretParam');
    expect(await fsp.readFile(opJson(), 'utf8')).not.toContain('secretParam');
  });

  it('a cancelled op or one that failed leaves no copy of its sealed secret in op.json.bak', async () => {
    const m = machine([threeSteps()]);
    await m.begin('migrate', CLI, {}, { secret: randomBytes(32) });
    await m.step(1);
    expect(await fsp.readFile(`${opJson()}.bak`, 'utf8')).toContain('secretParam');
    await m.cancel(CLI);
    expect(await fsp.readFile(`${opJson()}.bak`, 'utf8')).not.toContain('secretParam');

    const boom = oneStep({
      async step(_ctx, op) {
        if (op.params['n'] === undefined) return { ...op, params: { n: 1 } };
        throw new DomainError('BACKUP_INVALID', { detail: 'bad part' });
      },
    });
    const m2 = machine([boom]);
    await m2.begin('migrate', CLI, {}, { secret: randomBytes(32) });
    expect(await m2.step(1)).toMatchObject({ state: 'running' });
    expect(await m2.step(20_000)).toMatchObject({ state: 'failed' });
    expect(await fsp.readFile(`${opJson()}.bak`, 'utf8')).not.toContain('secretParam');
  });
});

describe('step', () => {
  it('two processes stepping at once: one runs the handler, the other returns the status', { timeout: 30_000 }, async () => {
    const m = machine([oneStep()]);
    now = Date.now();
    const handle = await m.begin('migrate', CLI, {});
    const reports = await runChildren([
      { action: 'step', delayMs: 1500 },
      { action: 'step', delayMs: 1500 },
    ]);
    expect(reports.reduce((sum, r) => sum + r.handlerCalls, 0)).toBe(1);
    expect(reports.map((r) => r.state).sort()).toEqual(['done', 'running']);
    expect(reports.every((r) => r.opId === handle.opId)).toBe(true);
    expect((await readOp()).state).toBe('done');
  });

  it('step(1) runs exactly one handler step; a larger budget runs on to the end and clears maintenance', async () => {
    const kind = threeSteps();
    const m = machine([kind]);
    const handle = await m.begin('migrate', CLI, {});
    const status = await m.step(1);
    expect(kind.calls).toBe(1);
    expect(status).toMatchObject({ opId: handle.opId, state: 'running', terminal: false, progress: 33 });
    expect((await readOp()).heartbeatAt).toBe(T0 + 5);

    const end = await m.step(20_000);
    expect(kind.calls).toBe(3);
    expect(end).toMatchObject({ state: 'done', terminal: true, finishedAt: T0 + 15, progress: 100 });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await m.step(20_000)).toMatchObject({ state: 'done' });
    expect(kind.calls).toBe(3);
  });

  it('returns null without an op, and stops at a handler step that changed nothing', async () => {
    let calls = 0;
    const kind = oneStep({
      async step(_ctx, op) {
        calls += 1;
        return op; // nothing to do yet (an owner that has not released its file, ...)
      },
    });
    const m = machine([kind]);
    expect(await m.step(20_000)).toBeNull();
    await m.begin('migrate', CLI, {});
    expect(await m.step(20_000)).toMatchObject({ state: 'running' });
    expect(calls).toBe(1);
  });

  it('M21: an op.json whose maintenance flag is gone gets it back at the next step', async () => {
    const m = machine([threeSteps()]);
    const handle = await m.begin('migrate', CLI, {});
    await fsp.rm(path.join(dataDir, 'ops', 'maintenance.json'));
    expect(await readMaintenance(dataDir)).toBeNull();
    now = T0 + 1000;
    await m.step(1);
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'migrate', since: T0 + 1000, opId: handle.opId, exemptJobIds: [] });
  });

  it('M21 spares an op in needs_attention: a flag forced off stays off; resume() raises it again (OPS-ATTN-EXIT)', async () => {
    const m = machine([threeSteps()]);
    const handle = await m.begin('migrate', CLI, {});
    now = T0 + OPS_STALL_MS + 1;
    expect(await m.step(20_000)).toMatchObject({ state: 'needs_attention' });
    await fsp.rm(path.join(dataDir, 'ops', 'maintenance.json')); // maintenance:off --force
    now += 60_000;
    expect(await m.step(20_000)).toMatchObject({ state: 'needs_attention' });
    expect(await readMaintenance(dataDir)).toBeNull();

    expect(await m.resume()).toMatchObject({ state: 'running' });
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'migrate', since: now, opId: handle.opId, exemptJobIds: [] });
  });

  it('no movement for 15 minutes → needs_attention with stateBefore and one onAttention; resume() returns to it', async () => {
    const kind = threeSteps();
    const attention: OpStatus[] = [];
    const m = machine([kind], {
      onAttention: async (s) => {
        attention.push(s);
      },
    });
    const handle = await m.begin('migrate', CLI, {});
    now = T0 + OPS_STALL_MS;
    await m.step(1); // exactly 15 minutes: still moving
    expect(kind.calls).toBe(1);

    now = (await readOp()).heartbeatAt + OPS_STALL_MS + 1;
    const status = await m.step(20_000);
    expect(status).toMatchObject({ opId: handle.opId, state: 'needs_attention', needsAttention: true, terminal: false });
    expect(await readOp()).toMatchObject({ state: 'needs_attention', stateBefore: 'running' });
    expect(kind.calls).toBe(1);
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ opId: handle.opId, state: 'needs_attention' });

    now += 60_000;
    expect(await m.step(20_000)).toMatchObject({ state: 'needs_attention' });
    expect(kind.calls).toBe(1);
    expect(attention).toHaveLength(1);
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);

    expect(await m.resume()).toMatchObject({ state: 'running', needsAttention: false, heartbeatAt: now });
    expect((await readOp()).stateBefore).toBeUndefined();
    expect(await m.step(20_000)).toMatchObject({ state: 'done' });
    expect(kind.calls).toBe(3);
  });

  it('Review C08: a kind whose stalls(op) is false for the op is stepped on after 15 minutes without movement', async () => {
    const kind = Object.assign(threeSteps(), { stalls: vi.fn((op: OpFile) => Number(op.params['n'] ?? 0) !== 1) });
    const m = machine([kind]);
    const handle = await m.begin('migrate', CLI, {});
    await m.step(1); // n = 1: the kind says it does not stall there
    now = (await readOp()).heartbeatAt + OPS_STALL_MS + 1;
    expect(await m.step(1)).toMatchObject({ opId: handle.opId, state: 'running', needsAttention: false });
    expect(kind.stalls).toHaveBeenCalledWith(expect.objectContaining({ opId: handle.opId, params: { n: 1 } }));
    expect(kind.calls).toBe(2);
    // n = 2: the rule applies again.
    now = (await readOp()).heartbeatAt + OPS_STALL_MS + 1;
    expect(await m.step(1)).toMatchObject({ state: 'needs_attention' });
    expect(await readOp()).toMatchObject({ stateBefore: 'running' });
    expect(kind.calls).toBe(2);
  });

  it('a handler error before the point of no return fails the op; after it, the op needs attention and maintenance stays', async () => {
    const boom = oneStep({
      async step() {
        throw new DomainError('BACKUP_INVALID', { detail: 'bad part', meta: { reason: 'checksum' } });
      },
    });
    const m = machine([boom]);
    await m.begin('migrate', CLI, {});
    expect(await m.step(20_000)).toMatchObject({ state: 'failed', terminal: true, error: { code: 'BACKUP_INVALID', detail: 'bad part' } });
    expect(await readMaintenance(dataDir)).toBeNull();

    let n = 0;
    const late = oneStep({
      async step(_ctx, op) {
        n += 1;
        if (n === 1) return { ...op, pointOfNoReturn: true, progress: 50 };
        throw new Error('driver said something with values in it');
      },
    });
    const attention: OpStatus[] = [];
    const m2 = machine([late], { onAttention: async (s) => void attention.push(s) });
    const handle = await m2.begin('migrate', CLI, {});
    const status = await m2.step(20_000);
    expect(status).toMatchObject({ state: 'needs_attention', pointOfNoReturn: true, error: { code: 'INTERNAL' } });
    expect(status?.error).not.toHaveProperty('detail');
    expect(await readOp()).toMatchObject({ stateBefore: 'running' });
    expect(attention).toHaveLength(1);
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);
  });

  it('a message and an error detail longer than op.json allows are cut to 2000 characters, never mid-pair', async () => {
    const kind = oneStep({
      async step(_ctx, op) {
        return {
          ...op,
          state: 'failed',
          message: `${'m'.repeat(1999)}\u{1F4DA}${'m'.repeat(3000)}`,
          error: { code: 'BACKUP_INVALID', detail: 'd'.repeat(5000) },
        };
      },
    });
    const m = machine([kind]);
    await m.begin('migrate', CLI, {});
    expect(await m.step(20_000)).toMatchObject({ state: 'failed', terminal: true, error: { code: 'BACKUP_INVALID' } });
    const op = await readOp();
    expect(op.message).toBe('m'.repeat(1999)); // the cut would have split the emoji's surrogate pair
    expect(op.error?.detail).toBe('d'.repeat(2000));
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it.each([
    ['a progress above 100', (op: OpFile): OpFile => ({ ...op, progress: 150 })],
    ['a state the kind does not have', (op: OpFile): OpFile => ({ ...op, state: 'exporting' })],
    ['another op', (op: OpFile): OpFile => ({ ...op, opId: newId() })],
    ['nothing', (): OpFile => undefined as unknown as OpFile],
  ])('a handler that returns %s fails the op like a thrown error (needs attention past the point of no return)', async (_name, bad) => {
    let n = 0;
    const kind = oneStep({
      async step(_ctx, op) {
        n += 1;
        return n === 2 ? bad(op) : { ...op, params: { n } };
      },
    });
    const m = machine([kind]);
    const handle = await m.begin('migrate', CLI, {});
    expect(await m.step(1)).toMatchObject({ state: 'running' });
    expect(await m.step(20_000)).toMatchObject({ opId: handle.opId, state: 'failed', terminal: true, error: { code: 'INTERNAL' } });
    expect(await readOp()).toMatchObject({ opId: handle.opId, state: 'failed', params: { n: 1 } });
    expect(await readMaintenance(dataDir)).toBeNull();

    n = 0;
    const late = oneStep({
      async step(_ctx, op) {
        n += 1;
        return n === 2 ? bad(op) : { ...op, pointOfNoReturn: true };
      },
    });
    const attention: OpStatus[] = [];
    const m2 = machine([late], { onAttention: async (s) => void attention.push(s) });
    const second = await m2.begin('migrate', CLI, {});
    await m2.step(1);
    expect(await m2.step(20_000)).toMatchObject({ opId: second.opId, state: 'needs_attention', error: { code: 'INTERNAL' } });
    expect(attention).toHaveLength(1);
    expect((await readMaintenance(dataDir))?.opId).toBe(second.opId);
  });

  it('a lock lost mid-step: no op.json write after it', async () => {
    const kind = oneStep({
      async step(_ctx, op) {
        // Another process judged the lock stale and took it over while this step ran.
        await fsp.writeFile(path.join(dataDir, 'ops', 'step.lock'), JSON.stringify({ pid: 1, startMs: 0, token: 'other', host: 'elsewhere' }));
        return { ...op, state: 'done' };
      },
    });
    const m = machine([kind]);
    await m.begin('migrate', CLI, {});
    const before = await fsp.readFile(opJson(), 'utf8');
    await expect(m.step(20_000)).rejects.toMatchObject({ code: 'STATE_CORRUPT', meta: { reason: 'lock_lost' } });
    expect(await fsp.readFile(opJson(), 'utf8')).toBe(before);
    expect((await readOp()).state).toBe('running');
    await fsp.rm(path.join(dataDir, 'ops', 'step.lock'));
  });

  it('the flag of an op that ended without lowering it (a crash after the terminal write) is lowered by the next step', async () => {
    const m = machine([threeSteps()]);
    const handle = await m.begin('migrate', CLI, {});
    // The process wrote the end of the op and died before it lowered the flag.
    await writeOpFile(dataDir, { ...(await readOp()), state: 'done', progress: 100, finishedAt: T0 });
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);

    now = T0 + 1000;
    expect(await m.step(20_000)).toMatchObject({ opId: handle.opId, state: 'done', terminal: true });
    expect(await readMaintenance(dataDir)).toBeNull();

    // A flag the op did not raise (a manual one) is not touched.
    await writeMaintenance(dataDir, { reason: 'manual', since: now, opId: null, exemptJobIds: [] });
    await m.step(20_000);
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'manual', opId: null });
  });

  it('an update that ended in restore_failed keeps its flag through later steps', async () => {
    const update = { ...oneStep(), kind: 'update' as const, initialState: 'checking', maintenance: 'update' as const };
    const m = machine([update]);
    const handle = await m.begin('update', CLI, {});
    await writeOpFile(dataDir, { ...(await readOp()), state: 'restore_failed', finishedAt: T0 });
    now = T0 + 1000;
    expect(await m.step(20_000)).toMatchObject({ state: 'restore_failed', terminal: true });
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);
  });

  it('begin lowers the flag an ended op left behind, even for a kind without maintenance', async () => {
    const reset = { ...oneStep(), kind: 'reset' as const, maintenance: null };
    const m = machine([threeSteps(), reset]);
    const old = await m.begin('migrate', CLI, {});
    await writeOpFile(dataDir, { ...(await readOp()), state: 'failed', finishedAt: T0 });
    expect((await readMaintenance(dataDir))?.opId).toBe(old.opId);
    await m.begin('reset', CLI, {});
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('an op that ends lowers its flag before it closes its connections and publishes its progress hint', async () => {
    const flagFile = path.join(dataDir, 'ops', 'maintenance.json');
    const seen: string[] = [];
    const conn = {
      close: async () => {
        seen.push(`close: flag ${existsSync(flagFile) ? 'up' : 'down'}`);
      },
    } as unknown as DbHandle;
    const backup = {
      ...oneStep(),
      kind: 'backup' as const,
      initialState: 'frozen',
      maintenance: 'backup' as const,
      async step(ctx: OpStepContext, op: OpFile): Promise<OpFile> {
        await ctx.connectDedicated();
        ctx.publish({ progress: 100 });
        return { ...op, state: 'done', progress: 100 };
      },
    };
    const m = machine([backup], {
      connect: async () => conn,
      // Only the progress hint asks for the live handle in this test.
      db: () => {
        seen.push(`hint: flag ${existsSync(flagFile) ? 'up' : 'down'}`);
        return undefined;
      },
    });
    await m.begin('backup', CLI, {});
    expect(await m.step(20_000)).toMatchObject({ state: 'done' });
    expect(seen.sort()).toEqual(['close: flag down', 'hint: flag down']);
  });

  it("a corrupt op.json and .bak: needs attention, maintenance stays, no new op", async () => {
    const m = machine([threeSteps()]);
    const handle = await m.begin('migrate', CLI, {});
    await fsp.writeFile(opJson(), '{"opSchema"');
    await fsp.writeFile(`${opJson()}.bak`, '');
    const status = await m.step(20_000);
    expect(status).toMatchObject({
      opId: handle.opId,
      kind: 'migrate',
      state: 'needs_attention',
      needsAttention: true,
      terminal: false,
      error: { code: 'STATE_CORRUPT' },
      backupId: null,
    });
    expect(await m.current()).toMatchObject({ state: 'needs_attention' });
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);
    expect(await codeOf(m.begin('migrate', CLI, {}))).toMatchObject({ code: 'OPS_IN_PROGRESS' });
    expect(await m.tokenMatches(handle.opsToken)).toBe(false);
  });

  it('a corrupt op.json and .bak: onAttention once, whichever process steps it, and again for a later op', async () => {
    const attention: OpStatus[] = [];
    const onAttention = async (s: OpStatus): Promise<void> => void attention.push(s);
    const reset = { ...threeSteps(), kind: 'reset' as const, maintenance: null };
    const m = machine([threeSteps(), reset], { onAttention });
    const handle = await m.begin('migrate', CLI, {});
    await fsp.writeFile(opJson(), '{"opSchema"');
    await fsp.writeFile(`${opJson()}.bak`, '');

    const status = await m.step(20_000);
    expect(attention).toEqual([status]);
    expect(attention[0]).toMatchObject({ opId: handle.opId, state: 'needs_attention', error: { code: 'STATE_CORRUPT' } });
    now += 60_000;
    await m.step(20_000);
    await machine([threeSteps()], { onAttention }).step(20_000); // another process
    expect(attention).toHaveLength(1);

    // Repaired by hand and ended; a later op without a maintenance flag (nothing names it) breaks the same way.
    await fsp.rm(`${opJson()}.bak`);
    await fsp.rm(opJson());
    await fsp.rm(path.join(dataDir, 'ops', 'maintenance.json'));
    await m.begin('reset', CLI, {});
    await fsp.writeFile(opJson(), 'garbage');
    await fsp.writeFile(`${opJson()}.bak`, 'garbage');
    expect(await m.step(20_000)).toMatchObject({ opId: null, state: 'needs_attention' });
    await m.step(20_000);
    expect(attention).toHaveLength(2);
    expect(attention[1]).toMatchObject({ opId: null, kind: null, error: { code: 'STATE_CORRUPT' } });
  });

  it('setAsideUnreadable moves an unreadable op.json and .bak aside, keeps maintenance as manual, and an op can begin (OPS-ATTN-EXIT)', async () => {
    const m = machine([threeSteps()]);
    expect(await m.setAsideUnreadable(CLI)).toBeNull(); // no op.json
    const handle = await m.begin('migrate', CLI, {});
    expect(await m.setAsideUnreadable(CLI)).toBeNull(); // readable: left alone
    expect((await readOp()).opId).toBe(handle.opId);

    await fsp.writeFile(opJson(), '{"opSchema"');
    await fsp.writeFile(`${opJson()}.bak`, 'garbage');
    now += 1000;
    const aside = await m.setAsideUnreadable(CLI);
    expect(aside).toEqual({ opId: handle.opId, kind: 'migrate', folder: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) });
    const folder = path.join(dataDir, 'ops', aside!.folder);
    expect(await fsp.readFile(path.join(folder, 'op.json'), 'utf8')).toBe('{"opSchema"');
    expect(await fsp.readFile(path.join(folder, 'op.json.bak'), 'utf8')).toBe('garbage');
    expect(existsSync(opJson()) || existsSync(`${opJson()}.bak`)).toBe(false);
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'manual', since: now, opId: null, exemptJobIds: [] });
    expect(await m.current()).toBeNull();

    const next = await m.begin('migrate', CLI, {});
    expect((await readOp()).opId).toBe(next.opId);
  });

  it('a corrupt op.json whose once-marker cannot be written still reports and returns its status (T6)', async () => {
    const attention: OpStatus[] = [];
    const warnings: string[] = [];
    const log: CoreLogger = { info() {}, warn: (msg) => void warnings.push(msg), error() {} };
    const m = machine([threeSteps()], { onAttention: async (s) => void attention.push(s), log });
    const handle = await m.begin('migrate', CLI, {});
    await fsp.writeFile(opJson(), '{"opSchema"');
    await fsp.writeFile(`${opJson()}.bak`, '');
    // ops/corrupt-reported is a folder that holds a file: neither read nor replaced (as on a full or read-only disk).
    await fsp.mkdir(path.join(dataDir, 'ops', 'corrupt-reported', 'x'), { recursive: true });
    const status = await m.step(20_000);
    expect(status).toMatchObject({ opId: handle.opId, state: 'needs_attention', error: { code: 'STATE_CORRUPT' } });
    expect(attention).toHaveLength(1);
    expect(warnings).toContain('ops: the report marker of an unreadable op.json cannot be kept; it may be reported again');
  });

  it('a once-marker that cannot be kept: each process reports the unreadable op.json once, not at every step (final review G2)', async () => {
    const attention: OpStatus[] = [];
    const onAttention = async (s: OpStatus): Promise<void> => void attention.push(s);
    const m = machine([threeSteps()], { onAttention });
    const other = machine([threeSteps()], { onAttention }); // another process: its own memory
    const handle = await m.begin('migrate', CLI, {});
    await fsp.writeFile(opJson(), '{"opSchema"');
    await fsp.writeFile(`${opJson()}.bak`, '');
    await fsp.mkdir(path.join(dataDir, 'ops', 'corrupt-reported', 'x'), { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      expect(await m.step(20_000)).toMatchObject({ opId: handle.opId, state: 'needs_attention', error: { code: 'STATE_CORRUPT' } });
    }
    expect(attention).toHaveLength(1);
    await other.step(20_000);
    await other.step(20_000);
    expect(attention).toHaveLength(2);
  });
});

describe('tokens, current, cancel, takeover', () => {
  it('tokenMatches is true while the op runs and until an hour after it ended; a wrong token never matches', async () => {
    const m = machine([oneStep()]);
    const handle = await m.begin('migrate', CLI, {});
    expect(await m.tokenMatches(handle.opsToken)).toBe(true);
    expect(await m.tokenMatches(`${handle.opsToken}x`)).toBe(false);
    expect(await m.tokenMatches('')).toBe(false);
    now = T0 + 10;
    await m.step(20_000);
    expect((await readOp()).finishedAt).toBe(T0 + 10);
    now = T0 + 10 + HOUR;
    expect(await m.tokenMatches(handle.opsToken)).toBe(true);
    expect(await m.current()).toMatchObject({ opId: handle.opId, state: 'done' });
    now += 1;
    expect(await m.tokenMatches(handle.opsToken)).toBe(false);
    expect(await m.current()).toBeNull();
  });

  it('an update that ended restore_failed stays current while a maintenance flag is up, past the hour; its token does not', async () => {
    // Spec §9.7, §9.8 row 3: it holds its maintenance with instructions until an operator acts (1d review C16).
    const update = { ...oneStep(), kind: 'update' as const, initialState: 'checking', maintenance: 'update' as const };
    const m = machine([update]);
    const handle = await m.begin('update', CLI, {});
    await writeOpFile(dataDir, { ...(await readOp()), state: 'restore_failed', finishedAt: T0, heartbeatAt: T0 });
    now = T0 + HOUR + 1;
    expect(await m.tokenMatches(handle.opsToken)).toBe(false);
    expect(await m.current()).toMatchObject({ opId: handle.opId, state: 'restore_failed', terminal: true });
    expect(await m.step(20_000)).toMatchObject({ opId: handle.opId, state: 'restore_failed' });
    // A restart replaced the op's flag with a manual one (holdMaintenance): still held.
    await writeMaintenance(dataDir, { reason: 'update', since: now, opId: null, exemptJobIds: [] });
    expect(await m.current()).toMatchObject({ opId: handle.opId, state: 'restore_failed' });
    expect(await m.step(20_000)).toMatchObject({ opId: handle.opId, state: 'restore_failed' });
    // Maintenance lowered (`maintenance:off --force`): past its hour like any ended op.
    await clearMaintenance(dataDir, null);
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await m.current()).toBeNull();
    expect(await m.step(20_000)).toBeNull();
    // Any other ended op is gone after its hour whatever flag is up.
    await writeOpFile(dataDir, { ...(await readOp()), state: 'aborted' });
    await writeMaintenance(dataDir, { reason: 'manual', since: now, opId: null, exemptJobIds: [] });
    expect(await m.current()).toBeNull();
  });

  it('cancel before the point of no return runs the kind cancel and ends in its failure state', async () => {
    const cancelled: string[] = [];
    const kind = threeSteps({
      ponrAt: 2,
      async cancel(_ctx, op) {
        cancelled.push(op.opId);
      },
    });
    const m = machine([kind]);
    const handle = await m.begin('migrate', CLI, {});
    await m.step(1);
    const staff = { type: 'staff', id: newId() } as const;
    const status = await m.cancel(staff);
    expect(cancelled).toEqual([handle.opId]);
    expect(status).toMatchObject({ opId: handle.opId, state: 'failed', terminal: true, finishedAt: now });
    expect((await readOp()).params).toMatchObject({ cancelledBy: staff });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await codeOf(m.cancel(staff))).toEqual({ code: 'OPS_NONE', status: 404 });
  });

  it('cancel after the point of no return is 409 OPS_POINT_OF_NO_RETURN', async () => {
    const cancel = vi.fn(async () => undefined);
    const m = machine([threeSteps({ ponrAt: 2, cancel })]);
    await m.begin('migrate', CLI, {});
    await m.step(1);
    await m.step(1);
    expect((await readOp()).pointOfNoReturn).toBe(true);
    expect(await codeOf(m.cancel(CLI))).toEqual({ code: 'OPS_POINT_OF_NO_RETURN', status: 409 });
    expect(cancel).not.toHaveBeenCalled();
    expect((await readOp()).state).toBe('running');
  });

  it('cancel with the op id it expects refuses another op with OPS_NONE and leaves it running (T24)', async () => {
    const m = machine([oneStep(), { ...threeSteps(), kind: 'reset' as const, maintenance: 'reset' as const }]);
    const mine = await m.begin('migrate', CLI, {});
    await m.step(20_000); // ended; someone else begins the next op
    const theirs = await m.begin('reset', CLI, {});
    expect(await codeOf(m.cancel(CLI, { opId: mine.opId }))).toEqual({ code: 'OPS_NONE', status: 404 });
    expect(await readOp()).toMatchObject({ opId: theirs.opId, state: 'running' });
    expect((await readMaintenance(dataDir))?.opId).toBe(theirs.opId);
    expect(await m.cancel(CLI, { opId: theirs.opId })).toMatchObject({ opId: theirs.opId, state: 'failed' });
  });

  it('a backup op is cancelled to aborted', async () => {
    const backup = { ...oneStep(), kind: 'backup' as const, initialState: 'frozen', maintenance: 'backup' as const };
    const m = machine([backup]);
    await m.begin('backup', CLI, {});
    expect(await m.cancel(CLI)).toMatchObject({ state: 'aborted', terminal: true });
  });

  it('takeover re-binds the actor and issues a new token; the old one stops matching', async () => {
    const m = machine([threeSteps()]);
    const first = await m.begin('migrate', CLI, {});
    const staff = { type: 'staff', id: newId() } as const;
    const second = await m.takeover(staff);
    expect(second.opId).toBe(first.opId);
    expect(second.opsToken).not.toBe(first.opsToken);
    expect(await m.tokenMatches(first.opsToken)).toBe(false);
    expect(await m.tokenMatches(second.opsToken)).toBe(true);
    expect((await readOp()).actor).toEqual(staff);
    expect(await m.current()).toMatchObject({ actor: staff });
  });
});

describe('control requests come first (final review: cancel and takeover starved behind drives)', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** A `migrate` kind whose every handler step takes `ms` of real time and moves the op, never to its end. */
  function slowSteps(ms: number): OpKindHandler & { calls: number } {
    const kind = {
      calls: 0,
      kind: 'migrate' as const,
      initialState: 'running',
      maintenance: 'migrate' as const,
      freeze: false,
      async step(_ctx: unknown, op: OpFile): Promise<OpFile> {
        kind.calls += 1;
        await sleep(ms);
        return { ...op, params: { ...op.params, n: Number(op.params['n'] ?? 0) + 1 } };
      },
    };
    return kind;
  }

  it('a cancel lands within one drive budget while another process drives back to back', { timeout: 60_000 }, async () => {
    const realClock = { clock: () => Date.now() };
    const driver = machine([slowSteps(100)], realClock);
    const control = machine([slowSteps(100)], realClock);
    await driver.begin('migrate', CLI, {});
    let driving = true;
    const loop = (async () => {
      while (driving) {
        const status = await driver.step(3000);
        if (status === null || status.terminal) break;
        await sleep(15); // one network round trip between two drives
      }
    })();
    await sleep(400);
    const began = Date.now();
    const cancelled = await control.cancel(CLI).finally(() => {
      driving = false;
    });
    const took = Date.now() - began;
    await loop;
    expect(cancelled).toMatchObject({ state: 'failed', terminal: true });
    expect(took).toBeLessThan(3000);
  });

  it('a fresh control request keeps steps out: step() answers the status at once; one older than 30 s does not', async () => {
    const kind = threeSteps();
    const m = machine([kind]);
    const handle = await m.begin('migrate', CLI, {});
    await writeControlRequest(dataDir, { id: 'someone-else', at: now });
    expect(await m.step(20_000)).toMatchObject({ opId: handle.opId, state: 'running', progress: 0 });
    expect(kind.calls).toBe(0);
    now += 30_001;
    expect(await m.step(1)).toMatchObject({ progress: 33 });
    expect(kind.calls).toBe(1);
  });

  it('a lock held past the control wait: 409 OPS_IN_PROGRESS (not 500), the request stays, and the retry lands', { timeout: 30_000 }, async () => {
    const kind = threeSteps();
    const m = machine([kind], { controlWaitMs: 300 });
    await m.begin('migrate', CLI, {});
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = withFileLock(
      stepLockPath(dataDir),
      async () => {
        locked();
        await held;
      },
      { waitMs: 1000 },
    );
    await holding;
    expect(await codeOf(m.cancel(CLI))).toEqual({ code: 'OPS_IN_PROGRESS', status: 409 });
    release();
    await holder;
    expect(await m.step(20_000)).toMatchObject({ state: 'running' }); // the request still keeps steps out
    expect(kind.calls).toBe(0);
    expect(await m.cancel(CLI)).toMatchObject({ state: 'failed' });
    expect(await m.begin('migrate', CLI, {})).toMatchObject({ opId: expect.any(String) });
    expect(await m.step(1)).toMatchObject({ progress: 33 }); // the request went with the cancel
  });
});

// 1d Task 11 (decision D1d-14, preflight 1D-23): an `update` op holds neither its maintenance flag nor the freeze before
// `maintenanceFrom` (`verified`): download and verification run while the site serves. The machine raises the flag at
// the first step in `verified`, right after the kind's `beforeMaintenance` (which may still refuse the op), then waits
// for the freeze. `begin` may start an op in one of the kind's entry states. The freeze itself (a live lease) is in
// test/db/ops-freeze.test.ts: here `db()` is undefined, so a step must not reach the lease count (no step 3 s after
// the flag rose without `params.frozenAt`).

describe('maintenance from a state, entry states (1d Task 11)', () => {
  const NEXT: Record<string, string> = {
    checking: 'downloading',
    downloading: 'verified',
    verified: 'frozen',
    frozen: 'backed_up',
    backed_up: 'staged',
    staged: 'switched',
    switched: 'booting',
    booting: 'migrating',
    migrating: 'verifying',
    verifying: 'done',
  };
  const flagFile = (): string => path.join(dataDir, 'ops', 'maintenance.json');

  interface FakeUpdate extends OpKindHandler {
    /** The op each handler step was given, and whether the flag file existed then. */
    steps: OpFile[];
    flagAtStep: boolean[];
    /** The op each `beforeMaintenance` was given, and whether the flag file existed then. */
    before: OpFile[];
    flagAtBefore: boolean[];
    cancels: OpFile[];
    flagAtCancel: boolean[];
    refreezes: OpFile[];
  }

  /**
   * A fake `update` kind: `checking → downloading → verified → frozen → … → switched` (the point of no return) `→ … →
   * done`, 5 ms of the fake clock per handler step. Maintenance `update` from `verified`, freeze, entry state `verified`.
   * `throwIn` makes the step in that state throw; `refuse` makes `beforeMaintenance` throw (each call takes the next
   * entry, `null` passes).
   */
  function updateKind(o: { throwIn?: string; refuse?: (Error | null)[]; freeze?: boolean } = {}): FakeUpdate {
    const refusals = [...(o.refuse ?? [])];
    const kind: FakeUpdate = {
      steps: [],
      flagAtStep: [],
      before: [],
      flagAtBefore: [],
      cancels: [],
      flagAtCancel: [],
      refreezes: [],
      kind: 'update',
      initialState: 'checking',
      entryStates: ['verified'],
      maintenance: 'update',
      maintenanceFrom: 'verified',
      freeze: o.freeze ?? true,
      async step(_ctx, op) {
        kind.steps.push(op);
        kind.flagAtStep.push(existsSync(flagFile()));
        now += 5;
        if (op.state === o.throwIn) throw new DomainError('UPDATE_DOWNLOAD_FAILED', { meta: { reason: 'network' } });
        const state = NEXT[op.state]!;
        return { ...op, state, pointOfNoReturn: op.pointOfNoReturn || state === 'switched' };
      },
      async beforeMaintenance(_ctx, op) {
        kind.before.push(op);
        kind.flagAtBefore.push(existsSync(flagFile()));
        const refusal = refusals.shift() ?? null;
        if (refusal !== null) throw refusal;
      },
      async cancel(_ctx, op) {
        kind.cancels.push(op);
        kind.flagAtCancel.push(existsSync(flagFile()));
      },
      refreeze(op) {
        kind.refreezes.push(op);
        return { ...op, state: 'verified' };
      },
    };
    return kind;
  }

  const blocked = (): DomainError =>
    new DomainError('OPS_BLOCKED_BY_BACKUP', { detail: 'Backup snapshot sedang berjalan / A snapshot backup is running' });

  it('begin: op.json in checking, no maintenance.json; steps in checking and downloading call the handler and write no flag', async () => {
    const kind = updateKind();
    const m = machine([kind]);
    const handle = await m.begin('update', CLI, { target: '0.2.0-test' });
    expect(await readOp()).toMatchObject({ opId: handle.opId, kind: 'update', state: 'checking' });
    expect(existsSync(flagFile())).toBe(false);

    expect(await m.step(1)).toMatchObject({ state: 'downloading' });
    expect(existsSync(flagFile())).toBe(false);
    // A larger budget runs on to verified and stops there: the handler is not called in verified by that step.
    expect(await m.step(20_000)).toMatchObject({ state: 'verified', needsAttention: false });
    expect(kind.steps.map((s) => s.state)).toEqual(['checking', 'downloading']);
    expect(kind.flagAtStep).toEqual([false, false]);
    expect(existsSync(flagFile())).toBe(false);
    expect(kind.before).toHaveLength(0);
    expect((await readOp()).params).not.toHaveProperty('frozenAt');

    // The next step: beforeMaintenance, then the flag; the freeze has not settled yet, so no handler step.
    const raisedAt = now;
    expect(await m.step(20_000)).toMatchObject({ state: 'verified' });
    expect(kind.before.map((s) => s.state)).toEqual(['verified']);
    expect(kind.flagAtBefore).toEqual([false]);
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'update', since: raisedAt, opId: handle.opId, exemptJobIds: [] });
    expect(kind.steps).toHaveLength(2);
    now += 1000;
    expect(await m.step(20_000)).toMatchObject({ state: 'verified' });
    expect(kind.before).toHaveLength(1); // once: the flag is up
    expect(kind.steps).toHaveLength(2);
  });

  it('beforeMaintenance throwing at verified: the op ends aborted through the kind cleanup, no flag ever written, called once', async () => {
    const kind = updateKind({ refuse: [blocked()] });
    const attention: OpStatus[] = [];
    const m = machine([kind], { onAttention: async (s) => void attention.push(s) });
    const handle = await m.begin('update', CLI, {});
    expect(await m.step(20_000)).toMatchObject({ state: 'verified' });
    const status = await m.step(20_000);
    expect(status).toMatchObject({
      opId: handle.opId,
      state: 'aborted',
      terminal: true,
      pointOfNoReturn: false,
      error: { code: 'OPS_BLOCKED_BY_BACKUP', detail: 'Backup snapshot sedang berjalan / A snapshot backup is running' },
      finishedAt: now,
    });
    expect(kind.before).toHaveLength(1);
    expect(kind.flagAtBefore).toEqual([false]);
    // The kind's cleanup ran, given the op with the error it ends with, the flag never up.
    expect(kind.cancels).toHaveLength(1);
    expect(kind.cancels[0]).toMatchObject({ state: 'verified', error: { code: 'OPS_BLOCKED_BY_BACKUP' } });
    expect(kind.flagAtCancel).toEqual([false]);
    expect(existsSync(flagFile())).toBe(false);
    expect(await readOp()).toMatchObject({ state: 'aborted', error: { code: 'OPS_BLOCKED_BY_BACKUP' } });
    expect(attention).toHaveLength(0);

    now += 60_000;
    expect(await m.step(20_000)).toMatchObject({ state: 'aborted' });
    expect(kind.before).toHaveLength(1);
    expect(kind.cancels).toHaveLength(1);
    expect(kind.steps.map((s) => s.state)).toEqual(['checking', 'downloading']);
    expect(existsSync(flagFile())).toBe(false);
  });

  it('beforeMaintenance failing for a while (DB_UNAVAILABLE) leaves the op as it was, unflagged; the next step asks again', async () => {
    const kind = updateKind({ refuse: [new DomainError('DB_UNAVAILABLE')] });
    const m = machine([kind]);
    const handle = await m.begin('update', CLI, {});
    await m.step(20_000);
    const before = await fsp.readFile(opJson(), 'utf8');
    await expect(m.step(20_000)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(await fsp.readFile(opJson(), 'utf8')).toBe(before);
    expect(existsSync(flagFile())).toBe(false);
    expect(kind.cancels).toHaveLength(0);

    now += 1000;
    expect(await m.step(20_000)).toMatchObject({ state: 'verified' });
    expect(kind.before).toHaveLength(2);
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'update', since: now, opId: handle.opId, exemptJobIds: [] });
  });

  it('the handler throwing in downloading: the op ends aborted and no flag was ever written', async () => {
    const kind = updateKind({ throwIn: 'downloading' });
    const m = machine([kind]);
    await m.begin('update', CLI, {});
    expect(await m.step(20_000)).toMatchObject({ state: 'aborted', terminal: true, error: { code: 'UPDATE_DOWNLOAD_FAILED' } });
    expect(kind.steps.map((s) => s.state)).toEqual(['checking', 'downloading']);
    expect(kind.flagAtStep).toEqual([false, false]);
    expect(kind.before).toHaveLength(0);
    expect(existsSync(flagFile())).toBe(false);
  });

  it('begin at an entry state: verified raises the flag at begin; a state that is neither the first nor an entry state is a TypeError', async () => {
    const kind = updateKind();
    const m = machine([kind, oneStep()]);
    await expect(m.begin('update', CLI, {}, { state: 'frozen' })).rejects.toThrow(TypeError);
    await expect(m.begin('update', CLI, {}, { state: 'done' })).rejects.toThrow(TypeError);
    await expect(m.begin('update', CLI, {}, { state: NEEDS_ATTENTION })).rejects.toThrow(TypeError);
    await expect(m.begin('migrate', CLI, {}, { state: 'done' })).rejects.toThrow(TypeError);
    expect(await readOpFile(dataDir)).toBeNull();
    expect(existsSync(flagFile())).toBe(false);

    const handle = await m.begin('update', CLI, { source: 'bundled' }, { state: 'verified' });
    expect(await readOp()).toMatchObject({ opId: handle.opId, state: 'verified', params: { source: 'bundled' } });
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'update', since: T0, opId: handle.opId, exemptJobIds: [] });
    expect(await m.step(20_000)).toMatchObject({ state: 'verified' }); // the freeze settles first
    expect(kind.before).toHaveLength(0); // the flag was up already: begin refused a snapshot backup itself
    expect(kind.steps).toHaveLength(0);
  });

  it('begin at the first state named explicitly behaves as without it', async () => {
    const m = machine([updateKind(), oneStep()]);
    const first = await m.begin('migrate', CLI, {}, { state: 'running' });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'migrate', opId: first.opId });
    await m.step(20_000);
    const handle = await m.begin('update', CLI, {}, { state: 'checking' });
    expect(await readOp()).toMatchObject({ opId: handle.opId, state: 'checking' });
    expect(existsSync(flagFile())).toBe(false);
  });

  it('Review Focus 4: an op in frozen with no step for 15 minutes → needs_attention with the flag kept; resume() → back to frozen', async () => {
    const kind = updateKind();
    const attention: OpStatus[] = [];
    const m = machine([kind], { onAttention: async (s) => void attention.push(s) });
    const handle = await m.begin('update', CLI, { target: '0.2.0-test' }, { state: 'verified' });
    // As if it had frozen (3 s after the flag) and stepped verified → frozen; then the admin closed the tab.
    const frozenAt = T0 + 3000;
    await writeOpFile(dataDir, { ...(await readOp()), state: 'frozen', params: { target: '0.2.0-test', frozenAt }, heartbeatAt: frozenAt + 5 });

    now = frozenAt + 5 + OPS_STALL_MS + 1;
    expect(await m.step(20_000)).toMatchObject({ opId: handle.opId, state: 'needs_attention', needsAttention: true, pointOfNoReturn: false });
    expect(await readOp()).toMatchObject({ state: 'needs_attention', stateBefore: 'frozen' });
    expect(attention).toHaveLength(1);
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'update', since: T0, opId: handle.opId, exemptJobIds: [] });
    now += 60_000;
    expect(await m.step(20_000)).toMatchObject({ state: 'needs_attention' });
    expect(await readMaintenance(dataDir)).toMatchObject({ since: T0, opId: handle.opId });
    expect(kind.steps).toHaveLength(0);

    expect(await m.resume()).toMatchObject({ state: 'frozen', needsAttention: false, heartbeatAt: now });
    expect(await readOp()).toMatchObject({ state: 'frozen', params: { frozenAt } });
    expect(kind.refreezes).toHaveLength(0);
    expect(kind.before).toHaveLength(0);
    expect(await readMaintenance(dataDir)).toMatchObject({ since: T0, opId: handle.opId });
    // The next step goes on at once, under the same freeze.
    await m.step(1);
    expect(kind.steps.at(-1)).toMatchObject({ state: 'frozen', params: { frozenAt } });
  });

  it('an op in downloading with no step for 15 minutes → needs_attention without a flag; resume() → downloading, still unflagged', async () => {
    const kind = updateKind();
    const m = machine([kind]);
    await m.begin('update', CLI, {});
    await m.step(1);
    now = (await readOp()).heartbeatAt + OPS_STALL_MS + 1;
    expect(await m.step(20_000)).toMatchObject({ state: 'needs_attention' });
    expect(await readOp()).toMatchObject({ stateBefore: 'downloading' });
    expect(existsSync(flagFile())).toBe(false);
    now += 60_000;
    expect(await m.step(20_000)).toMatchObject({ state: 'needs_attention' });
    expect(existsSync(flagFile())).toBe(false);

    expect(await m.resume()).toMatchObject({ state: 'downloading' });
    expect(existsSync(flagFile())).toBe(false);
    expect(await m.step(1)).toMatchObject({ state: 'verified' });
    expect(existsSync(flagFile())).toBe(false);
    expect(kind.before).toHaveLength(0);
  });

  it('resume() of an op whose flag was forced off asks beforeMaintenance before it raises the flag again; a refusal ends the op', async () => {
    const kind = updateKind({ refuse: [null, blocked()] });
    const m = machine([kind]);
    const handle = await m.begin('update', CLI, {}, { state: 'verified' });
    now = T0 + OPS_STALL_MS + 1;
    expect(await m.step(20_000)).toMatchObject({ state: 'needs_attention' });
    await fsp.rm(flagFile()); // maintenance:off --force
    now += 60_000;
    expect(await m.resume()).toMatchObject({ state: 'verified' });
    expect(kind.before.map((op) => [op.state, op.opId])).toEqual([['verified', handle.opId]]);
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'update', since: now, opId: handle.opId, exemptJobIds: [] });

    now = (await readOp()).heartbeatAt + OPS_STALL_MS + 1;
    expect(await m.step(20_000)).toMatchObject({ state: 'needs_attention' });
    await fsp.rm(flagFile());
    now += 60_000;
    expect(await m.resume()).toMatchObject({ state: 'aborted', terminal: true, error: { code: 'OPS_BLOCKED_BY_BACKUP' } });
    expect(kind.before).toHaveLength(2);
    expect(kind.cancels.map((op) => [op.state, op.error?.code])).toEqual([['verified', 'OPS_BLOCKED_BY_BACKUP']]);
    expect(kind.flagAtCancel).toEqual([false]);
    expect(existsSync(flagFile())).toBe(false);
    expect(kind.steps).toHaveLength(0);
  });

  it('cancel in downloading runs the kind cancel and touches no flag; cancel at verified once the flag is up lowers it', async () => {
    const kind = updateKind();
    const m = machine([kind]);
    await m.begin('update', CLI, {});
    await m.step(1);
    expect(await m.cancel(CLI)).toMatchObject({ state: 'aborted', terminal: true, error: null });
    expect(kind.cancels.map((op) => op.state)).toEqual(['downloading']);
    expect(existsSync(flagFile())).toBe(false);

    const handle = await m.begin('update', CLI, {});
    await m.step(20_000); // → verified
    await m.step(20_000); // the flag
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);
    expect(await m.cancel(CLI)).toMatchObject({ state: 'aborted', terminal: true });
    expect(kind.cancels.map((op) => op.state)).toEqual(['downloading', 'verified']);
    expect(existsSync(flagFile())).toBe(false);
  });

  it('a manual flag is left alone by an op that ends before maintenanceFrom', async () => {
    const m = machine([updateKind({ throwIn: 'downloading' })]);
    await m.begin('update', CLI, {});
    await writeMaintenance(dataDir, { reason: 'manual', since: now, opId: null, exemptJobIds: [] });
    expect(await m.step(20_000)).toMatchObject({ state: 'aborted' });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'manual', opId: null });
  });

  it('without the freeze: the step after verified raises the flag and calls the handler in verified at once', async () => {
    const kind = updateKind({ freeze: false });
    const m = machine([kind]);
    const handle = await m.begin('update', CLI, {});
    await m.step(20_000);
    expect(kind.steps.map((s) => s.state)).toEqual(['checking', 'downloading']);
    await m.step(1);
    expect(kind.before).toHaveLength(1);
    expect(kind.steps.map((s) => s.state)).toEqual(['checking', 'downloading', 'verified']);
    expect(kind.flagAtStep).toEqual([false, false, true]);
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);
    expect((await readOp()).params).not.toHaveProperty('frozenAt');
  });

  it('a step that goes back before maintenanceFrom (not ending the op) fails it like a thrown error', async () => {
    const kind = updateKind({ freeze: false });
    kind.step = async (_ctx, op) => {
      now += 5;
      return { ...op, state: 'downloading' };
    };
    const m = machine([kind]);
    await m.begin('update', CLI, {}, { state: 'verified' });
    expect(await m.step(20_000)).toMatchObject({ state: 'aborted', terminal: true, error: { code: 'INTERNAL' } });
    expect(existsSync(flagFile())).toBe(false);
  });

  it('createOpsMachine refuses a maintenanceFrom or an entry state the op cannot go on from', () => {
    const bad: [string, Partial<OpKindHandler>][] = [
      ['maintenanceFrom not a state of the kind', { maintenanceFrom: 'exporting' }],
      ['maintenanceFrom an end state', { maintenanceFrom: 'done' }],
      ['maintenanceFrom needs_attention', { maintenanceFrom: NEEDS_ATTENTION }],
      ['maintenanceFrom without a maintenance reason', { maintenance: null }],
      ['an entry state that ends the op', { entryStates: ['aborted'] }],
      ['an entry state that is not a state of the kind', { entryStates: ['running'] }],
      ['needs_attention as an entry state', { entryStates: [NEEDS_ATTENTION] }],
    ];
    for (const [name, over] of bad) {
      expect(() => machine([{ ...updateKind(), ...over }]), name).toThrow(TypeError);
    }
    expect(() => machine([updateKind()])).not.toThrow();
  });
});
