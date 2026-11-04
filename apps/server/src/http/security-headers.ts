import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './request-id.js';

/** One year; no `includeSubDomains`: other hosts of the school's domain may well be plain http. */
export const HSTS_VALUE = 'max-age=31536000';

/**
 * The headers every response carries: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and
 * `Strict-Transport-Security` only when `baseUrl` is https (P13: the scheme of the configured baseUrl decides HSTS,
 * never a request header). No baseUrl (not installed yet): no HSTS.
 */
export function securityHeaderEntries(baseUrl: string | undefined): [string, string][] {
  const entries: [string, string][] = [
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'same-origin'],
  ];
  if (baseUrl !== undefined && /^https:\/\//i.test(baseUrl)) entries.push(['Strict-Transport-Security', HSTS_VALUE]);
  return entries;
}

/**
 * Step 2 of the middleware chain (spec §4.7). The headers are set after the rest of the chain has answered, so
 * they are on every response: /_health, problem+json, 404s and errors. `baseUrl` is read per request: start()
 * learns it from config.json only after listening.
 */
export function securityHeaders(baseUrl: () => string | undefined): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    for (const [name, value] of securityHeaderEntries(baseUrl())) c.header(name, value);
  };
}
