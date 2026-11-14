import { code128Modules, type MemberBookmarkRow, type MemberLoanPage, type MemberSelf } from '@altis/core';
import { t, type HoldRefusal, type LoanOutcome, type Locale } from '@altis/shared';
import type { HoldView } from '@altis/shared/api/holds';
import type { Child } from 'hono/jsx';
import { opacText } from '../catalog/messages.js';
import { formatDate } from '../catalog/views/page.js';

// The views of the OPAC member area (`/akun`, routes.tsx): the frame with the account menu and the sign-out form, the
// notices, and one view per page. Every form posts to the member area with its CSRF token in the hidden `_csrf` field;
// the pages never show the address, identity number or notes of a member, only what the member needs. Server-rendered
// without a script: they work with the keyboard and a screen reader as plain HTML.

/** A link of the page that keeps the request's `?lang=`. */
export type Keep = (path: string) => string;

export type AkunTab = 'home' | 'history' | 'holds' | 'bookmarks' | 'card' | 'password' | 'data';

const TABS: readonly [AkunTab, string, Parameters<typeof opacText>[1]][] = [
  ['home', '/akun', 'akun.nav.home'],
  ['history', '/akun/riwayat', 'akun.nav.history'],
  ['holds', '/akun/reservasi', 'akun.nav.holds'],
  ['bookmarks', '/akun/penanda', 'akun.nav.bookmarks'],
  ['card', '/akun/kartu', 'akun.nav.card'],
  ['password', '/akun/sandi', 'akun.nav.password'],
  ['data', '/akun/data-saya', 'akun.nav.data'],
];

/** A calendar date as a reader writes it. */
export function day(locale: Locale, date: string): string {
  return formatDate(locale, Date.parse(`${date}T00:00:00Z`), 'UTC');
}

/** The hidden CSRF field of a form. */
function Csrf(props: { token: string }) {
  return <input type="hidden" name="_csrf" value={props.token} />;
}

/** A notice above the page's content: `ok` (done), `warn` (refused), `error` (a field to fix). */
export function Flash(props: { kind: 'ok' | 'warn' | 'error'; text: string }) {
  return (
    <p class={`akun-flash akun-flash-${props.kind}`} role={props.kind === 'ok' ? 'status' : 'alert'}>
      {props.text}
    </p>
  );
}

/** The member area's frame: the heading, the account menu, the sign-out button, then the page. */
export function AkunFrame(props: { locale: Locale; keep: Keep; title: string; active: AkunTab | null; csrf: string; children?: Child }) {
  const { locale, keep } = props;
  return (
    <div class="akun">
      <h1>{props.title}</h1>
      <nav class="akun-nav" aria-label={opacText(locale, 'akun.nav.label')}>
        <ul>
          {TABS.map(([tab, path, key]) => (
            <li>
              <a href={keep(path)} aria-current={tab === props.active ? 'page' : undefined}>
                {opacText(locale, key)}
              </a>
            </li>
          ))}
        </ul>
        <form method="post" action={keep('/akun/keluar')} class="akun-logout">
          <Csrf token={props.csrf} />
          <button type="submit">{opacText(locale, 'akun.logout')}</button>
        </form>
      </nav>
      <div class="akun-body">{props.children}</div>
    </div>
  );
}

