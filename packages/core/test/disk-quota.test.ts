import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DomainError } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDiskQuota } from '../src/files/disk-quota.js';

// A full disk or an exhausted quota (P21, Review Focus 3) as the file system and every database driver report it:
// the operations (backup, restore, upload, prepared download) turn each into DISK_QUOTA with notification.disk_low.

describe('isDiskQuota', () => {
  let root: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-disk-quota-'));
  });

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('DISK_QUOTA, and the file system’s ENOSPC and EDQUOT', () => {
    expect(isDiskQuota(new DomainError('DISK_QUOTA'))).toBe(true);
    expect(isDiskQuota(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))).toBe(true);
    expect(isDiskQuota(Object.assign(new Error('EDQUOT: disk quota exceeded'), { code: 'EDQUOT' }))).toBe(true);
    expect(isDiskQuota(new DomainError('INTERNAL'))).toBe(false);
    expect(isDiskQuota(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(false);
    expect(isDiskQuota(null)).toBe(false);
    expect(isDiskQuota('ENOSPC')).toBe(false);
  });

  it('SQLite: SQLITE_FULL as node:sqlite throws it, and SQLITE_IOERR_WRITE (a quota: the unix VFS reports EDQUOT so)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'full.sqlite'));
    let thrown: unknown = null;
    try {
      db.exec('PRAGMA max_page_count = 4; CREATE TABLE t (v TEXT)');
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
      for (let i = 0; i < 100; i += 1) insert.run('x'.repeat(4000));
    } catch (error) {
      thrown = error;
    } finally {
      db.close();
    }
    expect(thrown).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 13 });
    expect(isDiskQuota(thrown)).toBe(true);
    expect(isDiskQuota({ code: 'ERR_SQLITE_ERROR', errcode: 778, message: 'disk I/O error' })).toBe(true);
    expect(isDiskQuota({ code: 'ERR_SQLITE_ERROR', errcode: 5, message: 'database is locked' })).toBe(false);
    expect(isDiskQuota({ code: 'ERR_SQLITE_ERROR', errcode: 2067, message: 'UNIQUE constraint failed' })).toBe(false);
  });

  it('MySQL/MariaDB: ER_RECORD_FILE_FULL (1114), ER_DISK_FULL (1021), a write error whose OS errno is 28 or 122', () => {
    expect(isDiskQuota({ code: 'ER_RECORD_FILE_FULL', errno: 1114, sqlState: 'HY000', sqlMessage: "The table 'audit_log' is full" })).toBe(true);
    expect(isDiskQuota({ code: 'ER_DISK_FULL', errno: 1021, sqlState: 'HY000', sqlMessage: 'Disk full (/tmp/x); waiting for someone to free some space...' })).toBe(true);
    expect(
      isDiskQuota({ code: 'ER_ERROR_ON_WRITE', errno: 1026, sqlState: 'HY000', sqlMessage: "Error writing file './altis/t.ibd' (OS errno 28 - No space left on device)" }),
    ).toBe(true);
    expect(isDiskQuota({ code: 'ER_ERROR_ON_WRITE', errno: 1026, sqlState: 'HY000', sqlMessage: "Error writing file '/tmp/MYx' (Errcode: 122 - Disk quota exceeded)" })).toBe(true);
    expect(isDiskQuota({ code: 'ER_ERROR_ON_WRITE', errno: 1026, sqlState: 'HY000', sqlMessage: "Error writing file '/tmp/MYx' (Errcode: 13 - Permission denied)" })).toBe(false);
    expect(isDiskQuota({ code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000', sqlMessage: "Duplicate entry '28' for key 'x'" })).toBe(false);
  });

  it('PostgreSQL: SQLSTATE 53100 disk_full', () => {
    expect(isDiskQuota({ code: '53100', severity: 'ERROR', message: 'could not extend file "base/1/2": No space left on device' })).toBe(true);
    expect(isDiskQuota({ code: '23505', severity: 'ERROR', message: 'duplicate key' })).toBe(false);
  });

  it('a driver error wrapped as the cause of another error, as a failed migration wraps its safe copy', () => {
    const migration = Object.assign(new Error('Migration 0002_org_and_identity failed: database error ERR_SQLITE_ERROR, errno 13'), {
      name: 'MigrationError',
      code: 'ERR_SQLITE_ERROR',
      cause: { code: 'ERR_SQLITE_ERROR', errno: 13 },
    });
    expect(isDiskQuota(migration)).toBe(true);
    expect(isDiskQuota(Object.assign(new Error('Migration failed'), { code: 'ERR_SQLITE_ERROR', cause: { code: 'ERR_SQLITE_ERROR', errno: 1 } }))).toBe(false);
    expect(isDiskQuota(new Error('Migration failed', { cause: { code: 'ER_RECORD_FILE_FULL', errno: 1114, sqlState: 'HY000' } }))).toBe(true);
    expect(isDiskQuota(new Error('Migration failed', { cause: { code: '53100' } }))).toBe(true);
    expect(isDiskQuota(new Error('the load failed', { cause: { code: '53100', severity: 'ERROR' } }))).toBe(true);
    expect(isDiskQuota(new Error('the load failed', { cause: new Error('something else') }))).toBe(false);
  });
});
