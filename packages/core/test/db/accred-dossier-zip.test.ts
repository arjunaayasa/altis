import fsp from 'node:fs/promises';
import { reportExportPath } from '@altis/platform';
import { withTx } from '@altis/db';
import { newId, isDomainError, t, type MessageKey } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { GENERAL_STATS } from '../../src/accreditation/instruments/general-stats.js';
import { writeSettings } from '../../src/settings/service.js';
import { TINY_JPEG_BASELINE } from '../fixtures/tiny.jpg.js';
import {
  FORBIDDEN,
  KEYRING,
  SEEDED_AT,
  SMA,
  addEvidence,
  drive,
  openDocsDb,
  pdfPages,
  runDoc,
  schoolProfile,
  seedAnswers,
  seedPeriod,
  seedResults,
  startDoc,
  storedParams,
  streamEntries,
  tinyPdf,
  type DocsDb,
  type StreamedEntry,
} from './accred-documents-support.js';

// The evidence ZIPs of a period, on the engine picked by ALTIS_TEST_DB:
// - one ZIP: the evidence file PDF first, then one folder per component and `profil/`, each entry named
//   `<official number>-<nn>-<slug>.<ext>`, every entry stored with its sizes in its local header (a strict streaming
//   reader reads them all); generated lists are PDFs with the source status on every page;
// - one ZIP per component inside one ZIP: `K-koleksi.zip` … `G-pengelolaan.zip`, `profil.zip`, each holding its
//   indicator sheets (`00-lembar-<folder>.pdf`) and its files;
// - no entry of either holds the simulation, the estimate, a predicate, a gap action or an answer;
// - a component whose files pass the per-component limit is named in the run's warnings;
// - a ZIP over 5 000 entries or 2 GiB is refused before its run is written.

const ctx = testDbContext();

const msg = (key: string): string => t('id', key as MessageKey);
const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => 'resolved',
    (e: unknown) => (isDomainError(e) ? { code: e.code, meta: e.meta } : e),
  );

const actions = SMA.components.flatMap((c) => c.indicators.map((i) => msg(i.actionKey)));
const MIB = 1024 * 1024;

/** The text of an entry: a PDF's pages (checked by the structural checker), any other file's bytes. */
function entryText(e: StreamedEntry): string {
  if (e.name.endsWith('.pdf')) return pdfPages(e.data).join('\n');
  return e.data.toString('latin1');
}

/** No entry name or text holds a score, an answer, the simulation or a gap action. */
function expectNoScore(entries: readonly StreamedEntry[]): void {
  for (const e of entries) {
    const text = entryText(e);
    for (const bad of [...FORBIDDEN, ...actions, 'Saran ALTIS']) {
      expect(e.name, e.name).not.toContain(bad);
      expect(text, `${e.name}: ${bad}`).not.toContain(bad);
    }
  }
}

