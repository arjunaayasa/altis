import { withTx } from '@altis/db';
import { isDomainError, t, type MessageKey } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { GENERAL_STATS } from '../../src/accreditation/instruments/general-stats.js';
import { writeSettings } from '../../src/settings/service.js';
import { TINY_JPEG_BASELINE } from '../fixtures/tiny.jpg.js';
import {
  FORBIDDEN,
  KEYRING,
  LIBRARY,
  SD,
  SEEDED_AT,
  SMA,
  addEvidence,
  openDocsDb,
  pdfPages,
  runDoc,
  schoolProfile,
  seedAnswers,
  seedPeriod,
  seedResults,
  startDoc,
  tinyPdf,
  type DocsDb,
} from './accred-documents-support.js';

// The evidence file of a period as a PDF, on the engine picked by ALTIS_TEST_DB:
// - a school period prints its eight sections in order (cover, request letter and submission form, the statement of
//   1 000 titles, the certificate name, the profile form, the indicator sheets, the statistical annex, the school
//   standards), the instrument's decree with its source status on every page, the period, both signature roles, the
//   evidence checklist with its captions, file names and screens, and each sheet's raw value and formula;
// - it never prints a score: no estimate, no predicate, no gap action, no answer letter or suggestion label, no option
//   label of an answer chosen by hand, no note of an answer that replaced a suggestion, no note about the answer;
// - the primary instrument prints its own decree and its official numbers (the innovation item is L7 there);
// - the request letter alone is section 2 only, and only as a PDF;
// - the statistics mode prints the cover sentence, the profile signed by the head of the parent institution, the
//   register lists and the annex, and no submission form.

const ctx = testDbContext();

const msg = (key: string): string => t('id', key as MessageKey);
const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => 'resolved',
    (e: unknown) => (isDomainError(e) ? { code: e.code, meta: e.meta } : e),
  );

/** The texts of every gap action of an instrument. */
const actions = SMA.components.flatMap((c) => c.indicators.map((i) => msg(i.actionKey)));

/** The option labels of the answers chosen by hand (SP1 a, SP2 b, SP3 c, F3 c). */
const OPTION_LABELS = ['accred.ik.SP1.option.a', 'accred.ik.SP2.option.b', 'accred.ik.SP3.option.c', 'accred.ik.F3.option.c'].map(msg);

