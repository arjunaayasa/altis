import net from 'node:net';
import { hit, type BucketName, type SettingsCache } from '@altis/core';
import { withTx, type DbHandle } from '@altis/db';
import { DomainError, type IpTrust } from '@altis/shared';
import type { Context } from 'hono';
import type { AppEnv } from './request-id.js';

// The client IP (spec P15, §4.7 step 3, decision D13) and the per-IP rate limits of a route (step 6).
//
// The client IP is the `hops`-th entry from the right of `[XFF…, peer]`, where `peer` is the socket's address and
// `hops` is config.json's `trustProxy.hops`: with one proxy in front (hops 1) it is the address that proxy appended.
// The leftmost entry, which the client writes itself, is never used unless the chain is exactly that long.
//
// Trust (IpTrust): a request is `collapsed` when a trusted entry of the chain (the chosen one or one right of it) is
// not an IP address, or when a proxy header (X-Forwarded-For, X-Real-IP) is present and yet the address chosen is
// the peer itself, a loopback or private one: hops is set too low behind a local proxy, and every visitor would get
// the proxy's address (Review Focus 1).
// Otherwise it is the persisted `system.ip_trust` (written by 1c's Diagnostik). While the trust is not `ok`, every
// per-IP bucket is skipped, so that one shared address never locks a whole library out.

/** What {@link clientIp} decides for one request. */
export interface ClientIp {
  /** The client address (IPv4-mapped IPv6 unmapped, IPv6 in lower case); null without a usable peer. */
  ip: string | null;
  trust: IpTrust;
  /** The chain is shorter than `hops + 1` entries: the peer was taken instead. */
  chainShort: boolean;
}

