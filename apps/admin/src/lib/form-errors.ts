import { MESSAGES } from '@altis/shared';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { ADMIN_MESSAGES, type AdminKey, type TKey, type Translate } from '@/i18n';
import { ApiError } from './api';

/**
 * Form errors of the admin SPA (react-hook-form; Tasks 28 and 29). A field's error message is an i18n key, never
 * text: the field translates it when it renders ({@link fieldErrorText}), so the message follows the language.
 *
 * - The server names fields and checks in a 422 VALIDATION_FAILED (`errors: [{path, code}]`, never values; decision
 *   D10); {@link applyServerErrors} puts each on its field as `form.error.<code>` (`taken`, `too_small`, `too_big`,
 *   `invalid_format`, `archived`, ...; a code with no message becomes `form.error.invalid`).
 * - The forms check their input first with the same Zod objects as the server (D35). With {@link FORM_PARSE} those
 *   checks produce the same keys (`form.error.required` for an empty required text); without it a check keeps Zod's
 *   English message, which is not shown: its issue code (the error's `type`) is.
 * - Any other problem is a sentence for the form's alert: {@link problemText}.
 */

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** True when `key` has a message in the admin catalog or in the shared one. */
export function isMessageKey(key: string): key is TKey {
  return hasOwn(ADMIN_MESSAGES.id, key) || hasOwn(MESSAGES.id, key);
}

/** The message key of a field check that failed (`taken` → `form.error.taken`); `form.error.invalid` for a code without one. */
export function fieldErrorKey(code: string): AdminKey {
  const key = `form.error.${code}`;
  return hasOwn(ADMIN_MESSAGES.id, key) ? (key as AdminKey) : 'form.error.invalid';
}

/** The form-level error of a problem no field of the form owns. */
export const ROOT_ERROR = 'root.server';

/** Whether `values` (a form's values: every field has a default) holds the `.`-joined `path`. */
function hasField(values: unknown, path: string): boolean {
  let node: unknown = values;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null || !hasOwn(node, segment)) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return true;
}

/**
 * Puts the field errors of a VALIDATION_FAILED on the form: each `{path, code}` on the field at `path` (nested paths
 * `.`-joined, as react-hook-form names them) with the type `code` and the message `form.error.<code>`; the first error
 * of a field wins, and the first field gets the focus. A path the form has no field for (or `''`, the body itself)
 * goes to `root.server`; a form that holds no values at all (no `defaultValues`, nothing registered) cannot tell, so
 * there every named path counts as a field. Any other problem changes nothing and is left to the caller.
 */
export function applyServerErrors<T extends FieldValues, C = unknown, O = T>(form: UseFormReturn<T, C, O>, e: ApiError): void {
  if (e.code !== 'VALIDATION_FAILED') return;
  const values: unknown = form.getValues();
  const knowsNoFields = typeof values !== 'object' || values === null || Object.keys(values).length === 0;
  const done = new Set<string>();
  let focused = false;
  for (const { path, code } of e.errors ?? []) {
    const name = path !== '' && (knowsNoFields || hasField(values, path)) ? path : ROOT_ERROR;
    if (done.has(name)) continue;
    done.add(name);
    const shouldFocus: boolean = !focused && name !== ROOT_ERROR;
    form.setError(name as Path<T> | typeof ROOT_ERROR, { type: code, message: fieldErrorKey(code) }, { shouldFocus });
    focused ||= shouldFocus;
  }
}

/** Whether `e` is a VALIDATION_FAILED that names fields ({@link applyServerErrors} has something to show). */
export function hasFieldErrors(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === 'VALIDATION_FAILED' && (e.errors?.length ?? 0) > 0;
}

/** The text a field shows for `error`: its message when that is a known key, else `form.error.<type>`, else a generic one. */
export function fieldErrorText(t: Translate, error: { type?: string | number; message?: string } | undefined): string | undefined {
  if (error === undefined) return undefined;
  if (error.message !== undefined && isMessageKey(error.message)) return t(error.message);
  return t(fieldErrorKey(String(error.type ?? '')));
}

/**
 * The field message of a PASSWORD_TOO_WEAK, by its registered `reason` (D10: `too_short`, `too_long`, `common`); the
 * generic `error.PASSWORD_TOO_WEAK` for any other.
 */
export function passwordWeaknessKey(e: ApiError): TKey {
  switch (e.reason) {
    case 'too_short':
      return 'form.password.too_short';
    case 'too_long':
      return 'form.password.too_long';
    case 'common':
      return 'form.password.common';
    default:
      return 'error.PASSWORD_TOO_WEAK';
  }
}

/** The Zod error map of the forms: every issue's message is its `form.error.<code>` key. */
export function formErrorMap(issue: z.core.$ZodRawIssue): string {
  if (issue.input === undefined || (issue.code === 'too_small' && issue.origin === 'string' && Number(issue.minimum) <= 1)) {
    return 'form.error.required';
  }
  return fieldErrorKey(issue.code ?? 'custom');
}

/** The parse options for `zodResolver(schema, FORM_PARSE)`: Zod's checks report `form.error.<code>` keys. */
export const FORM_PARSE: z.core.ParseContext<z.core.$ZodIssue> = { error: formErrorMap };

/** Seconds up to this many are told in seconds; longer waits in whole minutes, rounded up. */
const SECONDS_SHOWN = 120;

/**
 * The sentence for a form's alert or a screen's notice: the localized `error.<CODE>` of a problem, plus how long to
 * wait when a 429 says (`Retry-After`); the connection message when no answer came at all (fetch's TypeError); else
 * the generic server error.
 */
export function problemText(t: Translate, e: unknown): string {
  if (e instanceof ApiError) {
    const text = t(`error.${e.code}` as TKey);
    if (e.status !== 429 || e.retryAfterS === undefined || e.retryAfterS <= 0) return text;
    const wait =
      e.retryAfterS < SECONDS_SHOWN
        ? t(e.retryAfterS === 1 ? 'form.retry_after_seconds_one' : 'form.retry_after_seconds', { seconds: e.retryAfterS })
        : t('form.retry_after_minutes', { minutes: Math.ceil(e.retryAfterS / 60) });
    return `${text} ${wait}`;
  }
  if (e instanceof TypeError) return t('form.network');
  return t('error.INTERNAL');
}
