import type { IpTrust } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { clientIp } from '../src/http/client-ip.js';

// P15 (decision D13): the client IP is the N-th entry from the right of `[XFF…, peer]` (N = trustProxy.hops); the
// leftmost entry is never used. A request is `collapsed` when an entry is not an IP address, or when a proxy header
// is present but the address chosen is the peer itself and the peer is loopback or private (hops set too low behind
// a local proxy: every visitor would look the same). Otherwise the trust is the persisted `system.ip_trust`.

type Row = [peer: string, xff: string | undefined, xRealIp: string | undefined, hops: number, persisted: IpTrust, ip: string, trust: IpTrust];

const TABLE: Row[] = [
  ['203.0.113.5', undefined, undefined, 0, 'ok', '203.0.113.5', 'ok'],
  ['127.0.0.1', '198.51.100.7', undefined, 1, 'ok', '198.51.100.7', 'ok'],
  ['127.0.0.1', '1.1.1.1, 198.51.100.7', undefined, 1, 'ok', '198.51.100.7', 'ok'],
  ['127.0.0.1', '1.1.1.1, 198.51.100.7', undefined, 2, 'ok', '1.1.1.1', 'ok'],
  ['127.0.0.1', '198.51.100.7', undefined, 0, 'ok', '127.0.0.1', 'collapsed'],
  ['10.0.0.2', undefined, '198.51.100.7', 0, 'ok', '10.0.0.2', 'collapsed'],
  ['192.168.1.20', undefined, undefined, 0, 'ok', '192.168.1.20', 'ok'], // a LAN PC
  ['10.0.0.2', '192.168.1.30', undefined, 1, 'ok', '192.168.1.30', 'ok'], // a LAN proxy
  ['::ffff:203.0.113.5', undefined, undefined, 0, 'ok', '203.0.113.5', 'ok'],
  ['127.0.0.1', 'garbage', undefined, 1, 'ok', '127.0.0.1', 'collapsed'],
  ['203.0.113.5', undefined, undefined, 0, 'spoofable', '203.0.113.5', 'spoofable'],
];

