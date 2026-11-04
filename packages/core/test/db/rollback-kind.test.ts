import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, connect, runMigrations } from '@altis/db';
import { acquireFileLock, dataPath, readCurrentState, updateCurrentState, withFileLock, type CurrentState } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { notify } from '../../src/notifications/service.js';
import { readMaintenance, readOpFile, stepLockPath, writeOpFile, type OpActor, type OpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpStatus, type OpsMachine } from '../../src/ops/machine.js';
import { insertReleaseLog, setReleaseLogStatus } from '../../src/updates/releases-log.js';
import { beginRollback, revertPending, rollbackAvailability, rollbackKind, type RollbackKindDeps } from '../../src/updates/rollback.js';

// The manual rollback (spec §9.7 "Manual (tombol/`release:rollback`)": `active = previous`, `previous = null`,
// `pinned = <the version left>`; plan Task 26; decision D1d-33; preflight 1D-02, 1D-03, 1D-22) and the CLI's revert of
// a pending release (`revertPending`, app.js's revert from the command line), on the engine picked by ALTIS_TEST_DB.
// Releases are folders with `.complete` (DATA_DIR/releases/<v> or <appRoot>/bundled-release/<v>); schema-meta.json is
// written by hand.

const ctx = testDbContext();
const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const V3 = '0.3.0-test';
const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: Buffer.alloc(32, 7).toString('base64url'), active: true }];
const CLI: OpActor = { type: 'cli', id: null };
const silent = { info() {}, warn() {}, error() {} };

const exists = (file: string): Promise<boolean> =>
  fsp.lstat(file).then(
    () => true,
    () => false,
  );

