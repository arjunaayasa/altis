import { randomBytes } from 'node:crypto';
import type { MemberTypeListResponse } from '@altis/shared/api/members';
import type { CspRecorder } from '../lib/csp.js';
import { T, expect, signIn, test } from '../fixtures.js';
import { openNavPage } from '../lib/nav.js';

// The guestbook of a library, end to end, in a real browser with the CSP guard of fixtures.ts on every page:
//
//   in Layanan → Buku Tamu the librarian adds a station and gets its activation code, shown once; on the station's own
//   device (a browser of its own, no staff session) `/kunjungan` asks for the code, "Aktifkan" pairs the device and the
//   check-in page opens; a member types the member number and is greeted by first name, the visit recorded; in
//   Layanan → Kunjungan the visit is listed under today's visits with the member and the source "Buku tamu".
//
// The member is made through the API (`staff`, the fixture super admin). The admin's words come from its catalogues
// (lib/text.ts); the station page is the server's own (apps/server/src/opac/catalog/messages/visits.ts): the few words
// this file looks for are written out below with their keys.

const STATION_TEXT = {
  'visits.activate_title': 'Aktifkan buku tamu',
  'visits.activate_code': 'Kode aktivasi',
  'visits.activate_submit': 'Aktifkan',
  'visits.member_no': 'Nomor anggota',
  'visits.submit': 'Masuk',
  'visits.recorded': 'Kunjungan Anda sudah dicatat.',
} as const;

/** `visits.greeting` with the member's first name. */
const greeting = (name: string): string => `Selamat datang, ${name}!`;

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

test('Buku Tamu: a station activated with its code records a member\'s visit, listed in Kunjungan', async ({ page, csp, staff, admin, newContext }) => {
  const word = randomLetters(6);
  const Word = word.charAt(0).toUpperCase() + word.slice(1);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const stationName = `Pintu depan ${Word}`;
  const member = { no: `E2E-TAMU-${tag}`, name: `Wulan ${Word}` };

  const types = await staff.call<MemberTypeListResponse>('GET', 'members/types');
  const umum = types.items.find((t) => t.code === 'UMUM');
  if (umum === undefined) throw new Error('the seeded member type UMUM is missing');
  await staff.call('POST', 'members', { memberNo: member.no, memberTypeId: umum.id, name: member.name, email: `tamu-${word}@perpus.example` });

  await clean(csp, 'sign in', async () => {
    await signIn(page, admin);
  });

  let code = '';
  await clean(csp, 'Buku Tamu: a new station and its activation code', async () => {
    await openNavPage(page, '/admin/layanan/buku-tamu');
    await expect(page).toHaveURL(/\/admin\/layanan\/buku-tamu$/);
    await expect(page.getByRole('heading', { level: 1, name: T('visits.stations.title'), exact: true })).toBeVisible();
    const form = page.getByRole('form', { name: T('visits.stations.create') });
    await form.getByLabel(T('visits.stations.name'), { exact: true }).fill(stationName);
    await form.getByRole('button', { name: T('visits.stations.create'), exact: true }).click();
    const shown = page.getByRole('status').filter({ hasText: T('visits.stations.code_title', { name: stationName }) });
    await expect(shown).toBeVisible();
    code = ((await shown.locator('p[translate="no"]').textContent()) ?? '').trim();
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const row = page.getByRole('table', { name: T('visits.stations.title') }).getByRole('row').filter({ hasText: stationName });
    await expect(row).toHaveCount(1);
  });

  const device = await newContext();
  const station = await device.newPage();

  await clean(csp, 'the station\'s device: the code pairs it, the check-in page opens', async () => {
    await station.goto('/kunjungan');
    await expect(station).toHaveURL(/\/kunjungan\/aktifkan$/);
    await expect(station.getByRole('heading', { level: 1, name: STATION_TEXT['visits.activate_title'], exact: true })).toBeVisible();
    await station.getByLabel(STATION_TEXT['visits.activate_code'], { exact: true }).fill(code);
    await station.getByRole('button', { name: STATION_TEXT['visits.activate_submit'], exact: true }).click();
    await expect(station).toHaveURL(/\/kunjungan$/);
    await expect(station.getByLabel(STATION_TEXT['visits.member_no'], { exact: true })).toBeVisible();
  });

  await clean(csp, 'the station: a member checks in with the member number and is greeted', async () => {
    await station.getByLabel(STATION_TEXT['visits.member_no'], { exact: true }).fill(member.no);
    await station.getByRole('button', { name: STATION_TEXT['visits.submit'], exact: true }).click();
    const greeted = station.getByRole('status');
    await expect(greeted).toContainText(greeting('Wulan'));
    await expect(greeted).toContainText(STATION_TEXT['visits.recorded']);
  });

  await clean(csp, 'Buku Tamu: the station is shown as active (paired)', async () => {
    await page.reload();
    const row = page.getByRole('table', { name: T('visits.stations.title') }).getByRole('row').filter({ hasText: stationName });
    await expect(row).toContainText(T('visits.stations.state.paired'));
  });

  await clean(csp, 'Kunjungan: the visit is listed with the member and the source', async () => {
    await openNavPage(page, '/admin/layanan/kunjungan');
    await expect(page).toHaveURL(/\/admin\/layanan\/kunjungan$/);
    await expect(page.getByRole('heading', { level: 1, name: T('visits.title'), exact: true })).toBeVisible();
    const row = page.getByRole('table', { name: T('visits.list.title') }).getByRole('row').filter({ hasText: `${member.no} — ${member.name}` });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(T('vocab.visit_source.station'));
  });
});
