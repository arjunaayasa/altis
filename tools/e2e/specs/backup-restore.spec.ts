import fsp from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { BackupItem, BackupListResponse } from '@altis/shared/api/backups';
import { ApiError, StaffApi, createStaff, type RequestFactory, type StaffUser } from '../lib/api.js';
import { T, expect, passReauth, signIn, test } from '../fixtures.js';

// Backup and restore through the admin UI (spec §9.9, §9.10, §13.3 "Backup"; acceptance A6; plan 1c Task 34), on the
// suite's install (standalone, SQLite, the worker running):
//
//   1. "Buat sekarang": a snapshot backup run by the worker; the list shows it "Berhasil" without a reload, and the
//      bell has the notification "Cadangan selesai";
//   2. "Siapkan unduhan" with a passphrase (re-authenticated), then "Unduh arsip": the encrypted .altisbak;
//   3. the data changes: a staff user is added after the backup;
//   4. "Unggah" of that archive: an uploaded (external) backup in the list;
//   5. "Pulihkan" of the uploaded archive with its passphrase (and this library's name, the confirmation of an
//      external archive): the page goes to /admin/_update, which shows the restore's progress until "Operasi selesai";
//   6. the data is back: the user made before the backup is there, the one added after it is gone; the super admin
//      signs in again (a restore ends every session) and lands on Beranda.
//
// The restore replaces the database with the backup's: everything this file does before the backup (and every spec
// before it) is kept, everything after it is not; the specs after it make their own users. Every page runs under the
// CSP guard of fixtures.ts (the operations page included).

const PASSPHRASE = 'Frasa sandi cadangan E2E 2026';

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A button whose accessible name starts with `text` (the backup list's actions name the backup's time after it). */
const startsWith = (text: string): RegExp => new RegExp(`^${escapeRe(text)}`);

/** The bell with unread notifications: "Notifikasi, <n> belum dibaca". */
const unreadBell = (): RegExp => new RegExp(`^${escapeRe(T('notifications.bell_unread', { count: 999 })).replace('999', '\\d+')}$`);

/** The backups `staff` sees that were not in `before`. */
async function newBackups(staff: StaffApi, before: ReadonlySet<string>): Promise<BackupItem[]> {
  return (await staff.call<BackupListResponse>('GET', 'backups')).items.filter((i) => !before.has(i.id));
}

