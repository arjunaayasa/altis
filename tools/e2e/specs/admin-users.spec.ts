import type { Page } from '@playwright/test';
import { newPassword } from '../lib/api.js';
import { T, chooseFromMenu, enrolInProfile, expect, expectHome, passReauth, signIn, signOut, submitFilter, submitPassword, test } from '../fixtures.js';
import { navLink, openGroup, openNavPage } from '../lib/nav.js';

// Staff administration in the browser (spec §7.1–§7.3, §13.3 "Pengguna"; Tasks 19, 29): the super admin creates
// `petugas` with the role Admin; petugas changes the required password and enables 2FA; the super admin resets
// petugas's 2FA (behind the reauth dialog) and then the password (a temporary one, shown once).
//
// Every super-admin step signs in afresh (a new browser): a fresh session carries no re-authentication, so the
// reauth dialog appearing is what the test sees, not an accident of timing.

const PETUGAS = { username: 'petugas', name: 'Petugas Sirkulasi', email: 'petugas@perpus.test' };

/** The users list, searched for petugas, and its row. */
async function petugasRow(page: Page) {
  await openNavPage(page, '/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: T('nav.users'), exact: true })).toBeVisible();
  const search = page.getByLabel(T('users.search'), { exact: true });
  await search.fill(PETUGAS.username);
  await submitFilter(search);
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: PETUGAS.username, exact: true }) });
  await expect(row).toHaveCount(1);
  return row;
}

