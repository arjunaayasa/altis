import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, TABLE_CLASSES, connect, countRows, runMigrations, tableLoadOrder, type DB, type DbHandle } from '@altis/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { catalogSampleRows, type CatalogTable } from '../../../db/test/fixtures/catalog-tables.js';
// ---- Komunitas K1 (tables) ----
import { k1SampleRows, type K1Table } from '../../../db/test/fixtures/komunitas-k1-tables.js';
// ---- Komunitas (members and circulation) ----
import { circulationSampleRows, type CirculationTable } from '../../../db/test/fixtures/komunitas-members-circulation-tables.js';
// ---- Komunitas (holds) ----
import { holdsSampleRows } from '../../../db/test/fixtures/komunitas-holds-tables.js';
// ---- Komunitas (circulation core) ----
import { circCoreSampleRows, type CircCoreTable } from '../../../db/test/fixtures/komunitas-circ-core-tables.js';
// ---- Komunitas K2 (visits) ----
import { visitsSampleRows, type VisitsTableName } from '../../../db/test/fixtures/komunitas-visits-tables.js';
// ---- Komunitas (charges and payments) ----
import { chargesSampleRows } from '../../../db/test/fixtures/komunitas-charges-tables.js';
// ---- Komunitas (notices) ----
import { noticesSampleRows } from '../../../db/test/fixtures/komunitas-notices-tables.js';
// ---- Komunitas K4 (stocktake) ----
import { stocktakeSampleRows } from '../../../db/test/fixtures/komunitas-stocktake-tables.js';
import { backupTables, tableChecksumFromDb } from '../../src/backup/canonical.js';
import { createExporter, type ExportCheckpoint } from '../../src/backup/exporter.js';
import { readManifest, type BackupManifest } from '../../src/backup/manifest.js';

// Cross-dialect checksums (spec §9.9, acceptance A6): the same rows (fixed ids and timestamps) in a SQLite database
// and in the engine picked by ALTIS_TEST_DB give every backed-up table the same checksum, so a restore into another
// dialect can be checked table by table. The expected values come from the SQLite copy, computed inside the test.
// The rows cover every column kind, NULLs, non-ASCII text (byte order of keys: 'A' < 'a' < 'é'), composite keys,
// a secret settings row and an instance settings row (left out of the backup). Phase 2 (catalog): the catalog tables
// hold the full sample rows of packages/db's table test, with fixed ids; the seed rows of 0027 (new ids on each
// database) are removed first. Komunitas K1: its data tables hold the K1 sample rows the same way; members and
// circulation (0040) too, its seeds removed first.

const ctx = testDbContext();
const T = 1_800_000_000_000;
const SCHEMA_VERSION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;

/** Fixed ULIDs, so both databases hold the very same keys. */
const ID = {
  branchA: '01JAAAAAAAAAAAAAAAAAAAAAA1',
  branchB: '01JAAAAAAAAAAAAAAAAAAAAAA2',
  userA: '01JBBBBBBBBBBBBBBBBBBBBBB1',
  userB: '01JBBBBBBBBBBBBBBBBBBBBBB2',
  roleA: '01JCCCCCCCCCCCCCCCCCCCCCC1',
  roleB: '01JCCCCCCCCCCCCCCCCCCCCCC2',
  codeA: '01JDDDDDDDDDDDDDDDDDDDDDD1',
  codeB: '01JDDDDDDDDDDDDDDDDDDDDDD2',
  urA: '01JEEEEEEEEEEEEEEEEEEEEEE1',
  urB: '01JEEEEEEEEEEEEEEEEEEEEEE2',
  fileA: '01JFFFFFFFFFFFFFFFFFFFFFF1',
  fileB: '01JFFFFFFFFFFFFFFFFFFFFFF2',
  fieldA: '01JGGGGGGGGGGGGGGGGGGGGGG1',
  fieldB: '01JGGGGGGGGGGGGGGGGGGGGGG2',
  noteA: '01JHHHHHHHHHHHHHHHHHHHHHH1',
  noteB: '01JHHHHHHHHHHHHHHHHHHHHHH2',
  auditA: '01JJJJJJJJJJJJJJJJJJJJJJJ1',
  auditB: '01JJJJJJJJJJJJJJJJJJJJJJJ2',
  releaseA: '01JKKKKKKKKKKKKKKKKKKKKKK1',
  backupA: '01JMMMMMMMMMMMMMMMMMMMMMM1',
  backupB: '01JMMMMMMMMMMMMMMMMMMMMMM2',
} as const;

const HASH = (c: string): string => c.repeat(64);

