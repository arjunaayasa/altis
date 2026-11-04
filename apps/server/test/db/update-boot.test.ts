import { fork, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { OpFile } from '@altis/core';
import { PHASE1_MIGRATIONS, type DbHandle } from '@altis/db';
import { dataPath, readCurrentState, updateCurrentState, withFileLock } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { writeConfig } from '../../src/config.js';
import { start, type BootContext } from '../../src/index.js';
import { flagOf, readOpJson, writeFlag, writeOp } from '../ops-support.js';
import { bootContext, closeTestServers, httpRequest, sampleConfig, useDataDir, type ServedServer, type TestBootContext } from '../support.js';

// start() of an update's target (plan Task 25; spec §9.3, §9.6 step 6; decisions D1d-17, D1d-42; preflight B8, S1, S2,
// 1D-02, 1D-05) on the engine picked by ALTIS_TEST_DB: the `update_boot` plan boots the target inside the update op
// (phase `updating`, no 1c runMigrations before the op ends, the real updateHealth, ctx.markHealthy by the op) and then
// boots as usual; a target whose op ends `reverting` or `needs_attention` rejects with UPDATE_BOOT_FAILED having closed
// what it opened; the target of an op already reverting refuses at once (B8); a loop facing an unchanged op does not
// spin (1D-02); a holder killed while it migrates is resumed by the next start() (Review Focus 1); `boot-crash`.

const seen = vi.hoisted(() => ({
  connects: 0,
  handles: [] as unknown[],
  steps: 0,
  runMigrations: [] as string[],
  dataDir: '',
  rolesThrow: false,
  kills: 0,
  /** The next connect() throws this instead of connecting, when set. */
  connectFails: null as Error | null,
  /** Run (once) right before the next ops.step: another process's writes. */
  beforeStep: null as (() => Promise<void>) | null,
  /** connect() refuses a db config with this password (access denied: DB_UNAVAILABLE), when set. */
  refusePassword: null as string | null,
  /** The db password of every connect() (undefined for none). */
  passwords: [] as (string | undefined)[],
}));
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  const fsm = await import('node:fs/promises');
  const pathm = await import('node:path');
  return {
    ...actual,
    connect: vi.fn(async (...args: Parameters<typeof actual.connect>) => {
      seen.connects += 1;
      seen.passwords.push(args[0].password);
      const fails = seen.connectFails;
      seen.connectFails = null;
      if (fails !== null) throw fails;
      if (seen.refusePassword !== null && args[0].password === seen.refusePassword) {
        throw new DomainError('DB_UNAVAILABLE', { meta: { reason: 'access_denied', code: 'ER_ACCESS_DENIED_ERROR', retryable: false } });
      }
      const handle = await actual.connect(...args);
      seen.handles.push(handle);
      return handle;
    }),
    // The 1c path's migrations: which state the update op was in when start() ran them.
    runMigrations: vi.fn(async (...args: Parameters<typeof actual.runMigrations>) => {
      let state = 'none';
      try {
        const op = JSON.parse(await fsm.readFile(pathm.join(seen.dataDir, 'ops', 'op.json'), 'utf8')) as { state: string };
        state = op.state;
      } catch {
        // no op
      }
      seen.runMigrations.push(state);
      return actual.runMigrations(...args);
    }),
  };
});
vi.mock('@altis/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/core')>();
  return {
    ...actual,
    createOpsMachine: (o: Parameters<typeof actual.createOpsMachine>[0]) => {
      const machine = actual.createOpsMachine(o);
      return {
        ...machine,
        step: async (budgetMs: number) => {
          seen.steps += 1;
          const before = seen.beforeStep;
          seen.beforeStep = null;
          if (before !== null) await before();
          return machine.step(budgetMs);
        },
      };
    },
  };
});
// 1D-02: the system roles of `verifying` throw on demand (the update kind imports them from this module).
vi.mock('../../../../packages/core/src/authz/system-roles.js', async (importOriginal) => {
  type Roles = (...args: unknown[]) => Promise<unknown>;
  const actual = await importOriginal<{ ensureSystemRoles: Roles }>();
  return {
    ...actual,
    ensureSystemRoles: vi.fn(async (...args: unknown[]) => {
      if (seen.rolesThrow) throw new Error('system roles: injected failure');
      return actual.ensureSystemRoles(...args);
    }),
  };
});
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return {
    ...actual,
    killSelf: vi.fn(() => {
      seen.kills += 1;
      return undefined as never;
    }),
  };
});
const actualDb = await vi.importActual<typeof import('@altis/db')>('@altis/db');

