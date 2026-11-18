import { randomBytes } from 'node:crypto';
import { openForeignMysql, type ForeignMysql } from '@altis/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_SPECS, engineLabel, TEST_DB_PASSWORD, TEST_DB_ROOT_PASSWORD, TEST_DB_USER, testDbContext, testDbHost } from '../../../../tools/test/test-db.js';
import { openDbSource } from '../../src/migration/slims/source/db-source.js';

// The SLiMS database source reads a TIMESTAMP column in UTC, as mysqldump writes it (its `--tz-utc` default), on a
// server whose time zone is not UTC: the server's global zone is set to +07:00 while the test runs (as root), so every
// new session starts there unless the client sets its own. MySQL only (ALTIS_TEST_DB=mysql80 or mysql84).

const ctx = testDbContext();
const MYSQL = ctx.engine === 'mysql80' || ctx.engine === 'mysql84';

describe.skipIf(!ctx.available || !MYSQL)(`SLiMS database source: TIMESTAMP columns in UTC [${engineLabel()}]`, () => {
  const sourceDb = `slims_tz_${randomBytes(4).toString('hex')}`;
  const server = { host: testDbHost(), port: ENGINE_SPECS[ctx.engine].port ?? 0, tls: false };
  let admin: ForeignMysql | null = null;
  let zone: string | null = null;

  beforeAll(async () => {
    admin = await openForeignMysql({ ...server, user: 'root', password: TEST_DB_ROOT_PASSWORD, database: 'mysql' }, { connectTimeoutMs: 10_000 });
    await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4', [sourceDb]);
    await admin.query('CREATE TABLE ??.files_read (filelog_id INT NOT NULL PRIMARY KEY, date_read TIMESTAMP NOT NULL)', [sourceDb]);
    // Written in UTC: 23:30 on the 30th is 06:30 on the 31st at +07:00, another day.
    await admin.query('INSERT INTO ??.files_read VALUES (1, ?), (2, ?)', [sourceDb, '2026-10-30 23:30:00', '2026-01-01 00:00:00']);
    await admin.query(`GRANT SELECT ON ??.* TO ?@'%'`, [sourceDb, TEST_DB_USER]);
    zone = String((await admin.query('SELECT @@GLOBAL.time_zone AS z', []))[0]?.['z']);
    await admin.query("SET GLOBAL time_zone = '+07:00'", []);
  }, 60_000);

  afterAll(async () => {
    if (admin === null) return;
    if (zone !== null) await admin.query('SET GLOBAL time_zone = ?', [zone]);
    await admin.query(`REVOKE SELECT ON ??.* FROM ?@'%'`, [sourceDb, TEST_DB_USER]).catch(() => undefined);
    await admin.query('DROP DATABASE IF EXISTS ??', [sourceDb]);
    await admin.close();
  }, 60_000);

  it('reads the TIMESTAMP values as UTC while the server runs at +07:00', async () => {
    expect(String((await admin!.query('SELECT @@GLOBAL.time_zone AS z', []))[0]?.['z'])).toBe('+07:00');
    const source = await openDbSource({ ...server, user: TEST_DB_USER, password: TEST_DB_PASSWORD, database: sourceDb });
    try {
      const { rows, next } = await source.rows('files_read', null, 10);
      expect(next).toBeNull();
      expect(rows).toEqual([
        { filelog_id: 1, date_read: '2026-10-30 23:30:00' },
        { filelog_id: 2, date_read: '2026-01-01 00:00:00' },
      ]);
    } finally {
      await source.close();
    }
  });
});
