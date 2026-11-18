import {
  MEMBER_RESET_TTL_MS,
  addBookmark,
  cancelHold,
  changeMemberPassword,
  checkMemberPasswordPolicy,
  completeMemberReset,
  confirmMemberPassword,
  createJobRegistry,
  enqueueMemberResetMail,
  hit,
  holdSettings,
  localStorageDriver,
  memberAttachment,
  memberBalances,
  memberBookmarks,
  memberDataExport,
  memberHolds,
  memberLoans,
  memberLogin,
  memberOwnCharges,
  memberResetSubject,
  memberResetMailJob,
  memberSelf,
  memberTypeName,
  normalizeMemberNo,
  onlineRenewalOpen,
  ownLoanForRenewal,
  pickupBranchFor,
  placeHold,
  publishedRecordTitle,
  recordUrlPath,
  removeBookmark,
  renewOwnLoan,
  revokeMemberSession,
  startMemberReset,
  type JobRegistry,
  type MemberSelf,
} from '@altis/core';
import { DomainError, RENEW_REFUSALS, isDomainError, isUlid, t, type Locale } from '@altis/shared';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { z } from 'zod';
import { clearAuthCookie } from '../../http/cookies.js';
import { ensurePreSessionCsrf } from '../../http/csrf.js';
import { memberRedirect, memberSessionLimits, setMemberSessionCookie } from '../../http/member-auth.js';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { linkableUrl } from '../catalog/attachment-viewer.js';
import { OPAC_CATALOG_ROUTES } from '../catalog/index.js';
import { opacText } from '../catalog/messages.js';
import { PageHead } from '../layout.js';
import { opacContext, opacPage, requestLang, type OpacContext } from '../catalog/page.js';
import { withLang } from '../catalog/urls.js';
import { OPAC_ROUTES } from '../routes.js';
import { safeLanjut } from './lanjut.js';
import {
  AkunFrame,
  BalanceNote,
  BookmarkConfirmView,
  BookmarksView,
  CardView,
  ChargesView,
  DataView,
  Flash,
  ForgotView,
  HistoryView,
  HoldConfirmView,
  HoldResultsView,
  HoldsView,
  LoginView,
  MemberSummary,
  OpenLoans,
  PasswordView,
  ResetView,
  day,
  holdRefusalText,
  type AkunTab,
  type Keep,
} from './views.js';

// The OPAC member area (`/akun`): the pages of a member signed in with the member number and a password, apart from the
// staff sessions (http/member-auth.ts, http/route.ts "member area"). Every route is public with `session: 'none'` and
// `member` (`required` but for the sign-in, forgotten-password and set-password pages); every page is `noindex` and
// `private, no-store`; every form posts `application/x-www-form-urlencoded` with the CSRF token in `_csrf` and answers
// with a 303 to the page that shows the outcome (`?pesan=<code>` from a fixed list, never a personal value), or with
// the form again when a field must be fixed.
//
// Ownership: a loan, a hold or a bookmark named in the path is read with the session's member in the WHERE; one of
// another member is the OPAC 404 page, the same as one that does not exist. A record named by `?cantuman=` must be one
// the OPAC shows.
//
// Every write runs `tx: 'self'` with its own short transaction: the pages a refusal answers with read the settings and
// the catalogue through the database handle, which must not wait on a transaction of the same request (SQLite has one
// connection).
//
// Audits: a renewal, a hold placed or cancelled, the member's password changed or reset, and the download of the
// member's own data are written with the member as actor (`alsoAudits`, so that a refused one, which writes nothing,
// is no AUDIT_MISSING); a sign-in bucket that just filled writes `members.self.login_locked`.

type Rc = RouteContext<unknown, unknown, unknown>;
type RcOf<B> = RouteContext<B, unknown, unknown>;

/** What every member route declares. */
const PAGE = { method: 'GET', public: true, session: 'none', member: 'required', maintenance: 'allow', idempotency: 'none', audit: null } as const;
const FORM = { method: 'POST', public: true, session: 'none', member: 'required', form: true, idempotency: 'none' } as const;

/** The page headers of the member area. */
const PRIVATE = 'private, no-store';

/** The most titles one "Pesan yang dipilih" holds. */
const HOLD_SELECTED_MAX = 20;

// ---------------------------------------------------------------------------------------------------------------
// The frame

interface Akun {
  ctx: OpacContext;
  locale: Locale;
  keep: Keep;
}

async function akunOf(rc: Rc): Promise<Akun> {
  const ctx = await opacContext(rc);
  const lang = requestLang(rc.c);
  return { ctx, locale: ctx.locale, keep: (path) => (lang === null ? path : withLang(path, lang)) };
}

/** A member-area page: inside the account frame when `tab` is given (null: the frame without a current tab). */
function page(
  rc: Rc,
  a: Akun,
  o: { title: string; tab?: AkunTab | null; status?: number; body: () => JSX.Element | (JSX.Element | null)[] | null },
): Response {
  const csrf = rc.member?.csrf ?? '';
  return opacPage(rc, a.ctx, {
    status: o.status ?? 200,
    title: `${o.title} · ${a.ctx.libraryName}`,
    robots: 'noindex',
    canonicalPath: null,
    openGraph: false,
    cacheControl: PRIVATE,
    pageHead: () => (
      <PageHead locale={a.locale} crumbs={[{ label: opacText(a.locale, 'shell.menu.home'), href: a.keep('/') }, { label: opacText(a.locale, 'akun.header.link') }]} />
    ),
    body: () =>
      o.tab === undefined ? (
        <>{o.body()}</>
      ) : (
        <AkunFrame locale={a.locale} keep={a.keep} title={o.title} active={o.tab} csrf={csrf}>
          {o.body()}
        </AkunFrame>
      ),
  });
}

