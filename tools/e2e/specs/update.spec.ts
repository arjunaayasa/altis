import type { Page } from '@playwright/test';
import { T, expect, passReauth, signIn, test as base } from '../fixtures.js';
import { StaffApi } from '../lib/api.js';
import { readAdminFixture, waitHealthy, type AdminFixture } from '../lib/server.js';
import { REVERT_STATES, UPDATE_END_STATES, UPDATE_VERSION, opFileState, recordOpsTraffic, serveFeed, updateZip, type OpsTraffic } from '../lib/update.js';
import { createOwnApp, type OwnApp } from '../uninstalled-setup.js';

// The one-click update in the browser (spec §9.6, §9.3, §10.2; acceptance A7, A9; plan 1d Task 35, preflight 1D-27):
// Pembaruan → "Periksa pembaruan" → "Perbarui ke 0.2.0-test" → the password → `/admin/_update`, which follows the op to
// `done` and goes back to Beranda; 0.2.0-test then serves. Each test brings an app of its own (uninstalled-setup.ts),
// installed headless on 0.1.0-test and pointed at a feed of 0.2.0-test signed with the dev keys (lib/update.ts).
//
// The progress is followed in the two phases of an update, by polling, and again with SSE on:
// 1. the server's page: the release that began the op serves `/admin/_update` (`X-Altis-Serving: server`);
// 2. app.js's page: while the pending release holds releases/boot.lock and migrates (held 30 s by the test fault
//    `migrate-slow`, Task 9), a second app.js process on the same DATA_DIR, as Passenger spawns one, serves only the
//    minimal pages of §9.2 step 6: the page there polls `ops/current` (`X-Altis-Serving: app`) and `GET events/stream`
//    answers 503 (polling only). The browser opens the page on that process with the same `altis_ops` cookie (cookies
//    do not depend on the port); the second process is ended before the pending release is done, so it never opens the
//    SQLite database beside the first one (P20);
// 3. the server's page again: polled, and once release N serves, loaded from it: with SSE on, its EventSource on
//    `events/stream` is answered 200 (the op has ended by then or ends meanwhile; the page shows it, then Beranda).
//
// Polling: SSE off (`PUT diagnostics/realtime`) and no worker (ALTIS_RUNNER=off: the `external` mode of a cPanel host),
// so the page itself drives the op with `POST ops/drive`, as on Passenger without cron (A7, Review Focus 4). SSE: the
// worker runs the op and the pages follow it, the server's over SSE. Every page runs under the CSP guard of fixtures.ts.

/** The cumulative hold of the pending release's migration (Task 9's `migrate-slow`, reported every 5 s). */
const SLOW_MIGRATION = 'migrate-slow:30';

let made = 0;

