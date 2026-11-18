import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { BranchListResponse } from '@altis/shared/api/branches';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { CspRecorder } from '../lib/csp.js';
import { T, expect, passReauth, signIn, test } from '../fixtures.js';
import { openNavPage } from '../lib/nav.js';

// A stocktake (inventarisasi) of one collection, as a librarian runs it, in a real browser with the CSP guard of
// fixtures.ts on every page:
//
//   in Layanan → Inventarisasi a new session is started over one collection type (made for this run, so the session
//   covers this run's three copies only and leaves the rest of the shared install alone); once it is under way, two
//   copies are scanned (found) and one code no copy has (unknown); finishing asks for the session's name (and the
//   password) and finishes it (the copy not scanned is marked missing, the default); the minutes (berita acara) are
//   downloaded and read: a PDF that names the session and its scope.
//
// The record, the collection type and the copies are made through the API (`staff`, the fixture super admin). The
// screens' words come from the admin catalogues (lib/text.ts).

/** Random lower-case letters: one search token that no other spec writes. */
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

test('Inventarisasi: a session over one collection is scanned, finished and its minutes downloaded', async ({ page, csp, staff, admin }) => {
  test.setTimeout(5 * 60_000);
  const word = randomLetters(6);
  const Word = word.charAt(0).toUpperCase() + word.slice(1);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const sessionName = `Opname ${Word}`;
  const typeCode = `INV${tag}`;
  const typeName = `Koleksi Opname ${Word}`;
  const barcodes = [`E2E-INV-${tag}-1`, `E2E-INV-${tag}-2`, `E2E-INV-${tag}-3`];
  const unknown = `E2E-INV-${tag}-X`;

  const branches = await staff.call<BranchListResponse>('GET', 'branches');
  const branch = branches.items.find((b) => b.isDefault);
  if (branch === undefined) throw new Error('the install has no default branch');
  const materials = await staff.call<{ items: { id: string; code: string }[] }>('GET', 'catalog/material-types');
  const buku = materials.items.find((m) => m.code === 'BUKU');
  if (buku === undefined) throw new Error('the seeded material type BUKU is missing');
  const type = await staff.call<StoreResponse>('POST', 'catalog/collection-types', { code: typeCode, nameId: typeName, nameEn: `Stocktake ${Word}`, loanable: true, selfService: false, sortOrder: 900 });
  const record = await staff.call<StoreResponse>('POST', 'catalog/records', { materialTypeId: buku.id, title: `Kamus Opname ${Word}` });
  for (const barcode of barcodes) {
    await staff.call('POST', `branches/${encodeURIComponent(branch.id)}/items`, { recordId: record.id, barcode, collectionTypeId: type.id });
  }

  await clean(csp, 'sign in', async () => {
    await signIn(page, admin);
  });

  await clean(csp, 'Inventarisasi: a new session over the collection type, under way', async () => {
    await openNavPage(page, '/admin/layanan/inventarisasi');
    await expect(page).toHaveURL(/\/admin\/layanan\/inventarisasi$/);
    await expect(page.getByRole('heading', { level: 1, name: T('stocktake.ui.title'), exact: true })).toBeVisible();
    const form = page.getByRole('form', { name: T('stocktake.ui.new.title') });
    await form.getByLabel(T('stocktake.ui.new.name'), { exact: true }).fill(sessionName);
    await form.getByLabel(T('stocktake.ui.new.collection_types'), { exact: true }).selectOption({ label: `${typeName} (${typeCode})` });
    await form.getByRole('button', { name: T('stocktake.ui.new.submit'), exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/layanan\/inventarisasi\/[0-9A-HJKMNP-TV-Z]{26}\/[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(page.getByRole('heading', { level: 1, name: sessionName, exact: true })).toBeVisible();
    // The session is prepared by a job, then under way: the scan box shows.
    await expect(page.getByText(T('vocab.stocktake_status.active'), { exact: true }).first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByLabel(T('stocktake.ui.scan.label'), { exact: true })).toBeVisible();
  });

  await clean(csp, 'scanning: two copies found, one code unknown', async () => {
    const box = page.getByLabel(T('stocktake.ui.scan.label'), { exact: true });
    const outcome = page.locator('[role="status"][data-outcome]');
    const scan = async (code: string, result: 'found' | 'unknown'): Promise<void> => {
      await box.fill(code);
      await page.getByRole('button', { name: T('stocktake.ui.scan.submit'), exact: true }).click();
      await expect(outcome).toHaveAttribute('data-outcome', result);
      await expect(outcome).toContainText(`${T(`vocab.stocktake_scan.${result}`)} · ${code}`);
    };
    await scan(barcodes[0]!, 'found');
    await scan(barcodes[1]!.toLowerCase(), 'found');
    await scan(unknown, 'unknown');
    const recent = page.getByRole('list').filter({ hasText: unknown });
    await expect(recent.getByRole('listitem')).toHaveCount(3);
  });

  await clean(csp, '"Selesaikan…": the name typed, the session finished', async () => {
    await page.getByRole('button', { name: T('stocktake.ui.finish.open'), exact: true }).click();
    const panel = page.getByRole('form', { name: T('stocktake.ui.finish.title') });
    await expect(panel).toBeVisible();
    await panel.getByLabel(T('stocktake.ui.finish.type_name', { name: sessionName }), { exact: true }).fill(sessionName);
    await panel.getByRole('button', { name: T('stocktake.ui.finish.submit'), exact: true }).click();
    // Finishing changes the copies' status: the server asks for the password first.
    const finished = page.getByText(T('vocab.stocktake_status.finished'), { exact: true }).first();
    await passReauth(page, admin.password, { next: finished });
    await expect(finished).toBeVisible({ timeout: 120_000 });
    await expect(panel).toBeHidden();
    // A finished session takes no more scans.
    await expect(page.getByLabel(T('stocktake.ui.scan.label'), { exact: true })).toHaveCount(0);
  });

  await clean(csp, 'the minutes: a PDF that names the session and its scope', async () => {
    const link = page.getByRole('link', { name: T('stocktake.ui.minutes'), exact: true });
    await expect(link).toHaveAttribute('target', '_blank');
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/api\/v1\/branches\/[0-9A-HJKMNP-TV-Z]{26}\/stocktakes\/[0-9A-HJKMNP-TV-Z]{26}\/minutes$/);
    // What the new tab opens, read with the page's own session.
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^application\/pdf/);
    const pdf = await res.body();
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/%%EOF\s*$/);
    const content = pdfContent(pdf);
    expect(content, 'the title').toContain(`(${T('stocktake.minutes.title')}) Tj`);
    expect(content, 'the session').toContain(`(${sessionName}) Tj`);
    expect(content, 'the scope').toContain(typeName);
  });
});
