import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, signIn } from '../fixtures.js';
import { wizardText as W, type OwnApp } from '../uninstalled-setup.js';
import { newPassword } from './api.js';
import type { DbConfig } from './targets.js';

// The steps of the web install wizard as a person goes through them in the browser (spec §9.5, §7.7), for
// wizard.spec.ts (A2, and A1 per target, 1d Task 35). Each step waits for its heading, fills what the step asks and
// moves on, in the wizard's own words (W). The community edition has no licence step: the super admin is followed by
// the scheduler.

export interface WizardAdmin {
  username: string;
  name: string;
  email: string;
  password: string;
}

export const newAdmin = (): WizardAdmin => ({ username: 'pustakawan', name: 'Pustakawan Kepala', email: 'pustakawan@perpus.test', password: newPassword() });

/** The step heading the wizard shows now. */
export const heading = (page: Page, key: string) => page.getByRole('heading', { level: 2, name: W(key), exact: true });

export const button = (page: Page, key: string) => page.getByRole('button', { name: W(key), exact: true });

/** Step 0: the code of install-code.txt, typed as the owner copies it. */
export async function claim(page: Page, app: Pick<OwnApp, 'installCode'>): Promise<string> {
  await expect(heading(page, 'claim.title')).toBeVisible();
  const code = await app.installCode();
  await page.locator('#install-code').fill(code);
  await button(page, 'claim.submit').click();
  return code;
}

/** Step 1: the server's checks and the browser's own test, then the hops confirmed and "Lanjut". */
export async function checks(page: Page, o: { sse?: boolean } = {}): Promise<void> {
  await expect(heading(page, 'checks.title')).toBeVisible();
  // The exposure verdict comes last of the browser test (lib/probes.ts): every candidate path fetched, none served.
  await expect(page.getByText(W('checks.exposure.ok'), { exact: true })).toBeVisible({ timeout: 60_000 });
  // Polling and SSE both work on a standalone server (the definitions list of the browser test).
  const results = page.locator('dl').filter({ hasText: W('checks.browser.polling') });
  await expect(results.locator('dd').nth(0)).toHaveText(W('checks.browser.works'));
  // SSE: a standalone server streams; a host in front of the app (Passenger, a proxy) may buffer it (1d Task 35).
  if (o.sse !== false) await expect(results.locator('dd').nth(1)).toHaveText(W('checks.browser.works'));
  await expect(page.locator('#install-base-url')).toHaveValue(new URL(page.url()).origin);
  await page.locator('#install-ip-confirm').check();
  await button(page, 'app.next').click();
}

/** Step 2: SQLite, its connection test, then "Simpan dan buat tabel" (`POST config`). */
export async function database(page: Page, db: DbConfig = { dialect: 'sqlite' }): Promise<void> {
  await expect(heading(page, 'db.title')).toBeVisible();
  await page.locator('#install-db-dialect').selectOption(db.dialect);
  if (db.dialect !== 'sqlite') {
    // 1d Task 35 (A1 per target): a server database, as the hosting panel shows its details.
    await page.locator('#install-db-host').fill(db.host ?? 'localhost');
    await page.locator('#install-db-port').fill(String(db.port ?? ''));
    await page.locator('#install-db-name').fill(db.database ?? '');
    await page.locator('#install-db-user').fill(db.user ?? '');
    await page.locator('#install-db-password').fill(db.password ?? '');
  }
  await button(page, 'db.test').click();
  await expect(page.getByText(W('db.result.empty'), { exact: true })).toBeVisible();
  await button(page, 'db.save').click();
}

/** Step 2 continued: the migrations, one `POST migrate` per call, to the end. */
export async function migrations(page: Page): Promise<void> {
  await expect(heading(page, 'migrate.title')).toBeVisible();
  await expect(page.getByText(W('migrate.done'), { exact: true })).toBeVisible({ timeout: 120_000 });
  await button(page, 'app.next').click();
}

/** Steps 3 to 5: the profile, the super admin, the scheduler; then step 6. */
export async function toTheEnd(page: Page, admin: WizardAdmin, library: string, o: { cron?: () => Promise<void> } = {}): Promise<void> {
  await expect(heading(page, 'profile.title')).toBeVisible();
  await page.locator('#install-library-name').fill(library);
  await expect(page.locator('#install-library-timezone')).toHaveValue('Asia/Jakarta'); // the browser's zone (playwright.config.ts)
  await page.locator('#install-branch-code').fill('PUSAT');
  await page.locator('#install-branch-name').fill('Perpustakaan Pusat');
  await button(page, 'profile.save').click();

  await expect(heading(page, 'admin.title')).toBeVisible();
  await page.locator('#install-admin-username').fill(admin.username);
  await page.locator('#install-admin-name').fill(admin.name);
  await page.locator('#install-admin-email').fill(admin.email);
  await page.locator('#install-admin-password').fill(admin.password);
  await page.locator('#install-admin-password-confirm').fill(admin.password);
  await button(page, 'admin.save').click();

  await expect(heading(page, 'cron.title')).toBeVisible();
  if (o.cron === undefined) {
    // Standalone: the worker of this process is the scheduler (optional here, required only on Passenger/LiteSpeed).
    await expect(page.getByText(W('cron.detected.worker'), { exact: true })).toBeVisible({ timeout: 30_000 });
  } else {
    // 1d Task 35, Passenger: the cron line runs (`o.cron`: POST /_cron with the cron token), then "Uji penjadwal".
    await o.cron();
    await button(page, 'cron.test').click();
    const [before, after] = W('cron.detected.cron_http').split('{time}');
    await expect(page.getByText(new RegExp(`^${escapeRegExp(before ?? '')}.+${escapeRegExp(after ?? '')}$`))).toBeVisible({ timeout: 30_000 });
  }
  await button(page, 'cron.finish').click();

  await expect(heading(page, 'done.title')).toBeVisible();
}

/** After `finish`: /install is gone (404), the code and claim files are removed, and the admin signs in. */
export async function afterFinish(page: Page, app: Pick<OwnApp, 'dataDir'> | { dataDir: string | null }, admin: WizardAdmin): Promise<void> {
  // The process leaves its install mode once `finish` is written; a request in that moment is answered 503 (the
  // phase in between), so the link is followed once the sign-in page answers.
  await expect.poll(async () => (await page.request.get('/admin/login', { maxRedirects: 0 })).status(), { timeout: 60_000 }).toBe(200);
  await page.getByRole('link', { name: W('done.login'), exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login(\?|$)/);
  await signIn(page, admin);
  await expect.poll(async () => (await page.request.get('/install', { maxRedirects: 0 })).status()).toBe(404);
  expect((await page.request.get('/install/api/checks', { maxRedirects: 0 })).status()).toBe(404);
  if (app.dataDir === null) return; // Docker: DATA_DIR is a volume
  await expect(fsp.stat(path.join(app.dataDir, 'install-code.txt'))).rejects.toThrow(/ENOENT/);
  await expect(fsp.stat(path.join(app.dataDir, 'install.lock'))).resolves.toBeTruthy();
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
