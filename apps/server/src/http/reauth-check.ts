import { DomainError } from '@altis/shared';
import { REAUTH_MS } from './auth.js';
import type { RouteContext } from './route.js';

// A re-authentication a handler asks for itself, when a route needs one only for some of its requests (the export of a
// report that holds personal data, the download of such a run): the route declares no `reauth`, and its handler (or
// its `prepare`) calls this once it knows. The window is the one of the declared check (http/auth.ts).

/**
 * Refuses the request unless its session re-authenticated within the re-authentication window.
 *
 * @throws DomainError `AUTH_REQUIRED` without a session; `AUTH_REAUTH_REQUIRED` (401) when the session never
 *   re-authenticated or did so too long ago
 */
export function assertRecentReauth(rc: RouteContext<unknown, unknown, unknown>): void {
  if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
  if (!hasRecentReauth(rc)) throw new DomainError('AUTH_REAUTH_REQUIRED');
}

/** True when the request's session re-authenticated within the re-authentication window. */
export function hasRecentReauth(rc: RouteContext<unknown, unknown, unknown>): boolean {
  const at = rc.auth?.session.reauthAt ?? null;
  return at !== null && rc.now - at <= REAUTH_MS;
}
