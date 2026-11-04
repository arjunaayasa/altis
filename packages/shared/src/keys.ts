/**
 * Key normalization and trust states shared by `packages/core`, `apps/server` and the SPA.
 * No Node built-ins here: the browser bundles this package.
 */

/**
 * The normalized form behind every `*_key` column (spec §6.1): NFKC, trim, every run of whitespace becomes one
 * space, upper case. Two spellings of the same human code (full-width letters, composed or decomposed accents, stray
 * or doubled spaces, another case) give the same key.
 */
export function normalizeKey(s: string): string {
  return s.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * How far the client IP of a request can be trusted (P15, decision D13):
 * - `ok`: the N-th entry from the right of `[XFF…, peer]` is a real visitor address;
 * - `spoofable`: hops are set but the proxy chain is shorter than that, so the address may come from the client;
 * - `collapsed`: every visitor appears as the same address (a proxy in front, hops 0).
 *
 * Anything but `ok` switches the per-IP login buckets off.
 */
export const IP_TRUST_VALUES = Object.freeze(['ok', 'spoofable', 'collapsed'] as const);

export type IpTrust = (typeof IP_TRUST_VALUES)[number];
