import { dashboardCheckDue, dashboardSummary, enqueueDashboardCheck } from '@altis/core';
import { DomainError } from '@altis/shared';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import { csrfKey } from '../http/csrf.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { loggableError } from '../safe-error.js';
import { listScheduleViews } from './jobs.js';

// The system dashboard of Task 26 (spec §13.3 "Dasbor sistem"; decision C33; route catalog `dashboard.get`; the wire
// format is described in @altis/shared/api/dashboard):
//
//   GET dashboard   any signed-in staff user (the dashboard is `/admin`): the version for everyone, every other
//                   section and each alert only for a holder of the permission of its data (core dashboardSummary)
//
// The runner mode is this process's (runnerMode: the runtime and ALTIS_RUNNER), the schedules are those of
// `GET schedules` (listScheduleViews), the op is the app's ops machine's current one (op.json). 1d Task 29: the edition
// section, the update card and their alerts read the app's edition (services.edition), current.json and the release
// bundled in the app folder; `trialStartedAt` is config.json's install date (the backup_missing alert). The answer
// carries `Cache-Control: no-store`.
//
// 1d Task 28 (§9.6 step 1, D1d-30): opening the dashboard also checks for updates, at most once an hour: when
// `update.dashboard_check_at` (read through the settings cache first, then again in the transaction that records the
// new time) is older than that, the `update.check` job is queued (a live one joined) and a worker loop woken. A
// failure there is logged and never fails the dashboard. Without a feed URL (a build without `--feed-url` and none
// set: the feed client's feedConfigured) online checks are off and nothing is queued.

const NO_STORE = { 'Cache-Control': 'no-store' };

/** 1d Task 28: queues the dashboard's update check when the last one is an hour old (see the top of this file). */
async function dashboardUpdateCheck(rc: RouteContext<unknown, unknown, unknown>): Promise<void> {
  try {
    if (!rc.services.updates.source.feedConfigured()) return;
    const at = await rc.services.settings.get<number | null>(rc.db.db, 'update.dashboard_check_at');
    if (!dashboardCheckDue(at, rc.now)) return;
    const jobId = await rc.withTx((tx) => enqueueDashboardCheck(tx.trx, { now: rc.now }));
    if (jobId !== null) rc.services.jobs?.kick();
  } catch (error) {
    rc.log.warn('dashboard: the update check could not be queued', { error: loggableError(error) });
  }
}

/** GET dashboard. */
const dashboardGet = route({
  id: 'dashboard.get',
  method: 'GET',
  path: '/api/v1/dashboard',
  public: true,
  session: 'required',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    // Unreachable: step 9 refuses a `session: 'required'` route without one.
    if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
    const { services } = rc;
    const body: DashboardResponse = await dashboardSummary({
      db: rc.db.db,
      dataDir: services.dataDir,
      sessionKey: csrfKey(rc.config),
      grants: rc.auth.grants,
      now: rc.now,
      version: services.version,
      appJsVersion: services.appJsVersion,
      runtime: services.runtime,
      env: services.install.env,
      trialStartedAt: rc.config.install.trialStartedAt,
      ops: services.ops,
      listSchedules: listScheduleViews,
      // 1d Task 29: the edition section and the update card (the edition's check), the bundled release.
      edition: services.edition,
      appRoot: services.install.appRoot,
    });
    await dashboardUpdateCheck(rc); // 1d Task 28
    return { body, headers: NO_STORE };
  },
});

/** The dashboard route (route catalog `dashboard.get`). */
export const DASHBOARD_ROUTES: RouteDecl[] = [dashboardGet];
