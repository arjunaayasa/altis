import fsp from 'node:fs/promises';
import path from 'node:path';
import { expect, test as base } from '../fixtures.js';
import { createTargetApp, e2eTarget, type TargetApp } from '../lib/targets.js';
import { afterFinish, checks, claim, database, heading, migrations, newAdmin, toTheEnd } from '../lib/wizard.js';
import { CLOCK_OFFSET_25H_MS, NOT_INSTALLED, createOwnApp, type OwnApp } from '../uninstalled-setup.js';

// The web install wizard in the browser (spec §9.5, §7.7; acceptance A2; plan 1c Task 34), project `uninstalled`:
// each test gets the release unzipped afresh and started standalone (SQLite allowed, the worker runs), never installed.
//
// 1. The whole wizard: the code read from DATA_DIR/install-code.txt (where the hosting panel's file manager finds it),
//    the claim, the checks with the browser's own probes (polling, SSE, methods, chunk, X-Forwarded-For, the exposure
//    of the app and data folders, the base URL proof), SQLite, the migrations, the profile, the super admin, the
//    scheduler (no licence step), then the sign-in of that admin; afterwards /install is 404 and the code is gone.
// 2. The resume: the server SIGKILLed right after the database step (config.json written, no migration run) and
//    started again 25 hours later: the code (24 h) and the claim (2 h idle) are both expired, so the next /install
//    makes a new code; the browser claims it and the wizard goes on from the migrations to the end, with no terminal
//    step (no CLI). The 25 hours are ALTIS_TEST_CLOCK_OFFSET_MS of the test release (M23) on the process that is
//    killed (-25 h, as apps/server/test/db/install-wizard.test.ts does): a process whose clock runs ahead cannot write
//    the audit entries of the admin step and of `finish` (@altis/db refuses an entry more than 5 minutes ahead of the
//    real clock).
//
// 1d Task 35 (A1, "keempat lingkungan"): the first test runs on the target of the run, ALTIS_E2E_TARGET and ALTIS_E2E_DB
// (lib/targets.ts): standalone + SQLite by default (the app of uninstalled-setup.ts, as above), or passenger-sim, pm2 or
// docker with a server database (an app started as the smoke run starts that target; the wizard is given the engine's
// database, plays the cron line where Passenger needs a scheduler, and expects the SSE probe only where the server
// streams by itself). The resume test runs on standalone only (it kills the app's process group).
//
// The steps themselves are lib/wizard.ts. Every page runs under the CSP guard of fixtures.ts (A11's 1c share).

let made = 0;

const TARGET = e2eTarget();
/** The first test runs on a target app (lib/targets.ts) unless the run is standalone + SQLite. */
const ON_TARGET = !(TARGET.target === 'standalone' && TARGET.db === 'sqlite');

/** The app a test installs: an own app (uninstalled-setup.ts) or a target app. */
interface Site {
  baseUrl: string;
  dataDir: string | null;
  own: OwnApp | null;
  target: TargetApp | null;
  installCode(): Promise<string>;
}

const test = base.extend<{ onTarget: boolean; site: Site }>({
  onTarget: [false, { option: true }],
  site: async ({ onTarget }, use) => {
    made += 1;
    if (onTarget) {
      const zip = process.env['ALTIS_E2E_RELEASE_ZIP'];
      if (zip === undefined || zip === '') throw new Error('ALTIS_E2E_RELEASE_ZIP is not set: run the specs through tools/e2e/playwright.config.ts');
      const app = await createTargetApp(TARGET, zip);
      try {
        await use({ baseUrl: app.baseUrl, dataDir: app.dataDir, own: null, target: app, installCode: () => app.installCode() });
      } finally {
        await app.dispose();
      }
      return;
    }
    const app = await createOwnApp(`wizard-${made}`);
    try {
      await use({ baseUrl: app.baseUrl, dataDir: app.dataDir, own: app, target: null, installCode: () => app.installCode() });
    } finally {
      await app.dispose();
    }
  },
  baseURL: async ({ site }, use) => {
    await use(site.baseUrl);
  },
});

test.describe.configure({ timeout: 300_000 });

test.describe(`the whole wizard on ${TARGET.target} + ${TARGET.db}`, () => {
  test.use({ onTarget: ON_TARGET });

  test('A1/A2: the whole wizard in the browser, real probes, then the super admin signs in', async ({ page, site, playwright }) => {
    const admin = newAdmin();
    const target = site.target;
    if (target === null) await site.own!.start({ ready: [NOT_INSTALLED] });
    else await target.start();
    await page.goto('/install');
    await claim(page, site);
    await checks(page, { sse: target === null || target.target === 'standalone' });
    await database(page, target?.db);
    await migrations(page);
    const cron =
      target?.needsCron === true
        ? async () => {
            const api = await playwright.request.newContext({ baseURL: target.baseUrl });
            try {
              const answer = await api.post('/_cron', { headers: { authorization: `Bearer ${await target.cronToken()}` } });
              expect(answer.status(), 'POST /_cron (the cron line)').toBe(200);
            } finally {
              await api.dispose();
            }
          }
        : undefined;
    await toTheEnd(page, admin, 'Perpustakaan Wizard E2E', cron === undefined ? {} : { cron });
    await afterFinish(page, site, admin);
  });
});

test('A2: killed after the database step, back 25 hours later: a new code, a new claim, on to the end without a terminal', async ({ page, site }) => {
  test.skip(site.own === null, 'the resume runs standalone only');
  const uninstalled = site.own!;
  const admin = newAdmin();
  // The process that will be killed runs 25 hours before the one that resumes.
  await uninstalled.start({ env: { ALTIS_TEST_CLOCK_OFFSET_MS: String(-CLOCK_OFFSET_25H_MS) }, ready: [NOT_INSTALLED] });
  await page.goto('/install');
  const oldCode = await claim(page, uninstalled);
  await checks(page);

  // The migrations wait (their requests held in the browser) while the server dies right after `POST config`.
  const held: { abort(): Promise<void> }[] = [];
  await page.route('**/install/api/migrate', (route) => void held.push(route));
  await database(page);
  await expect(heading(page, 'migrate.title')).toBeVisible();
  const config = JSON.parse(await fsp.readFile(path.join(uninstalled.dataDir, 'config.json'), 'utf8')) as { installState?: string };
  expect(config.installState).toBe('migrate');
  await uninstalled.kill();
  await page.unroute('**/install/api/migrate');
  for (const route of held) await route.abort().catch(() => {});

  // 25 hours later (the code lives 24 h, a claim 2 h idle): the next /install makes a new code.
  await uninstalled.start({ ready: [NOT_INSTALLED] });
  await page.goto('/install');
  const newCode = await claim(page, uninstalled);
  expect(newCode).not.toBe(oldCode);

  // The wizard resumes where config.json stands: the migrations, then the rest; nothing done on a command line.
  await migrations(page);
  await toTheEnd(page, admin, 'Perpustakaan Lanjutan E2E');
  await afterFinish(page, uninstalled, admin);
});