test('super admin: create petugas as Admin, reset its 2FA (reauth), reset its password (temporary, once)', async ({ page, admin, newContext }) => {
  // 1. The super admin creates petugas with a password and the role Admin.
  await signIn(page, admin);
  await openNavPage(page, '/admin/users');
  await page.getByRole('link', { name: T('users.add'), exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users\/new$/);
  const initial = newPassword();
  await page.getByLabel(T('users.field.username'), { exact: true }).fill(PETUGAS.username);
  await page.getByLabel(T('users.field.name'), { exact: true }).fill(PETUGAS.name);
  await page.getByLabel(T('users.field.email'), { exact: true }).fill(PETUGAS.email);
  await page.getByLabel(T('users.field.password'), { exact: true }).fill(initial);
  // A password the admin chose is changed at the first sign-in (the default).
  await expect(page.getByLabel(T('users.field.must_change_password'), { exact: true })).toBeChecked();
  await page.getByRole('button', { name: T('form.save'), exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users\/(?!new$)[^/?#]+$/);
  await expect(page.getByRole('heading', { level: 1, name: PETUGAS.name, exact: true })).toBeVisible();

  // The select labelled "Peran" (the section around it is named "Peran" too).
  await page.getByRole('combobox', { name: T('users.roles.role'), exact: true }).selectOption({ label: T('role.admin') });
  await page.getByRole('button', { name: T('users.roles.add'), exact: true }).click();
  await page.getByRole('button', { name: T('users.roles.save'), exact: true }).click();
  await passReauth(page, admin.password, { expectDialog: true });
  await expect(page.getByText(T('users.roles.saved'), { exact: true })).toBeVisible();

  // 2. petugas signs in, must change the password first, then enables 2FA.
  const petugas = await (await newContext()).newPage();
  await submitPassword(petugas, { username: PETUGAS.username, password: initial });
  await expect(petugas).toHaveURL(/\/admin\/profile\/password/);
  const changed = newPassword();
  await petugas.getByLabel(T('profile.password.current'), { exact: true }).fill(initial);
  await petugas.getByLabel(T('profile.password.next'), { exact: true }).fill(changed);
  await petugas.getByLabel(T('profile.password.confirm'), { exact: true }).fill(changed);
  await petugas.getByRole('button', { name: T('profile.password.submit'), exact: true }).click();
  await expectHome(petugas);
  // The role Admin shows its sections.
  await openGroup(petugas, T('nav.group.system'));
  await expect(navLink(petugas, '/admin/users')).toBeVisible();
  await enrolInProfile(petugas);
  await petugas.getByRole('button', { name: T('twofa.sign_in_again'), exact: true }).click();
  // From now on the password alone is not enough.
  await submitPassword(petugas, { username: PETUGAS.username, password: changed });
  await expect(petugas).toHaveURL(/\/admin\/login\/2fa/);

  // 3. The super admin resets petugas's 2FA: a fresh session, so the reauth dialog asks for the password first.
  const admin2 = await (await newContext()).newPage();
  await signIn(admin2, admin);
  const row = await petugasRow(admin2);
  // "Atur ulang 2FA" shows only for a user with 2FA on.
  await chooseFromMenu(admin2, row, T('users.more_named', { name: PETUGAS.name }), T('users.action.reset_2fa'));
  const confirm2fa = admin2.getByRole('alertdialog', { name: T('users.confirm.reset_2fa.title', { name: PETUGAS.name }) });
  await confirm2fa.getByRole('button', { name: T('users.action.reset_2fa'), exact: true }).click();
  await passReauth(admin2, admin.password, { expectDialog: true });
  await expect(confirm2fa).toBeHidden();
  await expect(admin2.getByText(T('users.done.reset_2fa', { name: PETUGAS.name }), { exact: true })).toBeVisible();

  // petugas signs in with the password only.
  const petugas2 = await (await newContext()).newPage();
  await signIn(petugas2, { username: PETUGAS.username, password: changed });

  // 4. The super admin resets petugas's password: a temporary password, shown once.
  const sameRow = await petugasRow(admin2);
  await chooseFromMenu(admin2, sameRow, T('users.more_named', { name: PETUGAS.name }), T('users.action.reset_password'));
  const confirmPassword = admin2.getByRole('alertdialog', { name: T('users.confirm.reset_password.title', { name: PETUGAS.name }) });
  await confirmPassword.getByRole('button', { name: T('users.action.reset_password'), exact: true }).click();
  const shown = admin2.getByRole('dialog', { name: T('users.temp_password.title') });
  // The re-authentication of step 3 is younger than 5 minutes, so the dialog normally does not ask again.
  await passReauth(admin2, admin.password, { next: shown });
  await expect(shown).toBeVisible();
  const temporary = ((await shown.locator('code').textContent()) ?? '').trim();
  expect(temporary).toMatch(/^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
  await shown.getByRole('button', { name: T('users.temp_password.done'), exact: true }).click();
  await expect(shown).toBeHidden();

  // The reset ended petugas's sessions.
  await petugas2.reload();
  await expect(petugas2).toHaveURL(/\/admin\/login/);

  // The temporary password signs in once, straight to the password change.
  const petugas3 = await (await newContext()).newPage();
  await submitPassword(petugas3, { username: PETUGAS.username, password: temporary });
  await expect(petugas3).toHaveURL(/\/admin\/profile\/password/);
  await expect(petugas3.getByRole('heading', { name: T('profile.password.title'), exact: true })).toBeVisible();
  const final = newPassword();
  await petugas3.getByLabel(T('profile.password.current'), { exact: true }).fill(temporary);
  await petugas3.getByLabel(T('profile.password.next'), { exact: true }).fill(final);
  await petugas3.getByLabel(T('profile.password.confirm'), { exact: true }).fill(final);
  await petugas3.getByRole('button', { name: T('profile.password.submit'), exact: true }).click();
  await expectHome(petugas3);
  await signOut(petugas3);

  const again = petugas3.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login'));
  await submitPassword(petugas3, { username: PETUGAS.username, password: temporary });
  expect((await again).status()).toBe(401);
  await expect(petugas3.getByText(T('error.AUTH_INVALID_CREDENTIALS'))).toBeVisible();
  await signIn(petugas3, { username: PETUGAS.username, password: final });
});
