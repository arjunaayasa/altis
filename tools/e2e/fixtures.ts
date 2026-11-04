import { test as base, expect, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import type { Locale } from '@altis/shared';
import { StaffApi } from './lib/api.js';
import { Authenticator } from './lib/authenticator.js';
import { CspRecorder, guardContext, pageViolations } from './lib/csp.js';
import { MailCatcher } from './lib/mail.js';
import { readAdminFixture, type AdminFixture } from './lib/server.js';
import { tr, type TextKey } from './lib/text.js';

// The fixtures of every spec (Task 32):
//
// - `baseURL`: the install global-setup.ts started (ALTIS_E2E_BASE_URL);
// - the CSP guard (lib/csp.ts) on `context`, so on `page` and every page of it: an init script collects each
//   `securitypolicyviolation` into `window.__csp`, and every console message is read. After each test `window.__csp`
//   of the page must be empty, and no console message may contain "Content Security Policy" (A11);
// - `newContext()`: another browser (a second device, a second user) with the same guard and the project's options;
// - `admin`: the first super admin's test-only credentials (fixtures/admin.json); `staff`: an API session of it for
//   preparing what a test needs (users, roles, 2FA); `mail`: the mail catcher's API (ALTIS_E2E_MAIL_API).
//
// The UI helpers below act as a user does (labels, button names) in the words of the SPA's catalogues (lib/text.ts).

export interface E2EFixtures {
  csp: CspRecorder;
  newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
  admin: AdminFixture;
  staff: StaffApi;
  mail: MailCatcher;
}

function setByGlobalSetup(name: 'ALTIS_E2E_BASE_URL' | 'ALTIS_E2E_MAIL_API'): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set: run the specs through tools/e2e/playwright.config.ts (global-setup.ts sets it)`);
  return value;
}

/** The checks of the CSP guard for the pages of `contexts`, then for everything the recorder saw. */
async function expectNoCspProblems(csp: CspRecorder, pages: readonly Page[]): Promise<void> {
  for (const page of pages) {
    expect(await pageViolations(page).catch(() => []), `window.__csp of ${page.url()}`).toEqual([]);
  }
  expect(csp.problems(), 'CSP violations (securitypolicyviolation events and console reports)').toEqual([]);
}

export const test = base.extend<E2EFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a fixture needs from its first parameter.
  baseURL: async ({}, use) => {
    await use(setByGlobalSetup('ALTIS_E2E_BASE_URL'));
  },
  // eslint-disable-next-line no-empty-pattern
  csp: async ({}, use) => {
    await use(new CspRecorder());
  },
  context: async ({ context, csp }, use) => {
    await guardContext(context, csp);
    await use(context);
  },
  page: async ({ page, context, csp }, use) => {
    await use(page);
    await expectNoCspProblems(csp, context.pages());
  },
  newContext: async ({ browser, csp, baseURL, viewport, userAgent, locale, timezoneId, deviceScaleFactor, isMobile, hasTouch }, use) => {
    const made: BrowserContext[] = [];
    await use(async (options = {}) => {
      const context = await browser.newContext({
        ...(baseURL === undefined ? {} : { baseURL }),
        viewport,
        ...(userAgent === undefined ? {} : { userAgent }),
        ...(locale === undefined ? {} : { locale }),
        ...(timezoneId === undefined ? {} : { timezoneId }),
        deviceScaleFactor,
        isMobile,
        hasTouch,
        ...options,
      });
      await guardContext(context, csp);
      made.push(context);
      return context;
    });
    await expectNoCspProblems(
      csp,
      made.flatMap((c) => c.pages()),
    );
    for (const context of made) await context.close();
  },
  // eslint-disable-next-line no-empty-pattern
  admin: async ({}, use) => {
    await use(readAdminFixture());
  },
  staff: async ({ playwright, baseURL, admin }, use) => {
    const api = await StaffApi.open(playwright.request, baseURL ?? setByGlobalSetup('ALTIS_E2E_BASE_URL'));
    await api.signIn(admin.username, admin.password);
    await use(api);
    await api.dispose();
  },
  // eslint-disable-next-line no-empty-pattern
  mail: async ({}, use) => {
    await use(new MailCatcher(setByGlobalSetup('ALTIS_E2E_MAIL_API')));
  },
});

export { expect };

// ---------------------------------------------------------------------------------------------------------------
// UI helpers (Indonesian unless a locale is given: the install's library language is `id`)

/** The text of `key` in Indonesian. */
export const T = (key: TextKey, params?: Readonly<Record<string, string | number>>): string => tr('id', key, params);

export interface Credentials {
  username: string;
  password: string;
}

/** Opens the sign-in page and submits a username and password (and "Ingat saya" when asked). */
export async function submitPassword(page: Page, c: Credentials, o: { remember?: boolean } = {}): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel(T('login.username'), { exact: true }).fill(c.username);
  await page.getByLabel(T('login.password'), { exact: true }).fill(c.password);
  if (o.remember === true) await page.getByLabel(T('login.remember'), { exact: true }).check();
  await page.getByRole('button', { name: T('login.submit'), exact: true }).click();
}

/** On the 2FA step: an authenticator code (or, with `recovery`, a recovery code), then "Verifikasi". */
export async function submitSecondFactor(page: Page, value: string, o: { recovery?: boolean } = {}): Promise<void> {
  await expect(page).toHaveURL(/\/admin\/login\/2fa(\?|$)/);
  if (o.recovery === true) {
    await page.getByRole('button', { name: T('login.2fa.use_recovery'), exact: true }).click();
    await page.getByLabel(T('login.2fa.recovery_code'), { exact: true }).fill(value);
  } else {
    await page.getByLabel(T('login.2fa.code'), { exact: true }).fill(value);
  }
  await page.getByRole('button', { name: T('login.2fa.submit'), exact: true }).click();
}

/** Beranda, the page a completed sign-in opens. */
export async function expectHome(page: Page, locale: Locale = 'id'): Promise<void> {
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.getByRole('heading', { level: 1, name: tr(locale, 'nav.home'), exact: true })).toBeVisible();
}

/** Signs in with a password only (a user without 2FA) and lands on Beranda. */
export async function signIn(page: Page, c: Credentials): Promise<void> {
  await submitPassword(page, c);
  await expectHome(page);
}

/** "Keluar" in the header. */
export async function signOut(page: Page, locale: Locale = 'id'): Promise<void> {
  await page.getByRole('button', { name: tr(locale, 'palette.logout'), exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login(\?|$)/);
}

/** The secret of the enrolment page as text: base32 in groups of four. */
const SECRET_TEXT = /^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/;

/**
 * Enables 2FA in "Profil saya" as a user does: start, read the secret the page shows as text (what a user types into
 * an app that cannot scan), confirm with a code of it. Answers the app and the 10 recovery codes the page shows once;
 * the page then offers "Masuk lagi" (the enable ended every session, S11).
 */
export async function enrolInProfile(page: Page): Promise<{ authenticator: Authenticator; recoveryCodes: string[] }> {
  await page.goto('/admin/profile');
  await page.getByRole('navigation', { name: T('profile.sections') }).getByRole('link', { name: T('profile.tab.2fa'), exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/profile\/2fa$/);
  await page.getByRole('button', { name: T('twofa.start'), exact: true }).click();
  const secret = page.locator('code').filter({ hasText: SECRET_TEXT });
  await expect(secret).toBeVisible();
  const authenticator = new Authenticator((await secret.textContent()) ?? '');
  await page.getByLabel(T('login.2fa.code'), { exact: true }).fill(await authenticator.nextCode());
  await page.getByRole('button', { name: T('twofa.enable'), exact: true }).click();
  const codes = page.getByRole('list', { name: T('codes.title') }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  return { authenticator, recoveryCodes: await codes.allTextContents() };
}

/**
 * Confirms the password in the reauth dialog (§7.3) when `expectDialog`; otherwise waits for `next` (what the action
 * shows afterwards) and fills the dialog only if it came first.
 */
export async function passReauth(page: Page, password: string, o: { expectDialog: true } | { next: ReturnType<Page['locator']> }, locale: Locale = 'id'): Promise<void> {
  const dialog = page.getByRole('dialog', { name: tr(locale, 'reauth.title') });
  if ('next' in o) {
    await expect(dialog.or(o.next).first()).toBeVisible();
    if (!(await dialog.isVisible())) return;
  } else {
    await expect(dialog).toBeVisible();
  }
  await dialog.getByLabel(tr(locale, 'reauth.password'), { exact: true }).fill(password);
  await dialog.getByRole('button', { name: tr(locale, 'reauth.submit'), exact: true }).click();
  await expect(dialog).toBeHidden();
}
