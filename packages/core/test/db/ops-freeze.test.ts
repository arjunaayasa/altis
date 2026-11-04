import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { DomainError, newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import { readMaintenance, readOpFile, writeMaintenance, type OpFile } from '../../src/ops/files.js';
import { FREEZE_SETTLE_MS, FREEZE_WAIT_MS, liveLeases } from '../../src/ops/freeze.js';
import { OPS_STALL_MS, createOpsMachine, type OpKindHandler, type OpsMachine } from '../../src/ops/machine.js';

// The freeze (spec §9.4, decision C9): an op of a freezing kind waits in its first state until no job lease is alive,
// at least 3 s after its maintenance flag went up and at most 60 s; past that it fails with OPS_FREEZE_TIMEOUT and
// lowers the flag. Also the progress hints of `ctx.publish` (M43). On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const CLI = { type: 'cli', id: null } as const;
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

describe.skipIf(!ctx.available)(`ops freeze [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  let now: number;
  let machines: OpsMachine[];

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-ops-freeze-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-ops-freeze-'));
    now = T0;
    machines = [];
    await h.db.deleteFrom('jobs').execute();
    await h.db.deleteFrom('events').execute();
  });

  afterEach(async () => {
    for (const m of machines) await m.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** A running job whose lease ends at `until`. */
  async function job(until: number, status = 'running'): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('jobs')
      .values({
        id,
        type: 'test.freeze',
        payload: '{}',
        status,
        run_at: T0 - 1000,
        max_attempts: 5,
        lock_token: status === 'running' ? 'token' : null,
        locked_by: status === 'running' ? 'worker' : null,
        locked_until: status === 'running' ? until : null,
        created_at: T0 - 1000,
        updated_at: T0 - 1000,
      })
      .execute();
    return id;
  }

  /**
   * A freezing kind: `restore` (`verifying → prechecked → done`) or `backup` (`frozen → exporting → done`). Its `cancel`
   * records the op it is given.
   */
  function freezing(kind: 'restore' | 'backup'): OpKindHandler & { steps: OpFile[]; cancels: OpFile[] } {
    const states = kind === 'restore' ? ['verifying', 'prechecked', 'done'] : ['frozen', 'exporting', 'done'];
    const handler = {
      steps: [] as OpFile[],
      cancels: [] as OpFile[],
      kind,
      initialState: states[0]!,
      maintenance: kind,
      freeze: true,
      async step(c: { publish(o: { progress: number; message?: string }): void }, op: OpFile): Promise<OpFile> {
        handler.steps.push(op);
        const next = states[states.indexOf(op.state) + 1]!;
        c.publish({ progress: next === 'done' ? 100 : 40, message: next });
        return { ...op, state: next, progress: next === 'done' ? 100 : 40 };
      },
      async cancel(_c: unknown, op: OpFile): Promise<void> {
        handler.cancels.push(op);
      },
    };
    return handler;
  }

  function machine(kinds: OpKindHandler[]): OpsMachine {
    const m = createOpsMachine({
      dataDir,
      kinds,
      db: () => h,
      connect: () => Promise.reject(new Error('the live handle is used here')),
      keyring: () => [],
      clock: () => now,
      log: silent,
      snapshotBackupRunning: async () => false,
    });
    machines.push(m);
    return m;
  }

  async function readOp(): Promise<OpFile> {
    const op = await readOpFile(dataDir);
    if (op === null || op === 'corrupt') throw new Error('no readable op.json');
    return op;
  }

  /** `maintenance:off --force`: the flag file goes, whatever op it names. */
  const forceOff = (): Promise<void> => fsp.rm(path.join(dataDir, 'ops', 'maintenance.json'));

  /** Moves the op to `needs_attention` (no movement for 15 minutes) and returns the clock then. */
  async function stall(m: OpsMachine): Promise<void> {
    now = (await readOp()).heartbeatAt + OPS_STALL_MS + 1;
    expect(await m.step(1)).toMatchObject({ state: 'needs_attention' });
  }

  /**
   * A frozen backup that exports `parts` parts, one per handler step (each takes 5 ms of the fake clock, so `step(1)`
   * runs one): `frozen` (its backup's row: `backupId`) `→ exporting` (`params.part` 0 … parts) `→ done`. Its `refreeze`
   * starts the export over from `frozen` (and counts its calls); its `cancel` records the op it is given.
   */
  function exporter(parts: number): OpKindHandler & { steps: OpFile[]; refreezes: OpFile[]; cancels: OpFile[] } {
    const handler = {
      steps: [] as OpFile[],
      refreezes: [] as OpFile[],
      cancels: [] as OpFile[],
      kind: 'backup' as const,
      initialState: 'frozen',
      maintenance: 'backup' as const,
      freeze: true,
      async step(_c: unknown, op: OpFile): Promise<OpFile> {
        handler.steps.push(op);
        now += 5;
        if (op.state === 'frozen') return { ...op, state: 'exporting', backupId: op.opId, params: { ...op.params, part: 0 } };
        const part = Number(op.params['part']) + 1;
        return { ...op, state: part >= parts ? 'done' : 'exporting', params: { ...op.params, part } };
      },
      refreeze(op: OpFile): OpFile {
        handler.refreezes.push(op);
        const params = { ...op.params };
        delete params['part'];
        return { ...op, state: 'frozen', params };
      },
      async cancel(_c: unknown, op: OpFile): Promise<void> {
        handler.cancels.push(op);
      },
    };
    return handler;
  }

  /**
   * A restore without `refreeze`: `verifying → prechecked → loading` (the point of no return) `→ done`, one handler
   * step per `step(1)` as above. Its `cancel` records the op it is given; while `cancelFails` holds an error, it throws
   * that error instead (once).
   */
  function restorer(): OpKindHandler & { steps: OpFile[]; cancels: OpFile[]; cancelFails: Error | null } {
    const next: Record<string, string> = { verifying: 'prechecked', prechecked: 'loading', loading: 'done' };
    const handler = {
      steps: [] as OpFile[],
      cancels: [] as OpFile[],
      cancelFails: null as Error | null,
      kind: 'restore' as const,
      initialState: 'verifying',
      maintenance: 'restore' as const,
      freeze: true,
      async step(_c: unknown, op: OpFile): Promise<OpFile> {
        handler.steps.push(op);
        now += 5;
        const state = next[op.state]!;
        return { ...op, state, pointOfNoReturn: op.pointOfNoReturn || state === 'loading' };
      },
      async cancel(_c: unknown, op: OpFile): Promise<void> {
        const fails = handler.cancelFails;
        handler.cancelFails = null;
        if (fails !== null) throw fails;
        handler.cancels.push(op);
      },
    };
    return handler;
  }

  it('liveLeases counts running jobs with a lease at or after now, outside the exempt ones', async () => {
    const a = await job(T0 + 50_000);
    await job(T0);
    await job(T0 - 1);
    await job(T0 + 50_000, 'queued');
    expect(await liveLeases(h, T0, [])).toBe(2);
    expect(await liveLeases(h, T0, [a])).toBe(1);
    expect(await liveLeases(h, T0 + 1, [])).toBe(1);
  });

  it('waits in the first state while a lease is alive, then sets params.frozenAt and runs the handler', async () => {
    const kind = freezing('restore');
    const m = machine([kind]);
    const leased = await job(T0 + 50_000);
    const handle = await m.begin('restore', CLI, {});
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'restore', since: T0, opId: handle.opId });

    now = T0 + FREEZE_SETTLE_MS - 1; // no lease look before the flag settled
    expect(await m.step(20_000)).toMatchObject({ state: 'verifying' });
    now = T0 + FREEZE_SETTLE_MS + 1000; // settled, but the lease is alive
    expect(await m.step(20_000)).toMatchObject({ state: 'verifying' });
    expect(kind.steps).toHaveLength(0);
    expect((await readOp()).params['frozenAt']).toBeUndefined();

    await h.db.updateTable('jobs').set({ status: 'succeeded', locked_until: null, lock_token: null, locked_by: null }).where('id', '=', leased).execute();
    now = T0 + 6000;
    expect(await m.step(20_000)).toMatchObject({ state: 'done', terminal: true });
    expect(kind.steps).toHaveLength(2);
    expect(kind.steps[0]).toMatchObject({ state: 'verifying', params: { frozenAt: T0 + 6000 } });
    expect((await readOp()).params['frozenAt']).toBe(T0 + 6000);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('a lease of an exempt job does not hold the freeze', async () => {
    const kind = freezing('restore');
    const m = machine([kind]);
    const exempt = await job(T0 + 50_000);
    const handle = await m.begin('restore', CLI, {});
    await writeMaintenance(dataDir, { reason: 'restore', since: T0, opId: handle.opId, exemptJobIds: [exempt] });
    now = T0 + FREEZE_SETTLE_MS;
    expect(await m.step(20_000)).toMatchObject({ state: 'done' });
  });

  it('a lease still alive after 60 s fails the op with OPS_FREEZE_TIMEOUT and lowers the flag', async () => {
    const kind = freezing('restore');
    const m = machine([kind]);
    await job(T0 + 600_000);
    await m.begin('restore', CLI, {});
    now = T0 + FREEZE_WAIT_MS;
    expect(await m.step(20_000)).toMatchObject({ state: 'verifying' });
    now = T0 + FREEZE_WAIT_MS + 1;
    const status = await m.step(20_000);
    expect(status).toMatchObject({ state: 'failed', terminal: true, error: { code: 'OPS_FREEZE_TIMEOUT' }, finishedAt: now });
    expect(kind.steps).toHaveLength(0);
    expect(kind.cancels).toHaveLength(0); // it did nothing yet: nothing to undo
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('a frozen backup that cannot freeze ends aborted', async () => {
    const m = machine([freezing('backup')]);
    await job(T0 + 600_000);
    await m.begin('backup', CLI, {});
    now = T0 + FREEZE_WAIT_MS + 1;
    expect(await m.step(20_000)).toMatchObject({ state: 'aborted', error: { code: 'OPS_FREEZE_TIMEOUT' } });
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('publishes the latest progress hint of a backup or restore step on system.backup, and none past a restore PONR', async () => {
    const kind = freezing('backup');
    const m = machine([kind]);
    const handle = await m.begin('backup', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(20_000);
    const events = await h.db.selectFrom('events').select(['channel', 'type', 'payload']).orderBy('seq').execute();
    expect(events.map((e) => [e.channel, e.type])).toEqual([
      ['system.backup', 'op.progress'],
      ['system.backup', 'op.progress'],
    ]);
    expect(JSON.parse(events[0]!.payload)).toEqual({ opId: handle.opId, kind: 'backup', state: 'exporting', progress: 40, message: 'exporting' });

    await h.db.deleteFrom('events').execute();
    const restore: OpKindHandler = {
      kind: 'restore',
      initialState: 'verifying',
      maintenance: 'restore',
      freeze: false,
      async step(c, op) {
        c.publish({ progress: 60 });
        return { ...op, state: 'prechecked', pointOfNoReturn: true };
      },
    };
    const m2 = machine([restore]);
    await m2.begin('restore', CLI, {});
    await m2.step(1);
    expect(await h.db.selectFrom('events').select('seq').execute()).toEqual([]);
  });

  it('an unreadable op.json and .bak: needs attention, maintenance kept, backupId from the newest releases_log row', async () => {
    await h.db.deleteFrom('releases_log').execute();
    const older = newId(T0 - 2000);
    const newer = newId(T0 - 1000);
    const row = (backupId: string | null, startedAt: number) => ({
      id: newId(startedAt),
      version: '0.2.0',
      action: 'update',
      status: 'done',
      started_at: startedAt,
      backup_id: backupId,
    });
    await h.db.insertInto('releases_log').values([row(older, T0 - 2000), row(newer, T0 - 1000), row(null, T0 - 500)]).execute();
    const m = machine([freezing('restore')]);
    const handle = await m.begin('restore', CLI, {});
    await fsp.writeFile(path.join(dataDir, 'ops', 'op.json'), '{');
    await fsp.writeFile(path.join(dataDir, 'ops', 'op.json.bak'), '{');
    const status = await m.step(20_000);
    expect(status).toMatchObject({ opId: handle.opId, kind: 'restore', state: 'needs_attention', backupId: newer, error: { code: 'STATE_CORRUPT' } });
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);
    await h.db.deleteFrom('releases_log').execute();
  });

  // Final review G2 round 2: a frozen op whose maintenance flag was down (forced off while it needed attention, or
  // removed by hand) is no longer frozen: other processes served and wrote meanwhile.

  it('resume after maintenance was forced off: the freeze starts over (settle, live leases) and so does the work (refreeze)', async () => {
    const kind = exporter(4);
    const m = machine([kind]);
    const handle = await m.begin('backup', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(1); // frozen → exporting, frozen at T0 + 3 s
    await m.step(1); // part 1
    expect(await readOp()).toMatchObject({ state: 'exporting', params: { frozenAt: T0 + FREEZE_SETTLE_MS, part: 1 } });
    await stall(m);
    await forceOff(); // the site serves again for an hour, jobs run
    now += HOUR;
    const leased = await job(now + 50_000);
    const handlerSteps = kind.steps.length;

    expect(await m.resume()).toMatchObject({ state: 'frozen', needsAttention: false });
    expect(kind.refreezes).toHaveLength(1);
    expect(kind.refreezes[0]).toMatchObject({ state: 'exporting', params: { part: 1 } });
    expect(kind.refreezes[0]!.params['frozenAt']).toBeUndefined();
    const resumed = await readOp();
    expect(resumed.params).not.toHaveProperty('frozenAt');
    expect(resumed.params).not.toHaveProperty('part');
    const resumedAt = now;
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'backup', since: resumedAt, opId: handle.opId, exemptJobIds: [] });

    // The settle again, from the flag raised by the resume; then the lease taken while the flag was off holds it.
    expect(await m.step(1)).toMatchObject({ state: 'frozen' });
    now = resumedAt + FREEZE_SETTLE_MS + 1000;
    expect(await m.step(1)).toMatchObject({ state: 'frozen' });
    expect(kind.steps).toHaveLength(handlerSteps);
    await h.db.updateTable('jobs').set({ status: 'succeeded', locked_until: null, lock_token: null, locked_by: null }).where('id', '=', leased).execute();
    const frozenAgain = now;
    await m.step(1);
    expect(kind.steps.at(-1)).toMatchObject({ state: 'frozen', params: { frozenAt: frozenAgain } });
    for (let i = 0; i < 10 && !(await readOp()).finishedAt; i += 1) await m.step(1);
    expect(await readOp()).toMatchObject({ state: 'done', params: { part: 4, frozenAt: frozenAgain } });
    // Every part after the resume was made under the new freeze.
    expect(kind.steps.slice(handlerSteps).map((s) => [s.state, s.params['part'] ?? null])).toEqual([
      ['frozen', null],
      ['exporting', 0],
      ['exporting', 1],
      ['exporting', 2],
      ['exporting', 3],
    ]);
  });

  it('resume with the flag still up keeps the freeze: no refreeze, the next step goes on at once', async () => {
    const kind = exporter(4);
    const m = machine([kind]);
    const handle = await m.begin('backup', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(1);
    await m.step(1);
    await stall(m);
    now += HOUR;
    expect(await m.resume()).toMatchObject({ state: 'exporting' });
    expect(kind.refreezes).toHaveLength(0);
    expect(await readMaintenance(dataDir)).toMatchObject({ since: T0, opId: handle.opId });
    await m.step(1);
    expect(kind.steps.at(-1)).toMatchObject({ state: 'exporting', params: { part: 1, frozenAt: T0 + FREEZE_SETTLE_MS } });
  });

  it('a kind without refreeze (a restore before its point of no return), forced off: resume ends it failed through its cancel (R1c-15)', async () => {
    const kind = restorer();
    const m = machine([kind]);
    const handle = await m.begin('restore', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(1); // verifying → prechecked
    await stall(m);
    await forceOff();
    now += HOUR;
    const status = await m.resume();
    expect(status).toMatchObject({ opId: handle.opId, state: 'failed', terminal: true, pointOfNoReturn: false, error: { code: 'OPS_FREEZE_BROKEN' }, finishedAt: now });
    // The kind undid its work, told why: the op as it stopped, with the error it ends with.
    expect(kind.cancels).toHaveLength(1);
    expect(kind.cancels[0]).toMatchObject({ opId: handle.opId, state: 'prechecked', error: { code: 'OPS_FREEZE_BROKEN' } });
    expect(await readOp()).toMatchObject({ state: 'failed', error: { code: 'OPS_FREEZE_BROKEN' } });
    expect(await readMaintenance(dataDir)).toBeNull(); // not raised again: the op ended
    expect(await m.step(1)).toMatchObject({ state: 'failed', terminal: true });
    expect(kind.steps).toHaveLength(1);
    expect(kind.cancels).toHaveLength(1);
  });

  it('a flag removed by hand while a restore runs before its point of no return: the next step ends it failed through its cancel', async () => {
    const kind = restorer();
    const m = machine([kind]);
    await m.begin('restore', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(1); // verifying → prechecked
    await forceOff();
    now += 60_000;
    expect(await m.step(1)).toMatchObject({ state: 'failed', terminal: true, error: { code: 'OPS_FREEZE_BROKEN' } });
    expect(kind.cancels.map((op) => [op.state, op.error?.code])).toEqual([['prechecked', 'OPS_FREEZE_BROKEN']]);
    expect(kind.steps).toHaveLength(1);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('a cancel that cannot reach the database leaves the broken op as it was, and the next step ends it', async () => {
    const kind = restorer();
    const m = machine([kind]);
    await m.begin('restore', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(1);
    await forceOff();
    now += 60_000;
    kind.cancelFails = new DomainError('DB_UNAVAILABLE');
    await expect(m.step(1)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(await readOp()).toMatchObject({ state: 'prechecked', params: { frozenAt: T0 + FREEZE_SETTLE_MS } });
    expect(await readMaintenance(dataDir)).toBeNull(); // not raised: no step may go on from the broken freeze
    expect(await m.step(1)).toMatchObject({ state: 'failed', error: { code: 'OPS_FREEZE_BROKEN' } });
    expect(kind.cancels).toHaveLength(1);
    expect(kind.steps).toHaveLength(1);
  });

  it("an operator's cancel gives the kind's cancel the op without an error", async () => {
    const kind = restorer();
    const m = machine([kind]);
    await m.begin('restore', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(1);
    expect(await m.cancel(CLI)).toMatchObject({ state: 'failed', error: null });
    expect(kind.cancels).toHaveLength(1);
    expect(kind.cancels[0]).toMatchObject({ state: 'prechecked', error: null });
  });

  it('a flag removed by hand while a frozen op runs: M21 raises it again and the freeze and the work start over', async () => {
    const kind = exporter(4);
    const m = machine([kind]);
    const handle = await m.begin('backup', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(1);
    await m.step(1);
    await forceOff();
    now += 60_000;
    const raisedAt = now;
    const handlerSteps = kind.steps.length;
    expect(await m.step(1)).toMatchObject({ state: 'frozen' });
    expect(kind.steps).toHaveLength(handlerSteps);
    expect(kind.refreezes).toHaveLength(1);
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'backup', since: raisedAt, opId: handle.opId, exemptJobIds: [] });
    expect((await readOp()).params).not.toHaveProperty('frozenAt');
    now = raisedAt + FREEZE_SETTLE_MS;
    await m.step(1);
    expect(kind.steps.at(-1)).toMatchObject({ state: 'frozen', params: { frozenAt: raisedAt + FREEZE_SETTLE_MS } });
  });

  it('a freeze that times out after a refreeze undoes the work the op did through its cancel (R1c-15)', async () => {
    const kind = exporter(4);
    const m = machine([kind]);
    const handle = await m.begin('backup', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(1); // frozen → exporting: the backup's row
    await m.step(1); // part 1
    await stall(m);
    await forceOff();
    now += HOUR;
    await job(now + HOUR); // taken while the flag was off, alive past the freeze wait
    expect(await m.resume()).toMatchObject({ state: 'frozen', backupId: handle.opId });
    const resumedAt = now;
    now = resumedAt + FREEZE_WAIT_MS;
    expect(await m.step(1)).toMatchObject({ state: 'frozen' });
    expect(kind.cancels).toHaveLength(0);
    now = resumedAt + FREEZE_WAIT_MS + 1;
    expect(await m.step(1)).toMatchObject({ state: 'aborted', terminal: true, error: { code: 'OPS_FREEZE_TIMEOUT' } });
    expect(kind.cancels).toHaveLength(1);
    expect(kind.cancels[0]).toMatchObject({ state: 'frozen', backupId: handle.opId, error: { code: 'OPS_FREEZE_TIMEOUT' } });
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('a restore past its point of no return keeps its flag in needs_attention (its tables are half loaded) and its freeze on resume', async () => {
    const kind = restorer();
    const m = machine([kind]);
    const handle = await m.begin('restore', CLI, {});
    now = T0 + FREEZE_SETTLE_MS;
    await m.step(1); // verifying → prechecked
    await m.step(1); // prechecked → loading: the point of no return
    expect(await readOp()).toMatchObject({ state: 'loading', pointOfNoReturn: true });
    await stall(m);
    await forceOff();
    now += 60_000;
    expect(await m.step(1)).toMatchObject({ state: 'needs_attention' });
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'restore', since: now, opId: handle.opId, exemptJobIds: [] });
    expect(kind.steps).toHaveLength(2);

    now += HOUR;
    expect(await m.resume()).toMatchObject({ state: 'loading' });
    expect((await readOp()).params['frozenAt']).toBe(T0 + FREEZE_SETTLE_MS);
    await m.step(1);
    expect(kind.steps.at(-1)).toMatchObject({ state: 'loading', params: { frozenAt: T0 + FREEZE_SETTLE_MS } });
  });

  // 1d Task 11 (decision D1d-14, preflight S23): an update holds its flag and the freeze only from `verified`
  // (`maintenanceFrom`); the download runs while the site serves and jobs run.

  /**
   * A fake `update` kind: `checking → downloading → verified → frozen → backed_up → staged → switched` (the point of no
   * return), one handler step per `step(1)` (5 ms of the fake clock each). Maintenance `update` from `verified`, freeze,
   * entry state `verified`. Its `refreeze` takes `frozen`/`backed_up` back to `verified`; `beforeMaintenance` and
   * `cancel` record the op they are given and whether the flag file existed then.
   */
  function updater(): OpKindHandler & {
    steps: OpFile[];
    before: [OpFile, boolean][];
    cancels: [OpFile, boolean][];
    refreezes: OpFile[];
  } {
    const next: Record<string, string> = {
      checking: 'downloading',
      downloading: 'verified',
      verified: 'frozen',
      frozen: 'backed_up',
      backed_up: 'staged',
      staged: 'switched',
      switched: 'switched',
    };
    const flagUp = (): boolean => existsSync(path.join(dataDir, 'ops', 'maintenance.json'));
    const handler = {
      steps: [] as OpFile[],
      before: [] as [OpFile, boolean][],
      cancels: [] as [OpFile, boolean][],
      refreezes: [] as OpFile[],
      kind: 'update' as const,
      initialState: 'checking',
      entryStates: ['verified'],
      maintenance: 'update' as const,
      maintenanceFrom: 'verified',
      freeze: true,
      async step(_c: unknown, op: OpFile): Promise<OpFile> {
        handler.steps.push(op);
        now += 5;
        const state = next[op.state]!;
        return { ...op, state, pointOfNoReturn: op.pointOfNoReturn || state === 'switched' };
      },
      async beforeMaintenance(_c: unknown, op: OpFile): Promise<void> {
        handler.before.push([op, flagUp()]);
      },
      async cancel(_c: unknown, op: OpFile): Promise<void> {
        handler.cancels.push([op, flagUp()]);
      },
      refreeze(op: OpFile): OpFile {
        handler.refreezes.push(op);
        return { ...op, state: 'verified' };
      },
    };
    return handler;
  }

  it('an update: no flag while checking and downloading; the step after verified raises {reason: update} and waits for 3 s and the live lease', async () => {
    const kind = updater();
    const m = machine([kind]);
    const leased = await job(T0 + 50_000); // a job running through the download
    const handle = await m.begin('update', CLI, { target: '0.2.0-test' });
    expect(await readOp()).toMatchObject({ state: 'checking' });
    expect(await readMaintenance(dataDir)).toBeNull();

    expect(await m.step(20_000)).toMatchObject({ state: 'verified' }); // checking, downloading: the lease does not matter
    expect(kind.steps.map((s) => s.state)).toEqual(['checking', 'downloading']);
    expect(await readMaintenance(dataDir)).toBeNull();

    now += 1000;
    const raisedAt = now;
    expect(await m.step(20_000)).toMatchObject({ state: 'verified' });
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'update', since: raisedAt, opId: handle.opId, exemptJobIds: [] });
    expect(kind.before.map(([op, up]) => [op.state, up])).toEqual([['verified', false]]);
    expect(kind.steps).toHaveLength(2);

    now = raisedAt + FREEZE_SETTLE_MS - 1; // not settled
    expect(await m.step(20_000)).toMatchObject({ state: 'verified' });
    now = raisedAt + FREEZE_SETTLE_MS + 1000; // settled, the lease alive
    expect(await m.step(20_000)).toMatchObject({ state: 'verified' });
    expect(kind.steps).toHaveLength(2);
    expect((await readOp()).params['frozenAt']).toBeUndefined();

    await h.db.updateTable('jobs').set({ status: 'succeeded', locked_until: null, lock_token: null, locked_by: null }).where('id', '=', leased).execute();
    now = raisedAt + 6000;
    expect(await m.step(1)).toMatchObject({ state: 'frozen' });
    expect(kind.steps[2]).toMatchObject({ state: 'verified', params: { target: '0.2.0-test', frozenAt: raisedAt + 6000 } });
    expect(kind.before).toHaveLength(1);
    expect(await m.step(20_000)).toMatchObject({ state: 'switched', pointOfNoReturn: true });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', since: raisedAt, opId: handle.opId });
    expect(kind.before).toHaveLength(1);
  });

  it('Review Focus 4: an update in frozen with no step for 15 minutes → needs_attention, flag kept; resume() → frozen, the same freeze', async () => {
    const kind = updater();
    const m = machine([kind]);
    const handle = await m.begin('update', CLI, {});
    await m.step(20_000); // → verified
    await m.step(20_000); // the flag, at T0 + 10
    now = T0 + 10 + FREEZE_SETTLE_MS;
    expect(await m.step(1)).toMatchObject({ state: 'frozen' });
    const frozenAt = T0 + 10 + FREEZE_SETTLE_MS;
    await stall(m);
    expect(await readOp()).toMatchObject({ state: 'needs_attention', stateBefore: 'frozen' });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', since: T0 + 10, opId: handle.opId });
    now += 60_000;
    expect(await m.step(20_000)).toMatchObject({ state: 'needs_attention' });
    expect((await readMaintenance(dataDir))?.opId).toBe(handle.opId);

    expect(await m.resume()).toMatchObject({ state: 'frozen', needsAttention: false });
    expect(kind.refreezes).toHaveLength(0);
    expect(await readOp()).toMatchObject({ state: 'frozen', params: { frozenAt } });
    await m.step(1);
    expect(kind.steps.at(-1)).toMatchObject({ state: 'frozen', params: { frozenAt } });
    expect(kind.before).toHaveLength(1);
  });

  it('an update whose freeze times out at verified: the kind undoes its work (the download), aborted with OPS_FREEZE_TIMEOUT, flag lowered', async () => {
    const kind = updater();
    const m = machine([kind]);
    await job(T0 + 600_000);
    await m.begin('update', CLI, {});
    await m.step(20_000); // → verified, at T0 + 10
    await m.step(20_000); // the flag
    now = T0 + 10 + FREEZE_WAIT_MS + 1;
    expect(await m.step(20_000)).toMatchObject({ state: 'aborted', terminal: true, error: { code: 'OPS_FREEZE_TIMEOUT' } });
    expect(kind.cancels.map(([op, up]) => [op.state, op.error?.code, up])).toEqual([['verified', 'OPS_FREEZE_TIMEOUT', true]]);
    expect(kind.steps).toHaveLength(2);
    expect(await readMaintenance(dataDir)).toBeNull();
  });

  it('a flag removed by hand while an update is frozen: beforeMaintenance again, refreeze back to verified, the flag and the freeze again', async () => {
    const kind = updater();
    const m = machine([kind]);
    const handle = await m.begin('update', CLI, {});
    await m.step(20_000);
    await m.step(20_000);
    now = T0 + 10 + FREEZE_SETTLE_MS;
    expect(await m.step(1)).toMatchObject({ state: 'frozen' });
    await forceOff();
    now += 60_000;
    const raisedAt = now;
    const handlerSteps = kind.steps.length;
    expect(await m.step(1)).toMatchObject({ state: 'verified' });
    expect(kind.refreezes.map((op) => op.state)).toEqual(['frozen']);
    expect(kind.before.map(([op, up]) => [op.state, up])).toEqual([
      ['verified', false],
      ['frozen', false],
    ]);
    expect(await readMaintenance(dataDir)).toEqual({ reason: 'update', since: raisedAt, opId: handle.opId, exemptJobIds: [] });
    expect((await readOp()).params).not.toHaveProperty('frozenAt');
    expect(kind.steps).toHaveLength(handlerSteps);
    now = raisedAt + FREEZE_SETTLE_MS;
    await m.step(1);
    expect(kind.steps.at(-1)).toMatchObject({ state: 'verified', params: { frozenAt: raisedAt + FREEZE_SETTLE_MS } });
  });
});
