import { activateStation, checkIn, hit, readSettings } from '@altis/core';
import { DomainError, VISIT_PURPOSES, isDomainError, isLocale, resolveLocale, t, type Locale, type VisitPurpose } from '@altis/shared';
import { StationActivateForm, StationCheckinForm } from '@altis/shared/api/visits';
import { DEFAULT_ACCENT, isAccent } from '@altis/opac-theme';
import type { Context } from 'hono';
import { requestConfig, setAuthCookie, VISIT_STATION_MAX_AGE_S } from '../../http/cookies.js';
import { csrfKey, ensurePreSessionCsrf } from '../../http/csrf.js';
import { cspHeader, cspNonce } from '../../http/csp.js';
import type { AppEnv } from '../../http/request-id.js';
import { route, type RouteDecl } from '../../http/route.js';
import type { DbHandle } from '@altis/db';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { stationCsrfToken } from '../../http/visit-station.js';
import { opacText } from '../catalog/messages.js';
import { keepLang } from '../catalog/views/page.js';
import { Layout, toDocument } from '../layout.js';

// The guestbook station (`/kunjungan`): a library device that records visits on its own page, without a staff session.
//
//   GET  /kunjungan/aktifkan   the activation form (a pre-session CSRF token); a paired device sees "activated"
//   POST /kunjungan/aktifkan   the code → the station's device token in the `altis_vs` cookie (400 days, Strict),
//                              audit `visits.station.activated` (the station as the actor); a wrong code: the form again
//   GET  /kunjungan            the check-in page (`?tamu=1`: the guest form); without a live station → the activation
//   POST /kunjungan            a check-in (member number, or a guest's name and institution) → the greeting, which goes
//                              back to the empty page after 4 seconds
//
// The pages work without JavaScript (autofocus keeps the scan box ready) and load nothing from elsewhere; every page
// carries its own CSP nonce and no inline script or style. A greeting shows the member's first name only (and the
// photo only when the library turns `visits.station.showPhoto` on, through the staff file route, which the station
// cannot reach: so the photo is never sent to a station in this version). Check-ins are counted per station
// (`visit_station_checkin`, 120 a minute); activations per client IP (`visit_station_activate:ip`).

interface Frame {
  locale: Locale;
  /** The language the request named (`?lang=`), kept on every form, link and redirect of the station. */
  lang: Locale | null;
  libraryName: string;
  accent: string;
  welcome: string | null;
  askPurpose: boolean;
}

async function frameOf(rc: { readonly db: DbHandle; readonly c: Context<AppEnv> }): Promise<Frame> {
  const s = await readSettings(rc.db.db, ['library.name', 'library.locale', 'opac.accent', 'visits.askPurpose', 'visits.station.welcome.id', 'visits.station.welcome.en'], []);
  const asked = rc.c.req.query('lang');
  const locale = resolveLocale(asked, String(s['library.locale']));
  const accent = String(s['opac.accent']);
  const welcome = (locale === 'en' ? s['visits.station.welcome.en'] : s['visits.station.welcome.id']) as string | null;
  return {
    locale,
    lang: asked !== undefined && isLocale(asked) ? asked : null,
    libraryName: String(s['library.name']),
    accent: isAccent(accent) ? accent : DEFAULT_ACCENT,
    welcome: welcome === null || welcome.trim() === '' ? null : welcome,
    askPurpose: s['visits.askPurpose'] === true,
  };
}

/** `path` of the station in the language the request named. */
const at = (f: Frame, path: string): string => keepLang(path, f.lang);

/** A station page: its nonce, CSP and `no-store`; `refreshTo` sends the device back there after 4 seconds. */
function page(c: Context<AppEnv>, f: Frame, status: 200 | 422 | 429, body: (nonce: string) => JSX.Element, refreshTo?: string): Response {
  const nonce = cspNonce();
  const html = toDocument(
    <Layout
      locale={f.locale}
      nonce={nonce}
      title={opacText(f.locale, 'visits.title')}
      description={opacText(f.locale, 'visits.title')}
      libraryName={f.libraryName}
      accent={f.accent}
      robots="noindex"
      head={refreshTo === undefined ? undefined : <meta http-equiv="refresh" content={`4;url=${at(f, refreshTo)}`} />}
    >
      {body(nonce)}
    </Layout>,
  );
  return c.body(html, status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': cspHeader(nonce),
    'Referrer-Policy': 'no-referrer',
  });
}

function redirect(c: Context<AppEnv>, to: string): Response {
  return c.body(null, 303, { Location: to, 'Cache-Control': 'private, no-store' });
}

function PurposeSelect(props: { locale: Locale }) {
  return (
    <>
      <label for="purpose">{opacText(props.locale, 'visits.purpose')}</label>
      <select id="purpose" name="purpose">
        <option value="">{opacText(props.locale, 'visits.purpose_none')}</option>
        {VISIT_PURPOSES.map((p) => (
          <option value={p}>{t(props.locale, `vocab.visit_purpose.${p}`)}</option>
        ))}
      </select>
    </>
  );
}