describe.skipIf(!ctx.available)(`rollback op kind and revertPending [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let appRoot: string;
  let ops: OpsMachine;
  let restarts: string[];

  const deps = (): RollbackKindDeps => ({
    dataDir,
    appRoot,
    requestRestart: async (reason) => {
      restarts.push(reason);
    },
    notify,
  });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-rollback-')));
    await runMigrations(h, { appVersion: V1, dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['events', 'notifications', 'releases_log'] as const) await h.db.deleteFrom(table).execute();
    const base = await fsp.mkdtemp(path.join(root, 'case-'));
    dataDir = path.join(base, 'data');
    appRoot = path.join(base, 'app');
    await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
    await fsp.mkdir(appRoot, { recursive: true });
    restarts = [];
    ops = createOpsMachine({
      dataDir,
      kinds: [rollbackKind(deps)],
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => KEYRING,
      clock: () => Date.now(),
      log: silent,
      snapshotBackupRunning: async () => false,
      appVersion: V2,
    });
  });

  afterEach(async () => {
    await ops.close();
  });

  /** current.json as given (created first with `active` bundled, then replaced). */
  async function setState(s: Omit<CurrentState, 'schema' | 'pendingSince'> & { pendingSince?: number | null }): Promise<CurrentState> {
    await readCurrentState(dataDir, s.active.version);
    const next: CurrentState = { schema: 1, pendingSince: s.pending === null ? null : (s.pendingSince ?? Date.now()), ...s };
    await updateCurrentState(dataDir, () => next);
    return next;
  }

  const currentText = (): Promise<string> => fsp.readFile(path.join(dataDir, 'releases', 'current.json'), 'utf8');
  const current = async (): Promise<CurrentState> => JSON.parse(await currentText()) as CurrentState;

  /** A release folder with `.complete` (or without, `complete: false`). */
  async function release(version: string, source: 'data' | 'bundled', o: { complete?: boolean } = {}): Promise<void> {
    const dir = source === 'data' ? path.join(dataDir, 'releases', version) : path.join(appRoot, 'bundled-release', version);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'server.mjs'), `// ${version}\n`);
    if (o.complete !== false) await fsp.writeFile(path.join(dir, '.complete'), '');
  }

  async function mirror(minCodeVersion: string): Promise<void> {
    await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'releases', 'schema-meta.json'), JSON.stringify({ schemaVersion: '0009', minCodeVersion }));
  }

  /** Steps the op until it ends. */
  async function drive(): Promise<OpStatus> {
    for (let i = 0; i < 20; i += 1) {
      const status = await ops.step(20_000);
      if (status === null) throw new Error('no op');
      if (status.terminal || status.needsAttention) return status;
    }
    throw new Error('the op did not end');
  }

  const opJson = async (): Promise<OpFile> => {
    const op = await readOpFile(dataDir);
    if (op === null || op === 'corrupt') throw new Error('op.json');
    return op;
  };
  const opText = (): Promise<string> => fsp.readFile(path.join(dataDir, 'ops', 'op.json'), 'utf8');
  const rollbacks = async (opId: string) =>
    (await h.db.selectFrom('audit_log').select(['meta', 'actor_type']).where('action', '=', 'update.rollback').where('entity_id', '=', opId).execute()).map((r) => ({
      actor: r.actor_type,
      meta: JSON.parse(r.meta) as Record<string, unknown>,
    }));
  const notifications = () => h.db.selectFrom('notifications').select(['type', 'audience_permission', 'params', 'link']).execute();
  const logRow = (id: string) => h.db.selectFrom('releases_log').selectAll().where('id', '=', id).executeTakeFirst();

  /** An op.json written by hand (a fixture of a process that died). */
  function opFixture(o: Partial<OpFile> & Pick<OpFile, 'kind' | 'state' | 'params'>): OpFile {
    const now = Date.now();
    return {
      opSchema: 1,
      opId: newId(now),
      actor: CLI,
      version: V2,
      backupId: null,
      heartbeatAt: now,
      startedAt: now - 1000,
      finishedAt: null,
      error: null,
      opsTokenHash: null,
      pointOfNoReturn: false,
      progress: 0,
      message: null,
      ...o,
    };
  }

  describe('rollbackAvailability', () => {
    it('no previous → no_previous; previous without .complete → missing; pending → pending; else available', async () => {
      await mirror('0.0.0');
      let s = await setState({ active: { version: V2, source: 'data' }, previous: null, pending: null, pinned: null });
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: false, reason: 'no_previous', target: null });

      s = await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'data' }, pending: null, pinned: null });
      await release(V1, 'data', { complete: false });
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: false, reason: 'missing', target: V1 });
      await fsp.writeFile(path.join(dataDir, 'releases', V1, '.complete'), '');
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: true, reason: null, target: V1 });

      // A bundled previous lives beside app.js.
      s = await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'bundled' }, pending: null, pinned: null });
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: false, reason: 'missing', target: V1 });
      await release(V1, 'bundled');
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: true, reason: null, target: V1 });
      expect(await rollbackAvailability(dataDir, s, '')).toEqual({ available: false, reason: 'missing', target: V1 });

      s = await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'bundled' }, pending: { version: V3, source: 'data' }, pinned: null });
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: false, reason: 'pending', target: V1 });
    });

    it("schema-meta minCodeVersion above previous → incompatible; equal or no mirror → available", async () => {
      await release(V2, 'data');
      const s = await setState({ active: { version: V3, source: 'data' }, previous: { version: V2, source: 'data' }, pending: null, pinned: null });
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: true, reason: null, target: V2 }); // no mirror yet
      await mirror(V3);
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: false, reason: 'incompatible', target: V2 });
      await mirror(V2);
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: true, reason: null, target: V2 });
      // An unreadable mirror (and no .bak) is not a compatible one.
      await fsp.writeFile(path.join(dataDir, 'releases', 'schema-meta.json'), '{not json');
      expect(await rollbackAvailability(dataDir, s, appRoot)).toEqual({ available: false, reason: 'incompatible', target: V2 });
    });
  });

  describe('the rollback kind', () => {
    it('active 0.2, previous 0.1, minCodeVersion 0.0.0 → done: pointers flipped and pinned, releases_log done, one update.rollback, restart', async () => {
      await mirror('0.0.0');
      await release(V2, 'data');
      await release(V1, 'bundled');
      await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'bundled' }, pending: null, pinned: null });

      const begun = await beginRollback(ops, { dataDir, appRoot, actor: CLI });
      expect(begun).toMatchObject({ target: V1, from: V2 });
      const first = await opJson();
      expect(first).toMatchObject({ kind: 'rollback', state: 'running', params: { target: V1, from: V2 } });
      expect(await readMaintenance(dataDir)).toBeNull(); // a rollback never raises maintenance

      const status = await drive();
      expect(status).toMatchObject({ kind: 'rollback', state: 'done', error: null });
      expect(await readMaintenance(dataDir)).toBeNull();
      expect(await current()).toEqual({
        schema: 1,
        active: { version: V1, source: 'bundled' },
        previous: null,
        pending: null,
        pendingSince: null,
        pinned: V2,
      });
      expect(await logRow(begun.opId)).toMatchObject({ action: 'rollback', version: V1, from_version: V2, status: 'done', backup_id: null });
      expect(await rollbacks(begun.opId)).toEqual([{ actor: 'cli', meta: { from: V2, to: V1 } }]);
      const sent = await notifications();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'update.rolled_back', audience_permission: 'system.update.run', link: '/admin/updates' });
      expect(JSON.parse(sent[0]!.params)).toEqual({ version: V2 });
      expect(restarts).toEqual(['rollback']);
    });

    it('minCodeVersion 0.3.0-test with previous 0.2 → failed ROLLBACK_UNAVAILABLE incompatible, current.json unchanged', async () => {
      await mirror(V3);
      await release(V2, 'data');
      await release(V3, 'data');
      await setState({ active: { version: V3, source: 'data' }, previous: { version: V2, source: 'data' }, pending: null, pinned: null });
      const before = await currentText();

      // The caller's check refuses it before anything begins...
      const refused = await beginRollback(ops, { dataDir, appRoot, actor: CLI }).catch((e: unknown) => e);
      expect(isDomainError(refused) && refused.code).toBe('ROLLBACK_UNAVAILABLE');
      expect(isDomainError(refused) && refused.meta?.['reason']).toBe('incompatible');
      expect(await readOpFile(dataDir)).toBeNull();

      // ...and the kind refuses an op begun anyway (another process, an older check).
      const { opId } = await ops.begin('rollback', CLI, { target: V2, from: V3 });
      const status = await drive();
      expect(status.state).toBe('failed');
      expect(status.error).toMatchObject({ code: 'ROLLBACK_UNAVAILABLE', reason: 'incompatible' });
      expect(await currentText()).toBe(before);
      expect(await rollbacks(opId)).toEqual([]);
      expect(await notifications()).toEqual([]);
      expect(restarts).toEqual([]);
    });

    it('no previous → failed no_previous; a previous folder without .complete → failed missing', async () => {
      await mirror('0.0.0');
      await setState({ active: { version: V2, source: 'data' }, previous: null, pending: null, pinned: null });
      await ops.begin('rollback', CLI, { target: V1, from: V2 });
      expect((await drive()).error).toMatchObject({ code: 'ROLLBACK_UNAVAILABLE', reason: 'no_previous' });

      await release(V1, 'data', { complete: false });
      await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'data' }, pending: null, pinned: null });
      const before = await currentText();
      const { opId } = await ops.begin('rollback', CLI, { target: V1, from: V2 });
      const status = await drive();
      expect(status).toMatchObject({ state: 'failed', error: { code: 'ROLLBACK_UNAVAILABLE', reason: 'missing' } });
      expect(await currentText()).toBe(before);
      expect(await rollbacks(opId)).toEqual([]);
    });

    it("the database's min_code_version counts too (a mirror that lags)", async () => {
      await mirror('0.0.0');
      await release(V1, 'data');
      await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'data' }, pending: null, pinned: null });
      const before = await currentText();
      const row = await h.db.selectFrom('schema_meta').select('min_code_version').where('id', '=', 1).executeTakeFirstOrThrow();
      await h.db.updateTable('schema_meta').set({ min_code_version: V2 }).where('id', '=', 1).execute();
      try {
        const { opId } = await ops.begin('rollback', CLI, { target: V1, from: V2 });
        const status = await drive();
        expect(status).toMatchObject({ state: 'failed', error: { code: 'ROLLBACK_UNAVAILABLE', reason: 'incompatible' } });
        expect(await currentText()).toBe(before);
        expect(await logRow(opId)).toBeUndefined();
      } finally {
        await h.db.updateTable('schema_meta').set({ min_code_version: row.min_code_version }).where('id', '=', 1).execute();
      }
    });

    it('1D-22: current.json already flipped, the op running with flipping → done with exactly one update.rollback and one notification', async () => {
      await mirror('0.0.0');
      await setState({ active: { version: V1, source: 'bundled' }, previous: null, pending: null, pinned: V2 });
      const op = opFixture({ kind: 'rollback', state: 'running', params: { target: V1, from: V2, flipping: true } });
      await writeOpFile(dataDir, op);
      await insertReleaseLog(h.db, { id: op.opId, version: V1, action: 'rollback', fromVersion: V2, startedAt: op.startedAt, backupId: null });

      const status = await drive();
      expect(status).toMatchObject({ opId: op.opId, state: 'done' });
      expect(await rollbacks(op.opId)).toEqual([{ actor: 'cli', meta: { from: V2, to: V1 } }]);
      expect(await notifications()).toHaveLength(1);
      expect(await logRow(op.opId)).toMatchObject({ status: 'done' });
      expect((await current()).active).toEqual({ version: V1, source: 'bundled' });
    });

    it('1D-22: the end already recorded (releases_log done) → done, no second audit entry or notification', async () => {
      await mirror('0.0.0');
      await setState({ active: { version: V1, source: 'bundled' }, previous: null, pending: null, pinned: V2 });
      const op = opFixture({ kind: 'rollback', state: 'running', params: { target: V1, from: V2, flipping: true } });
      await writeOpFile(dataDir, op);
      await insertReleaseLog(h.db, { id: op.opId, version: V1, action: 'rollback', fromVersion: V2, startedAt: op.startedAt, backupId: null });
      await setReleaseLogStatus(h.db, op.opId, 'done', { finishedAt: Date.now() });

      expect((await drive()).state).toBe('done');
      expect(await rollbacks(op.opId)).toEqual([]);
      expect(await notifications()).toEqual([]);
    });

    it('killed after the checkpoint, before the flip → the next step flips the pointers and ends done once', async () => {
      await mirror('0.0.0');
      await release(V1, 'data');
      await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'data' }, pending: null, pinned: null });
      const op = opFixture({ kind: 'rollback', state: 'running', params: { target: V1, from: V2, flipping: true, future: 1 } });
      await writeOpFile(dataDir, op);
      await insertReleaseLog(h.db, { id: op.opId, version: V1, action: 'rollback', fromVersion: V2, startedAt: op.startedAt, backupId: null });

      expect((await drive()).state).toBe('done');
      expect(await current()).toMatchObject({ active: { version: V1, source: 'data' }, previous: null, pinned: V2 });
      expect(await rollbacks(op.opId)).toHaveLength(1);
      expect(await notifications()).toHaveLength(1);
      expect((await opJson()).params).toMatchObject({ future: 1 }); // a later release's field is kept
    });

    it('the checkpoint is the point of no return: a failure after it needs attention, and resume finishes the rollback once', async () => {
      await mirror('0.0.0');
      await release(V1, 'data');
      await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'data' }, pending: null, pinned: null });
      const { opId } = await beginRollback(ops, { dataDir, appRoot, actor: CLI });
      // A step that checkpoints, then finds current.json unusable (main file and .bak): it cannot go back any more.
      const file = path.join(dataDir, 'releases', 'current.json');
      const good = await fsp.readFile(file, 'utf8');
      const realStep = ops.step.bind(ops);
      // A machine whose kind tears current.json right after the checkpoint: its next handler step cannot read it.
      const machine = createOpsMachine({
        dataDir,
        kinds: [
          {
            ...rollbackKind(deps),
            step: async (c, op) => {
              const next = await rollbackKind(deps).step(c, op);
              if (next.params['flipping'] === true && op.params['flipping'] !== true) {
                await fsp.writeFile(file, '{torn');
                await fsp.writeFile(`${file}.bak`, '{torn');
              }
              return next;
            },
          },
        ],
        db: () => h,
        connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
        keyring: () => KEYRING,
        clock: () => Date.now(),
        log: silent,
        snapshotBackupRunning: async () => false,
        appVersion: V2,
      });
      try {
        const stuck = await machine.step(20_000);
        expect(stuck).toMatchObject({ opId, state: 'needs_attention', pointOfNoReturn: true });
        expect((await opJson()).stateBefore).toBe('running');
        await expect(machine.cancel(CLI, { opId })).rejects.toMatchObject({ code: 'OPS_POINT_OF_NO_RETURN' });
      } finally {
        await machine.close();
      }
      expect(await rollbacks(opId)).toEqual([]);

      await fsp.writeFile(file, good); // the operator repairs it
      await ops.resume();
      expect(await realStep(20_000)).toMatchObject({ state: 'done' });
      expect(await current()).toMatchObject({ active: { version: V1, source: 'data' }, previous: null, pinned: V2 });
      expect(await rollbacks(opId)).toHaveLength(1);
      expect(await notifications()).toHaveLength(1);
      expect(await logRow(opId)).toMatchObject({ status: 'done' });
    });

    it('params that are not a rollback op’s → failed, nothing changed', async () => {
      await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'data' }, pending: null, pinned: null });
      const before = await currentText();
      await ops.begin('rollback', CLI, { target: 'latest', from: V2 });
      expect((await drive()).state).toBe('failed');
      expect(await currentText()).toBe(before);
    });
  });

  describe('revertPending', () => {
    /** An update op of target 0.3 past its point of no return. */
    function updateOp(state: string, o: Partial<OpFile> = {}): OpFile {
      return opFixture({
        kind: 'update',
        state,
        version: V3,
        pointOfNoReturn: true,
        params: { source: 'feed', target: V3, from: V2, entry: null, staging: null, needsBackup: false, pendingWritten: true },
        ...o,
      });
    }

    async function pendingState(): Promise<void> {
      await setState({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'bundled' }, pending: { version: V3, source: 'data' }, pinned: null });
    }

    it('nothing pending → null, nothing written', async () => {
      await setState({ active: { version: V2, source: 'data' }, previous: null, pending: null, pinned: null });
      const before = await currentText();
      expect(await revertPending(dataDir, Date.now())).toBeNull();
      expect(await currentText()).toBe(before);
    });

    it('the update op in switched → reverting (operator), then pending null and the boot markers removed', async () => {
      await pendingState();
      const op = updateOp('switched');
      await writeOpFile(dataDir, op);
      const markers = path.join(dataDir, 'releases', 'boot', V3);
      await fsp.mkdir(markers, { recursive: true });
      await fsp.writeFile(path.join(markers, '123-456'), '{}');
      const at = Date.now();

      expect(await revertPending(dataDir, at)).toBe(V3);
      const after = await opJson();
      expect(after).toMatchObject({ opId: op.opId, state: 'reverting', stateBefore: 'switched', error: { code: 'UPDATE_BOOT_FAILED', detail: 'operator' } });
      expect(after.heartbeatAt).toBeGreaterThanOrEqual(at);
      expect(after.params).toEqual(op.params);
      expect(await current()).toMatchObject({ active: { version: V2, source: 'data' }, pending: null, pendingSince: null, pinned: null });
      expect(await exists(markers)).toBe(false);
      expect(await exists(path.join(dataDir, 'releases', 'boot.lock'))).toBe(false);
    });

    it('1D-02: an op in needs_attention is judged by its stateBefore (migrating) → reverting', async () => {
      await pendingState();
      await writeOpFile(dataDir, updateOp('needs_attention', { stateBefore: 'migrating', error: { code: 'INTERNAL' } }));
      expect(await revertPending(dataDir, Date.now())).toBe(V3);
      expect(await opJson()).toMatchObject({ state: 'reverting', stateBefore: 'migrating', error: { code: 'UPDATE_BOOT_FAILED', detail: 'operator' } });
      expect((await current()).pending).toBeNull();
    });

    it('an op already reverting, of another target, or none → left as it is, pending cleared', async () => {
      await pendingState();
      await writeOpFile(dataDir, updateOp('reverting', { error: { code: 'UPDATE_BOOT_FAILED', detail: 'migration' } }));
      let before = await opText();
      expect(await revertPending(dataDir, Date.now())).toBe(V3);
      expect(await opText()).toBe(before);
      expect((await current()).pending).toBeNull();

      await pendingState();
      await writeOpFile(dataDir, updateOp('switched', { params: { source: 'feed', target: '0.4.0-test', from: V2, entry: null, staging: null, needsBackup: false } }));
      before = await opText();
      expect(await revertPending(dataDir, Date.now())).toBe(V3);
      expect(await opText()).toBe(before);
      expect((await current()).pending).toBeNull();

      await fsp.rm(path.join(dataDir, 'ops'), { recursive: true, force: true });
      await pendingState();
      expect(await revertPending(dataDir, Date.now())).toBe(V3);
      expect((await current()).pending).toBeNull();
    });

    it('1D-03: a live holder of boot.lock → RELEASE_PENDING with nothing changed; force waits until it is gone', async () => {
      await pendingState();
      await writeOpFile(dataDir, updateOp('migrating'));
      const beforeState = await currentText();
      const beforeOp = await opText();
      const holder = await acquireFileLock(dataPath(dataDir, 'releases', 'boot.lock'), { staleMs: 60_000 });
      expect(holder).not.toBeNull();
      try {
        const refused = await revertPending(dataDir, Date.now()).catch((e: unknown) => e);
        expect(isDomainError(refused) && refused.code).toBe('RELEASE_PENDING');
        expect(await currentText()).toBe(beforeState);
        expect(await opText()).toBe(beforeOp);

        const timedOut = await revertPending(dataDir, Date.now(), { force: true, pollMs: 50, maxWaitMs: 200 }).catch((e: unknown) => e);
        expect(isDomainError(timedOut) && timedOut.code).toBe('RELEASE_PENDING');
        expect(await currentText()).toBe(beforeState);

        const waits: number[] = [];
        const forced = revertPending(dataDir, Date.now(), { force: true, pollMs: 50, onWait: (ms) => waits.push(ms) });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await currentText()).toBe(beforeState); // still waiting
        await holder!.release();
        expect(await forced).toBe(V3);
        expect(waits.length).toBeGreaterThan(0);
        expect(await opJson()).toMatchObject({ state: 'reverting', stateBefore: 'migrating' });
        expect((await current()).pending).toBeNull();
      } finally {
        await holder?.release();
      }
    });

    it('a busy ops/step.lock → RELEASE_PENDING with nothing changed, boot.lock let go', async () => {
      await pendingState();
      await writeOpFile(dataDir, updateOp('switched'));
      const beforeState = await currentText();
      const beforeOp = await opText();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const stepper = withFileLock(stepLockPath(dataDir), async () => {
        entered();
        await held;
      });
      await inside;
      try {
        const refused = await revertPending(dataDir, Date.now(), { stepLockWaitMs: 200 }).catch((e: unknown) => e);
        expect(isDomainError(refused) && refused.code).toBe('RELEASE_PENDING');
        expect(await currentText()).toBe(beforeState);
        expect(await opText()).toBe(beforeOp);
        expect(await exists(path.join(dataDir, 'releases', 'boot.lock'))).toBe(false);
      } finally {
        release();
        await stepper;
      }
    });
  });
});
