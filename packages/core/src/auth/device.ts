import { hmacB64u, randomToken, safeEqual } from '../crypto/tokens.js';

// The known-device cookie `altis_dev` (spec §7.1, D21): proof that a login completed on this device before.
//
//   <deviceId>.<mac>[.<mac>…]     deviceId = randomToken(16); one MAC per username, newest first, at most 5
//   mac = HMAC(sessionKey, 'dev:' + deviceId + ':' + usernameKey), its first 16 bytes as base64url
//
// A valid MAC for the submitted username moves a login out of the per-IP buckets into `login:dev:<deviceId>`.
// The cookie is issued only when a login completes (after 2FA when 2FA applies); setting it, its lifetime (180 days)
// and its name (`__Host-` prefix) are the HTTP layer's job. The key is the install's decoded 32-byte sessionKey (D45).

/** The most usernames (MACs) one device cookie remembers. */
export const DEVICE_MAX_MACS = 5;

/** 16 bytes as unpadded base64url: the device id and every MAC. */
const PART = /^[A-Za-z0-9_-]{22}$/;
/** The longest well-formed cookie: an id and 5 MACs of 22 characters with their dots. */
const MAX_LENGTH = 22 + DEVICE_MAX_MACS * 23;

/** A parsed `altis_dev` cookie: its device id and MACs, newest first. */
export interface DeviceCookie {
  deviceId: string;
  macs: string[];
}

/** `hmacB64u(sessionKey, 'dev:' + deviceId + ':' + usernameKey, 16)`: 22 characters. */
export function deviceMac(sessionKey: Uint8Array, deviceId: string, usernameKey: string): string {
  return hmacB64u(sessionKey, `dev:${deviceId}:${usernameKey}`, 16);
}

/**
 * The device id and MACs of a cookie value, or null unless it is a 22-character id followed by 1 to 5 MACs of 22
 * base64url characters, separated by single dots (nothing else: no blanks, no padding).
 */
export function parseDeviceCookie(v: string | undefined): DeviceCookie | null {
  if (typeof v !== 'string' || v.length > MAX_LENGTH) return null;
  const [deviceId, ...macs] = v.split('.');
  if (deviceId === undefined || !PART.test(deviceId)) return null;
  if (macs.length < 1 || macs.length > DEVICE_MAX_MACS || !macs.every((m) => PART.test(m))) return null;
  return { deviceId, macs };
}

/** Whether one of the cookie's MACs is that of `usernameKey` on this device (compared in constant time). */
export function deviceKnows(sessionKey: Uint8Array, parsed: DeviceCookie, usernameKey: string): boolean {
  const expected = deviceMac(sessionKey, parsed.deviceId, usernameKey);
  let known = false;
  // Every MAC is compared, so the time does not tell which slot matched.
  for (const mac of parsed.macs) known = safeEqual(mac, expected) || known;
  return known;
}

/**
 * The cookie value after a completed login of `usernameKey`: the current cookie's device id (a new randomToken(16)
 * when there is no well-formed cookie), this login's MAC first, then the other MACs in their order, each once, at
 * most {@link DEVICE_MAX_MACS} (the oldest drop out).
 */
export function deviceCookieAfterLogin(
  sessionKey: Uint8Array,
  current: string | undefined,
  usernameKey: string,
): string {
  const parsed = parseDeviceCookie(current);
  const deviceId = parsed?.deviceId ?? randomToken(16);
  const mac = deviceMac(sessionKey, deviceId, usernameKey);
  const macs = [...new Set([mac, ...(parsed?.macs ?? [])])].slice(0, DEVICE_MAX_MACS);
  return [deviceId, ...macs].join('.');
}
