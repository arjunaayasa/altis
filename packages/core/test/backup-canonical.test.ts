import { createHmac } from 'node:crypto';
import { canonicalize } from '@altis/crypto';
import { PHASE1_MIGRATIONS, TABLE_CLASSES, TABLE_COLUMNS, tableLoadOrder, type TableName } from '@altis/db';
import { describe, expect, it } from 'vitest';
import {
  backupRowIncluded,
  backupTables,
  backupTablesAt,
  canonicalLine,
  canonicalRow,
  checksumLine,
} from '../src/backup/canonical.js';
import { BACKUP_FORMAT, manifestHmac, verifyManifestHmac, type BackupManifest } from '../src/backup/manifest.js';

// The canonical backup row (spec §9.9): the registry's columns and nothing else, keys sorted, integers as JSON numbers
// within ±(2^53 − 1), booleans 0/1, explicit null; one JSONL line per row. The same row read through another driver
// must give the same bytes (cross-dialect restores compare per-table checksums, A6). The checksum line leaves out the
// registered secret columns (settings.value only where is_secret = 1).

const T0 = 1_800_000_000_000;
const BRANCH_ID = '01JBRANCH0000000000000000A';
const USER_ID = '01JUSER00000000000000000AA';

const branchColumns = TABLE_COLUMNS.branches;

/** A branches row as node:sqlite returns it: numbers for integers and 0/1 flags, null for NULL. */
const sqliteBranch = {
  id: BRANCH_ID,
  code_key: 'pusat',
  code_display: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: null,
  timezone: 'Asia/Jakarta',
  is_default: 1,
  archived_at: null,
  version: 0,
  created_at: T0,
  created_by: null,
  updated_at: T0 + 5,
  updated_by: USER_ID,
};

/**
 * The same row as mysql2 returns it from MariaDB (supportBigNumbers, safe BIGINTs as numbers): another key order,
 * and a column the registry does not know (a driver or join extra) that must not reach the line.
 */
const mariadbBranch = {
  updated_by: USER_ID,
  updated_at: T0 + 5,
  version: 0,
  timezone: 'Asia/Jakarta',
  name: 'Perpustakaan Pusat',
  is_default: 1,
  id: BRANCH_ID,
  created_by: null,
  created_at: T0,
  code_key: 'pusat',
  code_display: 'PUSAT',
  archived_at: null,
  address: null,
  extra_join_column: 'x',
};

/** A staff_users row with every column: the TOTP secret is a sealed value (`v1:<kid>:<iv>:<ct>`). */
function staffRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const c of TABLE_COLUMNS.staff_users) row[c.name] = c.nullable ? null : c.kind === 'varchar' || c.kind === 'key191' || c.kind === 'id' ? 'x' : 0;
  return { ...row, id: USER_ID, totp_secret_enc: 'v1:k1:aaaa:bbbb', totp_last_step: 59_999_999, ...over };
}

function settingsRow(key: string, value: string | null, isSecret: 0 | 1, scope = 'data'): Record<string, unknown> {
  return { key, value, is_secret: isSecret, scope, updated_at: T0, updated_by: null };
}

