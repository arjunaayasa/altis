import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, TABLE_CLASSES, columnsAt, runMigrations, type TableName } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { readMaintenance } from '../../src/ops/files.js';
import { SCHEDULES } from '../../src/scheduler/registry.js';
import { checkRow, newPrepass, prepassStep, readRestoreReport, rekey, type Conflict, type PrepassCheckpoint } from '../../src/restore/prepass.js';
import { openRestoreSource } from '../../src/restore/source.js';
import {
  FIXTURES,
  beginRestore,
  installFixture,
  liveChecksums,
  loadedChecksums,
  manifestChecksums,
  restoreHarness,
  restoreParams,
  seedInstallation,
  stepUntil,
  type RestoreHarness,
} from '../fixtures/restore-support.js';

// The read-only pre-pass of a restore (spec §9.10 step 4; preflight S5; Review Focus 4; plan Task 22) on the engine
// picked by ALTIS_TEST_DB, with the committed SQLite fixtures (another installation, so `confirmed: true`, M7):
// `branches.code_key` 'X', 'X ' and 'X\t' collide on MySQL/MariaDB only ('X' and 'X '; a tab stays significant), and
// the `conflicts` fixture holds a composite UNIQUE collision, a name too long, a NUL, a 70 000-byte TEXT and an int out
// of range, each reported as named for the target's dialect. A conflict fails the op before its point of no return,
// with the report written, the database untouched and maintenance off. The pre-pass itself reads only the backup, so
// its per-dialect results are checked for every target dialect here, whatever engine runs the file.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes 64 MiB per new DATA_DIR.
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const INSTALL_ID = newId();

/**
 * The schedules (scheduler/registry.ts SCHEDULES) added after the committed fixtures were written (1c): a restore of a
 * fixture seeds them beside the archive's rows. 1d Task 28: `update.check`; Phase 2 Task 3: `catalog.housekeeping`.
 */
const SCHEDULES_AFTER_FIXTURES: readonly string[] = ['update.check', 'catalog.housekeeping'];
// The tables of the Phase 1 schema: under the test profile the registry also names the release fixtures' test_fixture
// (decision D1d-26), which this database (PHASE1_MIGRATIONS) does not have.
const PHASE1_SCHEMA = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const DATA_TABLES = (Object.keys(TABLE_CLASSES) as TableName[]).filter(
  (t) => (TABLE_CLASSES[t] === 'data' || TABLE_CLASSES[t] === 'config') && columnsAt(t, PHASE1_SCHEMA).length > 0,
);

/** The conflicts of the fixture `variant` for a `dialect` target, by the pre-pass alone. */
async function prepassOf(dataDir: string, variant: keyof typeof FIXTURES, dialect: 'mysql' | 'mariadb' | 'postgres' | 'sqlite'): Promise<Conflict[]> {
  const source = await openRestoreSource({
    dataDir,
    backupId: FIXTURES[variant],
    source: 'server',
    kek: null,
    opId: newId(),
    headroomBytes: Number.MAX_SAFE_INTEGER,
  });
  let cp: PrepassCheckpoint = newPrepass();
  for (;;) {
    const r = await prepassStep(source, cp, { dialect, deadline: Date.now() + 10_000, clock: Date.now, external: true, withoutFiles: false });
    cp = r.checkpoint;
    if (r.done) break;
  }
  return cp.conflicts;
}

const summary = (conflicts: Conflict[]) => conflicts.map((c) => ({ table: c.table, kind: c.kind, columns: c.columns, detail: c.detail ?? null }));

