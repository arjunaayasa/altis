import { randomToken } from '@altis/core';

// The Content-Security-Policy of the HTML pages (spec §7.4: admin and OPAC). Scripts and styles load from the app's
// own origin, or inline with the request's nonce (the admin index.html, Radix's <style> elements through setNonce()).
// 1b allows no extra `connect-src` origin.

/** What a nonce may contain: base64url, so it cannot end the quoted source expression it sits in. */
const NONCE_TEXT = /^[A-Za-z0-9_-]+$/;

/** A fresh nonce for one response: 16 random bytes, 22 base64url characters. */
export function cspNonce(): string {
  return randomToken(16);
}

/**
 * The policy for a page whose inline scripts and styles carry `nonce`.
 *
 * @throws TypeError when `nonce` is not base64url text (anything else could rewrite the policy)
 */
export function cspHeader(nonce: string): string {
  if (typeof nonce !== 'string' || !NONCE_TEXT.test(nonce)) throw new TypeError('cspHeader: the nonce must be base64url text');
  return (
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; ` +
    `img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'`
  );
}
