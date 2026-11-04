import { describe, expect, it } from 'vitest';
import {
  DEVICE_MAX_MACS,
  deviceCookieAfterLogin,
  deviceKnows,
  deviceMac,
  parseDeviceCookie,
} from '../src/auth/device.js';
import { hmacB64u } from '../src/crypto/tokens.js';

// The known-device cookie `altis_dev` (spec §7.1): `<deviceId>.<mac>[.<mac>…]`, one HMAC per username that
// completed a login on this device, newest first, at most 5. A valid MAC for the submitted username moves a login
// from the per-IP buckets to `login:dev`.

const KEY = new Uint8Array(32).fill(0x2a);
const OTHER_KEY = new Uint8Array(32).fill(0x2b);
const B64U = /^[A-Za-z0-9_-]+$/;

/** `s` with its character at `i` replaced by another base64url character. */
const flip = (s: string, i: number): string => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

describe('deviceMac', () => {
  it("is the 16-byte HMAC of 'dev:' + deviceId + ':' + usernameKey under the decoded session key (D45)", () => {
    const mac = deviceMac(KEY, 'dddddddddddddddddddddd', 'budi');
    expect(mac).toBe(hmacB64u(KEY, 'dev:dddddddddddddddddddddd:budi', 16));
    expect(mac).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(deviceMac(OTHER_KEY, 'dddddddddddddddddddddd', 'budi')).not.toBe(mac);
  });
});

describe('deviceCookieAfterLogin / parseDeviceCookie', () => {
  it('without a cookie makes a new device id (randomToken(16)) with this MAC', () => {
    const cookie = deviceCookieAfterLogin(KEY, undefined, 'budi');
    const parsed = parseDeviceCookie(cookie);
    expect(parsed).not.toBeNull();
    expect(parsed!.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(parsed!.macs).toEqual([deviceMac(KEY, parsed!.deviceId, 'budi')]);
    expect(cookie).toBe(`${parsed!.deviceId}.${parsed!.macs[0]}`);
    expect(deviceCookieAfterLogin(KEY, undefined, 'budi')).not.toBe(cookie); // a new device id each time
  });

  it('keeps the device id, puts the MAC of this login first and drops its older copy', () => {
    const first = deviceCookieAfterLogin(KEY, undefined, 'budi');
    const second = deviceCookieAfterLogin(KEY, first, 'ani');
    const third = deviceCookieAfterLogin(KEY, second, 'budi');
    const { deviceId } = parseDeviceCookie(first)!;
    expect(parseDeviceCookie(second)).toEqual({ deviceId, macs: [deviceMac(KEY, deviceId, 'ani'), deviceMac(KEY, deviceId, 'budi')] });
    expect(parseDeviceCookie(third)).toEqual({ deviceId, macs: [deviceMac(KEY, deviceId, 'budi'), deviceMac(KEY, deviceId, 'ani')] });
  });

  it('after 6 logins of distinct users only 5 MACs remain and the oldest is gone', () => {
    const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
    let cookie: string | undefined;
    for (const u of users) cookie = deviceCookieAfterLogin(KEY, cookie, u);
    const parsed = parseDeviceCookie(cookie)!;
    expect(DEVICE_MAX_MACS).toBe(5);
    expect(parsed.macs).toHaveLength(5);
    expect(parsed.macs).toEqual(['u6', 'u5', 'u4', 'u3', 'u2'].map((u) => deviceMac(KEY, parsed.deviceId, u)));
    expect(deviceKnows(KEY, parsed, 'u1')).toBe(false);
    for (const u of users.slice(1)) expect(deviceKnows(KEY, parsed, u), u).toBe(true);
  });

  it('starts a new device when the current cookie does not parse', () => {
    const cookie = deviceCookieAfterLogin(KEY, 'garbage', 'budi');
    const parsed = parseDeviceCookie(cookie)!;
    expect(parsed.macs).toEqual([deviceMac(KEY, parsed.deviceId, 'budi')]);
  });

  it('refuses anything but a 22-character id and 1 to 5 MACs of 22 base64url characters', () => {
    const id = 'dddddddddddddddddddddd';
    const mac = 'mmmmmmmmmmmmmmmmmmmmmm';
    expect(parseDeviceCookie(`${id}.${mac}`)).toEqual({ deviceId: id, macs: [mac] });
    expect(parseDeviceCookie([id, mac, mac, mac, mac, mac].join('.'))).toEqual({ deviceId: id, macs: Array(5).fill(mac) });
    for (const bad of [
      undefined,
      '',
      id,
      `${id}.`,
      `${id}.${mac}.`,
      `.${mac}`,
      `${id}..${mac}`,
      [id, mac, mac, mac, mac, mac, mac].join('.'),
      `${id.slice(1)}.${mac}`,
      `${id}.${mac}x`,
      `${id}.${mac.slice(1)}+`,
      `${id}.${mac.slice(1)}=`,
      ` ${id}.${mac}`,
      `${id}.${mac}\n`,
    ]) {
      expect(parseDeviceCookie(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('deviceKnows', () => {
  it('a MAC made for BUDI is not valid for ANI', () => {
    const parsed = parseDeviceCookie(deviceCookieAfterLogin(KEY, undefined, 'BUDI'))!;
    expect(deviceKnows(KEY, parsed, 'BUDI')).toBe(true);
    expect(deviceKnows(KEY, parsed, 'ANI')).toBe(false);
  });

  it('a tampered MAC, another device id or another session key is false', () => {
    const parsed = parseDeviceCookie(deviceCookieAfterLogin(KEY, undefined, 'budi'))!;
    const mac = parsed.macs[0]!;
    for (const i of [0, 10, 21]) {
      const tampered = flip(mac, i);
      expect(tampered).toMatch(B64U);
      expect(deviceKnows(KEY, { deviceId: parsed.deviceId, macs: [tampered] }, 'budi'), String(i)).toBe(false);
    }
    expect(deviceKnows(KEY, { deviceId: flip(parsed.deviceId, 3), macs: parsed.macs }, 'budi')).toBe(false);
    expect(deviceKnows(OTHER_KEY, parsed, 'budi')).toBe(false);
  });
});
