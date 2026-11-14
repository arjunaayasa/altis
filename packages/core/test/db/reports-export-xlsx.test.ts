import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { drive, exportPath, openExportDb, runRow, sheetRows, startRun, workDirExists, xlsxParts, type ExportDb } from './reports-export-support.js';

// The XLSX export of a table report: one sheet named after the report, the header in the run's language, numbers of
// `int` and `money` columns as numbers and text as inline strings (a formula-like text guarded), read back with our own
// ZIP and XML readers. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`the XLSX export [${engineLabel()}]`, () => {
  let db: ExportDb;

  beforeAll(async () => {
    db = await openExportDb('reports-export-xlsx');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('reads back with 1 204 rows: the header, then numbers as <v> and text as inline strings', async () => {
    const run = await startRun(db, 'test.rows', { format: 'xlsx', locale: 'en', params: { rows: 1203, texts: ['=HYPERLINK("x")', 'Laskar Pelangi'] } });
    expect(await drive(db, run.jobId)).toEqual(['succeeded']);

    const parts = await xlsxParts(exportPath(db, run.id, 'xlsx'));
    expect([...parts.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(parts.get('xl/workbook.xml')).toContain('name="Test rows"');
    const rows = sheetRows(parts.get('xl/worksheets/sheet1.xml')!);
    expect(rows).toHaveLength(1204);
    expect(rows[0]!.map((c) => [c.type, c.text])).toEqual([
      ['inlineStr', 'Number'],
      ['inlineStr', 'Text'],
      ['inlineStr', 'Amount'],
    ]);
    expect(rows[1]).toEqual([
      { ref: 'A2', type: 'n', text: '1' },
      { ref: 'B2', type: 'inlineStr', text: `'=HYPERLINK("x")` },
      { ref: 'C2', type: 'n', text: '1500' },
    ]);
    expect(rows[1203]).toEqual([
      { ref: 'A1204', type: 'n', text: '1203' },
      { ref: 'B1204', type: 'inlineStr', text: `'=HYPERLINK("x")` },
      { ref: 'C1204', type: 'n', text: '1804500' },
    ]);
    for (let n = 1; n <= 1203; n += 1) {
      expect(rows[n]!.map((c) => c.text)).toEqual([String(n), n % 2 === 1 ? `'=HYPERLINK("x")` : 'Laskar Pelangi', String(n * 1500)]);
    }

    const row = await runRow(db, run.id);
    expect(row).toMatchObject({ status: 'succeeded', row_count: 1203, non_latin_rows: null, output_name: `${run.id}.xlsx` });
    expect(await workDirExists(db, run.id)).toBe(false);
  });

  it('an empty report is a workbook with the header row only', async () => {
    const run = await startRun(db, 'test.rows', { format: 'xlsx', locale: 'id', params: { rows: 0 } });
    expect(await drive(db, run.jobId)).toEqual(['succeeded']);
    const rows = sheetRows((await xlsxParts(exportPath(db, run.id, 'xlsx'))).get('xl/worksheets/sheet1.xml')!);
    expect(rows.map((r) => r.map((c) => c.text))).toEqual([['Nomor', 'Teks', 'Nominal']]);
    expect(await runRow(db, run.id)).toMatchObject({ status: 'succeeded', row_count: 0 });
  });
});
