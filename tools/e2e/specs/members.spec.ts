import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import type { CspRecorder } from '../lib/csp.js';
import { T, expect, signIn, submitFilter, test } from '../fixtures.js';
import { openNavPage } from '../lib/nav.js';

// The member list as a librarian keeps it, in a real browser with the CSP guard of fixtures.ts on every page:
//
//   in Anggota → Daftar Anggota, "Tambah anggota" opens the form; one member is filled in (number, type, name, e-mail)
//   and saved, and the list's search finds it; then Anggota → Impor takes a small CSV of three members in the ALTIS
//   format (separator `;`), maps its columns from the header, runs the dry run (three to create, none refused) and the
//   import, and "Lihat anggota" shows the imported members in the list.
//
// The fixture super admin holds every permission it needs. Every name and number carries a word made for this run, so
// the list's search finds this run's members only. The screens' words come from the admin catalogues (lib/text.ts).

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

/** The value of the figure `label` in the figures list named `list` (a StatStrip). */
function figure(page: Page, list: string, label: string): Locator {
  return page.getByLabel(list, { exact: true }).locator('div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
}

/** Types `text` into the member list's search and submits it. */
async function searchMembers(page: Page, text: string): Promise<void> {
  const search = page.getByLabel(T('members.filter.search'), { exact: true });
  await search.fill(text);
  await submitFilter(search);
}

test('Anggota: a member added through the form and three imported from a CSV show in the list', async ({ page, csp, admin }) => {
  test.setTimeout(5 * 60_000);
  const word = randomLetters(6);
  const Word = word.charAt(0).toUpperCase() + word.slice(1);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const added = { no: `E2E-${tag}-01`, name: `Ratna ${Word}`, email: `anggota-${word}@perpus.example` };
  const imported = [
    { no: `E2E-${tag}-11`, name: `Bagas ${Word}`, className: 'X-A' },
    { no: `E2E-${tag}-12`, name: `Citra ${Word}`, className: 'X-B' },
    { no: `E2E-${tag}-13`, name: `Dimas ${Word}`, className: 'XI-A' },
  ];

  await clean(csp, 'sign in', async () => {
    await signIn(page, admin);
  });

  await clean(csp, 'Daftar Anggota: "Tambah anggota" opens the form; the member is saved', async () => {
    await openNavPage(page, '/admin/anggota');
    await expect(page).toHaveURL(/\/admin\/anggota$/);
    await expect(page.getByRole('heading', { level: 1, name: T('members.title'), exact: true })).toBeVisible();
    await page.getByRole('link', { name: T('members.add'), exact: true }).first().click();
    await expect(page).toHaveURL(/\/admin\/anggota\/baru$/);
    await expect(page.getByRole('heading', { level: 1, name: T('members.new.title'), exact: true })).toBeVisible();

    await page.getByLabel(T('members.field.member_no'), { exact: true }).fill(added.no);
    // The few seeded types are radio buttons, each named by the type and what it allows.
    await page.getByRole('group', { name: T('members.field.type'), exact: true }).getByRole('radio', { name: /^Umum/ }).check();
    await page.getByLabel(T('members.field.name'), { exact: true }).fill(added.name);
    await page.getByLabel(T('members.field.email'), { exact: true }).fill(added.email);
    await page.getByRole('button', { name: T('form.save'), exact: true }).click();

    await expect(page).toHaveURL(/\/admin\/anggota\/[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(page.getByText(T('members.created'), { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: added.name, exact: true })).toBeVisible();
  });

  await clean(csp, 'Daftar Anggota: the search finds the new member', async () => {
    await openNavPage(page, '/admin/anggota');
    await searchMembers(page, added.no);
    const table = page.getByRole('table', { name: T('members.caption') });
    const row = table.getByRole('row').filter({ has: page.getByRole('link', { name: added.name, exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(added.no);
    await expect(row).toContainText(T('vocab.member_status.active'));
  });

  await clean(csp, 'Impor: the CSV is read, mapped from its header and dry-run', async () => {
    await openNavPage(page, '/admin/anggota/impor');
    await expect(page).toHaveURL(/\/admin\/anggota\/impor$/);
    await expect(page.getByRole('heading', { level: 1, name: T('nav.members.import'), exact: true })).toBeVisible();
    const csv = ['member_no;name;member_type;class_name', ...imported.map((m) => `${m.no};${m.name};SISWA;${m.className}`)].join('\r\n') + '\r\n';
    await page.locator('input[type="file"]').setInputFiles({ name: `anggota-${word}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });

    // Pemetaan & pratinjau: the header's names feed the fields; nothing is unmapped.
    await expect(page.getByRole('heading', { level: 2, name: T('members.import.step.mapping'), exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: T('members.import.mapping_caption') })).toBeVisible();
    await page.getByRole('button', { name: T('members.import.dry_run'), exact: true }).click();

    // Uji kering: three to create, none refused.
    await expect(page.getByRole('heading', { level: 2, name: T('members.import.step.dry_run'), exact: true })).toBeVisible();
    await expect(figure(page, T('members.import.counts'), T('members.import.count.will_create'))).toHaveText('3', { timeout: 60_000 });
    await expect(figure(page, T('members.import.counts'), T('members.import.count.refused'))).toHaveText('0');
  });

  await clean(csp, 'Impor: the import runs; three members are made', async () => {
    await page.getByRole('button', { name: T('members.import.run'), exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: T('members.import.done_title'), exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(figure(page, T('members.import.counts'), T('members.import.count.created'))).toHaveText('3');
    await expect(figure(page, T('members.import.counts'), T('members.import.count.refused'))).toHaveText('0');
    await page.getByRole('link', { name: T('members.import.view_members'), exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/anggota$/);
  });

  await clean(csp, 'Daftar Anggota: the imported members are listed', async () => {
    await searchMembers(page, word);
    const table = page.getByRole('table', { name: T('members.caption') });
    for (const m of imported) {
      const row = table.getByRole('row').filter({ has: page.getByRole('link', { name: m.name, exact: true }) });
      await expect(row, m.name).toHaveCount(1);
      await expect(row).toContainText(m.no);
      await expect(row).toContainText(m.className);
    }
    // The one added through the form matches the word too.
    await expect(table.getByRole('row').filter({ has: page.getByRole('link', { name: added.name, exact: true }) })).toHaveCount(1);
  });
});
