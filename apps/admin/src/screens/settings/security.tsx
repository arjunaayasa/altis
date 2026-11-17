import type { RoleItem, RoleListResponse, RolePatchBody } from '@altis/shared/api/roles';
import { SecuritySettingsBody, type SecuritySettings } from '@altis/shared/api/settings';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { SideSection } from '@/components/layout';
import { CheckField, Field, Notice, ProblemAlert, RefetchProblem } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type AdminKey } from '@/i18n';
import { grantable, holds, isSuperAdmin, roleLabel } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, hasFieldErrors, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { SettingsFooter, SettingsLoader, SettingsPage, saveSettings, wholeNumberIn, type SaveOutcome } from './library';

/**
 * Pengaturan → Keamanan (spec §13.3 "kebijakan sandi, idle sesi, 2FA wajib per peran"):
 *
 * - the password policy and the session idle limit (`PUT settings/security`, which asks for the password first: the
 *   API client opens the reauth dialog, §7.3);
 * - the roles (`GET roles`, which needs `system.users.read`) with their 2FA requirement. With `system.roles.manage`
 *   each role has a switch that saves at once with `PATCH roles/:id` (the role's `version`, so a role changed
 *   elsewhere meanwhile is CONFLICT_STALE, never overwritten; reauth again). A role the signed-in user may not write
 *   (a system role unless they are a super admin; a custom role holding a permission they cannot grant, §7.2 rules 1
 *   and 5) has its switch disabled, with the reason. Without the permission the requirement is only shown.
 */

const ROLES_KEY = ['roles', 'list'] as const;

/** The bounds of the two numbers, from the shared body schema (the settings registry's limits). */
const PASSWORD_MIN = SecuritySettingsBody.shape.passwordMinLength.unwrap();
const SESSION_IDLE = SecuritySettingsBody.shape.sessionIdleMinutes.unwrap();

const SecurityForm = z.strictObject({ passwordMinLength: wholeNumberIn(PASSWORD_MIN), sessionIdleMinutes: wholeNumberIn(SESSION_IDLE) });

type SecurityValues = z.infer<typeof SecurityForm>;

function securityBody(values: SecurityValues, view: SecuritySettings): SecuritySettingsBody {
  const body: SecuritySettingsBody = {};
  if (values.passwordMinLength !== view.passwordMinLength) body.passwordMinLength = values.passwordMinLength;
  if (values.sessionIdleMinutes !== view.sessionIdleMinutes) body.sessionIdleMinutes = values.sessionIdleMinutes;
  return body;
}

function SecuritySettingsForm({ initial, canManage }: { initial: SecuritySettings; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [view, setView] = useState(initial);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const form = useForm<SecurityValues>({ resolver: zodResolver(SecurityForm, FORM_PARSE), defaultValues: { ...initial } });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const readOnly = !canManage;

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    setOutcome(null);
    const body = securityBody(values, view);
    if (Object.keys(body).length === 0) {
      form.reset({ ...view });
      setOutcome('unchanged');
      return;
    }
    try {
      const saved = await saveSettings(queryClient, 'security', body);
      setView(saved.view);
      form.reset({ ...saved.view });
      setOutcome('saved');
    } catch (e) {
      if (hasFieldErrors(e)) applyServerErrors(form, e);
      else setProblem(e);
    }
  });

  return (
    <SideSection title={t('settings.security.policy_title')}>
      <form noValidate className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => void submit(e)} onChange={() => setOutcome(null)}>
        <Field
          label={t('settings.security.password_min_length')}
          hint={t('settings.security.password_min_length_hint', { min: PASSWORD_MIN.minValue ?? '', max: PASSWORD_MIN.maxValue ?? '' })}
          error={errors.passwordMinLength}
        >
          {(c) => (
            <Input
              {...c}
              type="number"
              inputMode="numeric"
              min={PASSWORD_MIN.minValue ?? undefined}
              max={PASSWORD_MIN.maxValue ?? undefined}
              {...form.register('passwordMinLength', { valueAsNumber: true })}
              disabled={readOnly}
            />
          )}
        </Field>
        <Field
          label={t('settings.security.session_idle')}
          hint={t('settings.security.session_idle_hint', { min: SESSION_IDLE.minValue ?? '', max: SESSION_IDLE.maxValue ?? '' })}
          error={errors.sessionIdleMinutes}
        >
          {(c) => (
            <Input
              {...c}
              type="number"
              inputMode="numeric"
              min={SESSION_IDLE.minValue ?? undefined}
              max={SESSION_IDLE.maxValue ?? undefined}
              {...form.register('sessionIdleMinutes', { valueAsNumber: true })}
              disabled={readOnly}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:col-span-2">
          <SettingsFooter
            canManage={canManage}
            busy={isSubmitting}
            outcome={outcome}
            problem={problem}
            rootError={errors.root?.['server']?.message}
            note={t('settings.security.reauth_note')}
          />
        </div>
      </form>
    </SideSection>
  );
}