describe('backupTables', () => {
  it('lists the data, config and history tables in load order, with their classes', () => {
    const tables = backupTables();
    const names = tables.map((t) => t.table);
    const expected = (Object.keys(TABLE_CLASSES) as TableName[]).filter((t) =>
      ['data', 'config', 'history'].includes(TABLE_CLASSES[t]),
    );
    expect([...names].sort()).toEqual([...expected].sort());
    expect(names).toEqual(tableLoadOrder(expected).order);
    for (const t of tables) expect(t.cls).toBe(TABLE_CLASSES[t.table]);
    // Volatile, install and migrator tables are never backed up.
    for (const absent of ['sessions', 'jobs', 'events', 'locks', 'license_state', 'audit_head', 'schema_meta']) {
      expect(names).not.toContain(absent);
    }
    // Parents before the rows that reference them.
    expect(names.indexOf('staff_users')).toBeLessThan(names.indexOf('user_roles'));
    expect(names.indexOf('roles')).toBeLessThan(names.indexOf('role_permissions'));
    expect(names.indexOf('notifications')).toBeLessThan(names.indexOf('notification_reads'));
  });

  // ---- Phase 2 (catalog): Task 1 ----
  it('Phase 2: the 23 data tables are backed up in load order; the 4 search tables are not (§2.3)', () => {
    const names = backupTables().map((t) => t.table);
    const catalogData: TableName[] = [
      'locations',
      'records',
      'record_identifiers',
      'record_marc_extra',
      'agents',
      'record_agents',
      'subjects',
      'record_subjects',
      'subject_relations',
      'publishers',
      'record_relations',
      'attachments',
      'languages',
      'material_types',
      'items',
      'item_events',
      'collection_types',
      'suppliers',
      'pages',
      'page_translations',
      'catalog_runs',
      'migration_map',
      'migration_archive',
    ];
    expect(catalogData).toHaveLength(23);
    for (const t of catalogData) {
      expect({ t, backedUp: names.includes(t), cls: TABLE_CLASSES[t] }).toEqual({ t, backedUp: true, cls: 'data' });
    }
    for (const t of ['search_doc', 'search_facet', 'search_term', 'search_state'] as TableName[]) {
      expect({ t, backedUp: names.includes(t), cls: TABLE_CLASSES[t] }).toEqual({ t, backedUp: false, cls: 'volatile' });
    }
    // The catalog tables keep the load order of the whole list: parents before what references them.
    const catalogOrder = names.filter((n) => catalogData.includes(n));
    expect(catalogOrder).toEqual(tableLoadOrder(catalogData).order);
    const before = (a: TableName, b: TableName) => expect({ a, b, first: names.indexOf(a) < names.indexOf(b) }).toEqual({ a, b, first: true });
    before('branches', 'locations');
    for (const child of ['record_identifiers', 'record_marc_extra', 'record_agents', 'record_subjects', 'record_relations', 'attachments', 'items'] as TableName[]) {
      before('records', child);
    }
    before('items', 'item_events');
    before('pages', 'page_translations');
    before('subjects', 'subject_relations');
    before('custom_field_defs', 'custom_values');
  });

  // ---- Komunitas K1 (tables) ----
  it('Komunitas K1: the 12 data tables are backed up in load order; report runs and computed results are not', () => {
    const names = backupTables().map((t) => t.table);
    const k1Data: TableName[] = [
      'accred_periods',
      'accred_answers',
      'accred_snapshots',
      'accred_evidence',
      'usage_stats',
      'usage_group_map',
      'library_activities',
      'library_staff',
      'staff_trainings',
      'library_partnerships',
      'library_budgets',
      'library_documents',
    ];
    expect(k1Data).toHaveLength(12);
    for (const t of k1Data) {
      expect({ t, backedUp: names.includes(t), cls: TABLE_CLASSES[t] }).toEqual({ t, backedUp: true, cls: 'data' });
    }
    for (const t of ['report_runs', 'accred_results'] as TableName[]) {
      expect({ t, backedUp: names.includes(t), cls: TABLE_CLASSES[t] }).toEqual({ t, backedUp: false, cls: 'volatile' });
    }
    // The K1 tables keep the load order of the whole list: a period before its answers and snapshots, a staff member
    // before their trainings.
    const k1Order = names.filter((n) => k1Data.includes(n));
    expect(k1Order).toEqual(tableLoadOrder(k1Data).order);
    const before = (a: TableName, b: TableName) => expect({ a, b, first: names.indexOf(a) < names.indexOf(b) }).toEqual({ a, b, first: true });
    before('accred_periods', 'accred_answers');
    before('accred_periods', 'accred_snapshots');
    before('library_staff', 'staff_trainings');
    // A backup at a Phase 2 schema holds none of them.
    const phase2 = backupTablesAt('0029').map((t) => t.table);
    for (const t of k1Data) expect({ t, atPhase2: phase2.includes(t) }).toEqual({ t, atPhase2: false });
    expect(backupTablesAt('0033_catalog_accred_fields').map((t) => t.table)).toEqual(expect.arrayContaining(k1Data));
  });

  it('backupTablesAt: the tables a backup at an older schema version holds (a Phase 1 schema has no catalog table)', () => {
    const latest = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
    // Every backup table but the test builds' test_fixture (decision D1d-26), which 9001_test_expand makes.
    const all = backupTables().filter((t) => t.table !== ('test_fixture' as TableName));
    expect(backupTablesAt(latest)).toEqual(all);
    // The same tables, in the same order, as 1d's backupTables(schemaVersion) lists them.
    expect(backupTablesAt(latest)).toEqual(backupTables(latest));
    expect(backupTablesAt('0009')).toEqual(backupTables('0009'));
    const phase1 = backupTablesAt('0009');
    expect(phase1).toEqual(all.filter((t) => TABLE_COLUMNS[t.table][0]!.since < '0010'));
    expect(phase1.map((t) => t.table)).toContain('branches');
    expect(phase1.map((t) => t.table)).not.toContain('records');
    expect(backupTablesAt('0009_ops_jobs')).toEqual(phase1);
    expect(backupTablesAt('0020_catalog_authorities').map((t) => t.table)).toEqual(
      expect.arrayContaining(['agents', 'languages', 'material_types', 'publishers', 'subjects', 'subject_relations']),
    );
    expect(backupTablesAt('0020_catalog_authorities').map((t) => t.table)).not.toContain('records');
    expect(() => backupTablesAt('latest')).toThrow(TypeError);
  });
});

