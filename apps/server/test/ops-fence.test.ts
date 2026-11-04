import fsp from 'node:fs/promises';
import path from 'node:path';
import { activeOp, readDataEpoch, readMaintenance } from '@altis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../src/config.js';
import { createOpsFence } from '../src/http/ops-fence.js';
import { start } from '../src/index.js';
import { flagOf, removeOp, writeEpoch, writeFlag, writeOp } from './ops-support.js';
import { bootContext, closeTestServers, httpRequest, recordingLogger, sampleConfig, useDataDir } from './support.js';

// The ops part of the §9.3 fence (plan Task 15, S19, S23): ops/maintenance.json, ops/data-epoch and the kind and state
// of ops/op.json are looked at no more than once per 2 s, by requests (and the worker loop), never by a timer. A raised
// data epoch calls onEpoch once (start(): caches dropped, ctx.requestRestart('data-epoch')); onOpEnded fires once when a
// look finds no active op after one was seen.

const dirs = useDataDir();
const T0 = 1_800_000_000_000;

afterEach(async () => {
  await closeTestServers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A fence over a fake clock, with its three readers spied on (each look calls each once). */
function setup(o: { intervalMs?: number } = {}) {
  let now = T0;
  const reads = { maintenance: vi.fn(readMaintenance), epoch: vi.fn(readDataEpoch), op: vi.fn(activeOp) };
  const onEpoch = vi.fn<(next: number, prev: number) => void>();
  const onOpEnded = vi.fn<() => void>();
  const log = recordingLogger();
  const fence = createOpsFence({ dataDir: dirs.dataDir, clock: () => now, onEpoch, onOpEnded, log, reads, ...o });
  return { fence, reads, onEpoch, onOpEnded, log, advance: (ms: number) => (now += ms) };
}

describe('createOpsFence', () => {
  it('a maintenance.json written by another process is seen by a request ≥ 2 s after the previous look, not before', async () => {
    const { fence, reads, advance } = setup();
    await fence.check(); // the first check looks at once
    expect(reads.maintenance).toHaveBeenCalledTimes(1);
    expect(reads.epoch).toHaveBeenCalledTimes(1);
    expect(reads.op).toHaveBeenCalledTimes(1);
    expect(fence.maintenance()).toBeNull();

    const flag = flagOf('backup', null, T0);
    await writeFlag(dirs.dataDir, flag);
    advance(1999);
    await fence.check();
    expect(reads.maintenance).toHaveBeenCalledTimes(1); // no look yet
    expect(fence.maintenance()).toBeNull();

    advance(1);
    await fence.check();
    expect(reads.maintenance).toHaveBeenCalledTimes(2);
    expect(fence.maintenance()).toEqual(flag);

    // Concurrent checks share one look; a clock that went back counts as due.
    advance(5000);
    await Promise.all([fence.check(), fence.check(), fence.check()]);
    expect(reads.maintenance).toHaveBeenCalledTimes(3);
    advance(-60_000);
    await fence.check();
    expect(reads.maintenance).toHaveBeenCalledTimes(4);
  });

  it('refresh() looks now, whatever the interval', async () => {
    const { fence, reads } = setup();
    await fence.check();
    await writeFlag(dirs.dataDir, flagOf('manual', null, T0));
    await fence.refresh();
    expect(reads.maintenance).toHaveBeenCalledTimes(2);
    expect(fence.maintenance()?.reason).toBe('manual');
  });

  it('an epoch bump calls onEpoch(next, prev) once; the first look only learns the epoch', async () => {
    await writeEpoch(dirs.dataDir, 4);
    const { fence, onEpoch, advance } = setup();
    await fence.check();
    expect(fence.epoch()).toBe(4);
    expect(onEpoch).not.toHaveBeenCalled();

    await writeEpoch(dirs.dataDir, 5);
    advance(2000);
    await fence.check();
    expect(onEpoch).toHaveBeenCalledTimes(1);
    expect(onEpoch).toHaveBeenCalledWith(5, 4);
    expect(fence.epoch()).toBe(5);
    advance(2000);
    await fence.check();
    expect(onEpoch).toHaveBeenCalledTimes(1);
  });

  it('an unreadable data-epoch keeps the epoch in use, logged once; a failing onEpoch is logged, never thrown', async () => {
    await writeEpoch(dirs.dataDir, 2);
    const { fence, onEpoch, advance, log } = setup();
    await fence.check();
    await fsp.writeFile(path.join(dirs.dataDir, 'ops', 'data-epoch'), 'garbage\n');
    for (let i = 0; i < 3; i += 1) {
      advance(2000);
      await fence.check();
    }
    expect(fence.epoch()).toBe(2);
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(1);
    onEpoch.mockImplementation(() => {
      throw new Error('boom');
    });
    await writeEpoch(dirs.dataDir, 3);
    advance(2000);
    await expect(fence.check()).resolves.toBeUndefined();
    expect(fence.epoch()).toBe(3);
  });

  it('onOpEnded fires once after the op file turns terminal (or goes), and again for the next op', async () => {
    const { fence, onOpEnded, advance } = setup();
    await fence.check();
    expect(fence.op()).toBeNull();
    expect(fence.active()).toBe(false);

    const { op } = await writeOp(dirs.dataDir, { kind: 'backup', state: 'exporting', at: T0 });
    advance(2000);
    await fence.check();
    expect(fence.op()).toEqual({ opId: op.opId, kind: 'backup', state: 'exporting', pointOfNoReturn: false });
    expect(fence.active()).toBe(true);
    expect(onOpEnded).not.toHaveBeenCalled();

    await writeOp(dirs.dataDir, { ...op, state: 'done', at: T0 + 1 });
    advance(2000);
    await fence.check();
    expect(fence.op()).toBeNull();
    expect(onOpEnded).toHaveBeenCalledTimes(1);
    advance(2000);
    await fence.check();
    expect(onOpEnded).toHaveBeenCalledTimes(1);

    await writeOp(dirs.dataDir, { kind: 'migrate', state: 'running', at: T0 + 2 });
    advance(2000);
    await fence.check();
    await removeOp(dirs.dataDir);
    advance(2000);
    await fence.check();
    expect(onOpEnded).toHaveBeenCalledTimes(2);
  });

  it('restoreInProgress / restorePastPonr follow the restore op; a corrupt op.json is active and, under a restore flag, past its point of no return', async () => {
    const { fence, advance } = setup({ intervalMs: 0 });
    await fence.check();
    expect([fence.restoreInProgress(), fence.restorePastPonr()]).toEqual([false, false]);

    const { op } = await writeOp(dirs.dataDir, { kind: 'restore', state: 'prechecked', at: T0 });
    await writeFlag(dirs.dataDir, flagOf('restore', op.opId, T0));
    advance(1);
    await fence.check();
    expect([fence.restoreInProgress(), fence.restorePastPonr()]).toEqual([true, false]);

    await writeOp(dirs.dataDir, { ...op, state: 'loading', pointOfNoReturn: true });
    advance(1);
    await fence.check();
    expect([fence.restoreInProgress(), fence.restorePastPonr()]).toEqual([true, true]);

    // A frozen backup: maintenance, but no restore.
    const backup = await writeOp(dirs.dataDir, { kind: 'backup', state: 'exporting', at: T0 });
    await writeFlag(dirs.dataDir, flagOf('backup', backup.op.opId, T0));
    advance(1);
    await fence.check();
    expect([fence.restoreInProgress(), fence.restorePastPonr()]).toEqual([false, false]);

    // op.json and its .bak unreadable while the restore flag names the op: active, and treated as past PONR.
    await writeFlag(dirs.dataDir, flagOf('restore', op.opId, T0));
    await fsp.writeFile(path.join(dirs.dataDir, 'ops', 'op.json'), '{not json');
    advance(1);
    await fence.check();
    expect(fence.active()).toBe(true);
    expect(fence.op()).toEqual({ opId: op.opId, kind: 'restore', state: 'needs_attention', pointOfNoReturn: true });
    expect([fence.restoreInProgress(), fence.restorePastPonr()]).toEqual([true, true]);
  });

  it('never rejects: a look that fails keeps what it knew (logged once)', async () => {
    const { fence, reads, advance, log } = setup();
    await writeFlag(dirs.dataDir, flagOf('manual', null, T0));
    await fence.check();
    reads.maintenance.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    advance(2000);
    await expect(fence.check()).resolves.toBeUndefined();
    advance(2000);
    await fence.check();
    expect(fence.maintenance()?.reason).toBe('manual');
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(1);
  });
});

describe('start(ctx): the ops fence', () => {
  it('an epoch raised by another process: onEpoch once, ctx.requestRestart("data-epoch") once', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' } }));
    vi.stubEnv('ALTIS_RUNNER', 'off'); // external mode: no worker loop, only requests look
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    const served = await ctx.served();
    expect((await httpRequest(served.port, '/_health')).status).toBe(200);

    await writeEpoch(dirs.dataDir, 1);
    vi.setSystemTime(T0 + 1000);
    await httpRequest(served.port, '/_health');
    expect(ctx.requestRestart).not.toHaveBeenCalled(); // < 2 s since the last look

    vi.setSystemTime(T0 + 3000);
    await httpRequest(served.port, '/_health');
    expect(ctx.requestRestart).toHaveBeenCalledTimes(1);
    expect(ctx.requestRestart).toHaveBeenCalledWith('data-epoch');

    vi.setSystemTime(T0 + 6000);
    await httpRequest(served.port, '/_health');
    expect(ctx.requestRestart).toHaveBeenCalledTimes(1);
  });
});
