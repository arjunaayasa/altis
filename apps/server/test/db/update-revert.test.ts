import fsp from 'node:fs/promises';
import path from 'node:path';
import { createExporter, randomToken, readManifest, type ExportCheckpoint, type OpFile } from '@altis/core';
import { PHASE1_MIGRATIONS, type DbHandle } from '@altis/db';
import { readCurrentState, updateCurrentState } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { writeConfig, type Config } from '../../src/config.js';
import { csrfKey } from '../../src/http/csrf.js';
import { start, type BootContext } from '../../src/index.js';
import { flagOf, readOpJson, writeFlag, writeOp } from '../ops-support.js';
import { bootContext, closeTestServers, httpRequest, sampleConfig, useDataDir, type ServedServer, type TestBootContext } from '../support.js';

// start() of the release an update left behind, while the update reverts (plan Task 25; spec §9.7; decisions D1d-21,
// D1d-42; preflight S2, 1D-02, 1D-06) on the engine picked by ALTIS_TEST_DB: the `revert` plan steps `reverting` in
// phase `updating`, then boots as usual after `rolled_back`; `restore_failed` and a revert step that needs attention keep
// the phase and maintenance (no spin). On SQLite (1D-06): after the target's start() rejected, the revert of the release
// left behind, in the same process, restores the `pre_update` backup through the SQLite swap, whose file rename needs
// every handle of the rejected start() closed.

const seen = vi.hoisted(() => ({ handles: [] as unknown[], steps: 0 }));
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  return {
    ...actual,
    connect: vi.fn(async (...args: Parameters<typeof actual.connect>) => {
      const handle = await actual.connect(...args);
      seen.handles.push(handle);
      return handle;
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
        step: (budgetMs: number) => {
          seen.steps += 1;
          return machine.step(budgetMs);
        },
      };
    },
  };
});
const actualDb = await vi.importActual<typeof import('@altis/db')>('@altis/db');

const engine = testDbContext();
const dirs = useDataDir();
const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const V3 = '0.3.0-test';

beforeEach(async () => {
  if (engine.available) await (await testDb()).close(); // an empty database
  seen.handles.length = 0;
  seen.steps = 0;
});

afterEach(async () => {
  await closeTestServers();
  await Promise.all(seen.handles.map((h) => (h as DbHandle).close()));
  vi.unstubAllEnvs();
});

