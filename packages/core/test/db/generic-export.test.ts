import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PHASE1_MIGRATIONS, TABLE_COLUMNS, dropRegisteredTables, ensureColumn, ensureTable, runMigrations, withTx, type CatalogColumn } from '@altis/db';
import { decodeBase64Url } from '@altis/crypto';
import { dataPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { openAltisbak, readAltisbakHeader } from '../../src/archive/altisbak.js';
import { deriveKek } from '../../src/archive/kdf.js';
import { backupTables } from '../../src/backup/canonical.js';
import { auditHeadOf, finishBackup as finishBackupJob, insertBackupRow, schemaVersionOf } from '../../src/backup/create-job.js';
import { createExporter, type ExportCheckpoint, type ExporterOptions } from '../../src/backup/exporter.js';
import { catalogBackupTables, catalogColumnSpecs, columnSpecOf } from '../../src/backup/generic-columns.js';
import { manifestHmac, readManifest, unknownManifestFields, verifyManifestHmac, type BackupKind, type BackupManifest } from '../../src/backup/manifest.js';
import { backupPrepareDownloadJob, enqueuePrepareDownload } from '../../src/backup/prepare-download.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import {
  KEYRING,
  SESSION_KEY,
  beginRestore,
  liveChecksums,
  loadedChecksums,
  manifestChecksums,
  preparedArchive,
  restoreHarness,
  restoreParams,
  seedInstallation,
  sha256,
  silent,
  stepUntil,
  uploadedArchive,
  type RestoreHarness,
} from '../fixtures/restore-support.js';

// The generic exporter (1d Task 6; spec §9.8 row 3, `schemaHold`: "backup `pre_update` dengan eksportir generik (kolom
// dibaca dari skema DB, bukan registri kode)"; preflight M1, 1D-08) on the engine picked by ALTIS_TEST_DB. With
// `columns: 'catalog'` the exporter takes the tables from `schema_tables` and each table's columns and primary key
// from the database's catalog: on a database the registry describes, it writes the same parts byte for byte as the
// registry export; a table or a column the registry does not know is backed up all the same. The manifest records
// `columnsFrom: 'catalog'`. A manifest written by a later release with a field this one does not know is read and
// restored when the installation's HMAC covers it (unknown field included), and refused once that field was changed.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const INSTALL_ID = newId();

/** `o` without the fields `keys` (a shallow copy). */
function omit<T extends object>(o: T, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([key]) => !keys.includes(key)));
}

