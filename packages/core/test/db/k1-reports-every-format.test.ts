import fsp from 'node:fs/promises';
import { type DB } from '@altis/db';
import { isDomainError, newId, normalizeKey } from '@altis/shared';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { titleKey } from '../../src/catalog/lib/title-key.js';
import { REPORTS } from '../../src/reports/registry.js';
import type { ReportDefinition } from '../../src/reports/types.js';
import { seedSmaContoh, type GoldenFixture } from '../support/accreditation-golden.js';
import { checkPdf } from '../support/pdf-check.js';
import { csvCells, csvLines, drive, exportPath, openExportDb, runRow, sheetRows, startRun, xlsxParts, type ExportDb } from './reports-export-support.js';

// Every table report of this edition (the eight collection reports and the ten accreditation annexes) exported to CSV,
// XLSX and PDF on the golden school dataset, each run started as the run routes start it and written by the real export
// job, on the engine picked by ALTIS_TEST_DB:
// - every CSV starts with the UTF-8 byte order mark, and a title that starts with `=` is written with a quote before it;
// - every XLSX reads back with our own ZIP and XML readers (content types, workbook, first sheet), the same guard on
//   its text cells;
// - every PDF passes the structural checker;
// - an Arabic title is kept byte for byte in the CSV and the XLSX, and its PDF row is counted as non-Latin;
// - the staff annex is a personal report (its run is stored personal, as the personal run route starts it);
// - a title list of 10 001 titles is refused as a PDF when its run is created, before anything is written.

const ctx = testDbContext();

/** An Arabic title (a madrasah collection's): the standard PDF fonts cannot print it. */
const ARABIC = 'كتاب الأدب العربي للمدارس';
/** A title a spreadsheet would read as a formula. */
const FORMULA = `=cmd|' /C calc'!A0 Kumpulan Puisi`;

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const FORMATS = ['csv', 'xlsx', 'pdf'] as const;

/** The table definitions of this edition: collection reports and annexes (no test-profile one, no document). */
const TABLES: readonly ReportDefinition[] = REPORTS.filter((d) => d.kind === 'table' && !d.id.startsWith('test.'));

/** A title with one available copy received on 2026-03-01, written straight into the tables; its record id. */
async function addTitle(db: Kysely<DB>, fx: GoldenFixture, o: { title: string; classification: string; barcode: string }): Promise<string> {
  const at = Date.parse('2026-03-01T10:00:00+07:00');
  const material = (await db.selectFrom('material_types').select('id').where('code_key', '=', normalizeKey('BUKU')).executeTakeFirstOrThrow()).id;
  const collection = (await db.selectFrom('collection_types').select('id').where('code_key', '=', normalizeKey('UMUM')).executeTakeFirstOrThrow()).id;
  const trail = { archived_at: null, created_at: at, created_by: null, updated_at: at, updated_by: null };
  const recordId = newId(at);
  const record: Insertable<DB['records']> = {
    id: recordId,
    material_type_id: material,
    title: o.title,
    subtitle: null,
    responsibility: null,
    title_key: titleKey(o.title),
    edition: null,
    material_detail: null,
    publisher_id: null,
    publication_place: null,
    publication_year: '2024',
    publication_date_text: null,
    physical_desc: null,
    series: null,
    classification: o.classification,
    call_number: `${o.classification} KIT k`,
    language_id: null,
    content_type: null,
    media_type: null,
    carrier_type: null,
    summary: null,
    notes: null,
    cover_file_id: null,
    source: 'manual',
    merged_into: null,
    changed_at: at,
    ...trail,
    audience: null,
    local_work: null,
    local_work_kind: null,
    reference_kind: null,
  };
  await db.insertInto('records').values(record).execute();
  const itemId = newId(at);
  await db
    .insertInto('items')
    .values({
      id: itemId,
      record_id: recordId,
      branch_id: fx.branchId,
      barcode_display: o.barcode,
      barcode_key: normalizeKey(o.barcode),
      inventory_no: `INV-${o.barcode}`,
      call_number: null,
      location_id: fx.locationId,
      collection_type_id: collection,
      status: 'available',
      status_note: null,
      acq_source: 'purchase',
      order_no: null,
      order_date: null,
      received_date: '2026-03-01',
      invoice_date: null,
      supplier_id: null,
      invoice_no: null,
      price: 4_500_000,
      currency: 'IDR',
      note: null,
      ...trail,
      input_on: null,
    })
    .execute();
  await db
    .insertInto('item_events')
    .values({
      id: newId(at),
      item_id: itemId,
      at,
      type: 'created',
      from_status: null,
      to_status: 'available',
      from_location_id: null,
      to_location_id: fx.locationId,
      actor_type: 'staff',
      actor_id: null,
      meta: JSON.stringify({ fields: [] }),
    })
    .execute();
  return recordId;
}

