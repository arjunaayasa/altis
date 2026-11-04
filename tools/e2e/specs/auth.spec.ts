import { createStaff, enableTwoFactor, newPassword } from '../lib/api.js';
import { resetLinkOf } from '../lib/mail.js';
import { T, enrolInProfile, expect, expectHome, signIn, signOut, submitPassword, submitSecondFactor, test } from '../fixtures.js';

// Staff sign-in in the browser (spec §7.1; exit check A3 of 1b, the browser half of Tasks 15–18): 2FA enrolment and
// sign-in, recovery codes, remember-me, password reset by mail, and the device-cookie rule of the login limits. Each
// test makes its own users through the API (lib/api.ts), so no test depends on another one's state.

test('2FA: enable it in the profile, keep the recovery codes, sign in again with password + code', async ({ page, staff }) => {
  const user = await createStaff(staff, 'e2e-2fa');
  await signIn(page, user);

  // Profil saya → Verifikasi dua langkah: the secret read as text, a code of it, then the 10 recovery codes, shown
  // once; the enable ended every session (S11, D22).
  const { authenticator: app, recoveryCodes } = await enrolInProfile(page);
  expect(recoveryCodes.every((code) => /^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(code))).toBe(true);
  expect(new Set(recoveryCodes).size).toBe(10);
  await expect(page.getByText(T('twofa.signed_out'))).toBeVisible();

  await page.getByRole('button', { name: T('twofa.sign_in_again'), exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login\?/);
  await expect(page.getByText(T('login.notice.2fa_enabled'))).toBeVisible();

  await submitPassword(page, user);
  await submitSecondFactor(page, await app.nextCode());
  await expectHome(page);
});

test('2FA: a recovery code signs in once; the same code a second time is refused', async ({ page, staff, playwright, baseURL }) => {
  const user = await createStaff(staff, 'e2e-rec');
  const { recoveryCodes } = await enableTwoFactor(playwright.request, baseURL!, user);
  const code = recoveryCodes[3]!;

  await submitPassword(page, user);
  await submitSecondFactor(page, code, { recovery: true });
  await expectHome(page);
  await signOut(page);

  await submitPassword(page, user);
  const verify = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/2fa/verify'));
  await submitSecondFactor(page, code, { recovery: true });
  expect((await verify).status()).toBe(401);
  await expect(page.getByText(T('error.AUTH_MFA_INVALID'))).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/login\/2fa/);
});

test('remember-me: the session comes back without altis_sid; a new device needs password + code', async ({ page, context, staff, playwright, baseURL, newContext }) => {
  const user = await createStaff(staff, 'e2e-rm');
  const { authenticator } = await enableTwoFactor(playwright.request, baseURL!, user);

  // "Ingat saya" on the password step carries over to the 2FA step, where the token is issued.
  await submitPassword(page, user, { remember: true });
  await expect(page).toHaveURL(/\/admin\/login\/2fa\?/);
  await expect(page.getByLabel(T('login.remember'), { exact: true })).toBeChecked();
  await submitSecondFactor(page, await authenticator.nextCode());
  await expectHome(page);
  const cookies = await context.cookies();
  expect(cookies.map((c) => c.name)).toEqual(expect.arrayContaining(['altis_sid', 'altis_rm']));

  // The session cookie gone (a closed browser): the remember-me token opens a session again.
  await context.clearCookies({ name: 'altis_sid' });
  await page.reload();
  await expectHome(page);
  expect((await context.cookies()).some((c) => c.name === 'altis_sid')).toBe(true);

  // Another device: the sign-in page, and both factors.
  const other = await (await newContext()).newPage();
  await other.goto('/admin');
  await expect(other).toHaveURL(/\/admin\/login/);
  await submitPassword(other, user);
  await submitSecondFactor(other, await authenticator.nextCode());
  await expectHome(other);
});

test('forgot password: the mailed link sets a new password, which then signs in', async ({ page, staff, mail }) => {
  const user = await createStaff(staff, 'e2e-forgot');
  await page.goto('/admin/login');
  await page.getByRole('link', { name: T('login.forgot_link'), exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/forgot-password$/);
  await page.getByLabel(T('login.forgot.email'), { exact: true }).fill(user.email);
  await page.getByRole('button', { name: T('login.forgot.submit'), exact: true }).click();
  await expect(page.getByText(T('login.forgot.sent'))).toBeVisible();

  // The mail goes out after the response (D18).
  const message = await mail.waitFor(user.email, { timeoutMs: 30_000 });
  const link = resetLinkOf(message.text);
  expect(link.startsWith(`${new URL(page.url()).origin}/admin/reset-password#token=`)).toBe(true);

  const password = newPassword();
  await page.goto(link);
  await page.getByLabel(T('login.reset.password'), { exact: true }).fill(password);
  await page.getByLabel(T('login.reset.confirm'), { exact: true }).fill(password);
  await page.getByRole('button', { name: T('login.reset.submit'), exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login\?/);
  await expect(page.getByText(T('login.notice.password_reset'))).toBeVisible();

  await signIn(page, { username: user.username, password });
});

test('A3 device rule: 5 wrong passwords lock this browser out of the account, a known device still signs in', async ({ staff, newContext }) => {
  // A user of its own: its login:user-ip bucket stays locked for 15 minutes (M24).
  const user = await createStaff(staff, 'e2e-dev');

  // Device B signed in before: it holds the altis_dev cookie for this username.
  const b = await (await newContext()).newPage();
  await signIn(b, user);
  await signOut(b);

  // Device A has no device cookie: five wrong passwords, then the right one is refused too.
  const a = await (await newContext()).newPage();
  await a.goto('/admin/login');
  const attempt = async (password: string): Promise<number> => {
    await a.getByLabel(T('login.username'), { exact: true }).fill(user.username);
    await a.getByLabel(T('login.password'), { exact: true }).fill(password);
    const answer = a.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login'));
    await a.getByRole('button', { name: T('login.submit'), exact: true }).click();
    return (await answer).status();
  };
  for (let i = 1; i <= 5; i += 1) {
    expect(await attempt(`salah-${i}-${user.password}`), `wrong password ${i}`).toBe(401);
    await expect(a.getByText(T('error.AUTH_INVALID_CREDENTIALS'))).toBeVisible();
  }
  expect(await attempt(user.password)).toBe(429);
  await expect(a.getByText(T('error.AUTH_TOO_MANY_ATTEMPTS'))).toBeVisible();
  await expect(a).toHaveURL(/\/admin\/login/);

  // Device B signs in at once: a known device counts only in login:dev.
  await signIn(b, user);
});
