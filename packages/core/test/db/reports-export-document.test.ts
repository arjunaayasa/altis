import fsp from 'node:fs/promises';
import { appendLine, reportWorkPath } from '@altis/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import type { DocumentCtx, DocumentReport } from '../../src/reports/types.js';
import { STAFF_NAME, drive, exportNames, exportPath, jobRow, openExportDb, runRow, startRun, storedParams, workDirExists, type ExportDb } from './reports-export-support.js';

// A document report renders its own file across slices: one render per slice, the resume state kept in the job's
// checkpoint, the warning codes of its end stored in the run's parameters and the job ending with the fixed message
// `warnings` the run views translate. A resume state larger than a checkpoint may hold ends the run failed. On the
// engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

/** A document that answers a resume state too large for the job's checkpoint. */
const oversized: DocumentReport = {
  id: 'collection.document_oversized',
  module: 'collection',
  kind: 'document',
  titleKey: 'report.test.document.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['pdf'],
  orientation: 'portrait',
  params: [],
  paramsSchema: z.strictObject({}),
  async render() {
    return { done: false, resume: { phase: 'big', cursor: null, state: 'x'.repeat(60_001) } };
  },
};

/** A document that records what its context tells it, then ends with more warnings than a run keeps. */
const seen: Partial<DocumentCtx>[] = [];
const recording: DocumentReport = {
  ...oversized,
  id: 'collection.document_recording',
  formats: ['pdf', 'zip'],
  async render(c, resume) {
    seen.push({ runId: c.runId, format: c.format, libraryName: c.libraryName, staffName: c.staffName, appVersion: c.appVersion, locale: c.locale, params: c.params });
    expect(await c.cancelled()).toBe(false);
    await c.heartbeat(50);
    await appendLine(reportWorkPath(c.dataDir, c.runId, 'output.part'), `resume:${resume === null ? 'null' : resume.phase}`);
    if (resume === null) return { done: false, resume: { phase: 'two', cursor: 'c', state: { n: 1 } } };
    expect(resume).toEqual({ phase: 'two', cursor: 'c', state: { n: 1 } });
    return { done: true, rowCount: 7, nonLatinRows: 1, warnings: Array.from({ length: 25 }, (_, i) => `warning_${i + 1}`) };
  },
};

describe.skipIf(!ctx.available)(`document runs [${engineLabel()}]`, () => {
  let db: ExportDb;

  beforeAll(async () => {
    db = await openExportDb('reports-export-document', [oversized, recording]);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('test.document finishes in three slices as a ZIP with 3 rows, its warning stored and the job message "warnings"', async () => {
    const run = await startRun(db, 'test.document', { format: 'zip', params: {} });
    expect(await drive(db, run.jobId)).toEqual(['continued', 'continued', 'succeeded']);
    const row = await runRow(db, run.id);
    expect(row).toMatchObject({ status: 'succeeded', format: 'zip', row_count: 3, non_latin_rows: null, output_name: `${run.id}.zip`, error_code: null });
    expect(Number(row.expires_at)).toBe(Number(row.finished_at) + 604_800_000);
    expect((await storedParams(db, run.id)).warnings).toEqual(['test_warning']);
    expect((await storedParams(db, run.id)).def).toEqual({});
    expect((await jobRow(db, run.jobId)).progress_message).toBe('warnings');
    const bytes = await fsp.readFile(exportPath(db, run.id, 'zip'));
    expect(bytes.toString('utf8')).toBe('test-document:1\ntest-document:2\ntest-document:3\n');
    expect(Number(row.output_size)).toBe(bytes.byteLength);
    expect(await workDirExists(db, run.id)).toBe(false);
  });

  it('gives the document its run, format, library, requester, release and parameters; keeps 20 warnings; a PDF counts non-Latin rows', async () => {
    seen.length = 0;
    const run = await startRun(db, recording, { format: 'pdf', locale: 'en', params: {} });
    expect(await drive(db, run.jobId)).toEqual(['continued', 'succeeded']);
    expect(seen).toEqual([
      { runId: run.id, format: 'pdf', libraryName: 'Perpustakaan', staffName: STAFF_NAME, appVersion: '0.1.0', locale: 'en', params: {} },
      { runId: run.id, format: 'pdf', libraryName: 'Perpustakaan', staffName: STAFF_NAME, appVersion: '0.1.0', locale: 'en', params: {} },
    ]);
    expect(await runRow(db, run.id)).toMatchObject({ status: 'succeeded', row_count: 7, non_latin_rows: 1 });
    expect((await storedParams(db, run.id)).warnings).toEqual(Array.from({ length: 20 }, (_, i) => `warning_${i + 1}`));
    expect((await fsp.readFile(exportPath(db, run.id, 'pdf'))).toString('utf8')).toBe('resume:null\nresume:two\n');
  });

  it('a resume state over 60 000 bytes ends the run failed, without a file', async () => {
    const run = await startRun(db, oversized, { format: 'pdf', params: {} });
    expect(await drive(db, run.jobId)).toEqual(['succeeded']);
    expect(await runRow(db, run.id)).toMatchObject({ status: 'failed', error_code: 'internal', output_name: null, row_count: null });
    expect(await workDirExists(db, run.id)).toBe(false);
    expect((await exportNames(db)).filter((n) => n.startsWith(run.id))).toEqual([]);
  });
});
