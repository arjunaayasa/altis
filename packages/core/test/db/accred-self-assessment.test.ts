import { t, type MessageKey } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import {
  OVERRIDE_NOTE,
  SMA,
  openDocsDb,
  pdfPages,
  runDoc,
  schoolProfile,
  seedAnswers,
  seedPeriod,
  seedResults,
  type DocsDb,
} from './accred-documents-support.js';

// The internal simulation of the assessment, on the engine picked by ALTIS_TEST_DB:
// - from the results of the "SMA contoh" school it prints the estimate 70,45 with predicate C, the score per
//   component, the largest gaps with their actions, the answers chosen by hand or in place of a suggestion with their
//   notes, and every note;
// - while a registration prerequisite fails (the library number removed from the profile), the failed-prerequisites
//   banner shows, the single estimate is labelled a practice estimate and no predicate prints;
// - every page carries the "internal simulation" header, the disclaimer and the instrument's source status.

const ctx = testDbContext();

const msg = (key: string): string => t('id', key as MessageKey);
const HEADER = 'SIMULASI INTERNAL — bukan untuk diunggah';

describe.skipIf(!ctx.available)(`accreditation self-assessment [${engineLabel()}]`, () => {
  let db: DocsDb;

  beforeAll(async () => {
    db = await openDocsDb('accred-self-assessment');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('prints the estimate 70,45 with predicate C, the components, gaps, answers and notes, headed on every page', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025', profile: schoolProfile('sma_smk_ma') });
    await seedResults(db, id, SMA);
    await seedAnswers(db, id);
    const { run, bytes } = await runDoc(db, 'accreditation.self_assessment', id);
    expect(run).toMatchObject({ report_id: 'accreditation.self_assessment', format: 'pdf', locale: 'id', personal: 1 });
    const pages = pdfPages(bytes);
    const all = pages.join('\n');
    expect(all).toContain('Perkiraan nilai akhir: 70,45');
    expect(all).toContain('Predikat: C (Cukup Baik)');
    expect(all).toContain(msg('accred.component.L'));
    expect(all).toContain(msg('accred.gap.action.F3'));
    expect(all).toContain(msg('accred.gap.action.T4'));
    expect(all).toContain('F3 (Penyelenggaraan) — celah 1,8750');
    expect(all).toContain(OVERRIDE_NOTE);
    expect(all).toContain('pengganti saran');
    expect(all).toContain(t('id', 'accred.note.k2_overlap'));
    expect(all).toContain(t('id', 'accred.prereq.titles', { count: '1.000', date: '30 Juni 2026' }));
    expect(all).not.toContain(msg('accred.prereq.failed'));
    expect(all).not.toContain(msg('accred.na.exercise'));
    pages.forEach((page, k) => {
      expect(page, `page ${k + 1}`).toContain(HEADER);
      expect(page, `page ${k + 1}`).toContain(msg('accred.disclaimer.estimate'));
      expect(page, `page ${k + 1}`).toContain('salinan, belum dibandingkan dengan JDIH');
      expect(page, `page ${k + 1}`).toContain(`halaman ${k + 1}/${pages.length}`);
    });
  });

  it('labels the single estimate a practice estimate and prints no predicate while a prerequisite fails', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025', profile: schoolProfile('sma_smk_ma', { npp: null }) });
    await seedResults(db, id, SMA, { prerequisites: { npp: false } });
    await seedAnswers(db, id);
    const { bytes } = await runDoc(db, 'accreditation.self_assessment', id);
    const pages = pdfPages(bytes);
    const all = pages.join('\n');
    expect(all).toContain(msg('accred.prereq.failed'));
    expect(all).toContain(`${msg('accred.na.exercise')}: 70,45`);
    for (const text of ['Predikat', 'Cukup Baik', 'Sangat Baik', 'Tidak Terakreditasi', 'Perkiraan nilai akhir: 70,45']) expect(all, text).not.toContain(text);
    for (const page of pages) {
      expect(page).toContain(HEADER);
      expect(page).toContain('salinan, belum dibandingkan dengan JDIH');
    }
    expect(all).toContain('NPP —');
  });

  it('prints the range and the answered count while items are unanswered', async () => {
    const id = await seedPeriod(db, { instrumentId: 'sch-sma-2025', profile: schoolProfile('sma_smk_ma') });
    await seedResults(db, id, SMA);
    const { bytes } = await runDoc(db, 'accreditation.self_assessment', id);
    const all = pdfPages(bytes).join('\n');
    expect(all).toContain('terjawab 38/42');
    expect(all).toContain('Butir yang belum terjawab');
    expect(all).toContain(`SP1 — ${msg('accred.ik.SP1')}`);
    expect(all).not.toContain('Predikat');
  });
});
