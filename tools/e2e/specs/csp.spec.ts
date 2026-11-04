import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { LOCALES, type Locale } from '@altis/shared';
import type { BranchItem } from '@altis/shared/api/branches';
import type { RoleItem } from '@altis/shared/api/roles';
import { NAV as ADMIN_NAV } from '../../../apps/admin/src/lib/nav.js';
import { assignRole, createStaff, enableTwoFactor } from '../lib/api.js';
import { CspRecorder, guardContext, pageViolations } from '../lib/csp.js';
import { tr, type TextKey } from '../lib/text.js';
import { T, expect, expectHome, passReauth, signIn, test } from '../fixtures.js';

// No CSP violation anywhere a user goes (spec §7.4; exit check A11 of 1b): the sign-in pages, every entry of the admin
// navigation and the pages under it, the command palette, every dialog of the screens, in Indonesian and in English,
// and the OPAC home in both languages. The guard of fixtures.ts checks the whole test; each step here is also checked on
// its own, so that a violation names the step it happened in. A canary proves first that the guard sees a violation at
// all, in this browser.

/**
 * Every entry of the admin navigation, from the table the SPA's shell renders (apps/admin/src/lib/nav.ts): an entry
 * added there is visited here without anyone editing this spec. A super admin sees every one (the test checks it).
 */
const NAV: readonly { key: TextKey; path: RegExp }[] = ADMIN_NAV.map((item) => ({
  key: item.labelKey,
  path: new RegExp(`${item.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`),
}));

const SETTINGS_TABS: readonly { key: TextKey; path: RegExp }[] = [
  { key: 'settings.tab.email', path: /\/admin\/settings\/email$/ },
  { key: 'settings.tab.security', path: /\/admin\/settings\/security$/ },
  { key: 'settings.tab.opac', path: /\/admin\/settings\/opac$/ },
  { key: 'settings.tab.library', path: /\/admin\/settings$/ },
];

const PROFILE_TABS: readonly { key: TextKey; path: RegExp }[] = [
  { key: 'profile.tab.password', path: /\/admin\/profile\/password$/ },
  { key: 'profile.tab.sessions', path: /\/admin\/profile\/sessions$/ },
  { key: 'profile.tab.2fa', path: /\/admin\/profile\/2fa$/ },
  { key: 'profile.tab.general', path: /\/admin\/profile$/ },
];

const LANGUAGE_NAME: Readonly<Record<Locale, string>> = { id: 'Bahasa Indonesia', en: 'English' };

/** Runs `fn` as a reported step and requires that it caused no CSP problem. */
async function clean(csp: CspRecorder, name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    const mark = csp.mark();
    await fn();
    expect(csp.problems(mark), `CSP problems during "${name}"`).toEqual([]);
  });
}

/** The level-1 heading of the screen in <main>, once the screen has loaded. */
async function expectScreen(page: Page, path: RegExp): Promise<void> {
  await expect(page).toHaveURL(path);
  await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
}

// The canary: a guard that saw nothing would let every other test pass. A context of its own with a recorder of its own
// (no `page`, `context` or `csp` fixture), so the violation it causes on purpose never reaches the per-test check.
test('canary: the guard records a violation caused on purpose (binding, window.__csp, console)', async ({ browser, baseURL }) => {
  const recorder = new CspRecorder();
  const context = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  try {
    await guardContext(context, recorder);
    const page = await context.newPage();
    await page.goto('/admin/login');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(recorder.problems(), 'the sign-in page itself is clean').toEqual([]);

    // An inline script without the request's nonce: `script-src 'self' 'nonce-…'` refuses it. Playwright may reject
    // addScriptTag with the browser's refusal; what counts is that the script did not run and the guard saw it.
    await page.addScriptTag({ content: 'window.__altisCanaryRan = true;' }).catch(() => undefined);
    expect(await page.evaluate(() => (window as unknown as { __altisCanaryRan?: boolean }).__altisCanaryRan), 'the inline script was blocked').toBeUndefined();

    const fromBinding = (): string[] => recorder.problems().filter((p) => /^violation script-src(-elem)? blocked inline on .*\/admin\/login/.test(p));
    const fromConsole = (): string[] => recorder.problems().filter((p) => p.startsWith('console on ') && p.includes('script-src'));
    await expect.poll(() => fromBinding().length, 'the binding reported the violation').toBe(1);
    await expect.poll(() => fromConsole().length, 'a console message reported the violation').toBeGreaterThanOrEqual(1);
    expect(await pageViolations(page), "the page's window.__csp holds it").toEqual([expect.objectContaining({ blocked: 'inline', directive: expect.stringMatching(/^script-src(-elem)?$/) })]);
  } finally {
    await context.close();
  }
});