function CheckinForm(props: { f: Frame; csrf: string; guest: boolean; error?: string }) {
  const { f, csrf, guest } = props;
  const l = f.locale;
  return (
    <div class="guestbook">
      <h1>{f.libraryName}</h1>
      <p class="guestbook-welcome">{f.welcome ?? opacText(l, 'visits.welcome')}</p>
      {props.error === undefined ? null : <p class="guestbook-error">{props.error}</p>}
      {guest ? (
        <form method="post" action={at(f, '/kunjungan')}>
          <input type="hidden" name="_csrf" value={csrf} />
          <input type="hidden" name="guest" value="1" />
          <h2>{opacText(l, 'visits.guest_title')}</h2>
          <label for="guestName">{opacText(l, 'visits.guest_name')}</label>
          <input id="guestName" name="guestName" maxlength={191} required autofocus autocomplete="off" />
          <label for="guestInstitution">{opacText(l, 'visits.guest_institution')}</label>
          <input id="guestInstitution" name="guestInstitution" maxlength={191} required autocomplete="off" />
          {f.askPurpose ? <PurposeSelect locale={l} /> : null}
          <div class="guestbook-actions">
            <button type="submit">{opacText(l, 'visits.submit')}</button>
            <a href={at(f, '/kunjungan')}>{opacText(l, 'visits.member_button')}</a>
          </div>
        </form>
      ) : (
        <form method="post" action={at(f, '/kunjungan')}>
          <input type="hidden" name="_csrf" value={csrf} />
          <label for="memberNo">{opacText(l, 'visits.member_no')}</label>
          <input id="memberNo" class="guestbook-scan" name="memberNo" maxlength={200} required autofocus autocomplete="off" inputmode="text" />
          {f.askPurpose ? <PurposeSelect locale={l} /> : null}
          <div class="guestbook-actions">
            <button type="submit">{opacText(l, 'visits.submit')}</button>
            <a href={at(f, '/kunjungan?tamu=1')}>{opacText(l, 'visits.guest_button')}</a>
          </div>
        </form>
      )}
    </div>
  );
}

/** A form field, trimmed; '' and absent are undefined. */
function field(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().slice(0, max);
  return s === '' ? undefined : s;
}

function purposeOf(v: string | undefined): VisitPurpose | null {
  return v !== undefined && (VISIT_PURPOSES as readonly string[]).includes(v) ? (v as VisitPurpose) : null;
}

const activatePage = route({
  id: 'opac.visits.activate.page',
  method: 'GET',
  path: '/kunjungan/aktifkan',
  public: true,
  visitStation: true,
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const f = await frameOf(rc);
    if (rc.visitStation !== null) {
      return page(rc.c, f, 200, () => (
        <div class="guestbook">
          <h1>{opacText(f.locale, 'visits.activate_title')}</h1>
          <p class="guestbook-greeting">{opacText(f.locale, 'visits.activate_done')}</p>
          <div class="guestbook-actions">
            <a href={at(f, '/kunjungan')}>{opacText(f.locale, 'visits.activate_open')}</a>
          </div>
        </div>
      ));
    }
    return activateForm(rc.c, f, ensurePreSessionCsrf(rc.c), 200);
  },
});

function activateForm(c: Context<AppEnv>, f: Frame, csrf: string, status: 200 | 422 | 429, error?: string): Response {
  return page(c, f, status, () => (
    <div class="guestbook">
      <h1>{opacText(f.locale, 'visits.activate_title')}</h1>
      <p class="guestbook-welcome">{opacText(f.locale, 'visits.activate_lead')}</p>
      {error === undefined ? null : <p class="guestbook-error">{error}</p>}
      <form method="post" action={at(f, '/kunjungan/aktifkan')}>
        <input type="hidden" name="_csrf" value={csrf} />
        <label for="code">{opacText(f.locale, 'visits.activate_code')}</label>
        <input id="code" class="guestbook-code" name="code" maxlength={32} required autofocus autocomplete="off" />
        <div class="guestbook-actions">
          <button type="submit">{opacText(f.locale, 'visits.activate_submit')}</button>
        </div>
      </form>
    </div>
  ));
}

const activateSubmit = route({
  id: 'opac.visits.activate',
  method: 'POST',
  path: '/kunjungan/aktifkan',
  public: true,
  visitStation: true,
  form: true,
  maintenance: 'deny',
  idempotency: 'none',
  // Audited only when a code pairs the device (a wrong code answers the form again, with nothing to audit).
  audit: null,
  alsoAudits: ['visits.station.activated'],
  tx: 'self',
  ipLimits: ['visit_station_activate:ip'],
  body: StationActivateForm,
  handler: async (rc) => {
    const f = await frameOf(rc);
    let paired: { stationId: string; branchId: string; token: string };
    try {
      paired = await rc.withTx((tx) => activateStation(tx, rc.body.code));
    } catch (error) {
      if (isDomainError(error) && error.code === 'VISIT_ACTIVATION_INVALID') {
        return activateForm(rc.c, f, ensurePreSessionCsrf(rc.c), 422, opacText(f.locale, 'visits.activate_invalid'));
      }
      throw error;
    }
    // The station is the actor of its own activation.
    await rc.withTx((tx) => tx.audit({ action: 'visits.station.activated', entity: 'visit_stations', entityId: paired.stationId, branchId: paired.branchId, meta: {} }), {
      actor: { type: 'visit_station', id: paired.stationId, ip: rc.ip },
    });
    setAuthCookie(rc.c, 'altis_vs', paired.token, { maxAgeS: VISIT_STATION_MAX_AGE_S, sameSite: 'Strict' });
    return redirect(rc.c, at(f, '/kunjungan'));
  },
});

