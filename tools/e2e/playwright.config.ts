import { defineConfig, devices } from '@playwright/test';
import { browserUse, withHostResolver } from './lib/browser.js';

// The E2E suite (spec §12.3 nightly tier, §13.2 exit check of 1b: A3, A11; Task 32). `pnpm e2e` from the repository
// root (or `pnpm --filter @altis/e2e exec playwright test <args>`).
//
// global-setup.ts builds the test-profile release, installs it standalone on SQLite in a temp folder, starts
// `node app.js` on a free port of 127.0.0.1 and points its SMTP at mailpit or the in-process catcher; the specs reach
// it through ALTIS_E2E_BASE_URL (fixtures.ts). One worker, in file order: the specs share one install, whose
// per-IP login buckets every spec's 127.0.0.1 counts against, and each spec makes the users it needs.
//
// Browser: lib/browser.ts (Playwright's Chromium, or ALTIS_E2E_EXECUTABLE / ALTIS_E2E_CHANNEL). A context never
// bypasses CSP: the CSP guard of fixtures.ts must see what a user's browser would enforce. On a machine without
// Playwright's Chromium, point the suite at a Chromium-based browser that is there, e.g.
//
//   ALTIS_E2E_EXECUTABLE="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell" pnpm e2e
//   ALTIS_E2E_EXECUTABLE="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" pnpm e2e
//
// Other knobs: ALTIS_E2E_ZIP=<zip> installs that release instead of building one; ALTIS_E2E_KEEP=1 keeps the temp
// install; ALTIS_TEST_MAILPIT=1 / ALTIS_TEST_MAILPIT_REQUIRED=1 send the mail to mailpit (lib/mail.ts).
//
// Projects (1c Task 34): `chromium` runs the specs against the shared install; `uninstalled` runs the install wizard
// (specs/wizard.spec.ts, A2) against apps of its own that are not installed yet (uninstalled-setup.ts: the same release
// unzipped afresh per test, killed and restarted at will). Both drive the same browser, one after the other.
//
// 1d Task 35 (A1, A7, A8, A9, A11):
// - update.spec.ts, update-rollback.spec.ts and update-offline.spec.ts bring installed apps of their own (an app
//   updated cannot be the shared one). They update the suite's release (0.1.0-test) to 0.2.0-test through a feed
//   signed with the dev keys (feed-dev on 127.0.0.1): ALTIS_E2E_UPDATE_ZIP=<zip of 0.2.0-test> gives it, else
//   lib/update.ts builds it once per run.
// - Chromium resolves every name under altis-e2e.test to 127.0.0.1 (lib/browser.ts withHostResolver), for a spec that
//   needs a DNS name as the app's baseUrl (uninstalled-setup.ts `createOwnApp({host})`).
// - wizard.spec.ts runs on one target per run: ALTIS_E2E_TARGET (standalone by default; passenger-sim, pm2, docker)
//   and ALTIS_E2E_DB (the tools/test/compose.yml engine; sqlite by default, standalone only). See wizard.spec.ts.

const CI = process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== 'false';

/** The specs that bring an uninstalled app of their own. */
const UNINSTALLED_SPECS = /wizard\.spec\.ts$/;

export default defineConfig({
  testDir: './specs',
  outputDir: './dist/test-results',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  // A retry would meet the state the first attempt left (users, rate-limit buckets) in the same install.
  retries: 0,
  forbidOnly: CI,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [['list'], ['html', { outputFolder: './dist/report', open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    bypassCSP: false,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', testIgnore: UNINSTALLED_SPECS, use: { ...devices['Desktop Chrome'], ...withHostResolver(browserUse(process.env)) } },
    { name: 'uninstalled', testMatch: UNINSTALLED_SPECS, use: { ...devices['Desktop Chrome'], ...withHostResolver(browserUse(process.env)) } },
  ],
});