/** The catalog's sample rows with ids numbered from a fixed prefix, so both databases hold the very same keys. */
function catalogRows(): ReturnType<typeof catalogSampleRows> {
  let n = 0;
  return catalogSampleRows({ branchId: ID.branchA, staffId: ID.userA, newId: () => `01JQ${String((n += 1)).padStart(22, '0')}` });
}

/** The K1 sample rows with ids numbered from another fixed prefix. */
function k1Rows(): ReturnType<typeof k1SampleRows> {
  let n = 0;
  return k1SampleRows({ branchId: ID.branchA, staffId: ID.userA, newId: () => `01JR${String((n += 1)).padStart(22, '0')}` });
}

/** The members and circulation sample rows with ids numbered from another fixed prefix. */
function circulationRows(): ReturnType<typeof circulationSampleRows> {
  let n = 0;
  return circulationSampleRows({ branchId: ID.branchA, staffId: ID.userA, newId: () => `01JS${String((n += 1)).padStart(22, '0')}` });
}

/** The holds sample rows with ids numbered from another fixed prefix. */
function holdRows(): ReturnType<typeof holdsSampleRows> {
  let n = 0;
  return holdsSampleRows({ branchId: ID.branchA, staffId: ID.userA, newId: () => `01JT${String((n += 1)).padStart(22, '0')}` });
}

/** The visits sample rows with ids numbered from another fixed prefix. */
function visitsRows(): ReturnType<typeof visitsSampleRows> {
  let n = 0;
  return visitsSampleRows({ branchId: ID.branchA, staffId: ID.userA, newId: () => `01JV${String((n += 1)).padStart(22, '0')}` });
}