describe('rekey and checkRow (S5)', () => {
  it('rekey strips trailing U+0020 per text component on MySQL/MariaDB only; a tab stays', () => {
    expect(rekey('mariadb', ['X '])).toBe(rekey('mariadb', ['X']));
    expect(rekey('mysql', ['u', 'r', 'B  '])).toBe(rekey('mysql', ['u', 'r', 'B']));
    expect(rekey('mariadb', ['X\t'])).not.toBe(rekey('mariadb', ['X']));
    expect(rekey('mariadb', [' X'])).not.toBe(rekey('mariadb', ['X']));
    expect(rekey('postgres', ['X '])).not.toBe(rekey('postgres', ['X']));
    expect(rekey('sqlite', ['X '])).not.toBe(rekey('sqlite', ['X']));
    expect(rekey('mariadb', [1, 'a '])).toBe(rekey('mariadb', [1, 'a']));
    expect(rekey('mariadb', [1, 'a'])).not.toBe(rekey('mariadb', ['1', 'a']));
  });

  it('checkRow: columns, NULLs, integers, CHAR lengths, UTF-16, NUL and TEXT bytes per dialect', () => {
    const columns = columnsAt('staff_recovery_codes', '0009');
    const ok = { id: newId(), user_id: newId(), code_hash: 'a'.repeat(64), used_at: null, created_at: 1 };
    expect(checkRow('staff_recovery_codes', JSON.stringify(ok), columns, 'mariadb').conflicts).toEqual([]);
    const kinds = (row: object, dialect: 'mariadb' | 'postgres' | 'sqlite' = 'mariadb') =>
      summary(checkRow('staff_recovery_codes', JSON.stringify(row), columns, dialect).conflicts);
    expect(kinds({ ...ok, code_hash: 'a'.repeat(63) })).toEqual([{ table: 'staff_recovery_codes', kind: 'invalid', columns: ['code_hash'], detail: 'char_length' }]);
    expect(kinds({ ...ok, created_at: null })).toEqual([{ table: 'staff_recovery_codes', kind: 'invalid', columns: ['created_at'], detail: null }]);
    expect(kinds({ ...ok, created_at: 2 ** 53 })).toEqual([{ table: 'staff_recovery_codes', kind: 'invalid', columns: ['created_at'], detail: null }]);
    expect(kinds({ ...ok, extra: 1 })).toEqual([{ table: 'staff_recovery_codes', kind: 'invalid', columns: ['extra'], detail: null }]);
    expect(kinds({ ...ok, code_hash: `${'a'.repeat(63)}\uD800` })).toEqual([{ table: 'staff_recovery_codes', kind: 'invalid', columns: ['code_hash'], detail: 'utf16' }]);
    // An id of 26 characters that is no ULID loads as it is (hand-made ids exist), except a file's: it becomes a path
    // segment (uploads/<yyyy>/<mm>/<id>) only in finalizing, past the point of no return, so the pre-pass refuses it.
    expect(kinds({ ...ok, id: '01JBRANCHSUMBER00000000000' })).toEqual([]);
    const files = columnsAt('files', '0009');
    const file = { id: newId(), original_name: 'a.txt', mime: 'text/plain', size: 1, sha256: 'a'.repeat(64), context: 'test', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: 1, created_by: null };
    expect(checkRow('files', JSON.stringify(file), files, 'mariadb').conflicts).toEqual([]);
    for (const id of [`${'A'.repeat(25)}!`, '01JBRANCHSUMBER00000000000', newId().toLowerCase()]) {
      expect(summary(checkRow('files', JSON.stringify({ ...file, id }), files, 'mariadb').conflicts)).toEqual([{ table: 'files', kind: 'invalid', columns: ['id'], detail: null }]);
    }
    expect(summary(checkRow('staff_recovery_codes', '{not json', columns, 'mariadb').conflicts)).toEqual([
      { table: 'staff_recovery_codes', kind: 'invalid', columns: [], detail: null },
    ]);
    const audit = columnsAt('audit_log', '0009');
    const entry = {
      id: newId(),
      seq: 1,
      at: 1,
      actor_type: 'system',
      actor_id: null,
      action: 'x',
      entity: null,
      entity_id: null,
      branch_id: null,
      ip: null,
      meta: `{"a":"${'é'.repeat(40_000)}"}`,
      prev_hash: '0'.repeat(64),
      hash: '1'.repeat(64),
    };
    expect(summary(checkRow('audit_log', JSON.stringify(entry), audit, 'mariadb').conflicts)).toEqual([
      { table: 'audit_log', kind: 'invalid', columns: ['meta'], detail: 'text_bytes' },
    ]);
    expect(checkRow('audit_log', JSON.stringify(entry), audit, 'postgres').conflicts).toEqual([]);
    const nul = { ...entry, meta: '{"a":"\u0000"}' };
    expect(summary(checkRow('audit_log', JSON.stringify(nul), audit, 'postgres').conflicts)).toEqual([
      { table: 'audit_log', kind: 'invalid', columns: ['meta'], detail: 'nul' },
    ]);
    expect(checkRow('audit_log', JSON.stringify(nul), audit, 'sqlite').conflicts).toEqual([]);
  });
});