describe.skipIf(!ctx.available)(`accreditation evidence ZIPs [${engineLabel()}]`, () => {
  let db: DocsDb;
  let periodId: string;

  beforeAll(async () => {
    db = await openDocsDb('accred-dossier-zip');
    periodId = await seedPeriod(db, { instrumentId: 'sch-sma-2025' });
    const photo = await addEvidence(db, periodId, { indicatorCode: 'SCH-PROFIL', evidenceCode: 'photo_front', caption: '', name: 'depan.jpg', mime: 'image/jpeg', bytes: TINY_JPEG_BASELINE });
    await db.h.db.updateTable('accred_periods').set({ profile: JSON.stringify(schoolProfile('sma_smk_ma', { photos: { front: photo } })) }).where('id', '=', periodId).execute();
    await seedResults(db, periodId, SMA);
    await seedAnswers(db, periodId);
    await addEvidence(db, periodId, { indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'Layar katalog ALTIS', name: 'katalog.jpg', mime: 'image/jpeg', bytes: TINY_JPEG_BASELINE });
    await addEvidence(db, periodId, { indicatorCode: 'SCH-K3', evidenceCode: 'policy_document', caption: 'Kebijakan pengembangan koleksi 2025', name: 'kebijakan.PDF', mime: 'application/pdf', bytes: tinyPdf('Kebijakan') });
    await addEvidence(db, periodId, { indicatorCode: 'SCH-L1', evidenceCode: 'procedure_display', caption: 'Infografis tata tertib', name: 'tata-tertib.jpg', mime: 'image/jpeg', bytes: TINY_JPEG_BASELINE });
    await addEvidence(db, periodId, { indicatorCode: 'SCH-PRASYARAT', evidenceCode: null, caption: 'Salinan NPP', name: 'npp.pdf', mime: 'application/pdf', bytes: tinyPdf('NPP') });
  });

  afterAll(async () => {
    await db?.close();
  });

  it('writes one ZIP: the evidence file, one folder per component and the profile, every entry readable as it streams', async () => {
    const { run, bytes } = await runDoc(db, 'accreditation.dossier', periodId, { format: 'zip' });
    expect(run).toMatchObject({ format: 'zip', locale: 'id', personal: 1 });
    expect(storedParams(run)).toMatchObject({ def: { periodId, part: 'all', zipMode: 'combined' } });
    const entries = streamEntries(bytes);
    for (const e of entries) {
      expect(e.method, e.name).toBe(0);
      expect(e.flags & 0x0008, e.name).toBe(0);
    }
    const names = entries.map((e) => e.name);
    expect(Number(run.row_count)).toBe(names.length);
    expect(names[0]).toBe('00-berkas-bukti.pdf');
    for (const name of names.slice(1)) {
      expect(name).toMatch(/^(K-koleksi|SP-sarana|L-pelayanan|T-tenaga|F-penyelenggaraan|G-pengelolaan|profil)\/[A-Za-z0-9]+-\d{2,}-[a-z0-9-]{1,60}\.[a-z0-9]+$/);
    }
    expect(names).toEqual(
      expect.arrayContaining([
        'K-koleksi/K1-01-daftar-judul-koleksi-karya-cetak-karya-rekam-dan-alat.pdf',
        'K-koleksi/K1-02-layar-katalog-altis.jpg',
        'K-koleksi/K1-03-rekap-buku-tercetak-menurut-klasifikasi-bukti-pendukung.pdf',
        'K-koleksi/K3-01-kebijakan-pengembangan-koleksi-2025.pdf',
        'L-pelayanan/L1-01-infografis-tata-tertib.jpg',
        'T-tenaga/T3-01-daftar-tenaga-beserta-peran-dan-sertifikatnya.pdf',
        'profil/profil-01-tampak-depan-perpustakaan.jpg',
        'profil/prasyarat-01-salinan-npp.pdf',
      ]),
    );
    // The folders come in component order, the profile last (a component without any file or list has no folder).
    const order = ['K-koleksi', 'SP-sarana', 'L-pelayanan', 'T-tenaga', 'F-penyelenggaraan', 'G-pengelolaan', 'profil'];
    const folders = [...new Set(names.slice(1).map((n) => n.split('/')[0]!))];
    expect(folders).toEqual(order.filter((f) => folders.includes(f)));
    expect(folders).toEqual(expect.arrayContaining(['K-koleksi', 'SP-sarana', 'L-pelayanan', 'T-tenaga', 'G-pengelolaan', 'profil']));

    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('K-koleksi/K1-02-layar-katalog-altis.jpg')!.data.equals(Buffer.from(TINY_JPEG_BASELINE))).toBe(true);
    const dossier = pdfPages(byName.get('00-berkas-bukti.pdf')!.data);
    expect(dossier.join('\n')).toContain('Lembar Indikator Kinerja');
    const list = pdfPages(byName.get('K-koleksi/K1-01-daftar-judul-koleksi-karya-cetak-karya-rekam-dan-alat.pdf')!.data);
    expect(list[0]).toContain('K1 · Daftar judul koleksi');
    for (const page of list) expect(page).toContain('salinan, belum dibandingkan dengan JDIH');
    expectNoScore(entries);
  });

  it('writes the same ZIP when its slices stop often and when the work of some slices is lost', async () => {
    const once = await runDoc(db, 'accreditation.dossier', periodId, { format: 'zip' });
    const { id, jobId } = await startDoc(db, 'accreditation.dossier', periodId, { format: 'zip' });
    const outcomes = await drive(db, jobId, { budgetMs: 3_200, forget: (slice) => slice % 3 === 2 });
    expect(outcomes.length).toBeGreaterThan(4);
    const run = await db.h.db.selectFrom('report_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    const again = await fsp.readFile(reportExportPath(db.dataDir, id, 'zip'));
    expect(streamEntries(again).map((e) => e.name)).toEqual(streamEntries(once.bytes).map((e) => e.name));
    expect(again.equals(once.bytes)).toBe(true);
  });

  it('writes one ZIP per component inside one ZIP, each with its sheets and its files', async () => {
    const { run, bytes } = await runDoc(db, 'accreditation.dossier', periodId, { format: 'zip_components' });
    expect(run.format).toBe('zip');
    expect(storedParams(run)).toMatchObject({ def: { periodId, part: 'all', zipMode: 'components' } });
    const outer = streamEntries(bytes);
    expect(outer.map((e) => e.name)).toEqual(['K-koleksi.zip', 'SP-sarana.zip', 'L-pelayanan.zip', 'T-tenaga.zip', 'F-penyelenggaraan.zip', 'G-pengelolaan.zip', 'profil.zip']);
    const inner = new Map(outer.map((e) => [e.name.replace(/\.zip$/, ''), streamEntries(e.data)]));
    for (const [folder, entries] of inner) {
      expect(entries[0]!.name, folder).toBe(`00-lembar-${folder}.pdf`);
      for (const page of pdfPages(entries[0]!.data)) expect(page).toContain(folder === 'profil' ? '3201010D1000004' : 'salinan, belum dibandingkan dengan JDIH');
      for (const e of entries) expect(e.flags & 0x0008, e.name).toBe(0);
      expectNoScore(entries);
    }
    const k = inner.get('K-koleksi')!;
    expect(k.map((e) => e.name)).toEqual(
      expect.arrayContaining(['K1-01-daftar-judul-koleksi-karya-cetak-karya-rekam-dan-alat.pdf', 'K1-02-layar-katalog-altis.jpg', 'K3-01-kebijakan-pengembangan-koleksi-2025.pdf']),
    );
    const sheets = pdfPages(k[0]!.data).join('\n');
    expect(sheets).toContain('K1 · Koleksi Perpustakaan butir 1');
    expect(sheets).toContain('K8 · Koleksi Perpustakaan butir 8');
    expect(sheets).not.toContain('SP1 ·');
    expect(inner.get('L-pelayanan')!.map((e) => e.name)).toContain('L1-01-infografis-tata-tertib.jpg');
    const profil = inner.get('profil')!;
    expect(pdfPages(profil[0]!.data).join('\n')).toContain('Data Profil Perpustakaan');
    expect(profil.map((e) => e.name)).toEqual(['00-lembar-profil.pdf', 'profil-01-tampak-depan-perpustakaan.jpg', 'prasyarat-01-salinan-npp.pdf']);
  });

  it('writes the statistics mode as one ZIP: the evidence file, the profile and the annex lists', async () => {
    await withTx(db.h, (trx) => writeSettings(trx, { 'library.type': 'umum' }, { keyring: KEYRING, now: SEEDED_AT, actorId: null }));
    try {
      const id = await seedPeriod(db, { instrumentId: 'general-stats', name: 'Tahun 2026', population: false, profile: { npp: '3273000D2000001' } });
      await seedResults(db, id, GENERAL_STATS);
      await addEvidence(db, id, { indicatorCode: 'SCH-PROFIL', evidenceCode: 'photo_reading_room', caption: 'Ruang baca', name: 'baca.jpg', mime: 'image/jpeg', bytes: TINY_JPEG_BASELINE });
      const { bytes } = await runDoc(db, 'accreditation.dossier', id, { format: 'zip' });
      const entries = streamEntries(bytes);
      const names = entries.map((e) => e.name);
      expect(names[0]).toBe('00-berkas-bukti.pdf');
      expect(names).toContain('profil/profil-01-ruang-baca.jpg');
      const annex = names.filter((n) => n.startsWith('lampiran/'));
      expect(annex).toEqual([
        'lampiran/01-lampiran-kegiatan-perpustakaan.pdf',
        'lampiran/02-daftar-tenaga-perpustakaan.pdf',
        'lampiran/03-pelatihan-tenaga-perpustakaan.pdf',
        expect.stringMatching(/^lampiran\/04-/),
        'lampiran/05-lampiran-anggaran-perpustakaan.pdf',
        expect.stringMatching(/^lampiran\/06-/),
        'lampiran/07-lampiran-buku-tercetak-menurut-klasifikasi.pdf',
        'lampiran/08-lampiran-koleksi-menurut-media-dan-jenis.pdf',
        'lampiran/09-lampiran-penambahan-judul-tiga-tahun.pdf',
        'lampiran/10-lampiran-penggunaan-bulanan.pdf',
      ]);
      expect(names.every((n) => n === '00-berkas-bukti.pdf' || n.startsWith('profil/') || n.startsWith('lampiran/'))).toBe(true);
      for (const e of entries) if (e.name.endsWith('.pdf')) for (const page of pdfPages(e.data)) expect(page).toContain('Peraturan Perpusnas 2/2022');
      expectNoScore(entries);
    } finally {
      await withTx(db.h, (trx) => writeSettings(trx, { 'library.type': 'sekolah' }, { keyring: KEYRING, now: SEEDED_AT, actorId: null }));
    }
  });

  it('names a component whose files pass the per-component limit in the run warnings, across many short slices', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025', profile: schoolProfile('sma_smk_ma') });
    await seedResults(db, id, SMA);
    const half = Buffer.alloc(Math.round(4.75 * MIB), 7);
    await addEvidence(db, id, { indicatorCode: 'SCH-K4', evidenceCode: 'survey_report', caption: 'Survei kebutuhan 1', name: 'survei-1.pdf', mime: 'application/pdf', bytes: half });
    await addEvidence(db, id, { indicatorCode: 'SCH-K4', evidenceCode: 'survey_report', caption: 'Survei kebutuhan 2', name: 'survei-2.pdf', mime: 'application/pdf', bytes: half, sortOrder: 1 });
    const { id: runId, jobId } = await startDoc(db, 'accreditation.dossier', id, { format: 'zip_components' });
    const outcomes = await drive(db, jobId, { budgetMs: 3_500 });
    expect(outcomes.length).toBeGreaterThan(2);
    const run = await db.h.db.selectFrom('report_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    const warnings = storedParams(run).warnings ?? [];
    const over = warnings.find((w) => w.startsWith('component_over_limit:K:'));
    expect(over, warnings.join(',')).toBeDefined();
    expect(Number(over!.split(':')[2])).toBeGreaterThan(9.5 * MIB);
    expect(warnings.some((w) => w.startsWith('component_over_limit:SP:'))).toBe(false);
    const job = await db.h.db.selectFrom('jobs').select('progress_message').where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.progress_message).toBe('warnings');
  });

  it('refuses a ZIP over 5 000 entries or 2 GiB before its run is written', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025' });
    const fileId = newId(SEEDED_AT);
    await db.h.db
      .insertInto('files')
      .values({ id: fileId, original_name: 'besar.pdf', mime: 'application/pdf', size: 1, sha256: 'x', context: 'accreditation.evidence', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: SEEDED_AT, created_by: null })
      .execute();
    const rows = Array.from({ length: 5_001 }, () => ({
      id: newId(SEEDED_AT),
      period_id: id,
      indicator_code: 'SCH-K4',
      evidence_code: 'survey_report',
      entity: null,
      entity_id: null,
      file_id: fileId,
      caption: 'Survei',
      created_at: SEEDED_AT,
      created_by: null,
    }));
    for (let i = 0; i < rows.length; i += 500) await db.h.db.insertInto('accred_evidence').values(rows.slice(i, i + 500)).execute();
    const before = await db.h.db.selectFrom('report_runs').select('id').execute();
    const entries = (await failure(startDoc(db, 'accreditation.dossier', id, { format: 'zip' }))) as { code: string; meta: Record<string, unknown> };
    expect(entries.code).toBe('REPORT_TOO_LARGE');
    expect(entries.meta).toMatchObject({ max: 5000, format: 'zip', limit: 'entries' });
    expect(entries.meta['rows']).toBeGreaterThan(5001);
    expect(await failure(startDoc(db, 'accreditation.dossier', id, { format: 'zip_components' }))).toMatchObject({ code: 'REPORT_TOO_LARGE', meta: { limit: 'entries' } });
    // The PDF alone holds no evidence file: it starts.
    expect(await failure(startDoc(db, 'accreditation.dossier', id, { format: 'pdf' }))).toBe('resolved');

    const big = await seedPeriod(db, { instrumentId: 'sch-sma-2025' });
    const bigFile = newId(SEEDED_AT);
    await db.h.db
      .insertInto('files')
      .values({ id: bigFile, original_name: 'video.pdf', mime: 'application/pdf', size: 2 * 1024 ** 3, sha256: 'x', context: 'accreditation.evidence', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: SEEDED_AT, created_by: null })
      .execute();
    await db.h.db
      .insertInto('accred_evidence')
      .values({ id: newId(SEEDED_AT), period_id: big, indicator_code: 'SCH-K4', evidence_code: 'survey_report', entity: null, entity_id: null, file_id: bigFile, caption: 'Video', created_at: SEEDED_AT, created_by: null })
      .execute();
    const bytes = (await failure(startDoc(db, 'accreditation.dossier', big, { format: 'zip' }))) as { code: string; meta: Record<string, unknown> };
    expect(bytes).toMatchObject({ code: 'REPORT_TOO_LARGE', meta: { max: 2 * 1024 ** 3, format: 'zip', limit: 'bytes' } });
    expect(bytes.meta['rows']).toBeGreaterThan(2 * 1024 ** 3);
    const after = await db.h.db.selectFrom('report_runs').select('id').execute();
    expect(after.length).toBe(before.length + 1);
  });
});
