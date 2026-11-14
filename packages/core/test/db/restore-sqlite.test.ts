import { fork, spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  PHASE1_MIGRATIONS,
  connect,
  connectSqliteFile,
  runMigrations,
  verifyAuditChain,
  withTx,
  type DbConfig,
  type DbHandle,
  type TableName,
} from '@altis/db';
import { dataPath, lockHostIdentity, processStartMs } from '@altis/platform';
import { newId } from '@altis/shared';
import { sql, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryResult, type RootOperationNode, type UnknownRow } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import type { BackupManifest } from '../../src/backup/manifest.js';
import { txCtx, type CoreLogger } from '../../src/context.js';
import { readDataEpoch, readMaintenance, type OpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpStatus, type OpsMachine } from '../../src/ops/machine.js';
import { loadTables } from '../../src/restore/load.js';
import { restoreKind, type SqliteSwap } from '../../src/restore/kind.js';
import { createSqliteSwap } from '../../src/restore/sqlite-swap.js';
import { readSettings, writeSettings } from '../../src/settings/service.js';
import {
  KEYRING,
  SESSION_KEY,
  SYSTEM,
  currentOp,
  loadedChecksums,
  liveChecksums,
  manifestChecksums,
  restoreParams,
  seedInstallation,
  serverBackup,
  silent,
} from '../fixtures/restore-support.js';

// A restore on SQLite (spec §9.10 "SQLite", decision C17; S19, S23, M45, P14; plan Task 25): the load and finalizing
// steps 1–3 run on `db/<opId>/restore.sqlite`, the live file untouched; finalizing step 4 swaps it into place under
// `tmp/sqlite.lock` once every process let go of `db/altis.sqlite` (the owners through their ops fence, this process
// through its own hooks), with the history rows the live file gained meanwhile copied over; a failure after the swap
// renames the files back. SQLite only: the other engines restore on a dedicated connection (Task 22's tests).

/**
 * In place of `renameRetry` (as the swap calls it) while set: a rename that `renameRetry` would give up on (an EBUSY
 * lasting past its 10 s), or a directory sync failing after the rename, without waiting the 10 s.
 */
const renameHook = vi.hoisted(() => ({ fn: null as ((from: string, to: string, actual: (from: string, to: string) => Promise<void>) => Promise<void>) | null }));

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return {
    ...actual,
    ensureHeadroom: async () => {},
    renameRetry: (from: Parameters<typeof actual.renameRetry>[0], to: Parameters<typeof actual.renameRetry>[1]) =>
      renameHook.fn === null ? actual.renameRetry(from, to) : renameHook.fn(from, to, (f, t) => actual.renameRetry(f as typeof from, t as typeof to)),
  };
});

/** How often `readPkBatch` ran: the swap's history copy (2b) reads releases_log and backups with it. */
const dbCalls = vi.hoisted(() => ({ readPkBatch: 0 }));

vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  return {
    ...actual,
    readPkBatch: (...args: Parameters<typeof actual.readPkBatch>) => {
      dbCalls.readPkBatch += 1;
      return actual.readPkBatch(...args);
    },
  };
});

/** A logger that keeps the messages it was given at warn level. */
function warnings(): CoreLogger & { warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    info() {},
    warn(msg) {
      warns.push(msg);
    },
    error() {},
  };
}

const engine = testDbContext();
const CONFIG: DbConfig = { dialect: 'sqlite' };
const INSTALL_ID = newId();
const children: ChildProcess[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A process that only sleeps: a pid that is alive and holds nothing. */
function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/**
 * A process that opens `file` with a node:sqlite connection of its own and keeps it, whatever any flag says: an owner
 * that never lets go (its connection keeps the file's -wal/-shm). Resolves once the connection has run `first` on the
 * file (in WAL mode).
 */
async function holder(file: string, first = 'select count(*) from schema_meta'): Promise<ChildProcess> {
  const script =
    `process.on('disconnect', () => process.exit(0));` +
    `import('node:sqlite').then(({ DatabaseSync }) => {` +
    `  const db = new DatabaseSync(${JSON.stringify(file)});` +
    `  db.exec('pragma journal_mode = wal');` +
    `  db.exec(${JSON.stringify(first)});` +
    `  process.send('open');` +
    `  setInterval(() => db.prepare('select 1').get(), 1000);` +
    `});`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('exit', (code, signal) => reject(new Error(`the holder exited (${String(code ?? signal)})`)));
  });
  return child;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.connected) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.disconnect();
      await exited;
    } else {
      await kill(child);
    }
  }
  renameHook.fn = null;
  vi.restoreAllMocks();
});

