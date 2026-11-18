import { randomBytes } from 'node:crypto';
import type { BranchListResponse } from '@altis/shared/api/branches';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { LoanResponse } from '@altis/shared/api/circulation';
import type { MemberTypeListResponse } from '@altis/shared/api/members';
import type { CspRecorder } from '../lib/csp.js';
import { newPassword } from '../lib/api.js';
import { expect, test } from '../fixtures.js';

// The OPAC member area (`/akun`) as a member uses it, in a real browser with the CSP guard of fixtures.ts on every page:
//
//   `/akun` sends a visitor to the sign-in page; the member signs in with the member number and the password the
//   library set; the account greets the member and lists the open loans; "Perpanjang" renews one of them, and the page
//   says until when, the loan now showing one renewal of one.
//
// What the library did beforehand is made through the staff API (`staff`, the fixture super admin): a record and its
// copy, the member (type Guru, which may renew online) with a password, and a loan entered after the fact three days
// back ("Pinjaman tercatat mundur", with its note), since a loan made today cannot be renewed the same day. The general
// loan rule of a fresh install lends for 7 days with one renewal.
//
// The member area's words are the server's own (apps/server/src/opac/catalog/messages/akun.ts): the few this file looks
// for are written out below with their keys.

const AKUN_TEXT = {
  'akun.login.title': 'Masuk Anggota',
  'akun.login.member_no': 'Nomor anggota',
  'akun.login.password': 'Kata sandi',
  'akun.login.submit': 'Masuk',
  'akun.home.title': 'Akun Saya',
  'akun.loans.title': 'Pinjaman saat ini',
  'akun.loans.renewed_prefix': 'Pinjaman diperpanjang sampai ',
} as const;

/** `akun.home.greeting`. */
const greeting = (name: string): string => `Halo, ${name}`;
/** `akun.loans.renew_label`: the name of a loan's "Perpanjang" button. */
const renewLabel = (title: string): string => `Perpanjang ${title}`;
/** `akun.loans.renewals_of`. */
const renewalsOf = (n: number, limit: number): string => `${n} dari ${limit}`;

/** Random lower-case letters: one search token that no other spec writes. */
function randomLetters(n: number): string {
  return Array.from(randomBytes(n), (b) => String.fromCharCode(0x61 + (b % 26))).join('');
}

/** Runs `fn` as a reported step and requires that it caused no CSP problem (the fixture checks the test again). */
async function clean(csp: CspRecorder, name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    const mark = csp.mark();
    await fn();
    expect(csp.problems(mark), `CSP problems during "${name}"`).toEqual([]);
  });
}

/** The calendar date `days` before today (the install's time zone is the browser's, Asia/Jakarta). */
function daysAgo(days: number): string {
  const d = new Date(Date.now() + 7 * 3_600_000 - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

test('Akun: a member signs in, sees the open loans and renews one', async ({ page, csp, staff, admin }) => {
  const word = randomLetters(6);
  const Word = word.charAt(0).toUpperCase() + word.slice(1);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const title = `Riwayat Pelabuhan ${Word}`;
  const barcode = `E2E-AKUN-${tag}`;
  const member = { no: `E2E-AKUN-M${tag}`, name: `Sekar ${Word}`, password: newPassword() };

  const branches = await staff.call<BranchListResponse>('GET', 'branches');
  const branch = branches.items.find((b) => b.isDefault);
  if (branch === undefined) throw new Error('the install has no default branch');
  const materials = await staff.call<{ items: { id: string; code: string }[] }>('GET', 'catalog/material-types');
  const buku = materials.items.find((m) => m.code === 'BUKU');
  const collections = await staff.call<{ items: { id: string; code: string }[] }>('GET', 'catalog/collection-types');
  const umum = collections.items.find((c) => c.code === 'UMUM');
  const types = await staff.call<MemberTypeListResponse>('GET', 'members/types');
  const guru = types.items.find((t) => t.code === 'GURU');
  if (buku === undefined || umum === undefined || guru === undefined) throw new Error('a seeded material, collection or member type is missing');

  const record = await staff.call<StoreResponse>('POST', 'catalog/records', { materialTypeId: buku.id, title });
  await staff.call('POST', `branches/${encodeURIComponent(branch.id)}/items`, { recordId: record.id, barcode, collectionTypeId: umum.id });
  const made = await staff.call<StoreResponse>('POST', 'members', { memberNo: member.no, memberTypeId: guru.id, name: member.name, email: `akun-${word}@perpus.example` });
  // Setting a member's password asks for the staff password of the last minutes.
  await staff.reauth(admin.password);
  await staff.call('PUT', `members/${encodeURIComponent(made.id)}/password`, { password: member.password, mustReset: false });
  const loan = await staff.call<LoanResponse>('POST', `branches/${encodeURIComponent(branch.id)}/circulation/loans`, {
    memberId: made.id,
    barcode,
    loanedOn: daysAgo(3),
    override: { reasons: [], note: 'Dicatat dari daftar pinjaman kertas' },
  });

  await clean(csp, '/akun asks a visitor to sign in', async () => {
    await page.goto('/akun');
    await expect(page).toHaveURL(/\/akun\/masuk(\?|$)/);
    await expect(page.getByRole('heading', { level: 1, name: AKUN_TEXT['akun.login.title'], exact: true })).toBeVisible();
  });

  await clean(csp, 'the member signs in with the member number and the password', async () => {
    await page.getByLabel(AKUN_TEXT['akun.login.member_no'], { exact: true }).fill(member.no);
    await page.getByLabel(AKUN_TEXT['akun.login.password'], { exact: true }).fill(member.password);
    await page.getByRole('button', { name: AKUN_TEXT['akun.login.submit'], exact: true }).click();
    await expect(page).toHaveURL(/\/akun(\?|$)/);
    await expect(page.getByText(greeting(member.name), { exact: true })).toBeVisible();
  });

  const loans = page.getByRole('region', { name: AKUN_TEXT['akun.loans.title'], exact: true });
  const row = loans.getByRole('row').filter({ hasText: title });

  await clean(csp, 'the account lists the open loan', async () => {
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(barcode);
    await expect(row).toContainText(renewalsOf(0, 1));
  });

  await clean(csp, '"Perpanjang": the loan is renewed, the page says until when', async () => {
    await row.getByRole('button', { name: renewLabel(title), exact: true }).click();
    await expect(page).toHaveURL(/\/akun\?pesan=renewed/);
    await expect(page.getByText(AKUN_TEXT['akun.loans.renewed_prefix'])).toBeVisible();
    await expect(row).toContainText(renewalsOf(1, 1));
  });

  // The desk sees the renewal too: a week from today.
  const after = await staff.call<{ items: { id: string; dueOn: string; renewals: number }[] }>('GET', `circulation/loans?memberId=${encodeURIComponent(made.id)}`);
  const renewed = after.items.find((l) => l.id === loan.id);
  expect(renewed?.renewals).toBe(1);
  expect(renewed?.dueOn).toBe(daysAgo(-7));
});