/** Loopback, private and link-local ranges: a peer there is a proxy on the same machine or network. */
const LOCAL = new net.BlockList();
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('10.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('172.16.0.0', 12, 'ipv4');
LOCAL.addSubnet('192.168.0.0', 16, 'ipv4');
LOCAL.addSubnet('169.254.0.0', 16, 'ipv4');
LOCAL.addAddress('::1', 'ipv6');
LOCAL.addSubnet('fc00::', 7, 'ipv6');
LOCAL.addSubnet('fe80::', 10, 'ipv6');

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** `text` as an IP address (trimmed, `::ffff:a.b.c.d` → `a.b.c.d`, IPv6 lower-cased), or null when it is not one. */
function normalizeIp(text: string): string | null {
  const trimmed = text.trim();
  const unmapped = MAPPED_V4.exec(trimmed)?.[1] ?? trimmed;
  const family = net.isIP(unmapped);
  if (family === 0) return null;
  return family === 6 ? unmapped.toLowerCase() : unmapped;
}

function isLocal(ip: string): boolean {
  return LOCAL.check(ip, net.isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}

/**
 * 1c Task 23 (the probe's `peerPrivate`): whether a socket address is loopback, private or link-local (`::ffff:`
 * forms unmapped); false for anything that is not an address.
 */
export function isLocalPeer(peer: string | undefined): boolean {
  const ip = peer === undefined ? null : normalizeIp(peer);
  return ip !== null && isLocal(ip);
}

/** A header that is present and not blank. */
function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * The client IP of a request and how far it can be trusted (P15). `xff` is the X-Forwarded-For header (several
 * headers joined with commas), `xRealIp` the X-Real-IP header (only its presence counts), `hops` the configured
 * proxy count and `persisted` the setting `system.ip_trust`.
 *
 * - `chain = [...xff.split(','), peer]`; the client IP is `chain[chain.length - 1 - hops]`, or the peer when the
 *   chain is shorter (`chainShort`).
 * - `collapsed` (and the peer as the IP) when an entry from the chosen one rightwards (the whole chain when it is
 *   short) is not an IP address; entries left of it are ignored. `collapsed` when a proxy header is present, the IP
 *   chosen is the peer itself, and the peer is loopback or private; otherwise `persisted`.
 * - Without a peer that is an IP address (none, or a Unix socket): `{ip: null, trust: 'collapsed'}`.
 */
export function clientIp(o: { peer: string | undefined; xff: string | undefined; xRealIp: string | undefined; hops: number; persisted: IpTrust }): ClientIp {
  const peer = o.peer === undefined ? null : normalizeIp(o.peer);
  if (peer === null) return { ip: null, trust: 'collapsed', chainShort: false };
  const proxied = present(o.xff) || present(o.xRealIp);

  // Invalid entries stay in the chain as null, so that the hops still count from the right.
  const chain: (string | null)[] = [...(present(o.xff) ? o.xff.split(',').map(normalizeIp) : []), peer];
  const hops = Number.isSafeInteger(o.hops) && o.hops > 0 ? o.hops : 0;
  const index = chain.length - 1 - hops;
  const chainShort = index < 0;
  // Only the entries the derivation trusts (the chosen one and those the proxies appended right of it) must be
  // addresses: the ones left of it are written by the client and never used, so garbage there must not let a client
  // switch off the per-IP buckets (D13) or hide its address.
  if (chain.slice(Math.max(index, 0)).some((entry) => entry === null)) return { ip: peer, trust: 'collapsed', chainShort };

  const fromPeer = chainShort || index === chain.length - 1;
  const ip = chainShort ? peer : chain[index]!;
  const collapsed = proxied && fromPeer && isLocal(peer);
  return { ip, trust: collapsed ? 'collapsed' : o.persisted, chainShort };
}

/** The socket address @hono/node-server hands over (`c.env.incoming.socket.remoteAddress`), when there is one. */
export function peerOf(c: Context<AppEnv>): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined;
  const address = env?.incoming?.socket?.remoteAddress;
  return typeof address === 'string' ? address : undefined;
}

/**
 * Step 3 of the chain (spec §4.7): sets the request's `ip` and `ipTrust` with the configured `hops`. It reads no
 * database, so pages and /_health stay database-free (S29): `ipTrust` is `collapsed` or `ok` here, and the persisted
 * `system.ip_trust` is applied per route by {@link applyPersistedIpTrust}.
 */
export function setClientIp(c: Context<AppEnv>, hops: number): void {
  const r = clientIp({ peer: peerOf(c), xff: c.req.header('x-forwarded-for'), xRealIp: c.req.header('x-real-ip'), hops, persisted: 'ok' });
  c.set('ip', r.ip);
  c.set('ipTrust', r.trust);
}

/**
 * The rest of step 3, for a route that may use the database: a request that is not collapsed takes the persisted
 * `system.ip_trust` (through the settings cache). Without a database nothing changes.
 */
export async function applyPersistedIpTrust(c: Context<AppEnv>, settings: SettingsCache, db: DbHandle | undefined): Promise<void> {
  if (db === undefined || c.get('ipTrust') !== 'ok') return;
  c.set('ipTrust', await settings.get<IpTrust>(db.db, 'system.ip_trust'));
}

/**
 * Step 6: counts one hit on each of `buckets` for `ip`, each in a transaction of its own (a refusal must not roll its
 * count back), when `ip` is known and trusted (`trust === 'ok'`; decision D13 skips every per-IP bucket otherwise).
 *
 * @throws DomainError `AUTH_TOO_MANY_ATTEMPTS` (`meta.retryAfterS`, the longest wait) when a bucket refuses, after
 *   every bucket was counted; `DB_UNAVAILABLE` when there is something to count and no database
 */
export async function countIpLimits(
  db: DbHandle | undefined,
  buckets: readonly BucketName[],
  ip: string | null,
  trust: IpTrust,
  now: number,
): Promise<void> {
  if (buckets.length === 0 || ip === null || trust !== 'ok') return;
  if (db === undefined) throw new DomainError('DB_UNAVAILABLE');
  let refusedFor = -1;
  for (const name of buckets) {
    const h = await withTx(db, (trx) => hit(trx, name, ip, now));
    if (!h.allowed) refusedFor = Math.max(refusedFor, h.retryAfterS);
  }
  if (refusedFor >= 0) throw new DomainError('AUTH_TOO_MANY_ATTEMPTS', { meta: { retryAfterS: refusedFor } });
}
