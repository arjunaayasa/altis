import { fork } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  PHASE1_MIGRATIONS,
  TABLE_CLASSES,
  TABLE_KEYS,
  columnsAt,
  dropRegisteredTables,
  runMigrations,
  verifyAuditChain,
  withTx,
  type TableName,
} from '@altis/db';
import { resetTestFaults, type HeldFileLock } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { schemaVersionOf } from '../../src/backup/create-job.js';
import type { BackupManifest } from '../../src/backup/manifest.js';
import { txCtx } from '../../src/context.js';
import { readMaintenance, type OpFile } from '../../src/ops/files.js';
import { KEPT_TABLES, preserveStep, type PreserveCheckpoint } from '../../src/restore/keep.js';
import { loadTables } from '../../src/restore/load.js';
import {
  KEYRING,
  SESSION_KEY,
  beginRestore,
  currentOp,
  liveChecksums,
  loadedChecksums,
  manifestChecksums,
  preparedArchive,
  SYSTEM,
  restoreHarness,
  restoreParams,
  seedInstallation,
  serverBackup,
  stepKilledAfterCommit,
  stepUntil,
  uploadedArchive,
  type RestoreHarness,
  type Seeded,
} from '../fixtures/restore-support.js';

// A restore that fails or dies (spec §9.10 failure, A6 "kembali otomatis ke pre_restore"; Review Focus 2 and 3;
// preflight S13; P7, P21; plan Task 22) on the engine picked by ALTIS_TEST_DB:
//
// - a process stepping the op is SIGKILLed in `loading` right after part 1, part 3 or the last part committed (before
//   its checkpoint), and once right after the drop: a new process resumes it to `done`, every table equals the
//   backup's checksums and holds no row twice;
// - `restore-mid-load:2` → failed_restoring_pre → failed: every table as before the restore, maintenance off, one
//   notification.restore_failed; with `:replay` the replay fails too → needs_attention, maintenance kept (S13);
// - `disk-full:load:2` (a synthetic EDQUOT) → failed_restoring_pre → failed, tmp/<opId>/ gone, notification.disk_low;
//   restoring an uploaded `.altisbak`, its extraction `tmp/<opId>/src/` is there when the fault fires and gone after;
// - `preserving` a large audit_log: each step keeps at most one batch of rows (P9), and a step killed after its write
//   is resumed from its checkpoint: the kept file holds every row once;
// - finalizing's `backup.restore` entry cannot be written: the step stays at step 7 and is tried again (never back to
//   pre_restore); after 15 minutes of failures the op needs attention, and once resumed it ends `done`, audited.
//
// SQLite targets restore in place here (the test build's stand-in until Task 25).

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

/** While `fail` is set, finalizing's step 7 (`recordOutcome`) throws as a database that cannot write would. */
const outcomeFault = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('../../src/restore/finalize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/restore/finalize.js')>();
  return {
    ...actual,
    recordOutcome: async (...args: Parameters<typeof actual.recordOutcome>): Promise<void> => {
      if (outcomeFault.fail) {
        outcomeFault.calls += 1;
        throw new Error('the database server is out of disk space (test)');
      }
      await actual.recordOutcome(...args);
    },
  };
});

/** While `fail` is set, a `preserving` step throws EDQUOT after its write (a partial ops/<opId>/keep/ is on disk). */
const keepFault = vi.hoisted(() => ({ fail: false }));
vi.mock('../../src/restore/keep.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/restore/keep.js')>();
  return {
    ...actual,
    preserveStep: async (...args: Parameters<typeof actual.preserveStep>): ReturnType<typeof actual.preserveStep> => {
      const r = await actual.preserveStep(...args);
      if (keepFault.fail) throw Object.assign(new Error('EDQUOT: disk quota exceeded (test)'), { code: 'EDQUOT' });
      return r;
    },
  };
});