describe('clientIp (P15)', () => {
  it.each(TABLE)('peer %s, XFF %s, X-Real-IP %s, hops %i, persisted %s → %s %s', (peer, xff, xRealIp, hops, persisted, ip, trust) => {
    const r = clientIp({ peer, xff, xRealIp, hops, persisted });
    expect(r.ip).toBe(ip);
    expect(r.trust).toBe(trust);
  });

  it('never uses the leftmost entry when the chain is longer than hops + 1', () => {
    expect(clientIp({ peer: '127.0.0.1', xff: '6.6.6.6, 1.1.1.1, 198.51.100.7', xRealIp: undefined, hops: 2, persisted: 'ok' }).ip).toBe('1.1.1.1');
  });

  it('a chain shorter than hops: the peer, chainShort; collapsed only when a proxy header names a private peer', () => {
    expect(clientIp({ peer: '203.0.113.5', xff: undefined, xRealIp: undefined, hops: 1, persisted: 'ok' })).toEqual({
      ip: '203.0.113.5',
      trust: 'ok',
      chainShort: true,
    });
    expect(clientIp({ peer: '127.0.0.1', xff: '198.51.100.7', xRealIp: undefined, hops: 3, persisted: 'ok' })).toEqual({
      ip: '127.0.0.1',
      trust: 'collapsed',
      chainShort: true,
    });
    expect(clientIp({ peer: '127.0.0.1', xff: '198.51.100.7', xRealIp: undefined, hops: 1, persisted: 'ok' }).chainShort).toBe(false);
  });

  it('collapsed overrides any persisted trust; a public peer behind a proxy header keeps the persisted one', () => {
    expect(clientIp({ peer: '127.0.0.1', xff: '198.51.100.7', xRealIp: undefined, hops: 0, persisted: 'spoofable' }).trust).toBe('collapsed');
    expect(clientIp({ peer: '203.0.113.5', xff: '198.51.100.7', xRealIp: undefined, hops: 0, persisted: 'ok' })).toEqual({
      ip: '203.0.113.5',
      trust: 'ok',
      chainShort: false,
    });
  });

  it.each(['127.0.0.1', '127.8.9.10', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', 'fc00::1', 'fd12::1', 'fe80::1'])(
    'the private or loopback peer %s behind a proxy header with hops 0 → collapsed',
    (peer) => {
      expect(clientIp({ peer, xff: undefined, xRealIp: '198.51.100.7', hops: 0, persisted: 'ok' })).toMatchObject({ ip: peer, trust: 'collapsed' });
    },
  );

  it.each(['172.15.0.1', '172.32.0.1', '100.64.0.1', '8.8.8.8', '2001:db8::1'])('the public peer %s behind a proxy header → not collapsed', (peer) => {
    expect(clientIp({ peer, xff: undefined, xRealIp: '198.51.100.7', hops: 0, persisted: 'ok' }).trust).toBe('ok');
  });

  it('an invalid entry (empty, port, garbage) in the trusted part (the chosen entry and right of it) collapses to the peer', () => {
    for (const [xff, hops] of [
      ['198.51.100.7:443', 1],
      ['1.1.1.1, nope', 1],
      [' , ', 1],
      ['1.1.1.1, nope, 198.51.100.7', 2],
      ['1.1.1.1, 198.51.100.7, ', 2],
    ] as const) {
      expect(clientIp({ peer: '203.0.113.5', xff, xRealIp: undefined, hops, persisted: 'ok' }), xff).toEqual({
        ip: '203.0.113.5',
        trust: 'collapsed',
        chainShort: false,
      });
    }
  });

  it('an invalid entry left of the trusted hops (written by the client, never used) does not collapse', () => {
    for (const [xff, hops, ip] of [
      ['1.1.1.1,,198.51.100.7', 1, '198.51.100.7'],
      ['garbage, 198.51.100.7', 1, '198.51.100.7'],
      ['<script>, 6.6.6.6:80, , 198.51.100.7', 1, '198.51.100.7'],
      ['nope, 1.1.1.1, 198.51.100.7', 2, '1.1.1.1'],
    ] as const) {
      expect(clientIp({ peer: '127.0.0.1', xff, xRealIp: undefined, hops, persisted: 'ok' }), xff).toEqual({ ip, trust: 'ok', chainShort: false });
    }
    // The persisted trust still applies to such a request.
    expect(clientIp({ peer: '127.0.0.1', xff: 'garbage, 198.51.100.7', xRealIp: undefined, hops: 1, persisted: 'spoofable' }).trust).toBe('spoofable');
  });

  it('a chain shorter than hops: every entry is trusted, so any invalid one collapses (chainShort)', () => {
    expect(clientIp({ peer: '127.0.0.1', xff: 'garbage', xRealIp: undefined, hops: 3, persisted: 'ok' })).toEqual({
      ip: '127.0.0.1',
      trust: 'collapsed',
      chainShort: true,
    });
  });

  it('IPv4-mapped entries in XFF are unmapped; IPv6 is kept (lower case)', () => {
    expect(clientIp({ peer: '::ffff:127.0.0.1', xff: '::FFFF:198.51.100.7', xRealIp: undefined, hops: 1, persisted: 'ok' }).ip).toBe('198.51.100.7');
    expect(clientIp({ peer: '127.0.0.1', xff: '2001:DB8::7', xRealIp: undefined, hops: 1, persisted: 'ok' }).ip).toBe('2001:db8::7');
  });

  it('no peer (or an unusable one): no IP, collapsed', () => {
    expect(clientIp({ peer: undefined, xff: undefined, xRealIp: undefined, hops: 0, persisted: 'ok' })).toEqual({ ip: null, trust: 'collapsed', chainShort: false });
    expect(clientIp({ peer: 'unix:/tmp/sock', xff: '198.51.100.7', xRealIp: undefined, hops: 1, persisted: 'ok' })).toMatchObject({ ip: null, trust: 'collapsed' });
  });

  it('a blank proxy header counts as absent', () => {
    expect(clientIp({ peer: '127.0.0.1', xff: '  ', xRealIp: '', hops: 0, persisted: 'ok' })).toEqual({ ip: '127.0.0.1', trust: 'ok', chainShort: false });
  });
});