const engine = testDbContext();
const dirs = useDataDir();
const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const LAST_MIGRATION = Object.keys(PHASE1_MIGRATIONS).at(-1)!;
const children: ChildProcess[] = [];

type PendingCtx = TestBootContext & {
  pendingBoot?: boolean;
  bootMarker: TestBootContext['bootMarker'] & { waiting: ReturnType<typeof vi.fn> };
};

beforeEach(async () => {
  if (engine.available) await (await testDb()).close(); // an empty database
  seen.connects = 0;
  seen.handles.length = 0;
  seen.steps = 0;
  seen.runMigrations.length = 0;
  seen.dataDir = dirs.dataDir;
  seen.rolesThrow = false;
  seen.kills = 0;
  seen.connectFails = null;
  seen.beforeStep = null;
  seen.refusePassword = null;
  seen.passwords.length = 0;
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await closeTestServers();
  await Promise.all(seen.handles.map((h) => (h as DbHandle).close()));
  vi.unstubAllEnvs();
});

function ownHandle(): Promise<DbHandle> {
  return actualDb.connect(testDbConfig(engine), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
}

/** The database as 0.1 left it: every migration but the last (so the target's op has one to apply). */
async function databaseOfV1(o: { all?: boolean } = {}): Promise<void> {
  const h = await ownHandle();
  try {
    const migrations = o.all === true ? PHASE1_MIGRATIONS : Object.fromEntries(Object.entries(PHASE1_MIGRATIONS).slice(0, -1));
    await actualDb.runMigrations(h, { appVersion: V1, dataDir: dirs.dataDir, migrations });
  } finally {
    await h.close();
  }
}

async function migrationNames(): Promise<string[]> {
  const h = await ownHandle();
  try {
    return (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name);
  } finally {
    await h.close();
  }
}

/**
 * An update op of 0.1 → `target` past its point of no return, in `state` (frozen at `verified`, `pending` written), its
 * flag up, current.json with `pending` = the target; config.json.
 */
async function updateOp(o: { state: string; target?: string; error?: OpFile['error']; stateBefore?: string }): Promise<OpFile> {
  await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
  const at = Date.now();
  const target = o.target ?? V2;
  const { op } = await writeOp(dirs.dataDir, {
    kind: 'update',
    state: o.state,
    version: V1,
    pointOfNoReturn: true,
    error: o.error ?? null,
    ...(o.stateBefore === undefined ? {} : { stateBefore: o.stateBefore }),
    params: { source: 'feed', target, from: V1, entry: null, staging: null, needsBackup: false, pendingWritten: true, frozenAt: at - 30_000 },
    progress: 95,
  });
  await writeFlag(dirs.dataDir, flagOf('update', op.opId, at - 30_000));
  await readCurrentState(dirs.dataDir, V1);
  await updateCurrentState(dirs.dataDir, (s) => ({ ...s, pending: { version: target, source: 'data' }, pendingSince: at - 10_000 }));
  return op;
}

/** The context app.js hands a pending release (`pendingBoot`, markHealthy promoting it) or, with `pending: false`, another. */
function pendingContext(version: string, o: { pending?: boolean } = {}): PendingCtx {
  const base = bootContext(dirs.dataDir, { version });
  const ctx = base as PendingCtx;
  if (o.pending !== false) ctx.pendingBoot = true;
  ctx.bootMarker = { phase: vi.fn(), progress: vi.fn(), waiting: vi.fn() };
  ctx.markHealthy = vi.fn(async () => {
    if (o.pending === false) return; // an active release's markHealthy changes nothing
    markHealthyStates.push((await readOpJson(dirs.dataDir)).state);
    await updateCurrentState(dirs.dataDir, (s) =>
      s.pending?.version === version ? { ...s, previous: s.active, active: s.pending, pending: null, pendingSince: null } : null,
    );
  });
  return ctx;
}
/** The update op's state at each markHealthy of a pending context. */
let markHealthyStates: string[] = [];
beforeEach(() => {
  markHealthyStates = [];
});

async function health(served: ServedServer): Promise<{ status: number; body: unknown }> {
  const reply = await httpRequest(served.port, '/_health');
  return { status: reply.status, body: JSON.parse(reply.body) as unknown };
}

/** The handles start() opened that are still open (closing a closed handle is harmless; a closed pool refuses queries). */
async function openHandles(): Promise<number> {
  let open = 0;
  for (const h of seen.handles as DbHandle[]) {
    try {
      await h.db.selectFrom('schema_meta').select('id').limit(1).execute();
      open += 1;
    } catch {
      // closed
    }
  }
  return open;
}

describe.skipIf(!engine.available)(`start(ctx) of an update's target [${engineLabel()}]`, () => {
  it(
    'switched → updating → ready: no 1c runMigrations before the op ends, the real updateHealth, markHealthy by the op, MAINTENANCE meanwhile',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await databaseOfV1();
      // The op's migration takes 4 s from here (migrate-slow, armed by its first run in this DATA_DIR), long enough to
      // look at the app while it is `updating`.
      vi.stubEnv('ALTIS_TEST_FAULT', 'migrate-slow:4');
      const op = await updateOp({ state: 'switched' });
      const ctx = pendingContext(V2);
      let settled = false;
      const started = start(ctx as BootContext).finally(() => {
        settled = true;
      });
      const served = await ctx.served();
      await vi.waitFor(async () => expect((await readOpJson(dirs.dataDir)).state).toBe('migrating'), { timeout: 15_000, interval: 50 });
      // phase `updating`: /_health 503 maintenance, a `deny` route 503 MAINTENANCE.
      expect(await health(served)).toEqual({ status: 503, body: { status: 'maintenance', version: V2 } });
      const deny = await httpRequest(served.port, '/api/v1/auth/sessions');
      expect(deny.status).toBe(503);
      expect(JSON.parse(deny.body)).toMatchObject({ code: 'MAINTENANCE', reason: 'update' });
      expect(settled).toBe(false);

      await started;
      const after = await readOpJson(dirs.dataDir);
      expect(after).toMatchObject({ opId: op.opId, state: 'done', error: null });
      expect(await migrationNames()).toContain(LAST_MIGRATION);
      // The 1c path ran its migrations only after the op ended (up to date then).
      expect(seen.runMigrations.length).toBeGreaterThan(0);
      expect(seen.runMigrations.every((s) => s === 'done')).toBe(true);
      // markHealthy once, by the op's verifying step (the real updateHealth said healthy in phase `updating`).
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
      expect(markHealthyStates).toEqual(['verifying']);
      expect(ctx.bootMarker.phase.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['listening', 'migrating']));
      expect((await readCurrentState(dirs.dataDir, V1)).active.version).toBe(V2);
      expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: V2 } });
      expect((await httpRequest(served.port, '/api/v1/auth/sessions')).status).toBe(401);
      expect(ctx.requestRestart).not.toHaveBeenCalled(); // its own promotion is no release change (rebased)
    },
    60_000,
  );

  it(
    "the target's own done → the first request once ready is served as usual, no MAINTENANCE left over from the look taken while the op held its flag",
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await databaseOfV1();
      const op = await updateOp({ state: 'switched' });
      const ctx = pendingContext(V2);
      await start(ctx as BootContext);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'done', error: null });
      // At once, well within the ops fence's 2 s since the look start() took while the op still held its `update` flag
      // (no request came meanwhile to look again): the flag the op's end lowered is down for requests too.
      const reply = await httpRequest((await ctx.served()).port, '/api/v1/auth/sessions');
      expect({ status: reply.status, body: reply.body.slice(0, 200) }).toMatchObject({ status: 401 });
    },
    60_000,
  );

  it('an op that ends reverting (health:0.2.0-test) → start() rejects with UPDATE_BOOT_FAILED (health), every handle closed', async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off');
    vi.stubEnv('ALTIS_TEST_FAULT', `health:${V2}`);
    await databaseOfV1({ all: true });
    await updateOp({ state: 'switched' });
    const ctx = pendingContext(V2);
    const error = await start(ctx as BootContext).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isDomainError(error) && error.code).toBe('UPDATE_BOOT_FAILED');
    expect(isDomainError(error) && error.meta?.['reason']).toBe('health');
    expect(await readOpJson(dirs.dataDir)).toMatchObject({ state: 'reverting', error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' } });
    expect(ctx.markHealthy).not.toHaveBeenCalled();
    expect(seen.connects).toBeGreaterThan(0);
    expect(await openHandles()).toBe(0); // 1D-06
    expect((await readCurrentState(dirs.dataDir, V1)).pending).toEqual({ version: V2, source: 'data' }); // app.js clears it
  });

  it('a database that fails to open with an error other than DB_UNAVAILABLE → start() rejects with UPDATE_BOOT_FAILED (start), nothing left open', async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off');
    await databaseOfV1({ all: true });
    const op = await updateOp({ state: 'switched' });
    seen.connectFails = new Error('connect: injected failure');
    const ctx = pendingContext(V2);
    const error = await start(ctx as BootContext).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isDomainError(error) && error.code).toBe('UPDATE_BOOT_FAILED');
    expect(isDomainError(error) && error.meta?.['reason']).toBe('start');
    expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'switched' });
    expect(ctx.markHealthy).not.toHaveBeenCalled();
    expect(await openHandles()).toBe(0);
  });

  it.each(['switched', 'migrating'])(
    'Review C08: an op in %s whose heartbeat is 16 min old (nothing stepped it before this boot) → the pending boot reaches done, never UPDATE_BOOT_FAILED',
    async (state) => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await databaseOfV1();
      // N wrote `pending` and asked for the restart, then no request came for 16 min (cPanel at night); or a holder
      // was killed in `migrating` and nothing restarted it for as long.
      const op = await updateOp({ state });
      const written = await readOpJson(dirs.dataDir);
      await writeOp(dirs.dataDir, { ...written, at: written.startedAt, heartbeatAt: Date.now() - 16 * 60_000 });
      const ctx = pendingContext(V2);
      await start(ctx as BootContext);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'done', error: null });
      expect(await migrationNames()).toContain(LAST_MIGRATION);
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
      expect(markHealthyStates).toEqual(['verifying']);
      expect((await readCurrentState(dirs.dataDir, V1)).active.version).toBe(V2);
      expect(await health(await ctx.served())).toEqual({ status: 200, body: { status: 'ok', version: V2 } });
    },
    60_000,
  );

  it('Review C08: a promoted target (booted as active) whose op went 16 min without a step in verifying ends it and boots, no resume needed', async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off');
    await databaseOfV1({ all: true });
    const op = await updateOp({ state: 'verifying' });
    // app.js promoted 0.2 (markHealthy), and the process died before the op recorded its end; nothing stepped the op
    // for 16 min (a Passenger pool without requests).
    await updateCurrentState(dirs.dataDir, (s) => ({ ...s, previous: s.active, active: { version: V2, source: 'data' }, pending: null, pendingSince: null }));
    const written = await readOpJson(dirs.dataDir);
    await writeOp(dirs.dataDir, { ...written, at: written.startedAt, heartbeatAt: Date.now() - 16 * 60_000 });
    const ctx = pendingContext(V2, { pending: false });
    await start(ctx as BootContext);
    expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'done', error: null });
    expect(await health(await ctx.served())).toEqual({ status: 200, body: { status: 'ok', version: V2 } });
  });

  it(
    'Review L07: a database refused with the config read at the boot (a stale password) → the boot waits, then picks up a corrected config.json without a restart',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await databaseOfV1({ all: true });
      const op = await updateOp({ state: 'switched' });
      // The host changed the database password past the point of no return; config.json still names the old one.
      const good = testDbConfig(engine);
      const configFile = dataPath(dirs.dataDir, 'root', 'config.json');
      const written = JSON.parse(await fsp.readFile(configFile, 'utf8')) as Parameters<typeof writeConfig>[1];
      await writeConfig(dirs.dataDir, { ...written, db: { ...good, password: 'stale-password' } });
      seen.refusePassword = 'stale-password';
      const ctx = pendingContext(V2);
      const started = start(ctx as BootContext);
      await vi.waitFor(() => expect(ctx.bootMarker.waiting).toHaveBeenCalledWith('db_unavailable'), { timeout: 15_000, interval: 50 });
      expect(seen.passwords).toContain('stale-password');

      // The admin puts the right password into config.json by hand (`config:set` is refused while `pending`).
      await writeConfig(dirs.dataDir, { ...written, db: good });
      await vi.waitFor(async () => expect((await readOpJson(dirs.dataDir)).state).toBe('done'), { timeout: 30_000, interval: 100 });
      await started;
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'done' });
      expect(seen.passwords.at(-1)).toBe(good.password);
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
    },
    60_000,
  );

  it.each([
    ['another op began meanwhile', 'backup'],
    ['op.json is gone', null],
  ] as const)(
    'Review L06: a promoted target (booted as active) whose op another process ended before its first step (%s) plans again and boots, never UPDATE_BOOT_FAILED',
    async (_case, kind) => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await databaseOfV1({ all: true });
      await updateOp({ state: 'verifying' });
      await updateCurrentState(dirs.dataDir, (s) => ({ ...s, previous: s.active, active: { version: V2, source: 'data' }, pending: null, pendingSince: null }));
      // Another process of the pool ended the op `done` (its flag lowered) after this one read op.json; then an admin's
      // backup began and ended, or op.json went (housekeeping), before this process's first step.
      seen.beforeStep = async () => {
        await writeFlag(dirs.dataDir, null);
        if (kind !== null) await writeOp(dirs.dataDir, { kind, state: 'done' });
        else for (const f of ['op.json', 'op.json.bak']) await fsp.rm(path.join(dirs.dataDir, 'ops', f), { force: true });
      };
      const ctx = pendingContext(V2, { pending: false });
      await start(ctx as BootContext); // a rejection would make app.js fall back to 0.1 for good
      expect(seen.steps).toBeGreaterThan(0);
      expect(await health(await ctx.served())).toEqual({ status: 200, body: { status: 'ok', version: V2 } });
      expect((await httpRequest((await ctx.served()).port, '/api/v1/auth/sessions')).status).toBe(401); // no MAINTENANCE left over
    },
    60_000,
  );

  it(
    'a promoted target (booted as active) whose op needs attention in verifying waits in phase updating for a resume, then ends the op and boots',
    async () => {
      // Worker mode (no ALTIS_RUNNER=off): the wait looks at the op every 2 s.
      await databaseOfV1({ all: true });
      const op = await updateOp({ state: 'verifying' });
      // app.js promoted 0.2 (markHealthy), and the process died before the op recorded its end; the op needs attention
      // (a step of it threw meanwhile, or an operator's look found it stuck).
      await updateCurrentState(dirs.dataDir, (s) => ({ ...s, previous: s.active, active: { version: V2, source: 'data' }, pending: null, pendingSince: null }));
      const written = await readOpJson(dirs.dataDir);
      await writeOp(dirs.dataDir, { ...written, at: written.startedAt, state: 'needs_attention', stateBefore: 'verifying', heartbeatAt: Date.now() });
      const ctx = pendingContext(V2, { pending: false });
      let outcome: unknown = 'pending';
      const started = start(ctx as BootContext).then(
        () => 'resolved',
        (e: unknown) => e,
      );
      void started.then((o) => {
        outcome = o;
      });
      const served = await ctx.served();
      await vi.waitFor(async () => expect((await readOpJson(dirs.dataDir)).state).toBe('needs_attention'), { timeout: 15_000, interval: 50 });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(outcome).toBe('pending'); // no rejection: app.js would fall back to 0.1, which cannot end the op
      expect(await health(served)).toEqual({ status: 503, body: { status: 'maintenance', version: V2 } });

      // An operator's resume (ops/resume): the op back in the state it left, its heartbeat fresh.
      const stuck = await readOpJson(dirs.dataDir);
      const { stateBefore, ...rest } = stuck;
      expect(stateBefore).toBe('verifying');
      await writeOp(dirs.dataDir, { ...rest, state: 'verifying', at: stuck.startedAt, heartbeatAt: Date.now() });
      expect(await started).toBe('resolved');
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'done' });
      expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: V2 } });
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1); // the normal boot's (its own op never promoted anything)
    },
    60_000,
  );

  it('B8: the target with its op already reverting → rejects at once, without opening the database or stepping', async () => {
    await databaseOfV1({ all: true });
    await updateOp({ state: 'reverting', stateBefore: 'migrating', error: { code: 'UPDATE_BOOT_FAILED', detail: 'migration' } });
    const ctx = pendingContext(V2);
    const error = await start(ctx as BootContext).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isDomainError(error) && error.code).toBe('UPDATE_BOOT_FAILED');
    expect(isDomainError(error) && error.meta?.['reason']).toBe('migration');
    expect(seen.connects).toBe(0);
    expect(seen.steps).toBe(0);
    expect((await readOpJson(dirs.dataDir)).state).toBe('reverting');
    // Not as a pending boot either (a target booting as active): refused.
    const again = await start(pendingContext(V2, { pending: false }) as BootContext).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isDomainError(again) && again.code).toBe('UPDATE_BOOT_FAILED');
    expect(seen.connects).toBe(0);
  });

  it('a pending boot whose plan is not update_boot (no op at all) refuses (1D-02)', async () => {
    await databaseOfV1({ all: true });
    await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
    const error = await start(pendingContext(V2) as BootContext).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isDomainError(error) && error.code).toBe('UPDATE_BOOT_FAILED');
    expect(isDomainError(error) && error.meta?.['reason']).toBe('start');
    expect(seen.connects).toBe(0);
  });

  it(
    '1D-02: system roles throwing in verifying → needs_attention → start() rejects; then 0.1, after app.js recorded the op reverting, reaches rolled_back',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await databaseOfV1({ all: true });
      const op = await updateOp({ state: 'switched' });
      seen.rolesThrow = true;
      const error = await start(pendingContext(V2) as BootContext).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isDomainError(error) && error.code).toBe('UPDATE_BOOT_FAILED');
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'needs_attention', stateBefore: 'verifying' });
      expect(await openHandles()).toBe(0);
      seen.rolesThrow = false;

      // app.js (op-record.ts recordPendingFailure): the op judged by its stateBefore moves to `reverting`, then
      // pending = null, then the active release in this process.
      const stuck = await readOpJson(dirs.dataDir);
      await writeOp(dirs.dataDir, {
        ...stuck,
        state: 'reverting',
        stateBefore: 'verifying',
        error: { code: 'UPDATE_BOOT_FAILED', detail: 'start' },
        at: stuck.startedAt,
        heartbeatAt: Date.now(),
      });
      await updateCurrentState(dirs.dataDir, (s) => ({ ...s, pending: null, pendingSince: null }));
      const ctx = pendingContext(V1, { pending: false });
      await start(ctx as BootContext);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'rolled_back', error: { detail: 'start' } });
      const served = await ctx.served();
      expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: V1 } });
    },
    60_000,
  );

  it(
    '1D-02: a loop facing an unchanged op calls ops.step at most 11 times in 10 s (no spin)',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await databaseOfV1({ all: true });
      const op = await updateOp({ state: 'switched' });
      // Another process holds ops/step.lock for 10 s: every step answers the op as it was.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await fsp.mkdir(path.join(dirs.dataDir, 'ops'), { recursive: true });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = withFileLock(dataPath(dirs.dataDir, 'ops', 'step.lock'), async () => {
        locked();
        await held;
      });
      await isLocked;
      const started = start(pendingContext(V2) as BootContext);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      expect(seen.steps).toBeGreaterThan(0);
      expect(seen.steps).toBeLessThanOrEqual(11);
      expect((await readOpJson(dirs.dataDir)).state).toBe('switched');
      release();
      await holder;
      await started;
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'done' });
    },
    60_000,
  );

  it(
    'Review Focus 1: a holder killed while it migrates → the next start() resumes the op from migrating and reaches done',
    async () => {
      await databaseOfV1();
      const op = await updateOp({ state: 'switched' });
      const appRoot = path.join(dirs.root, 'app');
      const child = fork(path.join(import.meta.dirname, '../fixtures/update-boot-child.mjs'), [JSON.stringify({ dataDir: dirs.dataDir, appRoot, version: V2 })], {
        cwd: path.resolve(import.meta.dirname, '../../../..'),
        env: { ...process.env, ALTIS_RUNNER: 'off', ALTIS_TEST_FAULT: 'migrate-slow:8' },
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      const messages: unknown[] = [];
      child.on('message', (m) => messages.push(m));
      await vi.waitFor(async () => expect((await readOpJson(dirs.dataDir)).state).toBe('migrating'), { timeout: 20_000, interval: 50 });
      await new Promise((resolve) => setTimeout(resolve, 1000)); // inside the slow migration
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      expect(await migrationNames()).not.toContain(LAST_MIGRATION);
      expect(messages).toContainEqual({ phase: 'migrating' });
      expect(messages).not.toContainEqual({ started: true });

      // The next holder of boot.lock boots the same pending release (the slow migration's 8 s count from the child's
      // first run: what is left of them is waited here).
      vi.stubEnv('ALTIS_TEST_FAULT', 'migrate-slow:8');
      const ctx = pendingContext(V2);
      await start(ctx as BootContext);
      const after = await readOpJson(dirs.dataDir);
      expect(after).toMatchObject({ opId: op.opId, state: 'done', error: null });
      expect(await migrationNames()).toContain(LAST_MIGRATION);
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
      expect((await readCurrentState(dirs.dataDir, V1)).active.version).toBe(V2);
    },
    90_000,
  );

  it('boot-crash:0.2.0-test kills a pending boot of 0.2.0-test right after phase(listening); not 0.1.0-test, nor a boot that is not pending', async () => {
    vi.stubEnv('ALTIS_TEST_FAULT', `boot-crash:${V2}`);
    await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
    const order: string[] = [];
    const { killSelf } = await import('@altis/platform');
    vi.mocked(killSelf).mockImplementation(() => {
      order.push('kill');
      seen.kills += 1;
      return undefined as never;
    });
    const ctx = pendingContext(V2);
    ctx.bootMarker.phase.mockImplementation((p) => order.push(`phase:${p}`));
    await start(ctx as BootContext).catch(() => undefined); // no op: the pending boot then refuses
    expect(order.slice(0, 2)).toEqual(['phase:listening', 'kill']);
    expect(seen.kills).toBe(1);

    await start(pendingContext(V1) as BootContext).catch(() => undefined);
    expect(seen.kills).toBe(1);
    await databaseOfV1({ all: true });
    const notPending = pendingContext(V2, { pending: false });
    await start(notPending as BootContext);
    expect(seen.kills).toBe(1);
  });
});
