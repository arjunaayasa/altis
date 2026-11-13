import fsp from 'node:fs/promises';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { reportColumn } from '../../src/reports/params.js';
import type { ReportRow, TableReport } from '../../src/reports/types.js';
import { drive, exportPath, jobRow, openExportDb, runRow, sheetRows, startRun, workPath, xlsxParts, type ExportDb } from './reports-export-support.js';

// An export across many short slices: each slice does at least one step and then stops on its budget, the next one
// continues from the job's stored checkpoint, and bytes a slice wrote after its last checkpoint (it died before the
// checkpoint was stored) are cut off when the next one starts. The output is the same as that of a run in one slice. A
// report that scans the stock answers pages without rows while its scan runs; the job keeps its cursor in the
// checkpoint and gets the same rows. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const PARAMS = { rows: 1203, texts: ['=HYPERLINK("x")', 'Laskar Pelangi', 'تفسير الجلالين'] };

/** A scan-based report: two pages without rows (the scan's state in the cursor), then its rows. */
const cursors: (string | null)[] = [];
const scanning: TableReport = {
  id: 'collection.scan_test',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.test.rows.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [],
  paramsSchema: z.strictObject({}),
  columns: [reportColumn('n', 'int'), reportColumn('text', 'text')],
  scanBased: () => true,
  async rows(_ctx, cursor) {
    cursors.push(cursor);
    if (cursor === null) return { rows: [], nextCursor: JSON.stringify({ scanned: 1 }) };
    const state = JSON.parse(cursor) as { scanned: number };
    if (state.scanned < 2) return { rows: [], nextCursor: JSON.stringify({ scanned: state.scanned + 1 }) };
    const rows: ReportRow[] = [
      [1, 'Laskar Pelangi'],
      [2, 'Bumi Manusia'],
      [3, null],
    ];
    return { rows, nextCursor: null };
  },
  totals: async () => ['Jumlah', 3],
};

