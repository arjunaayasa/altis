import { ERROR_CODES, type ErrorCode } from '@altis/shared';
import { ApiError, type FieldError, type HttpMethod } from '@/lib/api';

/**
 * The wizard's only way to the server (spec §7.7, §9.5; plan Task 30): `/install/api/*` on this origin, JSON in and
 * out, cookies included (the claim travels in the HttpOnly `altis_install` cookie). Every request carries the
 * wizard's `X-CSRF-Token` once one is known: the one `POST claim` answered, or the one `GET checks` repeats (a reloaded
 * page lost the first). A problem+json answer, or any other failure status, becomes an {@link ApiError} (the type of
 * lib/api.ts); a network failure rejects with fetch's own TypeError.
 *
 * Nothing here retries or redirects: the wizard decides (a 403 INSTALL_CLAIM_REQUIRED shows the claim step again, a
 * 409 INSTALL_STEP_ORDER asks `GET checks` where the install stands, a 404 means the install is complete).
 */

const BASE = '/install/api/';

let csrf: string | null = null;

/** Sets the wizard's CSRF token (null forgets it). {@link installApi} also takes it from `claim` and `checks`. */
export function setInstallCsrf(token: string | null): void {
  csrf = token === '' ? null : token;
}

/** The wizard's CSRF token, or '' before the claim. */
export function installCsrf(): string {
  return csrf ?? '';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isJson = (res: Response): boolean => /[/+]json\b/i.test(res.headers.get('Content-Type') ?? '');

/** `Retry-After` in seconds (a number of seconds or an HTTP date), or undefined. */
function retryAfter(res: Response): number | undefined {
  const value = res.headers.get('Retry-After')?.trim() ?? '';
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** The {@link ApiError} of a failed answer (a body that is not the server's problem+json gives `INTERNAL`). */
export async function installProblem(res: Response): Promise<ApiError> {
  const body: unknown = isJson(res) ? await res.json().catch(() => undefined) : undefined;
  const problem = isRecord(body) ? body : {};
  const text = (key: string): string | undefined => (typeof problem[key] === 'string' ? (problem[key] as string) : undefined);
  const code: ErrorCode =
    typeof problem['code'] === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, problem['code']) ? (problem['code'] as ErrorCode) : 'INTERNAL';
  const errors = Array.isArray(problem['errors'])
    ? (problem['errors'] as unknown[])
        .filter((e): e is FieldError => isRecord(e) && typeof e['path'] === 'string' && typeof e['code'] === 'string')
        .map((e) => ({ path: e.path, code: e.code }))
    : undefined;
  const details: NonNullable<ConstructorParameters<typeof ApiError>[2]> = {
    problemJson: /^\s*application\/problem\+json\b/i.test(res.headers.get('Content-Type') ?? ''),
  };
  for (const key of ['detail', 'title', 'reason', 'traceId'] as const) {
    const value = text(key);
    if (value !== undefined) details[key] = value;
  }
  if (errors !== undefined) details.errors = errors;
  const wait = retryAfter(res);
  if (wait !== undefined) details.retryAfterS = wait;
  return new ApiError(res.status, code, details);
}

/** The steps whose answer carries the wizard's CSRF token. */
const TOKEN_PATHS: ReadonlySet<string> = new Set(['claim', 'checks']);

/**
 * Sends `method /install/api/<path>` with `body` as JSON and resolves to the parsed answer (undefined for an empty
 * one). Rejects with an {@link ApiError} for a failure status.
 */
export async function installApi<T>(method: HttpMethod, path: string, body?: unknown, o: { signal?: AbortSignal } = {}): Promise<T> {
  const rel = path.replace(/^\/+/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf !== null) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${BASE}${rel}`, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(o.signal === undefined ? {} : { signal: o.signal }),
  });
  if (!res.ok) throw await installProblem(res);
  const text = await res.text();
  const answer = (text === '' ? undefined : isJson(res) ? JSON.parse(text) : text) as T;
  if (TOKEN_PATHS.has(rel) && isRecord(answer) && typeof answer['csrfToken'] === 'string') setInstallCsrf(answer['csrfToken']);
  return answer;
}
