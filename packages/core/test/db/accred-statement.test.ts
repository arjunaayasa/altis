import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  LIBRARY_HEAD,
  SCHOOL_HEAD,
  SMA,
  openDocsDb,
  pdfPages,
  runDoc,
  schoolProfile,
  seedPeriod,
  seedResults,
  type DocsDb,
} from './accred-documents-support.js';
import { addTitle } from './report-collection-support.js';

// The statement that the library holds at least 1 000 titles, on the engine picked by ALTIS_TEST_DB:
// - its count and date are the registration prerequisites' (as the evaluation found them), not a count of its own;
// - its list is the title list in stock on that date (a title received after it is not listed);
// - its signature block has the role, the place and the date, and no name from the profile: it holds no personal
//   data, so its run is not personal;
// - without results it says the count is not computed yet.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`accreditation statement of 1 000 titles [${engineLabel()}]`, () => {
  let db: DocsDb;

  beforeAll(async () => {
    db = await openDocsDb('accred-statement');
    const received = (barcode: string, date: string) => ({ barcode, receivedDate: date });
    await addTitle(db.h.db, db.branchId, { title: 'Laskar Pelangi', year: '2005', classification: '899.221', items: [received('B0001', '2024-02-01')] });
    await addTitle(db.h.db, db.branchId, { title: 'Bumi Manusia', year: '1980', classification: '899.221', items: [received('B0002', '2024-03-01'), received('B0003', '2024-03-02')] });
    await addTitle(db.h.db, db.branchId, { title: 'Ensiklopedia Sains', year: '2019', classification: '503', items: [received('B0004', '2025-08-15')] });
    await addTitle(db.h.db, db.branchId, { title: 'Buku Datang Kemudian', year: '2026', classification: '500', items: [received('B0005', '2026-08-01')] });
  });

  afterAll(async () => {
    await db?.close();
  });

  it('prints the count and date of the prerequisites, the titles in stock on that date, and no name', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025', profile: schoolProfile('sma_smk_ma') });
    await seedResults(db, id, SMA, { prerequisites: { titles: 1000, asOf: '2026-06-30' } });
    const { run, bytes } = await runDoc(db, 'accreditation.statement_1000', id);
    expect(run).toMatchObject({ report_id: 'accreditation.statement_1000', format: 'pdf', locale: 'id', personal: 0 });
    expect(Number(run.row_count)).toBe(3);
    const pages = pdfPages(bytes);
    const all = pages.join('\n');
    expect(all).toContain('Surat Pernyataan Memiliki Koleksi Paling Sedikit 1.000 Judul');
    expect(all).toContain('memiliki koleksi sebanyak 1.000 judul per 30 Juni 2026');
    expect(all).toContain('Kepala Sekolah');
    expect(all).toContain('Kota Bandung');
    expect(all).toContain('Daftar Judul Koleksi');
    for (const title of ['Laskar Pelangi', 'Bumi Manusia', 'Ensiklopedia Sains']) expect(all).toContain(title);
    expect(all).not.toContain('Buku Datang Kemudian');
    for (const name of [SCHOOL_HEAD, LIBRARY_HEAD, '198001012005012001']) expect(all, name).not.toContain(name);
    for (const page of pages) expect(page).toContain('salinan, belum dibandingkan dengan JDIH');
  });

  it('says the count is not computed yet when the period has no results', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025', profile: schoolProfile('sma_smk_ma') });
    const { bytes } = await runDoc(db, 'accreditation.statement_1000', id);
    const all = pdfPages(bytes).join('\n');
    expect(all).toContain('Jumlah judul belum dihitung');
    expect(all).not.toContain(SCHOOL_HEAD);
  });
});
