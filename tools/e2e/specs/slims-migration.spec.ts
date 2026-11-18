import type { BranchListResponse } from '@altis/shared/api/branches';
import type { SlimsCutoverView } from '@altis/shared/api/catalog/migration';
import type { RoleItem } from '@altis/shared/api/roles';
import type { StationCodeResponse } from '@altis/shared/api/visits';
import { SLIMS_FIXTURE_SEED, slimsFixtureBytes } from '../../../packages/core/test/support/slims-fixture/index.js';
import { createStaff } from '../lib/api.js';
import type { CspRecorder } from '../lib/csp.js';
import type { TextKey } from '../lib/text.js';
import { readAdminFixture } from '../lib/server.js';
import { createOwnApp, type OwnApp } from '../uninstalled-setup.js';
import { T, expect, passReauth, signIn, test as base } from '../fixtures.js';
import { openNavPage } from '../lib/nav.js';

// The move from SLiMS (Katalog → Migrasi SLiMS) up to the cut-over, as a library's admin does it, in a real browser
// with the CSP guard of fixtures.ts on every page:
//
//   Sumber takes the synthetic SLiMS dump and its files zip (packages/core/test/support/slims-fixture, written by hand
//   from the schema description); Opsi starts the dry run (after the password), which ends with its report; the real
//   run is started from it and ends with the migration report and "Cocokkan dengan SLiMS"; the cut-over checklist
//   ("Pindah dari SLiMS") holds "Mulai melayani" back until the library has a desk staff member who can sign in, an
//   activated guestbook station and the reprint list opened ("Buka daftar"); then "Mulai melayani", asked first, marks
//   the library as serving in ALTIS.
//
// The staff member (a role that lends at the desk) and the station are made through the API (`staff`), the station
// activated on a device of its own: those screens have their own specs (visits.spec.ts).
//
// An app of its own: the migration brings a whole library in (its records, copies, members, loans and visits), and
// "Mulai melayani" cannot be taken back; the specs after this one keep the shared install as they knew it. The app is
// the suite's release, installed headless with the fixture admin and started on a port of its own.

const test = base.extend<{ app: OwnApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a fixture needs from its first parameter.
  app: async ({}, use) => {
    const app = await createOwnApp('slims-migration');
    try {
      await app.installHeadless(readAdminFixture());
      await app.start();
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  baseURL: async ({ app }, use) => {
    await use(app.baseUrl);
  },
});

/** A run (its jobs, slice by slice) may take this long. */
const RUN_TIMEOUT_MS = 6 * 60_000;

/** Runs `fn` as a reported step and requires that it caused no CSP problem (the fixture checks the test again). */
async function clean(csp: CspRecorder, name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    const mark = csp.mark();
    await fn();
    expect(csp.problems(mark), `CSP problems during "${name}"`).toEqual([]);
  });
}

test.describe.configure({ timeout: 20 * 60_000 });