function ownHandle(): Promise<DbHandle> {
  return actualDb.connect(testDbConfig(engine), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
}

async function withOwn<T>(fn: (h: DbHandle) => Promise<T>): Promise<T> {
  const h = await ownHandle();
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

/** config.json and the database of an installation at every Phase 1 migration (`schema_meta.install_id` its own). */
async function installation(): Promise<Config> {
  const config = sampleConfig({ db: testDbConfig(engine) });
  await writeConfig(dirs.dataDir, config);
  await withOwn(async (h) => {
    await actualDb.runMigrations(h, { appVersion: V1, dataDir: dirs.dataDir, migrations: PHASE1_MIGRATIONS });
    await h.db.updateTable('schema_meta').set({ install_id: config.install.id }).where('id', '=', 1).execute();
  });
  return config;
}

/** An update op of `from` → `target` past its point of no return, in `state`, its flag up; `pending` as told. */
async function updateOp(o: {
  state: string;
  from: string;
  target: string;
  backupId?: string | null;
  error?: OpFile['error'];
  stateBefore?: string;
  pending: boolean;
  params?: Record<string, unknown>;
  /** The op's `altis_ops` token (a new one by default). */
  token?: string;
}): Promise<OpFile> {
  const at = Date.now();
  const { op } = await writeOp(dirs.dataDir, {
    ...(o.token === undefined ? {} : { token: o.token }),
    kind: 'update',
    state: o.state,
    version: o.from,
    pointOfNoReturn: true,
    backupId: o.backupId ?? null,
    error: o.error ?? null,
    ...(o.stateBefore === undefined ? {} : { stateBefore: o.stateBefore }),
    params: {
      source: 'feed',
      target: o.target,
      from: o.from,
      entry: null,
      staging: null,
      needsBackup: o.backupId !== undefined && o.backupId !== null,
      pendingWritten: true,
      frozenAt: at - 30_000,
      ...o.params,
    },
    progress: 95,
  });
  await writeFlag(dirs.dataDir, flagOf('update', op.opId, at - 30_000));
  await readCurrentState(dirs.dataDir, o.from);
  if (o.pending) await updateCurrentState(dirs.dataDir, (s) => ({ ...s, pending: { version: o.target, source: 'data' }, pendingSince: at - 10_000 }));
  return op;
}

function context(version: string, o: { pending?: boolean } = {}): TestBootContext & { pendingBoot?: boolean } {
  const ctx = bootContext(dirs.dataDir, { version }) as TestBootContext & { pendingBoot?: boolean };
  if (o.pending === true) {
    ctx.pendingBoot = true;
    (ctx.bootMarker as unknown as { waiting: () => void }).waiting = vi.fn();
  }
  return ctx;
}

async function health(served: ServedServer): Promise<{ status: number; body: unknown }> {
  const reply = await httpRequest(served.port, '/_health');
  return { status: reply.status, body: JSON.parse(reply.body) as unknown };
}

/** How many of the handles connect() gave out still answer (a closed one refuses every query). */
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

async function minCodeVersion(): Promise<string> {
  return withOwn(async (h) => (await h.db.selectFrom('schema_meta').select('min_code_version').executeTakeFirstOrThrow()).min_code_version);
}

describe.skipIf(!engine.available)(`start(ctx) while an update reverts [${engineLabel()}]`, () => {
  it(
    "0.1's start() with the op in reverting → rolled_back (pending cleared, phase updating meanwhile) → ready",
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await installation();
      const op = await updateOp({
        state: 'reverting',
        stateBefore: 'migrating',
        from: V1,
        target: V2,
        error: { code: 'UPDATE_BOOT_FAILED', detail: 'start' },
        pending: true, // app.js died between its op record and its own pending = null
      });
      const ctx = context(V1);
      await start(ctx);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'rolled_back', error: { detail: 'start' } });
      expect(await readCurrentState(dirs.dataDir, V1)).toMatchObject({ active: { version: V1 }, pending: null });
      const served = await ctx.served();
      expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: V1 } });
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
      expect(ctx.requestRestart).not.toHaveBeenCalled(); // its own revert is no release change
      const rows = await withOwn((h) => h.db.selectFrom('releases_log').select(['id', 'status']).execute());
      expect(rows).toEqual([{ id: op.opId, status: 'rolled_back' }]);
    },
    60_000,
  );

  it(
    'A7: rolled_back by this start() → the first request once ready is served as usual, no MAINTENANCE left over from the look taken while the op reverted',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await installation();
      const op = await updateOp({
        state: 'reverting',
        stateBefore: 'verifying',
        from: V1,
        target: V2,
        error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' },
        pending: false, // app.js recorded the failure and cleared `pending` before it started 0.1 (the A7 path)
      });
      const ctx = context(V1);
      await start(ctx);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'rolled_back' });
      // At once, well within the ops fence's 2 s since the look start() took while the op still held its `update` flag:
      // the flag the revert lowered is down for requests too, so a `deny` route answers as it does out of maintenance
      // (401 without a session), never 503 MAINTENANCE, which the admin SPA follows to /admin/_update.
      const reply = await httpRequest((await ctx.served()).port, '/api/v1/auth/sessions');
      expect({ status: reply.status, body: reply.body.slice(0, 200) }).toMatchObject({ status: 401 });
    },
    60_000,
  );

  it(
    'restore_failed (a database too new, no pre_update backup) → start() resolves in phase updating, maintenance kept',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await installation();
      await withOwn((h) => h.db.updateTable('schema_meta').set({ min_code_version: V3 }).execute());
      const op = await updateOp({ state: 'reverting', stateBefore: 'verifying', from: V2, target: V3, error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' }, pending: false });
      const ctx = context(V2);
      await start(ctx);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'restore_failed', error: { code: 'SCHEMA_TOO_NEW' } });
      const served = await ctx.served();
      expect(await health(served)).toEqual({ status: 503, body: { status: 'maintenance', version: V2 } });
      const deny = await httpRequest(served.port, '/api/v1/auth/sessions');
      expect(deny.status).toBe(503);
      expect(JSON.parse(deny.body)).toMatchObject({ code: 'MAINTENANCE', reason: 'update' });
      expect(ctx.markHealthy).not.toHaveBeenCalled();
    },
    60_000,
  );

  it(
    'Review C17: after restore_failed, a restart of the same release boots into phase updating again (no runMigrations, not too_old): /admin/_update keeps the CLI steps',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await installation();
      await withOwn((h) => h.db.updateTable('schema_meta').set({ min_code_version: V3 }).execute());
      const token = randomToken();
      const op = await updateOp({
        state: 'reverting',
        stateBefore: 'verifying',
        from: V2,
        target: V3,
        error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' },
        pending: false,
        token,
      });
      await start(context(V2));
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'restore_failed' });
      await closeTestServers(); // the process dies (a Passenger idle kill), the flag stays

      const ctx = context(V2);
      await start(ctx);
      const served = await ctx.served();
      expect(await health(served)).toEqual({ status: 503, body: { status: 'maintenance', version: V2 } });
      const cookie = { cookie: `__Host-altis_ops=${token}`, accept: 'text/html' };
      const page = await httpRequest(served.port, '/admin/_update', 'GET', cookie);
      expect(page.status).toBe(200);
      expect(page.body).toContain('backup:restore');
      expect(page.body).toContain('release:rollback');
      const current = await httpRequest(served.port, '/api/v1/ops/current', 'GET', { cookie: `__Host-altis_ops=${token}` });
      expect(current.status).toBe(200);
      expect(JSON.parse(current.body)).toMatchObject({ opId: op.opId, kind: 'update', state: 'restore_failed' });
      const deny = await httpRequest(served.port, '/api/v1/auth/sessions');
      expect(JSON.parse(deny.body)).toMatchObject({ code: 'MAINTENANCE', reason: 'update' });
      expect(ctx.markHealthy).not.toHaveBeenCalled();
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'restore_failed' });

      // `maintenance:off --force` lowered the flag: the next restart boots as usual (and finds the database too new).
      await closeTestServers();
      await writeFlag(dirs.dataDir, null);
      const after = context(V2);
      await start(after);
      expect(await health(await after.served())).toEqual({ status: 503, body: { status: 'schema_too_new', version: V2 } });
    },
    60_000,
  );

  it(
    'a revert step that throws → needs_attention: no more steps (no spin), phase updating, start() still pending',
    async () => {
      vi.stubEnv('ALTIS_RUNNER', 'off');
      await installation();
      // `restoring` without its run: the step throws past the point of no return (the machine: needs_attention).
      const op = await updateOp({ state: 'restoring', from: V1, target: V2, error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' }, pending: false });
      const ctx = context(V1);
      let settled = false;
      void start(ctx).finally(() => {
        settled = true;
      });
      const served = await ctx.served();
      await vi.waitFor(async () => expect((await readOpJson(dirs.dataDir)).state).toBe('needs_attention'), { timeout: 15_000, interval: 50 });
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, stateBefore: 'restoring' });
      const steps = seen.steps;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(seen.steps).toBe(steps);
      expect(settled).toBe(false);
      expect(await health(served)).toEqual({ status: 503, body: { status: 'maintenance', version: V1 } });
    },
    60_000,
  );

  describe.skipIf(engine.engine !== 'sqlite')('1D-06 on SQLite', () => {
    it(
      "after the target's start() rejected, the in-process revert restores through the SQLite swap (the file rename done): no handle of the rejected start() left",
      async () => {
        vi.stubEnv('ALTIS_RUNNER', 'off');
        const config = await installation();
        // The pre_update backup 0.2 made before the update (DB only, frozen), this installation's own (secrets branch a).
        const backupId = newId();
        await withOwn(async (h) => {
          const head = await h.db.selectFrom('audit_head').select(['last_seq', 'last_hash']).where('id', '=', 1).executeTakeFirst();
          const now = Date.now();
          const exporter = createExporter({
            read: h.db,
            dialect: h.dialect,
            dataDir: dirs.dataDir,
            backupId,
            kind: 'pre_update',
            includeFiles: false,
            consistency: 'frozen',
            appVersion: V2,
            schemaVersion: Object.keys(PHASE1_MIGRATIONS).at(-1)!,
            installId: config.install.id,
            sessionKey: csrfKey(config),
            kids: config.keyring.map((k) => k.kid),
            auditHead: head === undefined ? { seq: 0, hash: '0'.repeat(64) } : { seq: Number(head.last_seq), hash: head.last_hash },
            clock: () => now,
          });
          let cp: ExportCheckpoint | null = null;
          for (;;) {
            const r = await exporter.step(cp, { deadline: Date.now() + 60_000 });
            cp = r.checkpoint;
            if (r.done) break;
          }
          expect(await readManifest(dirs.dataDir, backupId)).not.toBeNull();
          await h.db
            .insertInto('backups')
            .values({
              id: backupId,
              kind: 'pre_update',
              size: 1,
              sha256: null,
              schema_version: Object.keys(PHASE1_MIGRATIONS).at(-1)!,
              app_version: V2,
              dialect: h.dialect,
              consistency: 'frozen',
              status: 'ok',
              created_at: now,
            })
            .execute();
          // 0.3's contract raised min_code_version before it failed: 0.2 is "terlalu lama" for the database now.
          await h.db.updateTable('schema_meta').set({ min_code_version: V3 }).execute();
        });
        const op = await updateOp({ state: 'switched', from: V2, target: V3, backupId, pending: true });

        // 0.3, the pending release, fails its health check: its start() rejects.
        vi.stubEnv('ALTIS_TEST_FAULT', `health:${V3}`);
        const target = context(V3, { pending: true });
        const error = await start(target as BootContext).then(
          () => null,
          (e: unknown) => e,
        );
        expect(isDomainError(error) && error.code).toBe('UPDATE_BOOT_FAILED');
        expect(await readOpJson(dirs.dataDir)).toMatchObject({ state: 'reverting', error: { detail: 'health' } });
        expect(seen.handles.length).toBeGreaterThan(0);
        expect(await openHandles()).toBe(0);
        expect(await actualDb.readSqliteOwner(dirs.dataDir)).toBeNull();
        vi.unstubAllEnvs();
        vi.stubEnv('ALTIS_RUNNER', 'off');

        // app.js: the op is recorded already (`already`), pending = null, then 0.2 (`active`) in this same process.
        await updateCurrentState(dirs.dataDir, (s) => ({ ...s, pending: null, pendingSince: null }));
        const left = context(V2);
        await start(left as BootContext);
        expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'restored', backupId });
        // The swap's renames happened: the live file before the restore kept beside the op.
        await expect(fsp.stat(path.join(dirs.dataDir, 'db', op.opId, 'pre-restore.sqlite'))).resolves.toBeTruthy();
        expect(await minCodeVersion()).toBe('0.0.0');
        expect(left.requestRestart).toHaveBeenCalledWith('restore');
        const served = await left.served();
        expect((await health(served)).body).toEqual({ status: 'maintenance', version: V2 }); // the restart replaces it
      },
      180_000,
    );
  });
});