/** The OPAC 404 page in the member area: another member's loan, hold or bookmark is the same as none. */
function notFound(rc: Rc, a: Akun): Response {
  return page(rc, a, {
    status: 404,
    title: t(a.locale, 'opac.not_found.title'),
    body: () => (
      <>
        <h1>{t(a.locale, 'opac.not_found.title')}</h1>
        <p>{t(a.locale, 'opac.not_found.body')}</p>
      </>
    ),
  });
}

/** The query value `name` (the first), or undefined. */
function q(rc: Rc, name: string): string | undefined {
  return rc.c.req.query(name);
}

/** The page number of `?hal=` (1 when absent or not a number). */
function pageNo(rc: Rc): number {
  const n = Number(q(rc, 'hal'));
  return Number.isSafeInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

/** The signed-in member (the route is `member: 'required'`). */
function memberId(rc: Rc): string {
  if (rc.member === null) throw new DomainError('AUTH_REQUIRED');
  return rc.member.memberId;
}

/** The OPAC routes a `lanjut` may name (read when called: this module's own list is defined below). */
let lanjutList: readonly RouteDecl[] | undefined;
const lanjutRoutes = (): readonly RouteDecl[] => (lanjutList ??= [...OPAC_CATALOG_ROUTES, ...OPAC_ROUTES, ...AKUN_ROUTES]);

/** The outcome codes a page shows from `?pesan=` (a fixed list). */
function flash(rc: Rc, a: Akun): JSX.Element | null {
  const code = q(rc, 'pesan');
  const { locale } = a;
  switch (code) {
    case 'renewed': {
      const until = q(rc, 'sampai') ?? '';
      return /^\d{4}-\d{2}-\d{2}$/.test(until) ? <Flash kind="ok" text={opacText(locale, 'akun.loans.renewed', { date: day(locale, until) })} /> : null;
    }
    case 'renew_refused': {
      const reason = q(rc, 'alasan') ?? '';
      const known = (RENEW_REFUSALS as readonly string[]).includes(reason) || reason === 'not_open';
      return <Flash kind="warn" text={opacText(locale, known ? (`akun.renew.refused.${reason}` as 'akun.renew.refused.limit') : 'akun.renew.refused.other')} />;
    }
    case 'hold_placed': {
      const n = q(rc, 'antrean') ?? '';
      return <Flash kind="ok" text={/^\d{1,5}$/.test(n) ? opacText(locale, 'akun.holds.placed', { n }) : opacText(locale, 'akun.holds.placed_ready')} />;
    }
    case 'hold_cancelled':
      return <Flash kind="ok" text={opacText(locale, 'akun.holds.cancelled')} />;
    case 'bookmark_added':
      return <Flash kind="ok" text={opacText(locale, 'akun.bookmarks.added')} />;
    case 'bookmark_already':
      return <Flash kind="ok" text={opacText(locale, 'akun.bookmarks.already')} />;
    case 'bookmark_removed':
      return <Flash kind="ok" text={opacText(locale, 'akun.bookmarks.removed')} />;
    case 'bookmark_limit':
      return <Flash kind="warn" text={opacText(locale, 'akun.bookmarks.limit', { max: 200 })} />;
    case 'password_saved':
      return <Flash kind="ok" text={opacText(locale, 'akun.password.saved')} />;
    default:
      return null;
  }
}

/** The words of a refused password (the policy, a wrong current password, too many attempts, a busy server). */
function passwordError(locale: Locale, error: unknown, min: number): string | null {
  if (!isDomainError(error)) return null;
  switch (error.code) {
    case 'PASSWORD_TOO_WEAK': {
      const reason = error.meta?.['reason'];
      if (reason === 'too_long') return opacText(locale, 'akun.password.too_long');
      if (reason === 'common') return opacText(locale, 'akun.password.common');
      return opacText(locale, 'akun.password.too_short', { min });
    }
    case 'AUTH_INVALID_CREDENTIALS':
      return opacText(locale, 'akun.password.wrong');
    case 'AUTH_TOO_MANY_ATTEMPTS':
      return opacText(locale, 'akun.login.too_many', { minutes: Math.max(1, Math.ceil(Number(error.meta?.['retryAfterS'] ?? 60) / 60)) });
    case 'AUTH_BUSY':
      return opacText(locale, 'akun.login.busy');
    default:
      return null;
  }
}

/** `members.password.minLength`. */
function minLength(rc: Rc): Promise<number> {
  return rc.services.settings.get<number>(rc.db.db, 'members.password.minLength');
}

/** Whether the member may place holds online now (the settings, the type, an active membership). */
async function holdsOpen(rc: Rc, self: MemberSelf): Promise<boolean> {
  const s = await holdSettings(rc.db.db);
  return s.enabled && s.opac && self.holdsAllowed && self.status === 'active';
}

// ---------------------------------------------------------------------------------------------------------------
// Sign-in and sign-out

const LoginBody = z.strictObject({
  memberNo: z.string().max(200),
  password: z.string().max(1024),
  lanjut: z.string().max(1000).optional(),
});

/** GET /akun/masuk: the sign-in form (pre-session CSRF); a signed-in member goes on to `lanjut` or the account. */
const loginPage = route({
  ...PAGE,
  id: 'akun.login.page',
  path: '/akun/masuk',
  member: 'optional',
  mode: 'system',
  handler: async (rc) => {
    const lanjut = safeLanjut(q(rc, 'lanjut'), lanjutRoutes());
    if (rc.member !== null) return memberRedirect(rc.c, lanjut ?? '/akun');
    const a = await akunOf(rc);
    const pesan = q(rc, 'pesan');
    const notice =
      pesan === 'signed_out' ? opacText(a.locale, 'akun.login.signed_out') : pesan === 'reset_done' ? opacText(a.locale, 'akun.login.reset_done') : undefined;
    const closed = (await rc.services.settings.get<boolean>(rc.db.db, 'members.opac.enabled')) !== true;
    const csrf = ensurePreSessionCsrf(rc.c);
    return page(rc, a, {
      title: opacText(a.locale, 'akun.login.title'),
      body: () => <LoginView locale={a.locale} keep={a.keep} csrf={csrf} lanjut={lanjut} closed={closed} {...(notice === undefined ? {} : { notice })} />,
    });
  },
});

/** POST /akun/masuk: signs in (core memberLogin) and goes on to `lanjut`, or answers the form with the one failure text. */
const login = route({
  ...FORM,
  id: 'akun.login',
  path: '/akun/masuk',
  member: 'optional',
  mode: 'system',
  tx: 'self',
  audit: null,
  alsoAudits: ['members.self.login_locked'],
  body: LoginBody,
  handler: async (rc) => {
    const lanjut = safeLanjut(rc.body.lanjut, lanjutRoutes());
    const a = await akunOf(rc);
    const closed = (await rc.services.settings.get<boolean>(rc.db.db, 'members.opac.enabled')) !== true;
    const again = (status: number, error: string | undefined): Response => {
      const csrf = ensurePreSessionCsrf(rc.c);
      return page(rc, a, {
        status,
        title: opacText(a.locale, 'akun.login.title'),
        body: () => (
          <LoginView
            locale={a.locale}
            keep={a.keep}
            csrf={csrf}
            lanjut={lanjut}
            closed={closed}
            memberNo={rc.body.memberNo.slice(0, 64)}
            {...(error === undefined ? {} : { error })}
          />
        ),
      });
    };
    if (closed) return again(403, undefined);
    try {
      const limits = await memberSessionLimits(rc.services, rc.db.db);
      const out = await memberLogin(
        { memberNo: rc.body.memberNo, password: rc.body.password },
        {
          run: rc.withTx,
          now: rc.now,
          ip: rc.ip,
          ipTrust: rc.ipTrust,
          userAgent: rc.c.req.header('user-agent') ?? null,
          hasher: rc.services.hasher,
          ...(rc.member === null ? {} : { previousSessionId: rc.member.session.id }),
          log: rc.log,
          ...limits,
        },
      );
      setMemberSessionCookie(rc.c, out.session.token);
      return memberRedirect(rc.c, out.mustResetPassword ? '/akun/sandi' : (lanjut ?? '/akun'));
    } catch (error) {
      if (!isDomainError(error)) throw error;
      if (error.code === 'AUTH_INVALID_CREDENTIALS') return again(401, opacText(a.locale, 'akun.login.failed'));
      if (error.code === 'AUTH_TOO_MANY_ATTEMPTS') {
        rc.c.header('Retry-After', String(Number(error.meta?.['retryAfterS'] ?? 60)));
        return again(429, passwordError(a.locale, error, 0) ?? undefined);
      }
      if (error.code === 'AUTH_BUSY') return again(503, opacText(a.locale, 'akun.login.busy'));
      throw error;
    }
  },
});

/** POST /akun/keluar: ends the member's session and goes to the sign-in page. */
const logout = route({
  ...FORM,
  id: 'akun.logout',
  path: '/akun/keluar',
  mode: 'system',
  tx: 'self',
  audit: null,
  handler: async (rc) => {
    const id = rc.member?.session.id;
    if (id !== undefined) await rc.withTx((tx) => revokeMemberSession(tx.trx, id));
    clearAuthCookie(rc.c, 'altis_msid');
    return memberRedirect(rc.c, '/akun/masuk?pesan=signed_out');
  },
});

// ---------------------------------------------------------------------------------------------------------------
// The account, the history

/** GET /akun: the member, the open loans (paged) with the online renewal. */
const home = route({
  ...PAGE,
  id: 'akun.home',
  path: '/akun',
  handler: async (rc) => {
    const a = await akunOf(rc);
    const self = await memberSelf(rc.db.db, memberId(rc), rc.now);
    const loans = await memberLoans(rc.db.db, self.id, { open: true, page: pageNo(rc), now: rc.now });
    const canRenew = self.status === 'active' && (await onlineRenewalOpen(rc.db.db, self));
    const balance = (await memberBalances(rc.db.db, [self.id])).get(self.id) ?? 0;
    const currency = await rc.services.settings.get<string>(rc.db.db, 'catalog.currency');
    return page(rc, a, {
      title: opacText(a.locale, 'akun.home.title'),
      tab: 'home',
      body: () => [
        flash(rc, a),
        <p class="akun-greeting">{opacText(a.locale, 'akun.home.greeting', { name: self.name })}</p>,
        <MemberSummary locale={a.locale} self={self} typeName={memberTypeName(self, a.locale)} />,
        <BalanceNote locale={a.locale} keep={a.keep} balanceMinor={balance} currency={currency} />,
        <OpenLoans locale={a.locale} keep={a.keep} csrf={rc.member!.csrf} loans={loans} canRenew={canRenew} />,
      ],
    });
  },
});

/** GET /akun/riwayat: the closed loans, newest first (paged). */
const history = route({
  ...PAGE,
  id: 'akun.history',
  path: '/akun/riwayat',
  handler: async (rc) => {
    const a = await akunOf(rc);
    const loans = await memberLoans(rc.db.db, memberId(rc), { open: false, page: pageNo(rc), now: rc.now });
    return page(rc, a, {
      title: opacText(a.locale, 'akun.history.title'),
      tab: 'history',
      body: () => <HistoryView locale={a.locale} keep={a.keep} loans={loans} />,
    });
  },
});

/** GET /akun/denda: the member's unpaid fines and charges and their payments (paged), to look at only. */
const charges = route({
  ...PAGE,
  id: 'akun.charges',
  path: '/akun/denda',
  handler: async (rc) => {
    const a = await akunOf(rc);
    const data = await memberOwnCharges(rc.db.db, memberId(rc), { page: pageNo(rc) });
    return page(rc, a, {
      title: opacText(a.locale, 'akun.charges.title'),
      tab: 'charges',
      body: () => <ChargesView locale={a.locale} keep={a.keep} data={data} />,
    });
  },
});

/** POST /akun/pinjaman/:id/perpanjang: renews the member's own loan once (the desk's renewal, the online rules first). */
const renew = route({
  ...FORM,
  id: 'akun.loans.renew',
  path: '/akun/pinjaman/:id/perpanjang',
  mode: 'write',
  tx: 'self',
  audit: null,
  alsoAudits: ['circulation.loan.renew'],
  handler: async (rc) => {
    const loanId = (rc.params as Record<string, string>)['id'] ?? '';
    const member = memberId(rc);
    const refused = (reason: string): Response => memberRedirect(rc.c, `/akun?pesan=renew_refused&alasan=${encodeURIComponent(reason)}`);
    if (!isUlid(loanId)) return notFound(rc, await akunOf(rc));
    try {
      const { branchId } = await ownLoanForRenewal(rc.db.db, { memberId: member, loanId, now: rc.now });
      const r = await rc.withTx((tx) => renewOwnLoan(tx, { memberId: member, loanId, branchId }));
      return memberRedirect(rc.c, `/akun?pesan=renewed&sampai=${r.dueOn}`);
    } catch (error) {
      if (!isDomainError(error)) throw error;
      if (error.code === 'NOT_FOUND') return notFound(rc, await akunOf(rc));
      if (error.code === 'CIRC_RENEW_REFUSED') return refused(String(error.meta?.['reason'] ?? 'other'));
      if (error.code === 'CIRC_LOAN_NOT_OPEN') return refused('not_open');
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Holds

/** GET /akun/reservasi: the active holds (queue place, pickup deadline, cancel) and the recent closed ones. */
const holds = route({
  ...PAGE,
  id: 'akun.holds',
  path: '/akun/reservasi',
  handler: async (rc) => {
    const a = await akunOf(rc);
    const all = await memberHolds(rc.db.db, memberId(rc), { closed: true, closedLimit: 10 });
    const active = all.filter((h) => h.status === 'waiting' || h.status === 'ready');
    const closed = all.filter((h) => h.status !== 'waiting' && h.status !== 'ready');
    return page(rc, a, {
      title: opacText(a.locale, 'akun.holds.title'),
      tab: 'holds',
      body: () => [flash(rc, a), <HoldsView locale={a.locale} keep={a.keep} csrf={rc.member!.csrf} active={active} closed={closed} />],
    });
  },
});

/** The confirmation page of a hold on `recordId` (with `error` after a refusal). */
async function holdConfirm(rc: Rc, a: Akun, recordId: string, o: { error?: string; status?: number } = {}): Promise<Response> {
  const title = isUlid(recordId) ? await publishedRecordTitle(rc.db.db, recordId) : null;
  if (title === null) return notFound(rc, a);
  const member = memberId(rc);
  const self = await memberSelf(rc.db.db, member, rc.now);
  const branchId = await pickupBranchFor(rc.db.db, member);
  const branch = await rc.db.db.selectFrom('branches').select('name').where('id', '=', branchId).executeTakeFirst();
  const s = await holdSettings(rc.db.db);
  return page(rc, a, {
    status: o.status ?? 200,
    title: opacText(a.locale, 'akun.holds.confirm_title'),
    tab: null,
    body: () => (
      <HoldConfirmView
        locale={a.locale}
        keep={a.keep}
        csrf={rc.member!.csrf}
        recordId={recordId}
        title={title}
        branch={branch?.name ?? ''}
        open={s.enabled && s.opac && self.holdsAllowed}
        {...(o.error === undefined ? {} : { error: o.error })}
      />
    ),
  });
}

/** GET /akun/reservasi/baru?cantuman=<id>: the confirmation of a hold, from a record's "Pesan" link. */
const holdNew = route({
  ...PAGE,
  id: 'akun.holds.new',
  path: '/akun/reservasi/baru',
  handler: async (rc) => holdConfirm(rc, await akunOf(rc), q(rc, 'cantuman') ?? ''),
});

const RecordBody = z.strictObject({ recordId: z.string().max(64) });

/** POST /akun/reservasi: places a hold through the holds service, picked up at the member's home branch. */
const holdCreate = route({
  ...FORM,
  id: 'akun.holds.create',
  path: '/akun/reservasi',
  mode: 'write',
  tx: 'self',
  audit: null,
  alsoAudits: ['circulation.hold.create'],
  body: RecordBody,
  handler: async (rc) => {
    const a = await akunOf(rc);
    const recordId = rc.body.recordId;
    if (!isUlid(recordId) || (await publishedRecordTitle(rc.db.db, recordId)) === null) return notFound(rc, a);
    const member = memberId(rc);
    const pickupBranchId = await pickupBranchFor(rc.db.db, member);
    try {
      const r = await rc.withTx((tx) => placeHold(tx, { memberId: member, recordId, pickupBranchId, source: 'opac' }));
      return memberRedirect(rc.c, `/akun/reservasi?pesan=hold_placed${r.position === null ? '' : `&antrean=${r.position}`}`);
    } catch (error) {
      if (!isDomainError(error)) throw error;
      if (error.code === 'CIRC_HOLD_REFUSED') {
        const reason = holdRefusalText(a.locale, String(error.meta?.['reason'] ?? ''));
        return holdConfirm(rc, a, recordId, { status: 409, error: opacText(a.locale, 'akun.holds.refused', { reason }) });
      }
      if (error.code === 'NOT_FOUND') return notFound(rc, a);
      throw error;
    }
  },
});

/** POST /akun/reservasi/:id/batal: cancels the member's own hold (another member's: the 404 page). */
const holdCancel = route({
  ...FORM,
  id: 'akun.holds.cancel',
  path: '/akun/reservasi/:id/batal',
  mode: 'write',
  tx: 'self',
  audit: null,
  alsoAudits: ['circulation.hold.cancel'],
  handler: async (rc) => {
    const holdId = (rc.params as Record<string, string>)['id'] ?? '';
    if (!isUlid(holdId)) return notFound(rc, await akunOf(rc));
    const member = memberId(rc);
    try {
      await rc.withTx((tx) => cancelHold(tx, { holdId, by: 'member', memberId: member }));
    } catch (error) {
      if (!isDomainError(error)) throw error;
      if (error.code === 'NOT_FOUND') return notFound(rc, await akunOf(rc));
      if (error.code !== 'CIRC_HOLD_REFUSED') throw error;
      return memberRedirect(rc.c, '/akun/reservasi');
    }
    return memberRedirect(rc.c, '/akun/reservasi?pesan=hold_cancelled');
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Bookmarks

/** The bookmarks page, with the results of "Pesan yang dipilih" when given. */
async function bookmarksPage(rc: Rc, a: Akun, o: { results?: { title: string; ok: boolean; reason?: string }[]; error?: string } = {}): Promise<Response> {
  const member = memberId(rc);
  const self = await memberSelf(rc.db.db, member, rc.now);
  const rows = await memberBookmarks(rc.db.db, member);
  const canHold = await holdsOpen(rc, self);
  return page(rc, a, {
    title: opacText(a.locale, 'akun.bookmarks.title'),
    tab: 'bookmarks',
    body: () => [
      flash(rc, a),
      o.error === undefined ? null : <Flash kind="warn" text={o.error} />,
      o.results === undefined ? null : <HoldResultsView locale={a.locale} results={o.results} />,
      <BookmarksView
        locale={a.locale}
        keep={a.keep}
        csrf={rc.member!.csrf}
        rows={rows}
        canHold={canHold}
        recordHref={(r) => recordUrlPath(r.recordId, r.title)}
      />,
    ],
  });
}

/** GET /akun/penanda. */
const bookmarks = route({
  ...PAGE,
  id: 'akun.bookmarks',
  path: '/akun/penanda',
  handler: async (rc) => bookmarksPage(rc, await akunOf(rc)),
});

/** GET /akun/penanda/baru?cantuman=<id>: the confirmation of a bookmark, from a record's "Tandai" link. */
const bookmarkNew = route({
  ...PAGE,
  id: 'akun.bookmarks.new',
  path: '/akun/penanda/baru',
  handler: async (rc) => {
    const a = await akunOf(rc);
    const recordId = q(rc, 'cantuman') ?? '';
    const title = isUlid(recordId) ? await publishedRecordTitle(rc.db.db, recordId) : null;
    if (title === null) return notFound(rc, a);
    return page(rc, a, {
      title: opacText(a.locale, 'akun.bookmarks.confirm_title'),
      tab: null,
      body: () => <BookmarkConfirmView locale={a.locale} keep={a.keep} csrf={rc.member!.csrf} recordId={recordId} title={title} />,
    });
  },
});

/** POST /akun/penanda: bookmarks a title the OPAC shows (at most 200). */
const bookmarkCreate = route({
  ...FORM,
  id: 'akun.bookmarks.create',
  path: '/akun/penanda',
  mode: 'write',
  tx: 'self',
  audit: null,
  body: RecordBody,
  handler: async (rc) => {
    const recordId = rc.body.recordId;
    if (!isUlid(recordId)) return notFound(rc, await akunOf(rc));
    try {
      const member = memberId(rc);
      const r = await rc.withTx((tx) => addBookmark(tx, member, recordId));
      return memberRedirect(rc.c, `/akun/penanda?pesan=${r.added ? 'bookmark_added' : 'bookmark_already'}`);
    } catch (error) {
      if (!isDomainError(error)) throw error;
      if (error.code === 'NOT_FOUND') return notFound(rc, await akunOf(rc));
      if (error.code === 'VALIDATION_FAILED') return memberRedirect(rc.c, '/akun/penanda?pesan=bookmark_limit');
      throw error;
    }
  },
});

/** POST /akun/penanda/:recordId/hapus: removes the member's own bookmark (none: the 404 page). */
const bookmarkRemove = route({
  ...FORM,
  id: 'akun.bookmarks.remove',
  path: '/akun/penanda/:recordId/hapus',
  mode: 'write',
  tx: 'self',
  audit: null,
  handler: async (rc) => {
    const recordId = (rc.params as Record<string, string>)['recordId'] ?? '';
    if (!isUlid(recordId)) return notFound(rc, await akunOf(rc));
    try {
      const member = memberId(rc);
      await rc.withTx((tx) => removeBookmark(tx, member, recordId));
    } catch (error) {
      if (isDomainError(error) && error.code === 'NOT_FOUND') return notFound(rc, await akunOf(rc));
      throw error;
    }
    return memberRedirect(rc.c, '/akun/penanda?pesan=bookmark_removed');
  },
});

const HoldSelectedBody = z.strictObject({ recordIds: z.array(z.string().max(64)).max(100).optional() });

/** POST /akun/penanda/pesan: one hold per selected title (at most 20), each in its own transaction; a result per title. */
const bookmarkHold = route({
  ...FORM,
  id: 'akun.bookmarks.hold',
  path: '/akun/penanda/pesan',
  mode: 'write',
  tx: 'self',
  audit: null,
  alsoAudits: ['circulation.hold.create'],
  body: HoldSelectedBody,
  handler: async (rc: RcOf<z.infer<typeof HoldSelectedBody>>) => {
    const a = await akunOf(rc);
    const ids = [...new Set(rc.body.recordIds ?? [])];
    if (ids.length === 0) return bookmarksPage(rc, a, { error: opacText(a.locale, 'akun.bookmarks.hold_none') });
    if (ids.length > HOLD_SELECTED_MAX) return bookmarksPage(rc, a, { error: opacText(a.locale, 'akun.bookmarks.hold_max', { max: HOLD_SELECTED_MAX }) });
    const member = memberId(rc);
    const pickupBranchId = await pickupBranchFor(rc.db.db, member);
    const results: { title: string; ok: boolean; reason?: string }[] = [];
    for (const recordId of ids) {
      const title = isUlid(recordId) ? await publishedRecordTitle(rc.db.db, recordId) : null;
      if (title === null) continue;
      try {
        await rc.withTx((tx) => placeHold(tx, { memberId: member, recordId, pickupBranchId, source: 'opac' }));
        results.push({ title, ok: true });
      } catch (error) {
        if (!isDomainError(error)) throw error;
        if (error.code !== 'CIRC_HOLD_REFUSED' && error.code !== 'NOT_FOUND') throw error;
        const reason = error.code === 'NOT_FOUND' ? holdRefusalText(a.locale, 'member') : holdRefusalText(a.locale, String(error.meta?.['reason'] ?? ''));
        results.push({ title, ok: false, reason });
      }
    }
    return bookmarksPage(rc, a, { results });
  },
});

// ---------------------------------------------------------------------------------------------------------------
// The card and the photo

/** GET /akun/kartu: the member card, ready to print (the barcode holds the member number only). */
const card = route({
  ...PAGE,
  id: 'akun.card',
  path: '/akun/kartu',
  handler: async (rc) => {
    const a = await akunOf(rc);
    const self = await memberSelf(rc.db.db, memberId(rc), rc.now);
    return page(rc, a, {
      title: opacText(a.locale, 'akun.card.title'),
      tab: 'card',
      body: () => <CardView locale={a.locale} keep={a.keep} self={self} typeName={memberTypeName(self, a.locale)} libraryName={a.ctx.libraryName} />,
    });
  },
});

/** GET /akun/foto: the member's own photo (never through /files/:id), `private, no-store`. */
const photo = route({
  ...PAGE,
  id: 'akun.photo',
  path: '/akun/foto',
  handler: async (rc) => {
    const self = await memberSelf(rc.db.db, memberId(rc), rc.now);
    const file =
      self.photoFileId === null
        ? undefined
        : await rc.db.db.selectFrom('files').select(['mime', 'size', 'status']).where('id', '=', self.photoFileId).executeTakeFirst();
    if (file === undefined || file.status !== 'ok' || self.photoFileId === null) return notFound(rc, await akunOf(rc));
    const driver = localStorageDriver(rc.services.dataDir);
    const content = await driver.get(self.photoFileId);
    if (content === null) return notFound(rc, await akunOf(rc));
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) chunks.push(chunk);
    return new Response(Buffer.concat(chunks), {
      status: 200,
      headers: { 'Content-Type': file.mime, 'Cache-Control': PRIVATE, 'X-Content-Type-Options': 'nosniff' },
    });
  },
});

// ---------------------------------------------------------------------------------------------------------------
// The password: change, forgotten, reset

const PasswordBody = z.strictObject({ current: z.string().max(1024), next: z.string().max(1024), repeat: z.string().max(1024) });

/** The password page (with an error or a notice). */
async function passwordPage(rc: Rc, a: Akun, o: { status?: number; error?: string } = {}): Promise<Response> {
  const min = await minLength(rc);
  return page(rc, a, {
    status: o.status ?? 200,
    title: opacText(a.locale, 'akun.password.title'),
    tab: 'password',
    body: () => [
      flash(rc, a),
      <PasswordView
        locale={a.locale}
        keep={a.keep}
        csrf={rc.member!.csrf}
        min={min}
        mustReset={rc.member!.mustResetPassword}
        {...(o.error === undefined ? {} : { error: o.error })}
      />,
    ],
  });
}

/** GET /akun/sandi. */
const passwordGet = route({
  ...PAGE,
  id: 'akun.password',
  path: '/akun/sandi',
  mode: 'system',
  handler: async (rc) => passwordPage(rc, await akunOf(rc)),
});

/** POST /akun/sandi: the current password first, then the policy; every session ends, this browser gets a new one. */
const passwordChange = route({
  ...FORM,
  id: 'akun.password.change',
  path: '/akun/sandi',
  mode: 'system',
  tx: 'self',
  audit: null,
  alsoAudits: ['members.self.password_change'],
  body: PasswordBody,
  handler: async (rc) => {
    const a = await akunOf(rc);
    const min = await minLength(rc);
    try {
      const limits = await memberSessionLimits(rc.services, rc.db.db);
      if (rc.body.next !== rc.body.repeat) {
        // The current password is still checked first: a mismatch is told only to whoever knows it.
        await confirmMemberPassword({ memberId: memberId(rc), password: rc.body.current }, { run: rc.withTx, now: rc.now, ip: rc.ip, hasher: rc.services.hasher, log: rc.log });
        return passwordPage(rc, a, { status: 422, error: opacText(a.locale, 'akun.password.mismatch') });
      }
      const session = await changeMemberPassword(
        { memberId: memberId(rc), current: rc.body.current, next: rc.body.next, minLength: min },
        { run: rc.withTx, now: rc.now, ip: rc.ip, ipTrust: rc.ipTrust, userAgent: rc.c.req.header('user-agent') ?? null, hasher: rc.services.hasher, log: rc.log, ...limits },
      );
      setMemberSessionCookie(rc.c, session.token);
      return memberRedirect(rc.c, '/akun/sandi?pesan=password_saved');
    } catch (error) {
      if (isDomainError(error) && error.code === 'AUTH_REQUIRED') {
        clearAuthCookie(rc.c, 'altis_msid');
        return memberRedirect(rc.c, '/akun/masuk');
      }
      const text = passwordError(a.locale, error, min);
      if (text === null) throw error;
      return passwordPage(rc, a, { status: 422, error: text });
    }
  },
});

const ForgotBody = z.strictObject({ memberNo: z.string().max(200) });

/** GET /akun/lupa-sandi. */
const forgotPage = route({
  ...PAGE,
  id: 'akun.forgot.page',
  path: '/akun/lupa-sandi',
  member: 'optional',
  mode: 'system',
  handler: async (rc) => {
    const a = await akunOf(rc);
    const csrf = ensurePreSessionCsrf(rc.c);
    return page(rc, a, {
      title: opacText(a.locale, 'akun.forgot.title'),
      body: () => <ForgotView locale={a.locale} keep={a.keep} csrf={csrf} sent={false} minutes={MEMBER_RESET_TTL_MS / 60_000} />,
    });
  },
});

/** The registry the reset mail is enqueued with: the job runtime's, else one of its handler alone. */
function mailRegistry(rc: Rc): JobRegistry {
  const reg = rc.services.jobs?.registry;
  if (reg?.get('mail.member_password_reset') !== undefined) return reg;
  return createJobRegistry([memberResetMailJob({ mailer: rc.services.mailer, baseUrl: () => rc.config.baseUrl, settings: rc.services.settings })]);
}

/**
 * POST /akun/lupa-sandi: counts the member's forgot buckets, then answers the same page whatever the number is; the
 * reset and its mail start after the response (the time to answer says nothing about the member either).
 */
const forgot = route({
  ...FORM,
  id: 'akun.forgot',
  path: '/akun/lupa-sandi',
  member: 'optional',
  mode: 'system',
  tx: 'self',
  audit: null,
  ipLimits: ['member_forgot:ip'],
  body: ForgotBody,
  handler: async (rc) => {
    const a = await akunOf(rc);
    const key = normalizeMemberNo(rc.body.memberNo);
    if (key !== '' && key.length <= 191) {
      const hits = await rc.withTx(async (tx) => [
        await hit(tx.trx, 'member_forgot:member:5m', key, rc.now),
        await hit(tx.trx, 'member_forgot:member:1d', key, rc.now),
      ]);
      if (hits.every((h) => h.allowed)) {
        rc.afterResponse(async () => {
          try {
            const reg = mailRegistry(rc);
            const job = await rc.withTx(async (tx) => {
              const started = await startMemberReset(tx.trx, { memberNo: rc.body.memberNo, now: rc.now });
              return started === null ? null : enqueueMemberResetMail(tx.trx, reg, started, { now: rc.now, keyring: rc.config.keyring });
            });
            if (job !== null && rc.services.jobs !== null) {
              if (rc.services.jobs.mode === 'worker') rc.services.jobs.kick();
              else await rc.services.jobs.drive(job.id, { budgetMs: 10_000 });
            }
          } catch (error) {
            rc.log.error('mail failed', { stage: 'member_reset_start', code: isDomainError(error) ? error.code : 'error' });
          }
        });
      }
    }
    const csrf = ensurePreSessionCsrf(rc.c);
    return page(rc, a, {
      title: opacText(a.locale, 'akun.forgot.title'),
      body: () => <ForgotView locale={a.locale} keep={a.keep} csrf={csrf} sent={true} minutes={MEMBER_RESET_TTL_MS / 60_000} />,
    });
  },
});

const ResetBody = z.strictObject({ next: z.string().max(1024), repeat: z.string().max(1024) });

/** The set-password page of the link `token` (invalid: says so). */
async function resetPage(rc: Rc, a: Akun, token: string, o: { invalid: boolean; status?: number; error?: string }): Promise<Response> {
  const min = await minLength(rc);
  const csrf = ensurePreSessionCsrf(rc.c);
  return page(rc, a, {
    status: o.status ?? 200,
    title: opacText(a.locale, 'akun.reset.title'),
    body: () => (
      <ResetView locale={a.locale} keep={a.keep} csrf={csrf} token={token} invalid={o.invalid} min={min} {...(o.error === undefined ? {} : { error: o.error })} />
    ),
  });
}

/** GET /akun/atur-sandi/:token. */
const resetGet = route({
  ...PAGE,
  id: 'akun.reset.page',
  path: '/akun/atur-sandi/:token',
  member: 'optional',
  mode: 'system',
  handler: async (rc) => {
    const a = await akunOf(rc);
    const token = (rc.params as Record<string, string>)['token'] ?? '';
    rc.c.header('Referrer-Policy', 'no-referrer');
    try {
      await memberResetSubject(rc.db.db, token, rc.now);
    } catch (error) {
      if (isDomainError(error) && error.code === 'AUTH_RESET_TOKEN_INVALID') return resetPage(rc, a, '', { invalid: true, status: 410 });
      throw error;
    }
    return resetPage(rc, a, token, { invalid: false });
  },
});

/** POST /akun/atur-sandi/:token: the policy, the hash outside any transaction, then the token used up once. */
const resetSave = route({
  ...FORM,
  id: 'akun.reset',
  path: '/akun/atur-sandi/:token',
  member: 'optional',
  mode: 'system',
  tx: 'self',
  audit: null,
  alsoAudits: ['members.self.password_reset'],
  ipLimits: ['member_reset:ip'],
  body: ResetBody,
  handler: async (rc) => {
    const a = await akunOf(rc);
    const token = (rc.params as Record<string, string>)['token'] ?? '';
    rc.c.header('Referrer-Policy', 'no-referrer');
    const min = await minLength(rc);
    let subject: string;
    try {
      subject = await memberResetSubject(rc.db.db, token, rc.now);
    } catch (error) {
      if (isDomainError(error) && error.code === 'AUTH_RESET_TOKEN_INVALID') return resetPage(rc, a, '', { invalid: true, status: 410 });
      throw error;
    }
    if (rc.body.next !== rc.body.repeat) return resetPage(rc, a, token, { invalid: false, status: 422, error: opacText(a.locale, 'akun.password.mismatch') });
    try {
      checkMemberPasswordPolicy(rc.body.next, min);
      const hash = await rc.services.hasher.hash(rc.body.next);
      await rc.withTx((tx) => completeMemberReset(tx, { token, passwordHash: hash }), { actor: { type: 'member', id: subject, ip: rc.ip } });
    } catch (error) {
      if (isDomainError(error) && error.code === 'AUTH_RESET_TOKEN_INVALID') return resetPage(rc, a, '', { invalid: true, status: 410 });
      const text = passwordError(a.locale, error, min);
      if (text === null) throw error;
      return resetPage(rc, a, token, { invalid: false, status: 422, error: text });
    }
    return memberRedirect(rc.c, '/akun/masuk?pesan=reset_done');
  },
});

// ---------------------------------------------------------------------------------------------------------------
// The member's own data, the members' attachments

/** The data page (with an error). */
async function dataPage(rc: Rc, a: Akun, o: { status?: number; error?: string } = {}): Promise<Response> {
  return page(rc, a, {
    status: o.status ?? 200,
    title: opacText(a.locale, 'akun.data.title'),
    tab: 'data',
    body: () => <DataView locale={a.locale} keep={a.keep} csrf={rc.member!.csrf} {...(o.error === undefined ? {} : { error: o.error })} />,
  });
}

/** GET /akun/data-saya: asks for the current password. */
const dataGet = route({
  ...PAGE,
  id: 'akun.data',
  path: '/akun/data-saya',
  mode: 'system',
  handler: async (rc) => dataPage(rc, await akunOf(rc)),
});

const DataBody = z.strictObject({ password: z.string().max(1024) });

/**
 * POST /akun/data-saya: the current password verified outside any transaction (`member_export:member` and
 * `member_login:user` counted), then the member's own data as a JSON download, audited `members.self.data_export`.
 */
const dataExport = route({
  ...FORM,
  id: 'akun.data.export',
  path: '/akun/data-saya',
  mode: 'system',
  tx: 'self',
  audit: null,
  alsoAudits: ['members.self.data_export'],
  body: DataBody,
  handler: async (rc) => {
    const member = memberId(rc);
    try {
      await confirmMemberPassword({ memberId: member, password: rc.body.password }, { run: rc.withTx, now: rc.now, ip: rc.ip, hasher: rc.services.hasher, log: rc.log });
    } catch (error) {
      const a = await akunOf(rc);
      const text = passwordError(a.locale, error, 0);
      if (text === null) throw error;
      return dataPage(rc, a, { status: 422, error: text });
    }
    const data = await memberDataExport(rc.db.db, member, rc.now);
    await rc.withTx((tx) => tx.audit({ action: 'members.self.data_export', entity: 'members', entityId: member }));
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="data-anggota.json"',
        'Cache-Control': PRIVATE,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
});

/**
 * GET /akun/lampiran/:id: a members' attachment for the signed-in member: a file goes to `/files/:id` (which checks the
 * member session again), a link to its address; a type the attachment does not list sees why, anything else the 404.
 */
const attachment = route({
  ...PAGE,
  id: 'akun.attachment',
  path: '/akun/lampiran/:id',
  handler: async (rc) => {
    const id = (rc.params as Record<string, string>)['id'] ?? '';
    const a = await akunOf(rc);
    const found = isUlid(id) && rc.member !== null ? await memberAttachment(rc.db.db, id, rc.member.memberTypeId) : null;
    if (found === null) return notFound(rc, a);
    if (found === 'type') {
      return page(rc, a, {
        status: 403,
        title: opacText(a.locale, 'akun.attachment.title'),
        tab: null,
        body: () => <Flash kind="warn" text={opacText(a.locale, 'akun.attachment.type_denied')} />,
      });
    }
    if (found.kind === 'file' && found.fileId !== null) return memberRedirect(rc.c, `/files/${found.fileId}`);
    if (found.kind === 'url' && linkableUrl(found.url)) {
      rc.c.header('Cache-Control', 'no-store');
      return rc.c.redirect(found.url, 303);
    }
    return notFound(rc, a);
  },
});

/** The member-area routes (route catalog: akun.*), the fixed paths before the ones with parameters. */
export const AKUN_ROUTES: RouteDecl[] = [
  loginPage,
  login,
  logout,
  home,
  history,
  charges,
  renew,
  holds,
  holdNew,
  holdCreate,
  holdCancel,
  bookmarks,
  bookmarkNew,
  bookmarkHold,
  bookmarkCreate,
  bookmarkRemove,
  card,
  photo,
  passwordGet,
  passwordChange,
  forgotPage,
  forgot,
  resetGet,
  resetSave,
  dataGet,
  dataExport,
  attachment,
];
