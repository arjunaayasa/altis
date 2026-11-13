import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { drive, exportNames, jobRow, openExportDb, runRow, startRun, workDirExists, type ExportDb } from './reports-export-support.js';

// A cancel request the export's slice sees ends the run `cancelled` and removes its work folder and its partial
// output; the job ends cancelled too. A run another process ended already (the housekeeping marked it abandoned) is
// left as it is. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`cancelling an export [${engineLabel()}]`, () => {
  let db: ExportDb;

  beforeAll(async () => {
    db = await openExportDb('reports-export-cancel');
  });

  afterAll(async () => {
    await db?.close();
  });

  for (const format of ['csv', 'xlsx', 'pdf'] as const) {
    it(`a ${format.toUpperCase()} run cancelled after its first slice ends cancelled with nothing left on disk`, async () => {
      const run = await startRun(db, 'test.rows', { format, params: { rows: 1203 } });
      const outcomes = await drive(db, run.jobId, {
        budgetMs: 50,
        afterSlice: async (slice) => {
          if (slice !== 1) return;
          expect(await workDirExists(db, run.id)).toBe(true);
          expect((await runRow(db, run.id)).status).toBe('running');
          // The request reached the job while its slice ran; the next slice sees it from its start.
          await db.h.db.updateTable('jobs').set({ cancel_requested: 1 }).where('id', '=', run.jobId).execute();
        },
      });
      expect(outcomes).toEqual(['continued', 'cancelled']);
      const row = await runRow(db, run.id);
      expect(row).toMatchObject({ status: 'cancelled', error_code: null, output_name: null, row_count: null });
      expect(row.finished_at).not.toBeNull();
      expect((await jobRow(db, run.jobId)).status).toBe('cancelled');
      expect(await workDirExists(db, run.id)).toBe(false);
      expect((await exportNames(db)).filter((n) => n.startsWith(run.id))).toEqual([]);
    });
  }

  it('a run that was ended elsewhere is left as it is and its job ends', async () => {
    const run = await startRun(db, 'test.rows', { format: 'csv', params: { rows: 1203 } });
    const outcomes = await drive(db, run.jobId, {
      budgetMs: 50,
      afterSlice: async (slice) => {
        if (slice === 1) await db.h.db.updateTable('report_runs').set({ status: 'failed', error_code: 'abandoned', finished_at: Date.now() }).where('id', '=', run.id).execute();
      },
    });
    expect(outcomes).toEqual(['continued', 'succeeded']);
    expect(await runRow(db, run.id)).toMatchObject({ status: 'failed', error_code: 'abandoned' });
    expect(await workDirExists(db, run.id)).toBe(false);
    expect((await exportNames(db)).filter((n) => n.startsWith(run.id))).toEqual([]);
  });
});