/** Page links (`?hal=`) of a paged list. */
function Pager(props: { locale: Locale; keep: Keep; path: string; page: number; pages: number }) {
  const { locale, keep, path, page, pages } = props;
  if (pages <= 1) return null;
  const at = (n: number): string => keep(n === 1 ? path : `${path}?hal=${n}`);
  return (
    <nav class="akun-pager" aria-label={opacText(locale, 'akun.pager.label')}>
      {page > 1 ? (
        <a href={at(page - 1)} rel="prev">
          {opacText(locale, 'akun.pager.prev')}
        </a>
      ) : null}
      <span>{opacText(locale, 'akun.pager.page', { page, pages })}</span>
      {page < pages ? (
        <a href={at(page + 1)} rel="next">
          {opacText(locale, 'akun.pager.next')}
        </a>
      ) : null}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Sign-in, the forgotten password, the new password

/** A labelled field of a form. */
function Field(props: { id: string; label: string; name: string; type?: string; value?: string; autocomplete: string; hint?: string }) {
  return (
    <p class="akun-field">
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        name={props.name}
        type={props.type ?? 'text'}
        value={props.value}
        autocomplete={props.autocomplete}
        required
        maxlength={props.type === 'password' ? 1024 : 64}
        aria-describedby={props.hint === undefined ? undefined : `${props.id}-hint`}
      />
      {props.hint === undefined ? null : (
        <span id={`${props.id}-hint`} class="akun-hint">
          {props.hint}
        </span>
      )}
    </p>
  );
}

export function LoginView(props: { locale: Locale; keep: Keep; csrf: string; lanjut: string | null; memberNo?: string; error?: string; notice?: string; closed: boolean }) {
  const { locale, keep } = props;
  return (
    <div class="akun akun-narrow">
      <h1>{opacText(locale, 'akun.login.title')}</h1>
      {props.notice === undefined ? null : <Flash kind="ok" text={props.notice} />}
      {props.error === undefined ? null : <Flash kind="error" text={props.error} />}
      {props.closed ? (
        <p>{opacText(locale, 'akun.login.closed')}</p>
      ) : (
        <>
          <p>{opacText(locale, 'akun.login.lead')}</p>
          <form method="post" action={keep('/akun/masuk')} class="akun-form">
            <Csrf token={props.csrf} />
            {props.lanjut === null ? null : <input type="hidden" name="lanjut" value={props.lanjut} />}
            <Field id="nomor-anggota" label={opacText(locale, 'akun.login.member_no')} name="memberNo" value={props.memberNo} autocomplete="username" />
            <Field id="kata-sandi" label={opacText(locale, 'akun.login.password')} name="password" type="password" autocomplete="current-password" />
            <p>
              <button type="submit">{opacText(locale, 'akun.login.submit')}</button>
            </p>
          </form>
          <p>
            <a href={keep('/akun/lupa-sandi')}>{opacText(locale, 'akun.login.forgot')}</a>
          </p>
          <p class="akun-hint">{opacText(locale, 'akun.login.no_password')}</p>
        </>
      )}
    </div>
  );
}

export function ForgotView(props: { locale: Locale; keep: Keep; csrf: string; sent: boolean; minutes: number; error?: string }) {
  const { locale, keep } = props;
  return (
    <div class="akun akun-narrow">
      <h1>{opacText(locale, 'akun.forgot.title')}</h1>
      {props.error === undefined ? null : <Flash kind="error" text={props.error} />}
      {props.sent ? (
        <Flash kind="ok" text={opacText(locale, 'akun.forgot.sent', { minutes: props.minutes })} />
      ) : (
        <>
          <p>{opacText(locale, 'akun.forgot.lead')}</p>
          <form method="post" action={keep('/akun/lupa-sandi')} class="akun-form">
            <Csrf token={props.csrf} />
            <Field id="nomor-anggota" label={opacText(locale, 'akun.login.member_no')} name="memberNo" autocomplete="username" />
            <p>
              <button type="submit">{opacText(locale, 'akun.forgot.submit')}</button>
            </p>
          </form>
        </>
      )}
      <p>
        <a href={keep('/akun/masuk')}>{opacText(locale, 'akun.forgot.back')}</a>
      </p>
    </div>
  );
}

/** The two new-password fields (reset and change). */
function NewPasswordFields(props: { locale: Locale; min: number }) {
  const { locale } = props;
  return (
    <>
      <Field
        id="sandi-baru"
        label={opacText(locale, 'akun.password.new')}
        name="next"
        type="password"
        autocomplete="new-password"
        hint={opacText(locale, 'akun.password.rules', { min: props.min })}
      />
      <Field id="sandi-ulang" label={opacText(locale, 'akun.password.repeat')} name="repeat" type="password" autocomplete="new-password" />
    </>
  );
}

export function ResetView(props: { locale: Locale; keep: Keep; csrf: string; token: string; invalid: boolean; min: number; error?: string }) {
  const { locale, keep } = props;
  return (
    <div class="akun akun-narrow">
      <h1>{opacText(locale, 'akun.reset.title')}</h1>
      {props.invalid ? (
        <>
          <Flash kind="warn" text={opacText(locale, 'akun.reset.invalid')} />
          <p>
            <a href={keep('/akun/lupa-sandi')}>{opacText(locale, 'akun.login.forgot')}</a>
          </p>
        </>
      ) : (
        <>
          {props.error === undefined ? null : <Flash kind="error" text={props.error} />}
          <form method="post" action={keep(`/akun/atur-sandi/${props.token}`)} class="akun-form">
            <Csrf token={props.csrf} />
            <NewPasswordFields locale={locale} min={props.min} />
            <p>
              <button type="submit">{opacText(locale, 'akun.reset.submit')}</button>
            </p>
          </form>
        </>
      )}
    </div>
  );
}

export function PasswordView(props: { locale: Locale; keep: Keep; csrf: string; min: number; mustReset: boolean; error?: string; notice?: string }) {
  const { locale, keep } = props;
  return (
    <>
      {props.mustReset ? <Flash kind="warn" text={opacText(locale, 'akun.password.must_reset')} /> : null}
      {props.notice === undefined ? null : <Flash kind="ok" text={props.notice} />}
      {props.error === undefined ? null : <Flash kind="error" text={props.error} />}
      <form method="post" action={keep('/akun/sandi')} class="akun-form">
        <Csrf token={props.csrf} />
        <Field id="sandi-kini" label={opacText(locale, 'akun.password.current')} name="current" type="password" autocomplete="current-password" />
        <NewPasswordFields locale={locale} min={props.min} />
        <p>
          <button type="submit">{opacText(locale, 'akun.password.submit')}</button>
        </p>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The account: the member, the open loans, the history

const STATUS_KEYS = { active: 'akun.status.active', expired: 'akun.status.expired', suspended: 'akun.status.suspended' } as const;

export function MemberSummary(props: { locale: Locale; self: MemberSelf; typeName: string }) {
  const { locale, self } = props;
  const status = self.status === 'expired' || self.status === 'suspended' ? self.status : 'active';
  return (
    <>
      <dl class="akun-facts">
        <div>
          <dt>{opacText(locale, 'akun.home.member_no')}</dt>
          <dd class="akun-no">{self.memberNo}</dd>
        </div>
        <div>
          <dt>{opacText(locale, 'akun.home.type')}</dt>
          <dd>{props.typeName}</dd>
        </div>
        {self.className === null ? null : (
          <div>
            <dt>{opacText(locale, 'akun.home.class')}</dt>
            <dd>{self.className}</dd>
          </div>
        )}
        <div>
          <dt>{opacText(locale, 'akun.home.status')}</dt>
          <dd>
            <span class={`status ${status === 'active' ? 'status-ok' : 'status-warn'}`}>{opacText(locale, STATUS_KEYS[status])}</span>
          </dd>
        </div>
        <div>
          <dt>{opacText(locale, 'akun.home.valid_until')}</dt>
          <dd>{self.expiresOn === null ? opacText(locale, 'akun.home.no_expiry') : day(locale, self.expiresOn)}</dd>
        </div>
      </dl>
      {status === 'expired' ? <Flash kind="warn" text={opacText(locale, 'akun.home.expired_note')} /> : null}
      {status === 'suspended' ? <Flash kind="warn" text={opacText(locale, 'akun.home.suspended_note')} /> : null}
    </>
  );
}

/** The open loans, with the online renewal when it is open to the member. */
export function OpenLoans(props: { locale: Locale; keep: Keep; csrf: string; loans: MemberLoanPage; canRenew: boolean }) {
  const { locale, keep, loans } = props;
  return (
    <section aria-labelledby="pinjaman">
      <h2 id="pinjaman">{opacText(locale, 'akun.loans.title')}</h2>
      {loans.total === 0 ? (
        <p>{opacText(locale, 'akun.loans.empty')}</p>
      ) : (
        <>
          {props.canRenew ? null : <p class="akun-hint">{opacText(locale, 'akun.loans.renew_closed')}</p>}
          <div class="table-scroll">
            <table class="akun-table">
              <thead>
                <tr>
                  <th scope="col">{opacText(locale, 'akun.loans.col.title')}</th>
                  <th scope="col">{opacText(locale, 'akun.loans.col.barcode')}</th>
                  <th scope="col">{opacText(locale, 'akun.loans.col.loaned')}</th>
                  <th scope="col">{opacText(locale, 'akun.loans.col.due')}</th>
                  <th scope="col">{opacText(locale, 'akun.loans.col.renewals')}</th>
                  {props.canRenew ? <th scope="col">{opacText(locale, 'akun.loans.col.action')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {loans.rows.map((l) => (
                  <tr>
                    <td>{l.title ?? '—'}</td>
                    <td class="akun-no">{l.barcode ?? '—'}</td>
                    <td>{day(locale, l.loanedOn)}</td>
                    <td>
                      {day(locale, l.dueOn)}
                      {l.daysLate > 0 ? (
                        <>
                          {' '}
                          <span class="status status-warn">{opacText(locale, 'akun.loans.overdue', { days: l.daysLate })}</span>
                        </>
                      ) : null}
                    </td>
                    <td>{opacText(locale, 'akun.loans.renewals_of', { n: l.renewals, limit: l.renewLimit })}</td>
                    {props.canRenew ? (
                      <td>
                        <form method="post" action={keep(`/akun/pinjaman/${l.id}/perpanjang`)}>
                          <Csrf token={props.csrf} />
                          <button type="submit" aria-label={opacText(locale, 'akun.loans.renew_label', { title: l.title ?? l.barcode ?? '' })}>
                            {opacText(locale, 'akun.loans.renew')}
                          </button>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager locale={locale} keep={keep} path="/akun" page={loans.page} pages={loans.pages} />
        </>
      )}
    </section>
  );
}

export function HistoryView(props: { locale: Locale; keep: Keep; loans: MemberLoanPage }) {
  const { locale, keep, loans } = props;
  if (loans.total === 0) return <p>{opacText(locale, 'akun.history.empty')}</p>;
  return (
    <>
      <div class="table-scroll">
        <table class="akun-table">
          <thead>
            <tr>
              <th scope="col">{opacText(locale, 'akun.loans.col.title')}</th>
              <th scope="col">{opacText(locale, 'akun.loans.col.barcode')}</th>
              <th scope="col">{opacText(locale, 'akun.loans.col.loaned')}</th>
              <th scope="col">{opacText(locale, 'akun.history.col.returned')}</th>
              <th scope="col">{opacText(locale, 'akun.history.col.outcome')}</th>
            </tr>
          </thead>
          <tbody>
            {loans.rows.map((l) => (
              <tr>
                <td>{l.title ?? '—'}</td>
                <td class="akun-no">{l.barcode ?? '—'}</td>
                <td>{day(locale, l.loanedOn)}</td>
                <td>{l.returnedOn === null ? '—' : day(locale, l.returnedOn)}</td>
                <td>
                  {l.outcome === null ? '' : t(locale, `vocab.loan_outcome.${l.outcome as LoanOutcome}`)}
                  {l.daysLate > 0 ? ` · ${opacText(locale, 'akun.loans.overdue', { days: l.daysLate })}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager locale={locale} keep={keep} path="/akun/riwayat" page={loans.page} pages={loans.pages} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Holds

/** The words of a hold refusal. */
export function holdRefusalText(locale: Locale, reason: string): string {
  return t(locale, `vocab.hold_refusal.${reason as HoldRefusal}`);
}

export function HoldsView(props: { locale: Locale; keep: Keep; csrf: string; active: readonly HoldView[]; closed: readonly HoldView[] }) {
  const { locale, keep } = props;
  return (
    <>
      {props.active.length === 0 ? (
        <p>{opacText(locale, 'akun.holds.empty')}</p>
      ) : (
        <div class="table-scroll">
          <table class="akun-table">
            <thead>
              <tr>
                <th scope="col">{opacText(locale, 'akun.holds.col.title')}</th>
                <th scope="col">{opacText(locale, 'akun.holds.col.status')}</th>
                <th scope="col">{opacText(locale, 'akun.holds.col.pickup')}</th>
                <th scope="col">{opacText(locale, 'akun.loans.col.action')}</th>
              </tr>
            </thead>
            <tbody>
              {props.active.map((h) => (
                <tr>
                  <td>{h.record.title}</td>
                  <td>
                    {h.status === 'ready' ? (
                      <span class="status status-ok">
                        {h.pickupUntil === null ? t(locale, 'vocab.hold_status.ready') : opacText(locale, 'akun.holds.ready_until', { date: day(locale, h.pickupUntil) })}
                      </span>
                    ) : (
                      <span>{h.position === null ? t(locale, 'vocab.hold_status.waiting') : opacText(locale, 'akun.holds.position', { n: h.position })}</span>
                    )}
                  </td>
                  <td>{h.pickupBranch.name}</td>
                  <td>
                    <form method="post" action={keep(`/akun/reservasi/${h.id}/batal`)}>
                      <Csrf token={props.csrf} />
                      <button type="submit" aria-label={opacText(locale, 'akun.holds.cancel_label', { title: h.record.title })}>
                        {opacText(locale, 'akun.holds.cancel')}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {props.closed.length === 0 ? null : (
        <section aria-labelledby="reservasi-selesai">
          <h2 id="reservasi-selesai">{opacText(locale, 'akun.holds.closed_title')}</h2>
          <ul class="akun-list">
            {props.closed.map((h) => (
              <li>
                {h.record.title} · {t(locale, `vocab.hold_status.${h.status}`)}
                {h.closeReason === null ? '' : ` (${t(locale, `vocab.hold_close_reason.${h.closeReason}`)})`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** The confirmation of a hold (from a record's "Pesan" link). */
export function HoldConfirmView(props: { locale: Locale; keep: Keep; csrf: string; recordId: string; title: string; branch: string; open: boolean; error?: string }) {
  const { locale, keep } = props;
  return (
    <>
      {props.error === undefined ? null : <Flash kind="warn" text={props.error} />}
      {props.open ? (
        <form method="post" action={keep('/akun/reservasi')} class="akun-form">
          <Csrf token={props.csrf} />
          <input type="hidden" name="recordId" value={props.recordId} />
          <p>{opacText(locale, 'akun.holds.confirm_lead', { title: props.title, branch: props.branch })}</p>
          <p>
            <button type="submit">{opacText(locale, 'akun.holds.confirm_submit')}</button>
          </p>
        </form>
      ) : (
        <p>{opacText(locale, 'akun.holds.closed')}</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Bookmarks

export function BookmarksView(props: {
  locale: Locale;
  keep: Keep;
  csrf: string;
  rows: readonly MemberBookmarkRow[];
  canHold: boolean;
  recordHref: (row: MemberBookmarkRow) => string;
}) {
  const { locale, keep } = props;
  if (props.rows.length === 0) return <p>{opacText(locale, 'akun.bookmarks.empty')}</p>;
  return (
    <>
      <form method="post" action={keep('/akun/penanda/pesan')} id="pesan-penanda" class="akun-form">
        <Csrf token={props.csrf} />
      </form>
      <ul class="akun-list akun-bookmarks">
        {props.rows.map((r, i) => (
          <li>
            {props.canHold ? (
              <input
                type="checkbox"
                form="pesan-penanda"
                name={`recordIds.${i}`}
                value={r.recordId}
                id={`penanda-${i}`}
                aria-label={opacText(locale, 'akun.bookmarks.select', { title: r.title })}
              />
            ) : null}
            <a href={keep(props.recordHref(r))}>{r.title}</a>
            {r.responsibility === null ? null : <span class="akun-hint"> {r.responsibility}</span>}
            <form method="post" action={keep(`/akun/penanda/${r.recordId}/hapus`)} class="akun-inline">
              <Csrf token={props.csrf} />
              <button type="submit" aria-label={opacText(locale, 'akun.bookmarks.remove_label', { title: r.title })}>
                {opacText(locale, 'akun.bookmarks.remove')}
              </button>
            </form>
          </li>
        ))}
      </ul>
      {props.canHold ? (
        <p>
          <button type="submit" form="pesan-penanda">
            {opacText(locale, 'akun.bookmarks.hold_selected')}
          </button>
        </p>
      ) : null}
    </>
  );
}

export function BookmarkConfirmView(props: { locale: Locale; keep: Keep; csrf: string; recordId: string; title: string }) {
  const { locale, keep } = props;
  return (
    <form method="post" action={keep('/akun/penanda')} class="akun-form">
      <Csrf token={props.csrf} />
      <input type="hidden" name="recordId" value={props.recordId} />
      <p>{opacText(locale, 'akun.bookmarks.confirm_lead', { title: props.title })}</p>
      <p>
        <button type="submit">{opacText(locale, 'akun.bookmarks.confirm_submit')}</button>
      </p>
    </form>
  );
}

export function HoldResultsView(props: { locale: Locale; results: readonly { title: string; ok: boolean; reason?: string }[] }) {
  const { locale } = props;
  return (
    <section aria-labelledby="hasil-pesan">
      <h2 id="hasil-pesan">{opacText(locale, 'akun.bookmarks.hold_result')}</h2>
      <ul class="akun-list">
        {props.results.map((r) => (
          <li>
            {r.title}:{' '}
            {r.ok ? (
              <span class="status status-ok">{opacText(locale, 'akun.bookmarks.hold_ok')}</span>
            ) : (
              <span class="status status-warn">{opacText(locale, 'akun.bookmarks.hold_refused', { reason: r.reason ?? '' })}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The card, the data download, the members' attachment

/** The Code 128 of `text` as SVG bars (one unit per module, quiet zones of 10). */
export function Barcode(props: { text: string; label: string }) {
  const modules = code128Modules(props.text);
  const quiet = 10;
  const width = modules.length + 2 * quiet;
  const bars: { x: number; w: number }[] = [];
  for (let i = 0; i < modules.length; i += 1) {
    if (!modules[i]) continue;
    const last = bars[bars.length - 1];
    if (last !== undefined && last.x + last.w === i + quiet) last.w += 1;
    else bars.push({ x: i + quiet, w: 1 });
  }
  return (
    <svg class="akun-barcode" viewBox={`0 0 ${width} 40`} preserveAspectRatio="none" role="img" aria-label={props.label}>
      <rect x="0" y="0" width={width} height="40" fill="#fff" />
      {bars.map((b) => (
        <rect x={b.x} y="0" width={b.w} height="40" fill="#000" />
      ))}
    </svg>
  );
}

export function CardView(props: { locale: Locale; keep: Keep; self: MemberSelf; typeName: string; libraryName: string }) {
  const { locale, self } = props;
  return (
    <>
      <div class="akun-card">
        <p class="akun-card-library">{props.libraryName}</p>
        <div class="akun-card-main">
          {self.hasPhoto ? <img class="akun-card-photo" src={props.keep('/akun/foto')} alt={opacText(locale, 'akun.card.photo_alt')} width={90} height={120} /> : null}
          <div>
            <p class="akun-card-name">{self.name}</p>
            <p class="akun-no">{self.memberNo}</p>
            <p>
              {props.typeName}
              {self.className === null ? '' : ` · ${self.className}`}
            </p>
            <p>
              {opacText(locale, 'akun.home.valid_until')}: {self.expiresOn === null ? opacText(locale, 'akun.home.no_expiry') : day(locale, self.expiresOn)}
            </p>
          </div>
        </div>
        <Barcode text={self.memberNo} label={opacText(locale, 'akun.card.barcode_label', { no: self.memberNo })} />
      </div>
      <p class="akun-hint">{opacText(locale, 'akun.card.note')}</p>
    </>
  );
}

export function DataView(props: { locale: Locale; keep: Keep; csrf: string; error?: string }) {
  const { locale, keep } = props;
  return (
    <>
      {props.error === undefined ? null : <Flash kind="error" text={props.error} />}
      <p>{opacText(locale, 'akun.data.lead')}</p>
      <form method="post" action={keep('/akun/data-saya')} class="akun-form">
        <Csrf token={props.csrf} />
        <Field id="sandi-kini" label={opacText(locale, 'akun.password.current')} name="password" type="password" autocomplete="current-password" />
        <p>
          <button type="submit">{opacText(locale, 'akun.data.submit')}</button>
        </p>
      </form>
    </>
  );
}
