import { DomainError } from '@altis/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { inheritRequestId, type AppEnv } from './request-id.js';

// Method override (spec §5 P10, decision C37, preflight M27; 1c Task 16). A WAF in front of a shared host
// (ModSecurity, Imunify360) may refuse PUT, PATCH and DELETE; the admin then sends `POST` with
// `X-HTTP-Method-Override: PUT|PATCH|DELETE` (Diagnostik's browser test or a WAF page tells it to). P10 allows that
// "hanya untuk request terautentikasi yang lolos CSRF":
//
// - createApp registers {@link methodOverride} right after the request id, security headers and catch-all
//   middleware (M27): such a POST is dispatched again through the whole app with the named method, as a new Request
//   that keeps every header (the override header too) and the body, under the same request id. Its own refusal (any
//   other value) is therefore a problem like every other, with `X-Request-Id` and the security headers.
// - The route chain (http/route.ts) then sees a PUT/PATCH/DELETE carrying the header ({@link isOverridden}) and lets
//   it through only on a cookie route with a resolved session, never on a Bearer, `session: 'none'` or wizard route,
//   nor on a probe route (`*.probe.methods.*`, which tests the real methods); step 8 (CSRF/Origin) applies to it as
//   to any write.

/** The request header that names the method a `POST` stands for. */
export const METHOD_OVERRIDE_HEADER = 'X-HTTP-Method-Override';

/** The methods a `POST` may stand for. */
const OVERRIDABLE: ReadonlySet<string> = new Set(['PUT', 'PATCH', 'DELETE']);

/**
 * Whether the request was sent through method override: its method is not POST and it carries the header (the inner
 * request {@link methodOverride} dispatches keeps it). A real PUT that carries the header counts too: it gets no
 * more than an overridden one would.
 */
export function isOverridden(c: Context<AppEnv>): boolean {
  return c.req.method !== 'POST' && c.req.header(METHOD_OVERRIDE_HEADER) !== undefined;
}

/**
 * The middleware: a `POST` with {@link METHOD_OVERRIDE_HEADER} `PUT`, `PATCH` or `DELETE` (in any case) is answered by
 * `app.fetch(new Request(request, {method}), env)`, which runs the whole chain again with that method (the request id
 * of this request, the header and the body kept). Every other request passes on.
 *
 * @throws DomainError `METHOD_OVERRIDE_DENIED` (403) for a POST whose header names anything else
 */
export function methodOverride(app: Hono<AppEnv>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const value = c.req.header(METHOD_OVERRIDE_HEADER);
    if (c.req.method !== 'POST' || value === undefined) return next();
    const method = value.trim().toUpperCase();
    if (!OVERRIDABLE.has(method)) throw new DomainError('METHOD_OVERRIDE_DENIED');
    const inner = new Request(c.req.raw, { method });
    inheritRequestId(inner, c.get('requestId'));
    return app.fetch(inner, c.env);
  };
}