/** The same rows, written through Kysely, on any dialect. */
async function seed(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto('branches')
    .values([
      { id: ID.branchA, code_key: 'pusat', code_display: 'PUSAT', name: 'Perpustakaan Pusat — Ruang Baca 📚', address: 'Jl. Merdeka No. 1\nJakarta', timezone: 'Asia/Jakarta', is_default: 1, archived_at: null, version: 3, created_at: T, created_by: null, updated_at: T + 1, updated_by: ID.userA },
      { id: ID.branchB, code_key: 'cabang-é', code_display: 'Cabang É', name: 'Cabang "Timur" \\ Ä', address: null, timezone: 'Asia/Makassar', is_default: 0, archived_at: T + 99, version: 0, created_at: T + 2, created_by: ID.userB, updated_at: T + 3, updated_by: null },
    ])
    .execute();
  await db
    .insertInto('staff_users')
    .values([
      { id: ID.userA, username_key: 'ani', username_display: 'Ani', name: 'Ani Suryani', email_key: 'ani@example.test', email_display: 'Ani@Example.test', password_hash: '$scrypt$x', status: 'active', locale: 'id', totp_secret_enc: 'v1:k1:aaaa:bbbb', totp_enabled: 1, totp_last_step: 2 ** 53 - 1, totp_reenroll: 0, mfa_required: 1, must_change_password: 0, authz_version: 7, last_login_at: T + 50, version: 2, created_at: T, created_by: null, updated_at: T, updated_by: null },
      { id: ID.userB, username_key: 'Budi', username_display: 'Budi', name: 'Budi Ünal', email_key: null, email_display: null, password_hash: '$scrypt$y', status: 'disabled', locale: null, totp_secret_enc: null, totp_enabled: 0, totp_last_step: 0, totp_reenroll: 1, mfa_required: 0, must_change_password: 1, authz_version: 0, last_login_at: null, version: 0, created_at: T, created_by: ID.userA, updated_at: T, updated_by: ID.userA },
    ])
    .execute();
  await db
    .insertInto('staff_recovery_codes')
    .values([
      { id: ID.codeA, user_id: ID.userA, code_hash: HASH('1'), used_at: null, created_at: T },
      { id: ID.codeB, user_id: ID.userA, code_hash: HASH('2'), used_at: T + 5, created_at: T },
    ])
    .execute();
  await db
    .insertInto('roles')
    .values([
      { id: ID.roleA, key: 'super_admin', name: 'Super admin', description: null, is_system: 1, mfa_required: 1, version: 0, created_at: T, created_by: null, updated_at: T, updated_by: null },
      { id: ID.roleB, key: 'Pustakawan', name: 'Pustakawan', description: 'Peran «uji»', is_system: 0, mfa_required: 0, version: 1, created_at: T, created_by: ID.userA, updated_at: T + 9, updated_by: ID.userA },
    ])
    .execute();
  await db
    .insertInto('role_permissions')
    .values([
      { role_id: ID.roleA, permission: 'system.backup.create' },
      { role_id: ID.roleA, permission: 'Z.upper' },
      { role_id: ID.roleB, permission: 'catalog.read' },
    ])
    .execute();
  await db
    .insertInto('user_roles')
    .values([
      { id: ID.urA, user_id: ID.userA, role_id: ID.roleA, branch_id: null, scope_key: '*', created_at: T, created_by: null },
      { id: ID.urB, user_id: ID.userB, role_id: ID.roleB, branch_id: ID.branchB, scope_key: ID.branchB, created_at: T, created_by: ID.userA },
    ])
    .execute();
  await db
    .insertInto('settings')
    .values([
      { key: 'library.name', value: '"Perpustakaan Arsya"', is_secret: 0, scope: 'data', updated_at: T, updated_by: null },
      { key: 'Library.Upper', value: '{"a":[1,2,{"b":null}]}', is_secret: 0, scope: 'data', updated_at: T, updated_by: ID.userA },
      { key: 'library.é', value: null, is_secret: 0, scope: 'data', updated_at: T, updated_by: null },
      { key: 'smtp.password', value: 'v1:k1:cccc:dddd', is_secret: 1, scope: 'data', updated_at: T, updated_by: null },
      { key: 'system.ip_trust', value: '"collapsed"', is_secret: 0, scope: 'instance', updated_at: T, updated_by: null },
    ])
    .execute();
  await db
    .insertInto('files')
    .values([
      { id: ID.fileA, original_name: 'sampul ✓.png', mime: 'image/png', size: 12_345, sha256: HASH('a'), context: 'test', owner_type: 'branch', owner_id: ID.branchA, access: 'public', status: 'ok', created_at: T, created_by: ID.userA },
      { id: ID.fileB, original_name: 'x.pdf', mime: 'application/pdf', size: 0, sha256: HASH('b'), context: 'test', owner_type: null, owner_id: null, access: 'staff', status: 'missing', created_at: T, created_by: null },
    ])
    .execute();
  await db
    .insertInto('custom_field_defs')
    .values([
      { id: ID.fieldA, entity: 'member', code_key: 'nik', code_display: 'NIK', label: 'Nomor induk', type: 'text', options: null, is_required: 1, sort_order: 1, archived_at: null, version: 0, created_at: T, created_by: null, updated_at: T, updated_by: null },
      { id: ID.fieldB, entity: 'member', code_key: 'kelas', code_display: 'Kelas', label: 'Kelas', type: 'select', options: '["X","XI","XII"]', is_required: 0, sort_order: -2, archived_at: T, version: 4, created_at: T, created_by: ID.userA, updated_at: T, updated_by: ID.userA },
    ])
    .execute();
  await db
    .insertInto('custom_values')
    .values([
      { field_id: ID.fieldA, entity_id: ID.userA, value: '"3174"', updated_at: T, updated_by: null },
      { field_id: ID.fieldA, entity_id: ID.userB, value: '"3175"', updated_at: T, updated_by: ID.userA },
      { field_id: ID.fieldB, entity_id: ID.userA, value: '"XI"', updated_at: T, updated_by: null },
    ])
    .execute();
  await db
    .insertInto('notifications')
    .values([
      { id: ID.noteA, audience_permission: 'system.backup.read', user_id: null, type: 'backup_done', title_key: 'notification.backup_done', params: '{"backupId":"x"}', link: '/admin/backups', created_at: T, expires_at: T + 90 * 86_400_000 },
      { id: ID.noteB, audience_permission: null, user_id: ID.userB, type: 'job_dead', title_key: 'notification.job_dead', params: '{}', link: null, created_at: T, expires_at: T + 1 },
    ])
    .execute();
  await db
    .insertInto('notification_reads')
    .values([
      { notification_id: ID.noteA, user_id: ID.userA, read_at: T + 4 },
      { notification_id: ID.noteA, user_id: ID.userB, read_at: T + 5 },
    ])
    .execute();
  await db
    .insertInto('schedules')
    .values([
      { name: 'backup.daily', expr: '0 1 * * *', enabled: 1, next_run_at: T + 3_600_000, last_run_at: null },
      { name: 'audit.anchor', expr: '30 2 * * *', enabled: 0, next_run_at: T, last_run_at: T - 86_400_000 },
    ])
    .execute();
  await db
    .insertInto('audit_log')
    .values([
      { id: ID.auditA, seq: 1, at: T, actor_type: 'staff', actor_id: ID.userA, action: 'settings.update', entity: 'settings', entity_id: 'library.name', branch_id: null, ip: '2001:db8::1', meta: '{"changed":["library.name"],"note":"ü"}', prev_hash: HASH('0'), hash: HASH('3') },
      { id: ID.auditB, seq: 2, at: T + 1, actor_type: 'system', actor_id: null, action: 'backup.create', entity: null, entity_id: null, branch_id: ID.branchA, ip: null, meta: '{}', prev_hash: HASH('3'), hash: HASH('4') },
    ])
    .execute();
  await db
    .insertInto('releases_log')
    .values([
      { id: ID.releaseA, version: '0.1.0', action: 'install', from_version: null, status: 'done', started_at: T, finished_at: T + 10, backup_id: null, detail: 'pertama' },
    ])
    .execute();
  await db
    .insertInto('backups')
    .values([
      { id: ID.backupA, kind: 'manual', size: 9_007_199_254_740, sha256: HASH('c'), schema_version: '0009', app_version: '0.1.0', dialect: 'sqlite', consistency: 'snapshot', status: 'ok', created_at: T },
      { id: ID.backupB, kind: 'scheduled', size: null, sha256: null, schema_version: '0009', app_version: '0.1.0', dialect: 'mariadb', consistency: 'frozen', status: 'failed', created_at: T + 1 },
    ])
    .execute();
  // Phase 2 (catalog): the seeds of 0027 carry new ids on each database; the backed-up catalog tables get the sample
  // rows instead, parents first.
  for (const t of ['material_types', 'languages', 'collection_types'] as const) await db.deleteFrom(t).execute();
  // Komunitas (members and circulation): the seeds of 0040 (member types, the general loan rule) likewise.
  for (const t of ['member_types', 'policies'] as const) await db.deleteFrom(t).execute();
  const rows = catalogRows();
  const backedUp = (Object.keys(rows) as CatalogTable[]).filter((t) => TABLE_CLASSES[t] === 'data');
  for (const t of tableLoadOrder(backedUp).order as CatalogTable[]) {
    await (db as unknown as Kysely<Record<string, Record<string, unknown>>>).insertInto(t).values(rows[t]).execute();
  }
  // ---- Komunitas K1 (tables): the backed-up K1 tables, parents first ----
  const k1 = k1Rows();
  const k1BackedUp = (Object.keys(k1) as K1Table[]).filter((t) => TABLE_CLASSES[t] === 'data');
  for (const t of tableLoadOrder(k1BackedUp).order as K1Table[]) {
    await (db as unknown as Kysely<Record<string, Record<string, unknown>>>).insertInto(t).values(k1[t]).execute();
  }
  // ---- Komunitas (members and circulation): its tables, parents first ----
  const circulation = circulationRows();
  const circulationTables = Object.keys(circulation) as CirculationTable[];
  for (const t of tableLoadOrder(circulationTables).order as CirculationTable[]) {
    await (db as unknown as Kysely<Record<string, Record<string, unknown>>>).insertInto(t).values(circulation[t]).execute();
  }
  // ---- Komunitas (holds) ----
  await db.insertInto('holds').values(holdRows().holds).execute();
  // ---- Komunitas (circulation core): the calendar, items read in place, clearance letters ----
  const circCore = circCoreRows();
  for (const t of Object.keys(circCore) as CircCoreTable[]) {
    await (db as unknown as Kysely<Record<string, Record<string, unknown>>>).insertInto(t).values(circCore[t]).execute();
  }
  // ---- Komunitas K2 (visits) ----
  const visits = visitsRows();
  for (const t of Object.keys(visits) as VisitsTableName[]) {
    await (db as unknown as Kysely<Record<string, Record<string, unknown>>>).insertInto(t).values(visits[t]).execute();
  }
  // ---- Komunitas (member area): a bookmark of a sample member, a type list of a sample attachment ----
  await db.insertInto('member_bookmarks').values({ member_id: circulation.members[0]!.id, record_id: '01JU0000000000000000000001', created_at: 1767225600000 }).execute();
  await db.insertInto('attachment_member_types').values({ attachment_id: rows.attachments[0]!.id, member_type_id: '01JU0000000000000000000002' }).execute();
  // ---- Komunitas (charges and payments): parents first ----
  let c = 0;
  const charges = chargesSampleRows({ branchId: ID.branchA, staffId: ID.userA, newId: () => `01JW${String((c += 1)).padStart(22, '0')}` });
  for (const t of ['charges', 'charge_adjustments', 'payments', 'payment_allocations'] as const) {
    await (db as unknown as Kysely<Record<string, Record<string, unknown>>>).insertInto(t).values(charges[t]).execute();
  }
  // ---- Komunitas (notices): no foreign key, fixed ids ----
  let nn = 0;
  await db.insertInto('notices').values(noticesSampleRows({ newId: () => `01JX${String((nn += 1)).padStart(22, '0')}` }).notices).execute();
  // ---- Komunitas K4 (stocktake): sessions first ----
  let st = 0;
  const stocktake = stocktakeSampleRows({ branchId: ID.branchA, staffId: ID.userA, newId: () => `01JY${String((st += 1)).padStart(22, '0')}` });
  for (const t of ['stocktakes', 'stocktake_items', 'stocktake_unknown_codes'] as const) {
    await (db as unknown as Kysely<Record<string, Record<string, unknown>>>).insertInto(t).values(stocktake[t]).execute();
  }
}

