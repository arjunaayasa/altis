import { DEFAULT_LOCALE, resolveLocale, type Locale } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import { queryOptions, skipToken, useQuery, type QueryKey, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { api, setCsrfToken, setSessionUser, type ApiOptions } from './api';

/**
 * Who is signed in (spec §4.8, §7.1). `GET auth/me` is the SPA's first request after a page load: it is also where a
 * remember-me cookie becomes a session, so every other query waits for it (`enabled: me !== undefined`, through
 * {@link useApiQuery}). Its `csrfToken` is the token of the next write (D20).
 */

export const ME_KEY = ['auth', 'me'] as const;

/** The last user `GET auth/me` named in this page (signing out in between does not change it). */
let lastUser: string | null = null;

/** Whether `key` is `auth/me` or under it (its hold). */
const isMeKey = (key: QueryKey): boolean => key[0] === ME_KEY[0] && key[1] === ME_KEY[1];

export const meQuery = queryOptions({
  queryKey: ME_KEY,
  queryFn: async ({ client }): Promise<MeResponse> => {
    const me = await api<MeResponse>('GET', 'auth/me');
    const user = me.authenticated ? me.user.id : null;
    // Another user signed in on this browser: nothing read for the one before may be shown to them.
    if (user !== null && lastUser !== null && user !== lastUser) client.removeQueries({ predicate: (q) => !isMeKey(q.queryKey) });
    if (user !== null) lastUser = user;
    setCsrfToken(me.csrfToken);
    setSessionUser(user);
    return me;
  },
  staleTime: 30_000,
});

/**
 * The hold on the cached `auth/me` (lib/sign-in.ts `holdMe`): while it is set, no component reads `auth/me` again on
 * its own (mounting, the window regaining focus, an invalidation), so the screen that shows the recovery codes after
 * the server ended the session stays up. The cached answer keeps its real age, so an explicit fresh read
 * (`fetchQuery` with `staleTime: 0`: refreshMe, the sign-in gate) still reaches the server. It lives under
 * {@link ME_KEY}, so whatever forgets `auth/me` (`removeQueries({queryKey: ME_KEY})`) ends it too.
 */
export const ME_HOLD_KEY = [...ME_KEY, 'hold'] as const;

/** The hold flag: only ever written with `setQueryData`, never fetched. */
const meHoldQuery = queryOptions<boolean>({ queryKey: ME_HOLD_KEY, queryFn: skipToken, staleTime: Infinity });

type SignedIn = Extract<MeResponse, { authenticated: true }>;

/**
 * The `auth/me` the shell shows its screens (components/shell/app-shell.tsx): the live answer while the session
 * lasts. When it ended while a form was being filled, the shell keeps the page up with the last signed-in answer, so
 * that the screens neither unmount the form nor turn it read-only under the user's hands. Unset outside the shell.
 */
export const ShellMeContext = createContext<SignedIn | undefined>(undefined);

/** The answer of `GET auth/me`, or undefined until it came; inside the shell, what the shell shows ({@link ShellMeContext}). */
export function useMe(): MeResponse | undefined {
  const shown = useContext(ShellMeContext);
  const held = useQuery(meHoldQuery).data === true;
  const live = useQuery({ ...meQuery, enabled: !held }).data;
  return shown ?? live;
}

/** A query of the API that waits for `GET auth/me` (and for its own `enabled`). */
export function useApiQuery<T>(
  o: { queryKey: QueryKey; path: string; enabled?: boolean; request?: ApiOptions } & Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn' | 'enabled'>,
): UseQueryResult<T> {
  const me = useMe();
  const { path, request, enabled, ...rest } = o;
  return useQuery<T>({
    ...rest,
    queryFn: () => api<T>('GET', path, undefined, request),
    enabled: me !== undefined && (enabled ?? true),
  });
}

/** The UI language: the user's own, else the library's (`me.user.locale ?? me.library.locale`); Indonesian until known. */
export function localeOf(me: MeResponse | undefined): Locale {
  if (me === undefined) return DEFAULT_LOCALE;
  return me.authenticated ? resolveLocale(me.user.locale, me.library.locale) : resolveLocale(me.library.locale);
}

const DEFAULT_PATH = '/admin';

/**
 * Where a page under the shell must send the user instead (the route gate), or null when they may stay:
 * - signed out → `/admin/login`, with `?next=` back to `path` (unless that is `/admin` itself);
 * - signed in up to the password but the second factor still owed → the matching step of the sign-in;
 * - a password that must change first → `/admin/profile/password` (the only page until it has).
 */
export function gateTarget(me: MeResponse, path: string): string | null {
  if (!me.authenticated) {
    const pathname = path.split(/[?#]/, 1)[0] ?? '';
    return pathname === DEFAULT_PATH || pathname === `${DEFAULT_PATH}/` ? '/admin/login' : `/admin/login?next=${encodeURIComponent(path)}`;
  }
  if (me.stage === 'mfa') return '/admin/login/2fa';
  if (me.stage === 'mfa_setup') return '/admin/login/setup-2fa';
  if (me.stage === 'recovery') return '/admin/login/recovery';
  if (me.mustChangePassword && path.split(/[?#]/, 1)[0] !== '/admin/profile/password') return '/admin/profile/password';
  return null;
}
