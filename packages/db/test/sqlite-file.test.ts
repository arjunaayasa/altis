import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dataPath, listNames, resetTestFaults, type DataPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { sql, type KyselyPlugin } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, type DbHandle } from '../src/connect.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';
import { checkpointSqliteFile, connectSqliteFile, sqliteSnapshotTo, sqliteSnapshotWith } from '../src/sqlite-file.js';
import { withTx } from '../src/tx.js';

// SQLite copies (spec §9.9 snapshot on SQLite, §9.10 restore work file; S14): a handle on another SQLite file of
// DATA_DIR, and a consistent copy of a live SQLite database through node:sqlite's backup() (or VACUUM INTO). These
// tests open their own SQLite database in a temporary DATA_DIR, whatever engine ALTIS_TEST_DB names.

function branch(code: string) {
  return { id: newId(), code_key: code, code_display: code, name: code, address: null, timezone: 'Asia/Jakarta', created_at: 1, updated_at: 1 };
}

describe('SQLite files: connectSqliteFile and sqliteSnapshotTo', () => {
  let dataDir: string;
  let source: DbHandle;
  const opened: DbHandle[] = [];

  /** A handle that afterEach closes. */
  async function open(p: DataPath, o?: { readOnly?: boolean; create?: boolean }): Promise<DbHandle> {
    const h = await connectSqliteFile(p, o);
    opened.push(h);
    return h;
  }

  /** `backups/<new id>/.work/snapshot.sqlite`, whose folders do not exist yet. */
  const snapshotPath = () => dataPath(dataDir, 'backups', newId(), '.work', 'snapshot.sqlite');

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-sqlite-file-'));
    source = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'server', dataDir });
    await runMigrations(source, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    for (const code of ['A', 'B', 'C']) await source.db.insertInto('branches').values(branch(code)).execute();
  });

  afterEach(async () => {
    for (const h of opened.splice(0)) await h.close();
  });

  afterAll(async () => {
    await source?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it.each(['backup', 'vacuum'] as const)(
    'copies a database with 3 branches (%s); the copy opens read-only, reads 3 rows and refuses an insert',
    async (method) => {
      const dest = snapshotPath();
      await sqliteSnapshotWith(source, dest, method);
      const copy = await open(dest, { readOnly: true });
      expect(copy.dialect).toBe('sqlite');
      expect(copy.poolSize).toBe(1);
      expect((await copy.db.selectFrom('branches').select('code_key').orderBy('code_key').execute()).map((r) => r.code_key)).toEqual([
        'A',
        'B',
        'C',
      ]);
      await expect(copy.db.insertInto('branches').values(branch('D')).execute()).rejects.toThrow();
      expect((await sql<{ integrity_check: string }>`PRAGMA integrity_check`.execute(copy.db)).rows).toEqual([{ integrity_check: 'ok' }]);
      await copy.close();
      // One self-contained file (rollback journal): no -wal/-shm left beside it, not even after a read-only open.
      expect(await listNames(dataPath(dataDir, 'backups', path.basename(path.dirname(path.dirname(dest))), '.work'))).toEqual([
        'snapshot.sqlite',
      ]);
    },
  );

  it('sqliteSnapshotTo uses backup() when node:sqlite has it, and replaces an older copy at the same path', async () => {
    const dest = snapshotPath();
    await sqliteSnapshotTo(source, dest);
    const first = await open(dest, { readOnly: true });
    expect(await first.db.selectFrom('branches').select('id').execute()).toHaveLength(3);
    await first.close();
    await source.db.insertInto('branches').values(branch('D')).execute();
    try {
      await sqliteSnapshotTo(source, dest);
      const second = await open(dest, { readOnly: true });
      expect(await second.db.selectFrom('branches').select('id').execute()).toHaveLength(4);
    } finally {
      await source.db.deleteFrom('branches').where('code_key', '=', 'D').execute();
    }
  });

  it('backup() returns promptly on an idle event loop, also after writes (its promise settles without waking the loop)', async () => {
    // node:sqlite's backup() settles its promise without waking the event loop: on a loop that only waits (here the
    // test worker's IPC channel; in a server, a quiet night) the caller would resume only at the next unrelated event,
    // seconds or minutes later.
    try {
      for (const code of ['S1', 'S2', 'S3']) {
        const started = performance.now();
        await sqliteSnapshotWith(source, snapshotPath(), 'backup');
        expect(performance.now() - started).toBeLessThan(2000);
        await source.db.insertInto('branches').values(branch(code)).execute();
      }
    } finally {
      await source.db.deleteFrom('branches').where('code_key', 'in', ['S1', 'S2', 'S3']).execute();
    }
  });

  it('a write through the copied handle while the copy runs leaves a consistent copy (M31)', async () => {
    const dest = snapshotPath();
    const writes = (async () => {
      for (const code of ['W1', 'W2', 'W3']) await source.db.insertInto('branches').values(branch(code)).execute();
    })();
    try {
      await Promise.all([sqliteSnapshotTo(source, dest), writes]);
      const copy = await open(dest, { readOnly: true });
      expect((await sql`PRAGMA integrity_check`.execute(copy.db)).rows).toEqual([{ integrity_check: 'ok' }]);
      const codes = (await copy.db.selectFrom('branches').select('code_key').orderBy('code_key').execute()).map((r) => r.code_key);
      // Whole transactions only: the three branches, plus a prefix of the writes.
      expect([['A', 'B', 'C'], ['A', 'B', 'C', 'W1'], ['A', 'B', 'C', 'W1', 'W2'], ['A', 'B', 'C', 'W1', 'W2', 'W3']]).toContainEqual(codes);
    } finally {
      await source.db.deleteFrom('branches').where('code_key', 'in', ['W1', 'W2', 'W3']).execute();
    }
  });

  it.each(['backup', 'vacuum'] as const)(
    'a transaction of the copied handle open when the copy starts (a request between its statements): the copy waits for it (%s)',
    async (method) => {
      // node:sqlite's backup() fails ("not an error") when one of its steps meets a write transaction open on the
      // connection it copies; the server's transactions hold that one connection across awaits.
      const dest = snapshotPath();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let inside!: () => void;
      const entered = new Promise<void>((resolve) => (inside = resolve));
      const tx = withTx(source, async (trx) => {
        await trx.insertInto('branches').values(branch('T1')).execute();
        inside();
        await gate;
        await trx.insertInto('branches').values(branch('T2')).execute();
      });
      try {
        await entered;
        const copied = sqliteSnapshotWith(source, dest, method).then(
          () => null,
          (error: unknown) => error,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        release();
        await tx;
        expect(await copied).toBeNull();
        const copy = await open(dest, { readOnly: true });
        expect((await sql`PRAGMA integrity_check`.execute(copy.db)).rows).toEqual([{ integrity_check: 'ok' }]);
        // Taken after the transaction: both of its rows, never one without the other.
        expect((await copy.db.selectFrom('branches').select('code_key').where('code_key', 'in', ['T1', 'T2']).orderBy('code_key').execute()).map((r) => r.code_key)).toEqual(['T1', 'T2']);
      } finally {
        release();
        await tx.catch(() => undefined);
        await source.db.deleteFrom('branches').where('code_key', 'in', ['T1', 'T2']).execute();
      }
    },
  );

  it('connectSqliteFile with create: a new work file with the P20 pragmas, which the migrations can fill', async () => {
    const file = dataPath(dataDir, 'db', 'restore.sqlite');
    const work = await open(file, { create: true });
    const journal = (await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(work.db)).rows[0]?.journal_mode;
    const fks = (await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(work.db)).rows[0]?.foreign_keys;
    expect({ journal, fks }).toEqual({ journal: 'wal', fks: 1 });
    await runMigrations(work, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await work.db.insertInto('branches').values(branch('R')).execute();
    await work.close();
    const again = await open(file, { readOnly: true });
    expect((await again.db.selectFrom('branches').select('code_key').execute()).map((r) => r.code_key)).toEqual(['R']);
  });

  it('refuses a missing file without create, and readOnly together with create', async () => {
    const missing = dataPath(dataDir, 'db', 'pre-restore.sqlite');
    await expect(connectSqliteFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(connectSqliteFile(missing, { readOnly: true })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(connectSqliteFile(missing, { readOnly: true, create: true })).rejects.toThrow(TypeError);
    expect(await listNames(dataPath(dataDir, 'db'))).not.toContain('pre-restore.sqlite');
  });

  describe('a full disk or quota (P21): DISK_QUOTA, the temporary copy removed, the older copy at dest kept', () => {
    /** dest (with an older copy of 3 branches) and the names its folder holds. */
    async function olderCopy(): Promise<{ dest: DataPath; folder: DataPath; names: string[] }> {
      const dest = snapshotPath();
      await sqliteSnapshotTo(source, dest);
      const folder = dataPath(dataDir, 'backups', path.basename(path.dirname(path.dirname(dest))), '.work');
      return { dest, folder, names: await listNames(folder) };
    }

    async function branchCount(dest: DataPath): Promise<number> {
      const copy = await open(dest, { readOnly: true });
      return (await copy.db.selectFrom('branches').select('id').execute()).length;
    }

    afterEach(() => {
      vi.unstubAllEnvs();
      resetTestFaults();
    });

    it('a write that fails with EDQUOT (the disk-full fault)', async () => {
      const { dest, folder, names } = await olderCopy();
      await source.db.insertInto('branches').values(branch('Q')).execute();
      try {
        vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:backups:1');
        await expect(sqliteSnapshotTo(source, dest)).rejects.toMatchObject({ code: 'DISK_QUOTA', meta: { code: 'EDQUOT' } });
        expect(await listNames(folder)).toEqual(names);
        expect(await branchCount(dest)).toBe(3);
      } finally {
        await source.db.deleteFrom('branches').where('code_key', '=', 'Q').execute();
      }
    });

    it("SQLite's SQLITE_FULL while copying", async () => {
      const { dest, folder, names } = await olderCopy();
      // A copy of the handle's Kysely: sqliteSnapshotTo falls back to VACUUM INTO, which this plugin fails as a full
      // disk makes node:sqlite fail it.
      const full: KyselyPlugin = {
        transformQuery: () => {
          throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13, errstr: 'database or disk is full' });
        },
        transformResult: async (args) => args.result,
      };
      const failing: DbHandle = { ...source, db: source.db.withPlugin(full) };
      await expect(sqliteSnapshotTo(failing, dest)).rejects.toMatchObject({ code: 'DISK_QUOTA', meta: { code: 'ENOSPC' } });
      expect(await listNames(folder)).toEqual(names);
      expect(await branchCount(dest)).toBe(3);
    });
  });

  it('checkpointSqliteFile moves the WAL of a SQLite file into it and truncates the -wal; another dialect is refused', async () => {
    const opId = newId();
    const folder = dataPath(dataDir, 'db', opId);
    await fsp.mkdir(folder);
    const h = await open(dataPath(dataDir, 'db', opId, 'restore.sqlite'), { create: true });
    await sql`create table t (v text)`.execute(h.db);
    for (let i = 0; i < 50; i += 1) await sql`insert into t (v) values (${'x'.repeat(500)})`.execute(h.db);
    const wal = path.join(folder, 'restore.sqlite-wal');
    expect((await fsp.stat(wal)).size).toBeGreaterThan(0);
    await checkpointSqliteFile(h);
    expect((await fsp.stat(wal)).size).toBe(0);
    await expect(checkpointSqliteFile({ ...source, dialect: 'mysql' } as DbHandle)).rejects.toThrow(TypeError);
  });

  it('sqliteSnapshotTo refuses a handle of another dialect', async () => {
    const other = { ...source, dialect: 'postgres' } as DbHandle;
    await expect(sqliteSnapshotTo(other, snapshotPath())).rejects.toThrow(TypeError);
  });

  it('close() can be called twice', async () => {
    const h = await connectSqliteFile(dataPath(dataDir, 'db', 'altis.sqlite'), { readOnly: true });
    await h.close();
    await h.close();
  });
});
