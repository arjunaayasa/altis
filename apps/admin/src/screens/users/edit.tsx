import { UserCreateBody, UserPatchBody, type UserDetail } from '@altis/shared/api/users';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useState, type ComponentProps } from 'react';
import { useForm, type FieldValues, type UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { useDateTime } from '@/components/data-table';
import { CheckField, Field, Notice, ProblemAlert, RefetchProblem, SELECT_CLASS } from '@/components/form-field';
import { BackLink, ErrorState, FORM_FULL, FormBar, FormSection, LoadingState, PageHead, StatusText, Tag } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type Translate } from '@/i18n';
import { holds, meId } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { applyServerErrors, problemText } from '@/lib/form-errors';
import { ME_KEY, useApiQuery, useMe } from '@/lib/me';
import { RolesEditor } from './roles-editor';

/**
 * A staff user: create (`POST users`) and edit (`PATCH users/:id`), plus their role assignments (roles-editor.tsx).
 * The forms validate with the shared request schemas (`UserCreateBody`, `UserPatchBody`) before anything is sent; the
 * server's field errors (`taken`, `too_big`, ...) land under their fields (applyServerErrors).
 *
 * - An edit sends the row's `version` and only the fields that changed (CONFLICT_STALE when someone saved meanwhile:
 *   the data can be reloaded).
 * - On one's own page the 2FA requirement is shown but not editable, and never sent (D24: the server refuses
 *   `mfaRequired` on oneself with AUTHZ_ESCALATION).
 * - Without `system.users.manage` both pages are read-only (no save button); creating says it is not allowed.
 */

type CreateInput = z.input<typeof UserCreateBody>;
type PatchInput = z.input<typeof UserPatchBody>;

/** An empty text field is "not set" (null); surrounding spaces of an e-mail address are not part of it. */
const emailValue = (v: unknown): unknown => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v);
const localeValue = (v: unknown): unknown => (v === '' ? null : v);

function LocaleSelect({ t, ...props }: { t: Translate } & ComponentProps<'select'>) {
  return (
    <select className={SELECT_CLASS} {...props}>
      <option value="">{t('users.locale.library')}</option>
      <option value="id">{t('users.locale.id')}</option>
      <option value="en">{t('users.locale.en')}</option>
    </select>
  );
}

/** What a failed submission shows above the form; field errors go under their fields. */
function submitProblem<T extends FieldValues, O>(t: Translate, form: UseFormReturn<T, unknown, O>, e: unknown): string {
  if (e instanceof ApiError) applyServerErrors(form, e);
  return problemText(t, e);
}

