import type { MemberLoanPage } from '@altis/core';
import { AKUN_CSS } from '@altis/opac-theme';
import type { HoldView } from '@altis/shared/api/holds';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { HistoryView, HoldsView, OpenLoans } from '../src/opac/akun/views.js';

// The member area's tables of loans, history and holds on a phone: below the shell's 48 rem each row is a card (CSS
// only, the page keeps its strict CSP), so the due date and the "Perpanjang" or "Batalkan" button show without a
// sideways scroll. The markup gives every cell what the card needs: the title heads it, the action spans it, and each
// other cell names its column in `data-label`.

/** The server render of a view (hono's jsx() from a .ts file). */
const render = (view: unknown, props: Record<string, unknown>): string => String(jsx(view as never, props as never));

/** The attributes of every <td> of `html`, in order. */
function cells(html: string): Record<string, string>[] {
  return [...html.matchAll(/<td(\s[^>]*)?>/g)].map((m) => Object.fromEntries([...(m[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])));
}

/** The labels the cards print, per row: the title cell and the action cell carry none. */
function labelsPerRow(html: string, perRow: number): string[][] {
  const all = cells(html);
  expect(all.length % perRow).toBe(0);
  for (const c of all) {
    const cls = (c.class ?? '').split(' ');
    expect(cls.includes('akun-stack-main') || cls.includes('akun-stack-action') || c['data-label'] !== undefined, JSON.stringify(c)).toBe(true);
  }
  const rows: string[][] = [];
  for (let i = 0; i < all.length; i += perRow) rows.push(all.slice(i, i + perRow).flatMap((c) => (c['data-label'] === undefined ? [] : [c['data-label']])));
  return rows;
}

const loan = (id: string, o: Partial<MemberLoanPage['rows'][number]> = {}): MemberLoanPage['rows'][number] => ({
  id,
  recordId: 'R1',
  title: 'Laskar Pelangi: sebuah novel yang judulnya cukup panjang untuk layar ponsel',
  barcode: 'B0001',
  branchId: 'BR1',
  loanedOn: '2026-11-01',
  dueOn: '2026-11-08',
  returnedOn: null,
  outcome: null,
  renewals: 0,
  renewLimit: 2,
  daysLate: 0,
  finedDays: null,
  fineMinor: 0,
  currency: 'IDR',
  ...o,
});

const hold = (id: string, o: Partial<HoldView> = {}): HoldView => ({
  id,
  version: 1,
  status: 'waiting',
  record: { id: 'R1', title: 'Bumi Manusia' },
  item: null,
  pinned: false,
  member: null,
  pickupBranch: { id: 'BR1', code: 'PUSAT', name: 'Perpustakaan Pusat' },
  source: 'opac',
  placedOn: '2026-11-10',
  placedAt: 0,
  position: 2,
  readyAt: null,
  pickupUntil: null,
  expiresOn: null,
  closedAt: null,
  closeReason: null,
  shelfClearedAt: null,
  ...o,
});

describe('the member area tables stack into cards on a phone', () => {
  it('the open loans: every row a card with its due date and its renew button labelled for the card', () => {
    const loans: MemberLoanPage = { rows: [loan('L1', { daysLate: 3 }), loan('L2', { dueOn: '2026-11-30' })], total: 2, page: 1, pages: 1 };
    const html = render(OpenLoans, { locale: 'id', keep: (p: string) => p, csrf: 'token', loans, canRenew: true });
    expect(html).toContain('<table class="akun-table akun-stack">');
    expect(labelsPerRow(html, 6)).toEqual([
      ['Barkod', 'Dipinjam', 'Jatuh tempo', 'Perpanjangan'],
      ['Barkod', 'Dipinjam', 'Jatuh tempo', 'Perpanjangan'],
    ]);
    expect(cells(html).filter((c) => c.class === 'akun-stack-action')).toHaveLength(2);
    expect(html.match(/<button type="submit"[^>]*>Perpanjang<\/button>/g)).toHaveLength(2);
    // English labels the same way; and no inline style or script for the strict CSP.
    const en = render(OpenLoans, { locale: 'en', keep: (p: string) => p, csrf: 'token', loans, canRenew: false });
    expect(labelsPerRow(en, 5)[0]).toEqual(['Barcode', 'Borrowed', 'Due', 'Renewals']);
    for (const page of [html, en]) expect(page).not.toMatch(/\sstyle=|<script/);
  });

  it('the holds and the history stack the same way', () => {
    const holds = render(HoldsView, { locale: 'id', keep: (p: string) => p, csrf: 'token', active: [hold('H1'), hold('H2', { status: 'ready', position: null, pickupUntil: '2026-11-18' })], closed: [] });
    expect(holds).toContain('<table class="akun-table akun-stack">');
    expect(labelsPerRow(holds, 4)).toEqual([
      ['Keadaan', 'Tempat ambil'],
      ['Keadaan', 'Tempat ambil'],
    ]);
    const history = render(HistoryView, { locale: 'id', keep: (p: string) => p, loans: { rows: [loan('L3', { returnedOn: '2026-11-09', outcome: 'returned' })], total: 1, page: 1, pages: 1 } });
    expect(labelsPerRow(history, 5)).toEqual([['Barkod', 'Dipinjam', 'Dikembalikan', 'Keterangan']]);
  });

  it('a late loan says its days late as the desk does: the days its fine counts when they differ, and the running fine', () => {
    const loans: MemberLoanPage = {
      rows: [loan('L1', { daysLate: 10, finedDays: 8, fineMinor: 400_000 }), loan('L2', { daysLate: 3, finedDays: 3, fineMinor: 150_000 }), loan('L3', { daysLate: 2 })],
      total: 3,
      page: 1,
      pages: 1,
    };
    const id = render(OpenLoans, { locale: 'id', keep: (p: string) => p, csrf: 'token', loans, canRenew: false });
    expect(id).toContain('Terlambat 10 hari (8 hari dikenai denda)');
    expect(id).toMatch(/Denda berjalan Rp\s?4\.000/);
    expect(id).toContain('Terlambat 3 hari</span>');
    expect(id).toContain('Terlambat 2 hari</span>');
    expect(id.match(/Denda berjalan/g)).toHaveLength(2);
    const en = render(OpenLoans, { locale: 'en', keep: (p: string) => p, csrf: 'token', loans, canRenew: false });
    expect(en).toContain('10 days late (8 days fined)');
    const history = render(HistoryView, { locale: 'en', keep: (p: string) => p, loans: { rows: [loan('L4', { returnedOn: '2026-11-18', outcome: 'returned', daysLate: 10, finedDays: 8 })], total: 1, page: 1, pages: 1 } });
    expect(history).toContain('10 days late (8 days fined)');
    expect(history).not.toContain('Running fine');
  });

  it('the stylesheet turns those tables into cards below 48 rem: the header row only for screen readers, each cell labelled, the button across the card', () => {
    const narrow = /@media \(max-width:47\.99rem\)\{(.*)\}/.exec(AKUN_CSS.split('\n').find((line) => line.includes('.akun-stack')) ?? '')?.[1] ?? '';
    expect(narrow).toContain('.akun-stack thead{position:absolute;width:1px;height:1px;');
    expect(narrow).toContain('.akun-stack,.akun-stack tbody,.akun-stack tr,.akun-stack td{display:block;width:100%}');
    expect(narrow).toContain('.akun-stack td[data-label]::before{content:attr(data-label);');
    expect(narrow).toContain('.akun-stack .akun-stack-action button{width:100%}');
    // Nothing of it reaches a wider screen: the desktop table is unchanged.
    expect(AKUN_CSS.replace(/@media \(max-width:47\.99rem\)\{.*\}/, '')).not.toContain('akun-stack');
  });
});