describe('the pre-pass of the committed SQLite fixtures, for every target dialect', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-prepass-')));
    for (const variant of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]) {
      await fsp.cp(path.join(import.meta.dirname, '..', 'fixtures', 'sqlite-archive', variant), path.join(dir, 'backups', FIXTURES[variant]), { recursive: true });
    }
  });

  afterAll(async () => {
    if (dir !== undefined) await fsp.rm(dir, { recursive: true, force: true });
  });

  it("'X' and 'X ' collide on MySQL/MariaDB only, 'X\\t' never (S5a)", async () => {
    for (const dialect of ['mysql', 'mariadb'] as const) {
      const conflicts = await prepassOf(dir, 'pad-space', dialect);
      expect(summary(conflicts)).toEqual([{ table: 'branches', kind: 'duplicate', columns: ['code_key'], detail: null }]);
      expect(conflicts[0]!.value).toBe('X');
      expect(conflicts[0]!.pk).toHaveLength(1);
    }
    expect(await prepassOf(dir, 'pad-space', 'postgres')).toEqual([]);
    expect(await prepassOf(dir, 'pad-space', 'sqlite')).toEqual([]);
  });

  it('the conflicts fixture: each row reported as named for the dialect (S5b-d)', async () => {
    const sorted = (c: Conflict[]) => summary(c).sort((a, b) => `${a.table}${a.columns.join()}`.localeCompare(`${b.table}${b.columns.join()}`));
    const everywhere = [
      { table: 'branches', kind: 'too_long', columns: ['name'], detail: null },
      { table: 'staff_users', kind: 'invalid', columns: ['authz_version'], detail: 'int_range' },
    ];
    expect(sorted(await prepassOf(dir, 'conflicts', 'mariadb'))).toEqual(
      sorted([
        ...everywhere,
        { table: 'user_roles', kind: 'duplicate', columns: ['user_id', 'role_id', 'scope_key'], detail: null },
        { table: 'audit_log', kind: 'invalid', columns: ['meta'], detail: 'text_bytes' },
      ] as Conflict[]),
    );
    expect(sorted(await prepassOf(dir, 'conflicts', 'postgres'))).toEqual(
      sorted([...everywhere, { table: 'branches', kind: 'invalid', columns: ['address'], detail: 'nul' }] as Conflict[]),
    );
    expect(sorted(await prepassOf(dir, 'conflicts', 'sqlite'))).toEqual(sorted(everywhere as Conflict[]));
    const tooLong = (await prepassOf(dir, 'conflicts', 'sqlite')).find((c) => c.kind === 'too_long')!;
    expect(tooLong.value).toBe('n'.repeat(64));
  });
});

