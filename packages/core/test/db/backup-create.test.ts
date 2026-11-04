import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { encodeBase64Url } from '@altis/crypto';
import { PHASE1_MIGRATIONS, claimLock, connect, releaseLock, runMigrations, withTx, type DbHandle } from '@altis/db';
import { resetTestFaults } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import {
  BACKUP_CREATE_JOB,
  CONVERTED_TO_FROZEN,
  abandonBackup,
  backupCreateJob,
  type BackupCreatePayload,
  type BackupJobDeps,
} from '../../src/backup/create-job.js';
import { backupKind } from '../../src/backup/frozen-op.js';
import { readManifest, verifyManifestHmac } from '../../src/backup/manifest.js';
import { BACKUP_SNAPSHOT_LOCK, snapshotBackupRunning } from '../../src/backup/mode.js';
import { startBackup } from '../../src/backup/schedule-job.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { cleanFiles } from '../../src/housekeeping/files.js';
import { claimById } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { requestCancel } from '../../src/jobs/service.js';
import { closeJobSessions, runSlice } from '../../src/jobs/slice.js';
import { HEAVY_LOCK, type RunMode, type SliceResult } from '../../src/jobs/types.js';
import { readOpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpsMachine } from '../../src/ops/machine.js';

// The snapshot backup job `backup.create` (spec §9.9 "snapshot", A6 "konsistensi"; decisions C12, C38; preflight S8,
// S24, M31, M40; P17, P21) on the engine picked by ALTIS_TEST_DB: a backup taken while writes go on holds no orphan;
// SQLite copies the file first and exports from the copy, resumable in any process; MySQL/MariaDB/PostgreSQL export
// from one snapshot transaction kept in the job session, restarted when a fresh session finds parts, and turned into a
// frozen backup under `cron_http`; progress hints, one `backup.done`, the headroom, a full disk, a cancel.

const hooks = vi.hoisted(() => ({
  headroom: [] as [string, number][],
  sqliteOpens: [] as { path: string; readOnly: boolean }[],
  /** Folders whose removal fails with EBUSY (a file in them held open, as Windows refuses it). */
  busy: new Set<string>(),
}));
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // Records the call and proves nothing: a real probe writes 64 MiB per new DATA_DIR.
  const ensureHeadroom: typeof actual.ensureHeadroom = async (dir, bytes) => {
    hooks.headroom.push([dir, bytes]);
  };
  const removeTree: typeof actual.removeTree = async (p) => {
    if (hooks.busy.has(p)) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${p}'`), { code: 'EBUSY' });
    return actual.removeTree(p);
  };
  return { ...actual, ensureHeadroom, removeTree };
});
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  const connectSqliteFile: typeof actual.connectSqliteFile = async (p, o) => {
    hooks.sqliteOpens.push({ path: p, readOnly: o?.readOnly === true });
    return actual.connectSqliteFile(p, o);
  };
  return { ...actual, connectSqliteFile };
});

const ctx = testDbContext();
const KEY = new Uint8Array(32).fill(21);
const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: Buffer.alloc(32, 3).toString('base64url'), active: true }];
const INSTALL_ID = newId();
const MIB = 1024 * 1024;
const silent = { info() {}, warn() {}, error() {} };
const sqlite = ctx.engine === 'sqlite';
const ROOT = path.resolve(import.meta.dirname, '../../../..');
const LEASE_PAST_MS = 10 * 60_000;