/** The roles and their 2FA requirement; a switch per role for a user with `system.roles.manage`. */
function RoleMfaList() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const canRead = holds(me, 'system.users.read');
  const canManage = holds(me, 'system.roles.manage');
  const roles = useApiQuery<RoleListResponse>({ queryKey: [...ROLES_KEY], path: 'roles', enabled: canRead });
  const [pending, setPending] = useState<{ id: string; value: boolean } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  /** Why `role`'s switch is disabled for the signed-in user, or null when they may change it. */
  const blocked = (role: RoleItem): AdminKey | null => {
    if (role.isSystem) return isSuperAdmin(me) ? null : 'roles.system_mfa_super_admin';
    return role.permissions.every((p) => grantable(me, p) === 'ok') ? null : 'roles.cannot_edit';
  };

  const toggle = async (role: RoleItem, mfaRequired: boolean): Promise<void> => {
    setPending({ id: role.id, value: mfaRequired });
    setNotice(null);
    try {
      const body: RolePatchBody = { version: role.version, mfaRequired };
      const updated = await api<RoleItem>('PATCH', `roles/${encodeURIComponent(role.id)}`, body);
      queryClient.setQueryData<RoleListResponse>(ROLES_KEY, (old) =>
        old === undefined ? old : { items: old.items.map((r) => (r.id === updated.id ? updated : r)) },
      );
      queryClient.setQueryData(['roles', 'detail', updated.id], updated);
      setNotice({ kind: 'success', text: t('settings.security.mfa_saved', { role: roleLabel(t, updated) }) });
    } catch (e) {
      setNotice({ kind: 'error', text: problemText(t, e) });
      // Someone changed the role meanwhile: show what it is now.
      if (e instanceof ApiError && e.code === 'CONFLICT_STALE') void queryClient.invalidateQueries({ queryKey: ROLES_KEY });
    } finally {
      setPending(null);
    }
  };

  let content;
  if (!canRead) {
    content = <p className="text-sm text-muted-foreground">{t('settings.security.mfa_roles_hidden')}</p>;
  } else if (roles.data === undefined) {
    content = roles.isError ? (
      <ProblemAlert error={roles.error}>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => void roles.refetch()}>
          {t('table.retry')}
        </Button>
      </ProblemAlert>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        {t('shell.loading')}
      </p>
    );
  } else {
    // The data wins over an error: a failed background refetch keeps the list (RefetchProblem above it).
    content = (
      <ul className="flex flex-col divide-y">
        {roles.data.items.map((role) => {
          const name = roleLabel(t, role);
          const holders = t('roles.holder_count', { count: role.holders });
          if (!canManage) {
            return (
              <li key={role.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <span className="font-semibold">{name}</span>
                <span className="text-muted-foreground">
                  {t('roles.mfa_status', { value: t(role.mfaRequired ? 'form.yes' : 'form.no') })} · {holders}
                </span>
              </li>
            );
          }
          const reason = blocked(role);
          const checked = pending?.id === role.id ? pending.value : role.mfaRequired;
          return (
            <li key={role.id} className="py-2">
              <CheckField
                asSwitch
                label={name}
                hint={reason === null ? holders : `${holders} · ${t(reason)}`}
                checked={checked}
                disabled={reason !== null || pending !== null}
                onChange={(e) => void toggle(role, e.target.checked)}
              />
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <SideSection title={t('settings.security.mfa_title')} intro={t('settings.security.mfa_description')}>
      {notice !== null && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {canRead && <RefetchProblem query={roles} />}
      {content}
    </SideSection>
  );
}

/** `/admin/settings/security`. */
export function SecuritySettingsScreen() {
  return (
    <SettingsPage>
      <SettingsLoader group="security">{(view, canManage) => <SecuritySettingsForm initial={view} canManage={canManage} />}</SettingsLoader>
      <RoleMfaList />
    </SettingsPage>
  );
}
