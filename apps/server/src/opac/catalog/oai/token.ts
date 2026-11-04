import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { KeyringEntry } from '@altis/core';
import { decodeBase64Url, parseStrictJson } from '@altis/crypto';
import { isUlid } from '@altis/shared';
import { z } from 'zod';
import { isOaiSetSpec, type OaiListVerb, type OaiPrefix } from './protocol.js';

// The OAI-PMH resumption token (Phase 2 spec §10, D2-24, decision P2-30, M15): stateless, so any process of the
// install answers the next page and a restart loses no harvest.
//
//   <base64url(JSON payload)>.<base64url(HMAC-SHA256(key, <the first part as written>))>
//
// The payload names the list (verb, prefix, set, from, until), the keyset position (`after`, the last record id
// sent), the `completeListSize` counted on the first page (`size`) and the expiry (`exp`, 24 hours after it was
// issued). `from` is the inclusive lower bound and `until` the exclusive upper bound of `changed_at`, in epoch ms, as
// the first request's arguments resolved them.
//
// The key is HKDF-SHA256 of a keyring entry (no salt, info `altis oai-token v1`), so the token's key is separated
// from the keyring's other use (sealing secrets). A token is signed with the active entry's key and accepted under
// the key of any entry still in the keyring (M15): a key rotation does not break a harvest in progress. The MAC is
// compared as written (constant time), so no other spelling of the same bytes is accepted.

/** How long a token is valid (§10: 24 hours). */
export const OAI_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** The longest token read; anything longer is refused before any MAC is computed. */
export const OAI_TOKEN_MAX_LENGTH = 1024;

/** HKDF info of the token key (the purpose `oai-token`). */
const KEY_INFO = 'altis oai-token v1';

const KEY_BYTES = 32;

export interface OaiTokenPayload {
  v: 1;
  verb: OaiListVerb;
  prefix: OaiPrefix;
  /** The setSpec asked for, or null. */
  set: string | null;
  /** `changed_at >= from` (epoch ms), or null. */
  from: number | null;
  /** `changed_at < until` (epoch ms, exclusive), or null. */
  until: number | null;
  /** The last record id already sent: the next page starts after it. */
  after: string;
  /** completeListSize, counted on the first page. */
  size: number;
  /** Epoch ms after which the token is refused. */
  exp: number;
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** An epoch-ms bound: negative before 1970 (`from=0001-01-01` is a valid request). */
const epochMs = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

const PAYLOAD = z.strictObject({
  v: z.literal(1),
  verb: z.enum(['ListRecords', 'ListIdentifiers']),
  prefix: z.enum(['oai_dc', 'marc21']),
  set: z.string().max(256).refine(isOaiSetSpec).nullable(),
  from: epochMs.nullable(),
  until: epochMs.nullable(),
  after: z.string().refine(isUlid),
  size: count,
  exp: epochMs,
});

const PART = /^[A-Za-z0-9_-]+$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The token keys of `keyring` (M15): HKDF-SHA256 of every entry's key, the active entry's first; sign with `[0]`,
 * verify with all of them.
 *
 * @throws TypeError unless the keyring has exactly one active entry and every key is 32 bytes (config.json
 *   guarantees both)
 */
export function oaiTokenKeys(keyring: readonly KeyringEntry[]): Buffer[] {
  const active = keyring.filter((e) => e.active);
  if (active.length !== 1) throw new TypeError(`oaiTokenKeys: the keyring must have exactly one active key, found ${active.length}`);
  return [...active, ...keyring.filter((e) => !e.active)].map((e) => {
    const raw = typeof e.key === 'string' ? decodeBase64Url(e.key) : null;
    if (raw === null || raw.length !== KEY_BYTES) throw new TypeError('oaiTokenKeys: every keyring key must be 32 bytes of base64url');
    return Buffer.from(hkdfSync('sha256', raw, new Uint8Array(0), KEY_INFO, KEY_BYTES));
  });
}

function macOf(body: string, key: Buffer): string {
  return createHmac('sha256', key).update(body, 'ascii').digest('base64url');
}

/** `p` signed with `key` (the active key: `oaiTokenKeys(…)[0]`). */
export function signToken(p: OaiTokenPayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
  return `${body}.${macOf(body, key)}`;
}

/**
 * The payload of `token` when its MAC verifies under one of `keys`, its payload has the right shape and it has not
 * expired at `now`; null otherwise (OAI-PMH's badResumptionToken). The payload is parsed only after its MAC verified.
 */
export function verifyToken(token: string, keys: readonly Buffer[], now: number): OaiTokenPayload | null {
  if (typeof token !== 'string' || token.length > OAI_TOKEN_MAX_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  if (!PART.test(body) || !PART.test(mac)) return null;
  const given = Buffer.from(mac, 'ascii');
  let verified = false;
  for (const key of keys) {
    const expected = Buffer.from(macOf(body, key), 'ascii');
    if (expected.length === given.length && timingSafeEqual(expected, given)) verified = true;
  }
  if (!verified) return null;
  const bytes = decodeBase64Url(body);
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = parseStrictJson(utf8.decode(bytes));
  } catch {
    return null;
  }
  const parsed = PAYLOAD.safeParse(value);
  if (!parsed.success || parsed.data.exp <= now) return null;
  return parsed.data;
}
