// The SSRF guard of the outbound client (spec §6.1, preflight S8). The client resolves a name once, checks every
// address it got here, and connects only to a checked one, so neither a second resolution (DNS rebinding) nor one bad
// address among good ones reaches an internal service.
//
// An address is parsed with net.isIP and normalised: IPv6 is expanded to its eight groups first, because dns.lookup
// answers an unnormalised form (`::ffff:7f00:1`, not `::ffff:127.0.0.1`). An IPv4 address embedded in an IPv6 one
// (mapped, compatible, NAT64, 6to4) is taken out and checked as IPv4. Anything that does not parse is refused.
//
// Each address falls in one of three classes:
// - `public`: may be contacted;
// - `private`: loopback, RFC 1918, CGNAT, unique local and the like. Refused unless `catalog.sru.allowPrivateHosts`
//   (a campus SRU server on the LAN; super admin only, M11);
// - `forbidden`: refused even then. These are unspecified, link-local and cloud metadata (169.254.169.254,
//   fd00:ec2::254, 100.100.100.200, 192.0.0.192), multicast and reserved addresses, Teredo, and IPv6 outside
//   2000::/3 that embeds no IPv4 address. None of them is an SRU server.

import { isIP } from 'node:net';

type AddressClass = 'public' | 'private' | 'forbidden';

/** An IPv4 range: the network as a 32-bit number and its prefix length. */
interface V4Range {
  base: number;
  bits: number;
  cls: Exclude<AddressClass, 'public'>;
}

/** A dotted IPv4 address (already valid by net.isIP) as an unsigned 32-bit number. */
function v4Number(ip: string): number {
  return ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
}

function range(cidr: string, cls: V4Range['cls']): V4Range {
  const [ip, bits] = cidr.split('/') as [string, string];
  return { base: v4Number(ip), bits: Number(bits), cls };
}

// The first match wins, so the single metadata addresses come before the ranges that hold them.
const V4_RANGES: readonly V4Range[] = [
  range('100.100.100.200/32', 'forbidden'), // Alibaba Cloud metadata
  range('192.0.0.192/32', 'forbidden'), // Oracle Cloud metadata (legacy)
  range('0.0.0.0/8', 'forbidden'), // "this network", unspecified
  range('169.254.0.0/16', 'forbidden'), // link-local, cloud metadata
  range('224.0.0.0/4', 'forbidden'), // multicast
  range('240.0.0.0/4', 'forbidden'), // reserved, broadcast
  range('10.0.0.0/8', 'private'),
  range('100.64.0.0/10', 'private'), // CGNAT
  range('127.0.0.0/8', 'private'), // loopback
  range('172.16.0.0/12', 'private'),
  range('192.0.0.0/24', 'private'), // IETF protocol assignments
  range('192.168.0.0/16', 'private'),
  range('198.18.0.0/15', 'private'), // benchmarking
];

function classifyV4(n: number): AddressClass {
  for (const r of V4_RANGES) {
    const size = 2 ** (32 - r.bits);
    if (n >= r.base && n < r.base + size) return r.cls;
  }
  return 'public';
}

/** Two 16-bit groups as the IPv4 address they hold. */
function v4Of(high: number, low: number): number {
  return high * 65536 + low;
}

/**
 * The eight 16-bit groups of an IPv6 address that net.isIP accepted (a trailing dotted IPv4 part included), or null
 * when it does not expand to exactly eight.
 */
function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const n = v4Number(tail);
    text = `${text.slice(0, lastColon + 1)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string | undefined): number[] | null => {
    if (part === undefined || part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  if (head === null || rest === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function classifyV6(g: number[]): AddressClass {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const zeroTo = (last: number): boolean => g.slice(0, last + 1).every((x) => x === 0);
  if (zeroTo(7)) return 'forbidden'; // ::
  if (zeroTo(6) && g7 === 1) return 'private'; // ::1
  // An embedded IPv4 address is checked as IPv4.
  if (zeroTo(4) && g5 === 0xffff) return classifyV4(v4Of(g6, g7)); // mapped ::ffff:0:0/96
  if (zeroTo(5)) return classifyV4(v4Of(g6, g7)); // compatible ::/96
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return classifyV4(v4Of(g6, g7)); // NAT64 64:ff9b::/96
    // Local-use NAT64 64:ff9b:1::/48 (RFC 8215) in its /96 form; any other form hides where its IPv4 address sits.
    if (g2 === 1) return g3 === 0 && g4 === 0 && g5 === 0 ? classifyV4(v4Of(g6, g7)) : 'forbidden';
  }
  if (g0 === 0x2002) return classifyV4(v4Of(g1, g2)); // 6to4 2002::/16, bits 16-47
  if (g0 === 0x2001 && g1 === 0) return 'forbidden'; // Teredo 2001::/32
  if (g0 === 0xfd00 && g1 === 0x0ec2 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0x254) {
    return 'forbidden'; // cloud metadata fd00:ec2::254
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return 'forbidden'; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return 'private'; // site-local fec0::/10 (deprecated)
  if ((g0 & 0xff00) === 0xff00) return 'forbidden'; // multicast ff00::/8
  if ((g0 & 0xe000) !== 0x2000) return 'forbidden'; // not global unicast 2000::/3: reserved
  return 'public';
}

function classify(ip: string): AddressClass {
  const kind = isIP(ip);
  if (kind === 4) return classifyV4(v4Number(ip));
  if (kind === 6) {
    // A zone index (`fe80::1%en0`) scopes the address to one interface of this machine.
    if (ip.includes('%')) return 'forbidden';
    const groups = expandV6(ip);
    return groups === null ? 'forbidden' : classifyV6(groups);
  }
  return 'forbidden';
}

/**
 * Whether the outbound client refuses `ip` (S8): loopback, private, link-local, CGNAT, unspecified, cloud metadata,
 * multicast or reserved, as IPv4 or IPv6 (an IPv4 address embedded in an IPv6 one is checked as IPv4). Anything that
 * does not parse as an address is refused.
 */
export function isBlockedAddress(ip: string): boolean {
  return classify(ip) !== 'public';
}

/**
 * Whether `ip` stays refused with `catalog.sru.allowPrivateHosts` on: it lets loopback and private networks through,
 * never unspecified, link-local, metadata, multicast or reserved addresses. Internal to the outbound client.
 */
export function isForbiddenAddress(ip: string): boolean {
  return classify(ip) === 'forbidden';
}