/** The circulation core sample rows with ids numbered from another fixed prefix. */
function circCoreRows(): ReturnType<typeof circCoreSampleRows> {
  let n = 0;
  return circCoreSampleRows({ branchId: ID.branchA, staffId: ID.userA, newId: () => `01JU${String((n += 1)).padStart(22, '0')}` });
}

/** Runs a whole export of `h` into `dataDir` and returns its manifest. */
async function exportOf(h: DbHandle, dataDir: string, backupId: string): Promise<BackupManifest> {
  const exporter = createExporter({
    read: h.db,
    dialect: h.dialect,
    dataDir,
    backupId,
    kind: 'manual',
    includeFiles: false,
    consistency: 'frozen',
    appVersion: '0.1.0',
    schemaVersion: SCHEMA_VERSION,
    installId: '01JNNNNNNNNNNNNNNNNNNNNNN1',
    sessionKey: new Uint8Array(32).fill(1),
    kids: ['k1'],
    auditHead: { seq: 2, hash: HASH('4') },
    clock: () => Date.now(),
  });
  let checkpoint: ExportCheckpoint | null = null;
  for (;;) {
    const r = await exporter.step(checkpoint, { deadline: Date.now() + 60_000 });
    checkpoint = r.checkpoint;
    if (r.done) break;
  }
  return (await readManifest(dataDir, backupId))!;
}

