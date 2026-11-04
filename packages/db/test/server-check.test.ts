import { describe, expect, it } from 'vitest';
import { MIN_SERVER_VERSIONS, meetsMinimum, parseServerVersion } from '../src/server-check.js';

describe('parseServerVersion (SELECT VERSION() of MySQL and MariaDB)', () => {
  it.each([
    ['10.6.20-MariaDB-ubu2004', 'mariadb', [10, 6, 20]],
    ['10.6.20-MariaDB-ubu2004-log', 'mariadb', [10, 6, 20]],
    ['5.5.5-10.6.20-MariaDB-log', 'mariadb', [10, 6, 20]], // the old replication-handshake prefix
    ['11.4.4-MariaDB-ubu2404', 'mariadb', [11, 4, 4]],
    ['10.3.39-MariaDB', 'mariadb', [10, 3, 39]],
    ['10.11.6-MariaDB-0+deb12u1', 'mariadb', [10, 11, 6]],
    ['8.0.40', 'mysql', [8, 0, 40]],
    ['8.4.3', 'mysql', [8, 4, 3]],
    ['8.0.36-0ubuntu0.22.04.1', 'mysql', [8, 0, 36]],
    ['8.0.35-27', 'mysql', [8, 0, 35]], // Percona Server
    ['5.7.44-log', 'mysql', [5, 7, 44]],
    ['5.5.5', 'mysql', [5, 5, 5]],
  ] as const)('%s → %s %j', (raw, flavor, version) => {
    expect(parseServerVersion(raw)).toEqual({ flavor, version });
  });

  it.each(['', 'MariaDB', 'eight', '8.0', 'v8.0.1'])('returns null for %j', (raw) => {
    expect(parseServerVersion(raw)).toBeNull();
  });
});

describe('meetsMinimum', () => {
  it('uses the minimum versions of the global constraints', () => {
    expect(MIN_SERVER_VERSIONS).toMatchObject({ mysql: [8, 0, 0], mariadb: [10, 6, 0], postgres: [15, 0, 0] });
  });

  it.each([
    ['mysql', [8, 0, 0], true],
    ['mysql', [8, 4, 3], true],
    ['mysql', [5, 7, 44], false],
    ['mariadb', [10, 6, 0], true],
    ['mariadb', [10, 5, 99], false],
    ['mariadb', [11, 0, 0], true],
    ['postgres', [15, 0, 0], true],
    ['postgres', [14, 99, 0], false],
    ['postgres', [17, 2, 0], true],
    ['sqlite', [3, 53, 4], true],
    ['sqlite', [3, 30, 0], false],
  ] as const)('%s %j → %s', (flavor, version, expected) => {
    expect(meetsMinimum(flavor, version)).toBe(expected);
  });
});