describe('canonicalRow and canonicalLine', () => {
  it('keeps exactly the registered columns and sorts the keys', () => {
    const row = canonicalRow('branches', { ...sqliteBranch, unknown_column: 'drop me' }, branchColumns);
    expect(Object.keys(row)).toEqual(branchColumns.map((c) => c.name));
    const line = canonicalLine(row);
    expect(line.endsWith('\n')).toBe(true);
    expect(line).toBe(`${canonicalize(row)}\n`);
    const keys = Object.keys(JSON.parse(line) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
    expect(keys).not.toContain('unknown_column');
    expect(JSON.parse(line)).toMatchObject({ is_default: 1, version: 0, address: null, archived_at: null });
  });

  it('is byte-identical for the same row from SQLite and from MariaDB driver output', () => {
    const a = canonicalLine(canonicalRow('branches', sqliteBranch, branchColumns));
    const b = canonicalLine(canonicalRow('branches', mariadbBranch, branchColumns));
    expect(Buffer.from(b, 'utf8').equals(Buffer.from(a, 'utf8'))).toBe(true);
  });

  it('writes booleans as 0/1 and safe bigint values as numbers', () => {
    const fromBool = canonicalRow('branches', { ...sqliteBranch, is_default: true }, branchColumns);
    expect(fromBool['is_default']).toBe(1);
    const fromFalse = canonicalRow('branches', { ...sqliteBranch, is_default: false }, branchColumns);
    expect(fromFalse['is_default']).toBe(0);
    const fromBigint = canonicalRow('branches', { ...sqliteBranch, created_at: BigInt(T0) }, branchColumns);
    expect(fromBigint['created_at']).toBe(T0);
  });

  it('refuses an integer beyond 2^53 − 1 in a BIGINT, and other values that do not fit their column', () => {
    const columns = TABLE_COLUMNS.staff_users;
    expect(() => canonicalRow('staff_users', staffRow({ totp_last_step: 2 ** 53 }), columns)).toThrow(TypeError);
    expect(() => canonicalRow('staff_users', staffRow({ totp_last_step: 2n ** 53n }), columns)).toThrow(TypeError);
    expect(() => canonicalRow('staff_users', staffRow({ totp_last_step: -(2 ** 53) }), columns)).toThrow(TypeError);
    expect(canonicalRow('staff_users', staffRow({ totp_last_step: 2 ** 53 - 1 }), columns)['totp_last_step']).toBe(2 ** 53 - 1);
    expect(() => canonicalRow('staff_users', staffRow({ totp_last_step: 1.5 }), columns)).toThrow(TypeError);
    expect(() => canonicalRow('staff_users', staffRow({ totp_last_step: '12' }), columns)).toThrow(TypeError);
    expect(() => canonicalRow('branches', { ...sqliteBranch, is_default: 2 }, branchColumns)).toThrow(TypeError);
    expect(() => canonicalRow('branches', { ...sqliteBranch, name: 7 }, branchColumns)).toThrow(TypeError);
    const withoutVersion: Record<string, unknown> = { ...sqliteBranch };
    delete withoutVersion['version'];
    expect(() => canonicalRow('branches', withoutVersion, branchColumns)).toThrow(TypeError);
  });

  it('writes an explicit null', () => {
    const row = canonicalRow('branches', { ...sqliteBranch, address: null }, branchColumns);
    expect(canonicalLine(row)).toContain('"address":null');
    expect(canonicalLine(row)).toContain('"archived_at":null');
  });
});

describe('backupRowIncluded', () => {
  it('keeps only the settings rows whose scope class is data, and every row of the other tables', () => {
    expect(backupRowIncluded('settings', settingsRow('library.name', '"Pusat"', 0))).toBe(true);
    expect(backupRowIncluded('settings', settingsRow('smtp.password', 'v1:k1:a:b', 1))).toBe(true);
    expect(backupRowIncluded('settings', settingsRow('system.ip_trust', '"ok"', 0, 'instance'))).toBe(false);
    expect(backupRowIncluded('settings', settingsRow('odd.scope', '1', 0, 'elsewhere'))).toBe(false);
    expect(backupRowIncluded('branches', sqliteBranch)).toBe(true);
  });
});

describe('checksumLine', () => {
  it('leaves out staff_users.totp_secret_enc', () => {
    const columns = TABLE_COLUMNS.staff_users;
    const a = canonicalRow('staff_users', staffRow(), columns);
    const b = canonicalRow('staff_users', staffRow({ totp_secret_enc: 'v1:k2:cccc:dddd' }), columns);
    expect(canonicalLine(a)).not.toBe(canonicalLine(b));
    expect(checksumLine('staff_users', a)).toBe(checksumLine('staff_users', b));
    expect(checksumLine('staff_users', a)).not.toContain('totp_secret_enc');
    expect(checksumLine('staff_users', a).endsWith('\n')).toBe(true);
  });

  it('leaves out settings.value only where is_secret = 1', () => {
    const secretA = checksumLine('settings', settingsRow('smtp.password', 'v1:k1:a:b', 1));
    const secretB = checksumLine('settings', settingsRow('smtp.password', 'v1:k1:c:d', 1));
    expect(secretA).toBe(secretB);
    expect(secretA).not.toContain('"value"');
    const plain = settingsRow('library.name', '"Pusat"', 0);
    expect(checksumLine('settings', plain)).toBe(canonicalLine(plain));
    expect(checksumLine('settings', settingsRow('library.name', '"Cabang"', 0))).not.toBe(checksumLine('settings', plain));
  });

  it('is the canonical line itself for a table without secret columns', () => {
    const row = canonicalRow('branches', sqliteBranch, branchColumns);
    expect(checksumLine('branches', row)).toBe(canonicalLine(row));
  });
});

describe('manifestHmac', () => {
  const key = new Uint8Array(32).fill(7);
  const other = new Uint8Array(32).fill(8);

  function manifest(): Omit<BackupManifest, 'hmac'> {
    return {
      format: BACKUP_FORMAT,
      backupId: '01JBACKUP00000000000000000',
      kind: 'manual',
      appVersion: '0.1.0',
      schemaVersion: '0009_ops_jobs',
      dialect: 'sqlite',
      createdAt: T0,
      consistency: 'frozen',
      kids: ['k1'],
      installId: '01JINSTALL0000000000000000',
      auditHead: { seq: 3, hash: 'a'.repeat(64) },
      includesFiles: false,
      secrets: 'keyring',
      tables: {
        branches: {
          class: 'data',
          columns: ['id'],
          rows: 1,
          checksum: 'b'.repeat(64),
          parts: [{ n: 1, rows: 1, firstPk: ['x'], lastPk: ['x'], sha256: 'c'.repeat(64), bytes: 10 }],
        },
      },
      blobs: [],
    };
  }

  it('is base64url and verifies with the same key only', () => {
    const m = manifest();
    const hmac = manifestHmac(key, m);
    expect(hmac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyManifestHmac(key, { ...m, hmac })).toBe(true);
    expect(verifyManifestHmac(other, { ...m, hmac })).toBe(false);
  });

  it('fails after any field changes', () => {
    const m = manifest();
    const hmac = manifestHmac(key, m);
    expect(verifyManifestHmac(key, { ...m, createdAt: T0 + 1, hmac })).toBe(false);
    expect(verifyManifestHmac(key, { ...m, kids: ['k1', 'k2'], hmac })).toBe(false);
    const tables = structuredClone(m.tables);
    tables['branches']!.parts[0]!.rows = 2;
    expect(verifyManifestHmac(key, { ...m, tables, hmac })).toBe(false);
    const flipped = `${hmac.slice(0, -1)}${hmac.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyManifestHmac(key, { ...m, hmac: flipped })).toBe(false);
    expect(verifyManifestHmac(key, { ...m, hmac: '' })).toBe(false);
  });

  it('is keyed by HKDF of the session key, not by the key itself', () => {
    const m = manifest();
    // The same canonical text with the raw session key as the HMAC key must not match.
    const raw = createHmac('sha256', key).update(canonicalize(m), 'utf8').digest('base64url');
    expect(manifestHmac(key, m)).not.toBe(raw);
  });
});
