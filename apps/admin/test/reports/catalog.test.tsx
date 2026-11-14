import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPORTS_EN, REPORTS_ID } from '@/i18n/reports';
import { signedIn, startApp } from '../fake-api';
import { FIRST, reportRoutes } from './support';

// Laporan, the report catalogue (`/admin/reports`): one card per module the user may read (Koleksi, Akreditasi), each
// listing its reports with a link to the report's page and a badge for personal data or a document. The server lists
// only the definitions whose permission the user holds; the screen shows what it was given.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BOTH = signedIn({ permissions: ['reports.statistics.read', 'accreditation.workspace.read'] });
const STATISTICS = signedIn({ permissions: ['reports.statistics.read'] });

/** The module cards on screen. */
const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-report-module]')];

describe('Laporan, the report catalogue', { timeout: 20_000 }, () => {
  it('shows two cards, Koleksi and Akreditasi, to a holder of both permissions, each linking its reports', async () => {
    startApp({ me: BOTH, path: '/admin/reports', routes: reportRoutes(BOTH) });
    const collection = (await screen.findByRole('heading', { name: 'Koleksi' }, FIRST)).closest<HTMLElement>('[data-report-module]')!;
    const accreditation = screen.getByRole('heading', { name: 'Akreditasi' }).closest<HTMLElement>('[data-report-module]')!;
    expect(cards()).toEqual([collection, accreditation]);
    expect(collection.getAttribute('data-report-module')).toBe('collection');
    expect(accreditation.getAttribute('data-report-module')).toBe('accreditation');

    const summary = within(collection).getByRole('link', { name: /Ringkasan koleksi/ });
    expect(summary.getAttribute('href')).toBe('/admin/reports/collection.summary');
    expect(within(collection).getByRole('link', { name: /Perolehan koleksi per tahun/ }).getAttribute('href')).toBe('/admin/reports/collection.acquisitions');
    expect(within(collection).queryByRole('link', { name: /Lampiran/ })).toBeNull();

    const staff = within(accreditation).getByRole('link', { name: /Lampiran: tenaga perpustakaan/ });
    expect(staff.getAttribute('href')).toBe('/admin/reports/accreditation.annex.staff');
    expect(within(staff.closest('li')!).getByText('Data pribadi')).toBeTruthy();
    const dossier = within(accreditation).getByRole('link', { name: /Berkas bukti akreditasi/ });
    expect(within(dossier.closest('li')!).getByText('Dokumen')).toBeTruthy();
    // The real screen replaced the placeholder.
    expect(document.querySelector('[data-screen-placeholder]')).toBeNull();
  });

  it('shows one card, Koleksi, to a holder of the statistics permission only', async () => {
    startApp({ me: STATISTICS, path: '/admin/reports', routes: reportRoutes(STATISTICS) });
    await screen.findByRole('heading', { name: 'Koleksi' }, FIRST);
    expect(cards()).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Akreditasi' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Lampiran/ })).toBeNull();
  });

  it('says so when the user may open no report', async () => {
    const outsider = signedIn({ permissions: ['catalog.records.read'] });
    startApp({ me: outsider, path: '/admin/reports', routes: reportRoutes(outsider) });
    expect(await screen.findByText('Tidak ada laporan yang dapat Anda buka.', undefined, FIRST)).toBeTruthy();
    expect(cards()).toHaveLength(0);
  });

  it('in English for a user who chose English', async () => {
    const me = { ...BOTH, user: { ...BOTH.user, locale: 'en' as const } };
    startApp({ me, path: '/admin/reports', routes: reportRoutes(me) });
    expect(await screen.findByRole('heading', { name: 'Collection' }, FIRST)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Accreditation' })).toBeTruthy();
  });
});

describe('the Laporan copy', { timeout: 20_000 }, () => {
  /** English words that never belong in an Indonesian text (placeholders left out). */
  const ENGLISH = /\b(the|and|of|to|is|are|you|your|this|that|with|for|from|not|rows?|report|export|file|print|download)\b/i;

  it('has every key in both languages, a different text in each, and no English left in the Indonesian one', () => {
    const keys = Object.keys(REPORTS_ID) as (keyof typeof REPORTS_ID)[];
    expect(keys.length).toBeGreaterThan(0);
    expect(Object.keys(REPORTS_EN).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(key.startsWith('reports.'), key).toBe(true);
      expect(REPORTS_EN[key], key).not.toBe(REPORTS_ID[key]);
      expect(REPORTS_ID[key].replace(/\{[A-Za-z_]+\}/g, ''), key).not.toMatch(ENGLISH);
    }
  });
});
