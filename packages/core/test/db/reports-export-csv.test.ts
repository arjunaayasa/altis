import fsp from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { csvCells, csvLines, drive, exportNames, exportPath, insertPeriod, openExportDb, runRow, startRun, workDirExists, type ExportDb } from './reports-export-support.js';

// The CSV export of a table report: the byte order mark, the header in the run's language, one line per row with every
// cell quoted and a cell that starts like a formula prefixed so it never runs, money as a plain number; the run ends
// `succeeded` with its row count and a seven-day expiry, its work folder removed at once. An accreditation annex is
// always written in Indonesian, whatever language its requester reads. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const WEEK_MS = 604_800_000;

describe.skipIf(!ctx.available)(`the CSV export [${engineLabel()}]`, () => {
  let db: ExportDb;

  beforeAll(async () => {
    db = await openExportDb('reports-export-csv');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('writes the BOM, the English header and 1 203 rows, a formula-like cell guarded; the run succeeds and its work folder goes', async () => {
    const run = await startRun(db, 'test.rows', { format: 'csv', locale: 'en', params: { rows: 1203, texts: ['=HYPERLINK("x")', 'Laskar Pelangi'] } });
    expect(await drive(db, run.jobId)).toEqual(['succeeded']);

    const bytes = await fsp.readFile(exportPath(db, run.id, 'csv'));
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const lines = csvLines(bytes);
    expect(lines[0]).toBe('"Number","Text","Amount"');
    expect(lines).toHaveLength(1 + 1203);
    expect(lines[1]).toBe(`"1","'=HYPERLINK(""x"")","1500"`);
    expect(lines[2]).toBe('"2","Laskar Pelangi","3000"');
    expect(lines[1203]).toBe(`"1203","'=HYPERLINK(""x"")","1804500"`);
    for (let n = 1; n <= 1203; n += 1) {
      expect(csvCells(lines[n]!)).toEqual([String(n), n % 2 === 1 ? `'=HYPERLINK("x")` : 'Laskar Pelangi', String(n * 1500)]);
    }

    const row = await runRow(db, run.id);
    expect(row).toMatchObject({ status: 'succeeded', row_count: 1203, non_latin_rows: null, error_code: null, output_name: `${run.id}.csv` });
    expect(Number(row.output_size)).toBe(bytes.byteLength);
    expect(row.finished_at).not.toBeNull();
    expect(Number(row.expires_at)).toBe(Number(row.finished_at) + WEEK_MS);
    expect(await workDirExists(db, run.id)).toBe(false);
    expect(await exportNames(db)).toContain(`${run.id}.csv`);
  });

  it('the same run with locale id has the Indonesian header', async () => {
    const run = await startRun(db, 'test.rows', { format: 'csv', locale: 'id', params: { rows: 2 } });
    expect(await drive(db, run.jobId)).toEqual(['succeeded']);
    const lines = csvLines(await fsp.readFile(exportPath(db, run.id, 'csv')));
    expect(lines).toEqual(['"Nomor","Teks","Nominal"', '"1","baris 1","1500"', '"2","baris 2","3000"']);
  });

  it('an empty report is the BOM and the header, with a row count of 0', async () => {
    const run = await startRun(db, 'test.rows', { format: 'csv', locale: 'id', params: { rows: 0 } });
    expect(await drive(db, run.jobId)).toEqual(['succeeded']);
    const bytes = await fsp.readFile(exportPath(db, run.id, 'csv'));
    expect(bytes.toString('utf8')).toBe('\uFEFF"Nomor","Teks","Nominal"\r\n');
    expect(await runRow(db, run.id)).toMatchObject({ status: 'succeeded', row_count: 0 });
  });

  it('an accreditation annex requested by a user who reads English is written in Indonesian', async () => {
    const periodId = await insertPeriod(db, 'Tahun ajaran 2025/2026');
    const run = await startRun(db, 'accreditation.annex.budgets', { format: 'csv', locale: 'en', params: { periodId } });
    expect((await runRow(db, run.id)).locale).toBe('id');
    expect(await drive(db, run.jobId)).toEqual(['succeeded']);
    const lines = csvLines(await fsp.readFile(exportPath(db, run.id, 'csv')));
    expect(csvCells(lines[0]!)).toEqual([
      'Tahun',
      'Anggaran perpustakaan',
      'Anggaran lembaga induk',
      'Anggaran lembaga induk di luar belanja pegawai dan pemeliharaan',
      'Anggaran koleksi',
      'Anggaran kegiatan pemustaka',
      'Persentase (%)',
    ]);
  });
});