describe.skipIf(!ctx.available)(`restore pre-pass through the op [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let harness: RestoreHarness;
  const mysql = (): boolean => h.dialect === 'mysql' || h.dialect === 'mariadb';

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-restore-prepass-')));
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    // A fresh target for every test: migrated and seeded (a restore that went through drops and reloads it).
    const { dropRegisteredTables } = await import('@altis/db');
    await dropRegisteredTables(h.db, h.dialect);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    await seedInstallation(h, { dataDir, installId: INSTALL_ID });
    harness = restoreHarness({ dataDir, config: h.config, dbDataDir: h.dataDir, live: h, installId: INSTALL_ID });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('pad-space fixture: MySQL/MariaDB fail before PONR with one duplicate in report.json; elsewhere done with its checksums', async () => {
    const { backupId, manifest } = await installFixture(h, dataDir, 'pad-space');
    const before = await liveChecksums(h, DATA_TABLES);
    const opId = await beginRestore(harness, restoreParams(backupId, { confirmed: true }));
    const status = await stepUntil(harness, dataDir);
    expect(await readMaintenance(dataDir)).toBeNull();
    if (mysql()) {
      expect(status).toMatchObject({ state: 'failed', terminal: true, pointOfNoReturn: false, error: { code: 'RESTORE_CONFLICTS' } });
      const report = await readRestoreReport(dataDir, opId);
      expect(report).toMatchObject({ ok: false });
      expect(summary(report!.conflicts)).toEqual([{ table: 'branches', kind: 'duplicate', columns: ['code_key'], detail: null }]);
      expect(await liveChecksums(h, DATA_TABLES)).toEqual(before);
      return;
    }
    expect(status).toMatchObject({ state: 'done', terminal: true, error: null });
    // The restore seeds the code's schedules again (restore/load.ts, seedSchedules): those this release defines after
    // the fixture was written are added beside its rows, so the table holds every schedule of SCHEDULES. Once seen, the
    // added ones are set aside so the archive's own rows are compared with the manifest's checksum.
    const schedules = await h.db.selectFrom('schedules').select('name').execute();
    expect(schedules.map((r) => r.name).sort()).toEqual(SCHEDULES.map((d) => d.name).sort());
    const added = await h.db.selectFrom('schedules').select('name').where('name', 'in', SCHEDULES_AFTER_FIXTURES).execute();
    expect(added.map((r) => r.name).sort()).toEqual([...SCHEDULES_AFTER_FIXTURES].sort());
    await h.db.deleteFrom('schedules').where('name', 'in', SCHEDULES_AFTER_FIXTURES).execute();
    expect(await loadedChecksums(h, manifest, ['notifications'])).toEqual(manifestChecksums(manifest, ['notifications']));
    expect(await readRestoreReport(dataDir, opId)).toMatchObject({ ok: true, conflicts: [] });
    const codes = await h.db.selectFrom('branches').select('code_key').execute();
    expect(codes.map((r) => r.code_key).sort()).toEqual(['X', 'X\t', 'X ']);
  });

  it('conflicts fixture: RESTORE_CONFLICTS before PONR, each conflict in report.json, the database untouched', async () => {
    const { backupId } = await installFixture(h, dataDir, 'conflicts');
    const before = await liveChecksums(h, DATA_TABLES);
    const opId = await beginRestore(harness, restoreParams(backupId, { confirmed: true }));
    const status = await stepUntil(harness, dataDir);
    expect(status).toMatchObject({ state: 'failed', pointOfNoReturn: false, error: { code: 'RESTORE_CONFLICTS' } });
    const report = await readRestoreReport(dataDir, opId);
    const kinds = new Set(report!.conflicts.map((c) => `${c.table}.${c.columns.join('+')}:${c.kind}:${c.detail ?? ''}`));
    expect(kinds).toContain('branches.name:too_long:');
    expect(kinds).toContain('staff_users.authz_version:invalid:int_range');
    if (mysql()) {
      expect(kinds).toContain('user_roles.user_id+role_id+scope_key:duplicate:');
      expect(kinds).toContain('audit_log.meta:invalid:text_bytes');
    }
    if (h.dialect === 'postgres') expect(kinds).toContain('branches.address:invalid:nul');
    expect(await liveChecksums(h, DATA_TABLES)).toEqual(before);
    expect(await readMaintenance(dataDir)).toBeNull();
    const audit = await h.db.selectFrom('audit_log').select(['meta', 'entity_id']).where('action', '=', 'backup.restore').execute();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.meta)).toMatchObject({ opId, outcome: 'failed', error: 'RESTORE_CONFLICTS', sourceInstallId: '01K5Q8M2X0S0VRCE0000000000' });
  });

  it("schemaVersion '9999_future' → failed BACKUP_SCHEMA_TOO_NEW in verifying", async () => {
    const { backupId } = await installFixture(h, dataDir, 'pad-space');
    const file = path.join(dataDir, 'backups', backupId, 'manifest.json');
    const m = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    await fsp.writeFile(file, JSON.stringify({ ...m, schemaVersion: '9999_future' }));
    await beginRestore(harness, restoreParams(backupId, { confirmed: true }));
    expect(await stepUntil(harness, dataDir)).toMatchObject({ state: 'failed', pointOfNoReturn: false, error: { code: 'BACKUP_SCHEMA_TOO_NEW' } });
  });

  it('one flipped byte in a part → BACKUP_INVALID (checksum) in verifying, the database untouched', async () => {
    const { backupId } = await installFixture(h, dataDir, 'pad-space');
    const part = path.join(dataDir, 'backups', backupId, 'tables', 'branches', '00001.jsonl.gz');
    const bytes = await fsp.readFile(part);
    bytes[20] = (bytes[20] ?? 0) ^ 0xff;
    await fsp.writeFile(part, bytes);
    const before = await liveChecksums(h, DATA_TABLES);
    await beginRestore(harness, restoreParams(backupId, { confirmed: true }));
    const status = await stepUntil(harness, dataDir);
    expect(status).toMatchObject({ state: 'failed', pointOfNoReturn: false, error: { code: 'BACKUP_INVALID' } });
    expect(status!.error!.detail).toMatch(/SHA-256/);
    expect(await liveChecksums(h, DATA_TABLES)).toEqual(before);
  });

  it('an external archive with confirmed: false → failed in verifying with BACKUP_CONFIRM_REQUIRED, the database untouched', async () => {
    const { backupId } = await installFixture(h, dataDir, 'pad-space');
    const before = await liveChecksums(h, DATA_TABLES);
    await beginRestore(harness, restoreParams(backupId, { confirmed: false }));
    const status = await stepUntil(harness, dataDir);
    expect(status).toMatchObject({ state: 'failed', pointOfNoReturn: false, error: { code: 'BACKUP_CONFIRM_REQUIRED' } });
    expect(await liveChecksums(h, DATA_TABLES)).toEqual(before);
    expect(await readMaintenance(dataDir)).toBeNull();
  });
});
