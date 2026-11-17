import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { Download, Page } from '@playwright/test';
import type { BranchListResponse } from '@altis/shared/api/branches';
import type { RoleItem } from '@altis/shared/api/roles';
import { createStaff } from '../lib/api.js';
import type { CspRecorder } from '../lib/csp.js';
import { T, expect, signIn, test } from '../fixtures.js';
import { openNavPage } from '../lib/nav.js';

// K10 (Phase 2 spec §15; plan Task 39): the admin's catalogue flows as a librarian does them, in a real browser, with
// the 1b CSP guard of fixtures.ts on every page: catalogue a record in Bibliografi (with a new author made in the
// picker), add its item on the record's Eksemplar tab, and print labels in Cetak Label, once for the record (through
// the print queue of the Bibliografi list) and once for the item (added by its barcode). Each label PDF is downloaded
// and read: it must be a PDF whose page draws the item's barcode and the call number. The OPAC then shows the record
// and its item.
//
// The librarian is a staff user of this spec's own with two custom roles, as a library would set them up: the
// catalogue permissions everywhere (`catalog.records.read`, `catalog.records.manage`) and `catalog.items.manage` at
// the default branch only (D2-02), so the item screens see a branch-scoped grant. The fixture super admin makes them
// through the API (`staff`).
//
// The screens' words come from the admin catalogues (lib/text.ts), the way the SPA renders them.

/** Six random lower-case letters: one search token that no other spec writes. */
function randomLetters(n: number): string {
  return Array.from(randomBytes(n), (b) => String.fromCharCode(0x61 + (b % 26))).join('');
}

/** Runs `fn` as a reported step and requires that it caused no CSP problem (the fixture checks the test again). */
async function clean(csp: CspRecorder, name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    const mark = csp.mark();
    await fn();
    expect(csp.problems(mark), `CSP problems during "${name}"`).toEqual([]);
  });
}

/**
 * The text a PDF of ALTIS's writer (packages/core/src/print/pdf.ts) draws: every Flate content stream inflated,
 * joined. The writer puts each stream as `<< /Length n /Filter /FlateDecode >>\nstream\n<n bytes>\nendstream`.
 */
function pdfContent(pdf: Buffer): string {
  const text = pdf.toString('latin1'); // one character per byte: string offsets are byte offsets
  const out: string[] = [];
  const head = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    const start = m.index + m[0].length;
    const length = Number(m[1]);
    out.push(inflateSync(pdf.subarray(start, start + length)).toString('latin1'));
    head.lastIndex = start + length;
  }
  return out.join('\n');
}

/** "Unduh PDF" of Cetak Label: the downloaded label PDF, its name checked. */
async function downloadLabels(page: Page): Promise<Buffer> {
  const [download]: [Download, void] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: T('catalog.labels.print.download'), exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('label.pdf');
  return fsp.readFile(await download.path());
}

/** The checks every label PDF passes: a PDF 1.4 with an xref and EOF, whose page draws each of `draws` and none of `not`. */
function expectLabelPdf(pdf: Buffer, draws: readonly string[], not: readonly string[] = []): void {
  expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
  expect(pdf.toString('latin1')).toMatch(/startxref\n\d+\n%%EOF\n$/);
  const content = pdfContent(pdf);
  for (const text of draws) expect(content, `the label PDF draws ${text}`).toContain(`(${text}) Tj`);
  for (const text of not) expect(content, `the label PDF does not draw ${text}`).not.toContain(`(${text}) Tj`);
}

