import { T, expect, passReauth, signIn, test as base } from '../fixtures.js';
import { readAdminFixture, waitHealthy } from '../lib/server.js';
import { REVERT_STATES, UPDATE_END_STATES, UPDATE_VERSION, opFileState, recordOpsTraffic, updateZip } from '../lib/update.js';
import { createOwnApp, type OwnApp } from '../uninstalled-setup.js';

// The offline update in the browser (spec §9.6 "Unggah offline", decision D1d-31; acceptance A7; plan 1d Task 35): an
// app of its own on 0.1.0-test, with no feed at all. In Pembaruan the admin picks the release zip of 0.2.0-test in
// "Unggah paket pembaruan": the chunked upload (context `update`), then the dry run (`POST updates/upload {dryRun}`,
// after the password: the signature and the prechecks, nothing begun) shows the report; "Pasang versi 0.2.0-test"
// begins the op with the same upload, and `/admin/_update` follows it to `done` and goes back to Beranda. 0.2.0-test then
// serves. Every page runs under the CSP guard of fixtures.ts.

const test = base.extend<{ app: OwnApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a fixture needs from its first parameter.
  app: async ({}, use) => {
    const app = await createOwnApp('update-offline');
    try {
      await app.installHeadless(readAdminFixture());
      await use(app);
    } finally {
      await app.dispose();
    }
  },
  baseURL: async ({ app }, use) => {
    await use(app.baseUrl);
  },
});

test.describe.configure({ timeout: 600_000 });

test('A7 offline: upload, dry run, password, install → done, 0.2.0-test serves', async ({ page, app, admin }) => {
  const zip = await updateZip();
  await app.start();
  const traffic = recordOpsTraffic(page);
  await signIn(page, admin);
  await page.goto('/admin/updates');
  await expect(page.getByRole('heading', { name: T('updates.upload.title'), exact: true })).toBeVisible();

  // Upload and dry run (the server asks for the password before it verifies anything).
  await page.getByLabel(T('updates.upload.file'), { exact: true }).setInputFiles(zip);
  await page.getByRole('button', { name: T('updates.upload.submit'), exact: true }).click();
  const install = page.getByRole('button', { name: T('updates.upload.apply', { version: UPDATE_VERSION }), exact: true });
  await passReauth(page, admin.password, { next: install });
  await expect(install).toBeEnabled({ timeout: 120_000 });
  // The dry run began nothing.
  expect(traffic.polls).toEqual([]);

  // The real call, with the same upload: the op begins and the operations page follows it.
  await install.click();
  await passReauth(page, admin.password, { next: page.locator('#op-state') });
  await expect(page).toHaveURL(/\/admin\/_update$/);
  await expect.poll(() => opFileState(app), { timeout: 300_000, message: 'the update op ends' }).toMatch(new RegExp(`^(${UPDATE_END_STATES.join('|')})$`));
  expect(await opFileState(app), `states seen: ${traffic.states.join(' → ')}`).toBe('done');
  expect(traffic.states.filter((s) => REVERT_STATES.includes(s))).toEqual([]);
  await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 30_000 });
  expect((await waitHealthy(app.localUrl, { timeoutMs: 60_000 })).version).toBe(UPDATE_VERSION);
});