const stationPage = route({
  id: 'opac.visits.page',
  method: 'GET',
  path: '/kunjungan',
  public: true,
  visitStation: true,
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const station = rc.visitStation;
    const f = await frameOf(rc);
    if (station === null) return redirect(rc.c, at(f, '/kunjungan/aktifkan'));
    const csrf = stationCsrfToken(csrfKey(requestConfig(rc.c)), station.id);
    return page(rc.c, f, 200, () => <CheckinForm f={f} csrf={csrf} guest={rc.c.req.query('tamu') === '1'} />);
  },
});

const stationCheckin = route({
  id: 'opac.visits.checkin',
  method: 'POST',
  path: '/kunjungan',
  public: true,
  visitStation: true,
  form: true,
  maintenance: 'deny',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: StationCheckinForm,
  handler: async (rc) => {
    const station = rc.visitStation;
    if (station === null) throw new DomainError('VISIT_STATION_UNPAIRED');
    const f = await frameOf(rc);
    const l = f.locale;
    const csrf = stationCsrfToken(csrfKey(requestConfig(rc.c)), station.id);
    const limited = await rc.withTx(async (tx) => !(await hit(tx.trx, 'visit_station_checkin', station.id, rc.now)).allowed);
    if (limited) return page(rc.c, f, 429, () => <CheckinForm f={f} csrf={csrf} guest={false} />, '/kunjungan');
    const guest = rc.body.guest === '1';
    const purpose = f.askPurpose ? purposeOf(rc.body.purpose) : null;
    const actor = { type: 'visit_station' as const, id: station.id, ip: rc.ip };
    if (guest) {
      const name = field(rc.body.guestName, 191);
      const institution = field(rc.body.guestInstitution, 191);
      if (name === undefined || institution === undefined) {
        return page(rc.c, f, 422, () => <CheckinForm f={f} csrf={csrf} guest={true} error={opacText(l, 'visits.required')} />);
      }
      await rc.withTx((tx) => checkIn(tx, { branchId: station.branchId, source: 'station', stationId: station.id, locationId: station.locationId, guest: { name, institution }, purpose }), { actor });
      return page(
        rc.c,
        f,
        200,
        () => (
          <div class="guestbook">
            <div class="guestbook-greeting" role="status">
              {opacText(l, 'visits.greeting_guest', { name: name.split(/\s+/u)[0] ?? name })}
            </div>
            <div class="guestbook-actions">
              <a href={at(f, '/kunjungan')}>{opacText(l, 'visits.again')}</a>
            </div>
          </div>
        ),
        '/kunjungan',
      );
    }
    const memberNo = field(rc.body.memberNo, 200);
    if (memberNo === undefined) return page(rc.c, f, 422, () => <CheckinForm f={f} csrf={csrf} guest={false} error={opacText(l, 'visits.required')} />);
    const r = await rc.withTx((tx) => checkIn(tx, { branchId: station.branchId, source: 'station', stationId: station.id, locationId: station.locationId, memberNo, purpose }), { actor });
    if (r.outcome === 'unknown') {
      return page(rc.c, f, 200, () => (
        <div class="guestbook">
          <div class="guestbook-greeting is-error" role="alert">
            {opacText(l, 'visits.unknown')}
            <p>{opacText(l, 'visits.unknown_hint')}</p>
          </div>
          <div class="guestbook-actions">
            <a href={at(f, '/kunjungan')}>{opacText(l, 'visits.again')}</a>
            <a href={at(f, '/kunjungan?tamu=1')}>{opacText(l, 'visits.guest_button')}</a>
          </div>
        </div>
      ), '/kunjungan');
    }
    const note = r.expired ? opacText(l, 'visits.expired') : r.suspended ? opacText(l, 'visits.suspended') : opacText(l, r.outcome === 'repeat' ? 'visits.repeat' : 'visits.recorded');
    return page(
      rc.c,
      f,
      200,
      () => (
        <div class="guestbook">
          <div class={r.expired || r.suspended ? 'guestbook-greeting is-warning' : 'guestbook-greeting'} role="status">
            {opacText(l, 'visits.greeting', { name: r.firstName ?? '' })}
            <p>{note}</p>
          </div>
          <div class="guestbook-actions">
            <a href={at(f, '/kunjungan')}>{opacText(l, 'visits.again')}</a>
          </div>
        </div>
      ),
      '/kunjungan',
    );
  },
});

/** The guestbook station's routes, before the OPAC's own. */
export const VISIT_STATION_ROUTES: RouteDecl[] = [activatePage, activateSubmit, stationPage, stationCheckin];
