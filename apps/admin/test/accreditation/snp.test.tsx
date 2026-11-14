import { MESSAGES } from '@altis/shared';
import type { ResultsView } from '@altis/shared/api/accreditation';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnpTab } from '@/screens/accreditation/tabs/snp';
import type { FakeHandler } from '../fake-api';
import { ADMIN_ID, FIRST, instrumentsAnswer, periodView, renderTab, results } from './usage-print-fixtures';

// Kepatuhan SNP (spec §6, §10.9 item 8): one row per standard the tab checks, with its outcome as a badge, the rule as
// the standard words it, the value and the notes; the tab says it checks only the standards ALTIS can compute, and it
// shows no instrument score.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ID = MESSAGES.id;

function routes(view: ResultsView): Record<string, FakeHandler> {
  return {
    'GET accreditation/periods/:id': () => periodView(),
    'GET accreditation/instruments': () => instrumentsAnswer(),
    'GET accreditation/periods/:id/results': () => view,
  };
}

const SNP: ResultsView['snp'] = [
  { code: 'SNP-S-01', labelKey: 'accred.snp.S-01', outcome: 'pass', value: 1250, rule: 'accred.snp.S-01.rule', notes: [] },
  {
    code: 'SNP-S-02',
    labelKey: 'accred.snp.S-02',
    outcome: 'fail',
    value: 31,
    rule: 'accred.snp.S-02.rule.sd',
    notes: [{ key: 'accred.note.fiction_rule', params: { rule: 'tipe koleksi FIK' } }],
  },
  { code: 'SNP-S-13', labelKey: 'accred.snp.S-13', outcome: 'not_available', value: null, rule: 'accred.snp.S-13.rule', notes: [{ key: 'accred.note.snp_not_available' }] },
  { code: 'SNP-S-14', labelKey: 'accred.snp.S-14', outcome: 'reported', value: null, rule: 'accred.snp.S-14.rule', notes: [] },
];

const rowOf = (label: string): HTMLElement => screen.getByText(label).closest('tr')!;

describe('Kepatuhan SNP', () => {
  it('rows with outcome badges, the rule, the notes, and the note that only some standards are checked', async () => {
    renderTab(SnpTab, routes(results({ snp: SNP })));
    await screen.findByText(ID['accred.snp.S-01'], undefined, FIRST);
    expect(screen.getByText(ID['accred.note.snp_selected'])).toBeTruthy();

    const s01 = rowOf(ID['accred.snp.S-01']);
    expect(within(s01).getByText(ADMIN_ID['accreditation.snp.outcome.pass'])).toBeTruthy();
    expect(within(s01).getByText(ID['accred.snp.S-01.rule'])).toBeTruthy();
    expect(within(s01).getByText('1.250')).toBeTruthy();

    const s02 = rowOf(ID['accred.snp.S-02']);
    expect(within(s02).getByText(ADMIN_ID['accreditation.snp.outcome.fail'])).toBeTruthy();
    expect(within(s02).getByText(ID['accred.snp.S-02.rule.sd'])).toBeTruthy();
    expect(within(s02).getByText('Judul dihitung sebagai fiksi menurut aturan ini: tipe koleksi FIK.')).toBeTruthy();

    expect(within(rowOf(ID['accred.snp.S-14'])).getByText(ADMIN_ID['accreditation.snp.outcome.reported'])).toBeTruthy();
  });

  it('a not_available row shows its note', async () => {
    renderTab(SnpTab, routes(results({ snp: SNP })));
    await screen.findByText(ID['accred.snp.S-13'], undefined, FIRST);
    const row = rowOf(ID['accred.snp.S-13']);
    expect(within(row).getByText(ADMIN_ID['accreditation.snp.outcome.not_available'])).toBeTruthy();
    expect(within(row).getByText(ID['accred.note.snp_not_available'])).toBeTruthy();
  });

  it('no score, no grade: the tab never shows the estimate', async () => {
    renderTab(SnpTab, routes(results({ snp: SNP, score: { answered: 42, total: 42, perComponent: [], na: '88.10', naLow: '88.10', naHigh: '88.10', grade: 'A', gaps: [] } })));
    await screen.findByText(ID['accred.snp.S-01'], undefined, FIRST);
    expect(screen.queryByText(/88[.,]10/)).toBeNull();
    expect(screen.queryByText(ID['accred.predicate.A'])).toBeNull();
  });

  it('results not computed yet say so', async () => {
    renderTab(SnpTab, routes(results({ status: 'missing', computedAt: null, snp: [] })));
    expect(await screen.findByText(ADMIN_ID['accreditation.snp.missing'], undefined, FIRST)).toBeTruthy();
  });

  it('an instrument without standards says so', async () => {
    renderTab(SnpTab, routes(results({ snp: [] })));
    expect(await screen.findByText(ADMIN_ID['accreditation.snp.none'], undefined, FIRST)).toBeTruthy();
  });
});