/** Whether staff user `user` exists, read through a fresh session (`GET users/:id`). */
async function userExists(api: StaffApi, user: StaffUser): Promise<boolean> {
  try {
    await api.call('GET', `users/${encodeURIComponent(user.id)}`);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

/** A session of `admin` once the install answers again (a restart and a maintenance flag going away), within 90 s. */
async function signedInWhenBack(request: RequestFactory, baseURL: string, admin: { username: string; password: string }): Promise<StaffApi> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    let api: StaffApi | null = null;
    try {
      api = await StaffApi.open(request, baseURL);
      await api.signIn(admin.username, admin.password);
      return api;
    } catch (error) {
      await api?.dispose();
      const passing = (error instanceof ApiError && (error.code === 'MAINTENANCE' || error.status === 503)) || /ECONNREFUSED|ECONNRESET|socket hang up/.test(String(error));
      if (!passing || Date.now() > deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function openBackups(page: Page): Promise<void> {
  await page.goto('/admin/backups');
  await expect(page.getByRole('heading', { level: 1, name: T('nav.backups'), exact: true })).toBeVisible();
}

test('A6 through the UI: backup, download with a passphrase, change, upload, restore with the passphrase', async ({ page, staff, admin, playwright, baseURL }, testInfo) => {
  test.setTimeout(420_000);
  const library = (await staff.me()).library.name;
  const before = new Set((await staff.call<BackupListResponse>('GET', 'backups')).items.map((i) => i.id));
  const kept = await createStaff(staff, 'sebelum');

  // 1. A backup now: a snapshot the worker runs; the list follows it, the bell says it is done.
  await signIn(page, admin);
  await openBackups(page);
  await page.getByRole('button', { name: T('backups.create.submit'), exact: true }).click();
  await expect(page.getByText(T('backups.create.started'), { exact: true })).toBeVisible();
  await expect.poll(async () => (await newBackups(staff, before)).map((b) => `${b.kind}/${b.consistency}/${b.status}`), { timeout: 60_000 }).toEqual(['manual/snapshot/ok']);
  const made = (await newBackups(staff, before))[0]!;
  const madeRow = page.getByRole('row').filter({ hasText: T('backups.kind.manual') });
  await expect(madeRow.getByText(T('backups.status.ok'), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: unreadBell() }).click();
  const panel = page.getByRole('dialog', { name: T('notifications.title') });
  await expect(panel.getByText(T('notification.backup_done.title'), { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // 2. The download, prepared with a passphrase (the first reauth of this session), then fetched.
  await madeRow.getByRole('button', { name: startsWith(T('backups.action.prepare')) }).click();
  const prepare = page.getByRole('dialog', { name: T('backups.prepare.title') });
  await prepare.getByLabel(T('backups.prepare.passphrase'), { exact: true }).fill(PASSPHRASE);
  await prepare.getByLabel(T('backups.prepare.passphrase_again'), { exact: true }).fill(PASSPHRASE);
  await prepare.getByRole('button', { name: T('backups.prepare.submit'), exact: true }).click();
  await passReauth(page, admin.password, { expectDialog: true });
  const link = prepare.getByRole('link', { name: T('backups.prepare.download'), exact: true });
  await expect(link).toBeVisible({ timeout: 120_000 });
  const downloading = page.waitForEvent('download');
  await link.click();
  const archive = testInfo.outputPath(`backup-${made.id}.altisbak`);
  await (await downloading).saveAs(archive);
  expect((await fsp.stat(archive)).size).toBeGreaterThan(1024);
  await page.keyboard.press('Escape');
  await expect(prepare).toBeHidden();

  // 3. The data changes after the backup.
  const added = await createStaff(staff, 'sesudah');

  // 4. The archive uploaded back: an external backup in the list.
  await page.getByLabel(T('backups.upload.file'), { exact: true }).setInputFiles(archive);
  await page.getByRole('button', { name: T('backups.upload.submit'), exact: true }).click();
  const uploaded = page.getByText(T('backups.upload.done'), { exact: true });
  await passReauth(page, admin.password, { next: uploaded });
  await expect(uploaded).toBeVisible({ timeout: 60_000 });
  const archiveRow = page.getByRole('row').filter({ hasText: T('backups.status.uploaded') });
  await expect(archiveRow).toHaveCount(1);

  // 5. Restore from it, with its passphrase; the operations page follows the op to its end.
  await archiveRow.getByRole('button', { name: startsWith(T('backups.action.restore')) }).click();
  const restore = page.getByRole('dialog', { name: T('backups.restore.title') });
  await restore.getByLabel(T('backups.restore.passphrase'), { exact: true }).fill(PASSPHRASE);
  const confirmName = restore.getByLabel(T('backups.restore.confirm_name', { name: library }), { exact: true });
  if (await confirmName.isVisible()) await confirmName.fill(library);
  await restore.getByRole('button', { name: T('backups.restore.submit'), exact: true }).click();
  const opKind = page.locator('#op-kind');
  await passReauth(page, admin.password, { next: opKind });
  await expect(page).toHaveURL(/\/admin\/_update$/);
  await expect(opKind).toHaveText(T('ops.kind.restore'));
  await expect(page.locator('#op-progress')).toBeVisible();
  await expect(page.locator('#op-state')).not.toHaveText('');
  await expect(page.locator('#done')).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('#op-percent')).toHaveText('100%');

  // 6. The data of the backup is back. After `done` the server restarts (a restore raises the data epoch, P14) and
  //    the maintenance flag is seen gone at each process's next fence: read again until the install answers.
  await page.waitForURL((url) => url.pathname !== '/admin/_update', { timeout: 30_000 });
  const t0 = Date.now();
  const fresh = await signedInWhenBack(playwright.request, baseURL!, admin);
  testInfo.annotations.push({ type: 'back after done', description: `${Date.now() - t0} ms` });
  try {
    expect(await userExists(fresh, kept), `${kept.username}, made before the backup`).toBe(true);
    expect(await userExists(fresh, added), `${added.username}, added after the backup`).toBe(false);
  } finally {
    await fresh.dispose();
  }
  // The admin works again: a sign-in afresh (a restore ends every session), sent again while the server restarts
  // (the data epoch's restart follows `done` by a fence and a drain: the page's own redirect may meet it).
  await expect(async () => {
    await signIn(page, admin);
  }).toPass({ timeout: 60_000 });
});
