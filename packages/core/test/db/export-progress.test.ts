import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { backupTables } from '../../src/backup/canonical.js';
import { createExporter, type ExportCheckpoint } from '../../src/backup/exporter.js';

// 1d T11-EXPORT-PROGRESS-GRANULARITY (plan Task 24): the exporter's progress moves inside a table. The checkpoint
// records the rows the table held when its export began (`tableRows`), and the progress of the `tables` phase is
// `(tables done + rows done / max(1, tableRows)) / tables` of its share, so a backup whose first table is large (the
// audit log) no longer reports 0 until that table is complete.

const ctx = testDbContext();
const NOW = 1_800_000_000_000;
const KEY = new Uint8Array(32).fill(21);
const SCHEMA_VERSION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const AUDIT_ROWS = 5000;
const PART_ROWS = 1000;

/** Audit row ids that sort like their number. */
const auditId = (i: number): string => `A${String(i).padStart(25, '0')}`;

describe.skipIf(!ctx.available)(`export progress inside a table [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-export-progress-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(dataDir, 'mig'), migrations: PHASE1_MIGRATIONS });
    await withTx(h, async (trx) => {
      const rows = [];
      for (let i = 0; i < AUDIT_ROWS; i += 1) {
        rows.push({
          id: auditId(i),
          seq: i + 1,
          at: NOW + i,
          actor_type: 'system',
          action: 'settings.update',
          meta: `{"n":${i}}`,
          prev_hash: '0'.repeat(64),
          hash: '1'.repeat(64),
        });
      }
      for (let at = 0; at < rows.length; at += 500) await trx.insertInto('audit_log').values(rows.slice(at, at + 500)).execute();
    });
    vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', String(PART_ROWS));
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('5000 audit_log rows in parts of 1000: after the second part the progress is above 0 and below a third, and it moves inside the table', async () => {
    const tables = backupTables(SCHEMA_VERSION);
    const auditIndex = tables.findIndex((t) => t.table === 'audit_log');
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    const exporter = createExporter({
      read: h.db,
      dialect: h.dialect,
      dataDir,
      backupId: newId(),
      kind: 'manual',
      includeFiles: false,
      consistency: 'frozen',
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      installId: newId(),
      sessionKey: KEY,
      kids: ['k1'],
      auditHead: { seq: AUDIT_ROWS, hash: 'f'.repeat(64) },
      clock: () => Date.now(),
    });
    // A deadline already past: each step does exactly one unit of work (one part).
    let checkpoint: ExportCheckpoint | null = null;
    let before = -1;
    const seen: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const r = await exporter.step(checkpoint, { deadline: Date.now() });
      checkpoint = r.checkpoint;
      seen.push(r.progress);
      if (checkpoint.phase === 'tables' && checkpoint.table === auditIndex && checkpoint.written['audit_log'] === undefined) before = r.progress;
      if (checkpoint.written['audit_log'] === 2) {
        // The table's rows as counted when its export began.
        expect(checkpoint.tableRows).toBe(AUDIT_ROWS);
        expect(checkpoint).toMatchObject({ phase: 'tables', table: auditIndex, part: 3 });
        expect(r.progress).toBeGreaterThan(0);
        expect(r.progress).toBeLessThan(100 / 3);
        expect(r.progress).toBeGreaterThanOrEqual(before);
        // (tables done + rows done / tableRows) / tables of the 80 % the tables phase holds.
        expect(r.progress).toBe(Math.floor((80 * (auditIndex + (2 * PART_ROWS) / AUDIT_ROWS)) / tables.length));
      }
      // Phase 2's catalog tables make one table's share of the 80 % about 2 points: two parts of five may not reach the
      // next whole percent, the last part before the table ends does (tables done + 4/5).
      if (checkpoint.written['audit_log'] === AUDIT_ROWS / PART_ROWS - 1) {
        expect(checkpoint).toMatchObject({ phase: 'tables', table: auditIndex });
        expect(r.progress).toBeGreaterThan(before);
        expect(r.progress).toBe(Math.floor((80 * (auditIndex + (AUDIT_ROWS - PART_ROWS) / AUDIT_ROWS)) / tables.length));
        break;
      }
    }
    expect(checkpoint?.written['audit_log']).toBe(AUDIT_ROWS / PART_ROWS - 1);
    // Never backwards.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('the progress never goes backwards across a whole export and ends at 100', async () => {
    const exporter = createExporter({
      read: h.db,
      dialect: h.dialect,
      dataDir,
      backupId: newId(),
      kind: 'manual',
      includeFiles: false,
      consistency: 'frozen',
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      installId: newId(),
      sessionKey: KEY,
      kids: ['k1'],
      auditHead: { seq: AUDIT_ROWS, hash: 'f'.repeat(64) },
      clock: () => Date.now(),
    });
    let checkpoint: ExportCheckpoint | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const r = await exporter.step(checkpoint, { deadline: Date.now() });
      checkpoint = r.checkpoint;
      seen.push(r.progress);
      if (r.done) break;
    }
    expect(seen.at(-1)).toBe(100);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    // Several distinct values while the audit log alone is exported.
    expect(new Set(seen.slice(0, 5)).size).toBeGreaterThan(1);
  });
});