/** The positions of `needles` in `text`, in order (each searched after the previous one). */
function inOrder(text: string, needles: readonly string[]): boolean {
  let at = -1;
  for (const n of needles) {
    const next = text.indexOf(n, at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}

describe.skipIf(!ctx.available)(`accreditation evidence file PDF [${engineLabel()}]`, () => {
  let db: DocsDb;

  beforeAll(async () => {
    db = await openDocsDb('accred-dossier');
  });

  afterAll(async () => {
    await db?.close();
  });

  /** The SMA period of the "SMA contoh" school with its results, answers and a few evidence files. */
  async function smaPeriod(): Promise<string> {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025', name: 'Tahun pelajaran 2025/2026 SMA' });
    const photo = await addEvidence(db, id, { indicatorCode: 'SCH-PROFIL', evidenceCode: 'photo_front', caption: 'Tampak depan', name: 'depan.jpg', mime: 'image/jpeg', bytes: TINY_JPEG_BASELINE });
    await db.h.db.updateTable('accred_periods').set({ profile: JSON.stringify(schoolProfile('sma_smk_ma', { photos: { front: photo } })) }).where('id', '=', id).execute();
    await seedResults(db, id, SMA);
    await seedAnswers(db, id);
    await addEvidence(db, id, { indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'Layar katalog ALTIS', name: 'katalog.jpg', mime: 'image/jpeg', bytes: TINY_JPEG_BASELINE });
    await addEvidence(db, id, { indicatorCode: 'SCH-K3', evidenceCode: 'policy_document', caption: 'Kebijakan pengembangan koleksi 2025', name: 'kebijakan.pdf', mime: 'application/pdf', bytes: tinyPdf('Kebijakan') });
    return id;
  }

  it('prints the eight sections of a school period in order, with the source status on every page and no score', async () => {
    const id = await smaPeriod();
    const { run, bytes } = await runDoc(db, 'accreditation.dossier', id, { format: 'pdf' });
    expect(run).toMatchObject({ report_id: 'accreditation.dossier', format: 'pdf', locale: 'id', personal: 1, status: 'succeeded' });
    const pages = pdfPages(bytes);
    expect(Number(run.row_count)).toBe(pages.length);
    const all = pages.join('\n');

    expect(
      inOrder(all, [
        'Berkas Bukti Akreditasi Perpustakaan',
        'Surat Permohonan Akreditasi Perpustakaan',
        'Formulir Pengajuan Akreditasi Perpustakaan',
        'Surat Pernyataan Memiliki Koleksi Paling Sedikit 1.000 Judul',
        'Pernyataan Penulisan Sertifikat',
        'Data Profil Perpustakaan',
        'Lembar Indikator Kinerja',
        'Lampiran Statistik',
        'Kepatuhan Standar Nasional Perpustakaan Sekolah',
      ]),
    ).toBe(true);
    expect(all).toContain('Kepka Perpusnas 159/2025');
    expect(all).toContain('Tahun pelajaran 2025/2026 SMA');
    expect(all).toContain('Kepala Sekolah');
    expect(all).toContain('Kepala Perpustakaan');
    expect(all).toContain('1.000 judul per 30 Juni 2026');
    pages.forEach((page, k) => {
      expect(page, `page ${k + 1}`).toContain('salinan, belum dibandingkan dengan JDIH');
      expect(page, `page ${k + 1}`).toContain(`${LIBRARY} · NPP 3201010D1000004`);
      expect(page, `page ${k + 1}`).toContain(`halaman ${k + 1}/${pages.length}`);
      expect(page, `page ${k + 1}`).toContain('Dibuat ALTIS 0.1.0 · Kepka Perpusnas 159/2025');
    });

    // The evidence checklist: labels with their kinds, captions and file names, the screen of a screenshot.
    const k1 = SMA.components[0]!.indicators[0]!;
    for (const item of k1.evidence) expect(all).toContain(msg(item.labelKey));
    expect(all).toContain('Tangkapan layar');
    expect(all).toContain('Layar katalog ALTIS (berkas katalog.jpg)');
    expect(all).toContain('Kebijakan pengembangan koleksi 2025 (berkas kebijakan.pdf)');
    expect(all).toContain('Layar ALTIS: catalog/records');

    // A sheet: its number, paraphrase, raw value, formula, source and data-quality notes, without the overlap note.
    expect(inOrder(all, ['K2 · Koleksi Perpustakaan butir 2', msg('accred.ik.K2'), 'Nilai mentah', '25 %', '250 × 100 ÷ 1.000 = 25 %', 'data ALTIS'])).toBe(true);
    expect(all).toContain('Judul dihitung sebagai fiksi menurut aturan ini: tipe koleksi FIKSI.');
    expect(all).toContain('40 eksemplar tidak punya tanggal perolehan.');
    expect(all).toContain(t('id', 'accred.note.k6_tier', { count: 700 }));
    expect(all).not.toContain(t('id', 'accred.note.k2_overlap'));
    expect(all).toContain('Rincian Daftar judul');

    // Never a score, an answer or an answer-bearing note.
    for (const text of FORBIDDEN) expect(all, text).not.toContain(text);
    for (const text of actions) expect(all, text).not.toContain(text);
    for (const text of OPTION_LABELS) expect(all, text).not.toContain(text);
    expect(all).not.toContain('Saran ALTIS');
  });

  it('prints the primary instrument with its decree and its own official numbers', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sd-2025', profile: schoolProfile('sd_mi') });
    await seedResults(db, id, SD);
    const { bytes } = await runDoc(db, 'accreditation.dossier', id, { format: 'pdf' });
    const pages = pdfPages(bytes);
    const all = pages.join('\n');
    expect(all).toContain('Kepka Perpusnas 157/2025');
    for (const page of pages) expect(page).toContain('salinan, belum dibandingkan dengan JDIH');
    // The innovation item (concept L8) is item 7 of services in this instrument; the last services item is 13.
    expect(inOrder(all, ['L6 · Pelayanan Perpustakaan butir 6', 'L7 · Pelayanan Perpustakaan butir 7', msg('accred.ik.L8'), 'L8 · Pelayanan Perpustakaan butir 8'])).toBe(true);
    expect(all).toContain('L13 · Pelayanan Perpustakaan butir 13');
    expect(all).not.toContain('L14 ·');
    expect(all).not.toContain(msg('accred.ik.L7'));
  });

  it('prints the request letter alone, as a PDF only', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025', profile: schoolProfile('sma_smk_ma') });
    const { run, bytes } = await runDoc(db, 'accreditation.dossier', id, { format: 'pdf', part: 'request_letter' });
    expect(JSON.parse(run.params)).toMatchObject({ def: { periodId: id, part: 'request_letter', zipMode: 'combined' } });
    const pages = pdfPages(bytes);
    const all = pages.join('\n');
    expect(inOrder(all, ['Surat Permohonan Akreditasi Perpustakaan', 'Formulir Pengajuan Akreditasi Perpustakaan'])).toBe(true);
    expect(all).toContain('Drs. Budi Santoso');
    expect(all).toContain('Kota Bandung');
    for (const heading of ['Berkas Bukti Akreditasi', 'Surat Pernyataan', 'Data Profil Perpustakaan', 'Lembar Indikator Kinerja', 'Lampiran Statistik']) expect(all).not.toContain(heading);
    for (const page of pages) expect(page).toContain('salinan, belum dibandingkan dengan JDIH');

    expect(await failure(startDoc(db, 'accreditation.dossier', id, { format: 'zip', part: 'request_letter' }))).toEqual({
      code: 'VALIDATION_FAILED',
      meta: { errors: [{ path: 'part', code: 'invalid' }] },
    });
  });

  it('prints the statistics mode of a public library: the cover sentence, no submission form, the parent institution', async () => {
    await withTx(db.h, (trx) => writeSettings(trx, { 'library.type': 'umum' }, { keyring: KEYRING, now: SEEDED_AT, actorId: null }));
    try {
      const id = await seedPeriod(db, {
        instrumentId: 'general-stats',
        name: 'Tahun 2026',
        population: false,
        profile: { npp: '3273000D2000001', schoolName: 'Pemerintah Kota Contoh', schoolHead: 'Kepala Dinas Contoh', libraryHead: 'Rina Pustaka' },
      });
      await seedResults(db, id, GENERAL_STATS);
      const { bytes } = await runDoc(db, 'accreditation.dossier', id, { format: 'pdf' });
      const pages = pdfPages(bytes);
      const all = pages.join('\n');
      expect(all).toContain(msg('accred.general.cover'));
      expect(all).toContain('Kepala Lembaga Induk');
      expect(inOrder(all, ['Berkas Bukti Akreditasi Perpustakaan', 'Data Profil Perpustakaan', 'Daftar Register', 'Lampiran Statistik'])).toBe(true);
      for (const heading of ['Surat Permohonan', 'Formulir Pengajuan', 'Surat Pernyataan', 'Pernyataan Penulisan Sertifikat', 'Lembar Indikator Kinerja', 'Kepatuhan Standar']) {
        expect(all, heading).not.toContain(heading);
      }
      for (const page of pages) {
        expect(page).toContain('Peraturan Perpusnas 2/2022');
        expect(page).not.toContain('salinan, belum dibandingkan dengan JDIH');
      }
      expect(await failure(startDoc(db, 'accreditation.dossier', id, { format: 'zip_components' }))).toEqual({
        code: 'VALIDATION_FAILED',
        meta: { errors: [{ path: 'format', code: 'invalid_value' }] },
      });
      expect(await failure(startDoc(db, 'accreditation.dossier', id, { format: 'pdf', part: 'request_letter' }))).toEqual({
        code: 'VALIDATION_FAILED',
        meta: { errors: [{ path: 'part', code: 'invalid' }] },
      });
    } finally {
      await withTx(db.h, (trx) => writeSettings(trx, { 'library.type': 'sekolah' }, { keyring: KEYRING, now: SEEDED_AT, actorId: null }));
    }
  });

  it('refuses a period that is archived or unknown', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025' });
    await db.h.db.updateTable('accred_periods').set({ archived_at: SEEDED_AT }).where('id', '=', id).execute();
    expect(await failure(startDoc(db, 'accreditation.dossier', id, { format: 'pdf' }))).toMatchObject({ code: 'NOT_FOUND' });
  });
});
