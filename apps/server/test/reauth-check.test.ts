import { describe, expect, it } from 'vitest';
import { REAUTH_MS } from '../src/http/auth.js';
import { assertRecentReauth, hasRecentReauth } from '../src/http/reauth-check.js';
import type { RouteContext } from '../src/http/route.js';

// The re-authentication a handler asks for itself (a personal report's export or download): the session must have
// re-authenticated within the window of the declared check, else 401 AUTH_REAUTH_REQUIRED.

const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);

/** A route context whose session re-authenticated at `reauthAt` (null: never), or one without a session. */
function rc(reauthAt: number | null | 'no-session'): RouteContext<unknown, unknown, unknown> {
  const auth = reauthAt === 'no-session' ? null : { session: { reauthAt } };
  return { now: NOW, auth } as unknown as RouteContext<unknown, unknown, unknown>;
}

describe('assertRecentReauth', () => {
  it('passes within the window, its last millisecond included', () => {
    expect(() => assertRecentReauth(rc(NOW))).not.toThrow();
    expect(() => assertRecentReauth(rc(NOW - REAUTH_MS))).not.toThrow();
    expect(hasRecentReauth(rc(NOW - 1000))).toBe(true);
  });

  it('refuses a session that never re-authenticated or did so too long ago, and a request without a session', () => {
    expect(() => assertRecentReauth(rc(null))).toThrow(expect.objectContaining({ code: 'AUTH_REAUTH_REQUIRED', status: 401 }));
    expect(() => assertRecentReauth(rc(NOW - REAUTH_MS - 1))).toThrow(expect.objectContaining({ code: 'AUTH_REAUTH_REQUIRED' }));
    expect(() => assertRecentReauth(rc('no-session'))).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED', status: 401 }));
    expect(hasRecentReauth(rc(null))).toBe(false);
  });
});
