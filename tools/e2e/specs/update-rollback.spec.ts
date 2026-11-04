import { T, expect, passReauth, signIn, test as base } from '../fixtures.js';
import { readAdminFixture, waitHealthy } from '../lib/server.js';
import { UPDATE_VERSION, opFile, recordOpsTraffic, serveFeed, updateZip } from '../lib/update.js';
import { createOwnApp, type OwnApp } from '../uninstalled-setup.js';

// The automatic revert in the browser (spec §9.7, §9.3; acceptance A7 "kegagalan paksa → kembali otomatis"; plan 1d
// Task 35): an app of its own on 0.1.0-test, pointed at a feed of 0.2.0-test, runs with the test fault
// `health:0.2.0-test` (Task 25: release 0.2.0-test's internal health check fails, version-scoped, D1d-25). The admin
// updates from Pembaruan as usual; past the point of no return the pending release fails its health check, so
// `/admin/_update` shows the op ending `rolled_back` (UPDATE_BOOT_FAILED; 0.2.0-test brings an expand migration only,
// so the pointer goes back without a restore) with the error; 0.1.0-test serves again, out of maintenance, and the
// page offers the way back to the admin. Every page runs under the CSP guard of fixtures.ts.

const test = base.extend<{ app: OwnApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a fixture needs from its first parameter.
  app: async ({}, use) => {
    const app = await createOwnApp('update-rollback');
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

test('A7: a forced health failure of 0.2.0-test → the page shows the revert, and 0.1.0-test serves', async ({ page, app, admin }) => {
  const feed = await serveFeed(app, [await updateZip()]);
  try {
    await app.start({ env: { ALTIS_TEST_FAULT: `health:${UPDATE_VERSION}` } });
    const traffic = recordOpsTraffic(page);
    await signIn(page, admin);
    await page.goto('/admin/updates');
    await page.getByRole('button', { name: T('updates.check.action'), exact: true }).click();
    const apply = page.getByRole('button', { name: T('updates.apply', { version: UPDATE_VERSION }), exact: true });
    await expect(apply).toBeEnabled({ timeout: 60_000 });
    await apply.click();
    await passReauth(page, admin.password, { next: page.locator('#op-state') });
    await expect(page).toHaveURL(/\/admin\/_update$/);

    // The page follows the op through the revert to its end, and says so.
    await expect(page.locator('#op-state')).toHaveText(T('ops.state.rolled_back'), { timeout: 300_000 });
    // The pending release failed its boot (past the point of no return; the switch and the revert may each pass
    // between two polls of the page), and the op ended reverted.
    const states = `states: ${traffic.states.join(' → ')}`;
    expect(await opFile(app), states).toEqual({ state: 'rolled_back', error: 'UPDATE_BOOT_FAILED' });
    expect(traffic.states.at(-1), states).toBe('rolled_back');
    expect(traffic.states).not.toContain('done');
    await expect(page.locator('#op-error')).toBeVisible();
    await expect(page.locator('#back')).toBeVisible();
    await expect(page.locator('#done')).toBeHidden();

    // 0.1.0-test serves again, out of maintenance: the admin opens, and Pembaruan names the running version.
    expect((await waitHealthy(app.localUrl, { timeoutMs: 60_000 })).version).toBe('0.1.0-test');
    await page.locator('#back').click();
    await expect(page).toHaveURL(/\/admin\/?$/);
    // Right after the revert the process may still answer 503 for a moment (MAINTENANCE while it ends the op).
    await expect.poll(async () => (await page.goto('/admin/updates'))?.status(), { timeout: 60_000 }).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: T('nav.updates'), exact: true })).toBeVisible();
    await expect(page.getByText('0.1.0-test', { exact: true }).first()).toBeVisible();
  } finally {
    await feed.close();
  }
});
