import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import type { BranchListResponse } from '@altis/shared/api/branches';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { StaffApi } from '../lib/api.js';
import type { CspRecorder } from '../lib/csp.js';
import { T, expect, signIn, test } from '../fixtures.js';
import { openNavPage } from '../lib/nav.js';

// The circulation desk (Layanan → Meja Layanan) through one member's visit, as a librarian works it with a scanner, in
// a real browser with the CSP guard of fixtures.ts on every page:
//
//   the member's card is scanned and the member panel opens; a copy is scanned and lent; on the Dipinjam tab a loan of
//   three days ago is renewed; in the Kembali mode the copy lent just now comes back on time and a loan ten days old
//   comes back three days late, which books an overdue fine; back with the member, a hold is placed on a title whose
//   only copy another member has; that copy comes back and the desk says to keep it for the member; Rak Tunggu lists it
//   ready; the member picks it up (the copy scanned at the desk lends it and fulfils the hold); on the Denda tab the
//   fine is paid in full and the desk gives the receipt.
//
// What the desk works on is made through the staff API (`staff`, the fixture super admin): a member type of this run
// with its own loan rule (7 days, two renewals, a fine of 500 a day late, so no other spec's loans change), four
// records with a copy each, the member and another member, and the loans that happened before the visit, entered
// after the fact ("Pinjaman tercatat mundur", with a note), as the desk does for a paper list.
//
// The screens' words come from the admin catalogues (lib/text.ts).

/** Random lower-case letters: one search token that no other spec writes. */
function randomLetters(n: number): string {
  return Array.from(randomBytes(n), (b) => String.fromCharCode(0x61 + (b % 26))).join('');
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text before the first placeholder of a message: what every variant of it starts with. */
const lead = (text: string): RegExp => new RegExp(`^\\s*${escapeRe(text.split('{')[0]!.trim())}`);

/** Runs `fn` as a reported step and requires that it caused no CSP problem (the fixture checks the test again). */
async function clean(csp: CspRecorder, name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    const mark = csp.mark();
    await fn();
    expect(csp.problems(mark), `CSP problems during "${name}"`).toEqual([]);
  });
}

/** The calendar date `days` before today in the library's time zone (Asia/Jakarta, UTC+7). */
function daysAgo(days: number): string {
  return new Date(Date.now() + 7 * 3_600_000 - days * 86_400_000).toISOString().slice(0, 10);
}

/** The desk's outcome of the last scan: its sentence (the first paragraph) and the rest. */
function feedback(page: Page): Locator {
  return page.getByTestId('desk-feedback');
}

/** Types `code` into the scan box and processes it, as a scanner does (the code, then Enter). */
async function scan(page: Page, code: string): Promise<void> {
  const box = page.locator('input[enterkeyhint="go"]');
  await box.fill(code);
  await box.press('Enter');
}

/** The desk's mode switch: `label` is the mode's short name. */
async function switchMode(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: T('circulation.mode.label') }).getByRole('button', { name: new RegExp(`^${escapeRe(label)}`) }).click();
}

/** A record of the run with one copy at `branchId`: its id. */
async function recordWithCopy(staff: StaffApi, o: { branchId: string; materialTypeId: string; collectionTypeId: string; title: string; barcode: string }): Promise<string> {
  const record = await staff.call<StoreResponse>('POST', 'catalog/records', { materialTypeId: o.materialTypeId, title: o.title });
  await staff.call('POST', `branches/${encodeURIComponent(o.branchId)}/items`, { recordId: record.id, barcode: o.barcode, collectionTypeId: o.collectionTypeId });
  return record.id;
}