describe.skipIf(!ctx.available)(`exports across slices [${engineLabel()}]`, () => {
  let db: ExportDb;

  beforeAll(async () => {
    db = await openExportDb('reports-export-resume', [scanning]);
  });

  afterAll(async () => {
    await db?.close();
  });

  /**
   * What a slice that died before its checkpoint was stored leaves: rows past the recorded end of `rows.ndjson`, and
   * bytes past the recorded end of `output.part` once it exists (true then).
   */
  async function crashLeftovers(id: string): Promise<boolean> {
    await fsp.appendFile(workPath(db, id, 'rows.ndjson'), '[9999,"sisa irisan yang mati",1]\n[10000,"sisa');
    const part = workPath(db, id, 'output.part');
    if ((await fsp.stat(part).catch(() => null)) === null) return false;
    await fsp.appendFile(part, Buffer.alloc(777, 0x41));
    return true;
  }

  /** The job's stored checkpoint is inside the write phase, past its first rows. */
  async function writing(jobId: string): Promise<boolean> {
    const payload = JSON.parse((await jobRow(db, jobId)).payload) as { phase?: string; state?: { offset?: number } };
    return payload.phase === 'write' && (payload.state?.offset ?? 0) > 0;
  }

  it('a CSV run in 50 ms slices, with leftovers of a dead slice after slice 2, writes the bytes of a one-slice run', async () => {
    const whole = await startRun(db, 'test.rows', { format: 'csv', params: PARAMS });
    expect(await drive(db, whole.jobId)).toEqual(['succeeded']);
    const expected = await fsp.readFile(exportPath(db, whole.id, 'csv'));

    const sliced = await startRun(db, 'test.rows', { format: 'csv', params: PARAMS });
    const payloads: unknown[] = [];
    const outcomes = await drive(db, sliced.jobId, {
      budgetMs: 50,
      afterSlice: async (slice) => {
        payloads.push(JSON.parse((await jobRow(db, sliced.jobId)).payload));
        if (slice === 2) await crashLeftovers(sliced.id);
      },
    });
    expect(outcomes.length).toBeGreaterThanOrEqual(4);
    expect(outcomes.at(-1)).toBe('succeeded');
    expect(payloads[0]).toMatchObject({ runId: sliced.id, phase: 'rows', cursor: '500' });
    expect(payloads.some((p) => (p as { phase?: string }).phase === 'write')).toBe(true);
    expect(await fsp.readFile(exportPath(db, sliced.id, 'csv'))).toEqual(expected);
    expect(await runRow(db, sliced.id)).toMatchObject({ status: 'succeeded', row_count: 1203 });
  });

  it('a CSV run whose output was cut after a write slice is resumed to the same bytes', async () => {
    const whole = await startRun(db, 'test.rows', { format: 'csv', params: PARAMS });
    expect(await drive(db, whole.jobId)).toEqual(['succeeded']);
    const expected = await fsp.readFile(exportPath(db, whole.id, 'csv'));
    const sliced = await startRun(db, 'test.rows', { format: 'csv', params: PARAMS });
    let crashed = false;
    const outcomes = await drive(db, sliced.jobId, {
      budgetMs: 50,
      afterSlice: async () => {
        // Inside the write phase, once `output.part` holds the header and rows.
        if (!crashed && (await writing(sliced.jobId))) {
          crashed = true;
          expect(await crashLeftovers(sliced.id)).toBe(true);
        }
      },
    });
    expect(crashed).toBe(true);
    expect(outcomes.at(-1)).toBe('succeeded');
    expect(await fsp.readFile(exportPath(db, sliced.id, 'csv'))).toEqual(expected);
  });

  it('an XLSX run in 50 ms slices, resumed after leftovers inside the sheet, reads back with the same cells', async () => {
    const whole = await startRun(db, 'test.rows', { format: 'xlsx', params: PARAMS });
    expect(await drive(db, whole.jobId)).toEqual(['succeeded']);
    const expected = sheetRows((await xlsxParts(exportPath(db, whole.id, 'xlsx'))).get('xl/worksheets/sheet1.xml')!);

    const sliced = await startRun(db, 'test.rows', { format: 'xlsx', params: PARAMS });
    let crashed = 0;
    const outcomes = await drive(db, sliced.jobId, {
      budgetMs: 50,
      afterSlice: async (slice) => {
        if (slice === 2 || (crashed === 1 && (await writing(sliced.jobId)))) {
          crashed += 1;
          expect(await crashLeftovers(sliced.id)).toBe(crashed === 2);
        }
      },
    });
    expect(crashed).toBe(2);
    expect(outcomes.length).toBeGreaterThanOrEqual(4);
    expect(outcomes.at(-1)).toBe('succeeded');
    const rows = sheetRows((await xlsxParts(exportPath(db, sliced.id, 'xlsx'))).get('xl/worksheets/sheet1.xml')!);
    expect(rows).toHaveLength(1204);
    expect(rows).toEqual(expected);
  });

  it('a scan-based report answering two pages without rows gives, in 50 ms slices, the output of a long slice', async () => {
    for (const format of ['csv', 'xlsx'] as const) {
      cursors.length = 0;
      const whole = await startRun(db, scanning, { format, params: {} });
      expect(await drive(db, whole.jobId)).toEqual(['succeeded']);
      expect(cursors).toEqual([null, '{"scanned":1}', '{"scanned":2}']);

      cursors.length = 0;
      const sliced = await startRun(db, scanning, { format, params: {} });
      const stored: unknown[] = [];
      const outcomes = await drive(db, sliced.jobId, {
        budgetMs: 50,
        afterSlice: async () => {
          stored.push(JSON.parse((await jobRow(db, sliced.jobId)).payload));
        },
      });
      expect(outcomes.length).toBeGreaterThanOrEqual(3);
      expect(outcomes.at(-1)).toBe('succeeded');
      expect(cursors).toEqual([null, '{"scanned":1}', '{"scanned":2}']);
      expect(stored[0]).toMatchObject({ phase: 'rows', cursor: '{"scanned":1}' });
      expect(stored[1]).toMatchObject({ phase: 'rows', cursor: '{"scanned":2}' });

      const ext = format;
      if (format === 'csv') {
        const bytes = await fsp.readFile(exportPath(db, sliced.id, ext));
        expect(bytes).toEqual(await fsp.readFile(exportPath(db, whole.id, ext)));
        expect(bytes.toString('utf8')).toBe('\uFEFF"Nomor","Teks"\r\n"1","Laskar Pelangi"\r\n"2","Bumi Manusia"\r\n"3",""\r\n"Jumlah","3"\r\n');
      } else {
        const a = sheetRows((await xlsxParts(exportPath(db, sliced.id, ext))).get('xl/worksheets/sheet1.xml')!);
        expect(a).toEqual(sheetRows((await xlsxParts(exportPath(db, whole.id, ext))).get('xl/worksheets/sheet1.xml')!));
        expect(a.map((r) => r.map((c) => c.text))).toEqual([['Nomor', 'Teks'], ['1', 'Laskar Pelangi'], ['2', 'Bumi Manusia'], ['3'], ['Jumlah', '3']]);
      }
      // The totals row is not a data row.
      expect(await runRow(db, sliced.id)).toMatchObject({ status: 'succeeded', row_count: 3 });
    }
  });
});
