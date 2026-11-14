import fsp from 'node:fs/promises';
import { newId, t } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { describeParams } from '../../src/reports/export/describe.js';
import { reportColumn, reportParam } from '../../src/reports/params.js';
import { reportCtx } from '../../src/reports/runs/service.js';
import type { TableReport } from '../../src/reports/types.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import { checkPdf, type CheckedPdf } from '../support/pdf-check.js';
import {
  STAFF_NAME,
  drive,
  exportPath,
  insertPeriod,
  openExportDb,
  runRow,
  startRun,
  workDirExists,
  xlsxParts,
  type ExportDb,
} from './reports-export-support.js';

// The PDF export of a table report: one table under a header that names the library and the report and says the
// filters in words on every page, a footer with the printing date, the requester and the page number, money in the
// language's grouping. Rows whose text the PDF fonts cannot print (Arabic) carry a note and are counted; a
// transliterated name with an accent is not. CSV and XLSX keep that text byte for byte. On the engine picked by
// ALTIS_TEST_DB.

const ctx = testDbContext();
const ARABIC = ['تفسير الجلالين', 'صحيح البخاري'];
const NOTE_ID = 'teks non-Latin: lihat XLSX/CSV';

/** The texts of each page, in drawing order. */
function pageTexts(pdf: CheckedPdf): string[][] {
  return pdf.pages.map((p) => p.texts.map((x) => x.text));
}