export function UserCreateScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'system.users.manage');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const form = useForm<CreateInput, unknown, UserCreateBody>({
    resolver: zodResolver(UserCreateBody),
    defaultValues: { username: '', name: '', email: null, password: '', locale: null, mfaRequired: false, mustChangePassword: true },
  });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    try {
      const user = await api<UserDetail>('POST', 'users', values);
      queryClient.setQueryData(['users', 'detail', user.id], user);
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
      form.reset(values);
      await navigate({ href: `/admin/users/${encodeURIComponent(user.id)}`, state: { created: true } });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PASSWORD_TOO_WEAK') {
        form.setError('password', { type: 'weak', message: 'error.PASSWORD_TOO_WEAK' }, { shouldFocus: true });
      }
      setProblem(submitProblem(t, form, e));
    }
  });

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="grid gap-3">
        <BackLink to="/admin/users">{t('users.back')}</BackLink>
        <PageHead title={t('users.new.title')} />
      </div>
      {/* The server would refuse (and record the refusal): say so before anything is typed. */}
      {!canManage && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
      {problem !== null && <Notice kind="error">{problem}</Notice>}
      <form noValidate onSubmit={(e) => void submit(e)}>
        <FormSection title={t('users.form.account')} intro={t('users.form.account_intro')} disabled={!canManage}>
          <Field label={t('users.field.username')} hint={t('users.field.username_hint')} error={errors.username}>
            {(c) => <Input {...c} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} {...form.register('username')} />}
          </Field>
          <Field label={t('users.field.name')} error={errors.name}>
            {(c) => <Input {...c} autoComplete="off" maxLength={191} {...form.register('name')} />}
          </Field>
          <Field label={t('users.field.email')} hint={t('users.field.email_hint')} error={errors.email}>
            {(c) => <Input {...c} type="email" autoComplete="off" maxLength={191} {...form.register('email', { setValueAs: emailValue })} />}
          </Field>
        </FormSection>
        <FormSection title={t('users.form.access')} intro={t('users.form.access_intro')} disabled={!canManage}>
          <Field label={t('users.field.password')} hint={t('users.field.password_hint')} error={errors.password}>
            {(c) => <Input {...c} type="password" autoComplete="new-password" {...form.register('password')} />}
          </Field>
          <Field label={t('users.field.locale')} error={errors.locale}>
            {(c) => <LocaleSelect t={t} {...c} {...form.register('locale', { setValueAs: localeValue })} />}
          </Field>
          <div className={`grid content-start gap-3 ${FORM_FULL}`}>
            <CheckField label={t('users.field.mfa_required')} hint={t('users.field.mfa_required_hint')} {...form.register('mfaRequired')} />
            <CheckField label={t('users.field.must_change_password')} {...form.register('mustChangePassword')} />
          </div>
        </FormSection>
        {canManage && (
          <FormBar>
            <Button type="submit" disabled={isSubmitting}>
              {t(isSubmitting ? 'form.saving' : 'form.save')}
            </Button>
            <Button asChild variant="outline">
              <Link to="/admin/users">{t('form.cancel')}</Link>
            </Button>
            {isDirty && <StatusText tone="warn">{t('system.unsaved')}</StatusText>}
          </FormBar>
        )}
      </form>
    </div>
  );
}

function patchValues(u: UserDetail): PatchInput {
  return { version: u.version, username: u.username, name: u.name, email: u.email, locale: u.locale, mfaRequired: u.mfaRequired };
}

function UserForm({ user, canManage, isSelf, reload }: { user: UserDetail; canManage: boolean; isSelf: boolean; reload(): Promise<UserDetail | undefined> }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string; stale?: boolean } | null>(null);
  const form = useForm<PatchInput, unknown, UserPatchBody>({ resolver: zodResolver(UserPatchBody), defaultValues: patchValues(user) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);

  const submit = form.handleSubmit(async (values) => {
    setNotice(null);
    const before = form.formState.defaultValues ?? {};
    const body: UserPatchBody = { version: values.version };
    if (values.username !== before.username) body.username = values.username;
    if (values.name !== before.name) body.name = values.name;
    if ((values.email ?? null) !== (before.email ?? null)) body.email = values.email ?? null;
    if ((values.locale ?? null) !== (before.locale ?? null)) body.locale = values.locale ?? null;
    if (!isSelf && values.mfaRequired !== undefined && values.mfaRequired !== before.mfaRequired) body.mfaRequired = values.mfaRequired;
    if (Object.keys(body).length === 1) {
      form.reset(values);
      return;
    }
    try {
      const updated = await api<UserDetail>('PATCH', `users/${encodeURIComponent(user.id)}`, body);
      queryClient.setQueryData(['users', 'detail', user.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
      if (isSelf) void queryClient.invalidateQueries({ queryKey: ME_KEY });
      form.reset(patchValues(updated));
      setNotice({ kind: 'success', text: t('form.saved') });
    } catch (e) {
      setNotice({ kind: 'error', text: submitProblem(t, form, e), stale: e instanceof ApiError && e.code === 'CONFLICT_STALE' });
    }
  });

  const reloadData = async (): Promise<void> => {
    const latest = await reload();
    if (latest !== undefined) form.reset(patchValues(latest));
    setNotice(null);
  };

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-4">
      {notice !== null && (
        <Notice
          kind={notice.kind}
          action={
            notice.stale === true ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void reloadData()}>
                {t('form.reload_data')}
              </Button>
            ) : undefined
          }
        >
          {notice.text}
        </Notice>
      )}
      <FormSection title={t('users.form.account')} intro={t('users.form.account_intro')} disabled={!canManage}>
        <Field label={t('users.field.username')} hint={t('users.field.username_hint')} error={errors.username}>
          {(c) => <Input {...c} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} {...form.register('username')} />}
        </Field>
        <Field label={t('users.field.name')} error={errors.name}>
          {(c) => <Input {...c} autoComplete="off" maxLength={191} {...form.register('name')} />}
        </Field>
        <Field label={t('users.field.email')} hint={t('users.field.email_hint')} error={errors.email}>
          {(c) => <Input {...c} type="email" autoComplete="off" maxLength={191} {...form.register('email', { setValueAs: emailValue })} />}
        </Field>
        <Field label={t('users.field.locale')} error={errors.locale}>
          {(c) => <LocaleSelect t={t} {...c} {...form.register('locale', { setValueAs: localeValue })} />}
        </Field>
        <div className={FORM_FULL}>
          {isSelf ? (
            <CheckField label={t('users.field.mfa_required')} hint={t('users.field.mfa_required_self')} checked={user.mfaRequired} disabled readOnly />
          ) : (
            <CheckField label={t('users.field.mfa_required')} hint={t('users.field.mfa_required_hint')} {...form.register('mfaRequired')} />
          )}
        </div>
      </FormSection>
      {canManage && (
        <FormBar className="border-t-0 pt-0">
          <Button type="submit" disabled={isSubmitting}>
            {t(isSubmitting ? 'form.saving' : 'form.save')}
          </Button>
          {isDirty && <StatusText tone="warn">{t('system.unsaved')}</StatusText>}
        </FormBar>
      )}
    </form>
  );
}

