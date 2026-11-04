import type { LoginResponse, MeResponse, SessionStage } from '@altis/shared/api/auth';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { safeNext } from './api';
import { ME_HOLD_KEY, ME_KEY, meQuery } from './me';

/**
 * The sign-in steps (spec §7.1; Task 28): which page a session continues at, the gate of each sign-in page, and the
 * cached `GET auth/me` around the moments a session starts or ends.
 *
 * - `/admin/login` (password), then by the answer's stage `/admin/login/2fa` (`mfa`), `/admin/login/setup-2fa`
 *   (`mfa_setup`) or `/admin/login/recovery` (`recovery`); a full session goes to `/admin/profile/password` when the
 *   password must change first, else to `safeNext(next)` (M11). `next` (and the remember-me choice, for the 2FA step)
 *   travel along in the query.
 * - Enabling or disabling 2FA ends every session of the user, the current one included (S11, D22): the screen keeps
 *   showing what it must (the recovery codes) with {@link holdMe}, and "Masuk lagi" goes through {@link forgetMe}.
 *   Leaving that screen any other way ends the hold too ({@link endHold}, on every navigation).
 */

export const LOGIN_PATH = '/admin/login';

/** The page a password that must change first leads to (it keeps `next` for afterwards, M11). */
export const PASSWORD_PATH = '/admin/profile/password';

/** The page of each sign-in step. */
export const STEP_PATHS = {
  login: LOGIN_PATH,
  mfa: '/admin/login/2fa',
  mfa_setup: '/admin/login/setup-2fa',
  recovery: '/admin/login/recovery',
} as const satisfies Record<'login' | Exclude<SessionStage, 'full'>, string>;

export type SignInStep = keyof typeof STEP_PATHS;

/**
 * Why the sign-in page opened, told above the form (`?notice=`). `session_ended`: the session of an open page ended
 * under the user's hands (lib/api.ts `sessionEndedHref`).
 */
export const SIGN_IN_NOTICES = ['2fa_ended', '2fa_enabled', '2fa_disabled', 'password_reset', 'session_ended'] as const;

export type SignInNotice = (typeof SIGN_IN_NOTICES)[number];

/** The query of the sign-in pages. */
export interface SignInSearch {
  /** Where to go once signed in (checked by safeNext only at the end). */
  next?: string;
  notice?: SignInNotice;
  /** The remember-me choice of the password step, for the 2FA step (the token is issued only after 2FA). */
  remember?: boolean;
}

/** The sign-in pages' `validateSearch`: anything else in the query is dropped. */
export function validateSignInSearch(search: Record<string, unknown>): SignInSearch {
  const out: SignInSearch = {};
  const { next, notice, remember } = search;
  if (typeof next === 'string' && next !== '') out.next = next;
  if (typeof notice === 'string' && (SIGN_IN_NOTICES as readonly string[]).includes(notice)) out.notice = notice as SignInNotice;
  if (remember === true || remember === 'true') out.remember = true;
  return out;
}

/** The `validateSearch` of the password page, which a required change reaches with the sign-in's `next`. */
export function validateNextSearch(search: Record<string, unknown>): Pick<SignInSearch, 'next'> {
  const { next } = search;
  return typeof next === 'string' && next !== '' ? { next } : {};
}

/** `path` with the given query values (those not undefined). */
export function hrefWith(path: string, query: Readonly<Record<string, string | boolean | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  const text = params.toString();
  return text === '' ? path : `${path}?${text}`;
}

/** Where a session at `o.stage` continues: its pending step (keeping `next`), else the password page or `next`. */
export function continueAt(o: Pick<LoginResponse, 'stage' | 'mustChangePassword'>, search: SignInSearch): string {
  if (o.stage === 'mfa') return hrefWith(STEP_PATHS.mfa, { next: search.next, remember: search.remember });
  if (o.stage !== 'full') return hrefWith(STEP_PATHS[o.stage], { next: search.next });
  if (o.mustChangePassword) return hrefWith(PASSWORD_PATH, { next: search.next });
  return safeNext(search.next ?? null);
}

/** The sign-in page again, keeping `next`, with a notice. */
export function loginHref(search: SignInSearch, notice?: SignInNotice): string {
  return hrefWith(LOGIN_PATH, { next: search.next, notice });
}

/**
 * The `beforeLoad` of the sign-in page of `step`: sends the visitor where their session stands. The password page
 * shows for anyone not fully signed in (starting over is allowed) and checks `auth/me` afresh; a full session goes on
 * to `next`. A step page needs a session at that very step: signed out → the password page, another stage → its own
 * page. When `auth/me` cannot be read the page shows anyway (its own request then reports the problem).
 */
export async function signInGate(queryClient: QueryClient, step: SignInStep, search: SignInSearch): Promise<void> {
  let me: MeResponse;
  try {
    me = step === 'login' ? await queryClient.fetchQuery({ ...meQuery, staleTime: 0 }) : await queryClient.ensureQueryData(meQuery);
  } catch {
    return;
  }
  if (!me.authenticated) {
    if (step !== 'login') throw redirect({ href: loginHref(search) });
    return;
  }
  if (step === 'login' && me.stage !== 'full') return;
  const target = continueAt(me, search);
  if (target.split('?', 1)[0] !== STEP_PATHS[step]) throw redirect({ href: target });
}

/** Whether {@link holdMe} holds the cached `auth/me`. */
function isHeld(queryClient: QueryClient): boolean {
  return queryClient.getQueryData<boolean>(ME_HOLD_KEY) === true;
}

/** Reads `auth/me` afresh (a session started, moved on, or changed), ending any hold; forgets it when that fails. */
export async function refreshMe(queryClient: QueryClient): Promise<void> {
  if (isHeld(queryClient)) queryClient.setQueryData(ME_HOLD_KEY, false);
  try {
    await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
  } catch {
    queryClient.removeQueries({ queryKey: ME_KEY });
  }
}

/**
 * Keeps the cached `auth/me` on screen after the server ended the session (2FA enabled or disabled, S11): no
 * component reads it again on its own (lib/me.ts `ME_HOLD_KEY`), so nothing answers "signed out" and blanks the shell
 * while it shows the recovery codes or the "Masuk lagi" button. The cached answer keeps its real age, so the explicit
 * reads ({@link refreshMe}, the sign-in gate) still reach the server. {@link forgetMe} and {@link endHold} end it.
 */
export function holdMe(queryClient: QueryClient): void {
  void queryClient.cancelQueries({ queryKey: ME_KEY, exact: true });
  if (queryClient.getQueryData<MeResponse>(ME_KEY) !== undefined) queryClient.setQueryData(ME_HOLD_KEY, true);
}

/** Forgets the cached `auth/me` (the session is gone), and with it any hold: the next page reads it afresh. */
export function forgetMe(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: ME_KEY });
}

/**
 * The root route's `beforeLoad` (every navigation): leaving the page that holds `auth/me` forgets it, since the
 * session behind it is gone. The gates of the next page then read `auth/me` afresh and send the user to sign in.
 */
export function endHold(queryClient: QueryClient): void {
  if (isHeld(queryClient)) forgetMe(queryClient);
}
