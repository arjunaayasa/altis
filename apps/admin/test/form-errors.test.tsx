import { LoginBody } from '@altis/shared/api/auth';
import { zodResolver } from '@hookform/resolvers/zod';
import { act, renderHook } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ADMIN_MESSAGES, translate } from '@/i18n';
import { ApiError } from '@/lib/api';
import { FORM_PARSE, applyServerErrors, fieldErrorKey, problemText } from '@/lib/form-errors';

// Form errors (Task 28): a 422 VALIDATION_FAILED names fields and checks (`{path, code}`, never values; D10); the SPA
// puts each on its field as the message key `form.error.<code>`, which the field translates. The client-side checks
// of the shared Zod schemas (D35) produce the same keys.

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('id', key, params);

/** A form as a screen holds it: reading `formState.errors` while rendering subscribes to them. */
function useUserForm() {
  const form = useForm({ defaultValues: { username: '', name: '', address: { city: '' } } });
  void form.formState.errors;
  return form;
}

describe('applyServerErrors', () => {
  it("{path: 'username', code: 'taken'} sets the username field's message to form.error.taken", () => {
    const { result } = renderHook(useUserForm);
    act(() => applyServerErrors(result.current, new ApiError(422, 'VALIDATION_FAILED', { errors: [{ path: 'username', code: 'taken' }] })));
    expect(result.current.getFieldState('username').error?.message).toBe('form.error.taken');
    expect(result.current.getFieldState('username').error?.type).toBe('taken');
    expect(result.current.getFieldState('name').error).toBeUndefined();
  });

  it('maps every listed field (nested paths too); the first error of a field wins', () => {
    const { result } = renderHook(useUserForm);
    const e = new ApiError(422, 'VALIDATION_FAILED', {
      errors: [
        { path: 'name', code: 'too_big' },
        { path: 'name', code: 'invalid_format' },
        { path: 'address.city', code: 'too_small' },
        { path: 'username', code: 'archived' },
      ],
    });
    act(() => applyServerErrors(result.current, e));
    expect(result.current.getFieldState('name').error?.message).toBe('form.error.too_big');
    expect(result.current.getFieldState('address.city').error?.message).toBe('form.error.too_small');
    expect(result.current.getFieldState('username').error?.message).toBe('form.error.archived');
  });

  it('a path the form has no field for, or the body itself, goes to root.server; an unknown code to form.error.invalid', () => {
    const { result } = renderHook(useUserForm);
    act(() =>
      applyServerErrors(
        result.current,
        new ApiError(422, 'VALIDATION_FAILED', {
          errors: [
            { path: 'version', code: 'too_small' },
            { path: 'username', code: 'brand_new_code' },
          ],
        }),
      ),
    );
    expect(result.current.formState.errors.root?.['server']?.message).toBe('form.error.too_small');
    expect(result.current.getFieldState('username').error?.message).toBe('form.error.invalid');
  });

  it('every form.error.<code> it can produce exists in both languages', () => {
    for (const code of ['taken', 'too_small', 'too_big', 'invalid_format', 'archived', 'invalid_type', 'invalid_value', 'not_found', 'other']) {
      const key = fieldErrorKey(code);
      expect(Object.keys(ADMIN_MESSAGES.id)).toContain(key);
      expect(Object.keys(ADMIN_MESSAGES.en)).toContain(key);
    }
  });
});

describe('client-side checks with the shared schemas', () => {
  it('Zod issues become the same message keys (an empty required text is form.error.required)', async () => {
    const { result } = renderHook(() =>
      useForm({ resolver: zodResolver(LoginBody, FORM_PARSE), defaultValues: { username: '', password: '', remember: false } }),
    );
    await act(() => result.current.trigger());
    expect(result.current.getFieldState('username').error?.message).toBe('form.error.required');
    expect(result.current.getFieldState('password').error?.message).toBe('form.error.required');

    const Email = z.strictObject({ email: z.email().max(191) });
    const { result: email } = renderHook(() => useForm({ resolver: zodResolver(Email, FORM_PARSE), defaultValues: { email: 'x' } }));
    await act(() => email.current.trigger());
    expect(email.current.getFieldState('email').error?.message).toBe('form.error.invalid_format');
  });
});

describe('problemText', () => {
  it('a 429 adds the wait: seconds below two minutes, else minutes rounded up', () => {
    const short = new ApiError(429, 'AUTH_TOO_MANY_ATTEMPTS', { retryAfterS: 42 });
    expect(problemText(t, short)).toBe(`${t('error.AUTH_TOO_MANY_ATTEMPTS')} ${t('form.retry_after_seconds', { seconds: 42 })}`);
    expect(problemText(t, short)).toContain('42 detik');
    expect(problemText(t, new ApiError(429, 'AUTH_TOO_MANY_ATTEMPTS', { retryAfterS: 601 }))).toContain('sekitar 11 menit');
    expect(problemText(t, new ApiError(429, 'AUTH_BUSY'))).toBe(t('error.AUTH_BUSY'));
  });

  it('other problems: the localized code; no answer at all: the connection message', () => {
    expect(problemText(t, new ApiError(403, 'AUTH_ACCOUNT_DISABLED'))).toBe(t('error.AUTH_ACCOUNT_DISABLED'));
    expect(problemText(t, new TypeError('Failed to fetch'))).toBe(t('form.network'));
    expect(problemText(t, new Error('boom'))).toBe(t('error.INTERNAL'));
  });
});