describe.skipIf(!ctx.available)(`backup checksums across dialects [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let ref: DbHandle;
  let refDir: string;
  let outDir: string;

  beforeAll(async () => {
    h = await testDb();
    await runMigrations(h, { appVersion: '0.1.0', dataDir: h.dataDir, migrations: PHASE1_MIGRATIONS });
    await seed(h.db);
    refDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-checksum-ref-'));
    outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-checksum-out-'));
    ref = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'server', dataDir: refDir });
    await runMigrations(ref, { appVersion: '0.1.0', dataDir: refDir, migrations: PHASE1_MIGRATIONS });
    await seed(ref.db);
  });

  afterAll(async () => {
    await ref?.close();
    await h?.close();
    if (refDir !== undefined) await fsp.rm(refDir, { recursive: true, force: true });
    if (outDir !== undefined) await fsp.rm(outDir, { recursive: true, force: true });
  });

  it('gives every backed-up table the checksum the SQLite copy gives it', async () => {
    for (const { table } of backupTables(SCHEMA_VERSION)) {
      expect(await countRows(h.db.selectFrom(table)), table).toBeGreaterThan(0);
      const expected = await tableChecksumFromDb(ref.db, 'sqlite', table);
      expect(await tableChecksumFromDb(h.db, h.dialect, table), table).toBe(expected);
    }
  });

  it('exports the same canonical lines from both: equal rows, uncompressed bytes and checksums per table', async () => {
    const fromEngine = await exportOf(h, outDir, '01JPPPPPPPPPPPPPPPPPPPPPP1');
    const fromSqlite = await exportOf(ref, outDir, '01JPPPPPPPPPPPPPPPPPPPPPP2');
    for (const { table } of backupTables(SCHEMA_VERSION)) {
      const a = fromEngine.tables[table]!;
      const b = fromSqlite.tables[table]!;
      expect(a.checksum, table).toBe(b.checksum);
      expect(a.checksum, table).toBe(await tableChecksumFromDb(ref.db, 'sqlite', table));
      expect(a.parts.map((p) => [p.rows, p.bytes, p.firstPk, p.lastPk]), table).toEqual(
        b.parts.map((p) => [p.rows, p.bytes, p.firstPk, p.lastPk]),
      );
    }
    expect(fromEngine.tables['settings']!.rows).toBe(4);
    // Byte order of text keys on every dialect: 'L' (0x4C) < 'l' (0x6C), and 'library.n' < 'library.é'.
    expect(fromEngine.tables['settings']!.parts[0]!.firstPk).toEqual(['Library.Upper']);
    expect(fromEngine.tables['settings']!.parts[0]!.lastPk).toEqual(['smtp.password']);
  });
});