test('Meja Layanan: lend, renew, return (on time and late), a hold filled from the hold shelf, and the fine paid', async ({ page, csp, staff, admin }) => {
  test.setTimeout(5 * 60_000);
  const word = randomLetters(6);
  const Word = word.charAt(0).toUpperCase() + word.slice(1);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const copy = (n: string) => ({ title: `${n} ${Word}`, barcode: `E2E-MEJA-${tag}-${n.slice(0, 3).toUpperCase()}` });
  const lent = copy('Atlas Sungai');
  const renewed = copy('Babad Pesisir');
  const late = copy('Cerita Lereng');
  const held = copy('Dongeng Muara');
  const member = { no: `E2E-MEJA-${tag}-1`, name: `Gilang ${Word}` };
  const other = { no: `E2E-MEJA-${tag}-2`, name: `Hesti ${Word}` };

  // ---- what the library has before the visit ----
  const branches = await staff.call<BranchListResponse>('GET', 'branches');
  const branch = branches.items.find((b) => b.isDefault);
  if (branch === undefined) throw new Error('the install has no default branch');
  const materials = await staff.call<{ items: { id: string; code: string }[] }>('GET', 'catalog/material-types');
  const buku = materials.items.find((m) => m.code === 'BUKU');
  const collections = await staff.call<{ items: { id: string; code: string }[] }>('GET', 'catalog/collection-types');
  const umum = collections.items.find((c) => c.code === 'UMUM');
  if (buku === undefined || umum === undefined) throw new Error('a seeded material or collection type is missing');
  const type = await staff.call<StoreResponse>('POST', 'members/types', {
    code: `MEJA${tag}`,
    nameId: `Anggota meja ${Word}`,
    accredGroup: 'public',
    membershipDays: 365,
    loanLimit: null,
  });
  await staff.call('POST', 'circulation/policies', {
    code: `MEJA${tag}`,
    name: `Aturan meja ${Word}`,
    memberTypeId: type.id,
    loanable: true,
    loanDays: 7,
    loanLimit: null,
    renewLimit: 2,
    finePerDay: '500',
  });
  const where = { branchId: branch.id, materialTypeId: buku.id, collectionTypeId: umum.id };
  for (const c of [lent, renewed, late, held]) await recordWithCopy(staff, { ...where, ...c });
  const memberId = (await staff.call<StoreResponse>('POST', 'members', { memberNo: member.no, memberTypeId: type.id, name: member.name, email: `meja-${word}@perpus.example` })).id;
  const otherId = (await staff.call<StoreResponse>('POST', 'members', { memberNo: other.no, memberTypeId: type.id, name: other.name })).id;
  const backdated = (memberIdOf: string, barcode: string, days: number) =>
    staff.call('POST', `branches/${encodeURIComponent(branch.id)}/circulation/loans`, {
      memberId: memberIdOf,
      barcode,
      loanedOn: daysAgo(days),
      override: { reasons: [], note: 'Dicatat dari daftar pinjaman kertas' },
    });
  await backdated(memberId, renewed.barcode, 3);
  await backdated(memberId, late.barcode, 10);
  await backdated(otherId, held.barcode, 2);

  const memberPanel = page.getByRole('complementary', { name: member.name });

  await clean(csp, 'sign in', async () => {
    await signIn(page, admin);
  });

  await clean(csp, 'Meja Layanan: the member card is scanned, the member panel opens', async () => {
    await openNavPage(page, '/admin/layanan');
    await expect(page).toHaveURL(/\/admin\/layanan$/);
    await expect(page.getByRole('heading', { level: 1, name: T('nav.circulation.desk'), exact: true })).toBeVisible();
    await expect(page.getByLabel(T('circulation.scan.member'), { exact: true })).toBeFocused();
    await scan(page, member.no);
    await expect(feedback(page)).toContainText(T('circulation.feedback.member_loaded', { name: member.name }));
    await expect(memberPanel).toBeVisible();
    await expect(page.getByLabel(T('circulation.scan.item', { name: member.name }), { exact: true })).toBeVisible();
  });

  await clean(csp, 'pinjam: a copy scanned is lent to the member', async () => {
    await scan(page, lent.barcode);
    await expect(feedback(page).locator('p').first()).toHaveText(lead(T('circulation.feedback.lent')));
    await expect(feedback(page)).toContainText(lent.title);
    await expect(page.getByRole('tab', { name: T('circulation.tab.loans', { count: 3 }), exact: true })).toBeVisible();
  });

  await clean(csp, 'perpanjang: the loan of three days ago is renewed on the Dipinjam tab', async () => {
    await page.getByRole('tab', { name: T('circulation.tab.loans', { count: 3 }), exact: true }).click();
    const loans = page.getByRole('table', { name: T('circulation.loans.caption', { name: member.name }) });
    const row = loans.getByRole('row').filter({ hasText: renewed.barcode });
    await expect(row).toContainText(T('circulation.loans.renewals', { count: 0, limit: 2 }));
    await row.getByRole('button', { name: T('circulation.action.renew'), exact: true }).click();
    await expect(feedback(page).locator('p').first()).toHaveText(lead(T('circulation.feedback.renewed')));
    await expect(feedback(page)).toContainText(renewed.title);
    await expect(row).toContainText(T('circulation.loans.renewals', { count: 1, limit: 2 }));
  });

  await clean(csp, 'kembali: one copy back on time, one three days late (a fine is booked)', async () => {
    await switchMode(page, T('circulation.mode.return_short'));
    await expect(page.getByLabel(T('circulation.scan.return'), { exact: true })).toBeVisible();
    await scan(page, lent.barcode);
    await expect(feedback(page).locator('p').first()).toHaveText(T('circulation.feedback.returned'));
    await scan(page, late.barcode);
    // Three days late; the fine leaves out the days the library is closed, which the sentence then names too.
    await expect(feedback(page).locator('p').first()).toHaveText(lead(T('circulation.feedback.returned_late')));
    await expect(feedback(page)).toContainText(late.title);
    const returns = page.getByRole('table', { name: T('circulation.returns.caption') });
    await expect(returns.getByRole('row').filter({ hasText: lent.barcode })).toHaveCount(1);
    await expect(returns.getByRole('row').filter({ hasText: late.barcode })).toHaveCount(1);
  });

  await clean(csp, 'reservasi: a hold placed for the member on a title out on loan', async () => {
    await switchMode(page, T('circulation.mode.member_short'));
    await expect(memberPanel).toBeVisible();
    await page.getByRole('tab', { name: T('holds.member.tab', { count: 0 }), exact: true }).click();
    await page.getByRole('button', { name: T('holds.action.add'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: T('holds.place.title', { name: member.name }) });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(T('holds.place.search'), { exact: true }).fill(held.title);
    await dialog.getByRole('button', { name: T('holds.place.search'), exact: true }).click();
    const result = dialog.getByRole('listitem').filter({ hasText: held.title });
    await expect(result).toHaveCount(1);
    await result.getByRole('button', { name: T('holds.place.submit'), exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(feedback(page)).toContainText(T('holds.place.done', { title: held.title, position: 1 }));
    const holds = page.getByRole('table', { name: T('holds.member.caption', { name: member.name }) });
    await expect(holds.getByRole('row').filter({ hasText: held.title })).toContainText(T('vocab.hold_status.waiting'));
  });

  await clean(csp, 'kembali: the held title comes back from the other member and is kept for this one', async () => {
    await switchMode(page, T('circulation.mode.return_short'));
    await scan(page, held.barcode);
    await expect(feedback(page).locator('p').first()).toHaveText(T('holds.desk.keep_for', { no: member.no }));
    await expect(feedback(page).getByRole('link', { name: T('holds.action.print_slip'), exact: true })).toHaveAttribute('href', /\/circulation\/holds\/[0-9A-HJKMNP-TV-Z]{26}\/slip$/);
  });

  await clean(csp, 'Rak Tunggu: the copy is listed ready for the member', async () => {
    await openNavPage(page, '/admin/layanan/rak-tunggu');
    await expect(page).toHaveURL(/\/admin\/layanan\/rak-tunggu$/);
    await expect(page.getByRole('heading', { level: 1, name: T('nav.circulation.hold_shelf'), exact: true })).toBeVisible();
    const ready = page.getByRole('table', { name: new RegExp(`^${escapeRe(T('holds.shelf.ready', { count: 0 }).replace(/\s*\(.*$/, ''))}`) });
    const row = ready.getByRole('row').filter({ hasText: held.title });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(member.no);
  });

  await clean(csp, 'ambil: the member picks the copy up at the desk, the hold is fulfilled', async () => {
    await openNavPage(page, '/admin/layanan');
    await scan(page, member.no);
    await expect(memberPanel).toBeVisible();
    await scan(page, held.barcode);
    await expect(feedback(page).locator('p').first()).toHaveText(lead(T('circulation.feedback.lent')));
    await expect(feedback(page)).toContainText(held.title);
    await expect(page.getByRole('tab', { name: T('holds.member.tab', { count: 0 }), exact: true })).toBeVisible();
  });

  await clean(csp, 'bayar denda: the overdue fine is paid in full on the Denda tab', async () => {
    await page.getByRole('tab', { name: T('charges.member.tab', { count: 1 }), exact: true }).click();
    const charges = page.getByRole('table', { name: T('charges.panel.caption', { name: member.name }) });
    await expect(charges.getByRole('row').filter({ hasText: T('vocab.charge_kind.overdue') })).toHaveCount(1);
    await page.getByRole('button', { name: T('charges.action.pay_all'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: T('charges.pay.title') });
    await expect(dialog).toBeVisible();
    // The amount is the whole balance; cash is the default method.
    await expect(dialog.getByLabel(T('charges.pay.amount'), { exact: true })).not.toHaveValue('');
    await dialog.getByRole('button', { name: T('charges.pay.submit'), exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(feedback(page).locator('p').first()).toHaveText(lead(T('charges.pay.done')));
    await expect(feedback(page).getByRole('link', { name: lead(T('charges.pay.print')) })).toHaveAttribute('href', /\/circulation\/payments\/[0-9A-HJKMNP-TV-Z]{26}\/receipt/);
    await expect(charges.getByText(T('charges.panel.empty'), { exact: true })).toBeVisible();
  });
});