test('Migrasi SLiMS: the dump and its files, the dry run, the real run, the checklist, "Mulai melayani"', async ({ page, csp, staff, admin, newContext }) => {
  const { dump, filesZip } = slimsFixtureBytes(SLIMS_FIXTURE_SEED);

  await clean(csp, 'sign in', async () => {
    await signIn(page, admin);
  });

  await clean(csp, 'Sumber: the dump and the files zip', async () => {
    await openNavPage(page, '/admin/catalog/migration');
    await expect(page).toHaveURL(/\/admin\/catalog\/migration$/);
    await expect(page.getByRole('heading', { level: 1, name: T('nav.catalog.migration'), exact: true })).toBeVisible();
    await page.getByLabel(T('catalog.migration.source.kind_dump'), { exact: true }).check();
    await page.getByLabel(T('catalog.migration.dump.file'), { exact: true }).setInputFiles({ name: 'slims-dump.sql', mimeType: 'application/sql', buffer: dump });
    await page.getByLabel(T('catalog.migration.files.file'), { exact: true }).setInputFiles({ name: 'slims-files.zip', mimeType: 'application/zip', buffer: filesZip });
    await page.getByRole('button', { name: T('catalog.migration.next'), exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: T('catalog.migration.options.title'), exact: true })).toBeVisible();
  });

  await clean(csp, 'Opsi: the dry run is started and ends', async () => {
    await page.getByRole('button', { name: T('catalog.migration.start_dry'), exact: true }).click();
    const dry = page.getByRole('heading', { level: 2, name: T('catalog.migration.kind.dry'), exact: true });
    await passReauth(page, admin.password, { next: dry });
    await expect(page).toHaveURL(/[?&]run=[0-9A-HJKMNP-TV-Z]{26}/, { timeout: 120_000 });
    await expect(page.getByText(T('vocab.run_status.succeeded'), { exact: true }).first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  });

  await clean(csp, 'the real run from the dry run', async () => {
    await page.getByRole('button', { name: T('catalog.migration.real.submit'), exact: true }).click();
    const real = page.getByRole('heading', { level: 2, name: T('catalog.migration.kind.real'), exact: true });
    await passReauth(page, admin.password, { next: real });
    await expect(real).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(T('vocab.run_status.succeeded'), { exact: true }).first()).toBeVisible({ timeout: RUN_TIMEOUT_MS });
    // The report of the real run holds "Cocokkan dengan SLiMS": each number of SLiMS against ALTIS.
    await expect(page.getByRole('heading', { level: 2, name: T('catalog.migration.report.title_real'), exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: T('catalog.migration.people.matches'), exact: true })).toBeVisible();
  });

  const checklist = page.getByRole('region', { name: T('catalog.migration.people.cutover_title'), exact: true });
  const item = (key: TextKey, params: Readonly<Record<string, string>> = {}) => checklist.getByRole('listitem').filter({ hasText: T(key, params).slice(0, 40) });
  const serve = checklist.getByRole('button', { name: T('catalog.migration.people.serve'), exact: true });

  await clean(csp, 'Pindah dari SLiMS: the checklist holds "Mulai melayani" back', async () => {
    // The checklist is on the wizard's own page, under a new migration. The screen read it before the runs, a moment
    // ago (a real library's runs take long enough for it to be read again): the page is loaded afresh.
    await page.getByRole('button', { name: T('catalog.migration.run.new'), exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/catalog\/migration$/);
    await page.reload();
    await expect(checklist).toBeVisible();
    await expect(item('catalog.migration.people.check_reconciled')).toHaveAttribute('data-done', 'yes');
    await expect(item('catalog.migration.people.check_staff')).toHaveAttribute('data-done', 'no');
    await expect(item('catalog.migration.people.check_stations')).toHaveAttribute('data-done', 'no');
    await expect(item('catalog.migration.people.check_reprint')).toHaveAttribute('data-done', 'no');
    await expect(serve).toBeDisabled();
    await expect(checklist.getByText(T('catalog.migration.people.serve_held'), { exact: true })).toBeVisible();
  });

  // What the library does outside the wizard (its own screens, covered by their own specs): one desk staff member with
  // a password and a role that lends at the desk, and a guestbook station activated on its device.
  const branches = await staff.call<BranchListResponse>('GET', 'branches');
  const branch = branches.items.find((b) => b.isDefault);
  if (branch === undefined) throw new Error('the app has no default branch');
  await staff.reauth(admin.password);
  const role = await staff.call<RoleItem>('POST', 'roles', { name: 'Petugas meja', permissions: ['circulation.desk.use'] });
  const desk = await createStaff(staff, 'e2e-meja');
  await staff.call('PUT', `users/${encodeURIComponent(desk.id)}/roles`, { assignments: [{ roleId: role.id, branchId: null }] });
  const station = await staff.call<StationCodeResponse>('POST', `branches/${encodeURIComponent(branch.id)}/visits/stations`, { name: 'Pintu masuk' });
  const device = await (await newContext()).newPage();
  await device.goto('/kunjungan/aktifkan');
  await device.locator('input[name="code"]').fill(station.code);
  await device.locator('form[action^="/kunjungan/aktifkan"] button[type="submit"]').click();
  await expect(device).toHaveURL(/\/kunjungan$/);

  await clean(csp, '"Buka daftar": the reprint list opens from the checklist', async () => {
    await page.reload();
    await expect(item('catalog.migration.people.check_staff')).toHaveAttribute('data-done', 'yes');
    await expect(item('catalog.migration.people.check_stations')).toHaveAttribute('data-done', 'yes');
    await item('catalog.migration.people.check_reprint').getByRole('button', { name: T('catalog.migration.people.open_reprint'), exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/reports\/members\.reprint_list$/);
    await expect(page.getByRole('heading', { level: 1, name: T('report.members.reprint_list.title'), exact: true })).toBeVisible();
  });

  await clean(csp, '"Mulai melayani": asked first, then the library serves in ALTIS', async () => {
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/catalog\/migration/);
    await expect(item('catalog.migration.people.check_reprint')).toHaveAttribute('data-done', 'yes');
    await expect(serve).toBeEnabled();
    await serve.click();
    const dialog = page.getByRole('alertdialog', { name: T('catalog.migration.people.serve_confirm_title') });
    await dialog.getByRole('button', { name: T('catalog.migration.people.serve'), exact: true }).click();
    const serving = checklist.getByText(new RegExp(`^${T('catalog.migration.people.serving', { since: '' }).trim().replace(/\.$/, '')}`));
    await passReauth(page, admin.password, { next: serving });
    await expect(serving).toBeVisible();
    await expect(serve).toHaveCount(0);
  });

  const view = await staff.call<SlimsCutoverView>('GET', 'catalog/migrations/slims/cutover');
  expect(view.ready).toBe(true);
  expect(view.servingSince).not.toBeNull();
});
