import { createMemberSession } from '@altis/core';
import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { MatrixCall, MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedMember } from './komunitas-members.js';

// The matrix rows, fixtures and maintenance entries of the member area: staff setting a member's OPAC password, and the
// OPAC member area (`/akun`). The member area's routes are public with `session: 'none'`: every persona passes the
// gate (the staff session is never read there), and each call carries what the member side wants instead
// (MatrixCall.member, matrix-fixtures.ts sendCall): a new member session and its CSRF token, or the pre-session token
// of the sign-in, forgotten-password and set-password forms. A form is sent urlencoded. Its GET pages are `allow` in
// maintenance; the sign-in, sign-out, password and data routes are `system`.

/** A member of a type of its own with a session of its own: what a member-area call carries. */
async function signedMember(s: MatrixSeed): Promise<{ id: string; member: NonNullable<MatrixCall['member']> }> {
  const m = await seedMember(s);
  const session = await withTx(s.h, (trx) =>
    createMemberSession(trx, { memberId: m.id, sessionVersion: 0, ip: null, userAgent: null, now: s.now, idleMs: 1_200_000, absoluteMs: 28_800_000 }),
  );
  return { id: m.id, member: { token: session.token, sessionId: session.id } };
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (fields: Record<string, string> = {}): string => new URLSearchParams(fields).toString();

/** A member-area page (GET) of a signed-in member. */
const page =
  (o: Pick<MatrixCall, 'params' | 'query'> = {}): MatrixFixture =>
  async (s) => ({ ...o, member: (await signedMember(s)).member });

/** A member-area form of a signed-in member; `fields` and `params` may name new ids (nothing found: the OPAC 404). */
const post =
  (fields: () => Record<string, string> = () => ({}), params?: () => Record<string, string>): MatrixFixture =>
  async (s) => ({ member: (await signedMember(s)).member, body: form(fields()), headers: FORM, ...(params === undefined ? {} : { params: params() }) });

/** A pre-session form (sign-in, forgotten password, set password). */
const pre =
  (fields: () => Record<string, string>, params?: () => Record<string, string>): MatrixFixture =>
  async () => ({ member: 'pre', body: form(fields()), headers: FORM, ...(params === undefined ? {} : { params: params() }) });

const unique = (prefix: string): string => `${prefix}${newId().slice(-12)}`;
const token = (): string => newId().padEnd(43, 'x');

const PAGE = (path: string, o: { system?: boolean; optional?: boolean } = {}): string =>
  `GET ${path} | pub- | - | - | ${o.system === true ? 'system' : 'read'} | allow | none | null | - | member:${o.optional === true ? 'optional' : 'required'}`;
const POST = (path: string, o: { mode?: string; also?: string; ip?: string; optional?: boolean } = {}): string => {
  const extras = [
    o.also === undefined ? null : `also:${o.also}`,
    o.ip === undefined ? null : `ip:${o.ip}`,
    `member:${o.optional === true ? 'optional' : 'required'}`,
    'form',
  ].filter((x) => x !== null);
  return `POST ${path} | pub- | - | - | ${o.mode ?? 'write'} | deny | none | null | self | ${extras.join(' ')}`;
};

const rows: Record<string, string> = {
  'members.password.set':
    'PUT /api/v1/members/:id/password | P:members.records.manage | - | reauth | write | deny | none | members.member.password_set | self | -',
  'akun.login.page': PAGE('/akun/masuk', { system: true, optional: true }),
  'akun.login': POST('/akun/masuk', { mode: 'system', also: 'members.self.login_locked', optional: true }),
  'akun.logout': POST('/akun/keluar', { mode: 'system' }),
  'akun.home': PAGE('/akun'),
  'akun.history': PAGE('/akun/riwayat'),
  'akun.charges': PAGE('/akun/denda'),
  'akun.loans.renew': POST('/akun/pinjaman/:id/perpanjang', { also: 'circulation.loan.renew' }),
  'akun.holds': PAGE('/akun/reservasi'),
  'akun.holds.new': PAGE('/akun/reservasi/baru'),
  'akun.holds.create': POST('/akun/reservasi', { also: 'circulation.hold.create' }),
  'akun.holds.cancel': POST('/akun/reservasi/:id/batal', { also: 'circulation.hold.cancel' }),
  'akun.bookmarks': PAGE('/akun/penanda'),
  'akun.bookmarks.new': PAGE('/akun/penanda/baru'),
  'akun.bookmarks.hold': POST('/akun/penanda/pesan', { also: 'circulation.hold.create' }),
  'akun.bookmarks.create': POST('/akun/penanda'),
  'akun.bookmarks.remove': POST('/akun/penanda/:recordId/hapus'),
  'akun.card': PAGE('/akun/kartu'),
  'akun.photo': PAGE('/akun/foto'),
  'akun.password': PAGE('/akun/sandi', { system: true }),
  'akun.password.change': POST('/akun/sandi', { mode: 'system', also: 'members.self.password_change' }),
  'akun.forgot.page': PAGE('/akun/lupa-sandi', { system: true, optional: true }),
  'akun.forgot': POST('/akun/lupa-sandi', { mode: 'system', ip: 'member_forgot:ip', optional: true }),
  'akun.reset.page': PAGE('/akun/atur-sandi/:token', { system: true, optional: true }),
  'akun.reset': POST('/akun/atur-sandi/:token', { mode: 'system', also: 'members.self.password_reset', ip: 'member_reset:ip', optional: true }),
  'akun.data': PAGE('/akun/data-saya', { system: true }),
  'akun.data.export': POST('/akun/data-saya', { mode: 'system', also: 'members.self.data_export' }),
  'akun.attachment': PAGE('/akun/lampiran/:id'),
};

const fixtures: Record<string, MatrixFixture> = {
  'members.password.set': async (s) => ({ params: { id: (await seedMember(s)).id }, body: { password: 'sandi-matriks-2026', mustReset: false } }),
  'akun.login.page': async () => ({}),
  'akun.login': pre(() => ({ memberNo: unique('ZZ'), password: 'bukan-sandinya-1' })),
  'akun.logout': post(),
  'akun.home': page(),
  'akun.history': page(),
  'akun.charges': page(),
  'akun.loans.renew': post(undefined, () => ({ id: newId() })),
  'akun.holds': page(),
  'akun.holds.new': page({ query: { cantuman: newId() } }),
  'akun.holds.create': post(() => ({ recordId: newId() })),
  'akun.holds.cancel': post(undefined, () => ({ id: newId() })),
  'akun.bookmarks': page(),
  'akun.bookmarks.new': page({ query: { cantuman: newId() } }),
  'akun.bookmarks.hold': post(() => ({ 'recordIds.0': newId() })),
  'akun.bookmarks.create': post(() => ({ recordId: newId() })),
  'akun.bookmarks.remove': post(undefined, () => ({ recordId: newId() })),
  'akun.card': page(),
  'akun.photo': page(),
  'akun.password': page(),
  'akun.password.change': post(() => ({ current: 'bukan-sandinya-1', next: 'sandi-baru-matriks', repeat: 'sandi-baru-matriks' })),
  'akun.forgot.page': async () => ({}),
  'akun.forgot': pre(() => ({ memberNo: unique('ZZ') })),
  'akun.reset.page': async () => ({ params: { token: token() } }),
  'akun.reset': pre(
    () => ({ next: 'sandi-baru-matriks', repeat: 'sandi-baru-matriks' }),
    () => ({ token: token() }),
  ),
  'akun.data': page(),
  'akun.data.export': post(() => ({ password: 'bukan-sandinya-1' })),
  'akun.attachment': page({ params: { id: newId() } }),
};

/** The member area's GET pages answer during maintenance (the OPAC is `allow`); its forms do not. */
const maintenance: Record<string, 'allow'> = Object.fromEntries(
  Object.entries(rows)
    .filter(([id, row]) => id.startsWith('akun.') && row.startsWith('GET '))
    .map(([id]) => [id, 'allow' as const]),
);

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance,
  systemRoutes: [
    'akun.login.page',
    'akun.login',
    'akun.logout',
    'akun.password',
    'akun.password.change',
    'akun.forgot.page',
    'akun.forgot',
    'akun.reset.page',
    'akun.reset',
    'akun.data',
    'akun.data.export',
  ],
};