describe.skipIf(!ctx.available)(`the PDF export [${engineLabel()}]`, () => {
  let db: ExportDb;

  beforeAll(async () => {
    db = await openExportDb('reports-export-pdf');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('counts and marks the two Arabic rows, not the accented one; CSV and XLSX keep the Arabic text byte for byte', async () => {
    const params = { rows: 3, texts: [ARABIC[0], 'Pérez', ARABIC[1]] };
    const pdfRun = await startRun(db, 'test.rows', { format: 'pdf', locale: 'id', params });
    expect((await drive(db, pdfRun.jobId)).at(-1)).toBe('succeeded');
    const row = await runRow(db, pdfRun.id);
    expect(row).toMatchObject({ status: 'succeeded', row_count: 3, non_latin_rows: 2, output_name: `${pdfRun.id}.pdf` });
    expect(await workDirExists(db, pdfRun.id)).toBe(false);

    const bytes = await fsp.readFile(exportPath(db, pdfRun.id, 'pdf'));
    expect(Number(row.output_size)).toBe(bytes.byteLength);
    const pdf = checkPdf(bytes);
    const texts = pageTexts(pdf).flat();
    expect(texts.filter((x) => x === NOTE_ID)).toHaveLength(2);
    expect(texts).toContain('Pérez');
    const pages = pdf.pages.length;
    pageTexts(pdf).forEach((page, k) => {
      expect(page.some((x) => x.startsWith('Dicetak ') && x.includes(`oleh ${STAFF_NAME}`) && x.endsWith(`halaman ${k + 1}/${pages}`))).toBe(true);
    });

    const csvRun = await startRun(db, 'test.rows', { format: 'csv', locale: 'id', params });
    const xlsxRun = await startRun(db, 'test.rows', { format: 'xlsx', locale: 'id', params });
    expect(await drive(db, csvRun.jobId)).toEqual(['succeeded']);
    expect(await drive(db, xlsxRun.jobId)).toEqual(['succeeded']);
    const csv = await fsp.readFile(exportPath(db, csvRun.id, 'csv'));
    const sheet = (await xlsxParts(exportPath(db, xlsxRun.id, 'xlsx'))).get('xl/worksheets/sheet1.xml')!;
    for (const text of ARABIC) {
      expect(csv.includes(Buffer.from(text, 'utf8'))).toBe(true);
      expect(Buffer.from(sheet, 'utf8').includes(Buffer.from(text, 'utf8'))).toBe(true);
    }
    expect((await runRow(db, csvRun.id)).non_latin_rows).toBeNull();
    expect((await runRow(db, xlsxRun.id)).non_latin_rows).toBeNull();
  });

  it('prints "<library> · <report>" and the filters in words on every page, never the stored paper', async () => {
    const run = await startRun(db, 'test.rows', { format: 'pdf', locale: 'id', params: { rows: 3, countless: true }, pdf: { paper: 'F4' } });
    expect((await drive(db, run.jobId)).at(-1)).toBe('succeeded');
    const pdf = checkPdf(await fsp.readFile(exportPath(db, run.id, 'pdf')));
    expect(pdf.pages).toHaveLength(1);
    const page = pageTexts(pdf)[0]!;
    expect(page).toContain('Perpustakaan · Baris uji');
    expect(page).toContain('Jumlah baris: 3');
    expect(page).toContain('Tanpa hitungan');
    expect(page.some((x) => x.includes('F4') || x.includes('A4'))).toBe(false);
    // F4 portrait (215 × 330 mm): the paper comes from the stored PDF options, the orientation from the definition.
    expect(pdf.pages[0]!.mediaBox.map((v) => Math.round(v * 100) / 100)).toEqual([0, 0, 609.45, 935.43]);
  });

  it('keeps the page header short when the filters are long: each line cut at 100 characters', async () => {
    const texts = Array.from({ length: 20 }, (_, i) => `${String.fromCharCode(65 + i)}${'x'.repeat(199)}`);
    const run = await startRun(db, 'test.rows', { format: 'pdf', locale: 'id', params: { rows: 30, texts } });
    expect((await drive(db, run.jobId)).at(-1)).toBe('succeeded');
    const page = pageTexts(checkPdf(await fsp.readFile(exportPath(db, run.id, 'pdf'))))[0]!;
    // The header is drawn after the page's content: its left text, then the filter lines (wrapped), then the footer.
    const left = page.indexOf('Perpustakaan · Baris uji');
    const footer = page.findIndex((x, i) => i > left && x.startsWith('Dicetak '));
    expect(left).toBeGreaterThan(0);
    expect(page.slice(left + 1, footer).join('').replace(/ /g, '')).toBe(`Jumlahbaris:30Teksbaris:A${'x'.repeat(86)}…`);
  });

  it('repeats the header, the filters and a numbered footer on every page of a long table; money in the language grouping', async () => {
    const run = await startRun(db, 'test.rows', { format: 'pdf', locale: 'en', params: { rows: 150 } });
    expect((await drive(db, run.jobId)).at(-1)).toBe('succeeded');
    const pdf = checkPdf(await fsp.readFile(exportPath(db, run.id, 'pdf')));
    expect(pdf.pages.length).toBeGreaterThan(1);
    expect(pdf.pages[0]!.mediaBox.map((v) => Math.round(v * 100) / 100)).toEqual([0, 0, 595.28, 841.89]);
    const pages = pageTexts(pdf);
    pages.forEach((page, k) => {
      expect(page).toContain('Perpustakaan · Test rows');
      expect(page).toContain('Rows: 150');
      expect(page.some((x) => x.startsWith('Printed ') && x.includes(`by ${STAFF_NAME}`) && x.endsWith(`page ${k + 1}/${pages.length}`))).toBe(true);
    });
    const all = pages.flat();
    expect(all).toContain('1,500');
    expect(all).toContain('225,000');
    expect(await runRow(db, run.id)).toMatchObject({ status: 'succeeded', row_count: 150, non_latin_rows: 0 });

    const indonesian = await startRun(db, 'test.rows', { format: 'pdf', locale: 'id', params: { rows: 2 } });
    expect((await drive(db, indonesian.jobId)).at(-1)).toBe('succeeded');
    expect(pageTexts(checkPdf(await fsp.readFile(exportPath(db, indonesian.id, 'pdf')))).flat()).toContain('1.500');
  });

  describe('describeParams', () => {
    const def: TableReport = {
      id: 'collection.describe_test',
      module: 'collection',
      kind: 'table',
      titleKey: 'report.test.rows.title',
      permission: 'reports.statistics.read',
      personal: false,
      formats: ['csv'],
      orientation: 'portrait',
      params: [
        reportParam('periodId', 'period'),
        reportParam('branchId', 'branch'),
        reportParam('locationId', 'location'),
        reportParam('collectionTypeId', 'collectionType'),
        reportParam('materialTypeId', 'materialType'),
        reportParam('languageId', 'language'),
        reportParam('received', 'dateRange'),
        reportParam('input', 'dateRange'),
        reportParam('asOf', 'asOf'),
        reportParam('yearFrom', 'year'),
        reportParam('breakdown', 'status', { options: ['none', 'fnr'] }),
        reportParam('status', 'status', { multiple: true, options: ['available', 'lost'], optionLabelPrefix: 'vocab.item_status.' }),
        reportParam('divisions', 'bool'),
        reportParam('fictionOnly', 'bool'),
        reportParam('classPrefix', 'classPrefix'),
        reportParam('rows', 'int'),
      ],
      paramsSchema: z.record(z.string(), z.unknown()),
      columns: [reportColumn('n', 'int')],
      rows: async () => ({ rows: [], nextCursor: null }),
    };

    it('writes one "Label: value" line per set parameter in the given language, ids as names, dates in words', async () => {
      const now = Date.now();
      const branchId = newId(now);
      await db.h.db
        .insertInto('branches')
        .values({ id: branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Cabang Pusat', address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: now, created_by: null, updated_at: now, updated_by: null })
        .execute();
      const locationId = newId(now);
      await db.h.db
        .insertInto('locations')
        .values({
          id: locationId,
          branch_id: branchId,
          parent_id: null,
          kind: 'room',
          code_display: 'R1',
          code_key: 'R1',
          name: 'Ruang Baca',
          shelf_hint: null,
          class_from: null,
          class_to: null,
          map_file_id: null,
          map_x: null,
          map_y: null,
          map_w: null,
          map_h: null,
          archived_at: null,
          created_at: now,
          created_by: null,
          updated_at: now,
          updated_by: null,
        })
        .execute();
      const id = async (table: 'collection_types' | 'material_types' | 'languages', nameId: string) =>
        (await db.h.db.selectFrom(table).select('id').where('name_id', '=', nameId).executeTakeFirstOrThrow()).id;
      const periodId = await insertPeriod(db, 'Tahun ajaran 2025/2026');
      const params = {
        periodId,
        branchId,
        locationId,
        collectionTypeId: await id('collection_types', 'Referensi'),
        materialTypeId: await id('material_types', 'Buku'),
        languageId: await id('languages', 'Jepang'),
        received: { from: '2026-01-02', to: '2026-03-31' },
        input: { to: '2025-12-31' },
        asOf: '2026-06-30',
        yearFrom: 2024,
        breakdown: 'fnr',
        status: ['available', 'lost'],
        divisions: true,
        fictionOnly: false,
        rows: 0,
      };
      const settings = await loadAccredSettings(db.h.db);
      const at = (locale: 'id' | 'en') => reportCtx(db.h.db, { locale, tz: 'Asia/Jakarta', now, settings, params, budgetMs: 10_000 });

      expect(await describeParams(def, params, at('id'))).toEqual([
        'Periode akreditasi: Tahun ajaran 2025/2026',
        'Cabang: Cabang Pusat',
        'Lokasi: Ruang Baca',
        'Tipe koleksi: Referensi',
        'Jenis bahan: Buku',
        'Bahasa: Jepang',
        'Tanggal terima: 2 Januari 2026 – 31 Maret 2026',
        'Tanggal input: – 31 Desember 2025',
        'Per tanggal: 30 Juni 2026',
        'Dari tahun: 2024',
        `Rincian kolom: ${t('id', 'report.option.breakdown.fnr')}`,
        `Status eksemplar: ${t('id', 'vocab.item_status.available')}, ${t('id', 'vocab.item_status.lost')}`,
        'Tampilkan divisi',
        'Jumlah baris: 0',
      ]);
      const english = await describeParams(def, params, at('en'));
      expect(english).toContain('Collection type: Reference');
      expect(english).toContain('Language: Japanese');
      expect(english).toContain('As of: 30 June 2026');
      expect(await describeParams(def, {}, at('id'))).toEqual([]);
      // An id that names nothing (a removed row) is printed as it is.
      const gone = newId(now);
      expect(await describeParams(def, { branchId: gone }, at('id'))).toEqual([`Cabang: ${gone}`]);
    });
  });
});