test('a librarian catalogues a record, adds its item and prints their labels; the OPAC shows them', async ({ page, csp, staff, admin }) => {
  const word = randomLetters(6);
  const Word = word.charAt(0).toUpperCase() + word.slice(1);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const title = `Babad ${Word}`;
  const author = `Pujangga, ${Word}`;
  const callNumber = `959.8 ${word.slice(0, 3).toUpperCase()}`;
  const barcode = `E2E-LBL-${tag}`;

  // The librarian: the catalogue everywhere, the items at the default branch only.
  const branches = await staff.call<BranchListResponse>('GET', 'branches');
  const branch = branches.items.find((b) => b.isDefault);
  if (branch === undefined) throw new Error('the install has no default branch');
  // Writing roles and assigning them ask for a password confirmation of the last 5 minutes (§7.3).
  await staff.reauth(admin.password);
  const cataloguing = await staff.call<RoleItem>('POST', 'roles', { name: `Katalogisasi E2E ${tag}`, permissions: ['catalog.records.read', 'catalog.records.manage'] });
  const items = await staff.call<RoleItem>('POST', 'roles', { name: `Eksemplar E2E ${tag}`, permissions: ['catalog.items.manage'] });
  const librarian = await createStaff(staff, 'e2e-pustakawan');
  await staff.call('PUT', `users/${encodeURIComponent(librarian.id)}/roles`, {
    assignments: [
      { roleId: cataloguing.id, branchId: null },
      { roleId: items.id, branchId: branch.id },
    ],
  });

  await clean(csp, 'sign in', async () => {
    await signIn(page, librarian);
  });

  let recordId = '';
  await clean(csp, 'Bibliografi: a new record with a new author, saved', async () => {
    await openNavPage(page, '/admin/catalog/records');
    await expect(page).toHaveURL(/\/admin\/catalog\/records$/);
    await expect(page.getByRole('heading', { level: 1, name: T('catalog.records.list.title'), exact: true })).toBeVisible();
    await page.getByRole('link', { name: T('catalog.records.list.new'), exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/catalog\/records\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: T('catalog.records.new.title'), exact: true })).toBeVisible();

    await page.getByLabel(T('catalog.records.required', { label: T('catalog.records.field.material_type') }), { exact: true }).selectOption({ label: 'Buku' });
    await page.getByLabel(T('catalog.records.required', { label: T('catalog.records.field.title') }), { exact: true }).fill(title);
    await page.getByLabel(T('vocab.field.publication_year'), { exact: true }).fill('2023');
    await page.getByLabel(T('vocab.field.call_number'), { exact: true }).fill(callNumber);

    // The author: typed in the picker, made with "Buat baru", the main entry.
    await page.getByRole('combobox', { name: T('catalog.records.agents.add') }).click();
    await page.getByPlaceholder(T('catalog.records.agents.search'), { exact: true }).fill(author);
    await page.getByRole('option', { name: T('catalog.records.create_new', { name: author }) }).click();
    const main = page.getByRole('checkbox', { name: T('catalog.records.agents.main_label', { name: author }) });
    await main.check();
    await expect(main).toBeChecked();

    await page.getByRole('button', { name: T('form.save'), exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/catalog\/records\/[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(page.getByText(T('catalog.records.created'), { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    recordId = /\/admin\/catalog\/records\/([0-9A-Z]{26})$/.exec(new URL(page.url()).pathname)![1]!;
  });

  await clean(csp, 'Eksemplar tab: quick add of one item at the default branch', async () => {
    await page.getByRole('tab', { name: T('catalog.records.tab.items', { count: 0 }), exact: true }).click();
    await expect(page.getByRole('heading', { name: T('catalog.items.tab.title'), exact: true })).toBeVisible();
    const quick = page.getByRole('form', { name: T('catalog.items.quick.title') });
    await expect(quick.getByLabel(T('catalog.items.filter.branch'), { exact: true })).toHaveValue(branch.id);
    await quick.getByLabel(T('catalog.items.field.barcode'), { exact: true }).fill(barcode);
    // A fresh install names no default collection type: the librarian picks the seeded "Umum".
    await quick.getByLabel(T('catalog.items.field.collection_type'), { exact: true }).selectOption({ label: 'Umum' });
    await quick.getByRole('button', { name: T('catalog.items.quick.add'), exact: true }).click();
    await expect(quick.getByText(T('catalog.items.quick.added', { barcode }), { exact: true })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: barcode });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(T('vocab.item_status.available'));
  });

  await clean(csp, 'Bibliografi list: the search finds the record; its row joins the print queue', async () => {
    await openNavPage(page, '/admin/catalog/records');
    await page.getByLabel(T('catalog.records.list.search_label'), { exact: true }).fill(word);
    await page.getByRole('button', { name: T('catalog.records.list.search_button'), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]q=${word}(&|$)`));
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: title }) });
    await expect(row).toHaveCount(1);
    await row.getByRole('checkbox', { name: T('catalog.records.list.select_row', { title }), exact: true }).check();
    await page.getByRole('button', { name: T('catalog.labels.queue.add'), exact: true }).click();
    const outcome = page.getByRole('status').filter({ hasText: T('catalog.labels.queue.added', { count: 1 }) });
    await expect(outcome).toBeVisible();
    await outcome.getByRole('link', { name: T('catalog.labels.queue.open'), exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/catalog\/labels$/);
    await expect(page.getByRole('heading', { level: 1, name: T('nav.catalog.labels'), exact: true })).toBeVisible();
  });

  await clean(csp, 'Cetak Label: the record\'s labels (spine and barcode), downloaded and read; the printed entry leaves the queue', async () => {
    const queue = page.getByRole('table', { name: T('catalog.labels.queue.title') });
    await expect(queue.getByRole('row').filter({ hasText: title })).toHaveCount(1);
    await page.getByLabel(T('catalog.labels.print.profile'), { exact: true }).selectOption('spine-barcode-a4');
    await page.getByRole('button', { name: T('catalog.labels.print.submit'), exact: true }).click();
    await expect(page.getByText(T('catalog.labels.print.ready'), { exact: true })).toBeVisible();
    // The queued record gave its label: neither the "skipped" nor the "nothing printable" notice.
    await expect(page.getByText(T('catalog.labels.print.none'), { exact: true })).toHaveCount(0);
    await expect(page.getByText(T('catalog.labels.print.skipped', { count: 1 }), { exact: true })).toHaveCount(0);
    const open = page.getByRole('link', { name: T('catalog.labels.print.open'), exact: true });
    await expect(open).toHaveAttribute('href', /^blob:/);
    await expect(open).toHaveAttribute('target', '_blank');
    // A spine-and-barcode label: the call number on the left, the barcode on the right.
    expectLabelPdf(await downloadLabels(page), [barcode, callNumber.split(' ')[0]!]);

    await page.getByRole('button', { name: T('catalog.labels.print.remove_printed'), exact: true }).click();
    await expect(page.getByText(T('catalog.labels.queue.empty'), { exact: true })).toBeVisible();
  });

  await clean(csp, 'Cetak Label: the item added by its barcode, its barcode label downloaded and read', async () => {
    await page.getByLabel(T('catalog.labels.scan.barcode'), { exact: true }).fill(barcode.toLowerCase());
    await page.getByRole('button', { name: T('catalog.labels.scan.submit'), exact: true }).click();
    await expect(page.getByText(T('catalog.labels.scan.added', { label: `${barcode} — ${title}` }), { exact: true })).toBeVisible();
    const queue = page.getByRole('table', { name: T('catalog.labels.queue.title') });
    await expect(queue.getByRole('row').filter({ hasText: barcode })).toHaveCount(1);
    await page.getByLabel(T('catalog.labels.print.profile'), { exact: true }).selectOption('barcode-a4');
    // The first PDF's links stay until the new one replaces them: wait for a new object URL.
    const open = page.getByRole('link', { name: T('catalog.labels.print.open'), exact: true });
    const before = await open.getAttribute('href');
    await page.getByRole('button', { name: T('catalog.labels.print.submit'), exact: true }).click();
    await expect(open).toHaveAttribute('href', /^blob:/);
    await expect(open).not.toHaveAttribute('href', before ?? '');
    await expect(page.getByText(T('catalog.labels.print.ready'), { exact: true })).toBeVisible();
    // A barcode label: the bars and the barcode, the library name and the title, no call number.
    expectLabelPdf(await downloadLabels(page), [barcode, 'Perpustakaan E2E', title], [callNumber.split(' ')[0]!]);
  });

  await clean(csp, 'the OPAC finds the record and shows its item', async () => {
    await page.goto(`/cari?q=${word}`);
    const card = page.locator(`li.card a[href^="/katalog/${recordId}/"]`);
    await expect(card).toHaveCount(1);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/katalog/${recordId}/[a-z0-9-]+$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(page.locator('main ul.record-agents').getByRole('link', { name: author, exact: true })).toHaveAttribute('href', /^\/cari\?pengarang=[0-9A-HJKMNP-TV-Z]{26}$/);
    const row = page.locator('main section[aria-labelledby="ketersediaan"] tbody tr').filter({ hasText: barcode });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(callNumber);
    await expect(row).toContainText(T('vocab.item_status.available'));
  });
});