describe.skipIf(!ctx.available)(`backup.create (snapshot) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let ops: OpsMachine;
  let opened: number;
  let userId: string;
  const reg = createJobRegistry([backupCreateJob(() => deps())]);

  function deps(): BackupJobDeps {
    return {
      dataDir,
      installId: INSTALL_ID,
      appVersion: '0.1.0',
      sessionKey: KEY,
      kids: ['k1'],
      runtime: 'pm2',
      connectSnapshot: async () => {
        opened += 1;
        return connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir });
      },
      ops,
    };
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-create-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    userId = newId();
    const now = Date.now();
    await h.db
      .insertInto('staff_users')
      .values({ id: userId, username_key: 'pustakawan', username_display: 'pustakawan', name: 'P', password_hash: 'x', status: 'active', locale: null, created_at: now, created_by: null, updated_at: now, updated_by: null, email_key: null, email_display: null, totp_secret_enc: null, last_login_at: null })
      .execute();
    for (let i = 0; i < 40; i += 1) await assignment();
  });

  afterAll(async () => {
    await closeJobSessions();
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await closeJobSessions();
    for (const table of ['jobs', 'locks', 'backups', 'events', 'notifications'] as const) await h.db.deleteFrom(table).execute();
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    hooks.headroom.length = 0;
    hooks.sqliteOpens.length = 0;
    hooks.busy.clear();
    opened = 0;
    ops = createOpsMachine({
      dataDir,
      kinds: [backupKind(() => deps())],
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => KEYRING,
      clock: () => Date.now(),
      log: silent,
      snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
    });
    vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '7');
    resetTestFaults();
  });

  afterEach(async () => {
    await ops.close();
    vi.unstubAllEnvs();
    resetTestFaults();
  });

  /** A branch, a role and a user_roles row naming both, in one transaction (on `on`, default the test's handle). */
  async function assignment(on: DbHandle = h): Promise<void> {
    const now = Date.now();
    const branch = newId();
    const role = newId();
    await withTx(on, async (trx) => {
      await trx
        .insertInto('branches')
        .values({ id: branch, code_key: branch, code_display: branch, name: 'Cabang', address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: now, created_by: null, updated_at: now, updated_by: null })
        .execute();
      await trx.insertInto('roles').values({ id: role, key: `r_${role.toLowerCase()}`, name: 'Peran', description: null, created_at: now, created_by: null, updated_at: now, updated_by: null }).execute();
      await trx.insertInto('user_roles').values({ id: newId(), user_id: userId, role_id: role, branch_id: branch, scope_key: branch, created_at: now, created_by: null }).execute();
    });
  }

  const put = (payload: Partial<BackupCreatePayload> = {}) =>
    withTx(h, (trx) =>
      enqueue(
        trx,
        reg,
        { type: BACKUP_CREATE_JOB, payload: { backupId: null, kind: 'manual', includeFiles: false, checkpoint: null, snapshot: null, ...payload } },
        { now: Date.now(), keyring: KEYRING },
      ),
    ).then((r) => r.id);

  /** Slices of job `id` back to back in `mode` (as a worker or jobs:run would), until it is not continued. */
  async function drive(id: string, o: { mode?: RunMode; budgetMs?: number; slices?: number; now?: () => number; between?: (r: SliceResult, i: number) => Promise<void> } = {}): Promise<SliceResult[]> {
    const results: SliceResult[] = [];
    const clock = o.now ?? (() => Date.now());
    for (let i = 0; i < (o.slices ?? 2000); i += 1) {
      const job = await claimById(h, reg, id, { worker: 'w1', now: clock() });
      if (job === null) break;
      const r = await runSlice(h, reg, job, { mode: o.mode ?? 'cron_cli', budgetMs: o.budgetMs ?? 2500, keyring: KEYRING, log: silent, clock, env: process.env });
      results.push(r);
      await o.between?.(r, i);
      if (r.outcome !== 'continued') break;
    }
    return results;
  }

  const jobRow = (id: string) => h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const backupRows = () => h.db.selectFrom('backups').selectAll().orderBy('created_at').execute();
  const exists = (p: string) =>
    fsp.stat(p).then(
      () => true,
      () => false,
    );
  const backupDir = (id: string) => path.join(dataDir, 'backups', id);
  const events = (type: string) => h.db.selectFrom('events').select('payload').where('channel', '=', 'system.backup').where('type', '=', type).execute();
  const notifications = (type: string) => h.db.selectFrom('notifications').select(['type', 'title_key']).where('type', '=', type).execute();

  /** The rows of `table` in the backup's part files. */
  async function archived(id: string, table: string): Promise<Record<string, unknown>[]> {
    const dir = path.join(backupDir(id), 'tables', table);
    const rows: Record<string, unknown>[] = [];
    for (const name of (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl.gz')).sort()) {
      const text = gunzipSync(await fsp.readFile(path.join(dir, name))).toString('utf8');
      for (const line of text.split('\n')) if (line !== '') rows.push(JSON.parse(line) as Record<string, unknown>);
    }
    return rows;
  }

  it('A6: taken while assignments keep being written, the archive holds no orphan; manifest, row ok, events, headroom', async () => {
    // The previous backup was 100 MiB: the headroom proved is 1.5 times that (S8).
    await h.db
      .insertInto('backups')
      .values({ id: newId(Date.now() - 86_400_000), kind: 'manual', size: 100 * MIB, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status: 'ok', created_at: Date.now() - 86_400_000 })
      .execute();
    const id = await put();
    let stop = false;
    let written = 0;
    // On SQLite the writes go through the very handle the backup copies (M31).
    const writer = (async () => {
      // Spread over the backup's slices (a few ms apart), at most 60 of them: every row is 3 more parts to write.
      while (!stop && written < 60) {
        await assignment();
        written += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    let marker: string | null = null;
    const results = await drive(id, {
      async between(_r, i) {
        if (i === 0 && !sqlite) {
          // Inserted after the snapshot began: not in the archive.
          marker = newId();
          const now = Date.now();
          await h.db
            .insertInto('branches')
            .values({ id: marker, code_key: marker, code_display: marker, name: 'Penanda', address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: now, created_by: null, updated_at: now, updated_by: null })
            .execute();
        }
      },
    });
    stop = true;
    await writer;
    expect(written).toBeGreaterThan(0);
    // The whole result (its `error` too) and the job's last_error, should it not have succeeded.
    expect({ ...results.at(-1), lastError: (await jobRow(id)).last_error }).toMatchObject({ outcome: 'succeeded' });
    expect(results.length).toBeGreaterThan(3);

    const mine = (await backupRows()).filter((r) => r.id === id);
    expect(mine).toHaveLength(1); // the first backup takes the job's own id
    expect(mine[0]).toMatchObject({ status: 'ok', consistency: 'snapshot', kind: 'manual', dialect: h.dialect });
    const manifest = await readManifest(dataDir, id);
    expect(manifest).not.toBeNull();
    expect(verifyManifestHmac(KEY, manifest!)).toBe(true);
    // The schema version is the last migration (by name), never named here: Phase 1d and Phase 2 add theirs.
    const latest = Object.keys(PHASE1_MIGRATIONS).sort().at(-1);
    expect(manifest).toMatchObject({ consistency: 'snapshot', kind: 'manual', installId: INSTALL_ID, kids: ['k1'], schemaVersion: latest });
    const sha = createHash('sha256').update(await fsp.readFile(path.join(backupDir(id), 'manifest.json'))).digest('hex');
    expect(mine[0]!.sha256).toBe(sha);
    expect(Number(mine[0]!.size)).toBeGreaterThan(0);
    expect(await exists(path.join(backupDir(id), '.work'))).toBe(false);

    const branches = new Set((await archived(id, 'branches')).map((r) => r['id']));
    const roles = new Set((await archived(id, 'roles')).map((r) => r['id']));
    const assignments = await archived(id, 'user_roles');
    expect(assignments.length).toBeGreaterThanOrEqual(40);
    for (const a of assignments) {
      expect(branches.has(a['branch_id']), 'the branch of every assignment').toBe(true);
      expect(roles.has(a['role_id']), 'the role of every assignment').toBe(true);
    }
    expect(manifest!.tables['user_roles']!.rows).toBe(assignments.length);

    if (sqlite) {
      // The export read the copy, read-only.
      expect(hooks.sqliteOpens.length).toBeGreaterThan(0);
      for (const open of hooks.sqliteOpens) {
        expect(open.path).toBe(path.join(backupDir(id), '.work', 'snapshot.sqlite'));
        expect(open.readOnly).toBe(true);
      }
    } else {
      expect(branches.has(marker)).toBe(false);
      expect(opened).toBe(1); // one snapshot session for every slice of this run
    }

    expect(hooks.headroom).toEqual([[dataDir, 150 * MIB]]);
    expect((await events('backup.progress')).length).toBeGreaterThan(1);
    const done = await events('backup.done');
    expect(done).toHaveLength(1);
    expect(JSON.parse(done[0]!.payload)).toEqual({ backupId: id });
    expect(await notifications('backup.done')).toHaveLength(1);
    expect(await h.db.selectFrom('locks').select('name').where('name', '=', BACKUP_SNAPSHOT_LOCK).execute()).toEqual([]);
  });

  it('while a slice runs the lock backup:snapshot is held: a frozen op is refused with OPS_BLOCKED_BY_BACKUP', async () => {
    const id = await put();
    let refused: unknown = null;
    await drive(id, {
      slices: 2,
      async between() {
        refused ??= await ops.begin('backup', { type: 'system', id: null }, { kind: 'manual', includeFiles: false }).catch((e: unknown) => e);
      },
    });
    expect(refused).toMatchObject({ code: 'OPS_BLOCKED_BY_BACKUP' });
    expect(await readOpFile(dataDir)).toBeNull();
  });

  it.skipIf(!sqlite)('SQLite: a new process goes on from the stored checkpoint (C12): the parts already written stay as they are', async () => {
    const id = await put();
    // One part per slice; stop once two parts of the first table are stored.
    let stored: BackupCreatePayload | null = null;
    await drive(id, {
      async between() {
        const row = await jobRow(id);
        stored = JSON.parse(row.payload) as BackupCreatePayload;
      },
      slices: 4,
    });
    expect(stored!.snapshot).toBe('sqlite-copy');
    const written = Object.values(stored!.checkpoint!.written).reduce((a, b) => a + b, 0);
    expect(written).toBeGreaterThanOrEqual(2);
    const firstPart = path.join(backupDir(id), 'tables', 'audit_log', '00001.jsonl.gz');
    const before = await fsp.stat(firstPart);
    // Another process: no session of this one, no handle of its own on the copy.
    await closeJobSessions();
    const results = await drive(id, { budgetMs: 20_000 });
    expect(results.at(-1)?.outcome).toBe('succeeded');
    const after = await fsp.stat(firstPart);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('ok');
  });

  it.skipIf(sqlite)('a fresh session after parts were written removes them and exports again from a new snapshot (C12)', async () => {
    const id = await put();
    await drive(id, { slices: 3 });
    const payload = JSON.parse((await jobRow(id)).payload) as BackupCreatePayload;
    expect(payload.snapshot).toBe('transaction');
    expect(payload.checkpoint).not.toBeNull();
    // The process that held the snapshot is gone.
    await closeJobSessions();
    for (let i = 0; i < 5; i += 1) await assignment();
    const live = Number((await h.db.selectFrom('user_roles').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const results = await drive(id, { budgetMs: 20_000 });
    expect(results.at(-1)?.outcome).toBe('succeeded');
    expect(opened).toBe(2);
    const manifest = await readManifest(dataDir, id);
    expect(manifest!.tables['user_roles']!.rows).toBe(live);
    expect((await archived(id, 'user_roles')).length).toBe(live);
  });

  it.skipIf(sqlite)('a slice run by POST /_cron (cron_http) turns the job into a frozen backup', async () => {
    const id = await put();
    await drive(id, { slices: 2 });
    const before = JSON.parse((await jobRow(id)).payload) as BackupCreatePayload;
    expect(before.backupId).toBe(id);
    expect(await exists(backupDir(id))).toBe(true);
    const results = await drive(id, { mode: 'cron_http' });
    expect(results).toEqual([{ jobId: id, type: BACKUP_CREATE_JOB, outcome: 'succeeded' }]);
    expect(await jobRow(id)).toMatchObject({ status: 'succeeded', progress_message: CONVERTED_TO_FROZEN });
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('failed');
    expect(await exists(backupDir(id))).toBe(false);
    const op = await readOpFile(dataDir);
    expect(op).toMatchObject({ kind: 'backup', state: 'frozen', params: { kind: 'manual', includeFiles: false, convertedFrom: id } });
  });

  /** fixtures/backup-child.mjs on job `id`: its slices back to back with `budgetMs` each, the clock `offsetMs` ahead. */
  function child(id: string, o: { budgetMs: number; offsetMs: number; env?: Record<string, string> }) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; report?: { slices: number; outcome: string | null } }>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ALTIS_TEST_EXPORT_PART_ROWS: '3', ...o.env };
      if (o.env?.['ALTIS_TEST_FAULT'] === undefined) delete env['ALTIS_TEST_FAULT'];
      let report: { slices: number; outcome: string | null } | undefined;
      const p = fork(
        path.join(import.meta.dirname, '../fixtures/backup-child.mjs'),
        [
          JSON.stringify({
            config: h.config,
            dbDataDir: h.dataDir,
            dataDir,
            jobId: id,
            budgetMs: o.budgetMs,
            offsetMs: o.offsetMs,
            sessionKey: encodeBase64Url(KEY),
            installId: INSTALL_ID,
          }),
        ],
        { cwd: ROOT, env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
      );
      const timer = setTimeout(() => p.kill('SIGKILL'), 90_000);
      p.on('message', (m) => {
        report = m as typeof report;
      });
      p.on('error', reject);
      p.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, ...(report === undefined ? {} : { report }) });
      });
    });
  }

  it('a process killed in the middle of a part (export-mid-part:2) is followed, after its lease, by one that finishes the backup', async () => {
    const id = await put();
    // One part per slice: every finished part is in a stored checkpoint before the kill.
    const killed = await child(id, { budgetMs: 2500, offsetMs: 0, env: { ALTIS_TEST_FAULT: 'export-mid-part:2' } });
    expect(killed.signal).toBe('SIGKILL');
    const stored = JSON.parse((await jobRow(id)).payload) as BackupCreatePayload;
    expect((await jobRow(id)).status).toBe('running');
    expect(stored.backupId).toBe(id);
    expect(stored.checkpoint).not.toBeNull();
    const kept = Object.entries(stored.checkpoint!.written);
    expect(kept.length).toBeGreaterThan(0);
    const before = new Map<string, number>();
    for (const [table, parts] of kept) {
      for (let n = 1; n <= parts; n += 1) {
        const file = path.join(backupDir(id), 'tables', table, `${String(n).padStart(5, '0')}.jsonl.gz`);
        before.set(file, (await fsp.stat(file)).ino);
      }
    }
    // Written meanwhile: on MySQL/MariaDB/PostgreSQL the new snapshot sees them; the SQLite copy does not.
    const liveBefore = Number((await h.db.selectFrom('user_roles').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    for (let i = 0; i < 4; i += 1) await assignment();

    const resumed = await child(id, { budgetMs: 20_000, offsetMs: LEASE_PAST_MS });
    expect(resumed.code).toBe(0);
    expect(resumed.report?.outcome).toBe('succeeded');
    expect(await jobRow(id)).toMatchObject({ status: 'succeeded', attempts: 1 }); // the reclaim of the dead process's lease counted
    const manifest = (await readManifest(dataDir, id))!;
    expect(verifyManifestHmac(KEY, manifest)).toBe(true);
    for (const [table, t] of Object.entries(manifest.tables)) {
      expect(t.parts.map((p) => p.n), table).toEqual(t.parts.map((_, i) => i + 1));
      expect(t.parts.reduce((sum, p) => sum + p.rows, 0), table).toBe(t.rows);
    }
    const stillThere = await Promise.all([...before].map(async ([file, ino]) => (await fsp.stat(file).catch(() => null))?.ino === ino));
    if (sqlite) {
      // C12: the copy outlives the process; the export goes on from the stored checkpoint (the parts it vouches for stay).
      expect(stillThere.every(Boolean)).toBe(true);
      expect(manifest.tables['user_roles']!.rows).toBe(liveBefore);
    } else {
      // C12: a fresh session after parts were written: they go, and the export starts again from a new snapshot.
      expect(stillThere.some(Boolean)).toBe(false);
      expect(manifest.tables['user_roles']!.rows).toBe(liveBefore + 4);
    }
  }, 180_000);

  it('a full disk (disk-full:backups:3): folder removed, row failed, disk_low once; the retry ends the same way: dead with DISK_QUOTA', async () => {
    vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:backups:3');
    resetTestFaults();
    const id = await put();
    const first = await drive(id, { budgetMs: 20_000 });
    expect(first.at(-1)).toEqual({ jobId: id, type: BACKUP_CREATE_JOB, outcome: 'retry', error: 'DISK_QUOTA' });
    expect(await jobRow(id)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'DISK_QUOTA' });
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('failed');
    expect(await exists(backupDir(id))).toBe(false);
    expect(await notifications('disk.low')).toHaveLength(1);
    expect(await notifications('backup.failed')).toHaveLength(1);
    expect(await h.db.selectFrom('locks').select('name').where('name', '=', BACKUP_SNAPSHOT_LOCK).execute()).toEqual([]);

    // The retry (after its backoff) does not fill the disk again.
    const later = Date.now() + 60_000;
    const second = await drive(id, { now: () => later, budgetMs: 20_000 });
    expect(second).toEqual([{ jobId: id, type: BACKUP_CREATE_JOB, outcome: 'dead', error: 'DISK_QUOTA' }]);
    expect(await jobRow(id)).toMatchObject({ status: 'dead', last_error: 'DISK_QUOTA' });
    expect(await notifications('disk.low')).toHaveLength(1);
    expect((await backupRows()).filter((r) => r.status !== 'failed')).toEqual([]);
  });

  it('a cancel request ends the job cancelled, its folder removed and its row failed', async () => {
    const id = await put();
    await drive(id, { slices: 2 });
    await h.db.updateTable('jobs').set({ cancel_requested: 1 }).where('id', '=', id).execute();
    const results = await drive(id);
    expect(results.at(-1)?.outcome).toBe('cancelled');
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('failed');
    expect(await exists(backupDir(id))).toBe(false);
    expect(await h.db.selectFrom('locks').select('name').where('name', '=', BACKUP_SNAPSHOT_LOCK).execute()).toEqual([]);
  });

  it('an attempt that failed with an error the next one may resume from (an op in progress) does not doom the retry', async () => {
    // A conversion to frozen whose ops.begin was refused (OPS_IN_PROGRESS) left its row failed and its folder removed.
    const id = await put();
    await h.db
      .insertInto('backups')
      .values({ id, kind: 'manual', size: null, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status: 'failed', created_at: Date.now() })
      .execute();
    await h.db.updateTable('jobs').set({ attempts: 1, last_error: 'OPS_IN_PROGRESS', payload: JSON.stringify({ backupId: id, kind: 'manual', includeFiles: false, checkpoint: null, snapshot: null }) }).where('id', '=', id).execute();
    const results = await drive(id, { budgetMs: 20_000 });
    expect(results.at(-1)?.outcome).toBe('succeeded');
    const ok = (await backupRows()).filter((r) => r.status === 'ok');
    expect(ok).toHaveLength(1);
    expect(ok[0]!.id).not.toBe(id); // a new backup: the failed one keeps its row
    expect(await readManifest(dataDir, ok[0]!.id)).not.toBeNull();
  });

  /** `n` finished manual backups (rows `ok` and folders), the oldest first, days before now. */
  async function oldManualBackups(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const at = Date.now() - (30 - i) * 86_400_000;
      const id = newId(at);
      await h.db
        .insertInto('backups')
        .values({ id, kind: 'manual', size: 10, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status: 'ok', created_at: at })
        .execute();
      await fsp.mkdir(path.join(backupDir(id), 'tables'), { recursive: true });
      ids.push(id);
    }
    return ids;
  }

  it('a failure after the row is ok (the retention cannot remove an old folder) never ends the finished backup', async () => {
    // Ten manual backups: the eleventh makes the oldest go, whose folder cannot be removed (EBUSY: a download of it is
    // still open on Windows).
    const old = await oldManualBackups(10);
    hooks.busy.add(backupDir(old[0]!));
    const id = await put();
    const results = await drive(id, { budgetMs: 20_000 });
    expect(results.at(-1)?.outcome).toBe('succeeded');
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('ok');
    const manifest = await readManifest(dataDir, id);
    expect(manifest).not.toBeNull();
    expect(verifyManifestHmac(KEY, manifest!)).toBe(true);
    expect(await notifications('backup.done')).toHaveLength(1);
    expect(await notifications('backup.failed')).toEqual([]);
    // The retention did what it could: the oldest row is deleted, its folder left for housekeeping.files (its
    // `leftovers` phase removes it a day later, as any folder of a deleted backup).
    expect((await backupRows()).find((r) => r.id === old[0])?.status).toBe('deleted');
    expect(await h.db.selectFrom('locks').select('name').where('name', '=', BACKUP_SNAPSHOT_LOCK).execute()).toEqual([]);
  });

  it('the retention at its end never removes the backup that just finished (a clock gone back stamps it the oldest)', async () => {
    // Ten manual backups stamped later than now: a clock that ran ahead then, or one that went back now.
    for (let i = 0; i < 10; i += 1) {
      const at = Date.now() + (i + 1) * 86_400_000;
      await h.db
        .insertInto('backups')
        .values({ id: newId(at), kind: 'manual', size: 10, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status: 'ok', created_at: at })
        .execute();
    }
    const id = await put();
    const results = await drive(id, { budgetMs: 20_000 });
    expect(results.at(-1)?.outcome).toBe('succeeded');
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('ok');
    expect(await readManifest(dataDir, id)).not.toBeNull();
  });

  it('abandonBackup leaves a finished backup alone: no folder removed, no backup_failed', async () => {
    const [id] = await oldManualBackups(1);
    await abandonBackup(h, dataDir, { backupId: id!, error: new Error('late'), now: Date.now(), log: silent, notify: true });
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('ok');
    expect(await exists(path.join(backupDir(id!), 'tables'))).toBe(true);
    expect(await notifications('backup.failed')).toEqual([]);
  });

  /** A blob no manifest names (`backups/blobs/<sha256>`). */
  async function unusedBlob(): Promise<string> {
    const p = path.join(dataDir, 'backups', 'blobs', 'a'.repeat(64));
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, 'x');
    return p;
  }
  /** The files cleanup (housekeeping.files) run to its end. */
  const cleanup = () => cleanFiles(h, { dataDir, now: Date.now(), from: null, budgetLeft: () => true, owner: `job:${newId()}`, log: silent });
  /** backup:snapshot lapses (a lease's time passed since the job's last slice). */
  const lapse = () => h.db.updateTable('locks').set({ until: Date.now() - 1 }).where('name', '=', BACKUP_SNAPSHOT_LOCK).execute();

  // 1d T20-SNAPSHOT-HOLD-COUNTS-ATTEMPT: another snapshot backup (or the files cleanup) holding backup:snapshot is a
  // reason to wait, not a failure: the job's two attempts are kept for real failures.
  it('backup:snapshot held by another owner: each slice waits 60 s (queued, attempts 0, run_at = now + 60 000); once released the backup ends ok, not dead', async () => {
    const id = await put();
    const other = `job:${newId()}`;
    expect(await claimLock(h, BACKUP_SNAPSHOT_LOCK, other, 50_000)).toBe(true);
    const t0 = Date.now();
    for (let turn = 0; turn < 3; turn += 1) {
      const at = t0 + turn * 60_000;
      expect((await drive(id, { now: () => at })).map((r) => r.outcome)).toEqual(['waiting']);
      expect(await jobRow(id)).toMatchObject({ status: 'queued', attempts: 0, last_error: null, run_at: at + 60_000, lock_token: null });
      // Not before its time.
      expect(await drive(id, { now: () => at + 59_999 })).toEqual([]);
    }
    expect(await backupRows()).toEqual([]);
    expect(await h.db.selectFrom('locks').select('owner').where('name', '=', BACKUP_SNAPSHOT_LOCK).execute()).toEqual([{ owner: other }]);
    await releaseLock(h, BACKUP_SNAPSHOT_LOCK, other);
    const at = t0 + 3 * 60_000;
    const results = await drive(id, { now: () => at, budgetMs: 20_000 });
    expect(results.at(-1)?.outcome).toBe('succeeded');
    expect(await jobRow(id)).toMatchObject({ status: 'succeeded', attempts: 0 });
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('ok');
  });

  it('a job cancelled while queued (requestCancel) leaves no running backup: the files cleanup fails its row and removes its folder, copy included', async () => {
    const id = await put();
    await drive(id, { slices: 1 });
    expect((await jobRow(id)).status).toBe('queued');
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('running');
    if (sqlite) expect(await exists(path.join(backupDir(id), '.work', 'snapshot.sqlite'))).toBe(true);
    expect(await exists(backupDir(id))).toBe(true);
    // Cancelled at once: no slice of it runs again.
    expect(await withTx(h, (trx) => requestCancel(trx, id, Date.now()))).toBe('cancelled');
    await lapse();
    const blob = await unusedBlob();
    await cleanup();
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('failed');
    expect(await exists(backupDir(id))).toBe(false);
    // The blobs are collected again (no running row holds them back).
    expect(await exists(blob)).toBe(false);
    expect(await notifications('backup.failed')).toEqual([]);
  });

  it('a job made dead by a claim (its lease expired at the last attempt, claim (c)) leaves no running backup either', async () => {
    const id = await put();
    await drive(id, { slices: 1 });
    const t0 = Date.now();
    // Two processes claim the next slice and die in it (an OOM kill on the same big part); their heavy locks lapse.
    expect(await claimById(h, reg, id, { worker: 'w1', now: t0 })).not.toBeNull();
    await h.db.deleteFrom('locks').where('name', '=', HEAVY_LOCK).execute();
    expect(await claimById(h, reg, id, { worker: 'w2', now: t0 + LEASE_PAST_MS })).not.toBeNull();
    await h.db.deleteFrom('locks').where('name', '=', HEAVY_LOCK).execute();
    expect(await claimById(h, reg, id, { worker: 'w3', now: t0 + 2 * LEASE_PAST_MS })).toBeNull();
    expect(await jobRow(id)).toMatchObject({ status: 'dead', last_error: 'LEASE_EXPIRED_MAX_ATTEMPTS' });
    await lapse();
    await cleanup();
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('failed');
    expect(await exists(backupDir(id))).toBe(false);
  });

  it('the files cleanup leaves a live backup alone: one whose job is between slices, and every row while an op is active', async () => {
    const id = await put();
    await drive(id, { slices: 1 });
    await lapse(); // a cron-driven host: the lock lapses between the slices, the job is only queued
    const blob = await unusedBlob();
    await cleanup();
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('running');
    expect(await exists(backupDir(id))).toBe(true);
    expect(await exists(blob)).toBe(true); // a running backup's blobs may not be in a manifest yet
    const results = await drive(id, { budgetMs: 20_000 });
    expect(results.at(-1)?.outcome).toBe('succeeded');
    expect((await backupRows()).find((r) => r.id === id)?.status).toBe('ok');

    // A running row no job names, while an op is active (a frozen backup's row, a restore's pre_restore backup): left.
    const orphan = newId();
    await h.db
      .insertInto('backups')
      .values({ id: orphan, kind: 'manual', size: null, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: h.dialect, consistency: 'frozen', status: 'running', created_at: Date.now() })
      .execute();
    await fsp.mkdir(path.join(backupDir(orphan), 'tables'), { recursive: true });
    await ops.begin('backup', { type: 'system', id: null }, { kind: 'manual', includeFiles: false });
    await cleanup();
    expect((await backupRows()).find((r) => r.id === orphan)?.status).toBe('running');
    expect(await exists(backupDir(orphan))).toBe(true);
    // Once the op ended, it is an orphan.
    await ops.cancel({ type: 'system', id: null });
    await cleanup();
    expect((await backupRows()).find((r) => r.id === orphan)?.status).toBe('failed');
    expect(await exists(backupDir(orphan))).toBe(false);
  });

  it('startBackup with a fresh worker run → the snapshot job (one per unique key); with none → the frozen op', async () => {
    await withTx(h, (trx) => trx.deleteFrom('settings').where('key', 'like', 'system.run.%').execute());
    const base = { h, dataDir, runtime: 'pm2' as const, ops, kind: 'manual' as const, includeFiles: false, actor: { type: 'system' as const, id: null }, createdBy: null, uniqueKey: 'backup:manual' };
    const frozen = await startBackup({ ...base, now: Date.now() });
    expect(frozen).toMatchObject({ consistency: 'frozen' });
    expect(await readOpFile(dataDir)).toMatchObject({ kind: 'backup', state: 'frozen', params: { kind: 'manual', includeFiles: false } });
    await ops.cancel({ type: 'system', id: null });

    await h.db.insertInto('settings').values({ scope: 'instance', key: 'system.run.worker', value: String(Date.now()), updated_at: Date.now(), updated_by: null }).execute();
    const one = await startBackup({ ...base, now: Date.now() });
    const two = await startBackup({ ...base, now: Date.now() });
    expect(one).toMatchObject({ consistency: 'snapshot', existing: false });
    expect(two).toMatchObject({ consistency: 'snapshot', existing: true });
    expect((one as { jobId: string }).jobId).toBe((two as { jobId: string }).jobId);
    // A request with files never joins the live job without them (it would answer a backup without files): 409.
    const withFiles = await startBackup({ ...base, includeFiles: true, now: Date.now() }).catch((e: unknown) => e);
    expect(withFiles).toMatchObject({ code: 'OPS_BLOCKED_BY_BACKUP', status: 409 });
    expect(await h.db.selectFrom('jobs').select('id').where('type', '=', BACKUP_CREATE_JOB).execute()).toHaveLength(1);
    await withTx(h, (trx) => trx.deleteFrom('settings').where('key', 'like', 'system.run.%').execute());
  });
});