describe.skipIf(!ctx.available)(`generic export: columns from the database catalog [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let harness: RestoreHarness | null = null;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-generic-export-')));
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    await dropRegisteredTables(h.db, h.dialect);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await seedInstallation(h, { dataDir, installId: INSTALL_ID });
  });

  afterEach(async () => {
    delete process.env['ALTIS_TEST_EXPORT_PART_ROWS'];
    await harness?.close();
    harness = null;
  });

  const manifestFile = (backupId: string): string => path.join(dataDir, 'backups', backupId, 'manifest.json');
  const partFile = (backupId: string, table: string, n: number): string =>
    path.join(dataDir, 'backups', backupId, 'tables', table, `${String(n).padStart(5, '0')}.jsonl.gz`);

  /** The `running` row of a new backup (a history table: two exports compared need their rows in place first). */
  async function newBackup(kind: BackupKind = 'manual'): Promise<string> {
    const backupId = newId();
    const schemaVersion = await schemaVersionOf(h.db);
    await insertBackupRow(h, { id: backupId, kind, consistency: 'frozen', dialect: h.dialect, schemaVersion, appVersion: '0.1.0', now: Date.now() });
    return backupId;
  }

  /** The backup's row `ok` with the manifest's size and SHA-256, as a finished backup's. */
  async function finishBackup(backupId: string): Promise<void> {
    const bytes = await fsp.readFile(manifestFile(backupId));
    await h.db.updateTable('backups').set({ status: 'ok', size: bytes.byteLength, sha256: sha256(bytes) }).where('id', '=', backupId).execute();
  }

  /** The exporter options of the backup `backupId` with `columns`, its clock stopped at `now`. */
  async function exportOptions(backupId: string, columns: ExporterOptions['columns'], kind: BackupKind, now: number): Promise<ExporterOptions> {
    return {
      read: h.db,
      dialect: h.dialect,
      dataDir,
      backupId,
      kind,
      includeFiles: false,
      consistency: 'frozen',
      appVersion: '0.1.0',
      schemaVersion: await schemaVersionOf(h.db),
      installId: INSTALL_ID,
      sessionKey: SESSION_KEY,
      kids: ['k1'],
      auditHead: await auditHeadOf(h.db),
      clock: () => now,
      ...(columns === undefined ? {} : { columns }),
    };
  }

  /**
   * A whole export with `columns` into the backup `backupId`; returns its manifest. Its clock stands still: with
   * `stepwise`, the way an op runs it when every step is short, each step is a new exporter doing one unit of work (its
   * deadline already reached), resumed from the checkpoint of the step before (a catalog export reads the catalog
   * again each time); otherwise one step does it all.
   */
  async function runExport(backupId: string, columns: ExporterOptions['columns'], o: { kind?: BackupKind; stepwise?: boolean } = {}): Promise<BackupManifest> {
    const now = Date.now();
    const options = await exportOptions(backupId, columns, o.kind ?? 'manual', now);
    const deadline = o.stepwise === true ? now : now + 60_000;
    let checkpoint: ExportCheckpoint | null = null;
    for (let i = 0; i < 5000; i += 1) {
      const r = await createExporter(options).step(checkpoint, { deadline });
      checkpoint = r.checkpoint;
      if (r.done) return (await readManifest(dataDir, backupId))!;
    }
    throw new Error('the export did not finish');
  }

  /** A whole backup of the database exported with `columns` (undefined: the default); the row ends `ok`. */
  async function exportWith(columns: ExporterOptions['columns'], o: { kind?: BackupKind } = {}): Promise<{ backupId: string; manifest: BackupManifest }> {
    const backupId = await newBackup(o.kind);
    const manifest = await runExport(backupId, columns, o);
    await finishBackup(backupId);
    return { backupId, manifest };
  }

  /** A registry export and a catalog export of the same database (both `backups` rows in place before either runs). */
  async function exportBoth(o: { stepwise?: boolean } = {}): Promise<{
    registry: { backupId: string; manifest: BackupManifest };
    catalog: { backupId: string; manifest: BackupManifest };
  }> {
    const ids = { registry: await newBackup(), catalog: await newBackup() };
    const registry = { backupId: ids.registry, manifest: await runExport(ids.registry, undefined, o) };
    const catalog = { backupId: ids.catalog, manifest: await runExport(ids.catalog, 'catalog', o) };
    return { registry, catalog };
  }

  /** The rows of `table` in a backup, from its parts in order. */
  async function backedUpRows(backupId: string, m: BackupManifest, table: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (const part of m.tables[table]!.parts) {
      const text = gunzipSync(await fsp.readFile(partFile(backupId, table, part.n))).toString('utf8');
      for (const line of text.split('\n')) if (line !== '') rows.push(JSON.parse(line) as Record<string, unknown>);
    }
    return rows;
  }

  function newHarness(): RestoreHarness {
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_ID });
    return harness;
  }

  it('catalogColumnSpecs: every table as the registry describes it, each column with a kind of the same encoding', async () => {
    const integers = new Set(['serial', 'bool', 'money', 'timestamp', 'smallint', 'int', 'bigint']);
    // The tables of the database's schema version (the registry of a test build also names `test_fixture`, D1d-26).
    for (const { table } of backupTables(await schemaVersionOf(h.db))) {
      const specs = await catalogColumnSpecs(h.db, h.dialect, table);
      const encoding = (kind: string) => (integers.has(kind) ? 'number' : 'string');
      expect({ table, specs: specs.map((c) => ({ name: c.name, nullable: c.nullable, encoding: encoding(c.kind) })) }).toEqual({
        table,
        specs: TABLE_COLUMNS[table].map((c) => ({ name: c.name, nullable: c.nullable, encoding: encoding(c.kind) })),
      });
    }
  });

  it('columnSpecOf: each catalog family to the column kind whose canonical encoding it shares', () => {
    const of = (c: Omit<CatalogColumn, 'name'>) => {
      const spec = columnSpecOf({ name: 'c', ...c });
      return { kind: spec.kind, length: spec.length ?? null, nullable: spec.nullable };
    };
    expect(of({ family: 'integer', nullable: false, length: null })).toEqual({ kind: 'bigint', length: null, nullable: false });
    expect(of({ family: 'boolean', nullable: true, length: null })).toEqual({ kind: 'bool', length: null, nullable: true });
    expect(of({ family: 'binary', nullable: false, length: 26 })).toEqual({ kind: 'char', length: 26, nullable: false });
    expect(of({ family: 'binary', nullable: false, length: null })).toEqual({ kind: 'char', length: null, nullable: false });
    expect(of({ family: 'text', nullable: false, length: 191 })).toEqual({ kind: 'varchar', length: 191, nullable: false });
    expect(of({ family: 'text', nullable: true, length: null })).toEqual({ kind: 'text', length: null, nullable: true });
    expect(of({ family: 'decimal', nullable: true, length: null })).toEqual({ kind: 'text', length: null, nullable: true });
    expect(of({ family: 'json', nullable: true, length: null })).toEqual({ kind: 'json', length: null, nullable: true });
    expect(of({ family: 'date', nullable: true, length: null })).toEqual({ kind: 'date', length: null, nullable: true });
  });

  it('equality: a catalog export and a registry export have the same tables, checksums and part bytes', { timeout: 120_000 }, async () => {
    // Two rows per part, one unit of work per step: the tables with several rows (and the composite keys of
    // role_permissions and user_roles) are read across parts and across steps from the key of the part before.
    process.env['ALTIS_TEST_EXPORT_PART_ROWS'] = '2';
    const { registry, catalog } = await exportBoth({ stepwise: true });
    expect(registry.manifest.columnsFrom).toBeUndefined();
    expect(catalog.manifest.columnsFrom).toBe('catalog');
    expect(verifyManifestHmac(SESSION_KEY, catalog.manifest)).toBe(true);
    expect(Object.keys(catalog.manifest.tables)).toEqual(Object.keys(registry.manifest.tables));
    expect(catalog.manifest.tables).toEqual(registry.manifest.tables);
    expect(Object.values(catalog.manifest.tables).some((t) => t.parts.length > 1)).toBe(true);
    for (const [table, t] of Object.entries(registry.manifest.tables)) {
      for (const part of t.parts) {
        const a = await fsp.readFile(partFile(registry.backupId, table, part.n));
        const b = await fsp.readFile(partFile(catalog.backupId, table, part.n));
        expect({ table, n: part.n, same: a.equals(b) }).toEqual({ table, n: part.n, same: true });
      }
    }
    // The manifests differ only where they must.
    const fixed = (m: BackupManifest) => omit(m, 'backupId', 'createdAt', 'columnsFrom', 'hmac');
    expect(fixed(catalog.manifest)).toEqual(fixed(registry.manifest));
  });

  it('a table schema_tables records that the registry does not know: in the catalog export with its rows', async () => {
    await ensureTable(h.db, h.dialect, 'test_generic', 'data', 'test', (t) => {
      t.id();
      t.varchar('label', 64);
      t.bool('flag');
      t.json('meta').nullable();
      t.bigint('amount');
      t.date('day');
    });
    await ensureTable(h.db, h.dialect, 'test_generic_cache', 'volatile', 'test', (t) => {
      t.key191('k');
      t.primaryKey(['k']);
    });
    const rows = [
      { id: newId(), label: 'satu', flag: 1, meta: '{"a":1}', amount: 12, day: '2026-10-29' },
      { id: newId(), label: 'dua', flag: 0, meta: null, amount: -3, day: '2026-10-30' },
      { id: newId(), label: 'tiga', flag: 1, meta: '[]', amount: 2 ** 40, day: '2026-10-31' },
    ];
    for (const r of rows) {
      await sql`INSERT INTO test_generic (id, label, flag, meta, amount, day)
        VALUES (${r.id}, ${r.label}, ${r.flag}, ${r.meta}, ${r.amount}, ${r.day})`.execute(h.db);
    }
    await sql`INSERT INTO test_generic_cache (k) VALUES (${'x'})`.execute(h.db);

    const { registry, catalog } = await exportBoth();
    expect(catalog.manifest.tables['test_generic']).toMatchObject({ class: 'data', columns: ['id', 'label', 'flag', 'meta', 'amount', 'day'], rows: 3 });
    expect(await backedUpRows(catalog.backupId, catalog.manifest, 'test_generic')).toEqual([...rows].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(catalog.manifest.tables).not.toHaveProperty('test_generic_cache'); // volatile: never backed up
    expect(registry.manifest.tables).not.toHaveProperty('test_generic');
    expect(omit(catalog.manifest.tables, 'test_generic')).toEqual(registry.manifest.tables);
  });

  it('a catalog backup with a table the registry does not know: finishBackup sizes it ok, and its download is prepared', { timeout: 120_000 }, async () => {
    // Phase-end review C13: the update kind's `self` pre_update ends with the real finishBackup, whose part paths (like
    // the download's) accept the catalog backup's own tables, as the exporter wrote them (preflight M1).
    await ensureTable(h.db, h.dialect, 'test_generic', 'data', 'test', (t) => {
      t.id();
      t.varchar('label', 64);
    });
    await sql`INSERT INTO test_generic (id, label) VALUES (${newId()}, ${'satu'})`.execute(h.db);
    const backupId = await newBackup('pre_update');
    const manifest = await runExport(backupId, 'catalog', { kind: 'pre_update' });
    expect(manifest.tables['test_generic']).toMatchObject({ rows: 1 });

    await finishBackupJob(h, dataDir, { backupId, now: Date.now(), log: silent });
    let size = (await fsp.stat(manifestFile(backupId))).size;
    for (const [table, t] of Object.entries(manifest.tables)) {
      for (const part of t.parts) size += (await fsp.stat(partFile(backupId, table, part.n))).size;
    }
    const row = await h.db.selectFrom('backups').select(['status', 'size']).where('id', '=', backupId).executeTakeFirstOrThrow();
    expect({ status: row.status, size: Number(row.size) }).toEqual({ status: 'ok', size });
    expect(size).toBeGreaterThan((await fsp.stat(manifestFile(backupId))).size + (await fsp.stat(partFile(backupId, 'test_generic', 1))).size);

    const archiveId = await uploadedArchive(h, dataDir, await preparedArchive(h, { dataDir, backupId, preparedBy: await preparer(), passphrase: null, into: root }));
    const archive = await openAltisbak(dataPath(dataDir, 'backups', archiveId, 'archive.altisbak'), { headroomBytes: 1 << 30 });
    try {
      expect((await archive.manifest()).tables['test_generic']).toEqual(manifest.tables['test_generic']);
    } finally {
      await archive.close();
    }
  });

  it('a DECIMAL key column is refused at catalog time (ruling R1d-3); a DECIMAL column outside the key is exported', async () => {
    // A decimal key is read back as a string and compared in byte order, which is not the database's numeric order:
    // the keyset reads and the resume after a part could skip or repeat rows. The catalog refuses it, naming it.
    if (h.dialect === 'sqlite') {
      await sql`CREATE TABLE test_decimal_key (k DECIMAL(10,2) NOT NULL PRIMARY KEY, v TEXT)`.execute(h.db);
      await sql`CREATE TABLE test_decimal_value (id INTEGER NOT NULL PRIMARY KEY, amount DECIMAL(10,2))`.execute(h.db);
    } else if (h.dialect === 'postgres') {
      await sql`CREATE TABLE test_decimal_key (k numeric(10,2) NOT NULL PRIMARY KEY, v text)`.execute(h.db);
      await sql`CREATE TABLE test_decimal_value (id integer NOT NULL PRIMARY KEY, amount numeric(10,2))`.execute(h.db);
    } else {
      await sql`CREATE TABLE test_decimal_key (k decimal(10,2) NOT NULL PRIMARY KEY, v text)`.execute(h.db);
      await sql`CREATE TABLE test_decimal_value (id int NOT NULL PRIMARY KEY, amount decimal(10,2))`.execute(h.db);
    }
    await h.db.insertInto('schema_tables').values({ name: 'test_decimal_value', class: 'data', created_by: 'test' }).execute();
    const tables = await catalogBackupTables(h.db, h.dialect);
    expect(tables.find((t) => t.table === 'test_decimal_value')).toMatchObject({ pk: ['id'], columns: [{ name: 'id', kind: 'bigint' }, { name: 'amount', kind: 'text' }] });

    await h.db.insertInto('schema_tables').values({ name: 'test_decimal_key', class: 'data', created_by: 'test' }).execute();
    await expect(catalogBackupTables(h.db, h.dialect)).rejects.toThrow(/test_decimal_key\.k/);
    await expect(catalogBackupTables(h.db, h.dialect)).rejects.toBeInstanceOf(TypeError);
    await h.db.deleteFrom('schema_tables').where('name', 'in', ['test_decimal_key', 'test_decimal_value']).execute();
    await sql`DROP TABLE test_decimal_key`.execute(h.db);
    await sql`DROP TABLE test_decimal_value`.execute(h.db);
  });

  it('a column ensureColumn added to branches: in the catalog export’s rows, last', async () => {
    await ensureColumn(h.db, h.dialect, 'branches', (t) => t.varchar('note_extra', 64).nullable());
    const first = await h.db.selectFrom('branches').select('id').where('code_key', '=', 'CB1').executeTakeFirstOrThrow();
    await sql`UPDATE branches SET note_extra = ${'catatan'} WHERE id = ${first.id}`.execute(h.db);

    const { registry, catalog } = await exportBoth();
    expect(catalog.manifest.tables['branches']!.columns).toEqual([...TABLE_COLUMNS.branches.map((c) => c.name), 'note_extra']);
    const rows = await backedUpRows(catalog.backupId, catalog.manifest, 'branches');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r['note_extra'])).toEqual(rows.map((r) => (r['id'] === first.id ? 'catatan' : null)));
    expect(registry.manifest.tables['branches']!.columns).not.toContain('note_extra');
    expect(await backedUpRows(registry.backupId, registry.manifest, 'branches')).toEqual(rows.map((r) => omit(r, 'note_extra')));
  });

  it('a catalog that changes between two steps fails the export (BACKUP_INVALID, schema); mismatched checkpoints and options are refused', async () => {
    const backupId = await newBackup();
    const now = Date.now();
    const options = await exportOptions(backupId, 'catalog', 'manual', now);
    const first = await createExporter(options).step(null, { deadline: now });
    expect(first.done).toBe(false);
    expect(first.checkpoint.catalog).toMatch(/^[0-9a-f]{64}$/);
    // The same catalog: the next step goes on from the checkpoint.
    const second = await createExporter(options).step(first.checkpoint, { deadline: now });
    expect(second.checkpoint.catalog).toBe(first.checkpoint.catalog);
    // A registry exporter does not take a catalog export's checkpoint, nor a catalog exporter a registry one's.
    await expect(createExporter({ ...options, columns: 'registry' }).step(second.checkpoint, { deadline: now })).rejects.toBeInstanceOf(TypeError);
    const registryCp = (await createExporter(await exportOptions(await newBackup(), undefined, 'manual', now)).step(null, { deadline: now })).checkpoint;
    expect(registryCp).not.toHaveProperty('catalog');
    await expect(createExporter(options).step(registryCp, { deadline: now })).rejects.toMatchObject({ code: 'BACKUP_INVALID', meta: { reason: 'schema' } });

    await ensureColumn(h.db, h.dialect, 'branches', (t) => t.varchar('note_extra', 64).nullable());
    await expect(createExporter(options).step(second.checkpoint, { deadline: now })).rejects.toMatchObject({
      code: 'BACKUP_INVALID',
      meta: { reason: 'schema' },
    });

    expect(() => createExporter({ ...options, columns: 'other' as never })).toThrow(TypeError);
    expect(() => createExporter({ ...options, schemaVersion: 'latest' })).toThrow(TypeError);
    expect(() => createExporter({ ...options, columns: 'registry', schemaVersion: 'latest' })).toThrow(TypeError);
  });

  /** Signs `extra` into the manifest of `backupId` with the installation's HMAC, as a later release would write it. */
  async function addSignedField(backupId: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    const unsigned = omit(JSON.parse(await fsp.readFile(manifestFile(backupId), 'utf8')) as Record<string, unknown>, 'hmac');
    const signed = { ...unsigned, ...extra };
    const written = { ...signed, hmac: manifestHmac(SESSION_KEY, signed as unknown as BackupManifest) };
    await writeManifestFile(backupId, written);
    return written;
  }

  async function writeManifestFile(backupId: string, m: Record<string, unknown>): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(m)}\n`);
    await fsp.writeFile(manifestFile(backupId), bytes);
    await h.db.updateTable('backups').set({ size: bytes.byteLength, sha256: sha256(bytes) }).where('id', '=', backupId).execute();
  }

  it('a manifest with a field this release does not know, under a valid HMAC: read without it and restored', async () => {
    const { backupId, manifest } = await exportWith('catalog', { kind: 'pre_update' });
    const written = await addSignedField(backupId, { futureField: 1 });

    const read = (await readManifest(dataDir, backupId))!;
    expect(read).toEqual({ ...manifest, hmac: written['hmac'] });
    expect(read).not.toHaveProperty('futureField');
    expect(JSON.stringify(read)).not.toContain('futureField'); // what this release writes from it stays strictly shaped
    expect(verifyManifestHmac(SESSION_KEY, read)).toBe(true);
    expect(verifyManifestHmac(new Uint8Array(32).fill(1), read)).toBe(false);
    // A read manifest changed in place is judged as it is now.
    expect(verifyManifestHmac(SESSION_KEY, { ...read, createdAt: read.createdAt + 1 })).toBe(false);

    const now = Date.now();
    await h.db
      .insertInto('staff_users')
      .values({ id: newId(), username_key: 'baru', username_display: 'baru', name: 'Baru', password_hash: 'x', status: 'active', created_at: now, updated_at: now })
      .execute();
    const restore = newHarness();
    await beginRestore(restore, restoreParams(backupId));
    const status = await stepUntil(restore, dataDir);
    expect(status).toMatchObject({ kind: 'restore', state: 'done', error: null });
    expect(await loadedChecksums(h, read, ['notifications'])).toEqual(manifestChecksums(read, ['notifications']));
    expect(await h.db.selectFrom('staff_users').select('id').where('username_key', '=', 'baru').execute()).toEqual([]);
  });

  it('a later release’s fields at every level: named, dropped under a valid HMAC; the known fields still checked', async () => {
    const { backupId, manifest } = await exportWith('catalog');
    type Raw = Record<string, unknown> & {
      auditHead: Record<string, unknown>;
      tables: Record<string, Record<string, unknown> & { parts: Record<string, unknown>[] }>;
    };
    const raw = JSON.parse(await fsp.readFile(manifestFile(backupId), 'utf8')) as Raw;
    raw.auditHead['chain'] = 'v2';
    raw.tables['branches']!['since'] = '0002';
    raw.tables['branches']!.parts[0]!['codec'] = 'gzip';
    const written = await addSignedField(backupId, { ...omit(raw, 'hmac'), newTop: { nested: [1, 2] } });

    const read = (await readManifest(dataDir, backupId))!;
    expect([...unknownManifestFields(read)].sort()).toEqual(['auditHead.chain', 'newTop', 'tables.branches.parts.0.codec', 'tables.branches.since']);
    expect(read).toEqual({ ...manifest, hmac: written['hmac'] });
    expect(JSON.stringify(read)).not.toMatch(/chain|since|codec|newTop/);
    expect(verifyManifestHmac(SESSION_KEY, read)).toBe(true);
    expect(unknownManifestFields(manifest)).toEqual([]);

    // The fields this release knows are checked as strictly as ever, whatever else the manifest carries.
    await addSignedField(backupId, { kind: 'nightly' });
    await expect(readManifest(dataDir, backupId)).rejects.toMatchObject({ code: 'BACKUP_INVALID', meta: { reason: 'format' } });
  });

  it('the same field changed after signing → BACKUP_INVALID: the restore refuses it, confirmed or not', async () => {
    const { backupId } = await exportWith('catalog', { kind: 'pre_update' });
    const written = await addSignedField(backupId, { futureField: 1 });
    await writeManifestFile(backupId, { ...written, futureField: 2 });

    const read = (await readManifest(dataDir, backupId))!;
    expect(read).not.toHaveProperty('futureField');
    expect(verifyManifestHmac(SESSION_KEY, read)).toBe(false);

    const before = await liveChecksums(h, ['branches', 'staff_users', 'settings']);
    for (const confirmed of [false, true]) {
      const restore = newHarness();
      await beginRestore(restore, restoreParams(backupId, { confirmed }));
      const status = await stepUntil(restore, dataDir);
      expect(status).toMatchObject({ state: 'failed', pointOfNoReturn: false, error: { code: 'BACKUP_INVALID' } });
      expect(status!.error!.detail).toMatch(/futureField/);
      await restore.close();
      harness = null;
    }
    expect(await liveChecksums(h, ['branches', 'staff_users', 'settings'])).toEqual(before);
  });
  // Ruling R1d-3: every manifest reader is the tolerant one, and a download carries a later release's fields.
  const PASSPHRASE = 'frasa sandi arsip yang cukup panjang';
  const OTHER_KEY = new Uint8Array(32).fill(77);

  /** A backup whose manifest a later release signed with fields at two levels (one on a part an encrypted download rewrites). */
  async function laterBackup(): Promise<{ backupId: string; manifest: BackupManifest; written: Record<string, unknown> }> {
    const { backupId, manifest } = await exportWith(undefined);
    type Raw = Record<string, unknown> & { tables: Record<string, { parts: Record<string, unknown>[] }> };
    const raw = JSON.parse(await fsp.readFile(manifestFile(backupId), 'utf8')) as Raw;
    raw.tables['staff_users']!.parts[0]!['codec'] = 'gzip';
    const written = await addSignedField(backupId, { ...omit(raw, 'hmac'), futureField: { a: 1 } });
    return { backupId, manifest, written };
  }

  async function preparer(): Promise<string> {
    return (await h.db.selectFrom('staff_users').select('id').orderBy('id').executeTakeFirstOrThrow()).id;
  }

  it('a download carries a later release’s fields into the archive manifest, under this installation’s new HMAC', { timeout: 120_000 }, async () => {
    const { backupId, manifest } = await laterBackup();
    const preparedBy = await preparer();
    for (const passphrase of [null, PASSPHRASE]) {
      const archiveId = await uploadedArchive(h, dataDir, await preparedArchive(h, { dataDir, backupId, preparedBy, passphrase, into: root }));
      const archive = await openAltisbak(dataPath(dataDir, 'backups', archiveId, 'archive.altisbak'), {
        headroomBytes: 1 << 30,
        ...(passphrase === null ? {} : { passphrase }),
      });
      try {
        const m = await archive.manifest();
        expect([...unknownManifestFields(m)].sort()).toEqual(['futureField', 'tables.staff_users.parts.0.codec']);
        expect(verifyManifestHmac(SESSION_KEY, m)).toBe(true);
        expect(m.secrets).toBe(passphrase === null ? 'keyring' : 'archive');
        // An encrypted download rewrites the parts holding secrets: their new SHA-256 is signed, the part's unknown field kept.
        const sameParts = m.tables['staff_users']!.parts[0]!.sha256 === manifest.tables['staff_users']!.parts[0]!.sha256;
        expect(sameParts).toBe(passphrase === null);
      } finally {
        await archive.close();
      }
    }
  });

  it('a download of a backup whose unknown fields the HMAC does not cover is refused (BACKUP_INVALID, signature)', async () => {
    const { backupId, written } = await laterBackup();
    await writeManifestFile(backupId, { ...written, futureField: { a: 2 } });
    const reg = createJobRegistry([backupPrepareDownloadJob(() => ({ dataDir, keyring: KEYRING, sessionKey: SESSION_KEY }))]);
    const preparedBy = await preparer();
    const { jobId } = await withTx(h, (trx) =>
      enqueuePrepareDownload(trx, { backupId, preparedBy, superAdmin: true, key: null, now: Date.now(), keyring: KEYRING }),
    );
    const job = await claimById(h, reg, jobId, { worker: 'w1', now: Date.now() });
    const r = await runSlice(h, reg, job!, { mode: 'cron_cli', budgetMs: 20_000, keyring: KEYRING, log: silent, clock: () => Date.now(), env: process.env });
    expect(r.outcome).not.toBe('succeeded');
    expect(r.error).toMatch(/^BACKUP_INVALID\b.*futureField/);
    await expect(fsp.stat(path.join(dataDir, 'backups', backupId, 'downloads', preparedBy, 'archive.altisbak'))).rejects.toThrow();
  });

  it('an archive with a later release’s fields: restored under the HMAC or a passphrase, refused unencrypted from elsewhere', { timeout: 180_000 }, async () => {
    const { backupId } = await laterBackup();
    const preparedBy = await preparer();
    const plain = await uploadedArchive(h, dataDir, await preparedArchive(h, { dataDir, backupId, preparedBy, passphrase: null, into: root }));
    const encrypted = await uploadedArchive(h, dataDir, await preparedArchive(h, { dataDir, backupId, preparedBy, passphrase: PASSPHRASE, into: root }));
    const header = await readAltisbakHeader(dataPath(dataDir, 'backups', encrypted, 'archive.altisbak'));
    const kek = await deriveKek(PASSPHRASE, decodeBase64Url(header.encryption!.kdf.salt)!);
    const restoreWith = async (sessionKey: Uint8Array, archiveId: string, secret?: Uint8Array) => {
      const restore = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_ID, sessionKey });
      try {
        await beginRestore(restore, restoreParams(archiveId, { source: 'archive', confirmed: true, withoutFiles: true }), secret === undefined ? {} : { secret });
        return await stepUntil(restore, dataDir);
      } finally {
        await restore.close();
      }
    };
    // This installation: its HMAC covers the fields.
    expect(await restoreWith(SESSION_KEY, plain)).toMatchObject({ state: 'done', error: null });
    // Another installation: an unencrypted archive's unknown fields are covered by nothing it can check.
    const refused = await restoreWith(OTHER_KEY, plain);
    expect(refused).toMatchObject({ state: 'failed', pointOfNoReturn: false, error: { code: 'BACKUP_INVALID' } });
    expect(refused!.error!.detail).toMatch(/futureField/);
    // Another installation with the passphrase: the encrypted manifest is the passphrase holder's (branch b).
    expect(await restoreWith(OTHER_KEY, encrypted, kek)).toMatchObject({ state: 'done', error: null });
  });
});
