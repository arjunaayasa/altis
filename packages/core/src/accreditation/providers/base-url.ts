import { isIP } from 'node:net';
import { isBlockedAddress } from '../../net/ssrf.js';

// How reachable the installation is, judged from its configured base address alone: no name is looked up and no
// connection is made, so the class is a guess from the address as written (the automation and website indicators say
// so in their notes).
//
// - No address, an empty one, one that does not parse or one that is not a web address (http, https): `unset`.
// - `localhost` or a name under `.localhost`, an IPv4 address in 127.0.0.0/8 or `::1`: `localhost`, reachable only on
//   the computer ALTIS runs on. Decided first, because the outbound guard counts loopback among the private ranges.
// - Any other IP address the outbound guard refuses (private, shared, link-local, unique-local, reserved and the like;
//   its private and its forbidden classes both count here): `private`.
// - A name of one label (`perpus`) or under a suffix that only a local network resolves (`.local`, `.lan`,
//   `.internal`, `.intranet`, `.home.arpa`): `private`.
// - Anything else: `public`.

/** How reachable the installation is from its base address. */
export type BaseUrlClass = 'public' | 'private' | 'localhost' | 'unset';

/** The suffixes of names that only a local network resolves. */
const LOCAL_SUFFIXES = Object.freeze(['.local', '.lan', '.internal', '.intranet', '.home.arpa']);

const UNSET = Object.freeze({ class: 'unset' as const, host: null });

/** The host of a web address, lower case, without IPv6 brackets or a final dot; null when there is none. */
function hostOf(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host === '' ? null : host;
}

/** Whether `host` reaches only the computer ALTIS runs on. */
function isLoopback(host: string, ip: number): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (ip === 4) return host.split('.')[0] === '127';
  return ip === 6 && host === '::1';
}

/** The reachability class of `baseUrl` (config.json's `baseUrl`) and its host. */
export function baseUrlClass(baseUrl: string | null): { class: BaseUrlClass; host: string | null } {
  if (baseUrl === null || baseUrl.trim() === '') return { ...UNSET };
  const host = hostOf(baseUrl);
  if (host === null) return { ...UNSET };
  const ip = isIP(host);
  if (isLoopback(host, ip)) return { class: 'localhost', host };
  if (ip !== 0) return { class: isBlockedAddress(host) ? 'private' : 'public', host };
  if (!host.includes('.') || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { class: 'private', host };
  return { class: 'public', host };
}