function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Throws on the first DELETE of `sessions` (a volatile table) once `armed.on` is set, then disarms itself. */
function failVolatileOnce(armed: { on: boolean }): KyselyPlugin {
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      const node = args.node as { kind: string; from?: { froms: { table?: { identifier: { name: string } } }[] } };
      if (armed.on && node.kind === 'DeleteQueryNode' && node.from?.froms[0]?.table?.identifier.name === 'sessions') {
        armed.on = false;
        throw new Error('armed failure after the swap');
      }
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return args.result;
    },
  };
}

/** A machine with the restore kind of this process: no live handle of its own, the op's connections closed on request. */
interface Rig {
  ops: OpsMachine;
  restarts: string[];
  advance(ms: number): void;
}

function rig(dataDir: string, swap: SqliteSwap, own: { reopen?(): Promise<void> } = {}): Rig {
  let offset = 0;
  const restarts: string[] = [];
  const ops: OpsMachine = createOpsMachine({
    dataDir,
    kinds: [
      restoreKind({
        dataDir,
        appVersion: '0.1.0',
        migrations: PHASE1_MIGRATIONS,
        sessionKey: () => SESSION_KEY,
        keyring: () => KEYRING,
        installId: INSTALL_ID,
        requestRestart: async (reason) => {
          restarts.push(reason);
        },
        sqliteSwap: swap,
        // What this process holds on the live file: the op's dedicated connection.
        sqliteOwn: { close: () => ops.close(), reopen: own.reopen ?? (async () => {}) },
      }),
    ],
    db: () => undefined,
    connect: () => connect(CONFIG, { runtime: 'standalone', purpose: 'cli', dataDir }),
    keyring: () => KEYRING,
    clock: () => Date.now() + offset,
    log: silent,
    snapshotBackupRunning: async () => false,
  });
  return {
    ops,
    restarts,
    advance(ms) {
      offset += ms;
    },
  };
}

/** Steps the op (each call `budgetMs`) until `until(op)` holds for op.json or the op ends; the last status. */
async function stepUntil(r: Rig, dataDir: string, until: (op: OpFile) => boolean = () => false, budgetMs = 20_000): Promise<OpStatus | null> {
  let status: OpStatus | null = null;
  for (let i = 0; i < 5000; i += 1) {
    status = await r.ops.step(budgetMs);
    if (status === null || status.terminal || status.needsAttention) break;
    if (until(await currentOp(dataDir))) break;
  }
  return status;
}

const finalStep = (op: OpFile): string | undefined => (op.params['final'] as { step?: string } | undefined)?.step;

