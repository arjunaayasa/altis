import { hmacB64u, safeEqual, stationByToken } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { readAuthCookie, requestConfig } from './cookies.js';
import { checkOrigin, csrfKey, preSessionCsrfToken } from './csrf.js';
import type { AppEnv } from './request-id.js';

// The guestbook station's pages (`/kunjungan`, Komunitas K2): what the route pipeline does for a `visitStation`
// route in place of the staff session, and for a `form` route's HTML form body.
//
// - The station: the `altis_vs` cookie holds the device token a station got at its activation; it is looked up by its
//   SHA-256 among the stations that are not revoked. No cookie, a malformed one or a revoked station: no station (the
//   page then asks for an activation).
// - The form body: `application/x-www-form-urlencoded` only (415 otherwise), at most 16 KB (413), no field given twice
//   (400 VALIDATION_FAILED `duplicate_field`); every field is a string. `_csrf` is taken out before the strict schema.
// - Its CSRF check (step 8): Sec-Fetch-Site and Origin as every write, then the token from `_csrf` (or the
//   `X-CSRF-Token` header): with a live station, `base64url(HMAC(sessionKey, 'csrf:visit_station:' + station id))`;
//   without one (the activation form), the pre-session token of the `altis_csrf` cookie.

/** The station a request carries. */
export interface VisitStationAuth {
  id: string;
  branchId: string;
  locationId: string | null;
  name: string;
}

/** The largest form body. */
export const FORM_MAX_BYTES = 16 * 1024;

const STATION_PREFIX = 'csrf:visit_station:';

/** The CSRF token of the station `stationId`. */
export function stationCsrfToken(sessionKey: Uint8Array, stationId: string): string {
  return hmacB64u(sessionKey, STATION_PREFIX + stationId);
}

/** The station of the request's `altis_vs` cookie, or null. */
export async function resolveVisitStation(c: Context<AppEnv>, db: DbHandle | undefined): Promise<VisitStationAuth | null> {
  if (db === undefined) return null;
  const token = readAuthCookie(c, 'altis_vs');
  if (token === undefined) return null;
  return stationByToken(db.db, token);
}

const limitForm = bodyLimit({
  maxSize: FORM_MAX_BYTES,
  onError: () => {
    throw new DomainError('PAYLOAD_TOO_LARGE');
  },
});

const utf8 = new TextDecoder('utf-8', { fatal: true });

function isFormContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type = ''] = header.split(';');
  return type.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

/**
 * The request's form body: its fields (without `_csrf`) and the `_csrf` value.
 *
 * @throws DomainError UNSUPPORTED_MEDIA_TYPE, PAYLOAD_TOO_LARGE, VALIDATION_FAILED (`duplicate_field`, `invalid_format`)
 */
export async function readFormBody(c: Context<AppEnv>): Promise<{ fields: Record<string, string>; csrf: string | null }> {
  if (!isFormContentType(c.req.header('content-type'))) throw new DomainError('UNSUPPORTED_MEDIA_TYPE');
  await limitForm(c, async () => {});
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > FORM_MAX_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE');
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new DomainError('VALIDATION_FAILED', { meta: { errors: [{ path: '', code: 'invalid_format' }] } });
  }
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  let csrf: string | null = null;
  const seen = new Set<string>();
  for (const [key, value] of new URLSearchParams(text)) {
    if (seen.has(key)) throw new DomainError('VALIDATION_FAILED', { detail: 'Ruas ganda / A field given twice', meta: { errors: [{ path: '', code: 'duplicate_field' }] } });
    seen.add(key);
    if (key === '_csrf') csrf = value;
    else fields[key] = value;
  }
  return { fields: { ...fields }, csrf };
}

/**
 * Step 8 for a form route (see the top of this file).
 *
 * @throws DomainError ORIGIN_DENIED, CSRF_INVALID
 */
export function checkFormCsrf(c: Context<AppEnv>, formToken: string | null, station: VisitStationAuth | null): void {
  checkOrigin(c);
  const key = csrfKey(requestConfig(c));
  let expected: string | undefined;
  if (station !== null) expected = stationCsrfToken(key, station.id);
  else {
    const cookie = readAuthCookie(c, 'altis_csrf');
    if (cookie !== undefined) expected = preSessionCsrfToken(key, cookie);
  }
  const sent = formToken ?? c.req.header('x-csrf-token');
  if (expected === undefined || sent === undefined || !safeEqual(sent, expected)) throw new DomainError('CSRF_INVALID');
}