const test = base.extend<{ app: OwnApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a fixture needs from its first parameter.
  app: async ({}, use) => {
    made += 1;
    const app = await createOwnApp(`update-${made}`);
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

/** `PUT diagnostics/realtime {sse}` as the super admin (the app must run). */
async function setSse(app: OwnApp, request: Parameters<typeof StaffApi.open>[0], admin: AdminFixture, sse: boolean): Promise<void> {
  const api = await StaffApi.open(request, app.localUrl);
  try {
    await api.signIn(admin.username, admin.password);
    await api.call('PUT', 'diagnostics/realtime', { sse });
  } finally {
    await api.dispose();
  }
}

/** Pembaruan → check → "Perbarui ke <N>" → the password: the browser is on `/admin/_update`. */
async function applyFromPembaruan(page: Page, admin: AdminFixture): Promise<void> {
  await signIn(page, admin);
  await page.goto('/admin/updates');
  await expect(page.getByRole('heading', { level: 1, name: T('nav.updates'), exact: true })).toBeVisible();
  await page.getByRole('button', { name: T('updates.check.action'), exact: true }).click();
  const apply = page.getByRole('button', { name: T('updates.apply', { version: UPDATE_VERSION }), exact: true });
  await expect(apply).toBeEnabled({ timeout: 60_000 });
  await apply.click();
  await passReauth(page, admin.password, { next: page.locator('#op-state') });
  await expect(page).toHaveURL(/\/admin\/_update$/);
}

/** Waits until the pages have seen the op in one of `states`. */
async function waitForState(traffic: OpsTraffic, states: readonly string[], timeout = 300_000): Promise<void> {
  await expect.poll(() => traffic.states.some((s) => states.includes(s)), { timeout, message: `the op reaches ${states.join(' or ')} (seen: ${traffic.states.join(' → ')})` }).toBe(true);
}

/**
 * Phase 2 (see the top of this file): while the pending release migrates, `/admin/_update` of a second app.js, which
 * answers by itself (`X-Altis-Serving: app`), polls only; `GET events/stream` answers 503 there. Then that process is
 * ended and the page goes back to the first one.
 */
async function followOnSecondAppJs(page: Page, app: OwnApp, traffic: OpsTraffic): Promise<void> {
  await waitForState(traffic, ['migrating']);
  const second = await app.spawnSecond();
  try {
    const from = traffic.polls.length;
    const answer = await page.goto(`${second.localUrl}/admin/_update`);
    expect(answer?.status(), 'app.js serves /admin/_update while another process boots the pending release').toBe(200);
    expect(answer?.headers()['x-altis-serving']).toBe('app');
    await expect.poll(() => traffic.polls.slice(from).filter((p) => p.status === 200 && p.serving === 'app').length, { message: 'app.js page polls ops/current' }).toBeGreaterThanOrEqual(2);
    const events = await page.request.get(`${second.localUrl}/api/v1/events/stream?channels=system.update`, { failOnStatusCode: false });
    expect(events.status(), 'GET events/stream on app.js (polling only in this phase)').toBe(503);
    expect(traffic.states.filter((s) => REVERT_STATES.includes(s))).toEqual([]);
  } finally {
    await second.kill();
  }
  await page.goto(`${app.baseUrl}/admin/_update`);
}

/** The op ended `done` (op.json), the page went back to Beranda, release N serves; no revert on the way. */
async function expectUpdated(page: Page, app: OwnApp, traffic: OpsTraffic): Promise<void> {
  await expect.poll(() => opFileState(app), { timeout: 300_000, message: 'the update op ends' }).toMatch(new RegExp(`^(${UPDATE_END_STATES.join('|')})$`));
  expect(await opFileState(app), `states seen: ${traffic.states.join(' → ')}`).toBe('done');
  expect(traffic.states.filter((s) => REVERT_STATES.includes(s)), `states: ${traffic.states.join(' → ')}`).toEqual([]);
  await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 30_000 });
  expect((await waitHealthy(app.localUrl, { timeoutMs: 60_000 })).version).toBe(UPDATE_VERSION);
}

test('A9 polling: no worker and SSE off, /admin/_update drives the op and polls, on the server and on app.js, to done', async ({ page, app, admin, playwright }) => {
  const feed = await serveFeed(app, [await updateZip()]);
  try {
    await app.start({ env: { ALTIS_RUNNER: 'off', ALTIS_TEST_FAULT: SLOW_MIGRATION } });
    await setSse(app, playwright.request, admin, false);
    const traffic = recordOpsTraffic(page);
    await applyFromPembaruan(page, admin);
    await followOnSecondAppJs(page, app, traffic);
    await expectUpdated(page, app, traffic);
    expect(traffic.drives, 'the page drove the op (external mode)').toBeGreaterThan(0);
    const serving = new Set(traffic.polls.filter((p) => p.status === 200).map((p) => p.serving));
    expect([...serving].sort()).toEqual(['app', 'server']);
    expect(traffic.streams, 'no SSE stream while SSE is off').toEqual([]);
  } finally {
    await feed.close();
  }
});

test('A9 SSE: the server pages follow the op over SSE, app.js polls (events 503), to done', async ({ page, app, admin, playwright }) => {
  const feed = await serveFeed(app, [await updateZip()]);
  try {
    await app.start({ env: { ALTIS_TEST_FAULT: SLOW_MIGRATION } });
    await setSse(app, playwright.request, admin, true);
    const traffic = recordOpsTraffic(page);
    await applyFromPembaruan(page, admin);
    // Phase 1: the page of the release that began the op opened its stream.
    await expect.poll(() => traffic.streams.filter((s) => s.status === 200 && s.serving !== 'app').length, { message: 'the server page opened events/stream' }).toBeGreaterThan(0);
    const before = traffic.streams.length;
    await followOnSecondAppJs(page, app, traffic);
    // Phase 3: once release N serves, its page opens the stream, answered 200 by the server.
    expect((await waitHealthy(app.localUrl, { timeoutMs: 180_000 })).version).toBe(UPDATE_VERSION);
    await page.goto('/admin/_update');
    await expect.poll(() => traffic.streams.slice(before).some((s) => s.status === 200 && s.serving !== 'app'), { message: "release N's page opened events/stream" }).toBe(true);
    await expectUpdated(page, app, traffic);
    expect(traffic.drives, 'the worker ran the op: the page never drove it').toBe(0);
  } finally {
    await feed.close();
  }
});
