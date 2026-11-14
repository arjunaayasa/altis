import { MESSAGES } from '@altis/shared';
import type { ResultsView } from '@altis/shared/api/accreditation';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp, type FakeHandler } from '../fake-api';
import { PERIOD_ID, indicatorResult, instrumentsAnswer, periodView, periodsAnswer, resultsView, scoreView } from './workspace-fixtures';

// Ringkasan (spec §6, §10.3, §10.12): the registration prerequisites on top, the estimated score as a range with
// "terjawab X/42" while an indicator is unanswered, the single estimate with its predicate only when every indicator is
// answered and the prerequisites are met (with a failing prerequisite the single estimate is shown as a practice figure,
// never with a predicate), a bar per component, the ten largest gaps with their suggested action, the missing evidence
// per component and the disclaimer.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FIRST = { timeout: 10_000 };
const ID = MESSAGES.id;

function open(results: ResultsView, o: { instrumentId?: string } = {}) {
  const period = periodView(o.instrumentId === undefined ? {} : { instrumentId: o.instrumentId });
  const routes: Record<string, FakeHandler> = {
    'GET accreditation/instruments': () => instrumentsAnswer(),
    'GET accreditation/periods': () => periodsAnswer(period),
    'GET accreditation/periods/:id': () => period,
    'GET accreditation/periods/:id/results': () => results,
  };
  return startApp({ me: adminMe(), path: `/admin/accreditation/${PERIOD_ID}?tab=ringkasan`, routes });
}

/** Every predicate label, none of which may show without a met prerequisite. */
const PREDICATES = (['A', 'B', 'C', 'D'] as const).map((g) => ID[`accred.predicate.${g}`]);

describe('Ringkasan', () => {
  it('with 40 of 42 answered: "terjawab 40/42", the range, no predicate, and the disclaimer', async () => {
    open(resultsView());
    expect(await screen.findByText('terjawab 40/42', undefined, FIRST)).toBeTruthy();
    expect(screen.getByText('Perkiraan NA 70,45–72,10')).toBeTruthy();
    for (const label of PREDICATES) expect(screen.queryByText(new RegExp(label))).toBeNull();
    expect(screen.queryByText(/Predikat/)).toBeNull();
    expect(screen.getByText(ID['accred.disclaimer.estimate'])).toBeTruthy();
  });

  it('all answered with a failing prerequisite: the failed banner, the single estimate as a practice figure, never a predicate', async () => {
    open(
      resultsView({
        prerequisites: { titles: { pass: false, count: 850, asOf: '2026-06-30' }, npp: { pass: true }, foundingDecree: { pass: true }, met: false },
        score: scoreView({ answered: 42, total: 42, na: '82.14', naLow: '82.14', naHigh: '82.14', grade: null }),
      }),
    );
    expect(await screen.findByText(ID['accred.prereq.failed'], undefined, FIRST)).toBeTruthy();
    const estimate = screen.getByText(ID['accred.na.exercise']).closest('[data-score]') as HTMLElement;
    expect(estimate.getAttribute('data-score')).toBe('exercise');
    expect(within(estimate).getByText('82,14')).toBeTruthy();
    for (const label of PREDICATES) expect(screen.queryByText(new RegExp(label))).toBeNull();
    expect(screen.queryByText(/Predikat/)).toBeNull();
    expect(screen.getByText(ID['accred.disclaimer.estimate'])).toBeTruthy();
  });

  it('all answered with the prerequisites met: the single estimate and its predicate', async () => {
    open(resultsView({ score: scoreView({ answered: 42, total: 42, na: '82.14', naLow: '82.14', naHigh: '82.14', grade: 'B' }) }));
    const estimate = (await screen.findByText('Perkiraan NA 82,14', undefined, FIRST)).closest('[data-score]') as HTMLElement;
    expect(estimate.getAttribute('data-score')).toBe('single');
    expect(within(estimate).getByText(`Predikat: B (${ID['accred.predicate.B']})`)).toBeTruthy();
    expect(screen.queryByText(ID['accred.na.exercise'])).toBeNull();
    expect(screen.queryByText(ID['accred.prereq.failed'])).toBeNull();
  });

  it('the prerequisite block comes first and names each check', async () => {
    open(resultsView({ prerequisites: { titles: { pass: true, count: 1_250, asOf: '2026-06-30' }, npp: { pass: false }, foundingDecree: { pass: true }, met: false } }));
    const block = await screen.findByRole('region', { name: 'Prasyarat pendaftaran' }, FIRST);
    expect(within(block).getByText('Koleksi paling sedikit 1.000 judul: 1.250 judul per 30 Jun 2026.')).toBeTruthy();
    const npp = within(block).getByText(ID['accred.prereq.npp']).closest('li') as HTMLElement;
    expect(within(npp).getByText('Belum terpenuhi')).toBeTruthy();
    const score = screen.getByRole('region', { name: 'Perkiraan nilai akhir (NA)' });
    expect(block.compareDocumentPosition(score) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a bar per component, the largest gaps with their action, and the missing evidence per component', async () => {
    open(
      resultsView({
        indicators: [indicatorResult('SCH-K3', 'K3', 'K')],
        missingEvidence: [
          { component: 'K', items: [{ indicatorCode: 'SCH-K3', officialNo: 'K3', evidenceCode: 'policy_document', labelKey: 'accred.evidence.K3.policy_document' }] },
        ],
      }),
    );
    const bars = await screen.findByRole('region', { name: 'Skor per komponen' }, FIRST);
    const meters = within(bars).getAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual([ID['accred.component.K'], ID['accred.component.SP'], ID['accred.component.L']]);
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('24');
    expect(meters[0]!.getAttribute('aria-valuemax')).toBe('32');

    const gaps = screen.getByRole('region', { name: '10 celah terbesar' });
    const items = within(gaps).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('K3 · Koleksi butir 3');
    expect(items[0]!.textContent).toContain(ID['accred.gap.action.K3']);
    expect(items[1]!.textContent).toContain('L8 · Pelayanan butir 8');

    const missing = screen.getByRole('region', { name: 'Bukti belum lengkap per komponen' });
    expect(within(missing).getByText(ID['accred.component.K'])).toBeTruthy();
    expect(within(missing).getByText(new RegExp(ID['accred.evidence.K3.policy_document']))).toBeTruthy();
  });

  it('before the first evaluation it asks for one', async () => {
    open(resultsView({ status: 'missing', computedAt: null, stale: true, prerequisites: null, score: null }));
    expect(await screen.findByText('Hasil periode ini belum dihitung. Tekan Hitung ulang untuk menghitungnya.', undefined, FIRST)).toBeTruthy();
    expect(screen.queryByText(/terjawab/)).toBeNull();
  });

  it('an unscored instrument shows no estimate', async () => {
    open(resultsView({ score: null }), { instrumentId: 'general-stats' });
    expect(await screen.findByText(/Instrumen ini tidak berskor/, undefined, FIRST)).toBeTruthy();
    expect(screen.queryByText(/terjawab/)).toBeNull();
    expect(screen.queryByText(ID['accred.disclaimer.estimate'])).toBeNull();
  });
});
