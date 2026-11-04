import { randomBytes } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { LoginResponse, MeResponse, RecoveryCodesResponse, TwoFactorSetupResponse } from '@altis/shared/api/auth';
import type { RoleListResponse } from '@altis/shared/api/roles';
import type { UserCreateBody, UserDetail } from '@altis/shared/api/users';
import { Authenticator } from './authenticator.js';

// The staff API as the specs use it to prepare what a test needs (users, 2FA, roles) and global-setup.ts to point the
// install's SMTP at the catcher: a Playwright APIRequestContext (its own cookie jar, never global fetch, M24) that
// speaks the SPA's protocol: the CSRF token of `GET auth/me` (pre-session, D20) or of the session (the X-CSRF-Token
// header of a login or a rotation, S9) on every write, and the install's origin in `Origin` (§7.4).

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A refused API request: the status and the problem+json code (R53). */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly body: string,
    what: string,
  ) {
    super(`${what} → ${status}${code === null ? '' : ` ${code}`}: ${body.slice(0, 300)}`);
  }
}

/** What opens request contexts: Playwright's `request` (global setup) or the `playwright.request` of a test. */
export interface RequestFactory {
  newContext(options: { baseURL: string }): Promise<APIRequestContext>;
}

export class StaffApi {
  readonly #ctx: APIRequestContext;
  readonly #origin: string;
  #csrf = '';

  private constructor(ctx: APIRequestContext, baseURL: string) {
    this.#ctx = ctx;
    this.#origin = new URL(baseURL).origin;
  }

  /** A new cookie jar with its pre-session CSRF token. */
  static async open(request: RequestFactory, baseURL: string): Promise<StaffApi> {
    const api = new StaffApi(await request.newContext({ baseURL }), baseURL);
    await api.me();
    return api;
  }

  /** `GET auth/me`, which also gives the CSRF token of whatever session the jar holds. */
  async me(): Promise<MeResponse> {
    const me = await this.call<MeResponse>('GET', 'auth/me');
    this.#csrf = me.csrfToken;
    return me;
  }

  /** `<method> /api/v1/<path>` with the CSRF token and Origin on writes; the parsed answer, or ApiError. */
  async call<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const write = method !== 'GET';
    const res = await this.#ctx.fetch(`/api/v1/${path}`, {
      method,
      headers: { accept: 'application/json', ...(write ? { 'x-csrf-token': this.#csrf, origin: this.#origin } : {}) },
      ...(body === undefined ? {} : { data: body }),
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const token = res.headers()['x-csrf-token'];
    if (token !== undefined && token !== '') this.#csrf = token;
    const text = await res.text();
    if (!res.ok()) {
      let code: string | null = null;
      try {
        const problem = JSON.parse(text) as { code?: unknown };
        if (typeof problem.code === 'string') code = problem.code;
      } catch {
        // not problem+json
      }
      throw new ApiError(res.status(), code, text, `${method} ${path}`);
    }
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  /** Signs in; with 2FA enabled, `authenticator` gives the code. Ends with the session's own CSRF token. */
  async signIn(username: string, password: string, authenticator?: Authenticator): Promise<LoginResponse> {
    let res = await this.call<LoginResponse>('POST', 'auth/login', { username, password });
    if (res.stage === 'mfa') {
      if (authenticator === undefined) throw new Error(`${username} has 2FA enabled: signIn needs its authenticator`);
      res = await this.call<LoginResponse>('POST', 'auth/2fa/verify', { code: await authenticator.nextCode() });
    }
    await this.me();
    return res;
  }

  /** `POST auth/reauth` (§7.3), for the routes that ask for it. */
  async reauth(password: string, authenticator?: Authenticator): Promise<void> {
    await this.call('POST', 'auth/reauth', authenticator === undefined ? { password } : { password, code: await authenticator.nextCode() });
  }

  dispose(): Promise<void> {
    return this.#ctx.dispose();
  }
}

/** A staff user a spec made for itself. */
export interface StaffUser {
  id: string;
  username: string;
  name: string;
  email: string;
  password: string;
}

const suffix = (): string => randomBytes(3).toString('hex');

/** A password that passes the policy (≥ 10 characters, not a common one), new every time. */
export function newPassword(): string {
  return `E2E ${suffix()} Katalog ${suffix()}`;
}

/**
 * A new active staff user `<prefix>-<random>` with an e-mail address at perpus.test and no roles, through `admin` (a
 * session holding `system.users.manage`). The password needs no change at the first sign-in unless asked.
 */
export async function createStaff(admin: StaffApi, prefix: string, o: Partial<Pick<UserCreateBody, 'mustChangePassword' | 'mfaRequired' | 'locale'>> = {}): Promise<StaffUser> {
  const username = `${prefix}-${suffix()}`;
  const name = `E2E ${prefix} ${suffix()}`;
  const email = `${username}@perpus.test`;
  const password = newPassword();
  const body: UserCreateBody = { username, name, email, password, mustChangePassword: o.mustChangePassword ?? false, mfaRequired: o.mfaRequired ?? false };
  if (o.locale !== undefined) body.locale = o.locale;
  const user = await admin.call<UserDetail>('POST', 'users', body);
  return { id: user.id, username, name, email, password };
}

/** Gives `user` the system role `roleKey` globally (`PUT users/:id/roles` asks for a reauth, done here). */
export async function assignRole(admin: StaffApi, adminPassword: string, userId: string, roleKey: string): Promise<void> {
  const roles = await admin.call<RoleListResponse>('GET', 'roles');
  const role = roles.items.find((r) => r.key === roleKey);
  if (role === undefined) throw new Error(`no role ${roleKey}`);
  await admin.reauth(adminPassword);
  await admin.call('PUT', `users/${encodeURIComponent(userId)}/roles`, { assignments: [{ roleId: role.id, branchId: null }] });
}

/**
 * Enables 2FA for `user` through the API as the user does it (setup, then a code of the secret): the authenticator
 * of the new secret and the 10 recovery codes. Enabling ends every session of the user (S11), this one included.
 */
export async function enableTwoFactor(request: RequestFactory, baseURL: string, user: StaffUser): Promise<{ authenticator: Authenticator; recoveryCodes: string[] }> {
  const api = await StaffApi.open(request, baseURL);
  try {
    await api.signIn(user.username, user.password);
    const setup = await api.call<TwoFactorSetupResponse>('POST', 'auth/2fa/setup');
    const authenticator = new Authenticator(setup.secret);
    const { codes } = await api.call<RecoveryCodesResponse>('POST', 'auth/2fa/enable', { code: await authenticator.nextCode() });
    return { authenticator, recoveryCodes: codes };
  } finally {
    await api.dispose();
  }
}
