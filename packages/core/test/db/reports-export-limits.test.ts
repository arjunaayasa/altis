import { resetTestFaults } from '@altis/platform';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { drive, exportNames, jobRow, openExportDb, runRow, startRun, workDirExists, type ExportDb } from './reports-export-support.js';

// The row limits of a format when the size could not be known at the start (a report without a count): the running
// count of the rows phase passes the limit, the run ends failed with REPORT_TOO_LARGE and the job's message names the
// rows, the limit and the format; nothing of the run is left on disk. A full disk ends the run failed with `disk_full`
// at once. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`export row limits [${engineLabel()}]`, () => {
  let db: ExportDb;

  beforeAll(async () => {
    db = await openExportDb('reports-export-limits');
  });

  afterAll(async () => {
    await db?.close();
  });

  afterEach(() => {
    delete process.env['ALTIS_TEST_FAULT'];
    resetTestFaults();
  });

  async function expectTooLarge(run: { id: string; jobId: string }, rows: number, max: number, format: string): Promise<void> {
    const outcomes = await drive(db, run.jobId);
    expect(outcomes.at(-1)).toBe('succeeded');
    expect(await runRow(db, run.id)).toMatchObject({ status: 'failed', error_code: 'REPORT_TOO_LARGE', row_count: null, output_name: null, output_size: null });
    expect((await runRow(db, run.id)).finished_at).not.toBeNull();
    expect((await jobRow(db, run.jobId)).progress_message).toBe(`REPORT_TOO_LARGE rows=${rows} max=${max} format=${format}`);
    expect(await workDirExists(db, run.id)).toBe(false);
    expect((await exportNames(db)).filter((n) => n.startsWith(run.id))).toEqual([]);
  }

  it('a PDF of 10 001 rows without a count fails with REPORT_TOO_LARGE', async () => {
    const run = await startRun(db, 'test.rows', { format: 'pdf', params: { rows: 10_001, countless: true } });
    await expectTooLarge(run, 10_001, 10_000, 'pdf');
  });

  it('an XLSX of 100 001 rows without a count fails with REPORT_TOO_LARGE', async () => {
    const run = await startRun(db, 'test.rows', { format: 'xlsx', params: { rows: 100_001, countless: true } });
    await expectTooLarge(run, 100_001, 100_000, 'xlsx');
  });

  it('a PDF of exactly 10 000 rows is written', async () => {
    const run = await startRun(db, 'test.rows', { format: 'pdf', params: { rows: 10_000, countless: true } });
    expect((await drive(db, run.jobId)).at(-1)).toBe('succeeded');
    expect(await runRow(db, run.id)).toMatchObject({ status: 'succeeded', row_count: 10_000, non_latin_rows: 0 });
  });

  it('a full disk while the rows are written ends the run failed with disk_full, nothing left on disk', async () => {
    const run = await startRun(db, 'test.rows', { format: 'csv', params: { rows: 10 } });
    process.env['ALTIS_TEST_FAULT'] = 'disk-full:tmp:1';
    resetTestFaults();
    expect(await drive(db, run.jobId)).toEqual(['succeeded']);
    expect(await runRow(db, run.id)).toMatchObject({ status: 'failed', error_code: 'disk_full', output_name: null });
    expect((await jobRow(db, run.jobId)).progress_message).toBe('failed: disk_full');
    expect(await workDirExists(db, run.id)).toBe(false);
    expect((await exportNames(db)).filter((n) => n.startsWith(run.id))).toEqual([]);
  });
});