test('sign-in pages', async ({ page, csp }) => {
  await clean(csp, 'login', async () => {
    await page.goto('/admin/login');
    await expect(page.getByRole('heading', { level: 1, name: T('login.title'), exact: true })).toBeVisible();
  });
  await clean(csp, 'forgot password', async () => {
    await page.getByRole('link', { name: T('login.forgot_link'), exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: T('login.forgot.title'), exact: true })).toBeVisible();
  });
  // With the token first: from the page without one, the link would only change the fragment (no new document).
  await clean(csp, 'reset password with a token', async () => {
    await page.goto(`/admin/reset-password#token=${randomBytes(32).toString('base64url')}`);
    await expect(page.getByLabel(T('login.reset.password'), { exact: true })).toBeVisible();
  });
  await clean(csp, 'reset password without a token', async () => {
    await page.goto('/admin/login');
    await page.goto('/admin/reset-password');
    await expect(page.getByText(T('login.reset.missing'))).toBeVisible();
  });
});

test('OPAC home in both languages', async ({ page, csp }) => {
  for (const locale of LOCALES) {
    await clean(csp, `OPAC home (${locale})`, async () => {
      const res = await page.goto(`/?lang=${locale}`);
      expect(res?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('navigation', { name: tr(locale, 'opac.lang.switch') })).toBeVisible();
    });
    await clean(csp, `OPAC 404 page (${locale})`, async () => {
      const res = await page.goto(`/belum-ada?lang=${locale}`);
      expect(res?.status()).toBe(404);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
    });
  }
  await clean(csp, 'OPAC language links', async () => {
    await page.goto('/?lang=id');
    await page.getByRole('navigation', { name: tr('id', 'opac.lang.switch') }).getByRole('link', { name: LANGUAGE_NAME.en, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});

for (const locale of LOCALES) {
  test(`admin in ${LANGUAGE_NAME[locale]}: every nav entry, the command palette, every dialog`, async ({ page, csp, staff, admin, playwright, baseURL }) => {
    const t = (key: TextKey, params?: Readonly<Record<string, string | number>>): string => tr(locale, key, params);
    const tag = randomBytes(3).toString('hex');

    // A super admin of its own (its language changes here), a user with 2FA for the user dialogs, a custom role and a
    // branch for theirs.
    const me = await createStaff(staff, `e2e-csp-${locale}`);
    await assignRole(staff, admin.password, me.id, 'super_admin');
    const target = await createStaff(staff, `e2e-csp-user-${locale}`);
    await enableTwoFactor(playwright.request, baseURL!, target);
    const role = await staff.call<RoleItem>('POST', 'roles', { name: `E2E CSP ${locale} ${tag}`, permissions: ['system.audit.read'] });
    const branch = await staff.call<BranchItem>('POST', 'branches', { code: `E2E-${tag}`, name: `Cabang E2E ${locale} ${tag}`, timezone: 'Asia/Jakarta' });

    await clean(csp, 'sign in', async () => {
      await signIn(page, me);
    });

    const palette = page.getByRole('dialog', { name: t('palette.title') });
    if (locale !== 'id') {
      await clean(csp, `command palette: switch the language to ${LANGUAGE_NAME[locale]}`, async () => {
        await page.getByRole('button', { name: T('shell.open_palette') }).click();
        await page.getByRole('dialog', { name: T('palette.title') }).getByRole('option', { name: T(`palette.language.${locale}`) }).click();
        await expectHome(page, locale);
      });
    }

    const mainNav = page.getByRole('navigation', { name: t('shell.nav_label') });
    await clean(csp, 'nav: the shell shows every entry of the navigation table', async () => {
      await expect(mainNav.getByRole('link')).toHaveCount(NAV.length);
    });
    for (const item of NAV) {
      await clean(csp, `nav: ${t(item.key)}`, async () => {
        await mainNav.getByRole('link', { name: t(item.key), exact: true }).click();
        await expectScreen(page, item.path);
      });
    }

    await clean(csp, 'settings: every group', async () => {
      await mainNav.getByRole('link', { name: t('nav.settings'), exact: true }).click();
      const tabs = page.getByRole('navigation', { name: t('settings.sections') });
      for (const tab of SETTINGS_TABS) {
        await tabs.getByRole('link', { name: t(tab.key), exact: true }).click();
        await expectScreen(page, tab.path);
      }
    });

    await clean(csp, 'command palette: open it with the button, go to the profile', async () => {
      await page.getByRole('button', { name: t('shell.open_palette') }).click();
      await expect(palette).toBeVisible();
      await palette.getByRole('option', { name: t('palette.profile') }).click();
      await expect(palette).toBeHidden();
      await expectScreen(page, /\/admin\/profile$/);
    });

    await clean(csp, 'profile: every section, the 2FA enrolment with its QR code', async () => {
      const tabs = page.getByRole('navigation', { name: t('profile.sections') });
      for (const tab of PROFILE_TABS) {
        await tabs.getByRole('link', { name: t(tab.key), exact: true }).click();
        await expectScreen(page, tab.path);
        if (tab.key === 'profile.tab.2fa') {
          await page.getByRole('button', { name: t('twofa.start'), exact: true }).click();
          await expect(page.getByRole('img', { name: t('twofa.qr_label') })).toBeVisible();
        }
      }
    });

    await clean(csp, 'command palette: Ctrl+K, search, Enter', async () => {
      await page.keyboard.press('Control+k');
      await expect(palette).toBeVisible();
      await page.keyboard.type(t('nav.audit'));
      await page.keyboard.press('Enter');
      await expect(palette).toBeHidden();
      await expectScreen(page, /\/admin\/audit$/);
    });

    await clean(csp, 'users: the confirmations, the reauth dialog and the temporary password', async () => {
      await mainNav.getByRole('link', { name: t('nav.users'), exact: true }).click();
      await page.getByLabel(t('users.search'), { exact: true }).fill(target.username);
      await page.getByRole('button', { name: t('users.search_submit'), exact: true }).click();
      const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: target.username, exact: true }) });
      await expect(row).toHaveCount(1);

      for (const action of ['disable', 'reset_2fa'] as const) {
        await row.getByRole('button', { name: t(`users.action.${action}`), exact: true }).click();
        const confirm = page.getByRole('alertdialog', { name: t(`users.confirm.${action}.title`, { name: target.name }) });
        await expect(confirm).toBeVisible();
        await confirm.getByRole('button', { name: t('form.cancel'), exact: true }).click();
        await expect(confirm).toBeHidden();
      }

      await row.getByRole('button', { name: t('users.action.reset_password'), exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: t('users.confirm.reset_password.title', { name: target.name }) });
      await confirm.getByRole('button', { name: t('users.action.reset_password'), exact: true }).click();
      // A fresh session has no re-authentication: the dialog asks for the password.
      await passReauth(page, me.password, { expectDialog: true }, locale);
      const shown = page.getByRole('dialog', { name: t('users.temp_password.title') });
      await expect(shown).toBeVisible();
      await shown.getByRole('button', { name: t('users.temp_password.done'), exact: true }).click();
      await expect(shown).toBeHidden();
    });

    await clean(csp, 'roles: the delete confirmation', async () => {
      await page.goto(`/admin/roles/${encodeURIComponent(role.id)}`);
      await page.getByRole('button', { name: t('roles.delete'), exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: t('roles.confirm.delete.title', { name: role.name }) });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: t('form.cancel'), exact: true }).click();
      await expect(confirm).toBeHidden();
    });

    await clean(csp, 'branches: the archive confirmation', async () => {
      await mainNav.getByRole('link', { name: t('nav.branches'), exact: true }).click();
      const row = page.getByRole('row').filter({ hasText: branch.name });
      await row.getByRole('button', { name: t('branches.action.archive'), exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: t('branches.confirm.archive.title', { name: branch.name }) });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: t('form.cancel'), exact: true }).click();
      await expect(confirm).toBeHidden();
    });

    await clean(csp, 'system configuration: the cron token confirmation and the one-time token', async () => {
      await mainNav.getByRole('link', { name: t('nav.system'), exact: true }).click();
      await page.getByRole('button', { name: t('system.cron.rotate'), exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: t('system.cron.confirm_title') });
      await confirm.getByRole('button', { name: t('system.cron.rotate'), exact: true }).click();
      const shown = page.getByRole('dialog', { name: t('system.cron.new_title') });
      await passReauth(page, me.password, { next: shown }, locale);
      await expect(shown).toBeVisible();
      await shown.getByRole('button', { name: t('users.temp_password.done'), exact: true }).click();
      await expect(shown).toBeHidden();
    });
  });
}