describe.skipIf(!ctx.available)(`every report in every format on the golden dataset [${engineLabel()}]`, () => {
  let db: ExportDb;
  let fx: GoldenFixture;
  /** The run parameters of each definition: the golden upper secondary period for the annexes, none otherwise. */
  const paramsOf = (def: ReportDefinition): Record<string, unknown> => (def.module === 'accreditation' ? { periodId: fx.periods.sma } : {});

  beforeAll(async () => {
    db = await openExportDb('k1-every-format');
    fx = await seedSmaContoh(db.h);
    const arabic = await addTitle(db.h.db, fx, { title: ARABIC, classification: '297.1', barcode: 'ARB-0001' });
    const formula = await addTitle(db.h.db, fx, { title: FORMULA, classification: '899.221', barcode: 'FRM-0001' });
    // An attachment on each, opened a few times, for the attachment report.
    const at = Date.parse('2026-03-02T10:00:00+07:00');
    for (const [recordId, reads] of [[arabic, 7], [formula, 3]] as const) {
      await db.h.db
        .insertInto('attachments')
        .values({ id: newId(at), record_id: recordId, kind: 'url', file_id: null, url: 'https://perpus.sma-contoh.sch.id/baca', title: 'Baca daring', description: null, access: 'public', legacy_access_limit: null, read_count: reads, archived_at: null, created_at: at, created_by: null, updated_at: at, updated_by: null })
        .execute();
    }
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('covers the eight collection reports and the ten accreditation annexes', () => {
    expect(TABLES.map((d) => d.id)).toEqual([
      'collection.summary',
      'collection.ddc_recap',
      'collection.acquisitions',
      'collection.title_list',
      'collection.item_list',
      'collection.accession_register',
      'collection.data_quality',
      'collection.attachment_downloads',
      'accreditation.annex.ddc',
      'accreditation.annex.collection_matrix',
      'accreditation.annex.additions',
      'accreditation.annex.l14',
      'accreditation.annex.usage_monthly',
      'accreditation.annex.staff',
      'accreditation.annex.budgets',
      'accreditation.annex.activities',
      'accreditation.annex.partnerships',
      'accreditation.annex.documents',
    ]);
    for (const def of TABLES) expect([def.id, [...def.formats].sort()]).toEqual([def.id, ['csv', 'pdf', 'xlsx']]);
  });

  it.each(TABLES.map((d) => [d.id, d] as const))(
    '%s: CSV with the byte order mark, an XLSX that reads back, a PDF that passes the checker',
    async (_id, def) => {
      for (const format of FORMATS) {
        const run = await startRun(db, def, { format, params: paramsOf(def), locale: 'id' });
        const outcomes = await drive(db, run.jobId);
        const row = await runRow(db, run.id);
        expect([def.id, format, outcomes.at(-1), row.status, row.error_code]).toEqual([def.id, format, 'succeeded', 'succeeded', null]);
        expect(row.personal, def.id).toBe(def.personal ? 1 : 0);
        if (def.module === 'accreditation') expect(row.locale, def.id).toBe('id');
        const rows = Number(row.row_count);
        expect(rows, `${def.id} ${format}: the golden dataset gives it rows`).toBeGreaterThan(0);
        const bytes = await fsp.readFile(exportPath(db, run.id, format));
        if (format === 'csv') {
          expect(bytes.subarray(0, 3).equals(BOM), `${def.id} csv starts with the BOM`).toBe(true);
          const lines = csvLines(bytes);
          expect(lines.length, `${def.id} csv: a header and every row`).toBeGreaterThanOrEqual(rows + 1);
          // No cell starts with a character a spreadsheet would run as a formula.
          const cells = lines.flatMap(csvCells);
          expect(cells.filter((c) => /^[=+@\t\r]/.test(c) || /^-[^0-9]/.test(c)), def.id).toEqual([]);
        } else if (format === 'xlsx') {
          const parts = await xlsxParts(exportPath(db, run.id, 'xlsx'));
          for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) expect(parts.has(part), `${def.id} ${part}`).toBe(true);
          const sheet = sheetRows(parts.get('xl/worksheets/sheet1.xml')!);
          expect(sheet.length, `${def.id} xlsx: a header and every row`).toBeGreaterThanOrEqual(rows + 1);
          const texts = sheet.flat().filter((c) => c.type === 'inlineStr').map((c) => c.text);
          expect(texts.filter((c) => /^[=+@\t\r]/.test(c) || /^-[^0-9]/.test(c)), def.id).toEqual([]);
        } else {
          const pdf = checkPdf(bytes);
          expect(pdf.pages.length, `${def.id} pdf pages`).toBeGreaterThan(0);
        }
      }
    },
    300_000,
  );

  it('the title list keeps the Arabic title in the CSV and the XLSX, counts its PDF row as non-Latin, and guards the formula title', async () => {
    const def = REPORTS.find((d) => d.id === 'collection.title_list')!;
    const out: Record<string, { bytes: Buffer; nonLatin: number | null; rows: number }> = {};
    for (const format of FORMATS) {
      const run = await startRun(db, def, { format, params: {}, locale: 'id' });
      expect((await drive(db, run.jobId)).at(-1)).toBe('succeeded');
      const row = await runRow(db, run.id);
      out[format] = { bytes: await fsp.readFile(exportPath(db, run.id, format)), nonLatin: row.non_latin_rows === null ? null : Number(row.non_latin_rows), rows: Number(row.row_count) };
    }
    const titles = await db.h.db.selectFrom('records').select((eb) => eb.fn.countAll<number>().as('n')).where('archived_at', 'is', null).executeTakeFirstOrThrow();
    expect(out['csv']!.rows).toBe(Number(titles.n));

    // CSV: the Arabic title byte for byte; the formula title with a quote before it.
    const csvTitles = csvLines(out['csv']!.bytes).map((l) => csvCells(l)[0]);
    expect(csvTitles).toContain(ARABIC);
    expect(out['csv']!.bytes.includes(Buffer.from(ARABIC, 'utf8'))).toBe(true);
    expect(csvTitles).toContain(`'${FORMULA}`);
    expect(csvTitles).not.toContain(FORMULA);

    // XLSX: the same two cells as inline strings.
    const p = exportPath(db, (await db.h.db.selectFrom('report_runs').select('id').where('report_id', '=', def.id).where('format', '=', 'xlsx').orderBy('id', 'desc').executeTakeFirstOrThrow()).id, 'xlsx');
    const sheet = sheetRows((await xlsxParts(p)).get('xl/worksheets/sheet1.xml')!);
    const xlsxTitles = sheet.map((r) => r[0]!).filter((c) => c.type === 'inlineStr').map((c) => c.text);
    expect(xlsxTitles).toContain(ARABIC);
    expect(xlsxTitles).toContain(`'${FORMULA}`);
    expect(xlsxTitles).not.toContain(FORMULA);

    // PDF: the one Arabic row is counted (the golden titles and the formula title are Latin).
    expect(out['pdf']!.nonLatin).toBe(1);
    expect(out['csv']!.nonLatin).toBeNull();
    const pages = checkPdf(out['pdf']!.bytes).pages;
    const pdfText = pages.flatMap((page) => page.texts.map((t) => t.text)).join('\n');
    expect(pdfText).toContain('teks non-Latin');
  });

  it('a title list of 10 001 titles as a PDF is refused when its run is created, and nothing is written', async () => {
    const titles = Number((await db.h.db.selectFrom('records').select((eb) => eb.fn.countAll<number>().as('n')).where('archived_at', 'is', null).executeTakeFirstOrThrow()).n);
    const material = (await db.h.db.selectFrom('material_types').select('id').where('code_key', '=', normalizeKey('EBOOK')).executeTakeFirstOrThrow()).id;
    const at = Date.parse('2026-04-01T10:00:00+07:00');
    const more: Insertable<DB['records']>[] = Array.from({ length: 10_001 - titles }, (_, i) => ({
      id: newId(at),
      material_type_id: material,
      title: `Judul elektronik ${i + 1}`,
      title_key: titleKey(`Judul elektronik ${i + 1}`),
      classification: '020',
      source: 'manual',
      changed_at: at,
      created_at: at,
      updated_at: at,
    }));
    for (let i = 0; i < more.length; i += 200) await db.h.db.insertInto('records').values(more.slice(i, i + 200)).execute();

    const runsBefore = await db.h.db.selectFrom('report_runs').select('id').execute();
    const jobsBefore = await db.h.db.selectFrom('jobs').select('id').execute();
    const failure = await startRun(db, 'collection.title_list', { format: 'pdf', params: {} }).then(
      () => 'started',
      (e: unknown) => (isDomainError(e) ? { code: e.code, status: e.status, meta: e.meta } : e),
    );
    expect(failure).toEqual({ code: 'REPORT_TOO_LARGE', status: 422, meta: { rows: 10_001, max: 10_000, format: 'pdf' } });
    expect(await db.h.db.selectFrom('report_runs').select('id').execute()).toEqual(runsBefore);
    expect(await db.h.db.selectFrom('jobs').select('id').execute()).toEqual(jobsBefore);
    // The same list fits a CSV.
    const csv = await startRun(db, 'collection.title_list', { format: 'csv', params: {} });
    expect(csv.id).toMatch(/^[0-9A-Z]{26}$/);
  }, 120_000);
});