const ctx = testDbContext();
const INSTALL_ID = newId();
const ROOT = path.resolve(import.meta.dirname, '../../../..');
// The tables of the Phase 1 schema: under the test profile the registry also names the release fixtures' test_fixture
// (decision D1d-26), which this database (PHASE1_MIGRATIONS) does not have.
const PHASE1_SCHEMA = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const DATA_TABLES = (Object.keys(TABLE_CLASSES) as TableName[]).filter(
  (t) => (TABLE_CLASSES[t] === 'data' || TABLE_CLASSES[t] === 'config') && columnsAt(t, PHASE1_SCHEMA).length > 0,
);

/** Runs fixtures/restore-child.mjs on the current op with `env`; resolves with its exit and report. */
function runChild(o: object, env: NodeJS.ProcessEnv): Promise<{ code: number | null; signal: NodeJS.Signals | null; report: unknown }> {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(import.meta.dirname, '../fixtures/restore-child.mjs'), [JSON.stringify(o)], {
      cwd: ROOT,
      env,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let report: unknown;
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('message', (message) => {
      report = message;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, report });
    });
  });
}

describe.skipIf(!ctx.available)(`restore failures [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let harness: RestoreHarness;
  let seeded: Seeded;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-restore-failure-')));
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    await dropRegisteredTables(h.db, h.dialect);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    seeded = await seedInstallation(h, { dataDir, installId: INSTALL_ID });
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_ID });
    resetTestFaults();
  });

  afterEach(async () => {
    await harness.close();
    vi.unstubAllEnvs();
    resetTestFaults();
    Object.assign(outcomeFault, { fail: false, calls: 0 });
  });

  /** A backup of one row per part (many parts), then the data changed, so that the restore has work to undo. */
  async function backupThenChange(): Promise<{ backupId: string; manifest: BackupManifest }> {
    vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '1');
    const backup = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    vi.unstubAllEnvs();
    const now = Date.now();
    await h.db.updateTable('branches').set({ name: 'Diubah', updated_at: now }).execute();
    await h.db
      .insertInto('staff_users')
      .values({ id: newId(), username_key: 'baru', username_display: 'baru', name: 'Baru', password_hash: 'x', status: 'active', created_at: now, updated_at: now })
      .execute();
    return backup;
  }

  /** Row counts of the loaded tables, and whether any primary key appears twice. */
  async function rowCounts(manifest: BackupManifest): Promise<{ counts: Record<string, number>; duplicates: string[] }> {
    const counts: Record<string, number> = {};
    const duplicates: string[] = [];
    for (const table of loadTables(manifest)) {
      const pk = TABLE_KEYS[table].pk;
      const rows = (await h.db.selectFrom(table).select(pk as never).execute()) as Record<string, unknown>[];
      counts[table] = rows.length;
      const keys = rows.map((r) => JSON.stringify(pk.map((c) => r[c])));
      if (new Set(keys).size !== keys.length) duplicates.push(table);
    }
    return { counts, duplicates };
  }

  const expectedCounts = (manifest: BackupManifest): Record<string, number> =>
    Object.fromEntries(loadTables(manifest).map((t) => [t, manifest.tables[t]!.rows]));

  const childOptions = () => ({
    dataDir,
    config: h.config,
    dbDataDir: h.dataDir,
    installId: INSTALL_ID,
    keyring: KEYRING,
    sessionKey: Buffer.from(SESSION_KEY).toString('base64url'),
    budgetMs: 50,
  });

  for (const point of ['after-drop', 'after-part:1', 'after-part:3', 'last-part'] as const) {
    it(`SIGKILL ${point} of loading → a new process resumes to done: the backup's checksums, no row twice`, async () => {
      const { backupId, manifest } = await backupThenChange();
      // The global numbers of the parts that hold rows (an empty table's one part commits nothing, so no kill point
      // fires after it: Phase 2's catalog tables, empty here, come first in load order).
      const withRows: number[] = [];
      let global = 0;
      for (const t of loadTables(manifest)) {
        for (const p of manifest.tables[t]!.parts) {
          global += 1;
          if (p.rows > 0) withRows.push(global);
        }
      }
      const kill = point === 'after-drop' ? point : `after-part:${point === 'last-part' ? withRows.at(-1) : withRows[Number(point.split(':')[1]) - 1]}`;
      await beginRestore(harness, restoreParams(backupId));
      await stepUntil(harness, dataDir, (op) => op.state === 'loading', { budgetMs: 1 });
      expect((await currentOp(dataDir)).state).toBe('loading');

      const env = { ...process.env, ALTIS_TEST_RESTORE_KILL: kill, ALTIS_TEST_RESTORE_TX_ROWS: '1' };
      const killed = await runChild(childOptions(), env);
      expect(killed.signal).toBe('SIGKILL');
      const op = await currentOp(dataDir);
      expect(op.state).toBe('loading');
      expect(op.pointOfNoReturn).toBe(true);

      const resumed = await runChild(childOptions(), { ...process.env, ALTIS_TEST_RESTORE_TX_ROWS: '1' });
      expect(resumed).toMatchObject({ code: 0, report: { state: 'done', error: null } });
      expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
      const { counts, duplicates } = await rowCounts(manifest);
      expect(duplicates).toEqual([]);
      expect({ ...counts, notifications: manifest.tables['notifications']!.rows }).toEqual(expectedCounts(manifest));
      expect(await readMaintenance(dataDir)).toBeNull();
    }, 180_000);
  }

  /** Steps the op to its end (or to needs_attention), recording every state op.json passed through. */
  async function stepRecording(): Promise<string[]> {
    const states: string[] = [];
    await stepUntil(
      harness,
      dataDir,
      (op) => {
        if (states.at(-1) !== op.state) states.push(op.state);
        return false;
      },
      { budgetMs: 1 },
    );
    const last = (await currentOp(dataDir)).state;
    if (states.at(-1) !== last) states.push(last);
    return states;
  }

  it('restore-mid-load:2 → failed_restoring_pre → failed: the database as before, maintenance off, one restore_failed', async () => {
    const { backupId } = await backupThenChange();
    const before = await liveChecksums(h, DATA_TABLES.filter((t) => t !== 'notifications'));
    vi.stubEnv('ALTIS_TEST_FAULT', 'restore-mid-load:2');
    const opId = await beginRestore(harness, restoreParams(backupId));
    const states = await stepRecording();
    expect(states).toContain('failed_restoring_pre');
    expect(states.at(-1)).toBe('failed');
    const op = await currentOp(dataDir);
    expect(op).toMatchObject({ opId, state: 'failed', pointOfNoReturn: true, error: { code: 'INTERNAL' } });
    expect(await liveChecksums(h, DATA_TABLES.filter((t) => t !== 'notifications'))).toEqual(before);
    expect(await readMaintenance(dataDir)).toBeNull();
    const notes = await h.db.selectFrom('notifications').select('type').where('type', 'like', 'restore.%').execute();
    expect(notes).toEqual([{ type: 'restore.failed' }]);
    const audit = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').execute();
    expect(audit.map((a) => JSON.parse(a.meta) as Record<string, unknown>)).toMatchObject([{ opId, outcome: 'failed', error: 'INTERNAL' }]);
    expect(harness.deps.requestRestart.calls).toEqual(['restore']);
  });

  it('restore-mid-load:2:replay → the replay fails too → needs_attention, maintenance kept (S13)', async () => {
    const { backupId } = await backupThenChange();
    vi.stubEnv('ALTIS_TEST_FAULT', 'restore-mid-load:2:replay');
    const opId = await beginRestore(harness, restoreParams(backupId));
    const states = await stepRecording();
    expect(states).toContain('failed_restoring_pre');
    const op = await currentOp(dataDir);
    expect(op).toMatchObject({ opId, state: 'needs_attention', stateBefore: 'failed_restoring_pre', pointOfNoReturn: true });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'restore', opId });
  });

  it('disk-full:load:2 (EDQUOT while loading) → failed_restoring_pre → failed, tmp/<opId>/ gone, disk_low', async () => {
    const { backupId } = await backupThenChange();
    const before = await liveChecksums(h, DATA_TABLES.filter((t) => t !== 'notifications'));
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:load:2');
    resetTestFaults();
    const opId = await beginRestore(harness, restoreParams(backupId));
    const states = await stepRecording();
    expect(states).toContain('failed_restoring_pre');
    expect(await currentOp(dataDir)).toMatchObject({ state: 'failed', error: { code: 'DISK_QUOTA' } });
    expect(await liveChecksums(h, DATA_TABLES.filter((t) => t !== 'notifications'))).toEqual(before);
    await expect(fsp.stat(path.join(dataDir, 'tmp', opId))).rejects.toMatchObject({ code: 'ENOENT' });
    const notes = (await h.db.selectFrom('notifications').select('type').execute()).map((n) => n.type).sort();
    expect(notes).toEqual(['disk.low', 'restore.failed']);
    expect(await readMaintenance(dataDir)).toBeNull();
  });
  it('EDQUOT while preserving (before the point of no return) → failed, DISK_QUOTA, disk_low; the partial keep/ copies go', async () => {
    const { backupId } = await backupThenChange();
    await addAuditRows(2500);
    const before = await liveChecksums(h, DATA_TABLES.filter((t) => t !== 'notifications'));
    const opId = await beginRestore(harness, restoreParams(backupId));
    const keep = path.join(dataDir, 'ops', opId, 'keep');
    await stepUntil(harness, dataDir, (op) => op.state === 'preserving', { budgetMs: 1 });
    await harness.ops.step(1);
    expect((await currentOp(dataDir)).state).toBe('preserving');
    expect((await fsp.readdir(keep)).length).toBeGreaterThan(0);
    keepFault.fail = true;
    try {
      await harness.ops.step(1);
    } finally {
      keepFault.fail = false;
    }
    expect(await currentOp(dataDir)).toMatchObject({ opId, state: 'failed', pointOfNoReturn: false, error: { code: 'DISK_QUOTA' } });
    await expect(fsp.stat(keep)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(dataDir, 'tmp', opId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await liveChecksums(h, DATA_TABLES.filter((t) => t !== 'notifications'))).toEqual(before);
    const notes = await h.db.selectFrom('notifications').select('type').where('type', 'in', ['disk.low', 'restore.failed']).execute();
    expect(notes.map((n) => n.type)).toEqual(['disk.low']);
    expect(await readMaintenance(dataDir)).toBeNull();
  }, 120_000);

  it('a restore cancelled while preserving removes its partial keep/ copies', async () => {
    const { backupId } = await backupThenChange();
    await addAuditRows(2500);
    const opId = await beginRestore(harness, restoreParams(backupId));
    const keep = path.join(dataDir, 'ops', opId, 'keep');
    await stepUntil(harness, dataDir, (op) => op.state === 'preserving', { budgetMs: 1 });
    await harness.ops.step(1);
    expect((await fsp.readdir(keep)).length).toBeGreaterThan(0);
    expect(await harness.ops.cancel(SYSTEM)).toMatchObject({ opId, state: 'failed', terminal: true });
    await expect(fsp.stat(keep)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readMaintenance(dataDir)).toBeNull();
  }, 120_000);

  it('disk-full:load:2 restoring an uploaded .altisbak → failed; its extraction tmp/<opId>/src/, there at the fault, removed', async () => {
    const { backupId: sourceId } = await serverBackup(h, { dataDir, installId: INSTALL_ID, includeFiles: true });
    const archive = await preparedArchive(h, { dataDir, backupId: sourceId, preparedBy: seeded.users[0]!.id, passphrase: null, into: root });
    const backupId = await uploadedArchive(h, dataDir, archive);
    await h.db.updateTable('branches').set({ name: 'Diubah', updated_at: Date.now() }).execute();
    const before = await liveChecksums(h, DATA_TABLES.filter((t) => t !== 'notifications'));
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:load:2');
    resetTestFaults();
    const opId = await beginRestore(harness, restoreParams(backupId, { source: 'archive', confirmed: true }));
    const src = path.join(dataDir, 'tmp', opId, 'src');
    await stepUntil(harness, dataDir, (op) => op.state === 'loading', { budgetMs: 1 });
    // The archive was extracted before anything was loaded: the fault fires with its entries on disk.
    expect((await fsp.stat(src)).isDirectory()).toBe(true);
    expect(await fsp.readdir(src)).toEqual(expect.arrayContaining(['manifest.json', 'tables']));
    const states = await stepRecording();
    expect(states).toContain('failed_restoring_pre');
    expect(await currentOp(dataDir)).toMatchObject({ state: 'failed', error: { code: 'DISK_QUOTA' } });
    expect(await liveChecksums(h, DATA_TABLES.filter((t) => t !== 'notifications'))).toEqual(before);
    await expect(fsp.stat(path.join(dataDir, 'tmp', opId))).rejects.toMatchObject({ code: 'ENOENT' });
    const notes = await h.db.selectFrom('notifications').select('type').where('type', 'in', ['disk.low', 'restore.failed', 'restore.done']).execute();
    expect(notes.map((n) => n.type).sort()).toEqual(['disk.low', 'restore.failed']);
    expect(await readMaintenance(dataDir)).toBeNull();
  }, 120_000);

  /** `n` more entries in the target's own audit log; resolves with the rows it holds then. */
  async function addAuditRows(n: number): Promise<number> {
    await withTx(h, async (trx) => {
      for (let i = 0; i < n; i += 1) {
        await txCtx(trx, Date.now(), { type: 'system', id: null, ip: null }).audit({ action: 'audit.purge', entity: 'audit_log', entityId: null, meta: { i } });
      }
    });
    return (await h.db.selectFrom('audit_log').select('id').execute()).length;
  }

  /** The lines of the kept copy of `audit_log` of op `opId` (none while it is not there). */
  async function keptAuditLines(opId: string): Promise<string[]> {
    const file = path.join(dataDir, 'ops', opId, 'keep', 'audit_log.jsonl.gz');
    const bytes = await fsp.readFile(file).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    return bytes === null ? [] : gunzipSync(bytes).toString('utf8').split('\n').filter((line) => line !== '');
  }

  it('preserving a large audit_log: one batch per 1 ms step, a step killed after its write resumed, every row kept once', async () => {
    const { backupId } = await backupThenChange();
    // The target's own history: 2500 more entries than one batch of the kept-rows reader (1000) holds.
    const auditRows = await addAuditRows(2500);
    const opId = await beginRestore(harness, restoreParams(backupId));
    await stepUntil(harness, dataDir, (op) => op.state === 'preserving', { budgetMs: 1 });
    const keptLines = (): Promise<string[]> => keptAuditLines(opId);
    let kept = 0;
    let largest = 0;
    let killed = false;
    while ((await currentOp(dataDir)).state === 'preserving') {
      if (!killed && kept >= 1000 && kept < auditRows) {
        await stepKilledAfterCommit(harness, dataDir); // its rows are in the file, beyond the checkpoint
        killed = true;
      }
      await harness.ops.step(1);
      const now = (await keptLines()).length;
      largest = Math.max(largest, now - kept);
      kept = now;
    }
    expect(killed).toBe(true);
    expect(largest).toBeLessThanOrEqual(1000);
    const lines = await keptLines();
    expect(lines.length).toBe(auditRows);
    expect(new Set(lines).size).toBe(auditRows);

    expect(await stepUntil(harness, dataDir, undefined, { budgetMs: 20_000 })).toMatchObject({ state: 'done' });
    const restored = (await h.db.selectFrom('audit_log').select('id').execute()).map((r) => r.id);
    expect(new Set(restored).size).toBe(restored.length);
    expect(restored.length).toBe(auditRows + 1); // and the restore's own entry
    expect((await verifyAuditChain(h)).ok).toBe(true);
  }, 120_000);

  it('preserveStep: what a killed step appended beyond its checkpoint is cut back, even past what the next step writes', async () => {
    const auditRows = await addAuditRows(2500);
    const opId = newId();
    const lock: HeldFileLock = { lost: () => false, assertHeld: () => {} };
    const schemaVersion = await schemaVersionOf(h.db);
    /** A step that reads `batches` batches of 1000 rows (its clock passes the deadline after them). */
    const stepOf = (batches: number, cp: PreserveCheckpoint) => {
      let looks = 0;
      const clock = (): number => (looks++ < batches - 1 ? 0 : 1);
      return preserveStep(h, { dataDir, opId, schemaVersion, stopAt: 1, clock, lock }, cp);
    };
    const start: PreserveCheckpoint = { table: KEPT_TABLES.indexOf('audit_log'), after: null, bytes: 0 };
    const one = await stepOf(1, start);
    expect(one).toMatchObject({ done: false, checkpoint: { table: start.table, bytes: expect.any(Number) } });
    expect(await keptAuditLines(opId)).toHaveLength(1000);
    // Killed after appending the rest of the table as one member: its checkpoint never reached op.json.
    const killed = await stepOf(2, one.checkpoint);
    expect(killed.checkpoint.table).toBe(start.table + 1);
    // The next step writes one batch (a shorter member) where the killed one began, and the file ends there.
    const two = await stepOf(1, one.checkpoint);
    expect(two.checkpoint).toMatchObject({ table: start.table, bytes: (await fsp.stat(path.join(dataDir, 'ops', opId, 'keep', 'audit_log.jsonl.gz'))).size });
    expect(await keptAuditLines(opId)).toHaveLength(2000);
    let cp = two.checkpoint;
    while (cp.table === start.table) cp = (await stepOf(1, cp)).checkpoint;
    const lines = await keptAuditLines(opId);
    expect(lines).toHaveLength(auditRows);
    expect(new Set(lines).size).toBe(auditRows);
  }, 60_000);

  it('a backup.restore entry that cannot be written is tried again, never back to pre_restore; 15 minutes on, needs attention', async () => {
    const { backupId } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
    const opId = await beginRestore(harness, restoreParams(backupId));
    outcomeFault.fail = true;
    const atAudit = (op: OpFile): boolean => op.state === 'finalizing' && (op.params['final'] as { step?: string } | undefined)?.step === 'audit';
    await stepUntil(harness, dataDir, atAudit, { budgetMs: 20_000 }); // a step ends once step 7 failed twice
    const restoreEntries = async () => h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').execute();
    for (let i = 0; i < 3; i += 1) await harness.ops.step(1);
    expect(outcomeFault.calls).toBeGreaterThanOrEqual(3);
    expect(await currentOp(dataDir)).toMatchObject({ state: 'finalizing', pointOfNoReturn: true, params: { final: { step: 'audit' } } });
    expect(await restoreEntries()).toEqual([]);
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'restore', opId });

    // Still failing ten minutes on (the machine's own stall rule never fires: each step is a heartbeat).
    harness.advance(10 * 60_000);
    await harness.ops.step(1);
    expect(await currentOp(dataDir)).toMatchObject({ state: 'finalizing' });
    harness.advance(10 * 60_000);
    await harness.ops.step(1);
    expect(await currentOp(dataDir)).toMatchObject({ state: 'needs_attention', stateBefore: 'finalizing', pointOfNoReturn: true });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'restore', opId });
    expect(harness.deps.requestRestart.calls).toEqual([]);

    outcomeFault.fail = false;
    harness.advance(-20 * 60_000); // an audit entry may not be dated ahead of the real clock
    await harness.ops.resume();
    expect(await stepUntil(harness, dataDir)).toMatchObject({ state: 'done' });
    expect((await restoreEntries()).map((a) => JSON.parse(a.meta) as Record<string, unknown>)).toMatchObject([{ opId, outcome: 'done' }]);
    expect((await h.db.selectFrom('notifications').select('type').where('type', 'like', 'restore.%').execute()).map((n) => n.type)).toEqual(['restore.done']);
    expect(harness.deps.requestRestart.calls).toEqual(['restore']);
    expect(await readMaintenance(dataDir)).toBeNull();
  }, 60_000);
});
