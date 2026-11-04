// The browser's X-Forwarded-For test of Diagnostik and the wizard (spec §11, P15; decision C22; 1b D27).
//
// The browser polls `GET …/probe/poll` twice through the host's proxies: once clean (no X-Forwarded-For of its own),
// once with `X-Forwarded-For: <forged>`. Each poll answers the chain as the server received it and the client IP the
// configured `trustProxy.hops` derive from it. Every proxy in front appends one entry to what arrives, so:
//
// - the clean request's entry count is the number of hops to trust (`suggestedHops`);
// - the configuration is `spoofable` when the client IP derived for the forged request is the forged value itself:
//   the hops reach past the proxies into the entry the client wrote, so anyone can pick their address and dodge the
//   per-IP limits (P15).

/** `trustProxy.hops` never goes above this (the wizard's and `PUT system/config`'s bound). */
export const XFF_HOPS_MAX = 10;

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** An address as the server compares it: trimmed, `::ffff:a.b.c.d` unmapped, lower case (IPv6). */
function canonical(text: string): string {
  const trimmed = text.trim();
  return (MAPPED_V4.exec(trimmed)?.[1] ?? trimmed).toLowerCase();
}

/**
 * What the two polls of the XFF test show (see the top of this file): `spoofable` when the IP derived for the forged
 * request is the forged value (compared as addresses; an empty derivation never is), `suggestedHops` the number of
 * non-blank entries of the clean request's X-Forwarded-For, at most {@link XFF_HOPS_MAX}. `forgedXff` is what the
 * forged request arrived with; it is shown to the admin, the outcome does not depend on it.
 */
export function analyzeXff(o: { cleanXff: readonly string[]; forgedXff: readonly string[]; forged: string; forgedDerived: string }): {
  spoofable: boolean;
  suggestedHops: number;
} {
  const derived = canonical(o.forgedDerived);
  const spoofable = derived !== '' && derived === canonical(o.forged);
  const entries = o.cleanXff.filter((entry) => entry.trim() !== '').length;
  return { spoofable, suggestedHops: Math.min(entries, XFF_HOPS_MAX) };
}

/**
 * The client IP `hops` derive from a request whose X-Forwarded-For entries (blanks dropped) are `xff`, as
 * http/client-ip.ts derives it from `[...xff, peer]`: the `hops`-th entry from the right, or '' for the socket peer
 * (hops 0, or a chain shorter than `hops`), which {@link analyzeXff} never takes for the forged value. The wizard judges
 * its forged poll with it at the hops confirmed in `POST config`: the poll itself ran before config.json existed, at
 * the pre-install hops.
 */
export function xffClientAt(xff: readonly string[], hops: number): string {
  return Number.isSafeInteger(hops) && hops >= 1 && hops <= xff.length ? xff[xff.length - hops]! : '';
}