describe.skipIf(!engine.available || engine.engine !== 'sqlite')(`SQLite restore: work file and swap [${engineLabel()}]`, () => {
  let root: string;
  let dataDir: string;

  beforeAll(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-restore-sqlite-')));
  });

  afterAll(async () => {
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
  });

  const live = (): string => path.join(dataDir, 'db', 'altis.sqlite');
  const dbNames = async (sub?: string): Promise<string[]> => (await fsp.readdir(path.join(dataDir, 'db', ...(sub === undefined ? [] : [sub])))).sort();
  const open = (): Promise<DbHandle> => connect(CONFIG, { runtime: 'standalone', purpose: 'cli', dataDir });

  /**
   * The installation: seeded, a server backup of it, then changed (another library name, a new user, a renamed
   * branch). Returns the backup and the checksums of the changed data (what the live file holds before the restore).
   */
  async function prepare(): Promise<{ backupId: string; manifest: BackupManifest; tables: TableName[]; before: Record<string, string> }> {
    const h = await open();
    try {
      await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
      await seedInstallation(h, { dataDir, installId: INSTALL_ID });
      const { backupId, manifest } = await serverBackup(h, { dataDir, installId: INSTALL_ID });
      const now = Date.now();
      await withTx(h, (trx) => writeSettings(trx, { 'library.name': 'Nama Baru' }, { keyring: KEYRING, now, actorId: null }));
      await h.db
        .insertInto('staff_users')
        .values({ id: newId(), username_key: 'baru', username_display: 'baru', name: 'Baru', password_hash: 'x', status: 'active', created_at: now, updated_at: now })
        .execute();
      await h.db.updateTable('branches').set({ name: 'Diubah' }).execute();
      const tables = loadTables(manifest).filter((t) => t !== 'notifications') as TableName[];
      return { backupId, manifest, tables, before: await liveChecksums(h, tables) };
    } finally {
      await h.close();
    }
  }

  async function begin(r: Rig, backupId: string): Promise<string> {
    const { opId } = await r.ops.begin('restore', SYSTEM, restoreParams(backupId));
    r.advance(4000); // past the freeze's settle time
    return opId;
  }

  /** The restored live file: the backup's checksums, and the restart of P14. */
  async function expectRestored(manifest: BackupManifest, r: Rig): Promise<void> {
    const h = await open();
    try {
      expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
      expect((await readSettings(h.db, ['library.name'], []))['library.name']).toBe('Perpustakaan Arsya');
      expect((await verifyAuditChain(h)).ok).toBe(true);
    } finally {
      await h.close();
    }
    expect(r.restarts).toEqual(['restore']);
    expect(await readMaintenance(dataDir)).toBeNull();
  }

  it('loads into db/<opId>/restore.sqlite with the live file untouched, swaps it in checkpointed, keeps the old file', async () => {
    const { backupId, manifest, tables, before } = await prepare();
    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent }));
    const opId = await begin(r, backupId);

    // Loaded and migrated: the work file holds the restore, a read-only handle on the live file sees the old data.
    await stepUntil(r, dataDir, (op) => op.state === 'finalizing', 1);
    expect(await dbNames(opId)).toContain('restore.sqlite');
    expect(await dbNames(opId)).not.toContain('pre-restore.sqlite');
    const ro = await connectSqliteFile(dataPath(dataDir, 'db', 'altis.sqlite'), { readOnly: true });
    try {
      expect(await liveChecksums(ro, tables)).toEqual(before);
    } finally {
      await ro.close();
    }

    // Right after the swap (one handler step at a time): no -wal/-shm beside the new live file, the old one kept.
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'volatile', 1);
    expect(await dbNames()).toEqual([opId, 'altis.sqlite']);
    expect(await dbNames(opId)).toEqual(['pre-restore.sqlite']);
    expect((await readMaintenance(dataDir))?.sqliteRelease ?? null).toBeNull();

    const status = await stepUntil(r, dataDir);
    expect(status).toMatchObject({ opId, state: 'done', terminal: true, error: null });
    await expectRestored(manifest, r);
    const pre = await connectSqliteFile(dataPath(dataDir, 'db', opId, 'pre-restore.sqlite'));
    try {
      expect(await liveChecksums(pre, tables)).toEqual(before);
    } finally {
      await pre.close();
    }
  }, 120_000);

  it('a serving process releases its file within 2 s of sqliteRelease, reopens after the epoch bump, serves the restored data and restarts', async () => {
    const { backupId, manifest } = await prepare();
    const epoch = await readDataEpoch(dataDir);
    const child = fork(path.join(import.meta.dirname, '../fixtures/sqlite-owner-child.mjs'), [JSON.stringify({ dataDir })], {
      cwd: path.resolve(import.meta.dirname, '../../../..'),
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    children.push(child);
    const messages: Record<string, unknown>[] = [];
    child.on('message', (m) => messages.push(m as Record<string, unknown>));
    const port = await vi.waitFor(
      () => {
        const m = messages.find((x) => typeof x['port'] === 'number');
        if (m === undefined) throw new Error('the owner child is not listening yet');
        return m['port'] as number;
      },
      { timeout: 20_000, interval: 50 },
    );
    const ownerFile = path.join(dataDir, 'tmp', 'sqlite-owner.json');
    expect(JSON.parse(await fsp.readFile(ownerFile, 'utf8'))).toMatchObject({ pid: child.pid });
    expect(JSON.parse((await get(port, '/name')).body)).toEqual({ name: 'Nama Baru' });

    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent }));
    await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);

    // The swap step, watched: when sqliteRelease appears in maintenance.json.
    let askedAt: number | null = null;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const flag = await readMaintenance(dataDir).catch(() => null);
        if (askedAt === null && typeof flag?.sqliteRelease === 'string') askedAt = Date.now();
        await sleep(10);
      }
    })();
    // One handler step at a time (R1c-11: each step waits for the owner no longer than its own deadline).
    await stepUntil(r, dataDir, (op) => finalStep(op) !== 'swap', 1);
    watching = false;
    await watcher;
    expect(finalStep(await currentOp(dataDir))).toBe('volatile');
    const released = messages.find((m) => typeof m['released'] === 'number');
    expect(askedAt).not.toBeNull();
    expect(released).toBeDefined();
    // The fence looks at most every 2 s; the worker loop's pass adds up to 100 ms, the watcher 10 ms.
    expect((released!['released'] as number) - askedAt!).toBeLessThanOrEqual(2200);
    expect(messages.filter((m) => 'reopened' in m)).toEqual([]);

    const status = await stepUntil(r, dataDir);
    expect(status).toMatchObject({ state: 'done' });
    await expectRestored(manifest, r);
    await vi.waitFor(
      () => {
        expect(messages.find((m) => 'reopened' in m)).toMatchObject({ epoch: epoch + 1 });
        expect(messages.find((m) => 'restart' in m)).toMatchObject({ restart: 'data-epoch' });
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(JSON.parse(await fsp.readFile(ownerFile, 'utf8'))).toMatchObject({ pid: child.pid });
    expect(JSON.parse((await get(port, '/name')).body)).toEqual({ name: 'Perpustakaan Arsya' });
  }, 120_000);

  it('an owner that never lets go of the file: the step waits out the budget, then the file itself keeps the swap waiting, the op unchanged; it swaps once the owner is gone (S19, R1c-11)', async () => {
    const { backupId, manifest } = await prepare();
    const stub = await holder(live());
    const ownerFile = path.join(dataDir, 'tmp', 'sqlite-owner.json');
    await fsp.mkdir(path.dirname(ownerFile), { recursive: true });
    await fsp.writeFile(ownerFile, JSON.stringify({ pid: stub.pid, startMs: Date.now(), host: lockHostIdentity() }));

    const log = warnings();
    const r = rig(dataDir, createSqliteSwap({ dataDir, log, releaseWaitMs: 300 }));
    const opId = await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);
    const before = await currentOp(dataDir);
    const started = performance.now();
    const status = await r.ops.step(20_000);
    expect(performance.now() - started).toBeGreaterThanOrEqual(300);
    expect(status).toMatchObject({ state: 'finalizing', terminal: false });
    // Unchanged but for the heartbeat and when the wait for the owners began (R1c-11).
    const after = await currentOp(dataDir);
    const since = (after.params['final'] as { releaseWaitSince?: unknown }).releaseWaitSince;
    expect(since).toEqual(expect.any(Number));
    const final = before.params['final'] as Record<string, unknown>;
    expect({ ...after, heartbeatAt: 0 }).toEqual({ ...before, heartbeatAt: 0, params: { ...before.params, final: { ...final, releaseWaitSince: since } } });
    expect((await readMaintenance(dataDir))?.sqliteRelease).toBe(opId);
    expect(await dbNames(opId)).toEqual(['restore.sqlite']);
    expect(await dbNames()).toEqual(expect.arrayContaining(['altis.sqlite-shm', 'altis.sqlite-wal'])); // the holder's

    // The budget is spent: the owner, still alive, no longer counts; its connection on the file still does. That the
    // budget ran out is said once; a later step that cannot swap says why once and copies no history (2b): it only
    // looks at the live file.
    expect(log.warns.filter((m) => m.includes('did not let go in time'))).toHaveLength(1);
    log.warns.length = 0;
    const copies = dbCalls.readPkBatch;
    await r.ops.step(20_000);
    expect(log.warns).toEqual(['sqlite swap: a connection is still on the database file; the swap is tried again on a later step']);
    expect(dbCalls.readPkBatch).toBe(copies);
    expect(finalStep(await currentOp(dataDir))).toBe('swap');
    expect((await currentOp(dataDir)).params['final']).toMatchObject({ releaseWaitSince: since });

    await kill(stub);
    await r.ops.step(1);
    expect(finalStep(await currentOp(dataDir))).toBe('volatile');
    await expect(fsp.stat(ownerFile)).rejects.toMatchObject({ code: 'ENOENT' }); // a dead owner's record goes
    expect(await stepUntil(r, dataDir)).toMatchObject({ state: 'done' });
    await expectRestored(manifest, r);
  }, 120_000);

  it('the wait for an owner ends at each step’s deadline (P9); the budget runs across steps from the first wait, then an owner still alive (a reused pid) leaves it to the file (R1c-11)', async () => {
    const { backupId, manifest } = await prepare();
    const stub = sleeper(); // alive, and holds nothing: a crashed owner's pid taken by another process
    const ownerFile = path.join(dataDir, 'tmp', 'sqlite-owner.json');
    await fsp.mkdir(path.dirname(ownerFile), { recursive: true });
    await fsp.writeFile(ownerFile, JSON.stringify({ pid: stub.pid, startMs: Date.now(), host: lockHostIdentity() }));

    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent, releaseWaitMs: 2500 }));
    await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);

    // A step of 1.8 s waits until its deadline less the kind's 1 s margin, not the 2.5 s budget.
    const first = performance.now();
    await r.ops.step(1800);
    const firstMs = performance.now() - first;
    expect(firstMs).toBeGreaterThanOrEqual(700);
    expect(firstMs).toBeLessThan(2000);
    const since = ((await currentOp(dataDir)).params['final'] as { releaseWaitSince?: unknown }).releaseWaitSince;
    expect(since).toEqual(expect.any(Number));
    expect(finalStep(await currentOp(dataDir))).toBe('swap');

    // The next step goes on with the same budget (counted from the first wait), and stops at its deadline too.
    const second = performance.now();
    await r.ops.step(1800);
    expect(performance.now() - second).toBeLessThan(2000);
    expect((await currentOp(dataDir)).params['final']).toMatchObject({ step: 'swap', releaseWaitSince: since });

    // Once the budget is spent the owner, though alive, holds no connection on the file: the swap goes ahead, and its
    // record goes (a later swap or rename back does not wait for it again).
    expect(await stepUntil(r, dataDir)).toMatchObject({ state: 'done' });
    expect(performance.now() - first).toBeGreaterThanOrEqual(2500);
    expect(stub.exitCode === null && stub.signalCode === null).toBe(true);
    await expect(fsp.stat(ownerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectRestored(manifest, r);
  }, 120_000);

  it('an owner record of another host identity (a recreated container) is waited for, then the file itself decides', async () => {
    const { backupId, manifest } = await prepare();
    const ownerFile = path.join(dataDir, 'tmp', 'sqlite-owner.json');
    await fsp.mkdir(path.dirname(ownerFile), { recursive: true });
    await fsp.writeFile(ownerFile, JSON.stringify({ pid: 1, startMs: Date.now(), host: 'another-container/boot/pid:[1]' }));

    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent, releaseWaitMs: 300 }));
    await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);
    const started = performance.now();
    await stepUntil(r, dataDir, (op) => finalStep(op) !== 'swap', 1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(300);
    expect(finalStep(await currentOp(dataDir))).toBe('volatile'); // nothing was on the file: swapped
    await expect(fsp.stat(ownerFile)).rejects.toMatchObject({ code: 'ENOENT' }); // and the record names no holder
    expect(await stepUntil(r, dataDir)).toMatchObject({ state: 'done' });
    await expectRestored(manifest, r);
  }, 120_000);

  it('audit entries written to the live file after preserving are in the restored file (M45)', async () => {
    const { backupId, manifest } = await prepare();
    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent }));
    await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => op.state === 'loading', 1);
    expect((await currentOp(dataDir)).pointOfNoReturn).toBe(true);

    // Another process's audit entries meanwhile (an ops takeover, a cancel attempt, ...), on the live file.
    const w = await open();
    let ids: string[];
    try {
      ids = await withTx(w, async (trx) => {
        const out: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const at = Date.now();
          await txCtx(trx, at, { type: 'system', id: null, ip: null }).audit({ action: 'ops.takeover', entity: 'ops', entityId: null, meta: { i } });
        }
        const rows = await trx.selectFrom('audit_log').select('id').where('action', '=', 'ops.takeover').execute();
        for (const row of rows) out.push(row.id);
        return out;
      });
    } finally {
      await w.close();
    }
    expect(ids).toHaveLength(5);

    expect(await stepUntil(r, dataDir)).toMatchObject({ state: 'done' });
    await expectRestored(manifest, r);
    const h = await open();
    try {
      const restored = await h.db.selectFrom('audit_log').select('id').where('action', '=', 'ops.takeover').execute();
      expect(restored.map((row) => row.id).sort()).toEqual([...ids].sort());
      const head = await h.db.selectFrom('audit_head').select('last_seq').executeTakeFirstOrThrow();
      const top = await h.db.selectFrom('audit_log').select('seq').orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
      expect(Number(head.last_seq)).toBe(Number(top.seq));
      const last = await h.db.selectFrom('audit_log').select('action').where('seq', '=', top.seq).executeTakeFirstOrThrow();
      expect(last.action).toBe('backup.restore');
    } finally {
      await h.close();
    }
  }, 120_000);

  it('connect is refused while another process holds tmp/sqlite.lock; the holder itself and a dead holder’s record are no bar', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    const lockFile = path.join(dataDir, 'tmp', 'sqlite.lock');
    const holder = sleeper();
    await fsp.writeFile(lockFile, JSON.stringify({ pid: holder.pid, startMs: Date.now(), token: 'held', host: lockHostIdentity() }));
    for (const purpose of ['cli', 'server'] as const) {
      await expect(connect(CONFIG, { runtime: 'standalone', purpose, dataDir })).rejects.toMatchObject({
        code: 'DB_UNAVAILABLE',
        meta: { reason: 'sqlite_swap' },
      });
    }
    await expect(fsp.stat(path.join(dataDir, 'tmp', 'sqlite-owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    // The holder itself may open the files it swaps.
    await fsp.writeFile(lockFile, JSON.stringify({ pid: process.pid, startMs: processStartMs(), token: 'mine', host: lockHostIdentity() }));
    await (await open()).close();

    // A holder that is gone holds nothing.
    await fsp.writeFile(lockFile, JSON.stringify({ pid: holder.pid, startMs: Date.now(), token: 'held', host: lockHostIdentity() }));
    await kill(holder);
    const server = await connect(CONFIG, { runtime: 'standalone', purpose: 'server', dataDir });
    expect(JSON.parse(await fsp.readFile(path.join(dataDir, 'tmp', 'sqlite-owner.json'), 'utf8'))).toMatchObject({ pid: process.pid });
    await server.close();
    await expect(fsp.stat(path.join(dataDir, 'tmp', 'sqlite-owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a full disk while the work file loads its tables (SQLITE_FULL) fails the op with DISK_QUOTA and disk_low; the work file goes (P21)', async () => {
    // More rows than the tables' first pages hold: the load must grow the work file.
    const h0 = await open();
    let backupId: string;
    let tables: TableName[];
    let before: Record<string, string>;
    try {
      await runMigrations(h0, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
      await seedInstallation(h0, { dataDir, installId: INSTALL_ID });
      const now = Date.now();
      for (let i = 0; i < 300; i += 1) {
        const id = newId();
        await h0.db
          .insertInto('branches')
          .values({ id, code_key: id, code_display: id, name: `Cabang ${'x'.repeat(100)} ${i}`, address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: now, created_by: null, updated_at: now, updated_by: null })
          .execute();
      }
      const backup = await serverBackup(h0, { dataDir, installId: INSTALL_ID });
      backupId = backup.backupId;
      await h0.db.updateTable('branches').set({ name: 'Diubah' }).execute();
      tables = loadTables(backup.manifest).filter((t) => t !== 'notifications') as TableName[];
      before = await liveChecksums(h0, tables);
    } finally {
      await h0.close();
    }
    const base = createSqliteSwap({ dataDir, log: silent });
    let work: DbHandle | null = null;
    const swap: SqliteSwap = {
      ...base,
      async openWork(opId) {
        work = await base.openWork(opId);
        return work;
      },
    };
    const r = rig(dataDir, swap);
    const opId = await begin(r, backupId);
    // Dropped and migrated: from here on the work file may not grow (as a disk that is full).
    await stepUntil(r, dataDir, (op) => op.state === 'loading' && (op.params['load'] as { migrated?: boolean } | undefined)?.migrated === true, 1);
    expect(work).not.toBeNull();
    const pages = await sql<{ page_count: number }>`pragma page_count`.execute(work!.db);
    await sql`pragma max_page_count = ${sql.lit(Number(pages.rows[0]!.page_count))}`.execute(work!.db);

    const status = await stepUntil(r, dataDir, () => false, 1);
    expect(status).toMatchObject({ opId, state: 'failed', terminal: true, error: { code: 'DISK_QUOTA' } });
    expect(await dbNames(opId).catch(() => [])).not.toContain('restore.sqlite');
    const h = await open();
    try {
      expect(await liveChecksums(h, tables)).toEqual(before);
      const notes = await h.db.selectFrom('notifications').select('type').where('type', 'in', ['disk.low', 'restore.failed']).execute();
      expect(notes.map((n) => n.type)).toEqual(['disk.low']);
      const outcome = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').execute();
      expect(outcome.map((row) => JSON.parse(row.meta) as Record<string, unknown>)).toMatchObject([{ outcome: 'failed', error: 'DISK_QUOTA' }]);
    } finally {
      await h.close();
    }
    expect(await readMaintenance(dataDir)).toBeNull();
  }, 120_000);

  it('a failure after the swap renames the files back: the live file holds the pre-restore data, the op ends failed', async () => {
    const { backupId, tables, before } = await prepare();
    const epoch = await readDataEpoch(dataDir);
    const base = createSqliteSwap({ dataDir, log: silent });
    const armed = { on: false };
    const swap: SqliteSwap = {
      ...base,
      async openWork(opId) {
        const h = await base.openWork(opId);
        return { ...h, db: h.db.withPlugin(failVolatileOnce(armed)) };
      },
    };
    const r = rig(dataDir, swap);
    const opId = await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'volatile', 1);
    armed.on = true; // finalizing step 5, on the swapped-in file

    const status = await stepUntil(r, dataDir);
    expect(armed.on).toBe(false);
    expect(status).toMatchObject({ state: 'failed', terminal: true, error: { code: 'INTERNAL' } });
    expect(await dbNames(opId)).toEqual(['altis.sqlite']); // the restored file, kept beside the op
    const h = await open();
    try {
      expect(await liveChecksums(h, tables)).toEqual(before);
      const outcome = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').execute();
      expect(outcome.map((row) => (JSON.parse(row.meta) as { outcome: string }).outcome)).toEqual(['failed']);
    } finally {
      await h.close();
    }
    expect(await readDataEpoch(dataDir)).toBe(epoch + 1);
    expect(await readMaintenance(dataDir)).toBeNull();
  }, 120_000);

  /** The live file after a failed restore: the pre-restore data, one `backup.restore` outcome `failed`. */
  async function expectPreRestore(tables: TableName[], before: Record<string, string>): Promise<void> {
    const h = await open();
    try {
      expect(await liveChecksums(h, tables)).toEqual(before);
      const outcome = await h.db.selectFrom('audit_log').select('meta').where('action', '=', 'backup.restore').execute();
      expect(outcome.map((row) => (JSON.parse(row.meta) as { outcome: string }).outcome)).toEqual(['failed']);
    } finally {
      await h.close();
    }
    expect(await readMaintenance(dataDir)).toBeNull();
  }

  it('a failure in the swap after its renames (step 5) is judged by the files: rename back, the op ends failed on the pre-restore data (R1c-11)', async () => {
    const { backupId, tables, before } = await prepare();
    const epoch = await readDataEpoch(dataDir);
    const armed = { on: false };
    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent }), {
      async reopen() {
        if (!armed.on) return;
        armed.on = false;
        throw new Error('armed failure after the renames');
      },
    });
    const opId = await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);
    armed.on = true; // this process's reopen, the last thing the swap does

    const status = await stepUntil(r, dataDir);
    expect(armed.on).toBe(false);
    expect(status).toMatchObject({ state: 'failed', terminal: true, error: { code: 'INTERNAL' } });
    expect(await dbNames(opId)).toEqual(['altis.sqlite']); // the restored file, kept beside the op
    await expectPreRestore(tables, before);
    expect(await readDataEpoch(dataDir)).toBe(epoch + 1);
    expect(r.restarts).toEqual(['restore']);
  }, 120_000);

  it('the rename back waits for an owner like the swap: waiting with the wait’s start in the replay checkpoint, then done once it is gone (R1c-11)', async () => {
    const { backupId, tables, before } = await prepare();
    const armed = { on: false };
    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent, releaseWaitMs: 300 }), {
      async reopen() {
        if (!armed.on) return;
        armed.on = false;
        throw new Error('armed failure after the renames');
      },
    });
    const opId = await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);
    armed.on = true;
    await stepUntil(r, dataDir, (op) => op.state === 'failed_restoring_pre', 1);
    expect((await currentOp(dataDir)).params['replay']).toMatchObject({ phase: 'rename_back' });

    // An owner on the restored live file that never lets go.
    const stub = await holder(live());
    const ownerFile = path.join(dataDir, 'tmp', 'sqlite-owner.json');
    await fsp.writeFile(ownerFile, JSON.stringify({ pid: stub.pid, startMs: Date.now(), host: lockHostIdentity() }));
    const status = await r.ops.step(20_000);
    expect(status).toMatchObject({ state: 'failed_restoring_pre', terminal: false });
    const replay = (await currentOp(dataDir)).params['replay'] as { phase: string; final: { releaseWaitSince?: unknown } };
    expect(replay.phase).toBe('rename_back');
    expect(replay.final.releaseWaitSince).toEqual(expect.any(Number));
    expect((await readMaintenance(dataDir))?.sqliteRelease).toBe(opId);
    expect(await dbNames(opId)).toEqual(['pre-restore.sqlite']);

    await kill(stub);
    expect(await stepUntil(r, dataDir)).toMatchObject({ state: 'failed', terminal: true });
    expect(await dbNames(opId)).toEqual(['altis.sqlite']);
    await expectPreRestore(tables, before);
  }, 120_000);

  it('a swap interrupted between its renames whose finishing rename then fails goes back through rename_back too (R1c-11)', async () => {
    const { backupId, tables, before } = await prepare();
    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent }));
    const opId = await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);
    await r.ops.close();

    // As a crash between the two renames leaves it: the live file already moved aside, the work file not yet in place.
    const work = path.join(dataDir, 'db', opId, 'restore.sqlite');
    await fsp.rename(live(), path.join(dataDir, 'db', opId, 'pre-restore.sqlite'));
    // The rename that finishes the swap fails for good (not a busy file: not retried).
    const rename = fsp.rename;
    let refused = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === work && String(to) === live() && refused === 0) {
        refused += 1;
        throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
      }
      return rename(from, to);
    });

    const status = await stepUntil(r, dataDir);
    expect(refused).toBe(1);
    expect(status).toMatchObject({ state: 'failed', terminal: true });
    expect(await dbNames(opId)).toEqual(['altis.sqlite']); // the work file, kept beside the op as the restored one
    await expectPreRestore(tables, before);
  }, 120_000);

  it('a swap interrupted between its renames is finished over the file a connect made meanwhile only once no connection is left on it', async () => {
    const { backupId, manifest } = await prepare();
    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent }));
    const opId = await begin(r, backupId);
    await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);
    await r.ops.close();
    // As a crash between the two renames leaves it: the live file already moved aside, the work file not yet in place.
    await fsp.rename(live(), path.join(dataDir, 'db', opId, 'pre-restore.sqlite'));
    // Meanwhile another process connected (making a new altis.sqlite), wrote to it and keeps its connection.
    const stub = await holder(live(), 'create table if not exists t (x integer)');
    expect(await dbNames()).toEqual(expect.arrayContaining(['altis.sqlite-shm', 'altis.sqlite-wal']));

    // Its connection keeps the swap waiting: the work file is not renamed over a file in use (whose -wal/-shm would
    // then sit beside the restored file).
    expect(await r.ops.step(1)).toMatchObject({ state: 'finalizing', terminal: false });
    expect(finalStep(await currentOp(dataDir))).toBe('swap');
    expect(await dbNames(opId)).toEqual(['pre-restore.sqlite', 'restore.sqlite']);

    // Once it is gone, the swap is finished: nothing of the replaced file is left beside the restored one.
    await kill(stub);
    await stepUntil(r, dataDir, (op) => finalStep(op) !== 'swap', 1);
    expect(finalStep(await currentOp(dataDir))).toBe('volatile');
    expect(await dbNames()).toEqual([opId, 'altis.sqlite']);
    expect(await dbNames(opId)).toEqual(['pre-restore.sqlite']);
    expect(await stepUntil(r, dataDir)).toMatchObject({ state: 'done' });
    await expectRestored(manifest, r);
  }, 120_000);

  it('a rename refused with EBUSY twice (Windows) is retried and the swap completes', async () => {
    const { backupId, manifest } = await prepare();
    const rename = fsp.rename;
    let refused = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === live() && refused < 2) {
        refused += 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
      }
      return rename(from, to);
    });
    const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent }));
    await begin(r, backupId);
    expect(await stepUntil(r, dataDir)).toMatchObject({ state: 'done' });
    expect(refused).toBe(2);
    await expectRestored(manifest, r);
  }, 120_000);

  it.each([
    ['the first rename (altis.sqlite aside) fails with EIO', 'eio-first'],
    ['the first rename stays refused with EBUSY past renameRetry’s 10 s', 'ebusy-first'],
    ['the second rename stays refused with EBUSY and the first goes back', 'ebusy-second'],
  ] as const)(
    'a swap whose renames leave the live file in place (%s): the flag goes down, this process reopens its handle, the next step swaps (R1c-11)',
    async (_label, how) => {
      const { backupId, manifest } = await prepare();
      let reopens = 0;
      const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent }), {
        async reopen() {
          reopens += 1;
        },
      });
      const opId = await begin(r, backupId);
      await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);
      const pre = path.join(dataDir, 'db', opId, 'pre-restore.sqlite');
      const work = path.join(dataDir, 'db', opId, 'restore.sqlite');
      let refused = 0;
      if (how === 'eio-first') {
        const rename = fsp.rename;
        vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
          if (String(from) === live() && String(to) === pre && refused === 0) {
            refused += 1;
            throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
          }
          return rename(from, to);
        });
      } else {
        const [refusedFrom, refusedTo] = how === 'ebusy-first' ? [live(), pre] : [work, live()];
        renameHook.fn = async (from, to, actual) => {
          if (from === refusedFrom && to === refusedTo && refused === 0) {
            refused += 1;
            throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
          }
          return actual(from, to);
        };
      }

      // The step fails as a database being swapped does (transient): the op stays at the swap, its work file kept, the
      // live file in place and open again in this process.
      await expect(r.ops.step(20_000)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'sqlite_swap' } });
      expect(refused).toBe(1);
      expect(reopens).toBe(1);
      expect((await readMaintenance(dataDir))?.sqliteRelease ?? null).toBeNull();
      const op = await currentOp(dataDir);
      expect(op.state).toBe('finalizing');
      expect(finalStep(op)).toBe('swap');
      expect(await dbNames(opId)).toEqual(['restore.sqlite']);
      expect(await dbNames()).toContain('altis.sqlite');

      // The next step swaps.
      expect(await stepUntil(r, dataDir)).toMatchObject({ state: 'done' });
      expect(reopens).toBe(2);
      await expectRestored(manifest, r);
    },
    60_000,
  );

  it.each(['first', 'second'] as const)(
    'a %s rename of the swap that went through but whose directory sync failed: this process’s handle stays closed, rename back, the op ends failed (R1c-11)',
    async (which) => {
      const { backupId, tables, before } = await prepare();
      let reopens = 0;
      const r = rig(dataDir, createSqliteSwap({ dataDir, log: silent }), {
        async reopen() {
          reopens += 1;
        },
      });
      const opId = await begin(r, backupId);
      await stepUntil(r, dataDir, (op) => finalStep(op) === 'swap', 1);
      const [syncFrom, syncTo] =
        which === 'first' ? [live(), path.join(dataDir, 'db', opId, 'pre-restore.sqlite')] : [path.join(dataDir, 'db', opId, 'restore.sqlite'), live()];
      let failed = 0;
      renameHook.fn = async (from, to, actual) => {
        await actual(from, to);
        if (from === syncFrom && to === syncTo && failed === 0) {
          failed += 1;
          throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
        }
      };

      expect(await r.ops.step(1)).toMatchObject({ state: 'failed_restoring_pre', terminal: false });
      expect(failed).toBe(1);
      expect(reopens).toBe(0); // with the live file moved aside, a reopen could make an empty altis.sqlite
      expect(await stepUntil(r, dataDir)).toMatchObject({ state: 'failed', terminal: true });
      expect(reopens).toBe(0);
      expect(await dbNames(opId)).toEqual(['altis.sqlite']); // the restored file, kept beside the op
      await expectPreRestore(tables, before);
      expect(r.restarts).toEqual(['restore']);
    },
    60_000,
  );
});
