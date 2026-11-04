import type { Page } from '@playwright/test';
import type { JobView } from '@altis/shared/api/jobs';
import type { RealtimeResponse } from '@altis/shared/api/diagnostics';
import { T, expect, signIn, test as base } from '../fixtures.js';
import type { StaffApi } from '../lib/api.js';
import { readAdminFixture } from '../lib/server.js';
import { createOwnApp, type OwnApp } from '../uninstalled-setup.js';

// Realtime progress in the browser (spec §10.6-10.8, §13.3; plan 1c Task 34): a job's page follows the job while it
// moves, without a reload, once over SSE (`GET events/stream`) and once by polling (`GET events`), as
// `PUT diagnostics/realtime` sets the transport.
//
// The job must move only when the spec says so, so this spec brings an app of its own (uninstalled-setup.ts): installed
// headless with the fixture admin and started with ALTIS_RUNNER=off, the `external` runner mode of a host without a
// worker. One `POST /_cron` right after the start records a cron run: piggyback (which would move the job after any
// page view) stays off for 10 minutes (§10.2), and nothing else runs the job. The spec moves it one slice at a time
// with `POST jobs/:id/drive` from the API (the job's page offers no automatic drive), a `test.slices` job of three
// slices (`test.jobs.enqueue`, test release only): 33 %, 66 %, then `succeeded`. Every page runs under the CSP guard.

const test = base.extend<object, { realtimeApp: OwnApp }>({
  realtimeApp: [
    async ({ playwright }, use) => {
      const app = await createOwnApp('realtime');
      try {
        await app.installHeadless(readAdminFixture());
        await app.start({ env: { ALTIS_RUNNER: 'off' } });
        const cron = await playwright.request.newContext({ baseURL: app.baseUrl });
        try {
          const answer = await cron.post('/_cron', { headers: { authorization: `Bearer ${await app.cronToken()}` } });
          expect(answer.status(), 'POST /_cron').toBe(200);
        } finally {
          await cron.dispose();
        }
        await use(app);
      } finally {
        await app.dispose();
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  baseURL: async ({ realtimeApp }, use) => {
    await use(realtimeApp.baseUrl);
  },
});

/** The events requests of `page`: SSE streams and polls, by URL. */
function eventsRequests(page: Page): { streams: string[]; polls: string[] } {
  const seen = { streams: [] as string[], polls: [] as string[] };
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname === '/api/v1/events/stream') seen.streams.push(decodeURIComponent(url.search));
    else if (url.pathname === '/api/v1/events') seen.polls.push(decodeURIComponent(url.search));
  });
  return seen;
}

/** A `test.slices` job of three slices, queued by the admin (the page's creator), not run by anything. */
async function queueJob(staff: StaffApi): Promise<string> {
  return (await staff.call<{ id: string }>('POST', '_test/jobs', { type: 'test.slices', payload: { slices: 3, k: 1 } })).id;
}

/** The document's own mark: still there at the end, the page was never loaded again. */
const MARK = '__altisNoReload';

/**
 * The job page of `jobId` open; then three drive calls, each one slice, and after each the page shows what the job
 * reached, on its own (the bar's value, then the status "Berhasil"), in the same document (no reload).
 */
async function followOnPage(page: Page, staff: StaffApi, jobId: string): Promise<void> {
  await page.goto(`/admin/jobs/${jobId}`);
  await page.evaluate((mark) => void Object.defineProperty(window, mark, { value: true }), MARK);
  const bar = page.getByRole('progressbar', { name: T('jobs.detail.progress'), exact: true });
  await expect(bar).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByText(T('jobs.status.queued'), { exact: true }).first()).toBeVisible();
  for (const progress of [33, 66]) {
    const after = await staff.call<JobView>('POST', `jobs/${jobId}/drive`);
    expect(after.progress, 'the drive moved the job one slice').toBe(progress);
    await expect(bar).toHaveAttribute('aria-valuenow', String(progress));
  }
  const last = await staff.call<JobView>('POST', `jobs/${jobId}/drive`);
  expect(last.status).toBe('succeeded');
  await expect(page.getByText(T('jobs.status.succeeded'), { exact: true }).first()).toBeVisible();
  expect(await page.evaluate((mark) => (window as unknown as Record<string, unknown>)[mark] === true, MARK), 'the same document: no reload').toBe(true);
}

test('SSE on: the job page follows the job through GET events/stream, without a reload', async ({ page, staff, admin }) => {
  const realtime = await staff.call<RealtimeResponse>('PUT', 'diagnostics/realtime', { sse: true });
  expect(realtime.transport).toBe('sse');
  const requests = eventsRequests(page);
  await signIn(page, admin);
  const jobId = await queueJob(staff);
  await followOnPage(page, staff, jobId);
  expect(requests.streams.some((q) => q.includes(`jobs.${jobId}`))).toBe(true);
  expect(requests.polls.filter((q) => q.includes(`jobs.${jobId}`)), 'no poll while SSE works').toEqual([]);
});

test('SSE off: the job page follows the job by polling GET events, without a reload', async ({ page, staff, admin }) => {
  const realtime = await staff.call<RealtimeResponse>('PUT', 'diagnostics/realtime', { sse: false });
  expect(realtime.transport).toBe('polling');
  const requests = eventsRequests(page);
  await signIn(page, admin);
  const jobId = await queueJob(staff);
  await followOnPage(page, staff, jobId);
  expect(requests.polls.some((q) => q.includes(`jobs.${jobId}`))).toBe(true);
  expect(requests.streams, 'no stream while SSE is off').toEqual([]);
});
