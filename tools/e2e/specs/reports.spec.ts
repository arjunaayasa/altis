import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import type { Download } from '@playwright/test';
import type { CspRecorder } from '../lib/csp.js';
import { T, expect, signIn, test } from '../fixtures.js';
import { openNavPage } from '../lib/nav.js';

// The community report framework as a librarian uses it, in a real browser with the CSP guard of fixtures.ts on every
// page: Laporan lists the collection reports; the title list is previewed (its first page holds a record this spec
// catalogued through the API) and exported as CSV, a job the page follows to its end; the file is downloaded and read
// (a BOM, the header row, the record's title). The fixture super admin holds every permission it needs.
//
// The screens' words come from the admin catalogues (lib/text.ts), the way the SPA renders them.

function randomLetters(n: number): string {
  return Array.from(randomBytes(n), (b) => String.fromCharCode(0x61 + (b % 26))).join('');
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Runs `fn` as a reported step and requires that it caused no CSP problem (the fixture checks the test again). */
async function clean(csp: CspRecorder, name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    const mark = csp.mark();
    await fn();
    expect(csp.problems(mark), `CSP problems during "${name}"`).toEqual([]);
  });
}

test('Laporan: the title list is previewed, exported as CSV and the file downloaded', async ({ page, csp, staff, admin }) => {
  test.setTimeout(5 * 60_000);
  const word = randomLetters(7);
  const title = `Hikayat ${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  const types = await staff.call<{ items: { id: string; code: string }[] }>('GET', 'catalog/material-types');
  const buku = types.items.find((t) => t.code === 'BUKU');
  if (buku === undefined) throw new Error('the seeded material type BUKU is missing');
  await staff.call('POST', 'catalog/records', { materialTypeId: buku.id, title });

  const reportTitle = T('report.collection.title_list.title');

  await clean(csp, 'sign in', async () => {
    await signIn(page, admin);
  });

  await clean(csp, 'Laporan: the catalogue of reports opens the title list', async () => {
    await openNavPage(page, '/admin/reports');
    await expect(page).toHaveURL(/\/admin\/reports$/);
    await expect(page.getByRole('heading', { level: 1, name: T('reports.catalog.title'), exact: true })).toBeVisible();
    await page.getByRole('link', { name: reportTitle, exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/reports\/collection\.title_list$/);
    await expect(page.getByRole('heading', { level: 1, name: reportTitle, exact: true })).toBeVisible();
  });

  await clean(csp, 'preview: the first page holds the catalogued record', async () => {
    await page.getByRole('form', { name: T('reports.params.title') }).getByRole('button', { name: T('reports.params.apply'), exact: true }).click();
    const table = page.getByRole('table', { name: T('reports.preview.caption', { title: reportTitle }) });
    await expect(table).toBeVisible();
    await expect(table.getByRole('row').filter({ hasText: title })).toHaveCount(1);
  });

  await clean(csp, 'export as CSV: the job ends, the file is downloaded and read', async () => {
    await page.getByRole('button', { name: T('reports.export.csv'), exact: true }).click();
    const run = page.getByRole('region', { name: T('reports.export.running', { format: 'CSV' }), exact: true });
    await expect(run).toBeVisible();
    // The download appears once the run has succeeded.
    const label = T('reports.runs.download_label', { format: T('vocab.report_format.csv'), date: '' }).trim();
    const link = run.getByRole('link', { name: new RegExp(`^${escapeRe(label)}`) });
    await expect(link).toBeVisible({ timeout: 120_000 });
    await expect(run.getByText(T('vocab.report_run_status.succeeded'), { exact: true }).first()).toBeVisible();
    await expect(link).toHaveAttribute('href', /^\/api\/v1\/reports\/runs\/[0-9A-HJKMNP-TV-Z]{26}\/download$/);
    const [download]: [Download, void] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const text = await fsp.readFile(await download.path(), 'utf8');
    expect(text.charCodeAt(0), 'the CSV starts with a BOM').toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain(title);
  });

  await clean(csp, 'the run is listed under Ekspor Anda', async () => {
    const runs = page.getByRole('table', { name: T('reports.runs.caption') });
    await expect(runs.getByRole('row').filter({ hasText: T('vocab.report_run_status.succeeded') }).first()).toBeVisible();
  });
});
