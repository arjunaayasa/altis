import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from '../../src/net/index.js';
import { isForbiddenAddress } from '../../src/net/ssrf.js';

// The SSRF guard of the outbound client (spec §6.1, S8): every address a name resolves to passes isBlockedAddress
// before anything connects. IPv6 is normalised first (dns.lookup answers `::ffff:7f00:1`, not `::ffff:127.0.0.1`), and
// an IPv4 address embedded in an IPv6 one is checked as IPv4.

/** Refused: loopback, private, link-local, CGNAT, unspecified, metadata, multicast, reserved, and what does not parse. */
const BLOCKED: [ip: string, why: string][] = [
  ['0.0.0.0', '0/8 unspecified'],
  ['0.1.2.3', '0/8'],
  ['10.0.0.1', '10/8'],
  ['10.255.255.255', '10/8, last'],
  ['100.64.0.1', '100.64/10 CGNAT'],
  ['100.127.255.254', '100.64/10, last'],
  ['127.0.0.1', '127/8 loopback'],
  ['127.255.255.255', '127/8, last'],
  ['169.254.169.254', '169.254/16 cloud metadata'],
  ['169.254.0.1', '169.254/16 link-local'],
  ['172.16.0.1', '172.16/12'],
  ['172.31.255.255', '172.16/12, last'],
  ['192.0.0.8', '192.0.0/24 IETF protocol assignments'],
  ['192.0.0.192', '192.0.0/24, Oracle Cloud metadata'],
  ['192.168.1.1', '192.168/16'],
  ['198.18.0.1', '198.18/15 benchmarking'],
  ['198.19.255.255', '198.18/15, last'],
  ['224.0.0.1', '224/4 multicast'],
  ['239.255.255.250', '224/4, last block'],
  ['240.0.0.1', '240/4 reserved'],
  ['255.255.255.255', '240/4 broadcast'],
  ['::', 'IPv6 unspecified'],
  ['::1', 'IPv6 loopback'],
  ['0:0:0:0:0:0:0:1', 'IPv6 loopback, long form'],
  ['fc00::1', 'fc00::/7 unique local'],
  ['fd12:3456::1', 'fc00::/7, fd half'],
  ['fe80::1', 'fe80::/10 link-local'],
  ['FE80::1', 'fe80::/10, upper case'],
  ['febf::1', 'fe80::/10, last'],
  ['fec0::1', 'fec0::/10 site-local'],
  ['ff02::1', 'ff00::/8 multicast'],
  ['2001::1', '2001::/32 Teredo'],
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo, full form'],
  ['fd00:ec2::254', 'cloud metadata (IPv6)'],
  ['::ffff:10.0.0.1', 'IPv4-mapped, dotted'],
  ['::ffff:7f00:1', 'IPv4-mapped, hex (as dns.lookup answers)'],
  ['0:0:0:0:0:ffff:7f00:0001', 'IPv4-mapped, uncompressed'],
  ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
  ['::7f00:1', 'IPv4-compatible, hex'],
  ['::127.0.0.1', 'IPv4-compatible, dotted'],
  ['64:ff9b::a00:1', 'NAT64 64:ff9b::/96 of 10.0.0.1'],
  ['64:ff9b::10.0.0.1', 'NAT64, dotted'],
  ['64:ff9b:1::a00:1', 'local-use NAT64 64:ff9b:1::/48 of 10.0.0.1'],
  ['64:ff9b:1:a00:0:1::', 'local-use NAT64 not in the /96 form: its IPv4 address cannot be told, so refused'],
  ['2002:7f00:1::', '6to4 of 127.0.0.1'],
  ['2002:a9fe:a9fe::1', '6to4 of 169.254.169.254'],
  ['100::1', '100::/64 discard-only, outside 2000::/3'],
  ['fe80::1%en0', 'a zone index'],
  ['', 'empty'],
  ['localhost', 'a name, not an address'],
  ['1.2.3', 'three parts'],
  ['010.0.0.1', 'a leading zero'],
  ['[::1]', 'brackets'],
  ['1.2.3.4 ', 'a trailing space'],
];

/** Public: these pass. */
const PUBLIC: [ip: string, why: string][] = [
  ['8.8.8.8', 'public DNS'],
  ['1.1.1.1', 'public DNS'],
  ['11.0.0.1', 'just above 10/8'],
  ['100.63.255.255', 'just below 100.64/10'],
  ['100.128.0.0', 'just above 100.64/10'],
  ['169.253.255.255', 'just below 169.254/16'],
  ['172.15.255.255', 'just below 172.16/12'],
  ['172.32.0.1', 'just above 172.16/12'],
  ['192.0.1.1', 'just above 192.0.0/24'],
  ['192.169.0.1', 'just above 192.168/16'],
  ['198.17.255.255', 'just below 198.18/15'],
  ['198.20.0.1', 'just above 198.18/15'],
  ['223.255.255.255', 'just below 224/4'],
  ['2606:4700::1111', 'public IPv6'],
  ['2001:4860:4860::8888', '2001:4860::/32 is not Teredo'],
  ['2a00:1450:4001::1', 'public IPv6'],
  ['2002:808:808::', '6to4 of 8.8.8.8'],
  ['::ffff:8.8.8.8', 'IPv4-mapped public'],
  ['64:ff9b::808:808', 'NAT64 of 8.8.8.8'],
  ['64:ff9b:1::808:808', 'local-use NAT64 of 8.8.8.8 in the /96 form'],
];

describe('isBlockedAddress (S8)', () => {
  it('the table holds at least 36 refused addresses', () => {
    expect(BLOCKED.length).toBeGreaterThanOrEqual(36);
  });

  it.each(BLOCKED)('refuses %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(PUBLIC)('lets %s pass (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('isForbiddenAddress: refused even with catalog.sru.allowPrivateHosts', () => {
  it.each([
    '169.254.169.254',
    '::ffff:169.254.169.254',
    'fd00:ec2::254',
    '100.100.100.200',
    '192.0.0.192',
    '0.0.0.0',
    '::',
    'fe80::1',
    '224.0.0.1',
    'ff02::1',
    '240.0.0.1',
    '2001::1',
    '100::1',
    '64:ff9b:1:a00:0:1::',
    'fe80::1%en0',
    'not-an-ip',
  ])('%s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each(['127.0.0.1', '::1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '100.64.0.1', 'fd12:3456::1', 'fec0::1', '::ffff:10.0.0.1', '8.8.8.8'])(
    '%s is allowed for a private SRU server on the LAN',
    (ip) => {
      expect(isForbiddenAddress(ip)).toBe(false);
    },
  );
});