export function UserEditScreen() {
  const t = useT();
  const me = useMe();
  const formatDate = useDateTime();
  const { userId = '' } = useParams({ strict: false }) as { userId?: string };
  // Opened right after "Tambah pengguna": the next step is the roles.
  const created = useRouterState({ select: (s) => s.location.state.created === true });
  const user = useApiQuery<UserDetail>({ queryKey: ['users', 'detail', userId], path: `users/${encodeURIComponent(userId)}` });
  const canManage = holds(me, 'system.users.manage');

  // The data wins over an error: a failed background refetch keeps the forms and what was typed (RefetchProblem).
  if (user.data === undefined && user.isError) {
    return (
      <div className="grid max-w-5xl gap-6">
        <BackLink to="/admin/users">{t('users.back')}</BackLink>
        <ErrorState title={problemText(t, user.error)} error={null} onRetry={() => void user.refetch()} retrying={user.isFetching} />
      </div>
    );
  }
  if (user.data === undefined) return <LoadingState />;
  const u = user.data;
  const isSelf = meId(me) === u.id;
  const reload = async (): Promise<UserDetail | undefined> => (await user.refetch()).data;

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="grid gap-3">
        <BackLink to="/admin/users">{t('users.back')}</BackLink>
        <PageHead title={u.name} intro={`@${u.username}`} />
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-meta">
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">{t('users.info.status')}</dt>
            <dd>
              <Tag tone={u.status === 'active' ? 'ok' : u.status === 'locked' ? 'bad' : 'neutral'}>{t(`users.status.${u.status}`)}</Tag>
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">{t('users.info.2fa')}</dt>
            <dd>
              {t(u.totpEnabled ? 'users.2fa.on' : 'users.2fa.off')}
              {u.mfaRequired && ` · ${t('users.2fa.required')}`}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">{t('users.info.last_login')}</dt>
            <dd>{u.lastLoginAt === null ? t('users.never') : formatDate(u.lastLoginAt)}</dd>
          </div>
        </dl>
      </div>
      {created && <Notice kind="success">{t('users.created')}</Notice>}
      <RefetchProblem query={user} />
      <UserForm key={u.id} user={u} canManage={canManage} isSelf={isSelf} reload={reload} />
      <RolesEditor key={`roles:${u.id}`} user={u} canManage={canManage} isSelf={isSelf} />
    </div>
  );
}
